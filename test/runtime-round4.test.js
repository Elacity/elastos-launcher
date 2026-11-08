const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const gateway = require('../dist/main/targets/runtimeGateway');
const updates = require('../dist/main/targets/runtimeUpdate');
const targets = require('../dist/main/targets/runtimeTarget');
const fixture = require('./helpers/signed-release');
const { releaseHeadCid } = require('../dist/main/targets/releaseHead');

for (const minimumVersion of [undefined, '2.0.0', '2.1.0']) {
  test(`rollback and update reject a signed head below floor ${minimumVersion ?? 'default'} before mutation`, async () => {
    const raw = fixture.signedHead({ version: minimumVersion === '2.1.0' ? '2.0.0' : '1.9.9' });
    const cid = releaseHeadCid(raw);
    const calls = [];
    const store = { get: () => cid, set: () => calls.push('store') };
    const verify = { maintainerDid: fixture.FIXTURE_DID, publisherGateway: 'https://publisher.example',
      minimumVersion, fetchText: async () => raw };
    const run = async (args) => { calls.push(args); return { code: 0, stdout: `Head CID: ${cid}`, stderr: '' }; };
    await assert.rejects(() => updates.rollbackRuntime(run, store, verify), /minimum|floor|version/i);
    assert.deepEqual(calls, [], 'restore must not call Runtime');
    await assert.rejects(() => updates.applyRuntimeUpdate(run, store, verify), /minimum|floor|version/i);
    assert.deepEqual(calls, [['source', 'show']], 'update must not save a CID or invoke update');
  });
}

function processFixture(pid) {
  let exit;
  let output;
  return { pid, dead: false, onExit(fn) { exit = fn; }, onOutput(fn) { output = fn; },
    hasExited() { return this.dead; }, signal() {},
    exit(code) { this.dead = true; exit?.(code); }, output(text) { output?.(text); } };
}

for (const adopted of [false, true]) {
  test(`${adopted ? 'adopted' : 'spawned'} controller exits clear ownership and allow an explicit Start`, async () => {
    for (const code of [0, 1, null, 75]) {
      let proc = processFixture(101);
      let spawned = 0;
      let health = true;
      const sup = gateway.createGatewaySupervisor({
        binary: '/installed/elastos', args: ['home', '--browser'], adoptForControls: adopted,
        spawn() {
          spawned++;
          if (adopted && spawned === 1) {
            const rejected = processFixture(100);
            queueMicrotask(() => { rejected.output(gateway.ALREADY_OWNS_TEXT); rejected.exit(1); });
            return rejected;
          }
          proc = processFixture(101 + spawned);
          return proc;
        },
        fetchHealth: async () => health ? { status: 200, body: 'OK' } : null,
        confirmForeign: async () => true, adoptInstalled: async () => proc,
        now: () => 0, sleep: async () => {}, openUrl() {}, log() {},
      });
      await sup.start();
      const firstCount = spawned;
      proc.output('host executable was replaced on disk');
      health = false;
      proc.exit(code);
      assert.equal(sup.phase(), code === 0 || code === null ? 'stopped' : 'error');
      assert.equal(spawned, firstCount, 'the launcher must not restart the Home controller');
      health = true;
      await sup.start();
      assert.equal(spawned, firstCount + 1);
    }
  });
}

function lifecycle(t, mode) {
  const calls = [];
  let failStop = false;
  let finish;
  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const probe = require('../dist/main/targets/runtimeProbe');
  t.mock.method(probe, 'findRuntimeBinary', () => '/installed/elastos');
  const supervisors = [];
  t.mock.method(gateway, 'createDefaultGatewaySupervisor', () => {
    const id = supervisors.length + 1;
    const sup = { phase: () => 'stopped',
      stop: async () => { calls.push(`stop-${id}`); if (failStop) throw new Error('stop failed'); },
      start: async () => { calls.push(`start-${id}`); }, forceKill() { calls.push('force-stop'); } };
    supervisors.push(sup);
    return sup;
  });
  t.mock.method(updates, mode === 'update' ? 'applyRuntimeUpdate' : 'rollbackRuntime', async () => {
    calls.push(mode);
    if (failStop) throw new Error('mutation ran without a successful stop');
    entered(); await pending;
  });
  const target = targets.createRuntimeTarget('darwin', 'arm64');
  // Until the fix, Undo reaches this exported production entry point.
  target.rollback ??= targets.rollbackRuntimeUpdate;
  return { calls, target, supervisors, running, finish, failStop() { failStop = true; } };
}

for (const mode of ['update', 'rollback']) {
  test(`Mac ${mode} preserves the supervisor and never starts after failed Stop`, async (t) => {
    const w = lifecycle(t, mode);
    w.failStop();
    await assert.rejects(() => w.target[mode](), /stop failed/);
    assert.deepEqual(w.calls, ['stop-1']);
    assert.equal(w.supervisors.length, 1);
    await assert.rejects(() => w.target.stop(), /stop failed/);
    assert.deepEqual(w.calls, ['stop-1', 'stop-1']);
  });

  for (const control of ['stop', 'stopForRemoval', 'forceStop', 'quit']) {
    test(`Mac ${mode} serializes a later ${control} and leaves Home stopped`, async (t) => {
      const w = lifecycle(t, mode);
      const operation = w.target[mode]();
      await w.running;
      let stopping;
      if (control === 'quit') {
        const { createLaunchController } = require('../dist/main/launchController');
        const launch = createLaunchController({ env: {} });
        // Exercise the real shutdown path with this target's lifecycle state.
        launch.target.stop = w.target.stop;
        stopping = launch.shutdown();
      } else stopping = w.target[control]();
      assert.deepEqual(w.calls, control === 'forceStop' ? ['stop-1', mode, 'force-stop'] : ['stop-1', mode]);
      w.finish();
      await operation;
      await stopping;
      assert.equal(w.calls.some((call) => call.startsWith('start-')), false);
    });
  }
}

test('Mac Start and Restart serialize and the last requested state wins', async (t) => {
  const w = lifecycle(t, 'update');
  const update = w.target.update();
  await w.running;
  const start = w.target.start();
  const restart = w.target.restart();
  const stop = w.target.stop();
  w.finish();
  await Promise.all([update, start, restart, stop]);
  assert.equal(w.calls.some((call) => call.startsWith('start-')), false);
});

function adoption(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), 'round4-adopt-'));
  t.mock.method(os, 'homedir', () => home);
  const data = path.join(home, 'Library', 'Application Support', 'elastos');
  const binary = path.join(home, '.local', 'bin', 'elastos');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'installed fixture');
  const lock = path.join(data, 'host-process.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 701, addr: 'localhost:8090', generation: 'g1' }));
  let executable = binary;
  let birth = 'Sat Nov  7 21:00:00 2026';
  let controllerBirth = birth;
  let parent = 702;
  let alive = true;
  let poll;
  const signals = [];
  t.mock.method(global, 'setInterval', (fn) => { poll = fn; return { unref() {} }; });
  t.mock.method(global, 'clearInterval', () => {});
  t.mock.method(child, 'execFile', (_file, _args, _options, done) => {
    done(null, 'p701\nn127.0.0.1:8090\nn[::1]:8090\n');
  });
  t.mock.method(child, 'execFileSync', (file, args) => {
    assert.equal(file, 'ps');
    const field = args[args.length - 1];
    const pid = Number(args[1]);
    if (field === 'command=') return pid === 701 ? `${executable} gateway --addr localhost:8090`
      : `${data}/update-controller/runtime __update-controller --receipt private-file`;
    if (field === 'comm=') return pid === 701 ? executable : `${data}/update-controller/runtime`;
    if (field === 'lstart=') return pid === 701 ? birth : controllerBirth;
    if (field === 'ppid=') return String(parent);
    throw new Error(`unexpected ps field ${field}`);
  });
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0) { if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return; }
    signals.push([pid, signal]);
  });
  return { home, data, binary, lock, signals, adopt: () => gateway.adoptInstalledGatewayProcess('darwin', home),
    executable(value) { executable = value; }, birth(value) { birth = value; }, controllerBirth(value) { controllerBirth = value; },
    parent(value) { parent = value; }, exited() { alive = false; }, poll() { poll?.(); } };
}

test('adoptInstalledGatewayProcess rejects a lookalike executable and accepts the stored install_path', async (t) => {
  const w = adoption(t);
  w.executable('/another/elastos');
  assert.equal(await w.adopt(), null);
  const custom = path.join(w.home, 'custom', 'elastos');
  fs.mkdirSync(path.dirname(custom));
  fs.writeFileSync(custom, 'custom install');
  fs.writeFileSync(path.join(w.data, 'sources.json'), JSON.stringify({ default_source: 'stable', sources: [{ name: 'stable', install_path: custom }] }));
  w.executable(custom);
  const proc = await w.adopt();
  assert.ok(proc);
  proc.signal('SIGTERM');
  assert.deepEqual(w.signals, [[701, 'SIGTERM']]);
});

test('adoptInstalledGatewayProcess rechecks host birth before TERM and KILL and reports exit', async (t) => {
  const w = adoption(t);
  const proc = await w.adopt();
  assert.ok(proc);
  let exits = 0;
  proc.onExit(() => { exits++; });
  proc.signal('SIGTERM');
  w.birth('reused pid');
  assert.throws(() => proc.signal('SIGKILL'), /identity|changed|reused/i);
  assert.equal(await proc.hasExited(), true);
  w.poll();
  assert.equal(exits, 1);
  assert.deepEqual(w.signals, [[701, 'SIGTERM']]);
});

test('adoptInstalledGatewayProcess rechecks the controller birth before every signal', async (t) => {
  const w = adoption(t);
  fs.mkdirSync(path.join(w.data, 'update-controller'));
  fs.writeFileSync(path.join(w.data, 'update-controller', 'status.json'), JSON.stringify({
    host_pid: 701, generation: 'g1', controller_pid: 702,
  }));
  const proc = await w.adopt();
  assert.ok(proc);
  proc.signal('SIGTERM');
  w.controllerBirth('reused controller');
  assert.throws(() => proc.signal('SIGKILL'), /identity|changed|reused/i);
  assert.deepEqual(w.signals, [[702, 'SIGTERM']]);
});

test('adoptInstalledGatewayProcess caps the host lock before reading it', async (t) => {
  const w = adoption(t);
  fs.writeFileSync(w.lock, JSON.stringify({ pid: 701, addr: 'localhost:8090', padding: 'x'.repeat(16 * 1024) }));
  const read = fs.readFileSync;
  let lockReads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === w.lock) lockReads++;
    return read(file, ...args);
  });
  assert.equal(await w.adopt(), null);
  assert.equal(lockReads, 0);
  assert.deepEqual(w.signals, []);
});

test('previous-head store fsyncs a temporary file before rename and preserves the old record on failure', (t) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), 'round4-head-'));
  const store = updates.runtimeHeadStore(home);
  store.set('old');
  const calls = [];
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', (fd) => { calls.push('fsync'); return sync(fd); });
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.equal(store.get(), 'old');
    assert.equal(path.dirname(from), path.dirname(to));
    assert.match(path.basename(from), /^previous-head.json\..+\.tmp$/);
    calls.push('rename');
    return rename(from, to);
  });
  store.set('new');
  assert.deepEqual(calls, ['fsync', 'rename']);
  assert.equal(store.get(), 'new');
  let fail = true;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (fail) { fail = false; throw new Error('rename failed'); }
    return rename(...args);
  });
  assert.throws(() => store.set('torn'), /rename failed/);
  assert.equal(store.get(), 'new');
  assert.deepEqual(fs.readdirSync(path.join(home, '.elastos-launcher')), ['previous-head.json']);
});

for (const source of ['stdout', 'installed record']) {
  test(`applyRuntimeUpdate rejects signed 1.9.9 from ${source} without updating or storing it`, async () => {
    const raw = fixture.signedHead({ version: '1.9.9' });
    const cid = releaseHeadCid(raw);
    const calls = [];
    const verify = { maintainerDid: fixture.FIXTURE_DID, publisherGateway: 'https://publisher.example',
      readInstalledHead: async () => raw, fetchText: async () => raw };
    const run = async (args) => {
      calls.push(args);
      return { code: 0, stdout: args[0] === 'source' ? `Head CID: ${source === 'stdout' ? cid : 'unknown'}`
        : 'ElastOS Runtime v1.9.9', stderr: '' };
    };
    await assert.rejects(() => updates.applyRuntimeUpdate(run, { get() {}, set() { calls.push('store'); } }, verify), /minimum|version/i);
    assert.deepEqual(calls, source === 'stdout' ? [['source', 'show']] : [['source', 'show'], ['version']]);
  });
}

test('Undo in the launch controller uses the active target lifecycle', async (t) => {
  const { createLaunchController } = require('../dist/main/launchController');
  const launch = createLaunchController({ env: {} });
  let calls = 0;
  launch.target.rollback = async () => { calls++; };
  t.mock.method(updates, 'rollbackRuntime', async () => { throw new Error('Undo bypassed the target lifecycle'); });
  await launch.rollback();
  assert.equal(calls, 1);
});

test('Stop, removal and Restart pass their adoption intent to the real target supervisor', async (t) => {
  const w = lifecycle(t, 'update');
  const adopt = [];
  const create = gateway.createDefaultGatewaySupervisor;
  t.mock.method(gateway, 'createDefaultGatewaySupervisor', (...args) => {
    const sup = create(...args);
    sup.stop = async (options) => { adopt.push(options.adopt); };
    return sup;
  });
  await w.target.stop();
  await w.target.stopForRemoval();
  await w.target.restart();
  assert.deepEqual(adopt, [false, true, false]);
});

test('adoptInstalledGatewayProcess rejects PID reuse during socket inspection', async (t) => {
  const w = adoption(t);
  t.mock.method(child, 'execFile', (_file, _args, _options, done) => {
    w.birth('new host while lsof was pending');
    done(null, 'p701\nn127.0.0.1:8090\n');
  });
  assert.equal(await w.adopt(), null);
  assert.deepEqual(w.signals, []);
});

test('adoptInstalledGatewayProcess refuses a changed executable with the same birth time', async (t) => {
  const w = adoption(t);
  const proc = await w.adopt();
  assert.ok(proc);
  w.executable('/another/elastos');
  assert.throws(() => proc.signal('SIGTERM'), /identity|changed/i);
  assert.deepEqual(w.signals, []);
});

test('adoptInstalledGatewayProcess refuses an oversized controller status', async (t) => {
  const w = adoption(t);
  fs.mkdirSync(path.join(w.data, 'update-controller'));
  fs.writeFileSync(path.join(w.data, 'update-controller', 'status.json'), ' '.repeat(16 * 1024 + 1));
  assert.equal(await w.adopt(), null);
  assert.deepEqual(w.signals, []);
});

test('a Home controller exiting before readiness reports error without an automatic restart', async () => {
  for (const code of [0, 1, null, 75]) {
    let proc;
    let spawned = 0;
    let fail = true;
    const sup = gateway.createGatewaySupervisor({
      binary: '/installed/elastos', args: ['home', '--browser'],
      spawn() { spawned++; proc = processFixture(301 + spawned); return proc; },
      fetchHealth: async () => {
        if (fail) { proc.output('host executable was replaced on disk'); proc.exit(code); return null; }
        return { status: 200, body: 'OK' };
      },
      now: () => 0, sleep: async () => {}, openUrl() {}, log() {},
    });
    await assert.rejects(() => sup.start(), /stopped/);
    assert.equal(sup.phase(), 'error');
    assert.equal(spawned, 1);
    fail = false;
    await sup.start();
    assert.equal(spawned, 2);
  }
});
