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
      assert.ok(reads >= 2, 'confirm running before opening');
    });
  }
  test(`${platform} real controller: a cold Open Home leaves the browser to the new Home command`, async t => {
    const { launch, runtime } = runtimeFixtures(t, platform)();
    launch.target.openInBrowser = () => assert.fail('new home --browser already opens Home');
    await createOpenHome(launch, () => assert.fail('unexpected install'), true)();
    assert.deepEqual(runtime.calls, ['start']);
  });
}
