const assert = require('node:assert/strict');
const test = require('node:test');
const { mainFixture, tick } = require('./main-fixture');
const { runtimeFixtures } = require('./controller-fixture');
const { startHomeAtLogin } = require('../dist/main/targets/openAtLogin');
const { createLaunchController } = require('../dist/main/launchController');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const platform of ['darwin', 'linux', 'win32']) {
for (const action of ['Update', 'Open', 'login start']) {
  for (const stopPending of [true, false]) {
    test(`${platform} real controller: Quit during ${action}, shutdown ${stopPending ? 'pending' : 'finished'}`, async t => {
      const { launch, runtime } = runtimeFixtures(t, platform)();
      await launch.start();
      runtime.calls.length = 0;
      const f = await mainFixture({ controller: launch, platform });
      const work = defer(), stop = defer();
      let pending;
      if (action === 'Update') {
        runtime.wait.update = () => work.promise;
        await f.click('Update to 2.0.1…');
        pending = f.invoke('update');
      } else {
        launch.target.getStatus = () => work.promise.then(() => 'stopped');
        if (action === 'Open') await f.click('Open Home');
        else pending = startHomeAtLogin(true, launch);
      }
      await tick();
      runtime.wait.stop = () => stop.promise;
      const atQuit = runtime.calls.length;
      f.app.emit('before-quit', { preventDefault() {} });
      if (!stopPending) { stop.resolve(); await tick(); }
      try {
        work.resolve();
        if (pending) await pending;
        await tick(); await tick();
        const startsAfterQuit = runtime.calls.slice(atQuit).filter(c => c === 'start');
        stop.resolve();
        await tick(); await tick();
        assert.deepEqual({ startsAfterQuit, running: runtime.running, quit: f.calls.includes('quit') },
          { startsAfterQuit: [], running: false, quit: true });
        assert.equal(f.tray.menu[0].label, 'Stopping Home…');
      } finally { work.resolve(); stop.resolve(); }
    });
  }
}

for (const outcome of ['stopped', 'foreign', 'error']) {
  test(`${platform} shutdown closes all controller restart entry points even when stop reports ${outcome}`, async t => {
    const { launch, runtime } = runtimeFixtures(t, platform)();
    const stop = defer();
    runtime.wait.stop = async () => {
      await stop.promise;
      if (outcome === 'foreign') throw new (require('../dist/main/targets/runtimeGateway').ForeignGatewayError)();
      if (outcome === 'error') throw new Error('stop failed');
    };
    const shutdown = launch.shutdown();
    const result = outcome === 'error' ? assert.rejects(shutdown, /stop failed/) : shutdown;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await launch.start();
        await launch.restart();
        await launch.update(() => {});
        await launch.rollback();
        stop.resolve();
        await result;
      }
      await launch.target.start();
      for (const supervisor of runtime.supervisors) await supervisor.start();
      assert.deepEqual(runtime.calls, ['stop']);
    } finally { stop.resolve(); await result; }
  });
}

for (const action of ['update', 'rollback']) {
  test(`${platform} real target: Quit during ${action} never spawns again`, async t => {
    const { launch, runtime } = runtimeFixtures(t, platform)();
    await launch.start();
    const entered = defer(), work = defer();
    runtime.wait[action] = async () => { entered.resolve(); await work.promise; };
    const changing = launch[action](() => {});
    await entered.promise;
    const atQuit = runtime.calls.length;
    const quitting = launch.shutdown();
    work.resolve();
    await changing;
    await quitting;
    assert.deepEqual(runtime.calls.slice(atQuit).filter(c => c === 'start'), []);
    assert.equal(runtime.running, false);
  });
}

test(`${platform} bypassing the controller after Quit cannot start or replace a supervisor`, async t => {
  const { launch, runtime } = runtimeFixtures(t, platform)();
  await launch.start();
  await launch.shutdown();
  const atQuit = runtime.calls.length;
  for (const action of ['start', 'restart', 'update', 'rollback']) await launch.target[action](() => {});
  for (const supervisor of runtime.supervisors) await supervisor.start();
  assert.deepEqual(runtime.calls.slice(atQuit).filter(c => c === 'start'), []);
  assert.equal(runtime.running, false);
});

test(`${platform} Quit while start awaits an exited handle cannot spawn again`, async t => {
  const { launch, runtime } = runtimeFixtures(t, platform)();
  await launch.start();
  const entered = defer(), check = defer();
  runtime.wait.hasExited = async () => { entered.resolve(); await check.promise; };
  const starting = launch.target.start();
  await entered.promise;
  const atQuit = runtime.calls.length;
  const quitting = launch.shutdown();
  runtime.proc.exited = true; runtime.running = false;
  check.resolve();
  await starting; await quitting;
  assert.deepEqual(runtime.calls.slice(atQuit).filter(c => c === 'start'), []);
  assert.equal(runtime.running, false);
});
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} platform factory refuses before reaching any host boundary after Quit`, async t => {
    const gateway = require('../dist/main/targets/runtimeGateway');
    const childProcess = require('node:child_process');
    for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
      t.mock.method(childProcess, method, () => { throw new Error(`Host boundary reached: ${method}`); });
    }
    const lifetime = { shuttingDown: true };
    const supervisor = platform === 'win32'
      ? require('../dist/main/targets/windowsRuntime').createDistroGatewaySupervisor(lifetime)
      : gateway.createDefaultGatewaySupervisor('/fixture/elastos', platform, lifetime);
    assert.equal(await supervisor.start(), 'stopped');
    assert.equal(supervisor.phase(), 'stopped');
  });

  for (const legacy of [false, true]) {
    test(`${platform} Quit during ${legacy ? 'legacy' : 'current'} adoption refuses ownership and browser start`, async () => {
      const gateway = require('../dist/main/targets/runtimeGateway');
      const lifetime = { shuttingDown: false };
      const entered = defer(), adopt = defer();
      const calls = [];
      let output, clock = 0;
      const supervisor = gateway.createGatewaySupervisor({
        lifetime, platform, binary: '/fixture/elastos', args: ['home', '--browser'], adoptForControls: true,
        spawn: () => ({
          pid: 321, onOutput(fn) { output = fn; },
          onExit(fn) { queueMicrotask(() => { output(gateway.ALREADY_OWNS_TEXT); fn(0); }); },
          hasExited: () => true, signal() { throw new Error('Not owned'); },
        }),
        fetchHealth: async () => ({ status: 200, body: 'OK' }),
        confirmForeign: async () => true, foreignIsLegacy: async () => legacy,
        async adoptInstalled() { entered.resolve(); return adopt.promise; },
        sleep: async () => { clock += 1000; }, now: () => clock,
        openUrl() { calls.push('open'); }, log() {},
      });
      const starting = supervisor.start();
      await entered.promise;
      lifetime.shuttingDown = true;
      adopt.resolve({ pid: 456, onExit() { calls.push('own'); }, hasExited: () => true,
        signal() { calls.push('signal'); }, dispose() { calls.push('dispose'); } });
      await starting.catch(error => { if (!legacy) throw error; });
      assert.deepEqual(calls, ['dispose']);
    });
  }
}

test('Quit closes the default app lifetime across newly created targets on every platform', async t => {
  const gateway = require('../dist/main/targets/runtimeGateway');
  const windows = require('../dist/main/targets/windowsRuntime');
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  const child = require('node:child_process');
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    t.mock.method(child, method, () => { throw new Error(`Host boundary reached: ${method}`); });
  }
  t.mock.method(require('../dist/main/targets/runtimeProbe'), 'findRuntimeBinary', () => '/fixture/elastos');
  t.mock.method(windows, 'distroIsInstalled', () => true);
  const launch = createLaunchController({ env: {} });
  launch.target.stop = async () => {};
  await launch.shutdown();
  for (const platform of ['darwin', 'linux', 'win32']) {
    await createRuntimeTarget(platform, platform === 'darwin' ? 'arm64' : 'x64').start();
    const supervisor = platform === 'win32' ? windows.createDistroGatewaySupervisor()
      : gateway.createDefaultGatewaySupervisor('/fixture/elastos', platform);
    assert.equal(await supervisor.start(), 'stopped');
  }
});
