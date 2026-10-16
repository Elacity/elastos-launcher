import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { HEALTH_URL } from './runtimeGateway';
import { launcherOwnedDirectories } from './runtimePaths';
import { loadActiveRuntimePin } from './runtimePin';
import { BASH_MESSAGE, detectLinuxLibc, MUSL_MESSAGE, resolveBash } from './hostTools';
import { runtimeInstallBlock, wslKvmMessage, detectWsl } from './runtimeSupport';
import { detectWindows, hostPrompt, listDistros, lookupCommand } from './windowsHost';

export const DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

export interface PreflightCheck {
  id: string;
  level: 'pass' | 'warn' | 'block';
  message: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightInput {
  platform: string;
  arch: string;
  freeBytes: number | null;
  portBusy: boolean;
  healthOk: boolean;
  offline: boolean;
  wsl: boolean;
  kvm: boolean;
  wslInstalled?: boolean;
  distroReady?: boolean;
  libc?: 'glibc' | 'musl' | 'unknown';
  bashPresent?: boolean;
}

export function evaluatePreflight(input: PreflightInput): PreflightReport {
  const checks: PreflightCheck[] = [];
  if (input.platform === 'win32') {
    const prompt = hostPrompt({
      platform: input.platform,
      arch: input.arch,
      wslInstalled: input.wslInstalled ?? false,
      distroReady: input.distroReady ?? false,
    });
    const message = `${prompt.title}. ${prompt.body}`;
    const ready = prompt.kind === 'ready';
    checks.push({
      id: 'windows',
      level: ready ? 'pass' : 'block',
      message,
    });
    checks.push({
      id: 'platform',
      level: ready ? 'pass' : 'block',
      message: ready ? 'This computer can run ElastOS.' : message,
    });
  } else {
    const platform = runtimeInstallBlock(input.platform, input.arch);
    checks.push(platform
      ? { id: 'platform', level: 'block', message: platform }
      : { id: 'platform', level: 'pass', message: 'This computer can run ElastOS.' });
  }

  if (input.freeBytes == null) {
    checks.push({ id: 'disk', level: 'warn', message: 'Could not check free disk space.' });
  } else if (input.freeBytes < DISK_FLOOR_BYTES) {
    checks.push({ id: 'disk', level: 'block', message: 'This computer needs about 2 GB free to install ElastOS.' });
  } else {
    checks.push({ id: 'disk', level: 'pass', message: 'There is enough free disk space.' });
  }

  if (input.healthOk) {
    checks.push({ id: 'port', level: 'pass', message: 'Your computer is already running.' });
  } else if (input.portBusy) {
    checks.push({ id: 'port', level: 'block', message: 'Port 8090 is being used by another program. Quit that program and try again.' });
  } else {
    checks.push({ id: 'port', level: 'pass', message: 'Port 8090 is free.' });
  }

  checks.push(input.offline
    ? { id: 'network', level: 'block', message: 'You appear to be offline. Connect to the internet and try again.' }
    : { id: 'network', level: 'pass', message: 'The network is reachable.' });

  if (input.platform === 'linux' && input.libc === 'musl') {
    checks.push({ id: 'libc', level: 'block', message: MUSL_MESSAGE });
  }
  if ((input.platform === 'linux' || input.platform === 'darwin') && input.bashPresent === false) {
    checks.push({ id: 'bash', level: 'block', message: BASH_MESSAGE });
  }

  const kvm = wslKvmMessage(input.wsl, input.kvm);
  if (kvm) checks.push({ id: 'kvm', level: 'warn', message: kvm });

  return { ok: checks.every((check) => check.level !== 'block'), checks };
}

export function buildDiagnostics(info: {
  launcherVersion: string;
  runtimeVersion?: string;
  target: string;
  channel: string;
  pinVersion: string | null;
  platform: string;
  arch: string;
  status: string;
  health?: string;
  error: string;
  logs: string;
  checks: PreflightCheck[];
}): string {
  const checks = info.checks.map((check) => `${check.level} ${check.id}: ${check.message}`).join('\n');
  const body = [
    'ElastOS diagnostics',
    `launcher: ${info.launcherVersion}`,
    `runtime: ${info.runtimeVersion || 'unknown'}`,
    `target: ${info.target}`,
    `channel: ${info.channel}`,
    `pin: ${info.pinVersion ?? 'none'}`,
    `computer: ${info.platform}/${info.arch}`,
    `status: ${info.status}`,
    `health: ${info.health || 'unknown'}`,
    `error: ${info.error || 'none'}`,
    '',
    'checks:',
    checks || 'none',
    '',
    'log:',
    info.logs || 'none',
    '',
  ].join('\n');
  return scrubSupportText(body);
}

const DROP_SUPPORT_LINE = /runtime-coords\.json|gateway-runtime-coords|home-runtime-coords|\bprivate key\b|BEGIN [A-Z0-9 ]*PRIVATE KEY/i;

/**
 * Drop PEM and coordinate-file lines, and redact secret assignments that
 * share a line with text worth keeping.
 */
export function scrubSupportText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !DROP_SUPPORT_LINE.test(line))
    .map((line) => line
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[removed]')
      .replace(/(\battach_secret\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\bapi[_-]?key\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\baccess_token\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\btoken\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\bcookie\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\bauthorization\s*=\s*)\S+/gi, '$1[removed]')
      .replace(/bearer\s+\S+/gi, 'bearer [removed]')
      .replace(/password\s*[:=]\s*\S+/gi, 'password [removed]'))
    .join('\n');
}

export const SUPPORT_BUNDLE_NAME = 'ElastOS-support.txt';

export function supportBundlePath(homeDir: string, desktopExists: boolean): string {
  const dir = desktopExists ? path.join(homeDir, 'Desktop') : homeDir;
  return path.join(dir, SUPPORT_BUNDLE_NAME);
}

export function saveSupportBundle(
  file: string,
  text: string,
  write: (file: string, contents: string) => void,
): string {
  if (path.basename(file) !== SUPPORT_BUNDLE_NAME) {
    throw new Error('Refusing to write the support bundle under another name.');
  }
  const normalized = file.split(path.sep).join('/');
  if (!launcherOwnedDirectories(file) || /\/elastos\//.test(normalized)) {
    throw new Error('Refusing to store the support bundle inside the ElastOS data directory.');
  }
  write(file, scrubSupportText(text));
  return file;
}

export function saveCollectedSupportBundle(text: string, homeDir = os.homedir()): string {
  const desktop = path.join(homeDir, 'Desktop');
  let desktopExists = false;
  try {
    desktopExists = fs.statSync(desktop).isDirectory();
  } catch {
    desktopExists = false;
  }
  const file = supportBundlePath(homeDir, desktopExists);
  return saveSupportBundle(file, text, (target, contents) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, { mode: 0o600 });
  });
}

export function freeBytes(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

export function portBusy(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
}

async function healthOk(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(800) });
    return response.ok && (await response.text()).trim() === 'OK';
  } catch {
    return false;
  }
}

/** Hostname of the pinned publisher. Cold preflight does not request a path. */
export function publisherHost(gateway: string): string {
  let parsed: URL;
  try {
    parsed = new URL(gateway);
  } catch {
    throw new Error('The ElastOS publisher address is not a URL.');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error('The ElastOS publisher address is not a URL.');
  }
  return parsed.hostname;
}

function connectPublisher(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean) => {
      socket.setTimeout(0);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Cold open only checks that the publisher host accepts a connection on 443.
 * The signed release head is fetched when the person starts Install.
 */
export async function publisherOffline(
  gateway: string,
  connect: (host: string, port: number) => Promise<boolean> = connectPublisher,
): Promise<boolean> {
  try {
    return !(await connect(publisherHost(gateway), 443));
  } catch {
    return true;
  }
}

async function offline(): Promise<boolean> {
  try {
    return publisherOffline(loadActiveRuntimePin().publisherGateway);
  } catch {
    return true;
  }
}

export async function collectPreflight(
  platform = process.platform,
  arch = process.arch,
): Promise<PreflightReport> {
  const busy = platform === 'win32' ? false : await portBusy(8090);
  const healthy = busy ? await healthOk() : false;
  let procVersion = '';
  try {
    procVersion = fs.readFileSync('/proc/version', 'utf8');
  } catch {
    procVersion = '';
  }
  let wslInstalled = false;
  let distroReady = false;
  if (platform === 'win32') {
    const windows = await detectWindows({ platform, arch, lookup: lookupCommand, listDistros });
    wslInstalled = windows.wslInstalled;
    distroReady = windows.distroReady;
  }
  return evaluatePreflight({
    platform,
    arch,
    freeBytes: freeBytes(process.platform === 'win32' ? process.cwd() : '/'),
    portBusy: busy,
    healthOk: healthy,
    offline: await offline(),
    wsl: detectWsl(process.env, procVersion),
    kvm: fs.existsSync('/dev/kvm'),
    wslInstalled,
    distroReady,
    libc: platform === 'linux' ? detectLinuxLibc(platform) : 'unknown',
    bashPresent: platform === 'win32' ? true : resolveBash() !== null,
  });
}
