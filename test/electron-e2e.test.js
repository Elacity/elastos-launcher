const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mainFixture } = require('./main-fixture');

// Run the complete CI entry point against the real main-process retry handler.
test('Windows install e2e answers native Set Up and waits through setup to Home is ready', async () => {
  const f = await mainFixture({ installed: false, platform: 'win32' });
  const install = f.launch.install;
  let setup = false;
  f.launch.install = async progress => {
    if (!setup) throw new Error('Windows needs Linux support.');
    await install(progress);
  };
  f.launch.describeFailure = async () => ({ kind: 'windows', message: 'Windows needs Linux support.', fixLabel: 'Try Again' });
  f.launch.getPreflight = async () => ({ checks: [] });
  let finishSetup;
  f.launch.fixFailure = async () => {
    await new Promise(resolve => { finishSetup = resolve; });
    setup = true;
    return 'still-blocked';
  };
  let clicking;
  let primaryDisabled = false;
  const page = {
    locator: selector => ({
      waitFor: async () => {},
      innerText: async () => {
        const state = await f.invoke('getWindowState');
        if (selector === '#message') return state.message;
        return state.kind === 'error' ? state.actionLabel : state.ready ? 'Open Home' : 'Install';
      },
    }),
    getAttribute: async () => (await f.invoke('getWindowState')).kind,
    click: async () => {
      const state = await f.invoke('getWindowState');
      if (state.kind === 'error') {
        primaryDisabled = true;
        clicking = f.invoke('retry');
        await new Promise(resolve => setImmediate(resolve));
      } else if (!state.ready) await f.invoke('install', false);
      else await f.invoke('openHome');
    },
    waitForFunction: async predicate => {
      assert.equal(predicate(), false);
      assert.ok(finishSetup, 'Set Up confirmation must be accepted');
      finishSetup();
      await clicking;
      primaryDisabled = false;
      assert.equal(predicate(), true);
    },
    evaluate: async () => f.invoke('copyDiagnostics'),
  };
  const logs = [];
  const dialog = {};
  Object.defineProperty(dialog, 'showMessageBox', {
    set(handler) {
      f.dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        f.dialogs.push(options);
        return handler(...args);
      };
    },
  });
  const electronApp = {
    firstWindow: async () => page,
    evaluate: async (fn, arg) => fn({
      shell: {}, dialog, app: { exit() {} }, clipboard: { readText: () => [
        'Release head signature matches the pinned maintainer', 'install.sh SHA-256 matches the pin', 'Installed head CID matches the pin',
      ].join('\n') },
    }, arg),
    process: () => ({ kill() {} }),
  };
  let exit;
  const done = new Promise(resolve => { exit = resolve; });
  const script = path.resolve(__dirname, '../scripts/electron-e2e.js');
  const sandbox = {
    __dirname: path.dirname(script), console: { log: line => logs.push(line), error: line => logs.push(String(line)) },
    process: { platform: 'win32', env: {}, exit }, global: {},
    setTimeout: () => 0, clearTimeout() {},
    document: { querySelector: () => ({ disabled: primaryDisabled }) },
    require: name => {
      if (name === 'electron') return '/fixture/electron';
      if (name === 'playwright') return { _electron: { launch: async () => electronApp } };
      if (name === 'node:os') return { homedir: () => '/fixture' };
      if (name === 'node:fs') return { mkdirSync() {}, chmodSync() {}, mkdtempSync: () => '/fixture/home', existsSync: () => true };
      if (name === '../dist/main/targets/runtimeGateway') return {
        HOME_URL: 'http://localhost:8090/home/', isHealthOk: () => true, probeGatewayHealth: async () => ({}),
      };
      if (name === './tray-e2e') return {
        waitFor: async predicate => { for (let i = 0; i < 8; i++) if (await predicate()) return; throw new Error('Install did not finish'); },
        noWindow: async () => {},
      };
      if (name === './windows-lifecycle-e2e') return async app => app;
      return require(name);
    },
  };
  f.launch.openInBrowser = () => sandbox.__openedHome.push('http://localhost:8090/home/');
  sandbox.global = sandbox;
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
  assert.equal(await done, 0, logs.join('\n'));
  assert.ok(logs.includes('PASS install through window reaches Home is ready with signed-install evidence'));
  assert.equal(f.calls.filter(call => call === 'install').length, 1);
  assert.deepEqual(f.dialogs[0].buttons, ['Cancel', 'Set Up']);
  assert.equal(f.dialogs[0].defaultId, 0);
  assert.equal(setup, true);
  assert.equal((await f.dialog.showMessageBox({ buttons: ['Cancel', 'Reset'] })).response, 0);
});

for (const mode of ['delayed focus', 'never focused', 'duplicate tab']) {
  test(`Mac install e2e handles ${mode} before the native Open Home click`, async t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(global, 'setTimeout', (fn, ms) => { now += ms; queueMicrotask(fn); });
    const waits = require('../scripts/tray-e2e');
    let ready = false, closed = false, focusAt, nativeClicks = 0, compiles = 0;
    const focusCalls = [];
    const logs = [];
    const shell = {};
    const sandbox = {};
    const win = {
      id: 1, getTitle: () => 'ElastOS', isVisible: () => !closed,
      isFocused: () => !ready || (mode !== 'never focused' && focusAt !== undefined && now - focusAt >= 750),
      focus: () => { focusAt = now; focusCalls.push('window.focus'); },
      getContentBounds: () => ({ x: 10, y: 20, width: 360, height: 400 }),
      webContents: { executeJavaScript: async () => ({ kind: 'install', message: 'Home is ready.' }) },
    };
    const page = {
      locator: selector => ({ waitFor: async () => {}, innerText: async () => selector === '#message' ? 'Home is ready.' : ready ? 'Open Home' : 'Install',
        boundingBox: async () => ({ x: 5, y: 300, width: 360, height: 40 }),
      }),
      waitForTimeout: async () => {},
      getAttribute: async () => 'install', evaluate: async () => {},
    };
    const app = {
      firstWindow: async () => page,
      evaluate: async (fn, arg) => vm.runInNewContext(`(${fn})`, {
        global: sandbox, process: { mainModule: { require: name => {
          assert.equal(name, 'electron-log');
          return { transports: { file: { getFile: () => ({ path: '/fixture/no-logs/main.log' }) } } };
        } } },
      })({
        app: { focus: options => focusCalls.push({ ...options }), exit() {}, getPath: () => '/fixture/no-logs' },
        BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win.isFocused() ? win : null },
        shell, clipboard: { readText: () => ['Release head signature matches the pinned maintainer', 'install.sh SHA-256 matches the pin', 'Installed head CID matches the pin'].join('\n') },
      }, arg),
      process: () => ({ kill() {} }),
    };
    t.mock.method(require('node:child_process'), 'spawnSync', (file, args) => {
      if (file === 'swiftc') {
        compiles++;
        now += 20000;
        focusAt = undefined;
      } else if (args.length === 4) {
        win.getContentBounds = () => ({ x: 70, y: 65, width: 360, height: 400 });
      } else {
        nativeClicks++;
        assert.equal(win.isFocused(), true, 'native click reached an inactive window');
        if (!ready) {
          ready = true;
          focusAt = undefined; // home --browser brings another app to the front.
          if (mode === 'duplicate tab') shell.openExternal('http://localhost:8090/home/');
        } else {
          shell.openExternal('http://localhost:8090/home/');
          closed = true;
        }
      }
      return { status: 0 };
    });
    const nativeFile = require.resolve('../scripts/mac-native');
    delete require.cache[nativeFile];
    const native = require(nativeFile);
    t.after(() => { delete require.cache[nativeFile]; });
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const script = path.resolve(__dirname, '../scripts/electron-e2e.js');
    Object.assign(sandbox, {
      __dirname: path.dirname(script), Date, global: sandbox,
      console: { log: line => logs.push(String(line)), error: line => logs.push(String(line)) },
      process: { platform: 'darwin', env: { GITHUB_ACTIONS: 'true' }, exit: finish },
      setTimeout: () => 0,
      require: name => {
        if (name === 'electron') return '/fixture/electron';
        if (name === 'playwright') return { _electron: { launch: async () => app } };
        if (name === 'node:os') return { homedir: () => '/fixture' };
        if (name === 'node:fs') return { mkdirSync() {}, chmodSync() {}, mkdtempSync: () => '/fixture/home' };
        if (name === '../dist/main/targets/runtimeGateway') return { HOME_URL: 'http://localhost:8090/home/', isHealthOk: () => true, probeGatewayHealth: async () => ({}) };
        if (name === './tray-e2e') return waits;
        if (name === './mac-native') return native;
        if (name === './mac-lifecycle-e2e') return async () => app;
        return require(name);
      },
    });
    // The real helper prints failure evidence; keep it in the fixture's output.
    t.mock.method(console, 'error', line => logs.push(String(line)));
    vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
    assert.equal(await done, mode === 'delayed focus' ? 0 : 1, logs.join('\n'));
    assert.equal(nativeClicks, mode === 'delayed focus' ? 2 : 1);
    assert.equal(compiles, 1, 'compile the helper once per app and page');
    if (mode === 'delayed focus') {
      assert.equal(now, 20950);
      assert.deepEqual(focusCalls, [{ steal: true }, 'window.focus', { steal: true }, 'window.focus', { steal: true }, 'window.focus']);
    } else if (mode === 'never focused') {
      assert.match(logs.join('\n'), /Launcher window did not gain focus/);
      assert.match(logs.join('\n'), /current window state:.*Home is ready/);
    } else assert.match(logs.join('\n'), /Mac Install opened a duplicate browser tab/);
  });
}
