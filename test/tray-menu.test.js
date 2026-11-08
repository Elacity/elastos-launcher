const assert = require('node:assert/strict');
const test = require('node:test');
const { buildHomeMenu, trayPresentation } = require('../dist/main/homeMenu');
const { createOpenHome } = require('../dist/main/openHome');
const actions = Object.fromEntries(['open','start','stop','update','login','diagnostics','logs','removePc2','reset','uninstall','about','quit'].map(key => [key, () => {}]));
function stateFor(status) {
  return { observed: status === 'updating' ? 'running' : status, failure: null, quitting: false,
    inFlight: ['starting', 'stopping', 'updating'].includes(status)
      ? { kind: { starting: 'start', stopping: 'stop', updating: 'update' }[status], generation: 1 } : null };
}
for (const platform of ['darwin', 'win32', 'linux']) {
  for (const status of ['running', 'stopped', 'starting', 'stopping', 'updating', 'error', 'other-home', 'not-installed']) {
    test(`${platform} real menu: ${status}`, () => {
      const menu = buildHomeMenu({ ...stateFor(status), login: false, pc2: false, platform }, actions);
      assert.equal(menu[0].enabled, false);
      assert.equal(menu.filter(i => i.type !== 'separator')[1].label, 'Open Home');
      assert.equal(menu.find(i => i.label === 'Open Home').accelerator, 'CommandOrControl+O');
      assert.ok(!menu.some(i => /Show Window|keep Home|Status:/.test(i.label || '')));
      const power = menu.find(i => /^(Start|Stop) Home$/.test(i.label || ''));
      assert.equal(power.label, status === 'running' ? 'Stop Home' : 'Start Home');
      assert.equal(power.enabled, ['running', 'stopped', 'error'].includes(status));
      assert.equal(menu.at(-1).label, 'Quit ElastOS');
      assert.equal(menu.at(-1).accelerator, 'CommandOrControl+Q');
      assert.ok(trayPresentation(stateFor(status)).tooltip.startsWith('ElastOS: '));
    });
  }
}
test('offer, PC2 and login values come from state; clicks call real actions', () => {
  for (const login of [true, false]) for (const pc2 of [true, false]) for (const offered of [true, false]) {
    const calls = [];
    const callbacks = Object.fromEntries(Object.keys(actions).map(key => [key, (...args) => calls.push([key, ...args])]));
    const menu = buildHomeMenu({ ...stateFor('running'), login, pc2, platform: 'darwin', update: offered ? { latest: '2.0.1', updateAvailable: true } : null }, callbacks);
    const item = menu.find(i => i.type === 'checkbox');
    assert.equal(item.checked, login);
    item.click({ checked: !login });
    assert.deepEqual(calls.shift(), ['login', !login]);
    const troubleshoot = menu.find(i => i.label === 'Troubleshoot').submenu;
    assert.equal(troubleshoot.some(i => i.label === 'Remove Old PC2 Files…'), pc2);
    assert.equal(menu.some(i => i.label === 'Update to 2.0.1…'), offered);
    menu.find(i => i.label === 'Open Home').click();
    menu.at(-1).click();
    assert.deepEqual(calls, [['open'], ['quit']]);
  }
  assert.equal(buildHomeMenu({ ...stateFor('running'), platform: 'darwin', update: { latest: '2.0.1', updateAvailable: false } }, actions).some(i => /^Update to/.test(i.label || '')), false);
});
test('icon states are distinct', () => {
  assert.equal(new Set(['running', 'stopped', 'starting', 'error'].map(s => trayPresentation(stateFor(s)).image)).size, 4);
  assert.equal(trayPresentation(stateFor('updating')).image, trayPresentation(stateFor('starting')).image);
});
for (const status of ['running', 'stopped', 'error', 'not-installed', 'other-home']) {
  test(`open app = start if needed then open Home: ${status}`, async () => {
    const calls = [];
    const open = createOpenHome({ getStatus: async () => status, start: async () => calls.push('start'), openInBrowser: () => calls.push('open') }, () => calls.push('install'));
    if (status === 'other-home') await assert.rejects(open(), /another/i);
    else await Promise.all([open(), open()]);
    assert.deepEqual(calls, status === 'other-home' ? [] : status === 'not-installed' ? ['install'] : status === 'running' ? ['open'] : ['start', 'open']);
  });
}
test('failed start never opens the browser', async () => {
  let opened = false;
  const open = createOpenHome({ getStatus: async () => 'stopped', start: async () => { throw new Error('blocked'); }, openInBrowser: () => { opened = true; } }, () => {});
  await assert.rejects(open(), /blocked/);
  assert.equal(opened, false);
});
