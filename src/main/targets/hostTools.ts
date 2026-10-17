import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extractTarGz } from './hostArchive';
import { sha256Equals, sha256Hex } from './releaseHead';

export const MUSL_MESSAGE =
  'This Linux computer uses musl. ElastOS needs glibc, which Ubuntu and similar systems provide. Install cannot continue on this computer.';

export const BASH_MESSAGE =
  'ElastOS needs bash, and this computer does not have it. Install cannot continue.';

export const PYTHON_DOWNLOAD_MESSAGE =
  'ElastOS could not download a component it needs to finish installing. Check your connection and click Install to try again.';

export const PYTHON_VERIFY_MESSAGE =
  'ElastOS could not verify a component it needs to finish installing. Click Install to try again.';

export const PYTHON_MAX_BYTES = 80 * 1024 * 1024;

const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash'];

export interface HostPythonAsset {
  url: string;
  sha256: string;
}

export interface HostPythonPin {
  release: string;
  version: string;
  assets: Record<string, HostPythonAsset>;
}

export interface PreparedInstaller {
  bash: string;
  env: NodeJS.ProcessEnv;
}

export function hostPythonKey(platform: string, arch: string): string | null {
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `${platform}-${arch}`;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  return null;
}

export function parseHostPythonPin(raw: unknown): HostPythonPin {
  if (!raw || typeof raw !== 'object') throw new Error(PYTHON_VERIFY_MESSAGE);
  const pin = raw as Partial<HostPythonPin>;
  if (!pin.release || !pin.version || !pin.assets) throw new Error(PYTHON_VERIFY_MESSAGE);
  return { release: pin.release, version: pin.version, assets: pin.assets };
}

export function loadHostPythonPin(): HostPythonPin {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'host-python.json') : '';
  const dev = path.join(__dirname, '../../../resources/host-python.json');
  for (const file of [packaged, dev]) {
    if (file && fs.existsSync(file)) return parseHostPythonPin(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  throw new Error(PYTHON_VERIFY_MESSAGE);
}

export function hostPythonAsset(pin: HostPythonPin, platform: string, arch: string): HostPythonAsset {
  const key = hostPythonKey(platform, arch);
  const asset = key ? pin.assets[key] : undefined;
  if (!asset || !asset.url.startsWith('https://') || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
    throw new Error(PYTHON_VERIFY_MESSAGE);
  }
  return asset;
}

export function detectLinuxLibc(
  platform: string,
  list: (dir: string) => string[] = listDir,
): 'glibc' | 'musl' | 'unknown' {
  if (platform !== 'linux') return 'unknown';
  const names: string[] = [];
  for (const dir of ['/lib', '/lib64', '/usr/lib']) {
    try {
      names.push(...list(dir));
    } catch {
      // That directory is not on this computer.
    }
  }
  if (names.some((name) => name.startsWith('ld-musl-'))) return 'musl';
  if (names.some((name) => name.startsWith('ld-linux') || name === 'libc.so.6')) return 'glibc';
  return 'unknown';
}

export function resolveBash(canExec: (file: string) => boolean = canExecute): string | null {
  for (const file of BASH_CANDIDATES) {
    if (canExec(file)) return file;
  }
  return null;
}

export function toolShimScript(execPath: string, modulePath: string, tool: 'curl' | 'sha256sum'): string {
  return `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(execPath)} ${shellQuote(modulePath)} --elastos-tool ${tool} "$@"\n`;
}

export function pythonRuns(command: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, ['-c', ''], {
    env,
    timeout: 20000,
    stdio: 'ignore',
  });
  return result.status === 0;
}

export async function prepareInstallerEnvironment(input: {
  homeDir: string;
  platform: string;
  arch: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  modulePath?: string;
  pin?: HostPythonPin;
  pythonRuns?: (command: string, env: NodeJS.ProcessEnv) => boolean;
  download?: (url: string) => Promise<Buffer>;
  listLib?: (dir: string) => string[];
  canExec?: (file: string) => boolean;
  /** Use the app's Python even when python3 runs. The caller reads ELASTOS_HIDE_HOST_TOOLS. */
  hideHostTools?: boolean;
}): Promise<PreparedInstaller> {
  const env: NodeJS.ProcessEnv = { ...(input.env ?? process.env) };
  if (detectLinuxLibc(input.platform, input.listLib) === 'musl') throw new Error(MUSL_MESSAGE);
  const bash = resolveBash(input.canExec);
  if (!bash) throw new Error(BASH_MESSAGE);

  const tools = path.join(input.homeDir, '.elastos-launcher', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.chmodSync(tools, 0o755);
  const modulePath = materializeToolEntry(tools, input.modulePath);
  const execPath = input.execPath ?? process.execPath;
  writeShim(path.join(tools, 'curl'), toolShimScript(execPath, modulePath, 'curl'));
  writeShim(path.join(tools, 'sha256sum'), toolShimScript(execPath, modulePath, 'sha256sum'));

  const hide = input.hideHostTools ?? env.ELASTOS_HIDE_HOST_TOOLS === '1';
  const runs = input.pythonRuns ?? pythonRuns;
  let pythonBin: string | null = null;
  if (!hide && runs('python3', env)) {
    pythonBin = null;
  } else {
    pythonBin = await ensurePython(input, env);
  }
  const prefix = pythonBin ? [tools, pythonBin] : [tools];
  env.PATH = [...prefix, env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  return { bash, env };
}

async function ensurePython(
  input: {
    homeDir: string;
    platform: string;
    arch: string;
    pin?: HostPythonPin;
    download?: (url: string) => Promise<Buffer>;
    pythonRuns?: (command: string, env: NodeJS.ProcessEnv) => boolean;
  },
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const pin = input.pin ?? loadHostPythonPin();
  const asset = hostPythonAsset(pin, input.platform, input.arch);
  const root = path.join(input.homeDir, '.elastos-launcher', 'python');
  const bin = path.join(root, 'python', 'bin');
  const stamp = path.join(root, '.sha256');
  const runs = input.pythonRuns ?? pythonRuns;
  const childEnv = { ...env, PATH: [bin, env.PATH ?? ''].filter(Boolean).join(path.delimiter) };
  if (readStamp(stamp) === asset.sha256 && runs(path.join(bin, 'python3'), childEnv)) return bin;

  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const bytes = input.download ? await input.download(asset.url) : await downloadPython(asset.url);
  if (bytes.length > PYTHON_MAX_BYTES || !sha256Equals(sha256Hex(bytes), asset.sha256)) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(PYTHON_VERIFY_MESSAGE);
  }
  try {
    extractTarGz(bytes, root);
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
  if (!runs(path.join(bin, 'python3'), childEnv)) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(PYTHON_VERIFY_MESSAGE);
  }
  fs.writeFileSync(stamp, asset.sha256);
  return bin;
}

async function downloadPython(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(PYTHON_DOWNLOAD_MESSAGE);
  }
  if (!response.ok || !response.body) throw new Error(PYTHON_DOWNLOAD_MESSAGE);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > PYTHON_MAX_BYTES) {
      await reader.cancel();
      throw new Error(PYTHON_DOWNLOAD_MESSAGE);
    }
    chunks.push(Buffer.from(step.value));
  }
  return Buffer.concat(chunks);
}

function materializeToolEntry(tools: string, override?: string): string {
  const source = override ?? path.join(__dirname, 'hostToolEntry.js');
  const dest = path.join(tools, 'hostToolEntry.js');
  fs.writeFileSync(dest, fs.readFileSync(source));
  return dest;
}

function writeShim(file: string, script: string): void {
  fs.writeFileSync(file, script, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function readStamp(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function listDir(dir: string): string[] {
  return fs.readdirSync(dir);
}

function canExecute(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
