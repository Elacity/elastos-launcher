import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { HEALTH_URL } from './runtimeGateway';
import { launcherOwnedDirectories } from './runtimePaths';
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
  /** False on a cold open, which does not connect to the publisher. */
  networkChecked?: boolean;
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

  if (input.networkChecked === false) {
    checks.push({ id: 'network', level: 'pass', message: 'The network is checked when Install starts.' });
  } else {
    checks.push(input.offline
      ? { id: 'network', level: 'block', message: 'You appear to be offline. Connect to the internet and try again.' }
      : { id: 'network', level: 'pass', message: 'The network is reachable.' });
  }

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
const SHIELD_DID = /\bdid:key:z[1-9A-HJ-NP-Za-km-z]+\b/g;
const SHIELD_CID = /\bQm[1-9A-HJ-NP-Za-km-z]{44,}\b/g;
const SHIELD_CID_V1 = /\bb[a-z2-7]{50,}\b/g;
const HIGH_ENTROPY = /[A-Za-z0-9+/_-]{20,}/g;

function shannonEntropy(token: string): number {
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function shieldNonce(text: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const nonce = Array.from(crypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
    if (!text.includes(nonce)) return nonce;
  }
}

function shieldKeptTokens(text: string): { text: string; held: string[]; nonce: string } {
  const nonce = shieldNonce(text);
  const held: string[] = [];
  const shield = (match: string) => {
    const token = `\u0000${nonce}${held.length}\u0000`;
    held.push(match);
    return token;
  };
  return {
    text: text.replace(SHIELD_DID, shield).replace(SHIELD_CID, shield).replace(SHIELD_CID_V1, shield),
    held,
    nonce,
  };
}

function restoreKeptTokens(text: string, held: string[], nonce: string): string {
  return text.replace(new RegExp(`\u0000${nonce}(\\d+)\u0000`, 'g'), (match, index: string) => {
    const value = held[Number(index)];
    return typeof value === 'string' ? value : match;
  });
}

/** Paths, hashes, ids, and names a support bundle needs. A mixed-case secret is not one of these. */
function keepDiagnosticToken(token: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(token)) return true;
  if (/^[0-9a-fA-F-]{32,}$/.test(token) && token.includes('-')) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(token)) return true;
  if (/^b[a-z2-7]{50,}$/.test(token)) return true;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44,}$/.test(token)) return true;
  return false;
}

function redactHighEntropy(line: string): string {
  return line.replace(HIGH_ENTROPY, (token) => {
    if (keepDiagnosticToken(token)) return token;
    const mixed = /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
    if (mixed && token.length >= 20 && shannonEntropy(token) >= 3.5) return '[removed]';
    return token;
  });
}

/**
 * Drop PEM and coordinate-file lines. Redact labeled secrets and an unlabeled
 * mixed-case token of 20 or more characters with high entropy. Keep paths, hex hashes, CIDs,
 * did:key values, versions, UUIDs, and UPPER_SNAKE names. An unlabeled secret
 * shorter than that, or with low entropy, is not redacted.
 */
export function scrubSupportText(text: string): string {
  const shielded = shieldKeptTokens(text);
  const scrubbed = shielded.text
    .split('\n')
    .filter((line) => !DROP_SUPPORT_LINE.test(line))
    .map((line) => redactHighEntropy(line
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[removed]')
      .replace(/(\battach_secret\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\bapi[_-]?key\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\baccess_token\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\btoken\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\bcookie\s*[:=]\s*)\S+/gi, '$1[removed]')
      .replace(/(\bauthorization\s*=\s*)\S+/gi, '$1[removed]')
      .replace(/bearer\s+\S+/gi, 'bearer [removed]')
      .replace(/password\s*[:=]\s*\S+/gi, 'password [removed]')))
    .join('\n');
  return restoreKeptTokens(scrubbed, shielded.held, shielded.nonce);
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
  homeDir: string = os.homedir(),
  platform: string = process.platform,
): string {
  if (path.basename(file) !== SUPPORT_BUNDLE_NAME) {
    throw new Error('Refusing to write the support bundle under another name.');
  }
  const normalized = file.split(path.sep).join('/');
  if (!launcherOwnedDirectories(file, homeDir, platform, {}) || /\/elastos\//.test(normalized)) {
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
  }, homeDir, process.platform);
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
 * True when the publisher host does not accept a connection on port 443.
 * Install fetches the signed release head. A cold open does not call this.
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
    offline: false,
    networkChecked: false,
    wsl: detectWsl(process.env, procVersion),
    kvm: fs.existsSync('/dev/kvm'),
    wslInstalled,
    distroReady,
    libc: platform === 'linux' ? detectLinuxLibc(platform) : 'unknown',
    bashPresent: platform === 'win32' ? true : resolveBash() !== null,
  });
}
