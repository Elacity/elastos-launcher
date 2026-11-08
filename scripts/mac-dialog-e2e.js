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
const expectDrag = process.argv.includes('--expect-drag');
const clickHelper = path.join(os.tmpdir(), 'launcher-dialog-click');
const compiled = spawnSync('swiftc', [path.join(__dirname, 'mac-click.swift'), '-o', clickHelper], { encoding: 'utf8', timeout: 120000 });
assert.equal(compiled.status, 0, compiled.stderr);
const permission = spawnSync(clickHelper, [], { encoding: 'utf8', timeout: 5000 });
assert.ok([0, 77].includes(permission.status), permission.stderr);
console.log(permission.stdout.trim());

async function main() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'launcher-dialog-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ELASTOS_LAUNCH_TARGET: 'runtime',
    ELASTOS_HIDE_HOST_TOOLS: '1', PATH: (process.env.PATH || '').split(path.delimiter)
      .filter((dir) => !fs.existsSync(path.join(dir, 'elastos'))).join(path.delimiter) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: binary, env, timeout: 60000 });
  const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 180000);
  const failures = [];
  let nativeFailures = 0;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const geometry = await app.evaluate(({ ipcMain, BrowserWindow, app }) => {
      global.__dialogCalls = [];
      const info = { id: 'runtime', status: 'stopped', openUrl: 'http://localhost:8090/home/',
        preflight: { ok: true, checks: [] }, openAtLogin: false, canRollback: true };
      const items = ['.pc2', '.personal-cloud', 'Library/Application Support/Personal Cloud',
        'Library/Logs/Personal Cloud'].map((name) => ({ scope: 'host', label: 'Old Personal Cloud data',
        path: `/Users/runner/${name}`, bytes: 1024 }));
      const values = {
        getLaunchInfo: info, getStatus: 'stopped', getVersion: '2.0.0', isInstalled: true,
        getLogs: 'Packaged dialog regression', resumeInstallPlan: 'none',
        checkForUpdate: { updateAvailable: true, latest: '2.0.1' },
        describeLegacyPc2: { items },
        describeResetBackup: { present: true, enough: true, bytes: 1024, neededBytes: 2048,
          freeBytes: 1000000, folder: '/Users/runner/Desktop' },
        describeFailure: { title: 'ElastOS needs attention', message: 'Dialog fixture failure', fixLabel: 'Fix it' },
        getPreflight: { ok: true, checks: [] },
      };
      for (const name of [...Object.keys(values), 'start', 'stop', 'install', 'openBrowser', 'update', 'rollback',
        'resetRuntime', 'uninstall', 'removeLegacyPc2', 'setOpenAtLogin', 'fixFailure', 'getDiagnostics', 'saveSupportBundle']) {
        ipcMain.removeHandler(`elastos:${name}`);
        ipcMain.handle(`elastos:${name}`, (_event, ...args) => {
          global.__dialogCalls.push({ name, args });
          if (name === 'saveSupportBundle') throw new Error('Dialog fixture failure');
          return values[name];
        });
      }
      const window = BrowserWindow.getAllWindows()[0];
      // The production status poll also runs outside IPC. Keep its fixture
      // consistent with getLaunchInfo instead of racing a not-installed poll.
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => send(channel,
        ...(channel === 'elastos:status' ? ['stopped'] : args));
      window.setPosition(100, 100);
      // Hosted Macs clamp the requested 860px window to their shorter display.
      // Fit the intended CSS viewport on that display; native coordinates below
      // use the measured zoom, and Logs calibrates the OS click translation.
      const bounds = window.getContentBounds();
      window.webContents.setZoomFactor(Math.min(1, bounds.height / 860));
      window.show(); window.focus(); app.focus({ steal: true });
      return { bounds, zoom: window.webContents.getZoomFactor() };
    });
    console.log(`Dialog viewport: ${JSON.stringify(geometry)}`);
    await page.reload();
    await page.locator('#remove-pc2-btn').waitFor({ state: 'visible' });
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('#status-text').textContent(), 'Stopped', 'fixture survives the production status poll');
    assert.equal(await page.locator('#uninstall-btn').isEnabled(), true);
    const dragElements = await page.evaluate(() => [...document.querySelectorAll('*')]
      .filter((el) => getComputedStyle(el).webkitAppRegion === 'drag')
      .map((el) => el.tagName === 'BODY' ? 'body' : el.className));
    assert.deepEqual(dragElements, expectDrag ? ['body', 'title-bar'] : ['title-bar']);

    async function check(label, selector) {
      const controls = page.locator(selector);
      assert.ok(await controls.count(), `${label} has controls`);
      for (const control of await controls.all()) {
        if (!await control.isVisible()) continue;
        await control.scrollIntoViewIfNeeded();
        const report = await control.evaluate((element) => {
          const rect = (node) => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          const identify = (node) => node.id ? `#${node.id}` : node.tagName.toLowerCase() + (node.className ? `.${String(node.className).trim().replace(/\s+/g, '.')}` : '');
          const r = element.getBoundingClientRect();
          const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          const regions = [...document.querySelectorAll('*')].filter((node) => {
            const style = getComputedStyle(node);
            return ['drag', 'no-drag'].includes(style.webkitAppRegion) && node.getClientRects().length && style.visibility !== 'hidden';
          }).map((node) => ({ element: identify(node), region: getComputedStyle(node).webkitAppRegion, rect: rect(node) }));
          // Apply the rectangular drag/no-drag operations in document order:
          // body, card, title bar, then overlays. A later no-drag cuts an earlier drag.
          let drag = false;
          for (const region of regions) {
            const box = region.rect;
            if (center.x >= box.x && center.x < box.x + box.width && center.y >= box.y && center.y < box.y + box.height) {
              drag = region.region === 'drag';
            }
          }
          const ancestors = [];
          for (let node = element; node; node = node.parentElement) {
            ancestors.push({ element: identify(node), region: getComputedStyle(node).webkitAppRegion, rect: rect(node) });
          }
          return { control: identify(element), center, drag, regions, ancestors,
            card: rect(document.querySelector('.hardware-box')), dialog: rect(document.querySelector('.confirm-content')) };
        });
        console.log(`${report.drag ? 'FAIL' : 'PASS'} region ${label} ${JSON.stringify(report)}`);
        if (report.drag) failures.push(`${label} ${report.control}`);
      }
    }

    async function nativeClick(selector) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      const center = await page.locator(selector).evaluate((el) => {
        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const { bounds, zoom } = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { bounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor() };
      });
      const result = spawnSync(clickHelper, [String(bounds.x + center.x * zoom), String(bounds.y + center.y * zoom)], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      await page.waitForTimeout(300);
    }

    await check('main', '.hardware-box button, #login-checkbox');
    if (permission.status === 0) {
      await nativeClick('#logs-btn');
      assert.equal(await page.locator('#logs-panel').isVisible(), true, 'native click calibration opens Logs');
      await nativeClick('#close-logs');
      assert.equal(await page.locator('#logs-panel').isVisible(), false);
      console.log('PASS native OS click calibration opens and closes Logs');
    }
    await page.click('#logs-btn');
    await check('logs', '#logs-panel button');
    await page.click('#close-logs');

    for (const [name, trigger] of [['Reset', '#reset-btn'], ['Uninstall', '#uninstall-btn'], ['Remove PC2', '#remove-pc2-btn']]) {
      await page.click(trigger);
      await page.locator('#confirm-modal').waitFor({ state: 'visible' });
      if (name === 'Reset') await page.locator('#reset-backup-yes').waitFor({ state: 'visible' });
      await check(name, '#confirm-modal button, #confirm-modal input');
      if (permission.status === 0) {
        if (name === 'Remove PC2') {
          await nativeClick('#confirm-backup');
          const checked = await page.locator('#confirm-backup').isChecked();
          console.log(`${checked ? 'PASS' : 'FAIL'} native Remove PC2 backup checkbox`);
          if (!checked) nativeFailures++;
          if (!expectDrag) assert.equal(checked, true);
        }
        await nativeClick('#confirm-cancel');
        const closed = !await page.locator('#confirm-modal').isVisible();
        console.log(`${closed ? 'PASS' : 'FAIL'} native ${name} Cancel`);
        if (!closed) nativeFailures++;
        if (!expectDrag) assert.equal(closed, true);
        if (closed) await page.click(trigger);
      }
      if (name === 'Reset') await page.check('#reset-backup-yes');
      if (name === 'Remove PC2') await page.check('#confirm-backup');
      if (permission.status === 0) {
        await nativeClick('#confirm-delete');
        const closed = !await page.locator('#confirm-modal').isVisible();
        console.log(`${closed ? 'PASS' : 'FAIL'} native ${name} confirm`);
        if (!closed) nativeFailures++;
        if (!expectDrag) assert.equal(closed, true);
      }
      if (await page.locator('#confirm-modal').isVisible()) await page.click('#confirm-delete');
      await page.locator('#confirm-modal').waitFor({ state: 'hidden' });
    }
    const calls = await app.evaluate(() => global.__dialogCalls);
    assert.ok(calls.some((call) => call.name === 'resetRuntime' && call.args[0].backup === true));
    assert.ok(calls.some((call) => call.name === 'uninstall'));
    assert.ok(calls.some((call) => call.name === 'removeLegacyPc2' && call.args[0] === true && call.args[1].length === 4));
    await page.click('#logs-btn');
    await page.click('#close-logs');
    // The real support-bundle error handler exposes the error controls.
    // Invoke the existing handler after revealing the error section; it calls showError.
    await page.locator('#error-box').evaluate((el) => el.classList.remove('hidden'));
    await page.click('#support-btn');
    await page.locator('#fix-btn').waitFor({ state: 'visible' });
    await check('errors', '#error-box button');
    console.log(`Dialog regression: ${failures.length} drag-covered controls; ${nativeFailures} native click failures`);
    if (expectDrag) {
      assert.ok(failures.some((name) => name.startsWith('Remove PC2')), 'pinned baseline must reproduce Remove PC2 drag coverage');
      if (permission.status === 0) assert.ok(nativeFailures > 0, 'native clicks must reproduce the pinned regression');
    }
    else assert.deepEqual(failures, [], 'every interactive center must be outside native drag regions');
  } finally {
    try { await app.evaluate(({ app }) => app.exit(0)); } catch {}
    clearTimeout(watchdog);
    if (app.process().exitCode === null) app.process().kill('SIGKILL');
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
