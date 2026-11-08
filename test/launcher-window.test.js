const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { contentWindowBounds } = require('../dist/main/launcherWindow');
const { isLoginLaunch, startHomeAtLogin } = require('../dist/main/targets/openAtLogin');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('content sizing shrinks, grows, and clamps frame and position to the screen', () => {
  const bounds = { x: 900, y: 700, width: 420, height: 500 };
  const content = { width: 420, height: 470 };
  const work = { x: 0, y: 25, width: 1200, height: 775 };
  assert.deepEqual(contentWindowBounds(310, bounds, content, work), { x: 780, y: 460, width: 420, height: 340 });
  assert.deepEqual(contentWindowBounds(1200, bounds, content, work), { x: 780, y: 25, width: 420, height: 775 });
  assert.deepEqual(contentWindowBounds(300, bounds, content, { x: -320, y: 0, width: 320, height: 600 }),
    { x: -320, y: 270, width: 320, height: 330 });
});

test('login start is platform-explicit and starts only a stopped Home', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(isLoginLaunch(platform, ['--login'], { wasOpenedAtLogin: true }), true);
    assert.equal(isLoginLaunch(platform, [], {}), false);
    assert.equal(isLoginLaunch(platform, ['--login'], {}), platform !== 'darwin');
    for (const status of ['running', 'stopped', 'not-installed', 'error', 'starting', 'stopping', 'other-home']) {
      let starts = 0;
      const launch = { getStatus: async () => status, start: async () => { starts++; } };
      await startHomeAtLogin(false, launch);
      assert.equal(starts, 0);
      await startHomeAtLogin(true, launch);
      assert.equal(starts, status === 'stopped' ? 1 : 0, `${platform} ${status}`);
    }
  }
});

// Execute the complete built entry point with OS/runtime boundaries replaced.
// No Electron process, host profile, Home probe, or real timer is involved.
async function mainFixture({ login = false, enabled = true, lock = true, platform = 'darwin' } = {}) {
  const file = path.resolve(__dirname, '../dist/main/index.js');
  const realRequire = createRequire(file);
  const calls = [];
  const windows = [];
  const handlers = new Map();
  const app = new EventEmitter();
  let ready;
  const whenReady = new Promise((resolve) => { ready = resolve; });
  Object.assign(app, {
    requestSingleInstanceLock() { calls.push('lock'); return lock; },
    exit() { calls.push('exit'); throw new Error('fixture exit'); },
    setPath() {}, setAppLogsPath() {}, setName() {},
    dock: { setIcon() {}, hide() { calls.push('dock-hide'); }, show() {} },
    whenReady: () => whenReady,
    getLoginItemSettings: () => ({ wasOpenedAtLogin: login }),
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = { send() {} };
      this.bounds = { x: 100, y: 100, width: 420, height: 360 };
      this.shows = 0; this.focuses = 0; windows.push(this);
    }
    getBounds() { return this.bounds; }
    getContentBounds() { return this.bounds; }
    setBounds(value) { this.bounds = value; }
    loadFile() {}
    show() { this.shows++; }
    focus() { this.focuses++; }
    isMinimized() { return true; }
    restore() { calls.push('restore'); }
  }
  const launch = {
    onStatusChange() {}, onLog() {}, onActionSuccess() {}, getLogs: async () => '',
    getStatus: async () => 'stopped', getOpenAtLogin: () => enabled,
    setOpenAtLogin() {}, start: async () => { calls.push('start'); },
  };
  const image = { isEmpty: () => false, resize() { return this; } };
  const electron = { app, BrowserWindow,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) }, nativeImage: { createFromPath: () => image },
    ipcMain: { handle(name, fn) { handlers.set(name, fn); }, on(name, fn) { handlers.set(name, fn); } },
    Menu: { buildFromTemplate: (value) => value, setApplicationMenu() {} },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
  };
  const log = { transports: { file: {}, console: {} }, error() {}, info() {} };
  const customRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === 'electron-log') return log;
    if (name === 'fs') return { mkdirSync() { calls.push('mkdir'); } };
    if (name === './launchController') return {
      ...realRequire(name),
      createDefaultLaunchController() { calls.push('controller'); return launch; },
      homeLaunchForPlatform: () => ({}),
    };
    return realRequire(name);
  };
  const context = { require: customRequire, exports: {}, __dirname: path.dirname(file),
    process: { platform, argv: login ? ['elastos', '--login'] : ['elastos'], env: {} },
    setInterval: () => ({ unref() {} }), global: {} };
  if (!lock) {
    assert.throws(() => vm.runInNewContext(fs.readFileSync(file, 'utf8'), context), /fixture exit/);
    return { calls, windows };
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  ready(); await tick();
  windows[0].emit('ready-to-show'); await tick();
  return { calls, windows, app, handlers };
}

test('real main entry point keeps login launch hidden, starts Home, and reopens one window', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const fixture = await mainFixture({ login: true, platform });
    assert.equal(fixture.windows.length, 1);
    assert.equal(fixture.windows[0].shows, 0, platform);
    assert.equal(fixture.calls.filter((call) => call === 'start').length, 1, platform);
    fixture.app.emit('second-instance'); await tick();
    assert.equal(fixture.windows.length, 1);
    assert.equal(fixture.windows[0].shows, 1);
    assert.equal(fixture.windows[0].focuses, 1);
    assert.ok(fixture.calls.includes('restore'));
    fixture.app.emit('activate');
    assert.equal(fixture.windows[0].focuses, 2);
    const resize = fixture.handlers.get('elastos:contentSize');
    for (const invalid of [null, NaN, Infinity, -1, '300']) {
      assert.doesNotThrow(() => resize({ sender: fixture.windows[0].webContents }, invalid));
    }
    assert.doesNotThrow(() => resize({ sender: {} }, 300));
    assert.equal(fixture.windows[0].bounds.height, 360);
    resize({ sender: fixture.windows[0].webContents }, 300);
    assert.equal(fixture.windows[0].bounds.height, 300);
  }
  const normal = await mainFixture();
  assert.equal(normal.windows[0].shows, 1);
  assert.equal(normal.calls.includes('start'), false);
  const disabled = await mainFixture({ login: true, enabled: false });
  assert.equal(disabled.calls.includes('start'), false);
  const secondary = await mainFixture({ lock: false });
  assert.deepEqual(secondary.calls, ['mkdir', 'lock', 'exit']);
});

test('successful control operations clear stored errors and notify every window caller', async (t) => {
  const { createLaunchController } = require('../dist/main/launchController');
  const preflight = require('../dist/main/targets/preflight');
  t.mock.method(preflight, 'collectPreflight', async () => ({ ok: true, checks: [] }));
  t.mock.method(require('../dist/main/targets/runtimeUninstall'), 'resetRuntimeOnThisComputer', async () => ({ backupPath: null }));
  t.mock.method(require('../dist/main/targets/windowsReset'), 'resetRuntimeInDistroOnThisComputer', async () => ({ backupPath: null }));
  t.mock.method(require('../dist/main/targets/windowsUninstall'), 'uninstallRuntimeInDistroOnThisComputer', async () => {});
  for (const method of ['start', 'stop', 'restart', 'install', 'update', 'rollback', 'resetRuntime', 'uninstall', 'openInBrowser']) {
    const controller = createLaunchController({ env: {} });
    let successes = 0;
    controller.onActionSuccess(() => { successes++; });
    controller.target.start = async () => { throw new Error('prior start failed'); };
    await assert.rejects(controller.start(), /prior start failed/);
    assert.match((await controller.describeFailure()).message, /prior start failed/);
    assert.equal(successes, 0);
    controller.target.start = async () => {};
    controller.target[method] = () => Promise.resolve();
    await controller[method]();
    assert.doesNotMatch((await controller.describeFailure()).message, /prior start failed/, method);
    assert.equal(successes, 1, method);
  }
});

test('real login settings register hidden Mac login, Windows login args, and Linux autostart', () => {
  const file = path.resolve(__dirname, '../dist/main/targets/openAtLogin.js');
  const source = fs.readFileSync(file, 'utf8');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const settings = [];
    const files = new Map();
    const module = { exports: {} };
    const customRequire = (name) => {
      if (name === 'electron') return { app: { setLoginItemSettings(value) { settings.push(value); } } };
      if (name === 'fs') return {
        mkdirSync() {}, writeFileSync(file, data) { files.set(file, data); },
        rmSync(file) { files.delete(file); },
      };
      return require(name);
    };
    vm.runInNewContext(source, { require: customRequire, exports: module.exports,
      process: { platform, env: {}, execPath: '/fixture/ElastOS' } });
    module.exports.applyOpenAtLogin(true, '/fixture');
    if (platform === 'linux') {
      assert.match(files.get('/fixture/.config/autostart/elastos.desktop'), /^Exec=\/fixture\/ElastOS --login$/m);
    } else {
      assert.equal(settings[0].openAtLogin, true);
      if (platform === 'darwin') assert.equal(settings[0].openAsHidden, true);
      else assert.equal(JSON.stringify(settings[0].args), '["--login"]');
    }
    module.exports.applyOpenAtLogin(false, '/fixture');
    assert.equal(JSON.parse(files.get('/fixture/.elastos-launcher/open-at-login.json')).enabled, false);
    if (platform === 'linux') assert.equal(files.has('/fixture/.config/autostart/elastos.desktop'), false);
    else assert.equal(settings[1].openAtLogin, false);
  }
});

test('Home log folders follow each platform data location', () => {
  const { homeLogFolder } = require('../dist/main/launchController');
  assert.equal(homeLogFolder('darwin', '/fixture', {}), '/fixture/Library/Application Support/elastos/logs');
  assert.equal(homeLogFolder('linux', '/fixture', {}), '/fixture/.local/share/elastos/logs');
  assert.equal(homeLogFolder('linux', '/fixture', { XDG_DATA_HOME: '/data' }), '/data/elastos/logs');
  assert.equal(homeLogFolder('win32', 'C:\\Users\\fixture', {}), '\\\\wsl.localhost\\ElastOS\\root\\.local\\share\\elastos\\logs');
});
