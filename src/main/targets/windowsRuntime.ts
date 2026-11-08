import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PinMismatchError } from './runtimeInstall';
import { installRuntime, RuntimeInstallDeps } from './runtimeInstall';
import { INSTALLER_ENV_NAMES, runtimeChildEnv } from './releaseHead';
import { loadActiveRuntimePin } from './runtimePin';
import { runtimeDataDir, runtimeUpdateCheckPath } from './runtimePaths';
import { parseRuntimeVersion } from './runtimeProbe';
import { RuntimeCommandResult } from './runtimeUpdate';
import { WINDOWS_NATIVE_MESSAGE } from './runtimeSupport';
import {
  createGatewaySupervisor,
  emitRuntimeLog,
  GatewayProcess,
  InstalledGatewayKind,
  installedGatewayKind,
  listenerOwnership,
  openRuntimeHome,
  probeGatewayHealth,
  procListenersFor,
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
import base64, os, stat, sys, pathlib
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
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else None
    if limit is not None:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise SystemExit(2)
        fd = os.open(raw, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            data = os.read(fd, limit + 1)
        finally:
            os.close(fd)
        if len(data) > limit:
            raise SystemExit(2)
    else:
        data = path.read_bytes()
    sys.stdout.write(base64.b64encode(data).decode('ascii'))
elif op == 'exists':
    raise SystemExit(0 if path.is_file() else 1)
else:
    raise SystemExit(2)
`.trim();

const STOP_HELPER = `
import os, signal, sys
name = sys.argv[1]
raw = sys.argv[2]
if type(raw) is not str or not raw.isdigit():
    raise SystemExit(1)
pid = int(raw)
if type(pid) is not int or pid <= 1:
    raise SystemExit(1)
os.kill(-pid, signal.SIGKILL if name == 'KILL' else signal.SIGTERM)
`.trim();

const LOCK_PID_HELPER = `
import json
doc = json.load(open('/root/.local/share/elastos/host-process.lock'))
pid = doc.get('pid')
if type(pid) is not int or pid <= 1:
    raise SystemExit(1)
print(pid)
`.trim();

const LOCK_ALIVE_HELPER = `
import os, sys
raw = sys.argv[1]
if type(raw) is not str or not raw.isdigit():
    raise SystemExit(2)
pid = int(raw)
if type(pid) is not int or pid <= 1:
    raise SystemExit(2)
try:
    os.kill(pid, 0)
except ProcessLookupError:
    raise SystemExit(1)
except OSError:
    raise SystemExit(0)
`.trim();

const FACTS_HELPER = `
import json, os
lock_path = '/root/.local/share/elastos/host-process.lock'
out = {'lock': None, 'command': None, 'tcp': '', 'tcp6': '', 'links': [], 'alive': False}
try:
    out['lock'] = open(lock_path).read()
except Exception:
    pass
pid = 0
try:
    pid = json.loads(out['lock'] or '{}').get('pid') or 0
except Exception:
    pid = 0
if type(pid) is int and pid > 1:
    out['alive'] = os.path.exists(f'/proc/{pid}')
    try:
        out['command'] = open(f'/proc/{pid}/cmdline', 'rb').read().replace(bytes([0]), b' ').decode()
    except Exception:
        out['command'] = None
    try:
        out['tcp'] = open('/proc/net/tcp').read()
    except Exception:
        out['tcp'] = ''
    try:
        out['tcp6'] = open('/proc/net/tcp6').read()
    except Exception:
        out['tcp6'] = ''
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

/** wsl.exe passes names listed in WSLENV into the distro, so no ELASTOS_* name is left to pass. */
export function wslSpawnEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...runtimeChildEnv(parent), WSL_UTF8: '1' };
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
  // The distro can hold its own values. Unset every name install.sh reads,
  // then set the head from the signed pin.
  return [
    'env',
    ...INSTALLER_ENV_NAMES.filter((name) => name !== 'ELASTOS_HEAD_CID').flatMap((name) => ['-u', name]),
    `ELASTOS_HEAD_CID=${head}`,
    'bash',
    script,
    ...args,
  ];
}

/** Runtime 2.0.0 enters the update controller only through this command. */
export function distroGatewayArgs(): string[] {
  return [...wslCommandPrefix(), '/root/.local/bin/elastos', 'home', '--browser'];
}

/**
 * The controller binary the host lock's parent must be running.
 * `queue_update` accepts a request only while that process is the live controller.
 */
export const DISTRO_CONTROLLER_COMMAND =
  `${runtimeDataDir('linux', DISTRO_HOME, {})}/update-controller/runtime __update-controller`;

/** Home's controller can take the runtime's full ready budget (120s) plus margin. Mac uses the same budget. */
export const DISTRO_HOME_READY_MS = 150_000;

export function distroHomeSpawnOptions(env: NodeJS.ProcessEnv = wslSpawnEnv()): {
  detached: true;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
} {
  return {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  };
}

export interface DistroProcFact {
  ppid: number | null;
  command: string | null;
}

/** Raw files from the distro. The stop decision does not trust this until `distroStopPid`. */
export interface DistroStopReport {
  lockText: string;
  statusText: string | null;
  procs: Readonly<Record<string, DistroProcFact>>;
}

/**
 * Pid to signal. A proved controller is the host's parent, shares the lock
 * generation, and is the update-controller binary. Otherwise the host pid.
 * Null when the lock names no usable pid.
 */
export function distroStopPid(report: DistroStopReport): number | null {
  let lock: { pid?: unknown; generation?: unknown };
  try {
    lock = JSON.parse(report.lockText) as { pid?: unknown; generation?: unknown };
  } catch {
    return null;
  }
  const host = lock.pid;
  if (typeof host !== 'number' || !Number.isInteger(host) || host <= 1) return null;
  if (!report.statusText) return host;
  let status: { host_pid?: unknown; generation?: unknown; controller_pid?: unknown };
  try {
    status = JSON.parse(report.statusText) as { host_pid?: unknown; generation?: unknown; controller_pid?: unknown };
  } catch {
    return host;
  }
  const controller = status.controller_pid;
  const proved = status.host_pid === host
    && typeof status.generation === 'string'
    && status.generation.length > 0
    && status.generation === lock.generation
    && typeof controller === 'number'
    && Number.isInteger(controller)
    && controller > 1
    && controller !== host;
  if (!proved) return host;
  const controllerFact = report.procs[String(controller)];
  const hostFact = report.procs[String(host)];
  if (!controllerFact || !hostFact) return host;
  if (hostFact.ppid !== controller) return host;
  if (!controllerFact.command || !controllerFact.command.includes(DISTRO_CONTROLLER_COMMAND)) return host;
  return controller;
}

export function parseDistroStopReport(raw: string): DistroStopReport | null {
  let parsed: { lock?: unknown; status?: unknown; procs?: unknown };
  try {
    parsed = JSON.parse(raw) as { lock?: unknown; status?: unknown; procs?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.lock !== 'string') return null;
  if (parsed.status !== null && typeof parsed.status !== 'string') return null;
  if (!parsed.procs || typeof parsed.procs !== 'object') return null;
  const procs: Record<string, DistroProcFact> = {};
  for (const [key, value] of Object.entries(parsed.procs as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(key) || !value || typeof value !== 'object') return null;
    const fact = value as { ppid?: unknown; command?: unknown };
    if (fact.ppid !== null && (typeof fact.ppid !== 'number' || !Number.isInteger(fact.ppid) || fact.ppid <= 0)) return null;
    if (fact.command !== null && typeof fact.command !== 'string') return null;
    procs[key] = {
      ppid: typeof fact.ppid === 'number' ? fact.ppid : null,
      command: typeof fact.command === 'string' ? fact.command : null,
    };
  }
  return {
    lockText: parsed.lock,
    statusText: parsed.status,
    procs,
  };
}

export const DISTRO_STOP_READER = `
import json, os, stat
LIMIT = 16384
ROOT = '/root/.local/share/elastos'
LOCK = ROOT + '/host-process.lock'
STATUS = ROOT + '/update-controller/status.json'

def read_text(path, required):
    current = ''
    parts = path.strip('/').split('/')
    info = None
    for index, part in enumerate(parts):
        current = current + '/' + part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            if required:
                raise SystemExit(1)
            return None
        if stat.S_ISLNK(info.st_mode):
            raise SystemExit(2)
        if index == len(parts) - 1:
            if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
                raise SystemExit(2)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        data = os.read(fd, LIMIT + 1)
    finally:
        os.close(fd)
    if len(data) > LIMIT:
        raise SystemExit(2)
    return data.decode('utf-8', 'replace')

def read_proc(path):
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        data = os.read(fd, LIMIT + 1)
    finally:
        os.close(fd)
    if len(data) > LIMIT:
        return None
    return data

def pid_of(text, key):
    try:
        value = json.loads(text).get(key)
    except Exception:
        return None
    if type(value) is int and value > 1:
        return value
    return None

def proc_fact(pid):
    base = '/proc/' + str(pid)
    try:
        info = os.lstat(base)
    except OSError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return None
    status = read_proc(base + '/status')
    cmd = read_proc(base + '/cmdline')
    ppid = None
    if status:
        for line in status.decode('utf-8', 'replace').split('\\n'):
            if line.startswith('PPid:'):
                raw = line[5:].strip()
                if raw.isdigit():
                    ppid = int(raw)
    command = None
    if cmd is not None:
        command = cmd.replace(b'\\x00', b' ').decode('utf-8', 'replace').strip()
    return {'ppid': ppid, 'command': command}

lock = read_text(LOCK, True)
status = read_text(STATUS, False)
procs = {}
for key, text in (('pid', lock), ('host_pid', status), ('controller_pid', status)):
    if not text:
        continue
    pid = pid_of(text, key)
    if pid and str(pid) not in procs:
        fact = proc_fact(pid)
        if fact:
            procs[str(pid)] = fact
print(json.dumps({'lock': lock, 'status': status, 'procs': procs}))
`.trim();

export function readDistroStopReport(
  run: (args: readonly string[]) => { code: number; stdout: string } = (args) => runWslSync(args, undefined, 8000),
): DistroStopReport | null {
  try {
    const result = run(['python3', '-c', DISTRO_STOP_READER]);
    if (result.code !== 0) return null;
    return parseDistroStopReport(result.stdout);
  } catch {
    return null;
  }
}

function resolvedDistroStopPid(report: DistroStopReport | null, hostPid: number): number {
  if (!report) return hostPid;
  let lockPid: unknown;
  try {
    lockPid = (JSON.parse(report.lockText) as { pid?: unknown }).pid;
  } catch {
    return hostPid;
  }
  if (lockPid !== hostPid) return hostPid;
  return distroStopPid(report) ?? hostPid;
}

export function distroToolCheckArgs(): readonly string[] {
  return ['bash', '-lc', 'command -v python3 >/dev/null && command -v curl >/dev/null'];
}

export function distroRuntimeArgs(args: readonly string[]): string[] {
  return ['/root/.local/bin/elastos', ...args];
}

export function runDistroRuntimeCommand(args: readonly string[]): Promise<RuntimeCommandResult> {
  return runWsl(distroRuntimeArgs(args), 15 * 60 * 1000);
}

/** Same byte cap as the controller status read in DISTRO_STOP_READER. */
const DISTRO_STATUS_READ_LIMIT = 16384;

export function readDistroUpdateStatus(): string {
  return readDistroFile(
    runtimeUpdateCheckPath(runtimeDataDir('linux', DISTRO_HOME, {})),
    DISTRO_STATUS_READ_LIMIT,
  );
}

export function distroPackageArgs(): readonly string[] {
  return ['bash', '-lc', 'printf "nameserver 8.8.8.8\\n" > /etc/resolv.conf; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 curl ca-certificates'];
}

/** Signal this pid's group. The helper does not read the lock again. Pid 1 is refused. */
export function distroStopArgs(signal: 'TERM' | 'KILL', pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error('Refusing to signal that process.');
  }
  return ['python3', '-c', STOP_HELPER, signal, String(pid)];
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

function fileArgs(op: string, file: string, limit?: number): string[] {
  const args = ['python3', '-c', FILE_HELPER, op, assertDistroPath(file)];
  if (limit !== undefined) args.push(String(limit));
  return args;
}

function readDistroFile(file: string, limit?: number): string {
  const result = runWslSync(fileArgs('read', file, limit));
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

const DISTRO_FIRST_BOOT_MS = 3 * 60 * 1000;

export async function ensureElastosDistro(deps: {
  lookupWsl: () => Promise<boolean>;
  listDistros: () => Promise<string>;
  ensureRootfs: () => Promise<string>;
  importDistro: (installDir: string, rootfs: string) => Promise<number>;
  prepareImportDir?: (dir: string) => void;
  runInDistro?: (args: readonly string[], timeoutMs: number) => Promise<WslResult>;
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
  const run = deps.runInDistro ?? ((args, timeoutMs) => runWsl(args, timeoutMs));
  if (!facts.distroReady) {
    const rootfs = await deps.ensureRootfs();
    deps.onProgress('Rootfs SHA-256 matches the pin');
    (deps.prepareImportDir ?? prepareImportDir)(DISTRO_INSTALL_DIR);
    const code = await deps.importDistro(DISTRO_INSTALL_DIR, rootfs);
    if (code !== 0) throw new Error(DISTRO_IMPORT_FAILED);
    deps.onProgress('Starting the Linux environment for the first time');
  }
  let booted: WslResult;
  try {
    booted = await run(['true'], DISTRO_FIRST_BOOT_MS);
  } catch {
    throw new Error(DISTRO_SETUP_FAILED);
  }
  if (booted.code !== 0) throw new Error(DISTRO_SETUP_FAILED);
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
    // The record as Reset reads it in the distro (the fixed helper, no link
    // followed), checked against the pinned DID. The helper's data folder is
    // this same /root/.local/share/elastos.
    installRecordProved: () => {
      const reset = require('./windowsReset') as typeof import('./windowsReset');
      return reset.distroInstallRecordProved(reset.wslHelperRun(), reset.distroResetPaths(), pin.maintainerDid);
    },
  };
}

export async function installRuntimeInsideDistro(
  onProgress: (message: string) => void = () => {},
  host: {
    lookupWsl?: () => Promise<boolean>;
    listDistros?: () => Promise<string>;
    ensureRootfs?: () => Promise<string>;
    importDistro?: (installDir: string, rootfs: string) => Promise<number>;
    prepareImportDir?: (dir: string) => void;
    runInDistro?: (args: readonly string[], timeoutMs: number) => Promise<WslResult>;
    continueInstall?: (onProgress: (message: string) => void) => Promise<void>;
  } = {},
): Promise<void> {
  const run = host.runInDistro ?? ((args: readonly string[], timeoutMs: number) => runWsl(args, timeoutMs));
  await ensureElastosDistro({
    lookupWsl: host.lookupWsl ?? (() => lookupCommand('wsl.exe')),
    listDistros: host.listDistros ?? listDistros,
    ensureRootfs: host.ensureRootfs ?? (() => ensureElastosRootfs({
      dest: path.join(os.homedir(), '.elastos-launcher', 'ubuntu-noble-wsl.rootfs.tar.gz'),
      exists: (file) => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      },
      download: downloadPinnedRootfs,
      read: (file) => fs.readFileSync(file),
      accept: assertPinnedRootfs,
    })),
    importDistro: host.importDistro ?? ((installDir, rootfs) => runHost(importDistroArgs(installDir, rootfs), 10 * 60 * 1000)),
    prepareImportDir: host.prepareImportDir,
    runInDistro: run,
    hasTools: async () => (await run(distroToolCheckArgs(), 20000)).code === 0,
    installTools: async () => (await run(distroPackageArgs(), 10 * 60 * 1000)).code,
    onProgress,
  });
  if (host.continueInstall) {
    await host.continueInstall(onProgress);
    return;
  }
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

function signalResolvedDistroPid(name: 'TERM' | 'KILL'): void {
  const report = readDistroStopReport();
  const host = (() => {
    try {
      return (JSON.parse(report?.lockText ?? '') as { pid?: unknown }).pid;
    } catch {
      return null;
    }
  })();
  if (typeof host !== 'number' || !Number.isInteger(host) || host <= 1) return;
  const pid = resolvedDistroStopPid(report, host);
  if (!Number.isInteger(pid) || pid <= 1) return;
  runWslSync(distroStopArgs(name, pid), undefined, 5000);
  // SIGKILL cannot ask the controller to drain its child. Stop the host group too.
  if (name === 'KILL' && pid !== host) {
    runWslSync(distroStopArgs(name, host), undefined, 5000);
  }
}

/** Signal the proved controller, or the host lock pid when no controller is proved. Never uses pid 0 or 1. */
export function signalDistroLock(
  signal: NodeJS.Signals,
  stopInside: (name: 'TERM' | 'KILL') => void = signalResolvedDistroPid,
): void {
  const name = signal === 'SIGKILL' ? 'KILL' : 'TERM';
  stopInside(name);
}

export function signalDistroGateway(
  wslPid: number,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  stopInside: (name: 'TERM' | 'KILL') => void = signalResolvedDistroPid,
): void {
  try {
    signalDistroLock(signal, stopInside);
  } catch {
    // The lock may already be gone.
  }
  // SIGTERM lets the controller drain Home. wsl.exe exits when that command exits.
  // SIGKILL also ends wsl.exe if the distro command is still there.
  if (signal !== 'SIGKILL') return;
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
  const child = spawn('wsl.exe', distroGatewayArgs(), distroHomeSpawnOptions());
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
    args: ['home', '--browser'],
    spawn: () => spawnDistroGatewayProcess(),
    // Windows forwards localhost to the distro. Probe each address Windows
    // resolves localhost to, the same way the Windows browser can connect.
    fetchHealth: () => probeGatewayHealth(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    openUrl: openRuntimeHome,
    log: emitRuntimeLog,
    adoptForControls: true,
    healthTimeoutMs: DISTRO_HOME_READY_MS,
    confirmForeign: confirmDistroGateway,
    foreignIsLegacy: async () => (await distroListenerKind()) === 'legacy',
    // The Windows side of the forward has no pid this launcher can check.
    // Inside the distro, the lock pid must own every gateway socket.
    listenerOwned: () => confirmDistroGateway(),
    adoptInstalled: () => adoptInstalledDistroGateway(),
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
    if (!Number.isInteger(pid) || pid <= 1) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * True when the pid is still there, or when the distro could not be asked.
 * Only a confirmed ProcessLookupError (exit 1) is dead. A timeout stays alive
 * so Stop does not report the gateway stopped.
 */
export async function distroPidAlive(
  pid: number,
  run: (args: readonly string[]) => Promise<{ code: number }> = (args) => runWsl(args, 8000),
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try {
    const result = await run(['python3', '-c', LOCK_ALIVE_HELPER, String(pid)]);
    return result.code !== 1;
  } catch {
    return true;
  }
}

/** `elastos` is a localhost:8090 gateway. `legacy` is one on 127.0.0.1:8090 from an earlier launcher. */
export type DistroListenerKind = 'elastos' | 'legacy' | 'other' | 'unknown';

export interface DistroListenerIdentity {
  kind: DistroListenerKind;
  /** The lock pid the facts proved is the gateway. Null unless kind is `elastos` or `legacy`. */
  pid: number | null;
}

/** The pid from the lock text the facts read. Null when it is not a usable pid. */
function factsLockPid(raw: string): number | null {
  try {
    const facts = JSON.parse(raw) as { lock?: unknown };
    if (typeof facts.lock !== 'string') return null;
    const lock = JSON.parse(facts.lock) as { pid?: unknown };
    const pid = lock.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Identify the listener and keep the pid that one facts read proved. A failed
 * read is `unknown`. A listener that is not ElastOS is `other`.
 */
export async function distroListenerIdentity(
  run: (args: readonly string[], timeoutMs: number) => Promise<WslResult> = runWsl,
): Promise<DistroListenerIdentity> {
  try {
    const result = await run(['python3', '-c', FACTS_HELPER], 8000);
    if (result.code !== 0) return { kind: 'unknown', pid: null };
    const gateway = factsGatewayKind(result.stdout);
    if (!gateway) return { kind: 'other', pid: null };
    const pid = factsLockPid(result.stdout);
    if (pid == null) return { kind: 'unknown', pid: null };
    return { kind: gateway === 'current' ? 'elastos' : 'legacy', pid };
  } catch {
    return { kind: 'unknown', pid: null };
  }
}

/** `other` is a listener that is not ElastOS. A failed read is `unknown`. */
export async function distroListenerKind(
  run: (args: readonly string[], timeoutMs: number) => Promise<WslResult> = runWsl,
): Promise<DistroListenerKind> {
  return (await distroListenerIdentity(run)).kind;
}

/**
 * Adopt the installed distro Home. The host pid is the one the caller proved.
 * A controller is signaled only when this same lock says it is that host's
 * parent. hasExited asks the distro whether those pids are still there and
 * treats an error as still running. A missing pid is not adopted, and pid 0
 * is never signaled.
 */
export function adoptDistroGatewayProcess(deps: {
  readPid?: () => number | null;
  alive?: (pid: number) => boolean | Promise<boolean>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  runStop?: (args: readonly string[]) => void;
  report?: () => DistroStopReport | null;
} = {}): GatewayProcess | null {
  const readPid = deps.readPid ?? (() => readDistroLockPid());
  const alive = deps.alive ?? ((pid: number) => distroPidAlive(pid));
  const signalInside = deps.signal ?? ((pid: number, signal: NodeJS.Signals) => {
    if (!Number.isInteger(pid) || pid <= 1) return;
    const name = signal === 'SIGKILL' ? 'KILL' : 'TERM';
    const run = deps.runStop ?? ((args: readonly string[]) => {
      runWslSync(args, undefined, 5000);
    });
    run(distroStopArgs(name, pid));
  });
  const pid = readPid();
  if (pid == null || pid <= 1) return null;
  let stopPid = pid;
  if (deps.report) {
    try {
      stopPid = resolvedDistroStopPid(deps.report(), pid);
    } catch {
      stopPid = pid;
    }
  }
  if (!Number.isInteger(stopPid) || stopPid <= 1) stopPid = pid;
  const gone = (target: number): boolean | Promise<boolean> => {
    try {
      const result = alive(target);
      if (result && typeof (result as Promise<boolean>).then === 'function') {
        return (result as Promise<boolean>).then((still) => still === false).catch(() => false);
      }
      return result === false;
    } catch {
      return false;
    }
  };
  return {
    pid,
    onOutput() {},
    onExit() {},
    hasExited() {
      const hostGone = gone(pid);
      const controllerGone = stopPid === pid ? true : gone(stopPid);
      if (hostGone instanceof Promise || controllerGone instanceof Promise) {
        return Promise.all([hostGone, controllerGone]).then((both) => both.every(Boolean));
      }
      return hostGone && controllerGone;
    },
    signal(signal) {
      signalInside(stopPid, signal);
      if (signal === 'SIGKILL' && stopPid !== pid) signalInside(pid, signal);
    },
  };
}

/**
 * Reset and Uninstall adopt the lock pid only when the distro facts say it
 * is the ElastOS gateway. A different listener, and a facts read that fails,
 * are left running. The confirm dialog is not a license to signal an
 * unidentified pid. The adopted pid is the one those facts proved, not a
 * second read of the lock, so a lock rewritten between the two reads is not
 * signaled.
 */
export async function adoptInstalledDistroGateway(deps: {
  identify?: () => Promise<DistroListenerIdentity>;
  adopt?: (pid: number) => GatewayProcess | null;
} = {}): Promise<GatewayProcess | null> {
  const identify = deps.identify ?? (() => distroListenerIdentity());
  const adopt = deps.adopt ?? ((pid: number) => adoptDistroGatewayProcess({
    readPid: () => pid,
    report: () => readDistroStopReport(),
  }));
  let seen: DistroListenerIdentity;
  try {
    seen = await identify();
  } catch {
    return null;
  }
  if ((seen.kind !== 'elastos' && seen.kind !== 'legacy') || seen.pid == null || !Number.isInteger(seen.pid) || seen.pid <= 1) return null;
  return adopt(seen.pid);
}

/** Install and status read the program and the components manifest inside the distro. */
export function distroIsInstalled(
  exists: (file: string) => boolean = (file) => runWslSync(fileArgs('exists', file), undefined, 8000).code === 0,
): boolean {
  try {
    return exists('/root/.local/bin/elastos') && exists('/root/.local/share/elastos/components.json');
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

/** The gateway kind the distro facts prove, from tcp and tcp6, or null. */
export function factsGatewayKind(raw: string): InstalledGatewayKind | null {
  let parsed: {
    lock?: string | null;
    command?: string | null;
    tcp?: string;
    tcp6?: string;
    links?: string[];
    alive?: boolean;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  const listeners = procListenersFor(parsed.tcp ?? '', parsed.tcp6 ?? '', parsed.links ?? []);
  return installedGatewayKind({
    lockText: parsed.lock ?? null,
    command: parsed.command ?? null,
    pidAlive: () => parsed.alive === true,
    ownsSocket: (_pid, wants) => listenerOwnership(listeners, wants) === 'owned',
  });
}

/** True only for a localhost:8090 gateway. A 127.0.0.1:8090 one is stopped, not opened. */
export function factsAreElastos(raw: string): boolean {
  return factsGatewayKind(raw) === 'current';
}

export async function confirmDistroGateway(): Promise<boolean> {
  return (await distroListenerKind()) === 'elastos';
}
