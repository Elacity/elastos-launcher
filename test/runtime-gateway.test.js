const assert = require('node:assert/strict');
const test = require('node:test');

const { spawn } = require('node:child_process');
const {
  HOME_URL,
  binaryReplacement,
  createGatewaySupervisor,
  isHealthOk,
  scrubRuntimeLog,
  signalProcessGroup,
  ForeignGatewayError,
  foreignListenerIsElastos,
  installedGatewayKind,
  FOREIGN_LISTENER_MESSAGE,
  LEGACY_STILL_RUNNING_MESSAGE,
  combineHealth,
  listenerOwnership,
  localhostIsLoopback,
  parseLsofListeners,
  pidOwnsGatewayPort,
  probeGatewayHealth,
  procListenersFor,
  procNetAddress,
  procNetListeners,
} = require('../dist/main/targets/runtimeGateway');
const { uninstallRuntime } = require('../dist/main/targets/runtimeUninstall');

function fakeProcess(pid) {
  const proc = {
    pid,
    exited: false,
    listeners: [],
    exiters: [],
    onOutput(fn) { proc.listeners.push(fn); },
    onExit(fn) { proc.exiters.push(fn); },
    signal() {},
    hasExited() { return proc.exited; },
    emit(text) { for (const fn of proc.listeners) fn(text); },
    exit(code) {
      proc.exited = true;
      for (const fn of proc.exiters) fn(code);
    },
  };
  return proc;
}

function supervisor(options = {}) {
  const procs = [];
  const signals = [];
  const opened = [];
  const logs = [];
  const spawned = [];
  let health = { status: 200, body: 'OK' };
  let clock = 0;
  const sup = createGatewaySupervisor({
    binary: '/home/tester/.local/bin/elastos',
    spawn(binary, args) {
      spawned.push([binary, [...args]]);
      const proc = fakeProcess(400 + procs.length);
      proc.signal = (sig) => {
        signals.push(sig);
        if (options.onSignal) options.onSignal(sig, proc);
      };
      procs.push(proc);
      return proc;
    },
    fetchHealth: async () => health,
    sleep: async () => { clock += 1000; },
    now: () => clock,
    openUrl: (url) => opened.push(url),
    log: (line) => logs.push(line),
    graceMs: 3000,
    healthTimeoutMs: 5000,
    pollMs: 1000,
    maxRestarts: 1,
  });
  return {
    sup,
    procs,
    signals,
    opened,
    logs,
    spawned,
    setHealth(next) { health = next; },
  };
}

test('health is the exact OK body', () => {
  assert.equal(isHealthOk({ status: 200, body: 'OK' }), true);
  assert.equal(isHealthOk({ status: 200, body: 'OK\n' }), true);
  assert.equal(isHealthOk({ status: 200, body: 'ready' }), false);
  assert.equal(isHealthOk(null), false);
});

test('start spawns the gateway and becomes running when /healthz is OK', async () => {
  const world = supervisor();
  assert.equal(await world.sup.start(), 'started');
  assert.equal(world.sup.phase(), 'running');
  assert.deepEqual(world.spawned[0][1], ['gateway', '--addr', 'localhost:8090']);
  world.sup.openHome();
  assert.deepEqual(world.opened, [HOME_URL]);
  assert.equal(HOME_URL, 'http://localhost:8090/home/');
});

test('a held host lock opens Home only when the listener is the ElastOS gateway', async () => {
  const world = supervisor();
  world.setHealth(null);
  let asked = 0;
  const lock = JSON.stringify({ pid: 7, role: 'gateway', addr: 'localhost:8090' });
  const pending = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn() {
      const proc = fakeProcess(7);
      world.procs.push(proc);
      return proc;
    },
    fetchHealth: async () => {
      asked += 1;
      if (asked === 1) {
        world.procs[0].emit('another ElastOS host already owns this data directory\n');
        world.procs[0].exit(1);
        return null;
      }
      return { status: 200, body: 'OK' };
    },
    sleep: async () => {},
    now: () => 0,
    openUrl: (url) => world.opened.push(url),
    log: () => {},
    healthTimeoutMs: 5000,
    confirmForeign: async () => foreignListenerIsElastos({
      lockText: lock,
      command: '/home/user/.local/bin/elastos gateway --addr localhost:8090',
      pidAlive: (pid) => pid === 7,
      ownsSocket: (pid) => pid === 7,
    }),
  }).start();
  assert.equal(await pending, 'already-running');
  assert.deepEqual(world.opened, [HOME_URL]);

  const impostor = supervisor();
  impostor.setHealth(null);
  let polls = 0;
  await assert.rejects(() => createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn() {
      const proc = fakeProcess(9);
      impostor.procs.push(proc);
      return proc;
    },
    fetchHealth: async () => {
      polls += 1;
      if (polls === 1) {
        impostor.procs[0].emit('another ElastOS host already owns this data directory\n');
        impostor.procs[0].exit(1);
        return null;
      }
      return { status: 200, body: 'OK' };
    },
    sleep: async () => {},
    now: () => 0,
    openUrl: (url) => impostor.opened.push(url),
    log: () => {},
    healthTimeoutMs: 5000,
    confirmForeign: async () => foreignListenerIsElastos({
      lockText: JSON.stringify({ pid: 9, role: 'other', addr: 'localhost:8090' }),
      command: 'python3 -m http.server 8090',
      pidAlive: () => true,
      ownsSocket: () => true,
    }),
  }).start(), /not the ElastOS gateway/);
  assert.deepEqual(impostor.opened, []);
  assert.equal(foreignListenerIsElastos({
    lockText: lock,
    command: '/home/user/.local/bin/elastos gateway --addr localhost:8090',
    pidAlive: () => false,
    ownsSocket: () => true,
  }), false);
  assert.equal(foreignListenerIsElastos({
    lockText: lock,
    command: '/home/user/.local/bin/elastos gateway --addr localhost:8090',
    pidAlive: () => true,
    ownsSocket: () => false,
  }), false);
});

const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const tcpRow = (addr, inode, state = '0A') => `   0: ${addr}:1F9A 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
const V6_LOOPBACK = '00000000000000000000000001000000';
const V6_ANY = '00000000000000000000000000000000';

test('/proc/net addresses decode for IPv4, ::1, ::, and v4-mapped 127.0.0.1', () => {
  assert.equal(procNetAddress('0100007F'), '127.0.0.1');
  assert.equal(procNetAddress('00000000'), '0.0.0.0');
  assert.equal(procNetAddress(V6_LOOPBACK), '::1');
  assert.equal(procNetAddress(V6_ANY), '::');
  assert.equal(procNetAddress('0000000000000000FFFF00000100007F'), '::ffff:127.0.0.1');
  assert.equal(procNetAddress('zz'), null);
});

test('the gateway must own every localhost listener, on 127.0.0.1 and on ::1', () => {
  const tcp = [TCP_HEADER, tcpRow('0100007F', 4242), tcpRow('00000000', 9999, '01')].join('\n');
  const tcp6 = [TCP_HEADER, tcpRow(V6_LOOPBACK, 4343)].join('\n');
  assert.deepEqual(procNetListeners(tcp, tcp6), [
    { address: '127.0.0.1', inode: '4242' },
    { address: '::1', inode: '4343' },
  ]);
  const wants = ['127.0.0.1', '::1'];
  assert.equal(listenerOwnership(procListenersFor(tcp, tcp6, ['socket:[4242]', 'socket:[4343]', 'pipe:[1]']), wants), 'owned');
  // Tamper: another process holds ::1, where the browser can land for localhost.
  assert.equal(listenerOwnership(procListenersFor(tcp, tcp6, ['socket:[4242]']), wants), 'foreign');
  assert.equal(listenerOwnership(procListenersFor(tcp, tcp6, []), wants), 'foreign');
  // A wildcard listener of another process covers 127.0.0.1 too.
  const wild = [TCP_HEADER, tcpRow('0100007F', 4242), tcpRow('00000000', 5555)].join('\n');
  assert.equal(listenerOwnership(procListenersFor(wild, '', ['socket:[4242]']), wants), 'foreign');
  assert.equal(listenerOwnership(procListenersFor(TCP_HEADER, '', ['socket:[4242]']), wants), 'none');
  // A gateway that binds one family is enough when nothing else listens and nothing else answered.
  assert.equal(listenerOwnership(procListenersFor(tcp, '', ['socket:[4242]']), wants), 'owned');
  // An address that answered the probe but is not a socket of the pid is foreign
  // (macOS lsof cannot list another account's sockets).
  assert.equal(listenerOwnership(procListenersFor(tcp, '', ['socket:[4242]']), wants, ['127.0.0.1', '::1']), 'foreign');
  assert.equal(listenerOwnership(procListenersFor(tcp, tcp6, ['socket:[4242]', 'socket:[4343]']), wants, ['::1']), 'owned');
});

test('lsof listeners name the owner pid for IPv4, [::1], and *', () => {
  const out = ['p41', 'f7', 'n127.0.0.1:8090', 'f8', 'n[::1]:8090', 'p99', 'f3', 'n*:8090', 'p100', 'n127.0.0.1:9000'].join('\n');
  assert.deepEqual(parseLsofListeners(out, 41), [
    { address: '127.0.0.1', owned: true },
    { address: '::1', owned: true },
    { address: '*', owned: false },
  ]);
  assert.equal(listenerOwnership(parseLsofListeners(out, 41), ['127.0.0.1', '::1']), 'foreign');
  assert.equal(listenerOwnership(parseLsofListeners(out.split('\np99')[0], 41), ['127.0.0.1', '::1']), 'owned');
});

async function listenOn(host) {
  const net = require('node:net');
  const server = net.createServer();
  const ok = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen({ port: 0, host, ipv6Only: host.includes(':') }, () => resolve(true));
  });
  return ok ? server : null;
}

function selfFdLinks() {
  const fs = require('node:fs');
  return fs.readdirSync('/proc/self/fd').map((name) => {
    try { return fs.readlinkSync(`/proc/self/fd/${name}`); } catch { return ''; }
  });
}

function readNet(file) {
  try { return require('node:fs').readFileSync(file, 'utf8'); } catch { return ''; }
}

test('the Linux /proc reader sees a real 127.0.0.1 listener of this process', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  const server = await listenOn('127.0.0.1');
  try {
    const port = server.address().port;
    const listeners = procListenersFor(readNet('/proc/net/tcp'), readNet('/proc/net/tcp6'), selfFdLinks(), port);
    assert.deepEqual(listeners, [{ address: '127.0.0.1', owned: true }]);
    assert.equal(listenerOwnership(listeners, ['127.0.0.1', '::1'], ['127.0.0.1']), 'owned');
    // The same socket seen from a pid that does not hold it.
    assert.equal(listenerOwnership(procListenersFor(readNet('/proc/net/tcp'), '', [], port), ['127.0.0.1', '::1']), 'foreign');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the Linux /proc reader sees a real ::1 listener of this process', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  const server = await listenOn('::1');
  if (!server) return t.skip('this machine has no ::1');
  try {
    const port = server.address().port;
    const listeners = procListenersFor(readNet('/proc/net/tcp'), readNet('/proc/net/tcp6'), selfFdLinks(), port);
    assert.deepEqual(listeners, [{ address: '::1', owned: true }]);
    assert.equal(listenerOwnership(listeners, ['127.0.0.1', '::1'], ['::1']), 'owned');
    assert.equal(listenerOwnership(procListenersFor('', readNet('/proc/net/tcp6'), [], port), ['::1']), 'foreign');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('pidOwnsGatewayPort refuses when the listeners cannot be read', async () => {
  assert.equal(await pidOwnsGatewayPort(7, ['127.0.0.1', '::1'], [], async () => null), false);
  assert.equal(await pidOwnsGatewayPort(7, ['127.0.0.1', '::1'], [], async () => [{ address: '::1', owned: true }]), true);
});

test('the health probe asks every address localhost resolves to', async () => {
  const asked = [];
  const ok = { status: 200, body: 'OK' };
  const only6 = await probeGatewayHealth({
    lookup: async () => ['::1', '127.0.0.1'],
    get: async (address) => { asked.push(address); return address === '::1' ? ok : null; },
  });
  assert.deepEqual(asked.sort(), ['127.0.0.1', '::1']);
  assert.equal(isHealthOk(only6), true);
  assert.deepEqual(only6.addresses, ['::1']);
  const both = await probeGatewayHealth({ lookup: async () => ['127.0.0.1', '::1'], get: async () => ok });
  assert.deepEqual(both.addresses, ['127.0.0.1', '::1']);
  // Tamper: something else answers on one address. The browser can land there, so it is not OK.
  const mixed = await probeGatewayHealth({
    lookup: async () => ['::1', '127.0.0.1'],
    get: async (address) => (address === '::1' ? { status: 404, body: 'Not Found' } : ok),
  });
  assert.equal(isHealthOk(mixed), false);
  // Tamper: localhost points away from this computer. Nothing is asked.
  let called = false;
  assert.equal(await probeGatewayHealth({ lookup: async () => ['127.0.0.1', '10.0.0.5'], get: async () => { called = true; return ok; } }), null);
  assert.equal(called, false);
  assert.equal(await probeGatewayHealth({ lookup: async () => { throw new Error('ENOTFOUND'); } }), null);
  assert.equal(await probeGatewayHealth({ lookup: async () => [], get: async () => ok }), null);
  assert.equal(await probeGatewayHealth({ lookup: async () => ['127.0.0.1'], get: async () => null }), null);
  assert.equal(localhostIsLoopback(['127.0.0.1', '::1']), true);
  assert.equal(localhostIsLoopback(['127.0.1.1']), false);
  assert.equal(combineHealth([]), null);
});

test('an OK that the started gateway does not own never opens Home', async () => {
  const opened = [];
  let clock = 0;
  const owners = [];
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn: () => fakeProcess(41),
    fetchHealth: async () => ({ status: 200, body: 'OK', addresses: ['::1'] }),
    listenerOwned: (pid, health) => { owners.push([pid, health.addresses]); return false; },
    sleep: async () => { clock += 1000; },
    now: () => clock,
    openUrl: (url) => opened.push(url),
    log: () => {},
    healthTimeoutMs: 3000,
    pollMs: 1000,
  });
  await assert.rejects(() => sup.start(), (err) => err.message === FOREIGN_LISTENER_MESSAGE);
  assert.deepEqual(opened, []);
  assert.deepEqual(owners[0], [41, ['::1']]);
  assert.match(FOREIGN_LISTENER_MESSAGE, /localhost:8090/);

  const ready = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn: () => fakeProcess(42),
    fetchHealth: async () => ({ status: 200, body: 'OK', addresses: ['127.0.0.1'] }),
    listenerOwned: (pid) => pid === 42,
    sleep: async () => {},
    now: () => 0,
    openUrl: () => {},
    log: () => {},
  });
  assert.equal(await ready.start(), 'started');
});

test('upgrade: a gateway an earlier launcher started on 127.0.0.1 is stopped and started on localhost', async () => {
  const legacyLock = JSON.stringify({ pid: 7, role: 'gateway', addr: '127.0.0.1:8090' });
  const legacyFacts = {
    lockText: legacyLock,
    command: '/home/user/.local/bin/elastos gateway --addr 127.0.0.1:8090',
    pidAlive: () => true,
    ownsSocket: (_pid, wants) => wants.length === 1 && wants[0] === '127.0.0.1',
  };
  assert.equal(installedGatewayKind(legacyFacts), 'legacy');
  // Home never opens on the legacy gateway.
  assert.equal(foreignListenerIsElastos(legacyFacts), false);
  assert.equal(installedGatewayKind({ ...legacyFacts, lockText: JSON.stringify({ pid: 7, addr: '0.0.0.0:8090' }) }), null);
  assert.equal(installedGatewayKind({ ...legacyFacts, ownsSocket: () => false }), null);

  const spawned = [];
  const opened = [];
  const logs = [];
  let legacyRunning = true;
  const legacySignals = [];
  const legacy = {
    pid: 7,
    onOutput() {},
    onExit() {},
    hasExited: () => !legacyRunning,
    signal(sig) { legacySignals.push(sig); legacyRunning = false; },
  };
  let mine = null;
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn(binary, args) {
      spawned.push([...args]);
      const proc = fakeProcess(50 + spawned.length);
      if (legacyRunning) {
        queueMicrotask(() => {
          proc.emit('another ElastOS host already owns this data directory\n');
          proc.exit(1);
        });
      } else {
        mine = proc;
      }
      return proc;
    },
    fetchHealth: async () => (legacyRunning || mine ? { status: 200, body: 'OK', addresses: ['127.0.0.1'] } : null),
    sleep: async () => {},
    now: () => 0,
    openUrl: (url) => opened.push(url),
    log: (line) => logs.push(line),
    confirmForeign: async () => foreignListenerIsElastos(legacyFacts),
    foreignIsLegacy: async () => installedGatewayKind(legacyFacts) === 'legacy',
    adoptInstalled: () => legacy,
    listenerOwned: (pid) => Boolean(mine && pid === mine.pid),
  });
  assert.equal(await sup.start(), 'started');
  assert.deepEqual(legacySignals, ['SIGTERM']);
  assert.deepEqual(spawned, [['gateway', '--addr', 'localhost:8090'], ['gateway', '--addr', 'localhost:8090']]);
  assert.deepEqual(opened, []);
  assert.ok(logs.some((line) => /older ElastOS is running on 127\.0\.0\.1:8090/.test(line)));
  sup.openHome();
  assert.deepEqual(opened, ['http://localhost:8090/home/']);
});

test('upgrade: a legacy gateway that cannot be adopted is not opened and says so', async () => {
  const opened = [];
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn() {
      const proc = fakeProcess(60);
      queueMicrotask(() => {
        proc.emit('another ElastOS host already owns this data directory\n');
        proc.exit(1);
      });
      return proc;
    },
    fetchHealth: async () => ({ status: 200, body: 'OK' }),
    sleep: async () => {},
    now: () => 0,
    openUrl: (url) => opened.push(url),
    log: () => {},
    confirmForeign: async () => false,
    foreignIsLegacy: async () => true,
    adoptInstalled: () => null,
  });
  await assert.rejects(() => sup.start(), (err) => err.message === LEGACY_STILL_RUNNING_MESSAGE);
  assert.deepEqual(opened, []);
});

const REPLACED = 'host executable /bin/elastos was replaced on disk. Exiting stale host.\n';
const UNREADABLE = 'host executable path could not be read for /bin/elastos: os error. Exiting stale host.\n';
const REHASH = 'host executable /bin/elastos changed on disk and could not be re-verified: io error. Exiting stale host.\n';

test('exit 75 phrases distinguish a replaced binary from an unreadable path', () => {
  assert.equal(binaryReplacement(REPLACED, 75), true);
  assert.equal(binaryReplacement('host binary /bin/elastos changed on disk. Exiting stale host so the newer binary can take over.\n', 75), true);
  assert.equal(binaryReplacement(UNREADABLE, 75), false);
  assert.equal(binaryReplacement(REHASH, 75), false);
  assert.equal(binaryReplacement('host executable moved from /a to /b. Exiting stale host.\n', 75), false);
  assert.equal(binaryReplacement('host executable /bin/elastos could not be verified on disk: io error. Exiting stale host.\n', 75), false);
  assert.equal(binaryReplacement('', 75), false);
  assert.equal(binaryReplacement(REPLACED, 1), false);
});

test('exit 75 after the binary was replaced starts the gateway again', async () => {
  const world = supervisor();
  let polls = 0;
  const pending = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn() {
      const proc = fakeProcess(8 + world.procs.length);
      world.procs.push(proc);
      return proc;
    },
    fetchHealth: async () => {
      polls += 1;
      if (polls === 1) {
        world.procs[0].emit(REPLACED);
        world.procs[0].exit(75);
        return null;
      }
      return { status: 200, body: 'OK' };
    },
    sleep: async () => {},
    now: () => 0,
    openUrl: () => {},
    log: (line) => world.logs.push(line),
    maxRestarts: 1,
    healthTimeoutMs: 5000,
  }).start();
  assert.equal(await pending, 'started');
  assert.equal(world.procs.length, 2);
  assert.match(world.logs.join('\n'), /Starting it again/);
});

test('exit 75 when the path cannot be read does not start another gateway', async () => {
  const world = supervisor();
  const pending = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn() {
      const proc = fakeProcess(8 + world.procs.length);
      world.procs.push(proc);
      return proc;
    },
    fetchHealth: async () => {
      world.procs[0].emit(UNREADABLE);
      world.procs[0].exit(75);
      return null;
    },
    sleep: async () => {},
    now: () => 0,
    openUrl: () => {},
    log: (line) => world.logs.push(line),
    maxRestarts: 1,
    healthTimeoutMs: 5000,
  }).start();
  await assert.rejects(pending, /not started again/);
  assert.equal(world.procs.length, 1);
});

test('a running gateway does not restart when exit 75 is not a replaced binary', async () => {
  const world = supervisor();
  await world.sup.start();
  world.procs[0].emit(UNREADABLE);
  world.procs[0].exit(75);
  assert.equal(world.procs.length, 1);
  assert.equal(world.sup.phase(), 'error');
});

test('exit 75 with no replacement message does not start another gateway', async () => {
  const world = supervisor();
  const pending = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn() {
      const proc = fakeProcess(11);
      world.procs.push(proc);
      return proc;
    },
    fetchHealth: async () => {
      world.procs[0].exit(75);
      return null;
    },
    sleep: async () => {},
    now: () => 0,
    openUrl: () => {},
    log: () => {},
    maxRestarts: 1,
    healthTimeoutMs: 5000,
  }).start();
  await assert.rejects(pending, /not started again/);
  assert.equal(world.procs.length, 1);
});

test('a running gateway restarts once when the binary was replaced', async () => {
  const world = supervisor();
  await world.sup.start();
  world.procs[0].emit(REPLACED);
  world.procs[0].exit(75);
  assert.equal(world.procs.length, 2);
  assert.match(world.logs.join('\n'), /Starting it again/);
});

test('stop sends SIGTERM and SIGKILL only after the grace period', async () => {
  let world;
  world = supervisor({
    onSignal(sig, proc) {
      if (sig === 'SIGKILL') {
        world.setHealth(null);
        proc.exit(null);
      }
    },
  });
  await world.sup.start();
  await world.sup.stop();
  assert.deepEqual(world.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(world.sup.phase(), 'stopped');
});

test('stop returns once the process has exited and health has failed twice', async () => {
  const world = supervisor({
    onSignal(sig, proc) {
      if (sig === 'SIGTERM') {
        world.setHealth(null);
        proc.exit(0);
      }
    },
  });
  await world.sup.start();
  await world.sup.stop();
  assert.deepEqual(world.signals, ['SIGTERM']);
  assert.equal(world.sup.phase(), 'stopped');
});

test('one failed health poll while the process is alive is not a stop', async () => {
  const world = supervisor({
    onSignal() {
      world.setHealth(null);
    },
  });
  await world.sup.start();
  await assert.rejects(() => world.sup.stop(), /still running/);
  assert.equal(world.sup.phase(), 'error');
  assert.deepEqual(world.signals, ['SIGTERM', 'SIGKILL']);
});

test('signalProcessGroup uses the negative pid and surfaces a failed kill', () => {
  const seen = [];
  signalProcessGroup(42, 'SIGTERM', (pid, signal) => { seen.push([pid, signal]); });
  assert.deepEqual(seen, [[-42, 'SIGTERM']]);
  signalProcessGroup(0, 'SIGTERM', () => { throw new Error('pid 0 must not be signaled'); });
  signalProcessGroup(-5, 'SIGTERM', () => { throw new Error('a negative pid must not be signaled'); });
  signalProcessGroup(42, 'SIGTERM', () => {
    const err = new Error('gone');
    err.code = 'ESRCH';
    throw err;
  });
  assert.throws(
    () => signalProcessGroup(42, 'SIGKILL', () => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    }),
    /Could not signal ElastOS \(SIGKILL\): operation not permitted/,
  );
});

test('signalProcessGroup kills the leader and a child in that group', async () => {
  const child = spawn('bash', ['-c', 'sleep 30 & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const grandchild = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grandchild pid was not printed')), 3000);
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const line = buf.trim();
        if (/^\d+$/.test(line)) {
          clearTimeout(timer);
          resolve(Number(line));
        }
      });
    });
    signalProcessGroup(child.pid, 'SIGTERM');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('leader did not exit')), 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(grandchild, 0));
  } finally {
    try { process.kill(-(child.pid), 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('stop does not kill a gateway this launcher did not start', async () => {
  const world = supervisor();
  world.setHealth({ status: 200, body: 'OK' });
  await assert.rejects(() => world.sup.stop(), (err) => {
    assert.equal(err instanceof ForeignGatewayError, true);
    assert.equal(err.code, 'foreign-gateway');
    return true;
  });
  assert.deepEqual(world.signals, []);
});

test('stop adopts an installed gateway this window did not start', async () => {
  const signals = [];
  let health = { status: 200, body: 'OK' };
  let clock = 0;
  const adopted = fakeProcess(77);
  adopted.signal = (sig) => {
    signals.push(sig);
    if (sig === 'SIGTERM') {
      health = null;
      adopted.exit(0);
    }
  };
  let adoptedCalls = 0;
  const sup = createGatewaySupervisor({
    binary: '/home/tester/.local/bin/elastos',
    spawn() { throw new Error('must not spawn'); },
    fetchHealth: async () => health,
    sleep: async () => { clock += 1000; },
    now: () => clock,
    openUrl: () => {},
    log: () => {},
    graceMs: 3000,
    pollMs: 1000,
    confirmForeign: async () => true,
    adoptInstalled: () => {
      adoptedCalls += 1;
      return adopted;
    },
  });
  await assert.rejects(() => sup.stop(), (err) => err instanceof ForeignGatewayError);
  assert.equal(adoptedCalls, 0);
  assert.deepEqual(signals, []);
  await sup.stop({ adopt: true });
  assert.equal(adoptedCalls, 1);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(sup.phase(), 'stopped');

  const refused = [];
  const foreign = createGatewaySupervisor({
    binary: '/home/tester/.local/bin/elastos',
    spawn() { throw new Error('must not spawn'); },
    fetchHealth: async () => ({ status: 200, body: 'OK' }),
    sleep: async () => {},
    now: () => 0,
    openUrl: () => {},
    log: () => {},
    confirmForeign: async () => false,
    adoptInstalled: () => {
      refused.push('adopt');
      return null;
    },
  });
  await assert.rejects(() => foreign.stop({ adopt: true }), (err) => err instanceof ForeignGatewayError);
  assert.deepEqual(refused, ['adopt']);

  const adoptedAnyway = [];
  let openHealth = { status: 200, body: 'OK' };
  let openClock = 0;
  const opened = fakeProcess(91);
  opened.signal = (sig) => {
    adoptedAnyway.push(sig);
    if (sig === 'SIGTERM') {
      openHealth = null;
      opened.exit(0);
    }
  };
  const noConfirm = createGatewaySupervisor({
    binary: '/home/tester/.local/bin/elastos',
    spawn() { throw new Error('must not spawn'); },
    fetchHealth: async () => openHealth,
    sleep: async () => { openClock += 1000; },
    now: () => openClock,
    openUrl: () => {},
    log: () => {},
    graceMs: 3000,
    pollMs: 1000,
    adoptInstalled: () => {
      adoptedAnyway.push('adopt');
      return opened;
    },
  });
  await assert.rejects(() => noConfirm.stop(), (err) => err instanceof ForeignGatewayError);
  assert.deepEqual(adoptedAnyway, []);
  await noConfirm.stop({ adopt: true });
  assert.deepEqual(adoptedAnyway, ['adopt', 'SIGTERM']);
  assert.equal(noConfirm.phase(), 'stopped');
  foreign.forceKill();
  assert.deepEqual(signals, ['SIGTERM']);

  const alive = [];
  let aliveClock = 0;
  let aliveHealth = { status: 200, body: 'OK' };
  const still = fakeProcess(88);
  still.hasExited = () => false;
  still.signal = (sig) => {
    alive.push(sig);
    aliveHealth = null;
  };
  const hanging = createGatewaySupervisor({
    binary: '/home/tester/.local/bin/elastos',
    spawn() { throw new Error('must not spawn'); },
    fetchHealth: async () => aliveHealth,
    sleep: async () => { aliveClock += 1000; },
    now: () => aliveClock,
    openUrl: () => {},
    log: () => {},
    graceMs: 3000,
    pollMs: 1000,
    confirmForeign: async () => true,
    adoptInstalled: () => still,
  });
  await assert.rejects(() => hanging.stop({ adopt: true }), /still running/);
  assert.equal(hanging.phase(), 'error');
  assert.deepEqual(alive, ['SIGTERM', 'SIGKILL']);
  hanging.forceKill();
  assert.deepEqual(alive, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
});

test('logs omit attach secrets', async () => {
  const world = supervisor();
  let polls = 0;
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn() {
      const proc = fakeProcess(9);
      world.procs.push(proc);
      return proc;
    },
    fetchHealth: async () => {
      polls += 1;
      if (polls === 1) {
        world.procs[0].emit('wrote gateway-runtime-coords.json attach_secret=sekrit\n');
        return null;
      }
      return { status: 200, body: 'OK' };
    },
    sleep: async () => {},
    now: () => 0,
    openUrl: () => {},
    log: (line) => world.logs.push(line),
    healthTimeoutMs: 5000,
  });
  await sup.start();
  const text = sup.getLogs();
  assert.equal(text.includes('sekrit'), false);
  assert.match(text, /omitted a line/);
  assert.equal(scrubRuntimeLog('attach_secret=nope').includes('nope'), false);
});

test('uninstall removes only the runtime binary and data dir', async () => {
  const removed = [];
  await uninstallRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove: (target) => removed.push(target),
  });
  assert.deepEqual(removed, [
    '/home/tester/.local/bin/elastos',
    '/home/tester/.local/share/elastos',
  ]);

  await assert.rejects(() => uninstallRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.other',
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove: () => { throw new Error('should not remove'); },
  }), /not the ElastOS data directory/);

  let stopped = false;
  await assert.rejects(() => uninstallRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/Library/Application Support/elastos',
    homeDir: '/home/tester',
    platform: 'darwin',
    env: {},
    stop: async () => {
      stopped = true;
      throw new ForeignGatewayError();
    },
    remove: () => { throw new Error('should not remove'); },
  }), /another window/);
  assert.equal(stopped, true);
});

test('a local adopted gateway counts as exited only when the pid is gone', () => {
  const { localPidHasExited } = require('../dist/main/targets/runtimeGateway');
  const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(localPidHasExited(77, () => {}), false);
  assert.equal(localPidHasExited(77, fail('ESRCH')), true);
  // Alive under another account, or a probe that failed for another reason: still running.
  assert.equal(localPidHasExited(77, fail('EPERM')), false);
  assert.equal(localPidHasExited(77, fail('EINVAL')), false);
  assert.equal(localPidHasExited(77, () => { throw new Error('no code'); }), false);
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.equal(localPidHasExited(child.pid), false);
  } finally {
    child.kill('SIGKILL');
  }
});
