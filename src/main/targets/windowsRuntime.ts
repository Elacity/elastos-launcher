import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PinMismatchError } from './runtimeInstall';
import { installRuntime, RuntimeInstallDeps } from './runtimeInstall';
import { loadActiveRuntimePin } from './runtimePin';
import { parseRuntimeVersion } from './runtimeProbe';
import { WINDOWS_NATIVE_MESSAGE } from './runtimeSupport';
import {
  createGatewaySupervisor,
  emitRuntimeLog,
  foreignListenerIsElastos,
  GATEWAY_ARGS,
  GatewayProcess,
  healthListenInodes,
  openRuntimeHome,
  pidOwnsSocketInodes,
} from './runtimeGateway';
import {
  assertPinnedRootfs,
  detectWindows,
  downloadPinnedRootfs,
  ensureElastosRootfs,
  importDistroArgs,
  listDistros,
  lookupCommand,
} from './windowsHost';

export const DISTRO_NAME = 'ElastOS';
export const DISTRO_HOME = '/root';
export const DISTRO_INSTALL_DIR = 'C:\\ElastOS\\distro';
export const DISTRO_IMPORT_FAILED = 'ElastOS could not add its Linux environment. Click Install to try again.';
export const DISTRO_SETUP_FAILED = 'ElastOS could not finish setting up its Linux environment. Click Install to try again.';
export const DISTRO_INSTALL_FAILED = 'ElastOS could not be installed. Click Install to try again.';

const FILE_HELPER = `
import base64, sys, pathlib
op, raw = sys.argv[1], sys.argv[2]
root = pathlib.PurePosixPath('/root')
target = pathlib.PurePosixPath(raw)
if target != root and root not in target.parents:
    raise SystemExit(2)
path = pathlib.Path(raw)
if op == 'mkdir':
    path.mkdir(parents=True, exist_ok=True)
elif op == 'write':
    data = base64.b64decode(sys.stdin.buffer.read())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
elif op == 'read':
    sys.stdout.write(base64.b64encode(path.read_bytes()).decode('ascii'))
elif op == 'exists':
    raise SystemExit(0 if path.is_file() else 1)
else:
    raise SystemExit(2)
`.trim();

const STOP_HELPER = `
import json, os, signal, sys
name = sys.argv[1]
doc = json.load(open('/root/.local/share/elastos/host-process.lock'))
pid = doc.get('pid')
if not isinstance(pid, int) or pid <= 0:
    raise SystemExit(1)
os.kill(-pid, signal.SIGKILL if name == 'KILL' else signal.SIGTERM)
`.trim();

const LOCK_PID_HELPER = `
import json
doc = json.load(open('/root/.local/share/elastos/host-process.lock'))
pid = doc.get('pid')
if not isinstance(pid, int) or pid <= 0:
    raise SystemExit(1)
print(pid)
`.trim();

const LOCK_ALIVE_HELPER = `
import os, sys
pid = int(sys.argv[1])
if pid <= 0:
    raise SystemExit(1)
os.kill(pid, 0)
`.trim();

const FACTS_HELPER = `
import json, os
lock_path = '/root/.local/share/elastos/host-process.lock'
out = {'lock': None, 'command': None, 'tcp': '', 'links': [], 'alive': False}
try:
    out['lock'] = open(lock_path).read()
except Exception:
    pass
pid = 0
try:
    pid = json.loads(out['lock'] or '{}').get('pid') or 0
except Exception:
    pid = 0
if isinstance(pid, int) and pid > 0:
    out['alive'] = os.path.exists(f'/proc/{pid}')
    try:
        out['command'] = open(f'/proc/{pid}/cmdline', 'rb').read().replace(bytes([0]), b' ').decode()
    except Exception:
        out['command'] = None
    try:
        out['tcp'] = open('/proc/net/tcp').read()
    except Exception:
        out['tcp'] = ''
    links = []
    fd = f'/proc/{pid}/fd'
    try:
        for name in os.listdir(fd):
            try:
                links.append(os.readlink(f'{fd}/{name}'))
            except Exception:
                pass
    except Exception:
        links = []
    out['links'] = links
print(json.dumps(out))
`.trim();

export interface WslResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A path the distro may touch. Anything outside /root is refused. */
export function assertDistroPath(file: string): string {
  const normalized = path.posix.normalize(file.replace(/\\/g, '/'));
  if (normalized !== '/root' && !normalized.startsWith('/root/')) {
    throw new Error('Refusing to use a path outside the ElastOS Linux environment.');
  }
  return normalized;
}

export function wslCommandPrefix(): readonly string[] {
  return ['-d', DISTRO_NAME, '-u', 'root', '--'];
}

export function wslSpawnEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...parent, WSL_UTF8: '1' };
}

export function distroInstallerArgs(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const script = assertDistroPath(scriptPath);
  const head = env.ELASTOS_HEAD_CID ?? '';
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{20,}$/.test(head) || args.includes('--head-cid')) {
    throw new PinMismatchError('headCid');
  }
  return [
    'env',
    '-u', 'ELASTOS_MAINTAINER_DID',
    '-u', 'ELASTOS_PUBLISHER_GATEWAY',
    `ELASTOS_HEAD_CID=${head}`,
    'bash',
    script,
    ...args,
  ];
}

export function distroGatewayArgs(): string[] {
  return [...wslCommandPrefix(), '/root/.local/bin/elastos', ...GATEWAY_ARGS];
}

export function distroToolCheckArgs(): readonly string[] {
  return ['bash', '-lc', 'command -v python3 >/dev/null && command -v curl >/dev/null'];
}

export function distroPackageArgs(): readonly string[] {
  return ['bash', '-lc', 'printf "nameserver 8.8.8.8\\n" > /etc/resolv.conf; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 curl ca-certificates'];
}

export function distroStopArgs(signal: 'TERM' | 'KILL'): string[] {
  return ['python3', '-c', STOP_HELPER, signal];
}

function plainSpawnError(err: unknown, fallback: string): Error {
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: string }).code)
    : '';
  if (code === 'ENOENT') return new Error(WINDOWS_NATIVE_MESSAGE);
  return new Error(fallback);
}

export function runWslSync(args: readonly string[], input?: Buffer, timeoutMs = 60000): WslResult {
  const result = spawnSync('wsl.exe', [...wslCommandPrefix(), ...args], {
    windowsHide: true,
    env: wslSpawnEnv(),
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error) throw plainSpawnError(result.error, DISTRO_SETUP_FAILED);
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runWsl(args: readonly string[], timeoutMs: number, input?: Buffer): Promise<WslResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', [...wslCommandPrefix(), ...args], {
      windowsHide: true,
      env: wslSpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(DISTRO_SETUP_FAILED));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(plainSpawnError(err, DISTRO_SETUP_FAILED));
    });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (input) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function fileArgs(op: string, file: string): string[] {
  return ['python3', '-c', FILE_HELPER, op, assertDistroPath(file)];
}

function readDistroFile(file: string): string {
  const result = runWslSync(fileArgs('read', file));
  if (result.code !== 0) {
    throw new Error('ElastOS could not read a file in its Linux environment. Click Install to try again.');
  }
  return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
}

function writeDistroFile(file: string, contents: string): void {
  const result = runWslSync(fileArgs('write', file), Buffer.from(Buffer.from(contents).toString('base64')));
  if (result.code !== 0) throw new Error(DISTRO_SETUP_FAILED);
}

export function prepareImportDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) throw new Error(DISTRO_IMPORT_FAILED);
}

export async function ensureElastosDistro(deps: {
  lookupWsl: () => Promise<boolean>;
  listDistros: () => Promise<string>;
  ensureRootfs: () => Promise<string>;
  importDistro: (installDir: string, rootfs: string) => Promise<number>;
  prepareImportDir?: (dir: string) => void;
  hasTools: () => Promise<boolean>;
  installTools: () => Promise<number>;
  onProgress: (message: string) => void;
}): Promise<void> {
  if (!(await deps.lookupWsl())) throw new Error(WINDOWS_NATIVE_MESSAGE);
  const facts = await detectWindows({
    platform: 'win32',
    arch: 'x64',
    lookup: async () => true,
    listDistros: deps.listDistros,
  });
  if (!facts.distroReady) {
    const rootfs = await deps.ensureRootfs();
    deps.onProgress('Rootfs SHA-256 matches the pin');
    (deps.prepareImportDir ?? prepareImportDir)(DISTRO_INSTALL_DIR);
    const code = await deps.importDistro(DISTRO_INSTALL_DIR, rootfs);
    if (code !== 0) throw new Error(DISTRO_IMPORT_FAILED);
  }
  if (!(await deps.hasTools())) {
    const code = await deps.installTools();
    if (code !== 0) throw new Error(DISTRO_SETUP_FAILED);
  }
}

function distroInstallDeps(): RuntimeInstallDeps {
  const pin = loadActiveRuntimePin();
  return {
    platform: 'linux',
    arch: 'x64',
    homeDir: DISTRO_HOME,
    env: {},
    pin,
    probe: async () => {
      const binary = '/root/.local/bin/elastos';
      const exists = runWslSync(fileArgs('exists', binary));
      if (exists.code !== 0) return { kind: 'not-installed' };
      const version = runWslSync([binary, 'version'], undefined, 15000);
      if (version.code !== 0) {
        throw new Error('ElastOS is installed, but its version could not be read. Click Install to try again.');
      }
      const parsed = parseRuntimeVersion(version.stdout);
      if (!parsed) {
        throw new Error('ElastOS is installed, but its version could not be read. Click Install to try again.');
      }
      return { kind: 'version', version: parsed, binaryPath: binary };
    },
    fetchText: async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Could not download ElastOS. Check your connection and try again.');
      }
      return response.text();
    },
    runInstaller: async (scriptPath, args, env) => {
      const result = await runWsl(distroInstallerArgs(scriptPath, args, env), 15 * 60 * 1000);
      if (result.code !== 0) {
        console.error(result.stderr || result.stdout);
        throw new Error(DISTRO_INSTALL_FAILED);
      }
      return { stdout: result.stdout, stderr: result.stderr };
    },
    runSetup: async (binary) => {
      const result = await runWsl([assertDistroPath(binary), 'setup'], 15 * 60 * 1000);
      if (result.code !== 0) {
        console.error(result.stderr || result.stdout);
        throw new Error(DISTRO_SETUP_FAILED);
      }
      return { stdout: result.stdout, stderr: result.stderr };
    },
    writeFile: (file, contents) => writeDistroFile(file, contents),
    readFile: (file) => readDistroFile(file),
    exists: (file) => {
      try {
        return runWslSync(fileArgs('exists', file)).code === 0;
      } catch {
        return false;
      }
    },
    statMtimeMs: (file) => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch {
        return null;
      }
    },
    mkdirp: (dir) => {
      const result = runWslSync(fileArgs('mkdir', dir));
      if (result.code !== 0) throw new Error(DISTRO_SETUP_FAILED);
    },
  };
}

export async function installRuntimeInsideDistro(
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  await ensureElastosDistro({
    lookupWsl: () => lookupCommand('wsl.exe'),
    listDistros,
    ensureRootfs: () => ensureElastosRootfs({
      dest: path.join(os.homedir(), '.elastos-launcher', 'ubuntu-noble-wsl.rootfs.tar.gz'),
      exists: (file) => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      },
      download: downloadPinnedRootfs,
      read: (file) => fs.readFileSync(file),
      accept: assertPinnedRootfs,
    }),
    importDistro: (installDir, rootfs) => runHost(importDistroArgs(installDir, rootfs), 10 * 60 * 1000),
    hasTools: async () => (await runWsl(distroToolCheckArgs(), 20000)).code === 0,
    installTools: async () => (await runWsl(distroPackageArgs(), 10 * 60 * 1000)).code,
    onProgress,
  });
  await installRuntime(distroInstallDeps(), onProgress);
}

function runHost(args: readonly string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', [...args], {
      windowsHide: true,
      env: wslSpawnEnv(),
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(DISTRO_IMPORT_FAILED));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(plainSpawnError(err, DISTRO_IMPORT_FAILED));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** Signal the gateway recorded in the distro host lock. Never uses pid 0. */
export function signalDistroLock(
  signal: NodeJS.Signals,
  stopInside: (name: 'TERM' | 'KILL') => void = (name) => {
    runWslSync(distroStopArgs(name), undefined, 5000);
  },
): void {
  const name = signal === 'SIGKILL' ? 'KILL' : 'TERM';
  stopInside(name);
}

export function signalDistroGateway(
  wslPid: number,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  stopInside: (name: 'TERM' | 'KILL') => void = (name) => {
    runWslSync(distroStopArgs(name), undefined, 5000);
  },
): void {
  try {
    signalDistroLock(signal, stopInside);
  } catch {
    // The lock may already be gone.
  }
  if (!Number.isInteger(wslPid) || wslPid <= 0) return;
  try {
    kill(wslPid, signal);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code)
      : '';
    if (code === 'ESRCH') return;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not signal ElastOS (${signal}): ${message}`);
  }
}

export function spawnDistroGatewayProcess(): GatewayProcess {
  const child = spawn('wsl.exe', distroGatewayArgs(), {
    windowsHide: true,
    env: wslSpawnEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
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
    onOutput(listener) { outputListeners.push(listener); },
    onExit(listener) { exitListeners.push(listener); },
    hasExited() { return exited; },
    signal(signal) { signalDistroGateway(child.pid ?? -1, signal); },
  };
}

export function createDistroGatewaySupervisor() {
  return createGatewaySupervisor({
    binary: '/root/.local/bin/elastos',
    spawn: () => spawnDistroGatewayProcess(),
    fetchHealth: async () => {
      try {
        const response = await fetch('http://127.0.0.1:8090/healthz', { signal: AbortSignal.timeout(2000) });
        return { status: response.status, body: await response.text() };
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    openUrl: openRuntimeHome,
    log: emitRuntimeLog,
    confirmForeign: confirmDistroGateway,
    adoptInstalled: () => adoptDistroGatewayProcess(),
  });
}

/**
 * The gateway pid inside the ElastOS distro, from its host lock.
 * Returns null when the lock is missing or the pid is not a positive integer.
 */
export function readDistroLockPid(
  run: (args: readonly string[]) => { code: number; stdout: string } = (args) => runWslSync(args, undefined, 8000),
): number | null {
  try {
    const result = run(['python3', '-c', LOCK_PID_HELPER]);
    if (result.code !== 0) return null;
    const pid = Number(String(result.stdout).trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

export function distroPidAlive(
  pid: number,
  run: (args: readonly string[]) => { code: number } = (args) => runWslSync(args, undefined, 8000),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return run(['python3', '-c', LOCK_ALIVE_HELPER, String(pid)]).code === 0;
  } catch {
    return false;
  }
}

/**
 * Adopt the installed distro gateway. The signal goes to that pid's group
 * inside the distro. hasExited asks the distro whether the pid is still there.
 * A missing pid is not adopted, and pid 0 is never signaled.
 */
export function adoptDistroGatewayProcess(deps: {
  readPid?: () => number | null;
  alive?: (pid: number) => boolean;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
} = {}): GatewayProcess | null {
  const readPid = deps.readPid ?? (() => readDistroLockPid());
  const alive = deps.alive ?? ((pid: number) => distroPidAlive(pid));
  const signalInside = deps.signal ?? ((pid: number, signal: NodeJS.Signals) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    signalDistroLock(signal);
  });
  const pid = readPid();
  if (pid == null || pid <= 0) return null;
  return {
    pid,
    onOutput() {},
    onExit() {},
    hasExited() { return !alive(pid); },
    signal(signal) { signalInside(pid, signal); },
  };
}

export function distroIsInstalled(): boolean {
  try {
    const binary = runWslSync(fileArgs('exists', '/root/.local/bin/elastos'), undefined, 8000);
    const components = runWslSync(fileArgs('exists', '/root/.local/share/elastos/components.json'), undefined, 8000);
    return binary.code === 0 && components.code === 0;
  } catch {
    return false;
  }
}

export function readDistroVersion(): string {
  try {
    const result = runWslSync(['/root/.local/bin/elastos', 'version'], undefined, 8000);
    if (result.code !== 0) return 'not installed';
    return parseRuntimeVersion(result.stdout) ?? 'not installed';
  } catch {
    return 'not installed';
  }
}

export function factsAreElastos(raw: string): boolean {
  let parsed: {
    lock?: string | null;
    command?: string | null;
    tcp?: string;
    links?: string[];
    alive?: boolean;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return false;
  }
  const inodes = healthListenInodes(parsed.tcp ?? '');
  return foreignListenerIsElastos({
    lockText: parsed.lock ?? null,
    command: parsed.command ?? null,
    pidAlive: () => parsed.alive === true,
    ownsSocket: () => pidOwnsSocketInodes(parsed.links ?? [], inodes),
  });
}

export async function confirmDistroGateway(): Promise<boolean> {
  try {
    const result = await runWsl(['python3', '-c', FACTS_HELPER], 8000);
    if (result.code !== 0) return false;
    return factsAreElastos(result.stdout);
  } catch {
    return false;
  }
}
