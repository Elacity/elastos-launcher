import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { HEALTH_URL } from './runtimeGateway';
import { loadActiveRuntimePin } from './runtimePin';
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
    checks.push({
      id: 'windows',
      level: prompt.kind === 'ready' ? 'pass' : 'block',
      message,
    });
    checks.push({
      id: 'platform',
      level: 'block',
      message: prompt.kind === 'ready'
        ? 'Windows is ready. This button cannot finish the install inside Linux yet. You do not type any commands.'
        : message,
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

/** Drop secret-bearing lines. The bundle is meant to be pasted or emailed. */
export function scrubSupportText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/attach_secret|runtime-coords\.json|gateway-runtime-coords|home-runtime-coords|private key|BEGIN [A-Z ]*PRIVATE KEY/i.test(line))
    .map((line) => line
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
  if (normalized.includes('/.pc2/') || normalized.includes('/pc2.net/') || /\/elastos\//.test(normalized)) {
    throw new Error('Refusing to store the support bundle inside ElastOS or PC2 data.');
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

async function offline(): Promise<boolean> {
  try {
    const pin = loadActiveRuntimePin();
    const url = `${pin.publisherGateway.replace(/\/$/, '')}/release-head.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return !response.ok;
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
  });
}
