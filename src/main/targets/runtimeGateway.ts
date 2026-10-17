import { execFile, execFileSync, spawn } from 'child_process';
import * as dns from 'dns';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import {
  GATEWAY_ADDR,
  GATEWAY_HOST,
  GATEWAY_PORT,
  HEALTH_PATH,
  HEALTH_URL,
  HOME_URL,
  LEGACY_GATEWAY_ADDR,
  LOOPBACK_ADDRESSES,
} from './gatewayAddress';
import { runtimeChildEnv } from './releaseHead';
import { runtimeDataDir, runtimeHostLockPath } from './runtimePaths';

export { HEALTH_URL, HOME_URL, LEGACY_GATEWAY_ADDR, LOOPBACK_ADDRESSES };

/** Supervised command from the launcher contract. */
export const GATEWAY_ARGS: readonly string[] = ['gateway', '--addr', GATEWAY_ADDR];
export const ALREADY_OWNS_TEXT = 'another ElastOS host already owns';
export const EXIT_BINARY_REPLACED = 75;
export const STOP_GRACE_MS = 15_000;
export const FOREIGN_LISTENER_MESSAGE =
  `Another program is answering at ${GATEWAY_ADDR}, so Home was not opened. Quit that program and click Try again.`;
export const LEGACY_STILL_RUNNING_MESSAGE =
  'An older ElastOS is still running and could not be stopped. Quit it, then click Start.';

/** A gateway this window did not start. Callers match the type, not the sentence. */
export class ForeignGatewayError extends Error {
  readonly code = 'foreign-gateway';

  constructor() {
    super('ElastOS is already running. This window did not start it, so Stop leaves it running.');
    this.name = 'ForeignGatewayError';
  }
}

export function isForeignGatewayError(err: unknown): boolean {
  return err instanceof ForeignGatewayError
    || (err instanceof Error && (err as { code?: unknown }).code === 'foreign-gateway');
}

export interface HealthResult {
  status: number;
  body: string;
  /** The `localhost` addresses that answered. Absent when the caller did not record them. */
  addresses?: string[];
}

export interface GatewayProcess {
  readonly pid: number;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  signal(signal: NodeJS.Signals): void;
  hasExited(): boolean | Promise<boolean>;
}

/**
 * host_lock.rs exits 75 for a replaced binary and also when the path cannot
 * be read, the file moved, or the bytes cannot be re-hashed. Restart only
 * for a real replacement. Check the unreadable phrases first: the re-hash
 * failure also contains "changed on disk".
 */
export function binaryReplacement(output: string, code: number | null): boolean {
  if (code !== EXIT_BINARY_REPLACED) return false;
  if (/could not be read|could not be verified|could not be re-verified/i.test(output)) return false;
  return /was replaced on disk|changed on disk/i.test(output);
}

/** The gateway is its own process group. Signal the group, not only the leader. */
export function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    kill(-pid, signal);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code)
      : '';
    if (code === 'ESRCH') return;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not signal ElastOS (${signal}): ${message}`);
  }
}

/**
 * `current` is a gateway on `localhost:8090`, the address this launcher
 * starts. `legacy` is one an earlier launcher started on `127.0.0.1:8090`.
 * A legacy gateway is only stopped and started again. Home never opens on it.
 */
export type InstalledGatewayKind = 'current' | 'legacy';

/** The addresses a gateway that recorded this lock address must own. */
export function lockAddressWants(kind: InstalledGatewayKind): readonly string[] {
  return kind === 'current' ? LOOPBACK_ADDRESSES : ['127.0.0.1'];
}

/**
 * The installed gateway from its host lock, or null. The lock pid must be
 * alive, own the listening sockets for the recorded address, and run
 * `elastos gateway`. Any other lock address is refused.
 */
export function installedGatewayKind(input: {
  lockText: string | null;
  command: string | null;
  pidAlive: (pid: number) => boolean;
  ownsSocket: (pid: number, wants: readonly string[]) => boolean;
}): InstalledGatewayKind | null {
  if (!input.lockText) return null;
  let parsed: { pid?: unknown; addr?: unknown };
  try {
    parsed = JSON.parse(input.lockText) as { pid?: unknown; addr?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  let kind: InstalledGatewayKind;
  if (parsed.addr === GATEWAY_ADDR) kind = 'current';
  else if (parsed.addr === LEGACY_GATEWAY_ADDR) kind = 'legacy';
  else return null;
  if (!input.pidAlive(parsed.pid)) return null;
  if (!input.ownsSocket(parsed.pid, lockAddressWants(kind))) return null;
  if (!input.command) return null;
  const command = input.command.trim();
  if (!/(^|[\\/\s])elastos(\.exe)?(\s|$)/i.test(command) || !/\bgateway\b/.test(command)) return null;
  return kind;
}

/** A foreign OK on port 8090 opens Home only for a `localhost:8090` gateway. */
export function foreignListenerIsElastos(input: Parameters<typeof installedGatewayKind>[0]): boolean {
  return installedGatewayKind(input) === 'current';
}

export interface GatewaySupervisorDeps {
  binary: string;
  spawn: (binary: string, args: readonly string[]) => GatewayProcess;
  fetchHealth: () => Promise<HealthResult | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openUrl: (url: string) => void;
  log: (line: string) => void;
  confirmForeign?: () => Promise<boolean>;
  /**
   * True when the running gateway is one an earlier launcher started on
   * `127.0.0.1:8090`. Start stops it once through `adoptInstalled` and
   * starts it again on `localhost:8090`.
   */
  foreignIsLegacy?: () => Promise<boolean>;
  /**
   * An OK body counts only when this returns true: the started gateway owns
   * every `localhost` address that answered. Without it, OK is enough.
   */
  listenerOwned?: (pid: number, health: HealthResult) => boolean | Promise<boolean>;
  /**
   * The installed gateway when this window did not start it. Reset and
   * Uninstall call this after the confirm dialog. It is not a second prompt.
   * Returning null leaves a listener that is not that gateway running.
   */
  adoptInstalled?: () => GatewayProcess | null | Promise<GatewayProcess | null>;
  graceMs?: number;
  healthTimeoutMs?: number;
  pollMs?: number;
  maxRestarts?: number;
}

export interface GatewaySupervisor {
  start(): Promise<'started' | 'already-running'>;
  /**
   * Stop the gateway this window started. `adopt` is only for Reset and
   * Uninstall, after the person confirmed. Quit, Stop, and Restart omit it.
   */
  stop(options?: { adopt?: boolean }): Promise<void>;
  /** SIGKILL the process group this supervisor is stopping. Used when quit runs out of time. */
  forceKill(): void;
  openHome(): void;
  getLogs(lines?: number): string;
  phase(): 'running' | 'stopped' | 'starting' | 'stopping' | 'error';
}

/** One LISTEN socket on the gateway port, and whether the pid being checked holds it. */
export interface PortListener {
  /** `127.0.0.1`, `::1`, `0.0.0.0`, `::`, `::ffff:127.0.0.1`, `*` (any), or another address. */
  address: string;
  owned: boolean;
}

/** A `/proc/net/tcp` or `/proc/net/tcp6` address. The kernel prints each 32-bit word little-endian. */
export function procNetAddress(hex: string): string | null {
  if (!/^[0-9A-Fa-f]+$/.test(hex) || (hex.length !== 8 && hex.length !== 32)) return null;
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    const chunk = hex.slice(word, word + 8);
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(chunk.slice(i, i + 2), 16));
  }
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.every((b) => b === 0)) return '::';
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return '::1';
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(':');
}

/** LISTEN sockets on `port` from `/proc/net/tcp` and `/proc/net/tcp6`, with their inodes. */
export function procNetListeners(
  tcp: string,
  tcp6: string,
  port = GATEWAY_PORT,
): Array<{ address: string; inode: string }> {
  const wantPort = port.toString(16).toUpperCase().padStart(4, '0');
  const found: Array<{ address: string; inode: string }> = [];
  for (const line of `${tcp}\n${tcp6}`.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const local = parts[1] ?? '';
    const colon = local.lastIndexOf(':');
    if (colon <= 0 || local.slice(colon + 1).toUpperCase() !== wantPort) continue;
    if (parts[3] !== '0A') continue;
    const address = procNetAddress(local.slice(0, colon));
    if (!address) continue;
    found.push({ address, inode: parts[9] });
  }
  return found;
}

/** Socket inodes from `/proc/<pid>/fd` link targets. */
export function socketInodes(fdLinks: readonly string[]): Set<string> {
  const inodes = new Set<string>();
  for (const link of fdLinks) {
    const match = /^socket:\[(\d+)\]$/.exec(link);
    if (match) inodes.add(match[1]);
  }
  return inodes;
}

/** Linux listeners on the gateway port, marked by whether `fdLinks` holds each one. */
export function procListenersFor(tcp: string, tcp6: string, fdLinks: readonly string[], port = GATEWAY_PORT): PortListener[] {
  const owned = socketInodes(fdLinks);
  return procNetListeners(tcp, tcp6, port).map((entry) => ({ address: entry.address, owned: owned.has(entry.inode) }));
}

/**
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpn` output. `n` names look like
 * `127.0.0.1:8090`, `[::1]:8090`, or `*:8090`. A socket of another account is
 * missing from this list, so the health probe also checks every address that
 * answered (see `listenerOwnership`).
 */
export function parseLsofListeners(out: string, pid: number, port = GATEWAY_PORT): PortListener[] {
  const found: PortListener[] = [];
  let current = -1;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('p')) {
      current = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith('n')) continue;
    const name = line.slice(1);
    const colon = name.lastIndexOf(':');
    if (colon <= 0 || name.slice(colon + 1) !== String(port)) continue;
    const address = name.slice(0, colon).replace(/^\[(.*)\]$/, '$1');
    found.push({ address, owned: current === pid });
  }
  return found;
}

function coversAddress(listen: string, want: string): boolean {
  if (listen === want || listen === '*' || listen === '::') return true;
  if (want === '127.0.0.1') return listen === '0.0.0.0' || listen === '::ffff:127.0.0.1';
  return false;
}

export type ListenerOwnership = 'owned' | 'foreign' | 'none';

/**
 * Who holds the gateway port for the addresses in `wants`.
 * `foreign`: a socket on one of those addresses, or on a wildcard that
 * covers one, belongs to another process; or an address in `answered`
 * (the probe connected to it) is not a socket of the pid.
 * `owned`: the pid listens on at least one wanted address exactly, and
 * nothing above is foreign. `none`: the pid listens on none of them.
 */
export function listenerOwnership(
  listeners: readonly PortListener[],
  wants: readonly string[],
  answered: readonly string[] = [],
): ListenerOwnership {
  for (const listener of listeners) {
    if (!listener.owned && wants.some((want) => coversAddress(listener.address, want))) return 'foreign';
  }
  const exact = new Set(listeners.filter((l) => l.owned && wants.includes(l.address)).map((l) => l.address));
  for (const address of answered) {
    if (!exact.has(address)) return 'foreign';
  }
  return exact.size > 0 ? 'owned' : 'none';
}

export function isHealthOk(result: HealthResult | null): boolean {
  return Boolean(result && result.status === 200 && result.body.trim() === 'OK');
}

/** Drop lines that can carry attach_secret. The coords files stay on disk, out of the log. */
export function scrubRuntimeLog(chunk: string): string {
  if (/attach_secret|runtime-coords\.json|gateway-runtime-coords|home-runtime-coords/i.test(chunk)) {
    return '[elastos] omitted a line that can contain a local secret\n';
  }
  return chunk;
}

export function createGatewaySupervisor(deps: GatewaySupervisorDeps): GatewaySupervisor {
  const graceMs = deps.graceMs ?? STOP_GRACE_MS;
  const healthTimeoutMs = deps.healthTimeoutMs ?? 60_000;
  const pollMs = deps.pollMs ?? 250;
  const maxRestarts = deps.maxRestarts ?? 3;
  const logs: string[] = [];
  let owned: GatewayProcess | null = null;
  let foreign = false;
  let intentionalStop = false;
  let restarts = 0;
  let current: 'running' | 'stopped' | 'starting' | 'stopping' | 'error' = 'stopped';

  const note = (line: string) => {
    const clean = scrubRuntimeLog(line).replace(/\s+$/g, '');
    if (!clean) return;
    logs.push(clean);
    deps.log(clean);
  };

  async function launchOnce(): Promise<'ready' | 'replaced' | 'already'> {
    intentionalStop = false;
    foreign = false;
    const proc = deps.spawn(deps.binary, GATEWAY_ARGS);
    owned = proc;
    let output = '';
    let exited = false;
    let exitCode: number | null = null;
    proc.onOutput((chunk) => {
      output += chunk;
      note(chunk);
    });
    proc.onExit((code) => {
      exited = true;
      exitCode = code;
      if (current !== 'running' || intentionalStop) return;
      if (binaryReplacement(output, code)) {
        owned = null;
        restarts += 1;
        if (restarts > maxRestarts) {
          current = 'error';
          note('ElastOS kept restarting after an update. Click Start to try again.');
          return;
        }
        note('ElastOS was updated. Starting it again.');
        void supervisor.start().catch((err: unknown) => {
          current = 'error';
          note(err instanceof Error ? err.message : String(err));
        });
        return;
      }
      if (code === EXIT_BINARY_REPLACED) {
        owned = null;
        current = 'error';
        note('ElastOS stopped (exit 75) without a replaced binary. It was not started again.');
      }
    });

    const deadline = deps.now() + healthTimeoutMs;
    let answeredByOther = false;
    while (deps.now() < deadline) {
      if (exited) return classifyExit(exitCode, output);
      const health = await deps.fetchHealth();
      if (exited) return classifyExit(exitCode, output);
      if (health && isHealthOk(health)) {
        const ours = deps.listenerOwned ? await deps.listenerOwned(proc.pid, health) : true;
        if (exited) return classifyExit(exitCode, output);
        if (ours) {
          restarts = 0;
          current = 'running';
          return 'ready';
        }
        answeredByOther = true;
      }
      await deps.sleep(pollMs);
      if (exited) return classifyExit(exitCode, output);
    }
    if (answeredByOther) throw new Error(FOREIGN_LISTENER_MESSAGE);
    throw new Error('ElastOS did not become ready in time. Click Install to try again.');
  }

  function classifyExit(code: number | null, output: string): 'replaced' | 'already' {
    owned = null;
    if (binaryReplacement(output, code)) {
      restarts += 1;
      if (restarts > maxRestarts) {
        throw new Error('ElastOS kept restarting after an update. Click Start to try again.');
      }
      note('ElastOS was updated. Starting it again.');
      return 'replaced';
    }
    if (code === EXIT_BINARY_REPLACED) {
      throw new Error('ElastOS stopped (exit 75) without a replaced binary. It was not started again.');
    }
    if (output.includes(ALREADY_OWNS_TEXT)) {
      return 'already';
    }
    const tail = scrubRuntimeLog(output).trim().split('\n').slice(-3).join(' ');
    throw new Error(
      tail
        ? `ElastOS stopped before it was ready. ${tail}`
        : 'ElastOS stopped before it was ready. Click Install to try again.',
    );
  }

  /** Two failed /healthz polls, and only after this pid has exited. */
  async function confirmedStopped(proc: GatewayProcess, budgetMs: number): Promise<boolean> {
    const deadline = deps.now() + budgetMs;
    let misses = 0;
    while (deps.now() < deadline) {
      const dead = await proc.hasExited();
      const healthDown = !isHealthOk(await deps.fetchHealth());
      if (dead && healthDown) {
        misses += 1;
        if (misses >= 2) return true;
      } else {
        misses = 0;
      }
      await deps.sleep(pollMs);
    }
    return false;
  }

  /** SIGTERM, then SIGKILL after the grace period. Throws when the pid is still there. */
  async function stopProcess(proc: GatewayProcess): Promise<void> {
    intentionalStop = true;
    current = 'stopping';
    proc.signal('SIGTERM');
    if (await confirmedStopped(proc, graceMs)) {
      owned = null;
      current = 'stopped';
      return;
    }
    proc.signal('SIGKILL');
    if (await confirmedStopped(proc, graceMs)) {
      owned = null;
      current = 'stopped';
      return;
    }
    current = 'error';
    throw new Error('ElastOS is still running.');
  }

  const supervisor: GatewaySupervisor = {
    async start() {
      if (owned && current === 'running') return 'started';
      current = 'starting';
      let legacyStopped = false;
      for (;;) {
        const result = await launchOnce();
        if (result === 'replaced') continue;
        if (result === 'already') {
          if (!legacyStopped && deps.foreignIsLegacy && await deps.foreignIsLegacy()) {
            // An earlier launcher started it on 127.0.0.1. Passkeys need
            // localhost, so stop it once and start it again here.
            legacyStopped = true;
            note('An older ElastOS is running on 127.0.0.1:8090. Starting it again on localhost:8090.');
            const adopted = await (deps.adoptInstalled?.() ?? null);
            if (!adopted) {
              current = 'error';
              throw new Error(LEGACY_STILL_RUNNING_MESSAGE);
            }
            owned = adopted;
            try {
              await stopProcess(adopted);
            } catch {
              current = 'error';
              throw new Error(LEGACY_STILL_RUNNING_MESSAGE);
            }
            current = 'starting';
            continue;
          }
          const health = await deps.fetchHealth();
          if (!isHealthOk(health)) {
            current = 'error';
            throw new Error('ElastOS is already running, but it is not answering yet. Wait a moment and click Open my computer.');
          }
          const confirmed = deps.confirmForeign ? await deps.confirmForeign() : false;
          if (!confirmed) {
            current = 'error';
            throw new Error('Something is answering on port 8090, but it is not the ElastOS gateway. Home was not opened.');
          }
          foreign = true;
          owned = null;
          current = 'running';
          deps.openUrl(HOME_URL);
          return 'already-running';
        }
        current = 'running';
        return 'started';
      }
    },
    async stop(options?: { adopt?: boolean }) {
      if (!owned) {
        const health = await deps.fetchHealth();
        if (isHealthOk(health)) {
          const adopted = options?.adopt
            ? await (deps.adoptInstalled?.() ?? null)
            : null;
          if (!adopted) throw new ForeignGatewayError();
          owned = adopted;
        } else {
          foreign = false;
          current = 'stopped';
          return;
        }
      }
      await stopProcess(owned);
    },
    forceKill() {
      if (!owned) return;
      try {
        owned.signal('SIGKILL');
      } catch {
        // Quit still closes. The error from stop() is logged by the caller.
      }
    },
    openHome() {
      deps.openUrl(HOME_URL);
    },
    getLogs(lines?: number) {
      const count = lines ?? logs.length;
      return logs.slice(-count).join('\n');
    },
    phase() {
      return current;
    },
  };

  return supervisor;
}

export function spawnGatewayProcess(binary: string, args: readonly string[]): GatewayProcess {
  const child = spawn(binary, [...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: runtimeChildEnv(process.env),
  });
  const outputListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  let exited = false;
  const emit = (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const listener of outputListeners) listener(text);
  };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.on('exit', (code) => {
    exited = true;
    for (const listener of exitListeners) listener(code);
  });
  return {
    pid: child.pid ?? -1,
    onOutput(listener) {
      outputListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    hasExited() {
      return exited;
    },
    signal(signal) {
      signalProcessGroup(child.pid ?? -1, signal);
    },
  };
}

let logSink: (line: string) => void = () => {};

export function setRuntimeLogSink(sink: (line: string) => void): void {
  logSink = sink;
}

export function emitRuntimeLog(line: string): void {
  logSink(line);
}

/** The addresses `localhost` resolves to on this computer, in resolver order. */
export async function resolveLocalhost(): Promise<string[]> {
  const found = await dns.promises.lookup(GATEWAY_HOST, { all: true, verbatim: true });
  return [...new Set(found.map((entry) => entry.address))];
}

/** True when every address is a loopback address `localhost` may name. An empty list is false. */
export function localhostIsLoopback(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every((address) => LOOPBACK_ADDRESSES.includes(address));
}

/** GET /healthz on one address with `Host: localhost:8090`. Null when nothing answered. */
export function getHealthAt(address: string, timeoutMs: number): Promise<HealthResult | null> {
  return getLocalPath(address, HEALTH_PATH, timeoutMs);
}

/** GET a gateway path on one `localhost` address with `Host: localhost:8090`. The body is cut at 256 characters. */
export function getLocalPath(address: string, pathName: string, timeoutMs: number): Promise<HealthResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: HealthResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.request({
      host: address,
      port: GATEWAY_PORT,
      path: pathName,
      method: 'GET',
      agent: false,
      headers: { Host: GATEWAY_ADDR },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 256) body += chunk;
      });
      res.on('end', () => finish({ status: res.statusCode ?? 0, body }));
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, timeoutMs);
    req.on('error', () => finish(null));
    req.end();
  });
}

/**
 * Combine one /healthz reply per address. Nothing answered is null. Any
 * address that answered without OK makes the result not OK, because the
 * browser may connect to that address for `localhost`. Otherwise OK, with the
 * addresses that answered.
 */
export function combineHealth(results: ReadonlyArray<{ address: string; health: HealthResult | null }>): HealthResult | null {
  const answered = results.filter((row) => row.health);
  if (answered.length === 0) return null;
  const addresses = answered.map((row) => row.address);
  const bad = answered.find((row) => !isHealthOk(row.health));
  if (bad?.health) return { status: bad.health.status, body: bad.health.body, addresses };
  return { status: 200, body: 'OK', addresses };
}

/**
 * Probe /healthz on every address `localhost` resolves to. Node's fetch uses
 * the first resolved address only, and the browser may use any of them. A
 * resolver that names a non-loopback address is refused.
 */
export async function probeGatewayHealth(options: {
  timeoutMs?: number;
  lookup?: () => Promise<string[]>;
  get?: (address: string, timeoutMs: number) => Promise<HealthResult | null>;
} = {}): Promise<HealthResult | null> {
  const timeoutMs = options.timeoutMs ?? 2000;
  let addresses: string[];
  try {
    addresses = await (options.lookup ?? resolveLocalhost)();
  } catch {
    return null;
  }
  if (!localhostIsLoopback(addresses)) return null;
  const get = options.get ?? getHealthAt;
  const results = await Promise.all(addresses.map(async (address) => ({ address, health: await get(address, timeoutMs) })));
  return combineHealth(results);
}

/** LISTEN sockets on the gateway port, marked by whether `pid` holds each. Null when they cannot be read. */
export async function localListeners(pid: number, platform: string = process.platform): Promise<PortListener[] | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    let tcp: string;
    try {
      tcp = fs.readFileSync('/proc/net/tcp', 'utf8');
    } catch {
      return null;
    }
    let tcp6 = '';
    try {
      tcp6 = fs.readFileSync('/proc/net/tcp6', 'utf8');
    } catch {
      // No IPv6 on this kernel. Nothing can listen on ::1.
      tcp6 = '';
    }
    const links: string[] = [];
    try {
      const dir = `/proc/${pid}/fd`;
      for (const name of fs.readdirSync(dir)) {
        try {
          links.push(fs.readlinkSync(`${dir}/${name}`));
        } catch {
          // A descriptor can disappear between readdir and readlink.
        }
      }
    } catch {
      return null;
    }
    return procListenersFor(tcp, tcp6, links);
  }
  if (platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('lsof', ['-nP', `-iTCP:${GATEWAY_PORT}`, '-sTCP:LISTEN', '-Fpn'], {
        encoding: 'utf8',
        timeout: 5000,
      }, (err, stdout) => {
        const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : null;
        // lsof exits 1 when nothing matches. A missing lsof or a timeout is unknown.
        if (err && !(code === 1 && !String(stdout ?? '').trim())) {
          resolve(null);
          return;
        }
        resolve(parseLsofListeners(String(stdout ?? ''), pid));
      });
    });
  }
  return null;
}

/** True when `pid` owns the gateway port for `wants` and for every address that answered. */
export async function pidOwnsGatewayPort(
  pid: number,
  wants: readonly string[],
  answered: readonly string[] = [],
  read: (pid: number) => Promise<PortListener[] | null> = (target) => localListeners(target),
): Promise<boolean> {
  const listeners = await read(pid);
  if (!listeners) return false;
  return listenerOwnership(listeners, wants, answered) === 'owned';
}

export function createDefaultGatewaySupervisor(binary: string): GatewaySupervisor {
  return createGatewaySupervisor({
    binary,
    spawn: spawnGatewayProcess,
    fetchHealth: () => probeGatewayHealth(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    openUrl: openRuntimeHome,
    log: (line) => logSink(line),
    confirmForeign: confirmInstalledGateway,
    foreignIsLegacy: async () => (await installedGatewayOnThisComputer()) === 'legacy',
    listenerOwned: (pid, health) => pidOwnsGatewayPort(pid, LOOPBACK_ADDRESSES, health.addresses ?? []),
    adoptInstalled: adoptInstalledGatewayProcess,
  });
}

function readHostLock(): { text: string | null; pid: number } {
  const lockPath = runtimeHostLockPath(runtimeDataDir(process.platform, os.homedir(), process.env));
  let text: string | null = null;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch {
    text = null;
  }
  let pid = 0;
  try {
    const parsed = JSON.parse(text ?? '') as { pid?: unknown };
    pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
  } catch {
    pid = 0;
  }
  return { text, pid };
}

async function hostLockGatewayKind(text: string | null, pid: number): Promise<InstalledGatewayKind | null> {
  const listeners = await localListeners(pid);
  return installedGatewayKind({
    lockText: text,
    command: processCommand(pid),
    pidAlive: (id) => {
      try {
        process.kill(id, 0);
        return true;
      } catch {
        return false;
      }
    },
    ownsSocket: (_id, wants) => Boolean(listeners && listenerOwnership(listeners, wants) === 'owned'),
  });
}

/** The installed gateway's kind on Linux and macOS, from the host lock. Null when it is not proved. */
export async function installedGatewayOnThisComputer(): Promise<InstalledGatewayKind | null> {
  if (process.platform === 'win32') return null;
  const { text, pid } = readHostLock();
  return hostLockGatewayKind(text, pid);
}

export function confirmInstalledGateway(): Promise<boolean> {
  if (process.platform === 'win32') {
    const windows = require('./windowsRuntime') as {
      confirmDistroGateway: () => Promise<boolean>;
    };
    return windows.confirmDistroGateway();
  }
  return installedGatewayOnThisComputer().then((kind) => kind === 'current');
}

/**
 * Only "no such process" (ESRCH) is an exit. EPERM means the pid is alive under
 * another account, and any other error is unknown, so both count as running
 * and Reset keeps waiting instead of deleting under a live gateway.
 */
export function localPidHasExited(
  pid: number,
  probe: (pid: number, signal: 0) => void = (target, signal) => { process.kill(target, signal); },
): boolean {
  try {
    probe(pid, 0);
    return false;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
    return code === 'ESRCH';
  }
}

/**
 * The installed gateway from the host lock, so Stop can signal a process this
 * window did not spawn. A `127.0.0.1:8090` gateway from an earlier launcher is
 * adopted too, so Start, Reset, and Uninstall can stop it.
 */
export async function adoptInstalledGatewayProcess(): Promise<GatewayProcess | null> {
  if (process.platform === 'win32') return null;
  const { text, pid } = readHostLock();
  if (pid <= 0 || !(await hostLockGatewayKind(text, pid))) return null;
  return {
    pid,
    onOutput() {},
    onExit() {},
    hasExited() {
      return localPidHasExited(pid);
    },
    signal(signal) {
      signalProcessGroup(pid, signal);
    },
  };
}

function processCommand(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
  } catch {
    return null;
  }
}

export function openRuntimeHome(): void {
  // Electron is present in the app and absent in unit tests.
  const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
  if (!electron.shell?.openExternal) {
    throw new Error('Could not open your computer in the browser.');
  }
  electron.shell.openExternal(HOME_URL);
}
