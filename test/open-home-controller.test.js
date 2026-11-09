const assert = require('node:assert/strict');
const test = require('node:test');
const { createOpenHome } = require('../dist/main/openHome');
const { runtimeFixtures } = require('./controller-fixture');

for (const platform of ['darwin', 'linux', 'win32']) {
  for (const observed of ['starting', 'error', 'stopped']) {
    test(`${platform} real controller: Open Home after a stale ${observed} observation opens once without spawning`, async t => {
      const { launch, runtime } = runtimeFixtures(t, platform)();
      await launch.start();
      let reads = 0, opened = 0;
      launch.target.getStatus = async () => ++reads === 1 ? observed : 'running';
      launch.target.openInBrowser = () => { opened++; };
      const open = createOpenHome(launch, () => assert.fail('unexpected install'), true);
      await Promise.all([open(), open()]);
      assert.equal(opened, 1);
      assert.deepEqual(runtime.calls, ['start']);
    });
  }
  test(`${platform} real controller: a cold Open Home leaves the browser to the new Home command`, async t => {
    const { launch, runtime } = runtimeFixtures(t, platform)();
    launch.target.openInBrowser = () => assert.fail('new home --browser already opens Home');
    await createOpenHome(launch, () => assert.fail('unexpected install'), true)();
    assert.deepEqual(runtime.calls, ['start']);
  });
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} real controller: a reused Home waits for health before opening`, async t => {
    const { launch, runtime } = runtimeFixtures(t, platform)();
    await launch.start();
    let healthReads = 0, opened = 0, statusReads = 0;
    // The first wait belongs to hasExited, the next to the health probe.
    runtime.wait.start = async () => { if (++healthReads === 2) runtime.running = false; };
    launch.target.getStatus = async () => ++statusReads === 1 ? 'starting' : 'running';
    launch.target.openInBrowser = () => { opened++; };
    await assert.rejects(createOpenHome(launch, () => {}, true)(), /did not become ready/);
    assert.equal(opened, 0);
    assert.ok(healthReads > 2, 'polls health rather than accepting the cached running phase');
    assert.deepEqual(runtime.calls, ['start']);
    runtime.running = true;
    statusReads = 0;
    runtime.wait.start = undefined;
    await createOpenHome(launch, () => {}, true)();
    assert.equal(opened, 1);
  });
}
