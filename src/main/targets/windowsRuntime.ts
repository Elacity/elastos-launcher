import { ChildProcess, spawn, spawnSync } from 'child_process';
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
export const HOME_UNCONFIRMED_MESSAGE = 'Home could not be confirmed';

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

export const STOP_HELPER = `
import errno, json, os, signal, stat, sys, time
MESSAGE = 'Home could not be confirmed'
RECORD_MAX = 16384
STAT_MAX = 4096
LINK_MAX = 4096
BOOT_MAX = 128
CMD_MAX = 64
DATA = '/root/.local/share/elastos'
LOCK = DATA + '/host-process.lock'
STATUS = DATA + '/update-controller/status.json'
RUNTIME = DATA + '/update-controller/runtime'
BINARY = '/root/.local/bin/elastos'

def located(root, suffix):
    if root == '/':
        return suffix
    return root.rstrip('/') + suffix

def publish(channel, seq, text):
    final = os.path.join(channel, 'reply-%d' % seq)
    tmp = final + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, (text + '\\n').encode('utf-8'))
    finally:
        os.close(fd)
    os.replace(tmp, final)

def refuse(channel):
    try:
        publish(channel, 0, MESSAGE)
    except Exception:
        pass
    raise SystemExit(1)

def walk(path):
    current = ''
    parts = path.strip('/').split('/')
    if not parts or parts == ['']:
        return None
    for index, part in enumerate(parts):
        current = current + '/' + part
        try:
            info = os.lstat(current)
        except OSError:
            return None
        if stat.S_ISLNK(info.st_mode):
            return False
        if index == len(parts) - 1:
            return info
    return None

def read_file(path, limit):
    info = walk(path)
    if info is None or info is False:
        return info
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        return False
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return False
    try:
        data = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(data) > limit:
        return False
    return data

def load_json(data):
    if data is None or data is False:
        return data
    try:
        parsed = json.loads(data.decode('utf-8'))
    except Exception:
        return False
    if type(parsed) is not dict:
        return False
    return parsed

def positive(value):
    if type(value) is not int or value <= 1:
        return None
    return value

def token(value, limit):
    if type(value) is not str or value == '' or len(value) > limit:
        return None
    if '\\r' in value or '\\n' in value:
        return None
    return value

def prove(root):
    lock = load_json(read_file(located(root, LOCK), RECORD_MAX))
    status = load_json(read_file(located(root, STATUS), RECORD_MAX))
    if lock is None or lock is False or status is None or status is False:
        return None
    if lock.get('role') != 'gateway' or lock.get('addr') != 'localhost:8090':
        return None
    generation = token(lock.get('generation'), 128)
    if generation is None or generation != token(status.get('generation'), 128):
        return None
    start = token(status.get('controller_start'), 200)
    host = positive(lock.get('pid'))
    if start is None or host is None or positive(status.get('host_pid')) != host:
        return None
    controller = positive(status.get('controller_pid'))
    if controller is None or controller == host:
        return None
    return controller, start

def start_ticks(text, pid):
    space = text.find(' ')
    if space <= 0 or text[:space] != str(pid):
        return None
    end = text.rfind(')')
    if end < 0:
        return None
    parts = text[end + 1:].split()
    if len(parts) <= 19 or not parts[19].isdigit():
        return None
    return parts[19]

def load_boot(root):
    data = read_file(located(root, '/proc/sys/kernel/random/boot_id'), BOOT_MAX)
    if data is None:
        return True, None
    if data is False:
        return False, None
    boot = data.decode('utf-8', 'replace').strip()
    if boot == '' or any(ch.isspace() for ch in boot):
        return False, None
    return True, boot

def process_identity(text, boot, pid):
    ticks = start_ticks(text, pid)
    if ticks is None:
        return None
    if boot is None:
        return 'linux:' + ticks
    return 'linux:' + boot + ':' + ticks

def allowed_exes(root):
    found = []
    for suffix in (RUNTIME, BINARY):
        path = located(root, suffix)
        info = walk(path)
        if info is None or info is False or not stat.S_ISREG(info.st_mode):
            continue
        real = os.path.realpath(path)
        if real not in found:
            found.append(real)
    return found

def controller_exe(root, pid):
    path = located(root, '/proc/%d/exe' % pid)
    parent = path.rsplit('/', 1)[0]
    info = walk(parent)
    if info is None or info is False or not stat.S_ISDIR(info.st_mode):
        return None
    try:
        leaf = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISLNK(leaf.st_mode):
        return None
    try:
        link = os.readlink(path)
    except OSError:
        return None
    if len(link) > LINK_MAX or not link.startswith('/') or link.endswith(' (deleted)'):
        return None
    if '\\n' in link or '\\r' in link or '\\x00' in link:
        return None
    return os.path.realpath(link)

def identity_matches(root, pid, start):
    data = read_file(located(root, '/proc/%d/stat' % pid), STAT_MAX)
    if data is None or data is False:
        return False
    ok, boot = load_boot(root)
    if not ok:
        return False
    if process_identity(data.decode('utf-8', 'replace'), boot, pid) != start:
        return False
    exe = controller_exe(root, pid)
    if exe is None:
        return False
    return exe in allowed_exes(root)

def read_cmd(channel, seq):
    path = os.path.join(channel, 'cmd-%d' % seq)
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            info = os.lstat(path)
        except OSError:
            time.sleep(0.02)
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > CMD_MAX:
            return None
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            return None
        try:
            data = os.read(fd, CMD_MAX + 1)
        finally:
            os.close(fd)
        if len(data) > CMD_MAX:
            return None
        if not data.endswith(b'\\n'):
            time.sleep(0.02)
            continue
        return data.decode('utf-8', 'replace').strip()
    return None

def serve(root, channel):
    proved = prove(root)
    if proved is None:
        refuse(channel)
    pid, start = proved
    opener = getattr(os, 'pidfd_open', None)
    sender = getattr(signal, 'pidfd_send_signal', None)
    if opener is None or sender is None:
        refuse(channel)
    try:
        pidfd = opener(pid, 0)
    except OSError:
        refuse(channel)
    try:
        if not identity_matches(root, pid, start):
            refuse(channel)
        publish(channel, 0, 'ready')
        seq = 1
        while True:
            command = read_cmd(channel, seq)
            if command is None:
                return
            if command == 'close':
                publish(channel, seq, 'closed')
                return
            if command == 'TERM':
                sig = signal.SIGTERM
            elif command == 'KILL':
                sig = signal.SIGKILL
            else:
                publish(channel, seq, MESSAGE)
                seq += 1
                continue
            try:
                sender(pidfd, sig, None, 0)
            except OSError as err:
                code = errno.errorcode.get(err.errno, '')
                if code == 'ESRCH':
                    publish(channel, seq, 'errno ESRCH')
                else:
                    publish(channel, seq, MESSAGE)
                seq += 1
                continue
            publish(channel, seq, 'sent')
            seq += 1
    finally:
        try:
            os.close(pidfd)
        except OSError:
            pass

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '/'
    channel = sys.argv[2] if len(sys.argv) > 2 else ''
    if not root.startswith('/') or not channel.startswith('/'):
        raise SystemExit(1)
    try:
        info = os.lstat(channel)
    except OSError:
        raise SystemExit(1)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SystemExit(1)
    try:
        serve(root, channel)
    except SystemExit:
        raise
    except Exception:
        refuse(channel)

main()
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

export const FACTS_HELPER = `
import json, os, stat, sys
RECORD_MAX = 16384
PROC_MAX = 8 * 1024 * 1024
FD_MAX = 1024
LINK_MAX = 4096
root = sys.argv[1] if len(sys.argv) > 1 else ''
if root and not root.startswith('/'):
    raise SystemExit(1)

def under(suffix):
    if root == '' or root == '/':
        return suffix
    return root.rstrip('/') + suffix

def walk(path):
    current = ''
    parts = path.strip('/').split('/')
    if not parts or parts == ['']:
        return None
    for index, part in enumerate(parts):
        current = current + '/' + part
        try:
            info = os.lstat(current)
        except OSError:
            return None
        if stat.S_ISLNK(info.st_mode):
            return False
        if index == len(parts) - 1:
            return info
    return None

def read_capped(path, limit):
    info = walk(path)
    if info is None or info is False:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        data = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(data) > limit:
        return None
    return data

lock_path = under('/root/.local/share/elastos/host-process.lock')
out = {'lock': None, 'command': None, 'tcp': '', 'tcp6': '', 'links': [], 'alive': False}
lock_data = read_capped(lock_path, RECORD_MAX)
if lock_data is not None:
    out['lock'] = lock_data.decode('utf-8', 'replace')
pid = 0
try:
    pid = json.loads(out['lock'] or '{}').get('pid') or 0
except Exception:
    pid = 0
if type(pid) is int and pid > 1:
    proc = under('/proc/%d' % pid)
    try:
        info = os.lstat(proc)
        out['alive'] = (not stat.S_ISLNK(info.st_mode)) and stat.S_ISDIR(info.st_mode)
    except OSError:
        out['alive'] = False
    command = read_capped(proc + '/cmdline', RECORD_MAX)
    if command is not None:
        out['command'] = command.replace(bytes([0]), b' ').decode('utf-8', 'replace')
    tcp = read_capped(under('/proc/net/tcp'), PROC_MAX)
    out['tcp'] = '' if tcp is None else tcp.decode('utf-8', 'replace')
    tcp6 = read_capped(under('/proc/net/tcp6'), PROC_MAX)
    out['tcp6'] = '' if tcp6 is None else tcp6.decode('utf-8', 'replace')
    links = []
    fd_dir = proc + '/fd'
    try:
        info = os.lstat(fd_dir)
        names = [] if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) else os.listdir(fd_dir)
    except OSError:
        names = []
    if len(names) <= FD_MAX:
        for name in names:
            try:
                link = os.readlink(fd_dir + '/' + name)
            except OSError:
                continue
            if len(link) <= LINK_MAX:
                links.append(link)
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

/** Stop does not signal a pid from this report. */
export interface DistroStopReport {
  lockText: string;
  statusText: string | null;
  procs: Readonly<Record<string, DistroProcFact>>;
}

/** Stop does not signal this value. */
export function distroStopPid(report: DistroStopReport): number | null {
  let lock: { pid?: unknown; generation?: unknown };
  try {
    lock = JSON.parse(report.lockText) as { pid?: unknown; generation?: unknown };
  } catch {
    return null;
  }
  const host = lock.pid;
  if (typeof host !== 'number' || !Number.isInteger(host) || host <= 1) return null;
  if (!report.statusText) return null;
  let status: { host_pid?: unknown; generation?: unknown; controller_pid?: unknown };
  try {
    status = JSON.parse(report.statusText) as { host_pid?: unknown; generation?: unknown; controller_pid?: unknown };
  } catch {
    return null;
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
  if (!proved) return null;
  const controllerFact = report.procs[String(controller)];
  const hostFact = report.procs[String(host)];
  if (!controllerFact || !hostFact) return null;
  if (hostFact.ppid !== controller) return null;
  if (!controllerFact.command || !controllerFact.command.includes(DISTRO_CONTROLLER_COMMAND)) return null;
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

export function distroStopArgs(root = '/', channel?: string): string[] {
  const args = ['python3', '-c', STOP_HELPER, root];
  if (channel) args.push(channel);
  return args;
}

export const WSL_OUTPUT_MAX = 20 * 1024 * 1024;

export function appendCappedOutput(
  chunks: Buffer[],
  total: number,
  chunk: Buffer,
  max = WSL_OUTPUT_MAX,
): number {
  if (total >= max || chunk.length === 0) return total;
  const room = max - total;
  const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
  chunks.push(Buffer.from(slice));
  return total + slice.length;
}

const STOP_REPLY_MS = 8000;

export interface DistroStopSession {
  signal(name: 'TERM' | 'KILL'): void;
  close(): void;
  dispose(): void;
}

function helperGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code)
      : '';
    return code === 'ESRCH';
  }
  if (process.platform === 'win32') return false;
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
  const state = (result.stdout || '').trim();
  return state === '' || state.startsWith('Z');
}

function distroVisiblePath(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!drive) return normalized;
  return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
}

interface CreatedDir {
  path: string;
  dev: number;
  ino: number;
}

function stopChannelRoot(): string {
  return path.resolve(os.tmpdir());
}

function createStopChannel(): CreatedDir {
  const dir = fs.mkdtempSync(path.join(stopChannelRoot(), 'elastos-stop-'));
  fs.chmodSync(dir, 0o700);
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(HOME_UNCONFIRMED_MESSAGE);
  return { path: dir, dev: info.dev, ino: info.ino };
}

function parentsStayReal(dir: string, root: string): boolean {
  let current = path.resolve(dir);
  const stop = path.resolve(root);
  if (current !== stop && !current.startsWith(`${stop}${path.sep}`)) return false;
  while (current !== stop) {
    let info: fs.Stats;
    try {
      info = fs.lstatSync(current);
    } catch {
      return false;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  try {
    const rootInfo = fs.lstatSync(stop);
    return !rootInfo.isSymbolicLink() && rootInfo.isDirectory();
  } catch {
    return false;
  }
}

function removeStopChannel(dir: CreatedDir): void {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(dir.path);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  if (info.dev !== dir.dev || info.ino !== dir.ino) return;
  if (!parentsStayReal(dir.path, stopChannelRoot())) return;
  fs.rmSync(dir.path, { recursive: true, force: true });
}

function assertStopChannel(dir: CreatedDir): void {
  const info = fs.lstatSync(dir.path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== dir.dev || info.ino !== dir.ino) {
    throw new Error(HOME_UNCONFIRMED_MESSAGE);
  }
}

function readStopReply(dir: CreatedDir, seq: number, childPid: number, timeoutMs: number): string {
  assertStopChannel(dir);
  const file = path.join(dir.path, `reply-${seq}`);
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\n') || text.includes('\r')) return text.split(/\r?\n/, 1)[0].trim();
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
      if (code !== 'ENOENT') throw err;
    }
    if (helperGone(childPid)) throw new Error(HOME_UNCONFIRMED_MESSAGE);
    Atomics.wait(pause, 0, 0, 20);
  }
  throw new Error(HOME_UNCONFIRMED_MESSAGE);
}

function writeStopCommand(dir: CreatedDir, seq: number, command: string): void {
  assertStopChannel(dir);
  const finalPath = path.join(dir.path, `cmd-${seq}`);
  const tmp = `${finalPath}.tmp`;
  fs.writeFileSync(tmp, `${command}\n`, { mode: 0o600 });
  fs.renameSync(tmp, finalPath);
}

function defaultStopSpawn(args: readonly string[]): ChildProcess {
  return spawn('wsl.exe', [...wslCommandPrefix(), ...args], {
    windowsHide: true,
    env: wslSpawnEnv(),
    stdio: 'ignore',
  });
}

export function createDistroStopSession(deps: {
  root?: string;
  spawn?: (args: readonly string[]) => ChildProcess;
} = {}): DistroStopSession {
  const root = deps.root ?? '/';
  const launch = deps.spawn ?? defaultStopSpawn;
  let dir: CreatedDir | null = null;
  let child: ChildProcess | null = null;
  let ready = false;
  let seq = 0;
  let closed = false;
  let holding = false;

  function stopChild(): void {
    if (!child?.pid || helperGone(child.pid)) return;
    try {
      child.kill('SIGKILL');
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
      if (code !== 'ESRCH') throw err;
    }
  }

  function finish(): void {
    if (closed) return;
    holding = true;
    closed = true;
    let closeError: unknown = null;
    if (ready && dir && child?.pid && !helperGone(child.pid)) {
      try {
        seq += 1;
        writeStopCommand(dir, seq, 'close');
        readStopReply(dir, seq, child.pid, STOP_REPLY_MS);
      } catch (err) {
        closeError = err;
      }
    }
    const helperExited = child?.pid != null && helperGone(child.pid);
    stopChild();
    if (dir) removeStopChannel(dir);
    holding = false;
    if (closeError && !helperExited) throw closeError;
  }

  return {
    signal(name) {
      if (closed || (name !== 'TERM' && name !== 'KILL')) throw new Error(HOME_UNCONFIRMED_MESSAGE);
      holding = true;
      try {
        if (!ready) {
          dir = createStopChannel();
          const channel = dir.path;
          child = launch(distroStopArgs(root, distroVisiblePath(channel)));
          child.on('error', () => {});
          child.on('exit', () => {
            if (holding) return;
            closed = true;
            if (dir) removeStopChannel(dir);
          });
          child.unref();
          if (!child.pid) {
            finish();
            throw new Error(HOME_UNCONFIRMED_MESSAGE);
          }
          const opened = readStopReply(dir, 0, child.pid, STOP_REPLY_MS);
          if (opened !== 'ready') {
            finish();
            throw new Error(HOME_UNCONFIRMED_MESSAGE);
          }
          ready = true;
        }
        if (!dir || !child?.pid) throw new Error(HOME_UNCONFIRMED_MESSAGE);
        seq += 1;
        writeStopCommand(dir, seq, name);
        const reply = readStopReply(dir, seq, child.pid, STOP_REPLY_MS);
        if (reply === 'sent' || reply === 'errno ESRCH') return;
        throw new Error(HOME_UNCONFIRMED_MESSAGE);
      } finally {
        if (!closed) holding = false;
      }
    },
    close() { finish(); },
    dispose() {
      try {
        finish();
      } catch {
        // finish() already dropped the helper. Stop still reports its own error.
      }
    },
  };
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
    let stdoutTotal = 0;
    let stderrTotal = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(DISTRO_SETUP_FAILED));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(plainSpawnError(err, DISTRO_SETUP_FAILED));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutTotal = appendCappedOutput(stdout, stdoutTotal, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTotal = appendCappedOutput(stderr, stderrTotal, chunk);
    });
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

export function signalDistroLock(
  signal: NodeJS.Signals,
  stopInside: (name: 'TERM' | 'KILL') => void,
): void {
  stopInside(signal === 'SIGKILL' ? 'KILL' : 'TERM');
}

export function signalDistroGateway(
  wslPid: number,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  stopInside: (name: 'TERM' | 'KILL') => void = () => { throw new Error(HOME_UNCONFIRMED_MESSAGE); },
): void {
  let stopError: unknown = null;
  try {
    signalDistroLock(signal, stopInside);
  } catch (err) {
    stopError = err;
  }
  if (signal === 'SIGKILL' && Number.isInteger(wslPid) && wslPid > 0) {
    try {
      kill(wslPid, signal);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
      if (code !== 'ESRCH' && !stopError) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not signal ElastOS (${signal}): ${message}`);
      }
    }
  }
  if (stopError) {
    if (stopError instanceof Error) throw stopError;
    throw new Error(HOME_UNCONFIRMED_MESSAGE);
  }
}

export function spawnDistroGatewayProcess(): GatewayProcess {
  const child = spawn('wsl.exe', distroGatewayArgs(), distroHomeSpawnOptions());
  const session = createDistroStopSession();
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
    signal(signal) {
      try {
        signalDistroGateway(child.pid ?? -1, signal, process.kill, (name) => session.signal(name));
      } finally {
        if (signal === 'SIGKILL') session.close();
      }
    },
    dispose() {
      session.dispose();
    },
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
 * Adopt the installed distro Home. Stop signals only the confirmed controller.
 * hasExited asks whether the lock pid is still there and treats an error as
 * still running. A missing pid is not adopted.
 */
export function adoptDistroGatewayProcess(deps: {
  readPid?: () => number | null;
  alive?: (pid: number) => boolean | Promise<boolean>;
  stop?: (name: 'TERM' | 'KILL') => void;
  root?: string;
  spawn?: (args: readonly string[]) => ChildProcess;
} = {}): GatewayProcess | null {
  const readPid = deps.readPid ?? (() => readDistroLockPid());
  const alive = deps.alive ?? ((pid: number) => distroPidAlive(pid));
  let session: DistroStopSession | null = null;
  const stop = deps.stop ?? ((name: 'TERM' | 'KILL') => {
    if (!session) session = createDistroStopSession({ root: deps.root, spawn: deps.spawn });
    session.signal(name);
  });
  const pid = readPid();
  if (pid == null || pid <= 1) return null;
  const gone = (): boolean | Promise<boolean> => {
    try {
      const result = alive(pid);
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
      return gone();
    },
    signal(signal) {
      const name = signal === 'SIGKILL' ? 'KILL' : 'TERM';
      try {
        stop(name);
      } finally {
        if (name === 'KILL') session?.close();
      }
    },
    dispose() {
      session?.dispose();
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
