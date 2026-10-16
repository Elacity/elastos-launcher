import * as fs from 'fs';
import * as net from 'net';
import { HEALTH_URL } from './runtimeGateway';
import { loadActiveRuntimePin } from './runtimePin';
import { runtimeInstallBlock, wslKvmMessage, detectWsl } from './runtimeSupport';

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
}

export function evaluatePreflight(input: PreflightInput): PreflightReport {
  const checks: PreflightCheck[] = [];
  const platform = runtimeInstallBlock(input.platform, input.arch);
  checks.push(platform
    ? { id: 'platform', level: 'block', message: platform }
    : { id: 'platform', level: 'pass', message: 'This computer can run ElastOS.' });

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
  target: string;
  channel: string;
  pinVersion: string | null;
  platform: string;
  arch: string;
  status: string;
  error: string;
  logs: string;
  checks: PreflightCheck[];
}): string {
  const checks = info.checks.map((check) => `${check.level} ${check.id}: ${check.message}`).join('\n');
  const body = [
    'ElastOS diagnostics',
    `launcher: ${info.launcherVersion}`,
    `target: ${info.target}`,
    `channel: ${info.channel}`,
    `pin: ${info.pinVersion ?? 'none'}`,
    `computer: ${info.platform}/${info.arch}`,
    `status: ${info.status}`,
    `error: ${info.error || 'none'}`,
    '',
    'checks:',
    checks || 'none',
    '',
    'log:',
    info.logs || 'none',
    '',
  ].join('\n');
  return body
    .split('\n')
    .filter((line) => !/attach_secret|runtime-coords\.json|gateway-runtime-coords|home-runtime-coords/i.test(line))
    .join('\n');
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
  return evaluatePreflight({
    platform,
    arch,
    freeBytes: freeBytes(process.platform === 'win32' ? process.cwd() : '/'),
    portBusy: busy,
    healthOk: healthy,
    offline: await offline(),
    wsl: detectWsl(process.env, procVersion),
    kvm: fs.existsSync('/dev/kvm'),
  });
}
