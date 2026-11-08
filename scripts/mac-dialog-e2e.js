// Real packaged renderer and handlers; only IPC data/mutations are fixtures.
// Native macOS paths ignore HOME, so never run this on the maintainer's Mac.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Packaged Mac dialog e2e runs only on the disposable GitHub Mac runner.');
}
const binary = path.resolve(process.argv[2], 'Contents/MacOS/ElastOS');
const clickHelper = path.join(os.tmpdir(), 'launcher-dialog-click');
const compiled = spawnSync('swiftc', [path.join(__dirname, 'mac-click.swift'), '-o', clickHelper], { encoding: 'utf8', timeout: 120000 });
assert.equal(compiled.status, 0, compiled.stderr);
const permission = spawnSync(clickHelper, [], { encoding: 'utf8', timeout: 5000 });
assert.equal(permission.status, 0, `Native OS events are required: ${permission.stdout} ${permission.stderr}`);

async function main() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'launcher-dialog-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ELASTOS_LAUNCH_TARGET: 'runtime',
    ELASTOS_HIDE_HOST_TOOLS: '1', PATH: (process.env.PATH || '').split(path.delimiter)
      .filter((dir) => !fs.existsSync(path.join(dir, 'elastos'))).join(path.delimiter) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: binary, env, timeout: 60000 });
  const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 180000);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(({ ipcMain, BrowserWindow, app }) => {
      global.__dialogCalls = [];
      const info = { id: 'runtime', status: 'running', openUrl: 'http://localhost:8090/home/',
        preflight: { ok: true, checks: [] }, openAtLogin: false, canRollback: true };
      const items = ['.pc2', '.personal-cloud', 'Library/Application Support/Personal Cloud',
        'Library/Logs/Personal Cloud'].map((name) => ({ scope: 'host', label: 'Old Personal Cloud data',
        path: `/Users/runner/${name}`, bytes: 1024 }));
      const values = {
        getLaunchInfo: info, getVersion: '2.0.0', isInstalled: true,
        getLogs: 'Packaged dialog regression', resumeInstallPlan: 'none',
        checkForUpdate: { updateAvailable: true, latest: '2.0.1' },
        describeLegacyPc2: { items },
        describeResetBackup: { present: true, enough: true, bytes: 1024, neededBytes: 2048,
          freeBytes: 1000000, folder: '/Users/runner/Desktop' },
        describeFailure: { message: 'Dialog fixture failure', fixLabel: 'Fix it' },
        getPreflight: { ok: true, checks: [] },
      };
      for (const name of [...Object.keys(values), 'getStatus', 'start', 'stop', 'install', 'openBrowser', 'update', 'rollback',
        'resetRuntime', 'uninstall', 'removeLegacyPc2', 'setOpenAtLogin', 'fixFailure', 'getDiagnostics', 'saveSupportBundle', 'openLogFolder']) {
        ipcMain.removeHandler(`elastos:${name}`);
        ipcMain.handle(`elastos:${name}`, (_event, ...args) => {
          global.__dialogCalls.push({ name, args });
          if (name === 'saveSupportBundle') throw new Error('Dialog fixture failure');
          if (name === 'getStatus') return info.status;
          if (name === 'stop') info.status = 'stopped';
          if (name === 'removeLegacyPc2') {
            values.describeLegacyPc2 = { items: [] };
            return { ok: true, message: 'PC2 removed' };
          }
          return values[name];
        });
      }
      const window = BrowserWindow.getAllWindows()[0];
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => send(channel,
        ...(channel === 'elastos:status' ? [info.status] : args));
      window.setPosition(100, 100);
      window.show(); window.focus(); app.focus({ steal: true });
    });
    await page.reload();
    await page.locator('#url-value').waitFor({ state: 'visible' });
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('#status-text').textContent(), 'Home is running');

    async function geometry() {
      return app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { bounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor() };
      });
    }
    async function nativeClick(selector) {
      const control = page.locator(selector);
      await control.scrollIntoViewIfNeeded();
      const center = await control.evaluate((el) => {
        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const { bounds, zoom } = await geometry();
      const result = spawnSync(clickHelper, [String(bounds.x + center.x * zoom), String(bounds.y + center.y * zoom)], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      await page.waitForTimeout(300);
    }
    async function check(label) {
      const leaked = await page.locator('.hidden').evaluateAll((nodes) => nodes
        .filter((node) => getComputedStyle(node).display !== 'none').map((node) => node.id));
      assert.deepEqual(leaked, [], label);
      for (const control of await page.locator('button, a, input, summary').all()) {
        if (!await control.isVisible()) continue;
        assert.equal(await control.evaluate((el) => getComputedStyle(el).webkitAppRegion), 'no-drag');
      }
      console.log(`PASS ${label}: hidden elements and interactive drag regions`);
    }

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    const second = spawnSync(binary, [], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(second.status, 0, `second instance must exit cleanly: ${second.stderr}`);
    await page.waitForTimeout(300);
    assert.equal(await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length === 1 && windows[0].isVisible() && windows[0].isFocused();
    }), true, 'opening again must focus the existing window');
    console.log('PASS native second-instance activation focuses one existing window');

    await check('main');
    const before = await geometry();
    const strip = await page.locator('.title-bar').boundingBox();
    assert.ok(strip && strip.x === 0 && strip.width === before.bounds.width);
    assert.equal(await page.locator('.title-bar').evaluate((el) => getComputedStyle(el).webkitAppRegion), 'drag');
    const x = before.bounds.x + strip.width * .7;
    const y = before.bounds.y + strip.height / 2;
    const drag = spawnSync(clickHelper, [String(x), String(y), String(x + 60), String(y + 45)], { encoding: 'utf8', timeout: 5000 });
    assert.equal(drag.status, 0, drag.stderr);
    await page.waitForTimeout(300);
    const after = await geometry();
    assert.ok(Math.abs(after.bounds.x - before.bounds.x - 60) <= 3
      && Math.abs(after.bounds.y - before.bounds.y - 45) <= 3,
    `top-strip OS drag must move the window: ${JSON.stringify({ before, after })}`);
    console.log(`PASS native top-strip drag ${JSON.stringify({ before, after })}`);
    await nativeClick('#url-value');
    assert.ok(await app.evaluate(() => global.__dialogCalls.some((call) => call.name === 'openBrowser')));
    console.log('PASS native Home address click invokes openBrowser');
    await nativeClick('#power-btn');
    assert.equal(await page.locator('#status-text').textContent(), 'Home is stopped');
    await nativeClick('summary');
    assert.equal(await page.locator('#details').getAttribute('open'), '');
    await check('Details');

    for (const [name, trigger] of [['Reset', '#reset-btn'], ['Uninstall', '#uninstall-btn'], ['Remove old PC2 files', '#remove-pc2-btn']]) {
      await nativeClick(trigger);
      await page.locator('#confirm-modal').waitFor({ state: 'visible' });
      await check(name);
      if (name === 'Remove old PC2 files') {
        await nativeClick('#confirm-backup');
        assert.equal(await page.locator('#confirm-backup').isChecked(), true);
      }
      await nativeClick('#confirm-cancel');
      assert.equal(await page.locator('#confirm-modal').isVisible(), false);
      await nativeClick(trigger);
      if (name === 'Reset') await nativeClick('#reset-backup-yes');
      if (name === 'Remove old PC2 files') await nativeClick('#confirm-backup');
      await nativeClick('#confirm-delete');
      await page.locator('#confirm-modal').waitFor({ state: 'hidden' });
      console.log(`PASS native ${name} backup, Cancel, and confirm`);
    }
    const calls = await app.evaluate(() => global.__dialogCalls);
    assert.ok(calls.some((call) => call.name === 'resetRuntime' && call.args[0].backup === true));
    assert.ok(calls.some((call) => call.name === 'uninstall'));
    assert.ok(calls.some((call) => call.name === 'removeLegacyPc2' && call.args[0] === true && call.args[1].length === 4));
    assert.equal(await page.locator('#remove-pc2-btn').isVisible(), false);
    assert.equal(await page.locator('#status-text').textContent(), 'Old PC2 files removed.');
    await nativeClick('#support-btn');
    await page.locator('#fix-btn').waitFor({ state: 'visible' });
    await check('error');
  } finally {
    try { await app.evaluate(({ app }) => app.exit(0)); } catch {}
    clearTimeout(watchdog);
    if (app.process().exitCode === null) app.process().kill('SIGKILL');
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
