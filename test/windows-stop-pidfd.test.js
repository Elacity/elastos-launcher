const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const windowsRuntime = require('../dist/main/targets/windowsRuntime');
const { createGatewaySupervisor } = require('../dist/main/targets/runtimeGateway');

const STOP_HELPER = windowsRuntime.STOP_HELPER;
const FACTS_HELPER = windowsRuntime.FACTS_HELPER;
const { appendCappedOutput, WSL_OUTPUT_MAX } = windowsRuntime;
const HOME_UNCONFIRMED_MESSAGE = windowsRuntime.HOME_UNCONFIRMED_MESSAGE || 'Home could not be confirmed';

const TEMP = fs.realpathSync(os.tmpdir());

function python() {
  const probe = spawnSync('python3', ['-V'], { encoding: 'utf8' });
  assert.equal(probe.error, undefined, probe.error && probe.error.message);
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
}

function procStat(pid, ppid, start) {
  const fields = [
    'S', String(ppid), String(pid), String(pid), '0', '-1', '4194304',
    '0', '0', '0', '0', '0', '0', '0', '0',
    '20', '0', '1', '0', String(start),
  ];
  assert.equal(fields[19], String(start));
  return `${pid} (runtime) ${fields.join(' ')}\n`;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(TEMP, prefix));
}

function removeTemp(dir) {
  if (!dir) return;
  const info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

const PRELUDE = `
import atexit, errno, json, os, signal, time
events = []
bound = {}
real_readlink = os.readlink

def dump():
    target = os.environ.get('ELASTOS_STOP_EVENTS')
    if not target:
        return
    text = json.dumps(events).encode('utf-8')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text)
    finally:
        os.close(fd)

def note(event):
    events.append(event)
    dump()

atexit.register(dump)

def sig_name(value):
    for name in ('SIGTERM', 'SIGKILL'):
        number = getattr(signal, name, None)
        if number is not None and int(number) == int(value):
            return name
    return str(int(value))

def stat_path():
    return os.environ.get('ELASTOS_STOP_STAT') or ''

def birth_of(text):
    end = text.rfind(')')
    parts = text[end + 1:].split()
    return parts[19]

def rewrite(birth):
    target = stat_path()
    raw = open(target).read()
    end = raw.rfind(')')
    parts = raw[end + 1:].split()
    parts[19] = str(birth)
    body = raw[:end + 1] + ' ' + ' '.join(parts) + '\\n'
    fd = os.open(target, os.O_WRONLY | os.O_TRUNC)
    try:
        os.write(fd, body.encode('utf-8'))
    finally:
        os.close(fd)

def current_exe():
    target = stat_path()
    if not target:
        return None
    return os.path.realpath(real_readlink(target[:-len('/stat')] + '/exe'))

def readlink(path):
    result = real_readlink(path)
    if os.environ.get('ELASTOS_STOP_RACE') == 'after-exe' and path.endswith('/exe'):
        rewrite(999)
    return result

os.readlink = readlink

def pidfd_open(pid, flags=0):
    if os.environ.get('ELASTOS_STOP_RACE') == 'before-open':
        rewrite(999)
    birth = None
    exe = None
    if stat_path():
        birth = birth_of(open(stat_path()).read())
        exe = current_exe()
    bound.clear()
    bound.update({'fd': 42, 'pid': int(pid), 'birth': birth, 'exe': exe})
    note({'api': 'pidfd_open', 'pid': int(pid), 'birth': birth})
    return 42

def pidfd_send_signal(fd, sig, siginfo=None, flags=0):
    fault = os.environ.get('ELASTOS_STOP_FAULT') or ''
    if fault == 'timeout':
        time.sleep(30)
    birth = birth_of(open(stat_path()).read()) if stat_path() else None
    exe = current_exe()
    note({'api': 'pidfd_send_signal', 'fd': int(fd), 'sig': sig_name(sig), 'birth': birth})
    if fault == 'eperm':
        raise OSError(errno.EPERM, 'eperm')
    if (not bound) or int(fd) != bound.get('fd') or birth != bound.get('birth') or exe != bound.get('exe'):
        raise OSError(errno.ESRCH, 'esrch')
    note({'api': 'delivered', 'fd': int(fd), 'pid': bound.get('pid'), 'sig': sig_name(sig), 'birth': bound.get('birth')})

def kill(pid, sig):
    note({'api': 'kill', 'pid': int(pid), 'sig': sig_name(sig)})

os.pidfd_open = pidfd_open
os.kill = kill
signal.pidfd_send_signal = pidfd_send_signal
`.trim();

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function signalsOf(events) {
  return events.filter((event) => event.api === 'kill' || event.api === 'delivered' || event.api === 'pidfd_send_signal');
}

function runRaw(helper, name, pid) {
  const dir = makeTemp('elastos-stop-raw-');
  const events = path.join(dir, 'events.json');
  try {
    const result = spawnSync('python3', ['-c', `${PRELUDE}\n${helper}`, name, pid], {
      encoding: 'utf8',
      env: { ...process.env, ELASTOS_STOP_EVENTS: events, ELASTOS_STOP_RACE: '', ELASTOS_STOP_STAT: '' },
      timeout: 5000,
    });
    assert.equal(result.error, undefined, result.error && result.error.message);
    return { status: result.status, stderr: result.stderr, events: readEvents(events) };
  } finally {
    removeTemp(dir);
  }
}

function writeHome(root, options = {}) {
  const birth = options.birth ?? 100;
  const data = path.join(root, 'root', '.local', 'share', 'elastos');
  const controller = path.join(data, 'update-controller');
  fs.mkdirSync(controller, { recursive: true });
  fs.mkdirSync(path.join(root, 'root', '.local', 'bin'), { recursive: true });
  const runtime = path.join(controller, 'runtime');
  fs.writeFileSync(runtime, 'runtime-binary');
  fs.writeFileSync(path.join(root, 'root', '.local', 'bin', 'elastos'), 'elastos-binary');
  fs.writeFileSync(path.join(data, 'host-process.lock'), JSON.stringify({
    pid: 7,
    role: 'gateway',
    addr: 'localhost:8090',
    generation: options.generation ?? 'abc',
  }));
  if (options.status !== false) {
    fs.writeFileSync(path.join(controller, 'status.json'), JSON.stringify({
      phase: 'ready',
      controller_pid: 4,
      controller_start: options.start ?? 'linux:boot-1:100',
      host_pid: 7,
      generation: options.generation ?? 'abc',
    }));
  }
  const proc = path.join(root, 'proc', '4');
  fs.mkdirSync(proc, { recursive: true });
  fs.mkdirSync(path.join(root, 'proc', 'sys', 'kernel', 'random'), { recursive: true });
  const stat = path.join(proc, 'stat');
  fs.writeFileSync(stat, procStat(4, 1, birth));
  fs.symlinkSync(runtime, path.join(proc, 'exe'));
  fs.writeFileSync(path.join(root, 'proc', 'sys', 'kernel', 'random', 'boot_id'), 'boot-1\n');
  return stat;
}

function waitFile(file, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\n')) return text.split(/\r?\n/, 1)[0].trim();
    }
    if (!child.pid) return null;
    try {
      process.kill(child.pid, 0);
    } catch (err) {
      if (err && err.code === 'ESRCH') {
        if (!fs.existsSync(file)) return null;
        const text = fs.readFileSync(file, 'utf8');
        return text.includes('\n') ? text.split(/\r?\n/, 1)[0].trim() : null;
      }
    }
    Atomics.wait(pause, 0, 0, 20);
  }
  return null;
}

function runSession(helper, options) {
  const root = makeTemp('elastos-stop-root-');
  const channel = makeTemp('elastos-stop-chan-');
  const events = path.join(channel, 'events.json');
  const stderr = path.join(channel, 'stderr');
  const stat = writeHome(root, options.home || {});
  const errFd = fs.openSync(stderr, 'w');
  const child = spawn('python3', ['-c', `${PRELUDE}\n${helper}`, root, channel], {
    stdio: ['ignore', 'ignore', errFd],
    env: {
      ...process.env,
      ELASTOS_STOP_EVENTS: events,
      ELASTOS_STOP_RACE: options.race || '',
      ELASTOS_STOP_STAT: stat,
    },
  });
  fs.closeSync(errFd);
  try {
    const first = waitFile(path.join(channel, 'reply-0'), child, 3000);
    const replies = [first];
    if (first === 'ready') {
      (options.commands || []).forEach((command, index) => {
        const seq = index + 1;
        const tmp = path.join(channel, `cmd-${seq}.tmp`);
        fs.writeFileSync(tmp, `${command}\n`);
        fs.renameSync(tmp, path.join(channel, `cmd-${seq}`));
        replies.push(waitFile(path.join(channel, `reply-${seq}`), child, 3000));
      });
    }
    return {
      replies,
      events: readEvents(events),
      stderr: fs.readFileSync(stderr, 'utf8'),
    };
  } finally {
    if (child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (err) {
        if (!err || err.code !== 'ESRCH') throw err;
      }
    }
    removeTemp(root);
    removeTemp(channel);
  }
}

test('a raw pid and a host pid receive no signal', () => {
  python();
  const seen = [];
  for (const [name, pid] of [['TERM', '4'], ['KILL', '4'], ['KILL', '7']]) {
    const result = runRaw(STOP_HELPER, name, pid);
    seen.push([name, pid, signalsOf(result.events)]);
  }
  assert.deepEqual(seen.map((row) => row[2]), [[], [], []], JSON.stringify(seen));
  assert.equal(STOP_HELPER.includes('os.kill'), false);
});

test('Stop signals only the confirmed controller through one pidfd', () => {
  python();
  const result = runSession(STOP_HELPER, { commands: ['TERM', 'KILL', 'close'] });
  assert.equal(result.replies[0], 'ready', result.stderr);
  assert.deepEqual(result.replies.slice(1), ['sent', 'sent', 'closed'], result.stderr);
  const opens = result.events.filter((event) => event.api === 'pidfd_open');
  assert.deepEqual(opens, [{ api: 'pidfd_open', pid: 4, birth: '100' }]);
  assert.deepEqual(
    result.events.filter((event) => event.api === 'delivered'),
    [
      { api: 'delivered', fd: 42, pid: 4, sig: 'SIGTERM', birth: '100' },
      { api: 'delivered', fd: 42, pid: 4, sig: 'SIGKILL', birth: '100' },
    ],
  );
  assert.equal(result.events.some((event) => event.api === 'kill'), false);
  assert.equal(result.events.some((event) => event.pid === 7 || event.pid < 0), false);
});

test('a changed controller identity receives no signal', () => {
  python();
  const result = runSession(STOP_HELPER, { home: { birth: 999 }, commands: ['TERM'] });
  assert.equal(result.replies[0], HOME_UNCONFIRMED_MESSAGE, result.stderr);
  assert.deepEqual(result.events.filter((event) => event.api === 'pidfd_open'), [
    { api: 'pidfd_open', pid: 4, birth: '999' },
  ]);
  assert.equal(result.events.some((event) => event.api === 'delivered' || event.api === 'kill'), false);
  assert.equal(result.events.some((event) => event.pid === 7 || event.pid < 0), false);
});

test('missing controller proof sends nothing', () => {
  python();
  const result = runSession(STOP_HELPER, { home: { status: false }, commands: ['KILL'] });
  assert.equal(result.replies[0], HOME_UNCONFIRMED_MESSAGE, result.stderr);
  assert.deepEqual(result.events, []);
});

test('a pid replaced between the check and the signal is not signaled', () => {
  python();
  const result = runSession(STOP_HELPER, { race: 'after-exe', commands: ['TERM', 'close'] });
  assert.equal(result.replies[0], 'ready', result.stderr);
  assert.equal(result.replies[1], 'errno ESRCH', `${result.stderr} ${JSON.stringify(result.events)}`);
  assert.equal(result.events.filter((event) => event.api === 'pidfd_open').length, 1);
  assert.equal(result.events.some((event) => event.api === 'delivered' || event.api === 'kill'), false);
});

test('the launcher session reuses the pidfd for escalation', () => {
  python();
  assert.equal(typeof windowsRuntime.createDistroStopSession, 'function');
  const { createDistroStopSession } = windowsRuntime;
  const root = makeTemp('elastos-stop-session-');
  const stat = writeHome(root);
  let channel = '';
  const session = createDistroStopSession({
    root,
    spawn(args) {
      assert.equal(args[0], 'python3');
      assert.equal(args[1], '-c');
      assert.equal(args[2], STOP_HELPER);
      assert.equal(args[3], root);
      channel = args[4];
      return spawn('python3', ['-c', `${PRELUDE}\n${args[2]}`, args[3], args[4]], {
        stdio: 'ignore',
        env: {
          ...process.env,
          ELASTOS_STOP_EVENTS: path.join(args[4], 'events.json'),
          ELASTOS_STOP_RACE: '',
          ELASTOS_STOP_STAT: stat,
        },
      });
    },
  });
  try {
    session.signal('TERM');
    session.signal('KILL');
    const events = readEvents(path.join(channel, 'events.json'));
    assert.equal(events.filter((event) => event.api === 'pidfd_open').length, 1);
    assert.deepEqual(
      events.filter((event) => event.api === 'delivered').map((event) => event.sig),
      ['SIGTERM', 'SIGKILL'],
    );
    assert.equal(events.some((event) => event.api === 'kill' || event.pid === 7 || event.pid < 0), false);
  } finally {
    session.close();
    removeTemp(root);
  }
});

function runFacts(root) {
  return spawnSync('python3', ['-c', FACTS_HELPER, root], { encoding: 'utf8', timeout: 5000 });
}

test('facts helper keeps a small lock and drops an oversized or linked lock', () => {
  python();
  const root = makeTemp('elastos-facts-');
  const dir = path.join(root, 'root', '.local', 'share', 'elastos');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'host-process.lock');
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: 7, marker: 'small-lock-marker' }));
    const small = runFacts(root);
    assert.equal(small.status, 0, small.stderr);
    assert.equal(JSON.parse(small.stdout).lock.includes('small-lock-marker'), true);

    fs.writeFileSync(lock, `OVERSIZE-MARKER${'x'.repeat(20_000)}`);
    const oversized = runFacts(root);
    assert.equal(oversized.status, 0, oversized.stderr);
    assert.equal(oversized.stdout.includes('OVERSIZE-MARKER'), false);
    assert.equal(JSON.parse(oversized.stdout).lock, null);

    fs.rmSync(lock);
    fs.writeFileSync(path.join(dir, 'real-lock'), 'LINK-MARKER');
    fs.symlinkSync(path.join(dir, 'real-lock'), lock);
    const linked = runFacts(root);
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(linked.stdout.includes('LINK-MARKER'), false);
    assert.equal(JSON.parse(linked.stdout).lock, null);
  } finally {
    removeTemp(root);
  }
});

test('Stop channel removal does not follow a symlink', () => {
  python();
  const root = makeTemp('elastos-stop-root-');
  const secretDir = path.join(root, 'secret-dir');
  fs.mkdirSync(secretDir);
  const secret = path.join(secretDir, 'secret');
  fs.writeFileSync(secret, 'SECRET');
  const stat = writeHome(root, {});
  function openSession(onSpawn) {
    return windowsRuntime.createDistroStopSession({
      root,
      spawn(args) {
        const channel = args[4];
        if (onSpawn) onSpawn(channel);
        return spawn('python3', ['-c', `${PRELUDE}\n${args[2]}`, args[3], args[4]], {
          stdio: 'ignore',
          env: {
            ...process.env,
            ELASTOS_STOP_EVENTS: path.join(channel, 'events.json'),
            ELASTOS_STOP_RACE: '',
            ELASTOS_STOP_STAT: stat,
          },
        });
      },
    });
  }
  const linked = openSession((channel) => {
    fs.symlinkSync(secret, path.join(channel, 'linked-file'));
  });
  try {
    linked.signal('TERM');
    linked.close();
    assert.equal(fs.readFileSync(secret, 'utf8'), 'SECRET');
  } finally {
    linked.close();
  }
  let replacedPath = '';
  const replaced = openSession((channel) => {
    replacedPath = channel;
  });
  try {
    replaced.signal('TERM');
    const kept = `${replacedPath}-kept`;
    fs.renameSync(replacedPath, kept);
    fs.mkdirSync(replacedPath);
    fs.writeFileSync(path.join(replacedPath, 'marker'), 'KEEP');
    assert.throws(() => replaced.close(), new RegExp(HOME_UNCONFIRMED_MESSAGE));
    assert.equal(fs.readFileSync(secret, 'utf8'), 'SECRET');
    assert.equal(fs.readFileSync(path.join(replacedPath, 'marker'), 'utf8'), 'KEEP');
    removeTemp(replacedPath);
    removeTemp(kept);
  } finally {
    replaced.close();
    removeTemp(root);
  }
});

test('WSL output accumulation stops at the cap', () => {
  const chunks = [];
  let total = appendCappedOutput(chunks, 0, Buffer.alloc(WSL_OUTPUT_MAX + 32));
  assert.equal(total, WSL_OUTPUT_MAX);
  assert.equal(Buffer.concat(chunks).length, WSL_OUTPUT_MAX);
  total = appendCappedOutput(chunks, total, Buffer.from('more'));
  assert.equal(total, WSL_OUTPUT_MAX);
  assert.equal(Buffer.concat(chunks).length, WSL_OUTPUT_MAX);
});

function resourceCounts(tracked) {
  let helpers = 0;
  let pidfds = 0;
  for (const pid of tracked.pids) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err && err.code === 'ESRCH') continue;
    }
    helpers += 1;
    const events = readEvents(tracked.eventsByPid.get(pid));
    const opened = events.filter((event) => event.api === 'pidfd_open').length;
    const closed = events.filter((event) => event.api === 'pidfd_close').length;
    if (opened > closed) pidfds += opened - closed;
  }
  let channels = 0;
  for (const dir of tracked.channels) {
    try {
      const info = fs.lstatSync(dir);
      if (!info.isSymbolicLink() && info.isDirectory()) channels += 1;
    } catch {
      // already removed
    }
  }
  return { helpers, channels, pidfds };
}

function openedPidfds(tracked) {
  let count = 0;
  for (const file of tracked.eventFiles) {
    count += readEvents(file).filter((event) => event.api === 'pidfd_open').length;
  }
  return count;
}

async function waitForBaseline(tracked, before) {
  const deadline = Date.now() + 2000;
  let after = resourceCounts(tracked);
  while (Date.now() < deadline) {
    if (after.helpers === before.helpers && after.channels === before.channels && after.pidfds === before.pidfds) {
      return after;
    }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    after = resourceCounts(tracked);
  }
  return after;
}

function releaseTracked(tracked, root) {
  for (const pid of tracked.pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
  for (const dir of tracked.channels) {
    try {
      const info = fs.lstatSync(dir);
      if (!info.isSymbolicLink() && info.isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // already removed
    }
  }
  removeTemp(root);
}

async function withLeakSupervisor(fault, check) {
  python();
  const root = makeTemp('elastos-stop-leak-');
  const stat = writeHome(root);
  const tracked = {
    pids: [],
    channels: [],
    eventFiles: [],
    eventsByPid: new Map(),
  };
  let spawnCount = 0;
  const sup = createGatewaySupervisor({
    binary: '/root/.local/bin/elastos',
    args: ['home', '--browser'],
    adoptForControls: true,
    spawn() { throw new Error('a retained Home is not spawned'); },
    fetchHealth: async () => ({ status: 200, body: 'OK' }),
    adoptInstalled: () => windowsRuntime.adoptDistroGatewayProcess({
      readPid: () => 7,
      alive: () => true,
      root,
      spawn(args) {
        assert.equal(args[0], 'python3');
        assert.equal(args[1], '-c');
        assert.equal(args[2], STOP_HELPER);
        assert.equal(args[3], root);
        const channel = args[4];
        const events = path.join(root, `events-${spawnCount}.json`);
        spawnCount += 1;
        tracked.channels.push(channel);
        tracked.eventFiles.push(events);
        const child = spawn('python3', ['-c', `${PRELUDE}\n${args[2]}`, args[3], args[4]], {
          stdio: 'ignore',
          env: {
            ...process.env,
            ELASTOS_STOP_EVENTS: events,
            ELASTOS_STOP_FAULT: fault,
            ELASTOS_STOP_RACE: '',
            ELASTOS_STOP_STAT: stat,
          },
        });
        child.on('error', () => {});
        if (child.pid) {
          tracked.pids.push(child.pid);
          tracked.eventsByPid.set(child.pid, events);
        }
        return child;
      },
    }),
    now: () => Date.now(),
    sleep: async () => {},
    openUrl() {},
    log() {},
    graceMs: 30,
    pollMs: 10,
  });
  const before = resourceCounts(tracked);
  try {
    await check({ sup, tracked, before });
  } finally {
    releaseTracked(tracked, root);
  }
}

async function failStopTwice(fault) {
  await withLeakSupervisor(fault, async ({ sup, tracked, before }) => {
    await assert.rejects(() => sup.stop(), new RegExp(HOME_UNCONFIRMED_MESSAGE));
    await assert.rejects(() => sup.stop(), new RegExp(HOME_UNCONFIRMED_MESSAGE));
    assert.equal(sup.phase(), 'error');
    assert.equal(openedPidfds(tracked), 2);
    const after = await waitForBaseline(tracked, before);
    assert.deepEqual(after, before);
  });
}

test('repeated Stop after a send error returns helper, channel, and pidfd counts to baseline', async () => {
  await failStopTwice('eperm');
});

test('TERM and KILL during one Stop share one pidfd', async () => {
  await withLeakSupervisor('', async ({ sup, tracked, before }) => {
    await assert.rejects(() => sup.stop(), /ElastOS is still running/);
    assert.equal(openedPidfds(tracked), 1);
    const events = readEvents(tracked.eventFiles[0]);
    assert.deepEqual(
      events.filter((event) => event.api === 'delivered').map((event) => event.sig),
      ['SIGTERM', 'SIGKILL'],
    );
    const after = await waitForBaseline(tracked, before);
    assert.deepEqual(after, before);
  });
});

test('repeated Stop after a timeout returns helper, channel, and pidfd counts to baseline', { timeout: 60000 }, async () => {
  await failStopTwice('timeout');
});
