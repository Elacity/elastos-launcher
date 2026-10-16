const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HOME_URL,
  createGatewaySupervisor,
  isHealthOk,
  scrubRuntimeLog,
} = require('../dist/main/targets/runtimeGateway');
const { uninstallRuntime } = require('../dist/main/targets/runtimeUninstall');

function fakeProcess(pid) {
  const proc = {
    pid,
    listeners: [],
    exiters: [],
    onOutput(fn) { proc.listeners.push(fn); },
    onExit(fn) { proc.exiters.push(fn); },
    signal() {},
    emit(text) { for (const fn of proc.listeners) fn(text); },
    exit(code) { for (const fn of proc.exiters) fn(code); },
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
  assert.deepEqual(world.spawned[0][1], ['gateway', '--addr', '127.0.0.1:8090']);
  world.sup.openHome();
  assert.deepEqual(world.opened, [HOME_URL]);
});

test('a held host lock is already running and opens Home without a signal', async () => {
  const world = supervisor();
  world.setHealth(null);
  let asked = 0;
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
  }).start();
  assert.equal(await pending, 'already-running');
  assert.deepEqual(world.opened, [HOME_URL]);
});

test('exit 75 starts the gateway again', async () => {
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

test('stop sends SIGTERM and SIGKILL only after the grace period', async () => {
  let world;
  world = supervisor({
    onSignal(sig) {
      if (sig === 'SIGKILL') world.setHealth(null);
    },
  });
  await world.sup.start();
  await world.sup.stop();
  assert.deepEqual(world.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(world.sup.phase(), 'stopped');
});

test('stop does not kill a gateway this launcher did not start', async () => {
  const world = supervisor();
  world.setHealth({ status: 200, body: 'OK' });
  await assert.rejects(() => world.sup.stop(), /did not start it/);
  assert.deepEqual(world.signals, []);
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
    stop: async () => {},
    remove: (target) => removed.push(target),
  });
  assert.deepEqual(removed, [
    '/home/tester/.local/bin/elastos',
    '/home/tester/.local/share/elastos',
  ]);

  await assert.rejects(() => uninstallRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.pc2',
    stop: async () => {},
    remove: () => { throw new Error('should not remove'); },
  }), /not the ElastOS data directory|PC2 directory/);

  let stopped = false;
  await assert.rejects(() => uninstallRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/Library/Application Support/elastos',
    stop: async () => {
      stopped = true;
      throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
    },
    remove: () => { throw new Error('should not remove'); },
  }), /another window/);
  assert.equal(stopped, true);
});
