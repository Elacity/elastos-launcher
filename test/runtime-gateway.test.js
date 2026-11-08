const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  HOME_URL,
  binaryReplacement,
  createGatewaySupervisor,
  controllerGateway,
  confirmedControllerPid,
  signalRecordedController,
  openLinuxPidfd,
  signalProcessGroup,
  isHealthOk,
  scrubRuntimeLog,
  launcherLogText,
  homeLaunchForPlatform,
  spawnGatewayProcess,
  ForeignGatewayError,
  foreignListenerIsElastos,
  installedGatewayKind,
  FOREIGN_LISTENER_MESSAGE,
  LEGACY_STILL_RUNNING_MESSAGE,
  HOME_UNCONFIRMED_MESSAGE,
  OTHER_HOME_MESSAGE,
  linuxControllerAdopt,
  combineHealth,
  listenerOwnership,
  localhostIsLoopback,
  parseLsofListeners,
  pidOwnsGatewayPort,
  probeGatewayHealth,
  procListenersFor,
  procNetAddress,
  procNetListeners,
  procStatParent,
  listenersFromProcSnapshot,
  linuxProcessIdentity,
  linuxStatStartTicks,
  proveLinuxHome,
  linuxControllerSignalPid,
  platformAdoptsInstalledHome,
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

function procStat(pid, ppid, start) {
  const fields = ['S', String(ppid), ...Array(17).fill('0'), String(start)];
  return `${pid} (elastos) ${fields.join(' ')}`;
}

test('a Home controller does not own a descendant socket', () => {
  const tcp = [TCP_HEADER, tcpRow('0100007F', 4242)].join('\n');
  const tcp6 = [TCP_HEADER, tcpRow(V6_LOOPBACK, 4343)].join('\n');
  const wants = ['127.0.0.1', '::1'];
  assert.deepEqual(procStatParent('20 (elastos home) S 10 9'), { pid: 20, ppid: 10 });
  assert.equal(procStatParent('no-paren'), null);
  assert.equal(linuxStatStartTicks(procStat(20, 10, 200)), '200');
  assert.equal(linuxStatStartTicks('20 (elastos home) S 10'), null);
  assert.equal(linuxProcessIdentity(procStat(10, 1, 100), 'boot-1'), 'linux:boot-1:100');
  const child = [
    { pid: 10, ppid: 1, fdLinks: ['pipe:[1]'] },
    { pid: 20, ppid: 10, fdLinks: ['socket:[4242]', 'socket:[4343]'] },
  ];
  assert.equal(listenerOwnership(listenersFromProcSnapshot(tcp, tcp6, 10, child), wants), 'foreign');
  const host = [{ pid: 20, ppid: 10, fdLinks: ['socket:[4242]', 'socket:[4343]'] }];
  assert.equal(listenerOwnership(listenersFromProcSnapshot(tcp, tcp6, 20, host), wants), 'owned');
  const stranger = [
    { pid: 10, ppid: 1, fdLinks: [] },
    { pid: 20, ppid: 10, fdLinks: ['socket:[4242]'] },
    { pid: 30, ppid: 1, fdLinks: ['socket:[4343]'] },
  ];
  assert.equal(listenerOwnership(listenersFromProcSnapshot(tcp, tcp6, 10, stranger), wants), 'foreign');
});

test('Linux Home ownership follows the controller record, not a descendant or a reused pid', () => {
  const tcp = [TCP_HEADER, tcpRow('0100007F', 4242)].join('\n');
  const tcp6 = [TCP_HEADER, tcpRow(V6_LOOPBACK, 4343)].join('\n');
  const bootId = 'boot-1';
  const statusText = JSON.stringify({
    phase: 'ready',
    controller_pid: 10,
    controller_start: 'linux:boot-1:100',
    host_pid: 20,
    generation: 'abc',
  });
  const lockText = JSON.stringify({
    pid: 20, role: 'gateway', addr: 'localhost:8090', generation: 'abc',
  });
  const proved = proveLinuxHome({
    statusText,
    lockText,
    bootId,
    controllerStat: procStat(10, 1, 100),
    hostStatBefore: procStat(20, 10, 200),
    hostFdLinks: ['socket:[4242]', 'socket:[4343]'],
    hostStatAfter: procStat(20, 10, 200),
    tcp,
    tcp6,
  });
  assert.equal(proved && proved.controllerPid, 10);
  assert.equal(linuxControllerSignalPid(proved, 'linux:boot-1:100'), 10);
  assert.equal(linuxControllerSignalPid(proved, 'linux:boot-1:999'), null);
  assert.equal(linuxControllerSignalPid(proved, null), null);

  const descendant = proveLinuxHome({
    statusText,
    lockText,
    bootId,
    controllerStat: procStat(10, 1, 100),
    hostStatBefore: procStat(20, 10, 200),
    hostFdLinks: ['pipe:[1]'],
    hostStatAfter: procStat(20, 10, 200),
    tcp,
    tcp6,
  });
  assert.equal(descendant, null);

  const reused = proveLinuxHome({
    statusText,
    lockText,
    bootId,
    controllerStat: procStat(10, 1, 100),
    hostStatBefore: procStat(20, 10, 200),
    hostFdLinks: ['socket:[4242]', 'socket:[4343]'],
    hostStatAfter: procStat(20, 10, 300),
    tcp,
    tcp6,
  });
  assert.equal(reused, null);

  const stale = proveLinuxHome({
    statusText,
    lockText,
    bootId,
    controllerStat: procStat(10, 1, 50),
    hostStatBefore: procStat(20, 10, 200),
    hostFdLinks: ['socket:[4242]', 'socket:[4343]'],
    hostStatAfter: procStat(20, 10, 200),
    tcp,
    tcp6,
  });
  assert.equal(stale, null);

  const wrongRole = proveLinuxHome({
    statusText,
    lockText: JSON.stringify({ pid: 20, role: 'serve', addr: 'localhost:8090', generation: 'abc' }),
    bootId,
    controllerStat: procStat(10, 1, 100),
    hostStatBefore: procStat(20, 10, 200),
    hostFdLinks: ['socket:[4242]', 'socket:[4343]'],
    hostStatAfter: procStat(20, 10, 200),
    tcp,
    tcp6,
  });
  assert.equal(wrongRole, null);
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

test('the health probe returns when localhost lookup does not answer', { timeout: 2000 }, async () => {
  const health = await probeGatewayHealth({
    timeoutMs: 200,
    lookup: () => new Promise(() => {}),
  });
  assert.equal(health, null);
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

test('a gateway on 127.0.0.1:8090 is another Home and receives no signal', async () => {
  const legacyLock = JSON.stringify({ pid: 7, role: 'gateway', addr: '127.0.0.1:8090' });
  const legacyFacts = {
    lockText: legacyLock,
    command: '/home/user/.local/bin/elastos gateway --addr 127.0.0.1:8090',
    pidAlive: () => true,
    ownsSocket: (_pid, wants) => wants.length === 1 && wants[0] === '127.0.0.1',
  };
  assert.equal(installedGatewayKind(legacyFacts), 'legacy');
  assert.equal(foreignListenerIsElastos(legacyFacts), false);
  assert.equal(installedGatewayKind({ ...legacyFacts, lockText: JSON.stringify({ pid: 7, addr: '0.0.0.0:8090' }) }), null);
  assert.equal(installedGatewayKind({ ...legacyFacts, ownsSocket: () => false }), null);

  const spawned = [];
  const opened = [];
  const signals = [];
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos',
    spawn(_binary, args) {
      spawned.push([...args]);
      const proc = fakeProcess(50);
      queueMicrotask(() => {
        proc.emit('another ElastOS host already owns this data directory\n');
        proc.exit(1);
      });
      return proc;
    },
    fetchHealth: async () => ({ status: 200, body: 'OK', addresses: ['127.0.0.1'] }),
    sleep: async () => {},
    now: () => 0,
    openUrl: (url) => opened.push(url),
    log: () => {},
    confirmForeign: async () => foreignListenerIsElastos(legacyFacts),
    reportLegacyHome: async () => installedGatewayKind(legacyFacts) === 'legacy',
    adoptInstalled: () => {
      signals.push('adopt');
      return {
        pid: 7,
        onOutput() {},
        onExit() {},
        hasExited: () => false,
        signal(sig) { signals.push(sig); },
      };
    },
  });
  await assert.rejects(() => sup.start(), (err) => err.message === OTHER_HOME_MESSAGE);
  assert.deepEqual(signals, []);
  assert.deepEqual(opened, []);
  assert.deepEqual(spawned, [['gateway', '--addr', 'localhost:8090']]);
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
    spawn(_binary, args) {
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

test('a process this launcher spawned is signaled through its own handle', async () => {
  const proc = spawnGatewayProcess(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(child.pid));
    setInterval(() => {}, 1000);
  `], 'linux');
  let grandchild = 0;
  try {
    grandchild = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grandchild pid was not printed')), 3000);
      let buf = '';
      proc.onOutput((chunk) => {
        buf += chunk.toString();
        const line = buf.trim();
        if (/^\d+$/.test(line)) {
          clearTimeout(timer);
          resolve(Number(line));
        }
      });
    });
    proc.signal('SIGTERM');
    const leaderGone = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      proc.onExit(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.equal(leaderGone, true);
    process.kill(grandchild, 0);
  } finally {
    try { if (grandchild) process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ }
    try { proc.signal('SIGKILL'); } catch { /* already gone */ }
  }
});

function controllerView(overrides = {}) {
  return {
    statusText: JSON.stringify({
      phase: 'ready',
      controller_pid: 10,
      controller_start: 'linux:boot-1:100',
      host_pid: 20,
      generation: 'abc',
    }),
    lockText: JSON.stringify({
      pid: 20, role: 'gateway', addr: 'localhost:8090', generation: 'abc',
    }),
    bootId: 'boot-1',
    controllerStat: procStat(10, 1, 100),
    exePath: '/home/user/.local/share/elastos/update-controller/runtime',
    allowedExes: [
      '/home/user/.local/bin/elastos',
      '/home/user/.local/share/elastos/update-controller/runtime',
    ],
    ...overrides,
  };
}

const RUNTIME_EXE = '/home/user/.local/share/elastos/update-controller/runtime';

function signalIo(observed, delivered) {
  return {
    readRecord: () => observed,
    readProc: () => ({ controllerStat: observed.controllerStat, exePath: observed.exePath }),
    openPidfd(pid) {
      return {
        send(signal) { delivered.push([pid, signal]); },
        close() {},
      };
    },
  };
}

function refusedSignal(observed) {
  const delivered = [];
  assert.equal(confirmedControllerPid(observed), null);
  assert.throws(
    () => signalRecordedController('SIGTERM', signalIo(observed, delivered), { pidfd: null }),
    { message: HOME_UNCONFIRMED_MESSAGE },
  );
  assert.deepEqual(delivered, []);
}

function errno(code) {
  return Object.assign(new Error(code), { code });
}

function controllerKernel(replaceOn) {
  let live = { birth: 100, exe: RUNTIME_EXE };
  const delivered = [];
  let opens = 0;
  const replace = () => { live = { birth: 999, exe: '/usr/bin/foreign' }; };
  return {
    delivered,
    opens: () => opens,
    replace,
    readRecord() {
      if (replaceOn === 'after-record') replace();
      return controllerView();
    },
    readProc(pid) {
      const statBirth = live.birth;
      if (replaceOn === 'during-proc') replace();
      const exe = live.exe;
      const snap = { controllerStat: procStat(pid, 1, statBirth), exePath: exe };
      if (replaceOn === 'after-proc') replace();
      return snap;
    },
    openPidfd(pid) {
      opens += 1;
      const bound = { pid, birth: live.birth, exe: live.exe };
      return {
        send(signal) {
          if (bound.birth !== live.birth || bound.exe !== live.exe) throw errno('ESRCH');
          delivered.push({ pid: bound.pid, signal, birth: live.birth, exe: live.exe });
        },
        close() {},
      };
    },
  };
}

function boundController(getView, onDelivered) {
  return controllerGateway(
    () => getView(),
    () => {
      const view = getView();
      return { controllerStat: view.controllerStat, exePath: view.exePath };
    },
    (pid) => {
      const bound = getView().controllerStat;
      return {
        send(signal) {
          if (getView().controllerStat !== bound) throw errno('ESRCH');
          onDelivered(pid, signal);
        },
        close() {},
      };
    },
  );
}

test('a controller pid reused before the first read is not signaled', () => {
  refusedSignal(controllerView({ controllerStat: procStat(10, 1, 999) }));
  refusedSignal(controllerView({ statusText: null }));
  refusedSignal(controllerView({ statusText: 'x'.repeat((16 * 1024) + 1) }));
  refusedSignal(controllerView({
    lockText: JSON.stringify({ pid: 20, role: 'gateway', addr: 'localhost:8090', generation: 'stale' }),
  }));
  refusedSignal(controllerView({ exePath: '/usr/bin/other' }));
  refusedSignal(controllerView({ exePath: '/home/user/.local/bin/elastos (deleted)' }));
  const installed = controllerView({ exePath: '/home/user/.local/bin/elastos' });
  assert.equal(confirmedControllerPid(installed), 10);
});

test('a controller pid reused between the check and the signal is not signaled', () => {
  let observed = controllerView();
  assert.equal(confirmedControllerPid(observed), 10);
  observed = controllerView({ controllerStat: procStat(10, 1, 999) });
  const kills = [];
  assert.throws(
    () => signalRecordedController('SIGKILL', signalIo(observed, kills), { pidfd: null }),
    { message: HOME_UNCONFIRMED_MESSAGE },
  );
  assert.deepEqual(kills, []);
  const host = [];
  signalRecordedController('SIGTERM', signalIo(controllerView(), host), { pidfd: null });
  assert.deepEqual(host, [[10, 'SIGTERM']]);
  assert.equal(host.some((row) => row[0] === 20 || row[0] < 0), false);
});

test('a controller replaced during the proc read is not signaled', () => {
  const kernel = controllerKernel('during-proc');
  assert.throws(
    () => signalRecordedController('SIGTERM', kernel, { pidfd: null }),
    { message: HOME_UNCONFIRMED_MESSAGE },
  );
  assert.deepEqual(kernel.delivered, []);
});

test('a controller replaced after the proc reads and before the signal is not signaled', () => {
  const kernel = controllerKernel('after-proc');
  signalRecordedController('SIGTERM', kernel, { pidfd: null });
  assert.deepEqual(kernel.delivered, []);
  assert.equal(kernel.opens(), 1);
});

test('a pid reused before pidfd_open fails the identity check', () => {
  const kernel = controllerKernel('after-record');
  assert.throws(
    () => signalRecordedController('SIGTERM', kernel, { pidfd: null }),
    { message: HOME_UNCONFIRMED_MESSAGE },
  );
  assert.deepEqual(kernel.delivered, []);
});

test('escalation sends SIGKILL through the pidfd opened for SIGTERM', () => {
  const kernel = controllerKernel();
  const gateway = controllerGateway(kernel.readRecord, kernel.readProc, kernel.openPidfd);
  gateway.signal('SIGTERM');
  gateway.signal('SIGKILL');
  assert.equal(kernel.opens(), 1);
  assert.deepEqual(kernel.delivered.map((row) => row.signal), ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(kernel.delivered.map((row) => row.birth), [100, 100]);
  assert.deepEqual(kernel.delivered.map((row) => row.exe), [RUNTIME_EXE, RUNTIME_EXE]);
});

test('escalation does not signal a pid reused after SIGTERM', () => {
  const kernel = controllerKernel();
  const gateway = controllerGateway(kernel.readRecord, kernel.readProc, kernel.openPidfd);
  gateway.signal('SIGTERM');
  kernel.replace();
  gateway.signal('SIGKILL');
  assert.equal(kernel.opens(), 1);
  assert.deepEqual(kernel.delivered, [{ pid: 10, signal: 'SIGTERM', birth: 100, exe: RUNTIME_EXE }]);
});

test('a missing pidfd does not signal the recorded pid', () => {
  const delivered = [];
  assert.throws(
    () => signalRecordedController('SIGTERM', {
      readRecord: () => controllerView(),
      readProc: () => ({ controllerStat: procStat(10, 1, 100), exePath: RUNTIME_EXE }),
      openPidfd() { throw errno('ENOSYS'); },
    }, { pidfd: null }),
    { message: HOME_UNCONFIRMED_MESSAGE },
  );
  assert.deepEqual(delivered, []);
  if (process.platform !== 'linux') {
    assert.throws(() => openLinuxPidfd(10), (err) => err.code === 'ENOSYS');
  }
});

test('the linux package unpacks the pidfd helper', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.build.asarUnpack.includes('dist/native/linux-pidfd'), true);
  assert.equal(pkg.scripts['build:ts'].includes('scripts/build-linux-pidfd.js'), true);
});

test('the pidfd helper command is the pid and two fifo paths', { timeout: 5000 }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pidfd-client-'));
  const log = path.join(dir, 'log');
  const helper = path.join(dir, 'helper');
  fs.writeFileSync(helper, `#!/bin/sh
printf '%s\\n' "$#" >> '${log}'
printf '%s\\n' "$1" >> '${log}'
exec 3>"$2"
printf '%s\\n' ready >&3
exec 4<"$3"
while IFS= read -r line <&4; do
  printf '%s\\n' "$line" >> '${log}'
  case $line in
    SIGTERM|SIGKILL) printf '%s\\n' sent >&3 ;;
    close) exit 0 ;;
    *) printf '%s\\n' 'errno EINVAL' >&3 ;;
  esac
done
`, { mode: 0o755 });
  const pidfd = openLinuxPidfd(10, { helper });
  try {
    pidfd.send('SIGTERM');
    pidfd.send('SIGKILL');
  } finally {
    pidfd.close();
  }
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.filter((line) => line !== 'close'), ['3', '10', 'SIGTERM', 'SIGKILL']);
  assert.equal(lines.every((line) => ['3', '10', 'SIGTERM', 'SIGKILL', 'close'].includes(line)), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

function pidfdResources(pidFile) {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '';
  const inodes = new Set();
  let helpers = 0;
  let dirs = 0;
  for (const line of text.split('\n')) {
    const [pidText, cmd] = line.split(' ');
    const pid = Number(pidText);
    if (!pid || !cmd) continue;
    try {
      process.kill(pid, 0);
      helpers += 1;
    } catch {
    }
    const fifoDir = path.dirname(cmd);
    if (fs.existsSync(fifoDir)) dirs += 1;
    for (const leaf of ['cmd', 'reply']) {
      try {
        const st = fs.statSync(path.join(fifoDir, leaf));
        inodes.add(`${st.dev}:${st.ino}`);
      } catch {
      }
    }
  }
  let fds = 0;
  for (const name of fs.readdirSync('/dev/fd')) {
    const fd = Number(name);
    if (!Number.isInteger(fd)) continue;
    try {
      const st = fs.fstatSync(fd);
      if (inodes.has(`${st.dev}:${st.ino}`)) fds += 1;
    } catch {
      // The fd closed while this scan was reading /dev/fd.
    }
  }
  return { helpers, dirs, fds };
}

function releasePidfdLeak(pidFile, scriptDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '';
  for (const line of text.split('\n')) {
    const [pidText, cmd] = line.split(' ');
    const pid = Number(pidText);
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    if (!cmd) continue;
    fs.rmSync(path.dirname(cmd), { recursive: true, force: true });
  }
  fs.rmSync(scriptDir, { recursive: true, force: true });
}

function writePidfdHelper(mode) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pidfd-leak-'));
  const helper = path.join(dir, 'helper');
  const pidFile = path.join(dir, 'pids');
  const signalArm = mode === 'timeout'
    ? 'SIGTERM|SIGKILL) ;;'
    : "SIGTERM|SIGKILL) printf '%s\\n' 'errno EPERM' >&3 ;;";
  fs.writeFileSync(helper, `#!/bin/sh
printf '%s %s\\n' "$$" "$3" >> '${pidFile}'
exec 3>"$2"
printf '%s\\n' ready >&3
exec 4<"$3"
while IFS= read -r line <&4; do
  case $line in
    close) exit 0 ;;
    ${signalArm}
    *) printf '%s\\n' 'errno EINVAL' >&3 ;;
  esac
done
exit 0
`, { mode: 0o755 });
  return { helper, pidFile, dir };
}

async function failStopTwice(helper, pattern) {
  const sup = createGatewaySupervisor({
    binary: '/home/tester/.local/bin/elastos',
    args: ['home', '--browser'],
    adoptForControls: true,
    spawn() { throw new Error('a retained Home is not spawned'); },
    fetchHealth: async () => ({ status: 200, body: 'OK' }),
    adoptInstalled: () => controllerGateway(
      () => controllerView(),
      () => ({ controllerStat: procStat(10, 1, 100), exePath: RUNTIME_EXE }),
      (pid) => openLinuxPidfd(pid, { helper }),
    ),
    now: () => Date.now(),
    sleep: async () => {},
    openUrl() {},
    log() {},
    graceMs: 30,
    pollMs: 10,
  });
  await assert.rejects(() => sup.stop(), pattern);
  await assert.rejects(() => sup.stop(), pattern);
  assert.equal(sup.phase(), 'error');
}

async function waitForPidfdBaseline(pidFile, before) {
  const deadline = Date.now() + 1000;
  let after = pidfdResources(pidFile);
  while (Date.now() < deadline) {
    if (after.helpers === before.helpers && after.dirs === before.dirs && after.fds === before.fds) {
      return after;
    }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    after = pidfdResources(pidFile);
  }
  return after;
}

test('repeated Stop after a pidfd send error returns helper resources to baseline', { timeout: 10000 }, async () => {
  const { helper, pidFile, dir } = writePidfdHelper('eperm');
  const before = pidfdResources(pidFile);
  try {
    await failStopTwice(helper, /Could not signal ElastOS \(SIGTERM\): errno EPERM/);
    const after = await waitForPidfdBaseline(pidFile, before);
    assert.deepEqual(after, before);
  } finally {
    releasePidfdLeak(pidFile, dir);
  }
});

test('repeated Stop after a pidfd timeout returns helper resources to baseline', { timeout: 20000 }, async () => {
  const { helper, pidFile, dir } = writePidfdHelper('timeout');
  const before = pidfdResources(pidFile);
  try {
    await failStopTwice(helper, /Could not signal ElastOS \(SIGTERM\): pidfd helper timed out/);
    const after = await waitForPidfdBaseline(pidFile, before);
    assert.deepEqual(after, before);
  } finally {
    releasePidfdLeak(pidFile, dir);
  }
});

test('Quit and stop after a retained Home signals only the confirmed controller', async () => {
  let observed = controllerView();
  const kills = [];
  const adopted = boundController(() => observed, (pid, signal) => {
    kills.push([pid, signal]);
    if (signal === 'SIGTERM') observed = controllerView({ controllerStat: null });
  });
  let health = { status: 200, body: 'OK' };
  let clock = 0;
  const sup = createGatewaySupervisor({
    binary: '/home/tester/.local/bin/elastos',
    args: ['home', '--browser'],
    adoptForControls: true,
    spawn() { throw new Error('a retained Home is not spawned again'); },
    fetchHealth: async () => {
      if (kills.length > 0) health = null;
      return health;
    },
    adoptInstalled: async () => adopted,
    now: () => clock,
    sleep: async () => { clock += 1000; },
    openUrl() {},
    log() {},
    graceMs: 3000,
    pollMs: 1000,
  });
  await sup.stop();
  assert.deepEqual(kills, [[10, 'SIGTERM']]);
  assert.equal(sup.phase(), 'stopped');
  sup.forceKill();
  assert.deepEqual(kills, [[10, 'SIGTERM']]);

  observed = controllerView();
  const later = [];
  const again = boundController(() => observed, (pid, signal) => later.push([pid, signal]));
  again.signal('SIGTERM');
  observed = controllerView({ controllerStat: procStat(10, 1, 999) });
  again.signal('SIGKILL');
  assert.deepEqual(later, [[10, 'SIGTERM']]);
});

test('a legacy 127.0.0.1 gateway is not a controller the launcher can signal', () => {
  const legacy = JSON.stringify({ pid: 7, role: 'gateway', addr: '127.0.0.1:8090', generation: 'abc' });
  assert.equal(linuxControllerAdopt(legacy), 'other-home');
  assert.equal(linuxControllerAdopt(JSON.stringify({
    pid: 7, role: 'gateway', addr: 'localhost:8090', generation: 'abc',
  })), 'controller');
  assert.equal(linuxControllerAdopt(null), 'none');
  refusedSignal(controllerView({ lockText: legacy }));
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
  const keep = 'Keep this terminal open. Press Ctrl+C to stop Home.\nwas replaced on disk\n';
  assert.equal(launcherLogText(keep, true).includes('Keep this terminal open'), false);
  assert.match(launcherLogText(keep, true), /was replaced on disk/);
  assert.match(launcherLogText(keep, false), /Keep this terminal open/);
  assert.deepEqual(homeLaunchForPlatform('linux').args, ['home', '--browser']);
  assert.equal(homeLaunchForPlatform('linux').quitWhenLastWindowCloses, false);
  assert.equal(homeLaunchForPlatform('linux').updateRestartsHome, true);
  assert.equal(homeLaunchForPlatform('linux').rollbackRestartsHome, true);
  assert.equal(homeLaunchForPlatform('linux').hideTerminalKeepLine, true);
  assert.equal(homeLaunchForPlatform('linux').openBrowserAfterInstall, false);
  assert.equal(homeLaunchForPlatform('linux').offerKeepHomeOnQuit, true);
  assert.equal(platformAdoptsInstalledHome('linux'), true);
  assert.equal(platformAdoptsInstalledHome('darwin'), true);
  assert.equal(platformAdoptsInstalledHome('win32'), false);
  assert.deepEqual(homeLaunchForPlatform('darwin').args, ['home', '--browser']);
  assert.equal(homeLaunchForPlatform('darwin').quitWhenLastWindowCloses, false);
  assert.equal(homeLaunchForPlatform('darwin').updateRestartsHome, true);
  assert.equal(homeLaunchForPlatform('darwin').rollbackRestartsHome, true);
  assert.equal(homeLaunchForPlatform('darwin').hideTerminalKeepLine, false);
  assert.equal(homeLaunchForPlatform('darwin').openBrowserAfterInstall, true);
  assert.equal(homeLaunchForPlatform('darwin').offerKeepHomeOnQuit, false);
  assert.deepEqual(homeLaunchForPlatform('win32').args, ['gateway', '--addr', 'localhost:8090']);
  assert.equal(homeLaunchForPlatform('win32').quitWhenLastWindowCloses, true);
  assert.equal(homeLaunchForPlatform('win32').updateRestartsHome, false);
  assert.equal(homeLaunchForPlatform('win32').openBrowserAfterInstall, true);
  assert.equal(homeLaunchForPlatform('win32').offerKeepHomeOnQuit, false);
});

test('a Linux supervisor log drops the terminal sentence and keeps the other lines', async () => {
  const launch = homeLaunchForPlatform('linux');
  let proc;
  const logs = [];
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos',
    args: launch.args,
    hideTerminalKeepLine: launch.hideTerminalKeepLine,
    spawn() {
      proc = fakeProcess(11);
      return proc;
    },
    fetchHealth: async () => {
      proc.emit('Keep this terminal open. Press Ctrl+C to stop Home.\nHome: http://localhost:8090/home/\n');
      return { status: 200, body: 'OK' };
    },
    sleep: async () => {},
    now: () => 0,
    openUrl() {},
    log: (line) => logs.push(line),
    listenerOwned: () => true,
  });
  await sup.start();
  const text = logs.join('\n');
  assert.equal(text.includes('Keep this terminal open'), false);
  assert.match(text, /Home: http:\/\/localhost:8090\/home\//);
});

test('uninstall removes only the runtime binary and data dir', async () => {
  const home = require('node:path').join(require('node:fs').realpathSync(require('node:os').tmpdir()), 'fixture-home');
  const removed = [];
  await uninstallRuntime({
    binary: `${home}/.local/bin/elastos`,
    dataDir: `${home}/.local/share/elastos`,
    homeDir: `${home}`,
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove: (target) => removed.push(target),
  });
  assert.deepEqual(removed, [
    `${home}/.local/bin/elastos`,
    `${home}/.local/share/elastos`,
  ]);

  await assert.rejects(() => uninstallRuntime({
    binary: `${home}/.local/bin/elastos`,
    dataDir: `${home}/.other`,
    homeDir: `${home}`,
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove: () => { throw new Error('should not remove'); },
  }), /not the ElastOS data directory/);

  let stopped = false;
  await assert.rejects(() => uninstallRuntime({
    binary: `${home}/.local/bin/elastos`,
    dataDir: `${home}/Library/Application Support/elastos`,
    homeDir: `${home}`,
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

test('Mac controls adopt a proved Home and re-read its generation after a System update', async () => {
  let clock = 0;
  let healthy = true;
  let active = fakeProcess(71);
  const signals = [];
  const owned = (proc) => {
    proc.signal = (signal) => { signals.push([proc.pid, signal]); proc.exit(0); healthy = false; };
    return proc;
  };
  owned(active);
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos', args: ['home', '--browser'], adoptForControls: true,
    spawn() { throw new Error('Stop must adopt without spawning'); },
    fetchHealth: async () => healthy ? { status: 200, body: 'OK' } : null,
    adoptInstalled: async () => active,
    now: () => clock, sleep: async () => { clock += 1000; },
    openUrl() {}, log() {},
  });
  // The signed Home controller has replaced its old host with generation 72.
  active = owned(fakeProcess(72));
  await sup.stop();
  assert.deepEqual(signals, [[72, 'SIGTERM']]);
  assert.equal(sup.phase(), 'stopped');
  assert.equal(installedGatewayKind({
    lockText: JSON.stringify({ pid: 72, addr: 'localhost:8090' }),
    command: '/home/user/.local/bin/elastos home --browser',
    pidAlive: () => true, ownsSocket: () => true,
  }), 'current');
});

test('Mac adoption refuses an unproved listener without sending any signal', async () => {
  let attempts = 0;
  const sup = createGatewaySupervisor({
    binary: '/bin/elastos', adoptForControls: true,
    spawn() { throw new Error('must not spawn'); },
    fetchHealth: async () => ({ status: 200, body: 'OK' }),
    adoptInstalled: async () => { attempts++; return null; },
    now: () => 0, sleep: async () => {}, openUrl() {}, log() {},
  });
  await assert.rejects(() => sup.stop(), ForeignGatewayError);
  assert.equal(attempts, 3, 'unknown ownership is retried only a bounded number of times');
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

function compileObservedPidfd(dir, passthroughAlarm) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const helper = path.join(dir, 'linux-pidfd');
  const alarmLog = path.join(dir, 'alarm');
  const signalLog = path.join(dir, 'signals');
  const prctlLog = path.join(dir, 'prctl');
  const pidLog = path.join(dir, 'pid');
  const include = path.join(__dirname, 'native/include');
  const source = path.join(__dirname, '../src/native/linux-pidfd.c');
  const obs = path.join(__dirname, 'native/pidfd_obs.c');
  const quote = (file) => file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const compile = (args) => {
    const result = spawnSync('cc', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'cc failed');
    }
  };
  compile([
    '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-O2',
    '-I', include,
    '-Dalarm=pidfd_test_alarm',
    '-Dprctl=pidfd_test_prctl',
    '-Dsyscall=pidfd_test_syscall',
    '-c', source, '-o', path.join(dir, 'helper.o'),
  ]);
  compile([
    '-Wall', '-Wextra', '-Werror', '-O2',
    ...(passthroughAlarm ? ['-DPIDFD_PASSTHROUGH_ALARM'] : []),
    `-DPIDFD_ALARM_LOG="${quote(alarmLog)}"`,
    `-DPIDFD_SIGNAL_LOG="${quote(signalLog)}"`,
    `-DPIDFD_PRCTL_LOG="${quote(prctlLog)}"`,
    `-DPIDFD_PID_LOG="${quote(pidLog)}"`,
    '-c', obs, '-o', path.join(dir, 'obs.o'),
  ]);
  compile([path.join(dir, 'helper.o'), path.join(dir, 'obs.o'), '-o', helper]);
  return { helper, alarmLog, signalLog, prctlLog, pidLog };
}

function releaseObservedPidfd(dir, pidLog) {
  const fs = require('node:fs');
  const text = pidLog && fs.existsSync(pidLog) ? fs.readFileSync(pidLog, 'utf8') : '';
  for (const line of text.split('\n')) {
    const pid = Number(line);
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

test('Stop still sends SIGKILL on the same pidfd when health outlasts the idle alarm', { timeout: 10000 }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pidfd-idle-'));
  let built = null;
  let phase = 'adopt';
  let waited = false;
  let err = null;
  try {
    built = compileObservedPidfd(dir, false);
    const sup = createGatewaySupervisor({
      binary: '/home/tester/.local/bin/elastos',
      args: ['home', '--browser'],
      adoptForControls: true,
      spawn() { throw new Error('a retained Home is not spawned'); },
      fetchHealth: async () => {
        if (phase === 'wait' && !waited) {
          waited = true;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return { status: 200, body: 'OK' };
      },
      adoptInstalled: () => controllerGateway(
        () => controllerView(),
        () => ({ controllerStat: procStat(10, 1, 100), exePath: RUNTIME_EXE }),
        (pid) => {
          const pidfd = openLinuxPidfd(pid, { helper: built.helper });
          return {
            send(signal) {
              pidfd.send(signal);
              if (signal === 'SIGTERM') phase = 'wait';
            },
            close() { pidfd.close(); },
          };
        },
      ),
      now: () => Date.now(),
      sleep: async () => {},
      openUrl() {},
      log() {},
      graceMs: 30,
      pollMs: 1,
    });
    try {
      await sup.stop();
    } catch (caught) {
      err = caught;
    }
    assert.equal(fs.readFileSync(built.signalLog, 'utf8'), '15\n9\n');
    assert.equal(fs.readFileSync(built.alarmLog, 'utf8'), '2\n0\n');
    assert.equal(fs.readFileSync(built.prctlLog, 'utf8'), '1 9\n');
    assert.match(String(err && err.message), /still running/);
    const helperPid = Number(fs.readFileSync(built.pidLog, 'utf8'));
    let helperGone = false;
    for (let i = 0; i < 50; i += 1) {
      try {
        process.kill(helperPid, 0);
      } catch {
        helperGone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(helperGone, true);
  } finally {
    releaseObservedPidfd(dir, built && built.pidLog);
  }
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
    const gone = () => {
      try {
        process.kill(grandchild, 0);
        return false;
      } catch {
        return true;
      }
    };
    for (let waited = 0; waited < 5000 && !gone(); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.throws(() => process.kill(grandchild, 0));
  } finally {
    try { process.kill(-(child.pid), 'SIGKILL'); } catch { /* already gone */ }
  }
});
