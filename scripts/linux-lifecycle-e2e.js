const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');

async function health(wanted) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (isHealthOk(await probeGatewayHealth()) === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Home health did not become ${wanted}`);
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}

async function status(page, wanted) {
  await waitFor(async () => await page.evaluate(() => window.elastos.getStatus()) === wanted,
    180000, `Launcher status did not become ${wanted}`);
  await waitFor(async () => (await page.locator('#status-text').innerText()).toLowerCase() === `home is ${wanted}`,
    10000, `Window status did not become ${wanted}`);
}

async function liveController(data) {
  const statusPath = path.join(data, 'update-controller', 'status.json');
  const deadline = Date.now() + 180000;
  let last = 'absent';
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      const pid = record.controller_pid;
      if (record.phase === 'ready' && Number.isInteger(pid) && pid > 0) {
        const command = Buffer.alloc(4096);
        const fd = fs.openSync(`/proc/${pid}/cmdline`, 'r');
        let bytes = 0;
        try {
          bytes = fs.readSync(fd, command, 0, command.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (command.subarray(0, bytes).includes('__update-controller')) return record;
        last = `pid ${pid} is not the update controller`;
      } else {
        last = `phase ${record.phase}`;
      }
    } catch (err) {
      last = err && err.code ? err.code : 'unread';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Home system update check did not reach a live controller (${last})`);
}

async function clickTray(app, id) {
  const exit = new Promise((resolve) => app.process().once('exit', resolve));
  const clicked = app.evaluate((_electron, itemId) => {
    const menu = global.__elastosTrayMenu;
    const item = menu && menu.getMenuItemById(itemId);
    if (!item || !item.enabled) return false;
    item.click();
    return true;
  }, id).catch(() => false);
  const ok = await Promise.race([
    clicked,
    exit.then(() => true),
  ]);
  assert.equal(ok, true, id);
  await exit;
}

function portClosed(port, host) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (closed) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
  });
}

module.exports = async function (app, page, home, launch) {
  assert.equal(await app.evaluate(() => global.__elastosTray), true);
  console.log('PASS the tray icon is ready');

  await app.evaluate(({ shell }) => {
    global.__openedHome = [];
    shell.openExternal = async (url) => { global.__openedHome.push(url); };
  });
  await page.click('#open-btn');
  assert.deepEqual(await app.evaluate(() => global.__openedHome), ['http://localhost:8090/home/']);
  const response = await fetch('http://localhost:8090/home/');
  assert.equal(response.status, 200);
  console.log('PASS Open Home invokes the browser with localhost:8090/home/ and Home returns HTTP 200');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await health(true);
  console.log('PASS closing the window keeps Home running');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

  await page.click('#power-btn');
  await status(page, 'stopped');
  await health(false);
  console.log('PASS Stop Home closes the listener');
  await page.click('#open-btn');
  await status(page, 'running');
  await health(true);
  console.log('PASS Start Home becomes healthy');

  const data = path.join(home, '.local', 'share', 'elastos');
  const controller = await liveController(data);
  assert.equal(controller.phase, 'ready');
  console.log('PASS Home system update check reaches the live controller');
  console.log('NOT EXERCISED a full System update because no newer signed release exists');
  console.log('NOT EXERCISED the owner System summary because that route needs a wallet token');

  const checked = await page.evaluate(() => window.elastos.checkForUpdate());
  assert.equal(checked.updateAvailable, false);
  const nativeUpdate = path.join(data, 'update-check.json');
  const update = JSON.parse(fs.readFileSync(fs.existsSync(nativeUpdate) ? nativeUpdate
    : path.join(home, '.elastos-launcher', 'update-check.json'), 'utf8'));
  assert.equal(update.outcome, 'up_to_date');
  console.log('PASS elastos update --check writes up_to_date');

  const keptPid = controller.controller_pid;
  await clickTray(app, 'quit-keep-home');
  await health(true);
  assert.equal(fs.existsSync(`/proc/${keptPid}`), true);
  console.log('PASS Quit and keep Home leaves the controller running');

  const { _electron: electron } = require('playwright');
  const reopened = await electron.launch(launch);
  try {
    const again = await reopened.firstWindow();
    await status(again, 'running');
    assert.equal(await again.locator('#open-label').innerText(), 'Open Home');
    console.log('PASS a reopened launcher sees the retained Home');
    await clickTray(reopened, 'quit-stop-home');
  } finally {
    await reopened.close().catch(() => {});
  }
  await health(false);
  assert.equal(await portClosed(8090, '127.0.0.1'), true);
  assert.equal(await portClosed(8090, '::1'), true);
  assert.equal(fs.existsSync(`/proc/${keptPid}`), false);
  console.log('PASS Quit and stop Home after reopen stops the retained Home');
};
