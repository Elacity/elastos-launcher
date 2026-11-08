const assert = require('node:assert/strict');
const test = require('node:test');
const { mainFixture, tick } = require('./main-fixture');
const { runtimeFixtures } = require('./controller-fixture');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, platform) {
  const { launch, runtime } = runtimeFixtures(t, platform)();
  let installed = false;
  t.mock.method(require('../dist/main/targets/runtimeInstall'), 'installRuntimeOnThisComputer', async () => {
    runtime.calls.push('install'); installed = true;
  });
  launch.target.getStatus = async () => !installed ? 'not-installed' : runtime.running ? 'running' : 'stopped';
  launch.setOpenAtLogin = () => {};
  launch.finishResumeInstall = ok => runtime.calls.push(['resume', ok]);
  return { launch, runtime };
}

for (const platform of ['darwin', 'linux', 'win32']) {
  for (const path of ['Install', 'Reset then Install', 'setup resume']) {
    test(`${platform} real controller: ${path} starts Home before declaring ready`, async t => {
      const { launch, runtime } = fixture(t, platform);
      const start = defer();
      runtime.wait.start = () => start.promise;
      if (path === 'setup resume') launch.resumeInstallPlan = async () => 'install';
      const f = await mainFixture({ controller: launch, platform });
      let installing;
      try {
        if (path === 'Reset then Install') {
          launch.resetRuntime = async () => {};
          f.answers.push({ response: 1, checkboxChecked: false });
          await f.click('Reset ElastOS…');
        }
        if (path !== 'setup resume') installing = f.invoke('install', false);
        await tick();
        assert.deepEqual(await f.invoke('getWindowState'), { kind: 'progress', message: 'Starting Home' });
        assert.deepEqual(runtime.calls, ['install', 'start']);
        start.resolve();
        await installing; await tick(); await tick();
        assert.equal(runtime.running, true);
        assert.deepEqual(await f.invoke('getWindowState'), { kind: 'install', ready: true, message: 'Home is ready.' });
        if (path === 'setup resume') assert.deepEqual(runtime.calls.at(-1), ['resume', true]);
      } finally { start.resolve(); await installing; await tick(); }
    });
  }

  test(`${platform} real controller: start failure offers Try Again and retry starts Home`, async t => {
    const { launch, runtime } = fixture(t, platform);
    runtime.wait.start = async () => { throw new Error('Home start failed'); };
    const f = await mainFixture({ controller: launch, platform });
    await f.invoke('install', false);
    const state = await f.invoke('getWindowState');
    assert.equal(state.kind, 'error');
    assert.equal(state.actionLabel, 'Try Again');
    assert.notEqual(state.ready, true);
    delete runtime.wait.start;
    await f.invoke('retry');
    assert.equal(runtime.running, true);
    assert.equal((await f.invoke('getWindowState')).ready, true);
  });

  for (const during of ['install', 'start']) {
    test(`${platform} real controller: Quit during ${during} never publishes ready or restarts Home`, async t => {
      const { launch, runtime } = fixture(t, platform);
      const work = defer();
      if (during === 'install') t.mock.method(require('../dist/main/targets/runtimeInstall'), 'installRuntimeOnThisComputer', () => work.promise);
      else runtime.wait.start = () => work.promise;
      const f = await mainFixture({ controller: launch, platform });
      const installing = f.invoke('install', false);
      await tick();
      const atQuit = runtime.calls.length;
      f.app.emit('before-quit', { preventDefault() {} });
      work.resolve();
      await installing; await tick(); await tick();
      assert.equal(runtime.calls.slice(atQuit).includes('start'), false);
      assert.equal(runtime.running, false);
      assert.notEqual((await f.invoke('getWindowState')).ready, true);
      assert.ok(f.calls.includes('quit'));
    });
  }
}
