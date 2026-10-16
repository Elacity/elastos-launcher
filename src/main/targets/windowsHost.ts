import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256Hex } from './releaseHead';

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
      body: 'ElastOS on Windows runs in its own Linux environment. Click Enable. Windows will ask for permission once, and it may ask you to restart. You do not type any commands.',
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

export interface HiddenSpawn {
  (file: string, args: readonly string[], options: { windowsHide: true }): Promise<number>;
}

export async function runHostAction(
  kind: 'enable-wsl' | 'setup-distro',
  deps: {
    spawnHidden: HiddenSpawn;
    installDir?: string;
    rootfs?: string;
  },
): Promise<void> {
  if (kind === 'setup-distro' && !deps.rootfs) {
    throw new Error('The Linux environment file is not ready yet. Click Set up again.');
  }
  const args = kind === 'enable-wsl'
    ? enableWslArgs()
    : importDistroArgs(deps.installDir ?? 'C:\\ElastOS\\distro', deps.rootfs ?? '');
  const code = await deps.spawnHidden('wsl.exe', args, { windowsHide: true });
  if (code !== 0) {
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
}): Promise<void> {
  const prompt = hostPrompt(facts);
  assertPromptHasNoCommands(prompt);
  if (prompt.kind === 'enable-wsl') {
    await runHostAction('enable-wsl', deps);
    return;
  }
  if (prompt.kind === 'setup-distro') {
    const rootfs = await deps.ensureRootfs?.();
    await runHostAction('setup-distro', { ...deps, rootfs });
  }
}

export function spawnHidden(
  file: string,
  args: readonly string[],
  options: { windowsHide: true },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { windowsHide: options.windowsHide, stdio: 'ignore' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
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
    installDir: 'C:\\ElastOS\\distro',
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
