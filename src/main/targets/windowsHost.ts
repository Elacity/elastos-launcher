import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256Hex } from './releaseHead';
import { runtimeResumeInstallLockPath, runtimeResumeInstallPath } from './runtimePaths';

export type WindowsKind = 'not-windows' | 'enable-wsl' | 'setup-distro' | 'ready';

export interface WindowsFacts {
  platform: string;
  arch: string;
  wslInstalled: boolean;
  distroReady: boolean;
}

export interface HostPrompt {
  kind: WindowsKind | 'intel';
  title: string;
  body: string;
  actionLabel: 'Enable' | 'Set up' | null;
}

/** Ubuntu 24.04 WSL rootfs, release 20240423. Not the moving `current` alias. */
export const ELASTOS_ROOTFS_URL =
  'https://cloud-images.ubuntu.com/wsl/releases/24.04/20240423/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz';
export const ELASTOS_ROOTFS_SHA256 =
  '8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea';
export const ELASTOS_ROOTFS_BYTES = 356739129;
export const ELASTOS_ROOTFS_MAX_BYTES = 400 * 1024 * 1024;

const COMMAND_LEAK = /wsl\.exe|powershell|terminal|command prompt|\bcmd\b|\bbash\b|sudo /i;

/** One sentence for the person at the computer. It never includes a command. */
export function hostPrompt(facts: WindowsFacts): HostPrompt {
  if (facts.platform === 'darwin' && facts.arch === 'x64') {
    return {
      kind: 'intel',
      title: 'Intel Macs are not ready yet',
      body: 'A signed ElastOS release for this Mac is not published yet. Nothing was downloaded.',
      actionLabel: null,
    };
  }
  if (facts.platform !== 'win32') {
    return { kind: 'not-windows', title: '', body: '', actionLabel: null };
  }
  if (!facts.wslInstalled) {
    return {
      kind: 'enable-wsl',
      title: 'Windows needs Linux support',
      body: 'ElastOS on Windows runs in its own Linux environment. Click Enable. Windows will ask for permission once, and it may ask you to restart. After that restart, open ElastOS and Install continues. You do not type any commands.',
      actionLabel: 'Enable',
    };
  }
  if (!facts.distroReady) {
    return {
      kind: 'setup-distro',
      title: 'Set up ElastOS on Windows',
      body: 'Linux support is on. Click Set up and ElastOS will add its own Linux environment. Windows may ask for permission. You do not type any commands.',
      actionLabel: 'Set up',
    };
  }
  return {
    kind: 'ready',
    title: 'Windows is ready',
    body: 'Linux support is on. Click Install. ElastOS sets itself up in its own Linux environment and opens in the browser. You do not type any commands.',
    actionLabel: null,
  };
}

export function assertPromptHasNoCommands(prompt: HostPrompt): void {
  if (COMMAND_LEAK.test(`${prompt.title}\n${prompt.body}`)) {
    throw new Error('The prompt must not tell the user to type a command.');
  }
}

export function enableWslArgs(): readonly string[] {
  return ['--install', '--no-distribution'];
}

export function importDistroArgs(installDir: string, rootfs: string): readonly string[] {
  return ['--import', 'ElastOS', installDir, rootfs, '--version', '2'];
}

export const WINDOWS_REBOOT_MESSAGE = 'Restart Windows. When you open ElastOS again, Install continues.';

export type ResumeInstallPlan = 'install' | 'wait' | 'none';

export function planAfterWindowsRestart(input: { marker: boolean; wslInstalled: boolean }): ResumeInstallPlan {
  if (!input.marker) return 'none';
  if (!input.wslInstalled) return 'wait';
  return 'install';
}

export function markInstallResumeAfterReboot(homeDir: string = os.homedir()): void {
  const file = runtimeResumeInstallPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ resume: 'install', reason: 'windows-linux-support' }), { mode: 0o600 });
}

export function readResumeInstallMarker(homeDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeResumeInstallPath(homeDir), 'utf8')) as { resume?: unknown };
    return parsed.resume === 'install';
  } catch {
    return false;
  }
}

export interface HiddenSpawnOutput {
  code: number;
  stdout?: string;
  stderr?: string;
}

export interface HiddenSpawn {
  (
    file: string,
    args: readonly string[],
    options: { windowsHide: true },
  ): Promise<number | HiddenSpawnOutput>;
}

export function windowsEnableNeedsReboot(text: string): boolean {
  return /\breboot\b|\brestart\b/i.test(text);
}

export async function runHostAction(
  kind: 'enable-wsl' | 'setup-distro',
  deps: {
    spawnHidden: HiddenSpawn;
    installDir?: string;
    rootfs?: string;
    onReboot?: () => void;
  },
): Promise<void> {
  if (kind === 'setup-distro' && !deps.rootfs) {
    throw new Error('The Linux environment file is not ready yet. Click Set up again.');
  }
  const args = kind === 'enable-wsl'
    ? enableWslArgs()
    : importDistroArgs(deps.installDir ?? 'C:\\ElastOS\\distro', deps.rootfs ?? '');
  const result = await deps.spawnHidden('wsl.exe', args, { windowsHide: true });
  const code = typeof result === 'number' ? result : result.code;
  const text = typeof result === 'number' ? '' : `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (kind === 'enable-wsl' && windowsEnableNeedsReboot(text)) {
    deps.onReboot?.();
    throw new Error(WINDOWS_REBOOT_MESSAGE);
  }
  if (code !== 0) {
    if (text.trim()) console.error(text.trim());
    throw new Error(kind === 'enable-wsl'
      ? 'Windows did not turn on Linux support. Click Enable to try again.'
      : 'ElastOS could not add its Linux environment. Click Set up to try again.');
  }
}

export async function detectWindows(deps: {
  platform: string;
  arch: string;
  lookup: (file: string) => Promise<boolean>;
  listDistros: () => Promise<string>;
}): Promise<WindowsFacts> {
  if (deps.platform !== 'win32') {
    return { platform: deps.platform, arch: deps.arch, wslInstalled: false, distroReady: false };
  }
  const wslInstalled = await deps.lookup('wsl.exe');
  if (!wslInstalled) {
    return { platform: deps.platform, arch: deps.arch, wslInstalled: false, distroReady: false };
  }
  const list = (await deps.listDistros()).replace(/\0/g, '');
  return {
    platform: deps.platform,
    arch: deps.arch,
    wslInstalled: true,
    distroReady: /ElastOS\s+\S+\s+2/.test(list),
  };
}

export async function ensureElastosRootfs(deps: {
  dest: string;
  exists: (file: string) => boolean;
  download: (url: string, dest: string) => Promise<void>;
  read?: (file: string) => Buffer;
  accept?: (bytes: Buffer) => void;
}): Promise<string> {
  if (deps.exists(deps.dest)) {
    if (!deps.read || !deps.accept) return deps.dest;
    try {
      deps.accept(deps.read(deps.dest));
      return deps.dest;
    } catch {
      // The cached file is not the pinned rootfs.
    }
  }
  await deps.download(ELASTOS_ROOTFS_URL, deps.dest);
  if (deps.read && deps.accept) deps.accept(deps.read(deps.dest));
  return deps.dest;
}

export async function applyWindowsFix(facts: WindowsFacts, deps: {
  spawnHidden: HiddenSpawn;
  installDir?: string;
  ensureRootfs?: () => Promise<string>;
  prepareImportDir?: (dir: string) => void;
  onReboot?: () => void;
}): Promise<void> {
  const prompt = hostPrompt(facts);
  assertPromptHasNoCommands(prompt);
  if (prompt.kind === 'enable-wsl') {
    await runHostAction('enable-wsl', deps);
    return;
  }
  if (prompt.kind === 'setup-distro') {
    const rootfs = await deps.ensureRootfs?.();
    const installDir = deps.installDir ?? 'C:\\ElastOS\\distro';
    // wsl --import fails immediately when this directory is missing.
    (deps.prepareImportDir ?? prepareWindowsImportDir)(installDir);
    await runHostAction('setup-distro', { ...deps, installDir, rootfs });
  }
}

/** Create the empty folder wsl --import writes the ElastOS distro into. */
export function prepareWindowsImportDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) {
    throw new Error('ElastOS could not add its Linux environment. Click Set up to try again.');
  }
}

export function spawnHidden(
  file: string,
  args: readonly string[],
  options: { windowsHide: true },
): Promise<HiddenSpawnOutput> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      windowsHide: options.windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', () => resolve({ code: 1, stdout: '', stderr: '' }));
    child.on('exit', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

export function lookupCommand(file: string): Promise<boolean> {
  const which = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    const child = spawn(which, [file], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

export function listDistros(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['--list', '--verbose'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => resolve(''));
    child.on('exit', () => resolve(out.replace(/\0/g, '')));
  });
}

export async function fixWindowsOnThisComputer(): Promise<void> {
  const facts = await detectWindows({
    platform: process.platform,
    arch: process.arch,
    lookup: lookupCommand,
    listDistros,
  });
  await applyWindowsFix(facts, {
    spawnHidden,
    onReboot: () => markInstallResumeAfterReboot(os.homedir()),
    installDir: 'C:\\ElastOS\\distro',
    prepareImportDir: prepareWindowsImportDir,
    ensureRootfs: () => ensureElastosRootfs({
      dest: path.join(os.homedir(), '.elastos-launcher', 'ubuntu-noble-wsl.rootfs.tar.gz'),
      exists: (file) => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      },
      download: downloadPinnedRootfs,
      read: (file) => fs.readFileSync(file),
      accept: assertPinnedRootfs,
    }),
  });
}

export async function downloadPinnedRootfs(url: string, dest: string): Promise<void> {
  if (url !== ELASTOS_ROOTFS_URL) {
    throw new Error('Refusing to download a Linux environment that is not the pinned file.');
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error('Could not download the Linux environment. Click Set up to try again.');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > ELASTOS_ROOTFS_MAX_BYTES) {
      await reader.cancel();
      throw new Error('The Linux environment download is larger than ElastOS accepts.');
    }
    chunks.push(Buffer.from(step.value));
  }
  const bytes = Buffer.concat(chunks);
  assertPinnedRootfs(bytes);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
}

/** Refuse a rootfs whose size or SHA-256 is not the pinned release. */
export function assertPinnedRootfs(bytes: Buffer): void {
  if (bytes.length > ELASTOS_ROOTFS_MAX_BYTES) {
    throw new Error('The Linux environment download is larger than ElastOS accepts.');
  }
  if (bytes.length !== ELASTOS_ROOTFS_BYTES) {
    throw new Error('The Linux environment download is not the pinned file.');
  }
  if (sha256Hex(bytes) !== ELASTOS_ROOTFS_SHA256) {
    throw new Error('The Linux environment download does not match the pinned hash.');
  }
}

function resumeLockPath(homeDir: string): string {
  return runtimeResumeInstallLockPath(homeDir);
}

/** A lock older than this is stale even if its pid is still in the process table. */
export const RESUME_LOCK_STALE_MS = 10 * 60 * 1000;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
    return code === 'EPERM';
  }
}

function resumeLockIsStale(lock: string): boolean {
  let text = '';
  let mtime = 0;
  try {
    const stat = fs.statSync(lock);
    mtime = stat.mtimeMs;
    text = fs.readFileSync(lock, 'utf8');
  } catch {
    return false;
  }
  let parsed: { pid?: unknown; uptime?: unknown } | null = null;
  try {
    parsed = JSON.parse(text) as { pid?: unknown; uptime?: unknown };
  } catch {
    return true;
  }
  if (!parsed || typeof parsed.pid !== 'number' || parsed.pid <= 0) return true;
  if (parsed.pid === process.pid) return false;
  if (typeof parsed.uptime === 'number' && os.uptime() + 1 < parsed.uptime) return true;
  if (Number.isFinite(mtime) && Date.now() - mtime > RESUME_LOCK_STALE_MS) return true;
  return !pidIsAlive(parsed.pid);
}

function tryCreateResumeLock(lock: string, payload: string): boolean {
  const tmp = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    try {
      fs.linkSync(tmp, lock);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The lock file, when the link succeeded, is the copy that matters.
    }
  }
}

/** One process claims the resume. An empty, crashed, or rebooted lock can be taken. */
export function claimResumeInstall(homeDir: string): boolean {
  const lock = resumeLockPath(homeDir);
  const payload = JSON.stringify({ pid: process.pid, uptime: os.uptime() });
  if (tryCreateResumeLock(lock, payload)) return true;
  if (!resumeLockIsStale(lock)) return false;
  const junk = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lock, junk);
  } catch {
    return false;
  }
  try {
    fs.rmSync(junk, { force: true });
  } catch {
    // The name is no longer the lock. The next create can proceed.
  }
  return tryCreateResumeLock(lock, payload);
}

/**
 * After a Windows restart, continue Install only when Linux support is on and
 * ElastOS is not already installed. One open claims the resume. The marker
 * stays until Install succeeds.
 */
export async function resumeInstallPlanOnThisComputer(deps: {
  homeDir?: string;
  platform?: string;
  wslInstalled?: boolean;
  installed?: () => Promise<boolean>;
  detect?: () => Promise<{ wslInstalled: boolean }>;
} = {}): Promise<ResumeInstallPlan> {
  const homeDir = deps.homeDir ?? os.homedir();
  const marker = readResumeInstallMarker(homeDir);
  if (!marker) return 'none';
  if (deps.installed) {
    try {
      if (await deps.installed()) return 'none';
    } catch {
      return 'wait';
    }
  }
  const platform = deps.platform ?? process.platform;
  let wslInstalled = deps.wslInstalled;
  if (wslInstalled === undefined) {
    if (platform !== 'win32') return 'wait';
    try {
      const facts = deps.detect
        ? await deps.detect()
        : await detectWindows({
          platform,
          arch: process.arch,
          lookup: lookupCommand,
          listDistros,
        });
      wslInstalled = facts.wslInstalled;
    } catch {
      return 'wait';
    }
  }
  const plan = planAfterWindowsRestart({ marker: true, wslInstalled });
  if (plan !== 'install') return plan;
  if (!claimResumeInstall(homeDir)) return 'none';
  return 'install';
}

/** Drop the resume lock. Remove the marker only after Install succeeded. */
export function finishResumeInstall(homeDir: string, ok: boolean): void {
  try {
    fs.rmSync(resumeLockPath(homeDir), { force: true });
  } catch {
    // The next open can reclaim a lock whose process is gone.
  }
  if (!ok) return;
  try {
    fs.rmSync(runtimeResumeInstallPath(homeDir), { force: true });
  } catch {
    // Reset also removes this file.
  }
}
