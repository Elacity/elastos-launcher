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
  healthListenInodes,
  pidOwnsSocketInodes,
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
  assert.deepEqual(world.spawned[0][1], ['gateway', '--addr', '127.0.0.1:8090']);
  world.sup.openHome();
  assert.deepEqual(world.opened, [HOME_URL]);
});

test('a held host lock opens Home only when the listener is the ElastOS gateway', async () => {
  const world = supervisor();
  world.setHealth(null);
  let asked = 0;
  const lock = JSON.stringify({ pid: 7, role: 'gateway', addr: '127.0.0.1:8090' });
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
      command: '/home/user/.local/bin/elastos gateway --addr 127.0.0.1:8090',
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
      lockText: JSON.stringify({ pid: 9, role: 'other', addr: '127.0.0.1:8090' }),
      command: 'python3 -m http.server 8090',
      pidAlive: () => true,
      ownsSocket: () => true,
    }),
  }).start(), /not the ElastOS gateway/);
  assert.deepEqual(impostor.opened, []);
  assert.equal(foreignListenerIsElastos({
    lockText: lock,
    command: '/home/user/.local/bin/elastos gateway --addr 127.0.0.1:8090',
    pidAlive: () => false,
    ownsSocket: () => true,
  }), false);
  assert.equal(foreignListenerIsElastos({
    lockText: lock,
    command: '/home/user/.local/bin/elastos gateway --addr 127.0.0.1:8090',
    pidAlive: () => true,
    ownsSocket: () => false,
  }), false);
});

test('the health socket inode must belong to the lock pid', () => {
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1F9A 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9999 1 0000000000000000 100 0 0 10 0',
  ].join('\n');
  const inodes = healthListenInodes(tcp);
  assert.deepEqual([...inodes], ['4242']);
  assert.equal(pidOwnsSocketInodes(['socket:[4242]', 'pipe:[1]'], inodes), true);
  assert.equal(pidOwnsSocketInodes(['socket:[9999]'], inodes), false);
  assert.equal(pidOwnsSocketInodes([], inodes), false);
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
