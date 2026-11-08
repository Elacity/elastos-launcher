import { ChildProcess, execFile, execFileSync, spawn, spawnSync } from 'child_process';
import * as dns from 'dns';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
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
import { runtimeBinaryPath, runtimeDataDir, runtimeHostLockPath } from './runtimePaths';

export { HEALTH_URL, HOME_URL, LEGACY_GATEWAY_ADDR, LOOPBACK_ADDRESSES };

/** Supervised command from the launcher contract. */
export const GATEWAY_ARGS: readonly string[] = ['gateway', '--addr', GATEWAY_ADDR];
export const HOME_TERMINAL_LINE = 'Keep this terminal open. Press Ctrl+C to stop Home.';

export interface HomeLaunch {
  args: readonly string[];
  quitWhenLastWindowCloses: boolean;
  updateRestartsHome: boolean;
  rollbackRestartsHome: boolean;
  hideTerminalKeepLine: boolean;
  openBrowserAfterInstall: boolean;
  offerKeepHomeOnQuit: boolean;
}

/** Each desktop platform starts the signed Home controller. */
export function homeLaunchForPlatform(platform: string): HomeLaunch {
  const browserHome = platform === 'darwin' || platform === 'linux' || platform === 'win32';
  return {
    args: browserHome ? ['home', '--browser'] : GATEWAY_ARGS,
    quitWhenLastWindowCloses: platform !== 'darwin' && platform !== 'linux',
    updateRestartsHome: browserHome,
    rollbackRestartsHome: browserHome,
    hideTerminalKeepLine: platform === 'linux' || platform === 'win32',
    openBrowserAfterInstall: platform !== 'linux' && platform !== 'win32',
    offerKeepHomeOnQuit: platform === 'linux',
  };
}
export const ALREADY_OWNS_TEXT = 'another ElastOS host already owns';
export const EXIT_BINARY_REPLACED = 75;
export const STOP_GRACE_MS = 15_000;
export const FOREIGN_LISTENER_MESSAGE =
  `Another program is answering at ${GATEWAY_ADDR}, so Home was not opened. Quit that program and click Try again.`;
export const LEGACY_STILL_RUNNING_MESSAGE =
  'An older ElastOS is still running and could not be stopped. Quit it, then click Start.';
export const HOME_UNCONFIRMED_MESSAGE =
  'Home could not be confirmed; stop it with Ctrl+C in its terminal';
export const OTHER_HOME_MESSAGE = 'another ElastOS Home is running';

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
  /** True only for the ChildProcess this launcher created. Stop keeps that handle. */
  readonly spawnedHere?: boolean;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  signal(signal: NodeJS.Signals): void;
  hasExited(): boolean | Promise<boolean>;
  /** Drop a stop helper. A process that has none does not implement this. */
  dispose?(): void;
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
 * Linux does not signal a legacy gateway. Windows may stop its distro
 * gateway and start `localhost:8090`. Home never opens on the legacy one.
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
  /** macOS caller already matched the kernel executable to an installed path. */
  verifiedExecutable?: string;
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
  if (input.verifiedExecutable) {
    // argv[0] may be an alias or symlink; authority comes from the kernel path.
    return /\bgateway\b|\bhome\s+--browser(?:\s|$)/.test(command) ? kind : null;
  }
  if (!/(^|[\\/\s])elastos(\.exe)?(\s|$)/i.test(command)
    || !(/\bgateway\b/.test(command) || /\bhome\s+--browser(?:\s|$)/.test(command))) return null;
  return kind;
}

/** A foreign OK on port 8090 opens Home only for a `localhost:8090` gateway. */
export function foreignListenerIsElastos(input: Parameters<typeof installedGatewayKind>[0]): boolean {
  return installedGatewayKind(input) === 'current';
}

export interface GatewaySupervisorDeps {
  platform?: string;
  binary: string;
  args?: readonly string[];
  /** Mac and Linux adopt the installed Home proved by its host lock and controller status. */
  adoptForControls?: boolean;
  spawn: (binary: string, args: readonly string[]) => GatewayProcess;
  fetchHealth: () => Promise<HealthResult | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openUrl: (url: string) => void;
  log: (line: string) => void;
  /** Linux drops the runtime's terminal sentence. Exit 75 still reads the raw stream. */
  hideTerminalKeepLine?: boolean;
  confirmForeign?: () => Promise<boolean>;
  /**
   * True when the running gateway is one an earlier launcher started on
   * `127.0.0.1:8090`. Start stops it once through `adoptInstalled` and
   * starts it again on `localhost:8090`.
   */
  foreignIsLegacy?: () => Promise<boolean>;
  /**
   * Linux sets this. A bare gateway on 127.0.0.1:8090 is another Home.
   * Start reports that and does not signal it. Windows leaves this unset.
   */
  reportLegacyHome?: () => Promise<boolean>;
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
  /**
   * Linux Stop signals the process this window spawned. Mac Stop adopts the
   * proved controller instead, including after that process has exited.
   */
  keepSpawnedHandle?: boolean;
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
  /** SIGKILL the process this supervisor is stopping. Used when quit runs out of time. */
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

export interface ProcProcess {
  pid: number;
  ppid: number;
  fdLinks: readonly string[];
}

/** `comm` may contain spaces. The kernel ends the name at the last `)`. */
export function procStatParent(stat: string): { pid: number; ppid: number } | null {
  const end = stat.lastIndexOf(')');
  const space = stat.indexOf(' ');
  if (end < 0 || space <= 0 || space > end) return null;
  const pid = Number(stat.slice(0, space));
  const ppid = Number(stat.slice(end + 2).split(' ')[1]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return null;
  return { pid, ppid };
}

/**
 * Sockets on `port` held by `root` itself.
 * Home names the gateway pid in the controller status. A descendant is not that pid.
 */
export function listenersFromProcSnapshot(
  tcp: string,
  tcp6: string,
  root: number,
  rows: readonly ProcProcess[],
  port = GATEWAY_PORT,
): PortListener[] {
  const own = rows.find((row) => row.pid === root);
  return procListenersFor(tcp, tcp6, own ? own.fdLinks : [], port);
}

/** Field 22 of `/proc/<pid>/stat`, the starttime tick. `comm` may contain spaces. */
export function linuxStatStartTicks(stat: string): string | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const ticks = stat.slice(end + 1).trim().split(/\s+/)[19];
  if (!ticks || !/^[0-9]+$/.test(ticks)) return null;
  return ticks;
}

/**
 * The same birth string Runtime 2.0.0 stores in `controller_start`
 * (`update_controller/child.rs` `process_identity`).
 */
export function linuxProcessIdentity(stat: string | null, bootId: string | null): string | null {
  if (!stat) return null;
  const ticks = linuxStatStartTicks(stat);
  if (!ticks) return null;
  const boot = (bootId ?? '').trim();
  if (!boot) return `linux:${ticks}`;
  if (/[\r\n]/.test(boot)) return null;
  return `linux:${boot}:${ticks}`;
}

export interface LinuxHomeStatus {
  controllerPid: number;
  controllerStart: string;
  hostPid: number;
  generation: string;
}

export interface HostLockRecord {
  pid: number;
  role: string;
  addr: string;
  generation: string;
}

function positivePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** `update-controller/status.json` from Runtime 2.0.0. A missing field is not a Home. */
export function parseLinuxHomeStatus(text: string | null): LinuxHomeStatus | null {
  if (!text || text.length > 16 * 1024) return null;
  let parsed: {
    controller_pid?: unknown;
    controller_start?: unknown;
    host_pid?: unknown;
    generation?: unknown;
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  const controllerPid = positivePid(parsed.controller_pid);
  const hostPid = positivePid(parsed.host_pid);
  const controllerStart = typeof parsed.controller_start === 'string' ? parsed.controller_start : '';
  const generation = typeof parsed.generation === 'string' ? parsed.generation : '';
  if (!controllerPid || !hostPid || !controllerStart || !generation) return null;
  if (controllerStart.length > 200 || generation.length > 128) return null;
  if (/[\r\n]/.test(controllerStart) || /[\r\n]/.test(generation)) return null;
  return { controllerPid, controllerStart, hostPid, generation };
}

/** `host-process.lock`. `generation` may be empty for a gateway this controller did not start. */
export function parseHostLockRecord(text: string | null): HostLockRecord | null {
  if (!text || text.length > 16 * 1024) return null;
  let parsed: { pid?: unknown; role?: unknown; addr?: unknown; generation?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  const pid = positivePid(parsed.pid);
  if (!pid || typeof parsed.role !== 'string' || typeof parsed.addr !== 'string') return null;
  const generation = typeof parsed.generation === 'string' ? parsed.generation : '';
  if (generation.length > 128 || /[\r\n]/.test(generation)) return null;
  return { pid, role: parsed.role, addr: parsed.addr, generation };
}

/** The controller Runtime 2.0.0 recorded, proved against the host lock and `/proc`. */
export interface ProvedLinuxHome {
  controllerPid: number;
  controllerStart: string;
  hostPid: number;
  hostStart: string;
  generation: string;
}

/**
 * Fail closed. The host lock must name this gateway on `localhost:8090`.
 * The status file must name that same pid, generation, and controller birth.
 * The host birth must be the same value on both sides of the descriptor read.
 */
export function proveLinuxHome(input: {
  statusText: string | null;
  lockText: string | null;
  bootId: string | null;
  controllerStat: string | null;
  hostStatBefore: string | null;
  hostFdLinks: readonly string[] | null;
  hostStatAfter: string | null;
  tcp: string;
  tcp6: string;
  answered?: readonly string[];
}): ProvedLinuxHome | null {
  const status = parseLinuxHomeStatus(input.statusText);
  const lock = parseHostLockRecord(input.lockText);
  if (!status || !lock) return null;
  if (lock.role !== 'gateway' || lock.addr !== GATEWAY_ADDR) return null;
  if (lock.pid !== status.hostPid || lock.generation !== status.generation) return null;
  const controllerNow = linuxProcessIdentity(input.controllerStat, input.bootId);
  const controllerParsed = input.controllerStat ? procStatParent(input.controllerStat) : null;
  if (controllerNow !== status.controllerStart || !controllerParsed || controllerParsed.pid !== status.controllerPid) {
    return null;
  }
  const before = linuxProcessIdentity(input.hostStatBefore, input.bootId);
  const after = linuxProcessIdentity(input.hostStatAfter, input.bootId);
  const hostParsed = input.hostStatBefore ? procStatParent(input.hostStatBefore) : null;
  if (!before || before !== after || !hostParsed || hostParsed.pid !== status.hostPid) return null;
  if (!input.hostFdLinks) return null;
  const listeners = procListenersFor(input.tcp, input.tcp6, input.hostFdLinks);
  if (listenerOwnership(listeners, LOOPBACK_ADDRESSES, input.answered ?? []) !== 'owned') return null;
  return {
    controllerPid: status.controllerPid,
    controllerStart: status.controllerStart,
    hostPid: status.hostPid,
    hostStart: before,
    generation: status.generation,
  };
}

/** The pid to signal, or null when its birth no longer matches the proof. */
export function linuxControllerSignalPid(proved: ProvedLinuxHome, identityNow: string | null): number | null {
  if (!identityNow || identityNow !== proved.controllerStart) return null;
  return proved.controllerPid;
}

/** One fresh read of the controller record, the lock, and `/proc`. */
export interface ControllerObservation {
  statusText: string | null;
  lockText: string | null;
  bootId: string | null;
  controllerStat: string | null;
  exePath: string | null;
  allowedExes: readonly string[];
}

export type ControllerRecord = Pick<ControllerObservation, 'statusText' | 'lockText' | 'bootId' | 'allowedExes'>;

export type ControllerProcView = Pick<ControllerObservation, 'controllerStat' | 'exePath'>;

/** A pidfd for one process. `send` cannot target a later occupant of the same pid number. */
export interface Pidfd {
  send(signal: NodeJS.Signals): void;
  close(): void;
}

/**
 * The update controller pid, or null. The start time, the exe, and the host
 * lock generation must all match this read. A host pid is not a target.
 */
export function confirmedControllerPid(observed: ControllerObservation): number | null {
  const status = parseLinuxHomeStatus(observed.statusText);
  const lock = parseHostLockRecord(observed.lockText);
  if (!status || !lock) return null;
  if (lock.role !== 'gateway' || lock.addr !== GATEWAY_ADDR) return null;
  if (!status.generation || lock.generation !== status.generation) return null;
  const identity = linuxProcessIdentity(observed.controllerStat, observed.bootId);
  const parsed = observed.controllerStat ? procStatParent(observed.controllerStat) : null;
  if (identity !== status.controllerStart || !parsed || parsed.pid !== status.controllerPid) return null;
  const exe = observed.exePath;
  if (!exe || exe.endsWith(' (deleted)')) return null;
  if (!observed.allowedExes.includes(exe)) return null;
  return status.controllerPid;
}

export function signalRecordedController(
  signal: NodeJS.Signals,
  io: {
    readRecord: () => ControllerRecord;
    readProc: (pid: number) => ControllerProcView;
    openPidfd: (pid: number) => Pidfd;
  },
  held: { pidfd: Pidfd | null },
): void {
  if (!held.pidfd) {
    const record = io.readRecord();
    const status = parseLinuxHomeStatus(record.statusText);
    const lock = parseHostLockRecord(record.lockText);
    if (!status || !lock || lock.role !== 'gateway' || lock.addr !== GATEWAY_ADDR
      || !status.generation || lock.generation !== status.generation) {
      throw new Error(HOME_UNCONFIRMED_MESSAGE);
    }
    let pidfd: Pidfd;
    try {
      pidfd = io.openPidfd(status.controllerPid);
    } catch {
      throw new Error(HOME_UNCONFIRMED_MESSAGE);
    }
    let proc: ControllerProcView;
    try {
      proc = io.readProc(status.controllerPid);
    } catch {
      pidfd.close();
      throw new Error(HOME_UNCONFIRMED_MESSAGE);
    }
    const confirmed = confirmedControllerPid({
      statusText: record.statusText,
      lockText: record.lockText,
      bootId: record.bootId,
      allowedExes: record.allowedExes,
      controllerStat: proc.controllerStat,
      exePath: proc.exePath,
    });
    if (confirmed !== status.controllerPid) {
      pidfd.close();
      throw new Error(HOME_UNCONFIRMED_MESSAGE);
    }
    held.pidfd = pidfd;
  }
  try {
    held.pidfd.send(signal);
  } catch (err) {
    if (signalErrorCode(err) === 'ESRCH') return;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not signal ElastOS (${signal}): ${message}`);
  }
}

export function controllerGateway(
  readRecord: () => ControllerRecord,
  readProc: (pid: number) => ControllerProcView,
  openPidfd: (pid: number) => Pidfd,
): GatewayProcess {
  const held: { pidfd: Pidfd | null } = { pidfd: null };
  function observation(): ControllerObservation | null {
    const record = readRecord();
    const status = parseLinuxHomeStatus(record.statusText);
    if (!status) return null;
    const proc = readProc(status.controllerPid);
    return {
      statusText: record.statusText,
      lockText: record.lockText,
      bootId: record.bootId,
      allowedExes: record.allowedExes,
      controllerStat: proc.controllerStat,
      exePath: proc.exePath,
    };
  }
  return {
    pid: -1,
    onOutput() {},
    onExit() {},
    hasExited() {
      let gone = false;
      try {
        const observed = observation();
        gone = observed === null || confirmedControllerPid(observed) === null;
      } catch {
        return false;
      }
      if (gone && held.pidfd) {
        held.pidfd.close();
        held.pidfd = null;
      }
      return gone;
    },
    signal(signal) {
      signalRecordedController(signal, { readRecord, readProc, openPidfd }, held);
    },
    dispose() {
      const pidfd = held.pidfd;
      held.pidfd = null;
      if (!pidfd) return;
      try {
        pidfd.close();
      } catch {
        // Stop still reports its own error. close() has already dropped the helper.
      }
    },
  };
}

function throwSignalCode(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function linuxPidfdHelperPath(): string {
  return path.join(__dirname, '../../native/linux-pidfd')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function makeFifo(file: string): void {
  const result = spawnSync('mkfifo', ['-m', '600', file], { timeout: 1000 });
  if (result.error || result.status !== 0) throwSignalCode('ENOSYS', 'pidfd is unavailable');
}

function waitBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

function readPidfdLine(fd: number, deadline: number): string {
  const buf = Buffer.alloc(64);
  let text = '';
  while (!text.includes('\n')) {
    if (text.length > 64) throwSignalCode('EIO', 'pidfd reply is too long');
    if (Date.now() >= deadline) throwSignalCode('ETIMEDOUT', 'pidfd helper timed out');
    try {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        waitBriefly();
        continue;
      }
      text += buf.toString('utf8', 0, n);
    } catch (err) {
      const code = signalErrorCode(err);
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        waitBriefly();
        continue;
      }
      throw err;
    }
  }
  return text.slice(0, text.indexOf('\n'));
}

function openFifoWrite(file: string, deadline: number): number {
  const flags = fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
  for (;;) {
    if (Date.now() >= deadline) throwSignalCode('ETIMEDOUT', 'pidfd helper timed out');
    try {
      return fs.openSync(file, flags);
    } catch (err) {
      if (signalErrorCode(err) === 'ENXIO') {
        waitBriefly();
        continue;
      }
      throw err;
    }
  }
}

export function openLinuxPidfd(pid: number, options?: { helper?: string }): Pidfd {
  if (!Number.isInteger(pid) || pid <= 0) throwSignalCode('EINVAL', 'bad pid');
  const helper = options?.helper ?? linuxPidfdHelperPath();
  if (!options?.helper && process.platform !== 'linux') throwSignalCode('ENOSYS', 'pidfd is unavailable');
  if (!fs.existsSync(helper)) throwSignalCode('ENOENT', 'pidfd helper is missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-pidfd-'));
  fs.chmodSync(dir, 0o700);
  const replyPath = path.join(dir, 'reply');
  const cmdPath = path.join(dir, 'cmd');
  let child: ChildProcess | null = null;
  let replyFd: number | null = null;
  let cmdFd: number | null = null;
  let settled = false;
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    if (cmdFd === null) {
      try {
        cmdFd = fs.openSync(cmdPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      } catch (err) {
        const code = signalErrorCode(err);
        if (code !== 'ENXIO' && code !== 'ENOENT') throw err;
      }
    }
    const command = cmdFd;
    const reply = replyFd;
    cmdFd = null;
    replyFd = null;
    let closeError: unknown = null;
    if (command !== null) {
      try { fs.closeSync(command); } catch (err) { closeError = err; }
    }
    if (reply !== null) {
      try { fs.closeSync(reply); } catch (err) { if (!closeError) closeError = err; }
    }
    child?.unref();
    fs.rmSync(dir, { recursive: true, force: true });
    if (closeError) throw closeError;
  };
  try {
    makeFifo(replyPath);
    makeFifo(cmdPath);
    child = spawn(helper, [String(pid), replyPath, cmdPath], { stdio: 'ignore' });
    // Node crashes when the spawn error event has no listener.
    child.on('error', () => {});
    if (!child.pid) throwSignalCode('ENOENT', 'pidfd helper is missing');
    const replyFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
    replyFd = fs.openSync(replyPath, replyFlags);
    const ready = readPidfdLine(replyFd, Date.now() + 2000);
    if (ready.startsWith('errno ')) throwSignalCode(ready.slice('errno '.length), ready);
    if (ready !== 'ready') throwSignalCode('EIO', 'pidfd helper did not become ready');
    cmdFd = openFifoWrite(cmdPath, Date.now() + 2000);
    const reply = replyFd;
    const cmd = cmdFd;
    let closed = false;
    return {
      send(signal: NodeJS.Signals): void {
        if (closed) throwSignalCode('EBADF', 'pidfd is closed');
        if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throwSignalCode('EINVAL', 'unsupported signal');
        fs.writeSync(cmd, `${signal}\n`);
        const line = readPidfdLine(reply, Date.now() + 2000);
        if (line === 'sent') return;
        if (line.startsWith('errno ')) throwSignalCode(line.slice('errno '.length), line);
        throwSignalCode('EIO', 'pidfd helper reply was not a signal result');
      },
      close(): void {
        if (closed) return;
        closed = true;
        try {
          fs.writeSync(cmd, 'close\n');
        } catch (err) {
          const code = signalErrorCode(err);
          if (code !== 'EPIPE' && code !== 'EBADF') {
            cleanup();
            throw err;
          }
        }
        cleanup();
      },
    };
  } catch (err) {
    cleanup();
    throw err;
  }
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
export function scrubRuntimeLog(chunk: string, platform: string = process.platform): string {
  if (/attach_secret|runtime-coords\.json|gateway-runtime-coords|home-runtime-coords/i.test(chunk)) {
    return '[elastos] omitted a line that can contain a local secret\n';
  }
  if (platform !== 'win32' || !chunk.includes(HOME_TERMINAL_LINE)) return chunk;
  return chunk.split(HOME_TERMINAL_LINE).join('');
}

export function launcherLogText(text: string, hideTerminalKeepLine: boolean, platform: string = process.platform): string {
  const clean = scrubRuntimeLog(text, platform);
  if (!hideTerminalKeepLine) return clean;
  return clean.split('\n').filter((line) => !line.includes(HOME_TERMINAL_LINE)).join('\n');
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
  const homeController = deps.args?.[0] === 'home';

  const note = (line: string) => {
    const clean = launcherLogText(line, deps.hideTerminalKeepLine === true, deps.platform).replace(/\s+$/g, '');
    if (!clean) return;
    logs.push(clean);
    deps.log(clean);
  };

  function recordExit(proc: GatewayProcess, code: number | null): void {
    if (owned !== proc) return;
    owned = null;
    foreign = false;
    if (intentionalStop || current !== 'running') return;
    current = code === 0 ? 'stopped' : 'error';
    note(code === 0 ? 'ElastOS stopped.' : code === null
      ? 'ElastOS stopped unexpectedly. Click Start to try again.'
      : `ElastOS stopped (exit ${code}). Click Start to try again.`);
  }

  function replaceOwned(proc: GatewayProcess | null): void {
    if (owned && owned !== proc) owned.dispose?.();
    owned = proc;
  }

  function ownAdopted(proc: GatewayProcess | null): void {
    replaceOwned(proc);
    proc?.onExit((code) => recordExit(proc, code));
  }

  async function findInstalled(): Promise<GatewayProcess | null> {
    const attempts = deps.adoptForControls ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const proc = await (deps.adoptInstalled?.() ?? null);
      if (proc) return proc;
      if (attempt + 1 < attempts) {
        note('Checking Home ownership again.');
        await deps.sleep(pollMs);
      }
    }
    return null;
  }

  async function launchOnce(): Promise<'ready' | 'replaced' | 'already'> {
    intentionalStop = false;
    foreign = false;
    const proc = deps.spawn(deps.binary, deps.args ?? GATEWAY_ARGS);
    replaceOwned(proc);
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
      if (owned !== proc) return;
      if (homeController) {
        recordExit(proc, code);
        return;
      }
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
        return;
      }
      recordExit(proc, code);
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
    if (!homeController && binaryReplacement(output, code)) {
      restarts += 1;
      if (restarts > maxRestarts) {
        throw new Error('ElastOS kept restarting after an update. Click Start to try again.');
      }
      note('ElastOS was updated. Starting it again.');
      return 'replaced';
    }
    if (code === EXIT_BINARY_REPLACED) {
      current = 'error';
      throw new Error('ElastOS stopped (exit 75) without a replaced binary. It was not started again.');
    }
    if (output.includes(ALREADY_OWNS_TEXT)) {
      return 'already';
    }
    const tail = launcherLogText(output, deps.hideTerminalKeepLine === true, deps.platform).trim().split('\n').slice(-3).join(' ');
    current = 'error';
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
    try {
      proc.signal('SIGTERM');
      if (await confirmedStopped(proc, graceMs)) {
        proc.dispose?.();
        owned = null;
        current = 'stopped';
        return;
      }
      proc.signal('SIGKILL');
      if (await confirmedStopped(proc, graceMs)) {
        proc.dispose?.();
        owned = null;
        current = 'stopped';
        return;
      }
      current = 'error';
      throw new Error('ElastOS is still running.');
    } catch (err) {
      proc.dispose?.();
      throw err;
    }
  }

  const supervisor: GatewaySupervisor = {
    async start() {
      if (owned && current === 'running') {
        if (!(await owned.hasExited())) return 'started';
        owned = null;
      }
      current = 'starting';
      let legacyStopped = false;
      for (;;) {
        const result = await launchOnce();
        if (result === 'replaced') continue;
        if (result === 'already') {
          if (deps.reportLegacyHome && await deps.reportLegacyHome()) {
            current = 'error';
            throw new Error(OTHER_HOME_MESSAGE);
          }
          if (!legacyStopped && deps.foreignIsLegacy && await deps.foreignIsLegacy()) {
            // An earlier launcher started it on 127.0.0.1. Passkeys need
            // localhost, so stop it once and start it again here.
            legacyStopped = true;
            note('An older ElastOS is running on 127.0.0.1:8090. Starting it again on localhost:8090.');
            const adopted = await findInstalled();
            if (!adopted) {
              current = 'error';
              throw new Error(LEGACY_STILL_RUNNING_MESSAGE);
            }
            ownAdopted(adopted);
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
            throw new Error('ElastOS is already running, but it is not answering yet. Wait a moment and click Open Home.');
          }
          const confirmed = deps.confirmForeign ? await deps.confirmForeign() : false;
          if (!confirmed) {
            current = 'error';
            throw new Error('Something is answering on port 8090, but it is not the ElastOS gateway. Home was not opened.');
          }
          foreign = true;
          intentionalStop = false;
          ownAdopted(deps.adoptForControls ? await findInstalled() : null);
          current = 'running';
          deps.openUrl(HOME_URL);
          return 'already-running';
        }
        current = 'running';
        return 'started';
      }
    },
    async stop(options?: { adopt?: boolean }) {
      const currentProc = owned;
      const keepSpawned = deps.keepSpawnedHandle === true
        && currentProc !== null && currentProc.spawnedHere === true
        && !(await currentProc.hasExited());
      if (!keepSpawned && deps.adoptForControls && isHealthOk(await deps.fetchHealth())) {
        const installed = await findInstalled();
        if (!installed) throw new ForeignGatewayError();
        ownAdopted(installed);
      }
      if (!owned) {
        const health = await deps.fetchHealth();
        if (isHealthOk(health)) {
          const adopted = (options?.adopt || deps.adoptForControls)
            ? await findInstalled()
            : null;
          if (!adopted) throw new ForeignGatewayError();
          ownAdopted(adopted);
        } else {
          foreign = false;
          current = 'stopped';
          return;
        }
      }
      if (owned) {
        try {
          await stopProcess(owned);
        } catch (err) {
          current = 'error';
          throw err;
        }
      }
    },
    forceKill() {
      if (!owned) return;
      const failed = current === 'error';
      try {
        owned.signal('SIGKILL');
      } catch {
        // Quit still closes. The error from stop() is logged by the caller.
      }
      if (failed) owned.dispose?.();
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

export function spawnGatewayProcess(
  binary: string,
  args: readonly string[],
  platform: string = process.platform,
): GatewayProcess {
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
    spawnedHere: true,
    signal(signal) {
      if (platform === 'darwin') {
        signalProcessGroup(child.pid ?? -1, signal);
        return;
      }
      try {
        child.kill(signal);
      } catch (err) {
        if (signalErrorCode(err) === 'ESRCH') return;
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not signal ElastOS (${signal}): ${message}`);
      }
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

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('localhost lookup timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The addresses `localhost` resolves to on this computer, in resolver order. */
export async function resolveLocalhost(timeoutMs = 2000): Promise<string[]> {
  const found = await withDeadline(
    dns.promises.lookup(GATEWAY_HOST, { all: true, verbatim: true }),
    timeoutMs,
  );
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
    addresses = options.lookup
      ? await withDeadline(options.lookup(), timeoutMs)
      : await resolveLocalhost(timeoutMs);
  } catch {
    return null;
  }
  if (!localhostIsLoopback(addresses)) return null;
  const get = options.get ?? getHealthAt;
  const results = await Promise.all(addresses.map(async (address) => ({ address, health: await get(address, timeoutMs) })));
  return combineHealth(results);
}

const PROC_STAT_MAX = 4096;
const PROC_TEXT_MAX = 8 * 1024 * 1024;
const HOME_RECORD_MAX = 16 * 1024;

function fdLinks(pid: number): string[] | null {
  const links: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      links.push(fs.readlinkSync(`/proc/${pid}/fd/${name}`));
    } catch {
      // A descriptor can disappear between readdir and readlink.
    }
  }
  return links;
}

/** `undefined` when the path is absent. `null` when the bytes are not a bounded file. */
function readProcOptional(file: string, max: number): string | null | undefined {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      total += n;
      if (total > max) return null;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
    if (code === 'ENOENT') return undefined;
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function readRegularText(file: string, max: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > max) return null;
    const buf = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const n = fs.readSync(fd, buf, offset, info.size - offset, offset);
      if (n <= 0) return null;
      offset += n;
    }
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Listeners held by `pid` itself. Null when `/proc` cannot prove that. */
function linuxProcessListeners(pid: number): PortListener[] | null {
  const tcp = readProcOptional('/proc/net/tcp', PROC_TEXT_MAX);
  if (!tcp) return null;
  const tcp6 = readProcOptional('/proc/net/tcp6', PROC_TEXT_MAX);
  if (tcp6 === null) return null;
  const links = fdLinks(pid);
  if (!links) return null;
  return procListenersFor(tcp, tcp6 ?? '', links);
}

function readProvedLinuxHome(answered: readonly string[] = []): ProvedLinuxHome | null {
  const data = runtimeDataDir('linux', os.homedir(), process.env);
  const statusText = readRegularText(`${data}/update-controller/status.json`, HOME_RECORD_MAX);
  const lockText = readRegularText(runtimeHostLockPath(data), HOME_RECORD_MAX);
  const bootId = readProcOptional('/proc/sys/kernel/random/boot_id', 128);
  if (bootId === null) return null;
  const status = parseLinuxHomeStatus(statusText);
  if (!status) return null;
  const hostStatBefore = readProcOptional(`/proc/${status.hostPid}/stat`, PROC_STAT_MAX);
  const hostFdLinks = fdLinks(status.hostPid);
  const hostStatAfter = readProcOptional(`/proc/${status.hostPid}/stat`, PROC_STAT_MAX);
  const controllerStat = readProcOptional(`/proc/${status.controllerPid}/stat`, PROC_STAT_MAX);
  const tcp = readProcOptional('/proc/net/tcp', PROC_TEXT_MAX);
  const tcp6 = readProcOptional('/proc/net/tcp6', PROC_TEXT_MAX);
  if (!controllerStat || !hostStatBefore || !hostStatAfter || !tcp || tcp6 === null) return null;
  return proveLinuxHome({
    statusText,
    lockText,
    bootId: bootId ?? null,
    controllerStat,
    hostStatBefore,
    hostFdLinks,
    hostStatAfter,
    tcp,
    tcp6: tcp6 ?? '',
    answered,
  });
}

function linuxControllerOwnsListeners(controllerPid: number, health: HealthResult): boolean {
  const proved = readProvedLinuxHome(health.addresses ?? []);
  if (!proved || proved.controllerPid !== controllerPid) return false;
  const bootId = readProcOptional('/proc/sys/kernel/random/boot_id', 128);
  const stat = readProcOptional(`/proc/${proved.controllerPid}/stat`, PROC_STAT_MAX);
  if (bootId === null || !stat) return false;
  return linuxControllerSignalPid(proved, linuxProcessIdentity(stat, bootId ?? null)) === proved.controllerPid;
}

/** LISTEN sockets on the gateway port, marked by whether `pid` itself holds each. Null when they cannot be read. */
export async function localListeners(pid: number, platform: string = process.platform): Promise<PortListener[] | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') return linuxProcessListeners(pid);
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

/** Linux and Mac Stop and Quit take the installed Home. Windows does not. */
export function platformAdoptsInstalledHome(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux';
}

export function createDefaultGatewaySupervisor(binary: string, platform: string = process.platform): GatewaySupervisor {
  const launch = homeLaunchForPlatform(platform);
  return createGatewaySupervisor({
    binary,
    platform,
    args: launch.args,
    hideTerminalKeepLine: launch.hideTerminalKeepLine,
    adoptForControls: platformAdoptsInstalledHome(platform),
    keepSpawnedHandle: platform === 'linux',
    healthTimeoutMs: platform === 'darwin' ? 150000 : 60000,
    spawn: (command, commandArgs) => spawnGatewayProcess(command, commandArgs, platform),
    fetchHealth: () => probeGatewayHealth(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    openUrl: openRuntimeHome,
    log: (line) => logSink(line),
    confirmForeign: confirmInstalledGateway,
    foreignIsLegacy: platform === 'darwin'
      ? async () => (await installedGatewayOnThisComputer(platform)) === 'legacy'
      : undefined,
    reportLegacyHome: platform === 'linux'
      ? async () => (await installedGatewayOnThisComputer(platform)) === 'legacy'
      : undefined,
    listenerOwned: (pid, health) => platform === 'darwin'
      ? installedGatewayOnThisComputer(platform).then((kind) => kind === 'current')
      : platform === 'linux'
        ? linuxControllerOwnsListeners(pid, health)
        : pidOwnsGatewayPort(pid, LOOPBACK_ADDRESSES, health.addresses ?? []),
    adoptInstalled: () => adoptInstalledGatewayProcess(platform),
  });
}

/** Read a regular control file through one fd; size changes cannot exceed the cap. */
function readControlFile(file: string, maximum = 16 * 1024): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) return null;
    const bytes = Buffer.alloc(maximum + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return count > maximum ? null : bytes.toString('utf8', 0, count);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readHostLock(platform: string, homeDir: string): { text: string | null; pid: number } {
  const lockPath = runtimeHostLockPath(runtimeDataDir(platform, homeDir, process.env));
  const text = readControlFile(lockPath);
  let pid = 0;
  try {
    const parsed = JSON.parse(text ?? '') as { pid?: unknown };
    pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
  } catch {
    pid = 0;
  }
  return { text, pid };
}

type MacProcessIdentity = { executable: string; start: string };

function psField(pid: number, field: string): string {
  return execFileSync('ps', ['-p', String(pid), '-ww', '-o', `${field}=`], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024, env: { ...process.env, LC_ALL: 'C' },
  }).trim();
}

function macProcessIdentity(pid: number): MacProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const helper = path.join(__dirname, '../../native/mac-process-info')
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const report = execFileSync(helper, [String(pid)], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024,
    });
    const newline = report.indexOf('\n');
    const start = report.slice(0, newline);
    const executable = report.slice(newline + 1);
    if (!/^\d+\.\d{6}$/.test(start) || !path.isAbsolute(executable) || executable.includes('\0')) return null;
    return { executable, start };
  } catch {
    return null;
  }
}

function sameMacProcess(expected: MacProcessIdentity, actual: MacProcessIdentity | null): boolean {
  return actual !== null && actual.start === expected.start && actual.executable === expected.executable;
}

function installedMacExecutable(homeDir: string, executable: string): boolean {
  const candidates = [runtimeBinaryPath(homeDir)];
  try {
    const data = runtimeDataDir('darwin', homeDir, process.env);
    const sources = JSON.parse(readControlFile(path.join(data, 'sources.json'), 256 * 1024) ?? '{}');
    const selected = sources.sources?.find((source: { name?: unknown }) => source.name === sources.default_source);
    if (typeof selected?.install_path === 'string' && path.isAbsolute(selected.install_path)) {
      candidates.push(selected.install_path);
    }
  } catch {
    // The default installed binary remains usable without a sources record.
  }
  return candidates.some((candidate) => {
    try { return fs.realpathSync(candidate) === executable; } catch { return false; }
  });
}

async function hostLockGatewayKind(
  text: string | null, pid: number, platform: string, homeDir: string,
): Promise<InstalledGatewayKind | null> {
  const identity = platform === 'darwin' ? macProcessIdentity(pid) : null;
  if (platform === 'darwin' && (!identity || !installedMacExecutable(homeDir, identity.executable))) return null;
  const listeners = await localListeners(pid, platform);
  const kind = installedGatewayKind({
    lockText: text,
    command: processCommand(pid, platform),
    verifiedExecutable: identity?.executable,
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
  if (identity && !sameMacProcess(identity, macProcessIdentity(pid))) return null;
  return kind;
}

/** The installed gateway's kind on Linux and macOS, from the host lock. Null when it is not proved. */
export async function installedGatewayOnThisComputer(
  platform: string = process.platform, homeDir: string = os.homedir(),
): Promise<InstalledGatewayKind | null> {
  if (platform === 'win32') return null;
  const { text, pid } = readHostLock(platform, homeDir);
  return hostLockGatewayKind(text, pid, platform, homeDir);
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
 * Stop can signal one process this window did not spawn: the update controller
 * named by status.json. A `127.0.0.1:8090` gateway is not that process.
 */
function signalErrorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
}

function resolvedFile(file: string): string | null {
  try {
    const real = fs.realpathSync(file);
    return real ? real : null;
  } catch {
    return null;
  }
}

function controllerExeFromProc(pid: number): string | null {
  let link: string;
  try {
    link = fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
  if (!link || link.endsWith(' (deleted)')) return null;
  return resolvedFile(link);
}

/** The installed binary, and the controller copy Runtime stores under the data dir. */
function allowedControllerExes(homeDir: string, dataDir: string): string[] {
  const files = [
    runtimeBinaryPath(homeDir),
    `${dataDir}/update-controller/runtime`,
  ];
  const allowed: string[] = [];
  for (const file of files) {
    const real = resolvedFile(file);
    if (real && !allowed.includes(real)) allowed.push(real);
  }
  return allowed;
}

function observeControllerRecord(homeDir: string): ControllerRecord {
  const data = runtimeDataDir('linux', homeDir, process.env);
  const statusText = readRegularText(`${data}/update-controller/status.json`, HOME_RECORD_MAX);
  const lockText = readRegularText(runtimeHostLockPath(data), HOME_RECORD_MAX);
  const boot = readProcOptional('/proc/sys/kernel/random/boot_id', 128);
  return {
    statusText,
    lockText,
    bootId: boot ?? null,
    allowedExes: allowedControllerExes(homeDir, data),
  };
}

function observeControllerProc(pid: number): ControllerProcView {
  if (!Number.isInteger(pid) || pid <= 0) return { controllerStat: null, exePath: null };
  const stat = readProcOptional(`/proc/${pid}/stat`, PROC_STAT_MAX);
  return {
    controllerStat: stat ?? null,
    exePath: controllerExeFromProc(pid),
  };
}

/** `controller` may be signaled. `other-home` is a legacy gateway and is never signaled. */
export function linuxControllerAdopt(lockText: string | null): 'controller' | 'other-home' | 'none' {
  const lock = parseHostLockRecord(lockText);
  if (!lock || lock.role !== 'gateway') return 'none';
  if (lock.addr === LEGACY_GATEWAY_ADDR) return 'other-home';
  if (lock.addr !== GATEWAY_ADDR) return 'none';
  return 'controller';
}

/** Linux Home. Signal only the recorded update controller. A legacy gateway is not adopted. */
async function adoptLinuxGatewayProcess(homeDir: string): Promise<GatewayProcess | null> {
  const data = runtimeDataDir('linux', homeDir, process.env);
  const lockText = readRegularText(runtimeHostLockPath(data), HOME_RECORD_MAX);
  if (linuxControllerAdopt(lockText) !== 'controller') return null;
  return controllerGateway(
    () => observeControllerRecord(homeDir),
    (pid) => observeControllerProc(pid),
    openLinuxPidfd,
  );
}

export async function adoptInstalledGatewayProcess(
  platform: string = process.platform, homeDir: string = os.homedir(),
): Promise<GatewayProcess | null> {
  if (platform === 'win32') return null;
  if (platform === 'linux') return adoptLinuxGatewayProcess(homeDir);
  const refused = (reason: string): null => {
    logSink(`Home ownership check: ${reason}`);
    return null;
  };
  const { text, pid } = readHostLock(platform, homeDir);
  if (pid <= 0) return refused('host-lock');
  const hostIdentity = platform === 'darwin' ? macProcessIdentity(pid) : null;
  if (platform === 'darwin' && !hostIdentity) return refused('native-host');
  if (!(await hostLockGatewayKind(text, pid, platform, homeDir))) return refused('host-proof');
  if (platform === 'darwin' && (!hostIdentity || !sameMacProcess(hostIdentity, macProcessIdentity(pid)))) return refused('host-changed');
  let stopPid = pid;
  let stopIdentity = hostIdentity;
  if (platform === 'darwin') {
    const data = runtimeDataDir(platform, homeDir, process.env);
    const statusText = readControlFile(path.join(data, 'update-controller', 'status.json'));
    try {
      // A directly started gateway has no controller status file.
      if (statusText !== null) {
        const status = JSON.parse(statusText);
        const lock = JSON.parse(text ?? '{}');
        const controller = status.controller_pid;
        const identity = macProcessIdentity(controller);
        if (status.host_pid === pid && typeof lock.generation === 'string' && status.generation === lock.generation
          && identity && identity.executable === path.join(data, 'update-controller', 'runtime')
          && processCommand(controller, platform)?.startsWith(`${identity.executable} __update-controller `)
          && Number(psField(pid, 'ppid')) === controller) {
          stopPid = controller;
          stopIdentity = identity;
        }
        // A stale controller record grants no authority over that controller.
        // The independently proved host can still be stopped after a crash.
      } else if (fs.existsSync(path.join(data, 'update-controller', 'status.json'))) {
        return refused('controller-status');
      }
    } catch {
      return refused('controller-metadata');
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let notified = false;
  const exitListeners: Array<(code: number | null) => void> = [];
  function gone(target: number, identity: MacProcessIdentity | null): boolean {
    if (localPidHasExited(target)) return true;
    const actual = identity ? macProcessIdentity(target) : null;
    return Boolean(identity && actual && !sameMacProcess(identity, actual));
  }
  function observeExit(): void {
    if (gone(stopPid, stopIdentity) && !notified) {
      notified = true;
      if (timer) clearInterval(timer);
      for (const listener of exitListeners) listener(gone(pid, hostIdentity) ? 0 : null);
    }
  }
  function hasExited(): boolean {
    observeExit();
    return gone(pid, hostIdentity) && (stopPid === pid || gone(stopPid, stopIdentity));
  }
  return {
    pid,
    onOutput() {},
    onExit(listener) {
      exitListeners.push(listener);
      if (!timer && !notified) {
        timer = setInterval(observeExit, 1000);
        timer.unref();
      }
    },
    hasExited,
    signal(signal) {
      // The controller drains its own children. Recheck the signal recipient,
      // including its birth time, immediately before TERM or escalation to KILL.
      if (platform === 'darwin') {
        if (!stopIdentity || !sameMacProcess(stopIdentity, macProcessIdentity(stopPid))) {
          throw new Error('ElastOS process identity changed. Refusing to signal a reused PID.');
        }
        process.kill(stopPid, signal);
      } else {
        signalProcessGroup(pid, signal);
      }
    },
  };
}

function processCommand(pid: number, platform: string = process.platform): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000, maxBuffer: 16 * 1024,
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
