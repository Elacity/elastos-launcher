const assert = require('node:assert/strict');
const test = require('node:test');
const { mainFixture, tick } = require('./main-fixture');
const { controllerFixture } = require('./controller-fixture');
const { startHomeAtLogin } = require('../dist/main/targets/openAtLogin');
const { createLaunchController } = require('../dist/main/launchController');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const action of ['Update', 'Open', 'login start']) {
  for (const stopPending of [true, false]) {
    test(`real controller: Quit during ${action}, shutdown ${stopPending ? 'pending' : 'finished'}`, async () => {
      const { launch, runtime } = controllerFixture();
      const f = await mainFixture({ controller: launch });
      const work = defer(), stop = defer();
      runtime.wait.stop = () => stop.promise;
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
  test(`shutdown closes all controller restart entry points even when stop reports ${outcome}`, async () => {
    const { launch, runtime } = controllerFixture();
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
      assert.deepEqual(runtime.calls, ['stop']);
    } finally { stop.resolve(); await result; }
  });
}

test('real Runtime update and its caller cannot restart Home after controller shutdown', async t => {
  const gateway = require('../dist/main/targets/runtimeGateway');
  const runtimeUpdate = require('../dist/main/targets/runtimeUpdate');
  const targets = require('../dist/main/targets');
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  const calls = [];
  let phase = 'stopped';
  const supervisor = {
    async start() { calls.push('start'); phase = 'running'; },
    async stop() { calls.push('stop'); phase = 'stopped'; },
    phase: () => phase,
  };
  t.mock.method(gateway, 'createDefaultGatewaySupervisor', () => supervisor);
  t.mock.method(require('../dist/main/targets/runtimeProbe'), 'findRuntimeBinary', () => '/fixture/elastos');
  t.mock.method(require('../dist/main/targets/runtimePin'), 'loadActiveRuntimePin', () => ({
    maintainerDid: 'did:example:test', publisherGateway: 'https://example.invalid', version: '2.0.0',
  }));
  t.mock.method(targets, 'createLaunchTarget', () => createRuntimeTarget('darwin', 'arm64'));
  const entered = defer(), apply = defer();
  t.mock.method(runtimeUpdate, 'applyRuntimeUpdate', async () => { entered.resolve(); await apply.promise; });
  const launch = createLaunchController({ env: {} });
  await launch.start();
  const updating = launch.update(() => {});
  await entered.promise;
  const atQuit = calls.length;
  const quitting = launch.shutdown();
  apply.resolve();
  await updating;
  // The Update caller's late start, after the target cancels its own restart.
  await launch.start();
  await quitting;
  assert.deepEqual({ startsAfterQuit: calls.slice(atQuit).filter(c => c === 'start'), phase },
    { startsAfterQuit: [], phase: 'stopped' });
});
