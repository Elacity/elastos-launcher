const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const waits = require('../scripts/tray-e2e');

function clock(t) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setTimeout', (fn, ms) => { now += ms; queueMicrotask(fn); });
  return () => now;
}

function fixture(t, focused) {
  const now = clock(t);
  const calls = [];
  const logs = path.join(__dirname, `.e2e-logs-${process.pid}`);
  fs.mkdirSync(logs);
  t.after(() => { fs.unlinkSync(path.join(logs, 'main.log')); fs.rmdirSync(logs); });
  fs.writeFileSync(path.join(logs, 'main.log'), Array.from({ length: 65 }, (_, i) => `launcher line ${i + 1}`).join('\n') + '\n');
  const win = {
    id: 7, getTitle: () => 'ElastOS', isVisible: () => true,
    isFocused: () => focused(now()), focus: () => calls.push('window.focus'),
    webContents: { executeJavaScript: async () => ({ kind: 'install', message: 'Home is ready.', primary: 'Open Home' }) },
  };
  const app = { evaluate: async (fn, arg) => vm.runInNewContext(`(${fn})`, {
    global, process: { mainModule: { require: name => {
      assert.equal(name, 'electron-log');
      return { transports: { file: { getFile: () => ({ path: path.join(logs, 'main.log') }) } } };
    } } },
  })({
    app: { focus: options => calls.push({ ...options }), getPath: () => path.join(logs, 'different-electron-log-folder') },
    BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win.isFocused() ? win : null },
  }, arg) };
  t.mock.method(console, 'error', () => {});
  global.__openedHome = ['http://localhost:8090/home/'];
  t.after(() => { delete global.__openedHome; });
  return { app, calls, now };
}

test('focusWindow requests app and window focus and waits for the actual focused window', async t => {
  const { app, calls, now } = fixture(t, now => now >= 750);
  await waits.focusWindow(app);
  assert.equal(now(), 750);
  assert.deepEqual(calls, [{ steal: true }, 'window.focus']);
});

test('focusWindow fails with focus, renderer state, browser calls and exactly the last 60 log lines', async t => {
  const { app, now } = fixture(t, () => false);
  await assert.rejects(waits.focusWindow(app), error => {
    assert.match(error.message, /Launcher window did not gain focus/);
    assert.match(error.message, /focused window: null/);
    assert.match(error.message, /"id":7/);
    assert.match(error.message, /Home is ready/);
    assert.match(error.message, /__openedHome:.*localhost:8090/);
    const tail = error.message.split('launcher log (last 60 lines):\n')[1];
    assert.equal(tail.split('\n').length, 60);
    assert.equal(tail.split('\n')[0], 'launcher line 6');
    assert.equal(tail.split('\n').at(-1), 'launcher line 65');
    assert.ok(console.error.mock.calls.length, 'diagnostics printed before rejection');
    return true;
  });
  assert.equal(now(), 10000);
});

test('waitFor includes diagnostics when its predicate throws and preserves the original cause', async t => {
  const { app } = fixture(t, () => true);
  const cause = new Error('Runtime reported an install error');
  await assert.rejects(waits.waitFor(() => { throw cause; }, 1000, 'Install timeout', app), error => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /Runtime reported an install error/);
    assert.match(error.message, /focused window: 7/);
    assert.match(error.message, /launcher line 65/);
    return true;
  });
});

for (const platform of ['mac', 'linux', 'windows']) {
  test(`${platform} lifecycle waits for a fresh async Open Home browser call`, async t => {
    const now = clock(t);
    let clickedAt;
    // An earlier click must not satisfy this lifecycle step.
    global.__elastosTray = true;
    global.__openedHome = ['http://localhost:8090/home/'];
    t.after(() => { delete global.__openedHome; delete global.__elastosTray; });
    const shell = {};
    let context;
    const app = { evaluate: async (fn, arg) => {
      if (clickedAt !== undefined && now() - clickedAt >= 750 && !global.__openedHome.length) shell.openExternal('http://localhost:8090/home/');
      return vm.runInContext(`(${fn})`, context)({ shell, BrowserWindow: { getAllWindows: () => [] } }, arg);
    } };
    const stop = new Error('stop after the browser assertion');
    const script = path.resolve(__dirname, `../scripts/${platform}-lifecycle-e2e.js`);
    const sandbox = {
      module: { exports: {} }, global, process: {}, Date, setTimeout, console, fetch: async () => {
        assert.ok(now() - clickedAt >= 750, 'browser assertion ran before openApp completed');
        throw stop;
      },
      require: name => {
        if (name === './tray-e2e') return { ...waits, trayState: async () => {}, noWindow: async () => {}, clickMenu: async () => {
          assert.equal(global.__openedHome.length, 0, 'browser history must be cleared before the menu click');
          clickedAt = now();
        } };
        if (name.startsWith('../dist/')) return {};
        return require(name);
      },
    };
    context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(script, 'utf8'), context, { filename: script });
    await assert.rejects(sandbox.module.exports(app, {}, '/fixture', {}), error => error === stop);
    assert.equal(now(), 750);
  });
}

test('waitFor still prints the launcher log when Electron has exited', async t => {
  const { app } = fixture(t, () => true);
  await waits.waitFor(() => true, 1000, 'initial ready', app);
  t.mock.method(app, 'evaluate', async () => { throw new Error('Electron connection closed'); });
  await assert.rejects(waits.waitFor(() => false, 1000, 'Home health did not become false', app), error => {
    assert.match(error.message, /Home health did not become false/);
    assert.match(error.message, /focused window:.*Electron connection closed/);
    assert.match(error.message, /current window state:.*Electron connection closed/);
    assert.match(error.message, /__openedHome:.*Electron connection closed/);
    assert.match(error.message, /launcher log \(last 60 lines\):\nlauncher line 6/);
    assert.match(error.message, /launcher line 65$/);
    return true;
  });
});
