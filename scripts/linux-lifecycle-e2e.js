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
  await waitFor(async () => (await page.locator('#status-text').innerText()).toLowerCase() === wanted,
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
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (cmdline.includes('__update-controller')) return record;
        last = `pid ${pid} command ${cmdline}`;
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

module.exports = async function (app, page, home) {
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
  const update = JSON.parse(fs.readFileSync(path.join(data, 'update-check.json'), 'utf8'));
  assert.equal(update.outcome, 'up_to_date');
  console.log('PASS elastos update --check writes up_to_date');
};
