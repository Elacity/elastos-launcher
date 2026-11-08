const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { noWindow } = require('../scripts/tray-e2e');

function clock(t) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setTimeout', (fn, ms) => { now += ms; queueMicrotask(fn); });
  return () => now;
}
function fakeApp(windows) {
  return { evaluate: (fn, arg) => vm.runInNewContext(`(${fn})`, { process: {} })({ BrowserWindow: { getAllWindows: windows } }, arg) };
}
function window(id, title, visible) { return { id, getTitle: () => title, isVisible: visible }; }

test('noWindow waits for every visible window to hide', async t => {
  const now = clock(t);
  const app = fakeApp(() => [window(1, 'Hidden', () => false), window(2, 'Update ElastOS', () => now() < 750)]);
  await noWindow(app);
  assert.equal(now(), 750);
});

test('noWindow fails after 10 seconds and names the last visible window state', async t => {
  const now = clock(t);
  await assert.rejects(noWindow(fakeApp(() => [window(7, 'Update ElastOS', () => true)])), error => {
    assert.match(error.message, /No visible windows after 10000 ms/);
    assert.match(error.message, /"id":7/);
    assert.match(error.message, /"title":"Update ElastOS"/);
    assert.match(error.message, /"visible":true/);
    return true;
  });
  assert.equal(now(), 10000);
});

for (const windows of [[], [window(1, 'Hidden', () => false)]]) {
  test(`noWindow accepts ${windows.length ? 'hidden' : 'no'} windows immediately`, async () => {
    await noWindow(fakeApp(() => windows));
  });
}

for (const stable of [true, false]) {
  test(`native click ${stable ? 'uses bounds and element position after two stable reads' : 'refuses moving bounds after 10 seconds'}`, async t => {
    const now = clock(t), events = [], reads = [];
    t.mock.method(require('node:child_process'), 'spawnSync', (file, args) => {
      if (file !== 'swiftc') events.push(args);
      return { status: 0 };
    });
    const file = require.resolve('../scripts/mac-native');
    delete require.cache[file];
    const { nativeControls } = require(file);
    t.after(() => { delete require.cache[file]; });
    const bounds = () => {
      reads.push(now());
      return { x: 10, y: 20, width: 360, height: stable && now() >= 100 ? 400 : 320 + now() };
    };
    const app = fakeApp(() => [{ getContentBounds: bounds }]);
    const page = { locator: () => ({ boundingBox: async () => {
      assert.ok(now() >= 200, 'element position read before the resize settled');
      return { x: 5, y: 300, width: 100, height: 40 };
    } }) };
    const clicking = nativeControls(app, page).click('#primary');
    if (stable) {
      await clicking;
      assert.deepEqual(reads, [0, 100, 200]);
      assert.deepEqual(events, [['65', '340']]);
    } else {
      await assert.rejects(clicking, /Window content bounds did not stabilize/);
      assert.equal(events.length, 0);
      assert.equal(now(), 10000);
    }
  });
}
