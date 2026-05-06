/**
 * pc2-node Runtime Heartbeat Poller
 *
 * Reads `<pc2NodeDir>/data/runtime/heartbeat.json` (written by pc2-node
 * v1.2.7.13+ every 2 s) as the single source of truth for "is pc2-node
 * alive?". Fixes the launcher status indicator desync that happened any
 * time pc2-node respawned without the launcher's spawn() call:
 *
 *   1. macOS in-app update (`UpdateService` → `spawnDetachedRespawn`)
 *   2. macOS manual restart (`POST /api/system/restart`)
 *   3. Linux/Jetson terminal `pm2 restart pc2`
 *   4. Crash + supervisor (pm2 / systemd) auto-restart
 *
 * In all four scenarios the launcher's tracked PID died but a fresh
 * pc2-node was running; the launcher's status was stuck on "Stopped"
 * until the user manually quit + relaunched the app.
 *
 * Protocol contract: docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md
 * in the pc2.net repo.
 *
 * Backward compat: against an older pc2-node (no heartbeat file ever
 * appears) this class reports `not-running` forever and the caller
 * falls back to its existing /health polling. No coordinated rollout.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import log from 'electron-log';

/** Schema written by pc2-node — DO NOT mutate field shapes; the contract is owned by pc2.net. */
export interface HeartbeatPayload {
  schema: 'pc2.heartbeat.v1';
  pid: number;
  version: string;
  port: number;
  healthy: boolean;
  startedAt: string;
  lastUpdated: string;
  lastRestartReason?: string;
}

/** Resolved liveness state. */
export type HeartbeatState =
  | { kind: 'not-running' }
  | { kind: 'stale'; lastSeen: HeartbeatPayload }
  | { kind: 'shutting-down'; payload: HeartbeatPayload }
  | { kind: 'running'; payload: HeartbeatPayload };

/**
 * 5 s = 3 missed writes at the 2 s pc2-node interval. Less is too jumpy
 * (macOS can briefly stall on disk under memory pressure). More is too
 * slow to detect a real crash.
 */
const STALE_AFTER_MS = 5_000;

/** Default poll cadence — twice the writer's rate gives bounded staleness without thrashing the disk. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** How long requestRestart waits for pc2-node to acknowledge before throwing. */
const DEFAULT_RESTART_ACK_TIMEOUT_MS = 10_000;

export class HeartbeatPoller {
  private readonly heartbeatPath: string;
  private readonly restartFlagPath: string;
  private timer: NodeJS.Timeout | null = null;
  private lastState: HeartbeatState = { kind: 'not-running' };
  private readonly stateListeners: ((state: HeartbeatState) => void)[] = [];

  constructor(
    pc2NodeDir: string,
    private readonly intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {
    const runtimeDir = join(pc2NodeDir, 'data', 'runtime');
    this.heartbeatPath = join(runtimeDir, 'heartbeat.json');
    this.restartFlagPath = join(runtimeDir, 'restart-requested.flag');
  }

  /**
   * Begin polling. Idempotent — calling start() twice is a no-op the second time.
   * The first poll runs synchronously so `getLastState()` is correct immediately
   * after `start()` returns.
   */
  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** Stop polling. Safe to call multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Subscribe to state-change notifications. Fires only when the state
   * `kind` changes (running ↔ shutting-down ↔ stale ↔ not-running) — not
   * on every payload tick. Returns an unsubscribe function.
   */
  onStateChange(listener: (state: HeartbeatState) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      const idx = this.stateListeners.indexOf(listener);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  /** Most recent observed state. Cheap; reads in-memory cache. */
  getLastState(): HeartbeatState {
    return this.lastState;
  }

  /**
   * Write the restart flag and wait for pc2-node to acknowledge by
   * dropping `healthy` to false (or removing the heartbeat entirely).
   *
   * If pc2-node doesn't acknowledge within `timeoutMs`, throws — the
   * caller should fall back to its existing kill-and-respawn path.
   * (This usually means an older pc2-node without flag support.)
   *
   * @param reason - tagged in the heartbeat's `lastRestartReason` for traceability.
   *                 Lowercase, no spaces (e.g. 'gui-restart-button', 'post-update').
   */
  async requestRestart(reason: string, timeoutMs: number = DEFAULT_RESTART_ACK_TIMEOUT_MS): Promise<void> {
    const flagDir = dirname(this.restartFlagPath);
    if (!existsSync(flagDir)) {
      mkdirSync(flagDir, { recursive: true });
    }
    writeFileSync(this.restartFlagPath, `reason: ${reason}\n`, { mode: 0o644 });
    log.info(`[HeartbeatPoller] Wrote restart flag (reason=${reason})`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.readState();
      // pc2-node sets healthy=false then exits → both shutting-down and
      // not-running mean the flag was consumed.
      if (state.kind === 'shutting-down' || state.kind === 'not-running') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Best-effort cleanup: leave the flag in place so a fresh pc2-node
    // running the new code consumes it on startup. (The startup path
    // explicitly handles this case — see `RuntimeHeartbeat.start`.)
    throw new Error(
      `pc2-node did not acknowledge restart flag within ${timeoutMs}ms. ` +
      `Either it is on an older version (<v1.2.7.13) without flag support, ` +
      `or it is unresponsive. Falling back to kill-and-respawn is recommended.`,
    );
  }

  /**
   * Best-effort cleanup of any stale flag file we may have written and
   * pc2-node didn't consume (shouldn't normally happen, but guards against
   * a future-pc2 stale flag confusing a future-pc2 startup).
   */
  cleanupStaleFlag(): void {
    try {
      if (existsSync(this.restartFlagPath)) {
        unlinkSync(this.restartFlagPath);
      }
    } catch {
      /* best-effort */
    }
  }

  private poll(): void {
    const next = this.readState();
    if (next.kind !== this.lastState.kind) {
      log.info(`[HeartbeatPoller] State change: ${this.lastState.kind} → ${next.kind}` +
        (next.kind === 'running' ? ` (pid=${next.payload.pid}, version=${next.payload.version})` : ''));
      this.lastState = next;
      for (const listener of this.stateListeners) {
        try {
          listener(next);
        } catch (err) {
          log.warn('[HeartbeatPoller] state listener threw:', err);
        }
      }
    } else {
      // Same kind — refresh the cached payload anyway so getLastState()
      // returns the latest pid/version/lastUpdated even between transitions.
      this.lastState = next;
    }
  }

  /** Pure function: read the disk, return the resolved state. No side effects beyond debug logging. */
  private readState(): HeartbeatState {
    if (!existsSync(this.heartbeatPath)) {
      return { kind: 'not-running' };
    }

    let payload: HeartbeatPayload;
    try {
      const raw = readFileSync(this.heartbeatPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<HeartbeatPayload>;
      // Schema check — refuse anything we can't reliably interpret.
      if (parsed.schema !== 'pc2.heartbeat.v1') {
        log.debug(`[HeartbeatPoller] Unknown heartbeat schema "${parsed.schema}" — treating as not-running`);
        return { kind: 'not-running' };
      }
      // Light shape validation — every required field must be present.
      if (
        typeof parsed.pid !== 'number' ||
        typeof parsed.version !== 'string' ||
        typeof parsed.port !== 'number' ||
        typeof parsed.healthy !== 'boolean' ||
        typeof parsed.startedAt !== 'string' ||
        typeof parsed.lastUpdated !== 'string'
      ) {
        log.debug('[HeartbeatPoller] Heartbeat missing required fields — treating as not-running');
        return { kind: 'not-running' };
      }
      payload = parsed as HeartbeatPayload;
    } catch (err) {
      // Likely a partial write (pc2-node replaces the file atomically via
      // writeFileSync, but on some filesystems we can still catch it
      // mid-flight). Treat as transient — caller polls again in 1 s.
      log.debug(`[HeartbeatPoller] Failed to parse heartbeat: ${(err as Error).message}`);
      return { kind: 'not-running' };
    }

    const lastUpdatedMs = Date.parse(payload.lastUpdated);
    if (Number.isNaN(lastUpdatedMs)) {
      // Malformed timestamp — treat as stale rather than running so we
      // don't claim health based on an unparseable field.
      return { kind: 'stale', lastSeen: payload };
    }

    const ageMs = Date.now() - lastUpdatedMs;
    if (ageMs > STALE_AFTER_MS) {
      return { kind: 'stale', lastSeen: payload };
    }

    if (!payload.healthy) {
      return { kind: 'shutting-down', payload };
    }

    return { kind: 'running', payload };
  }
}
