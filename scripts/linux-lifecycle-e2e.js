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

async function status(page, wanted) {
  await page.waitForFunction(async (next) => await window.elastos.getStatus() === next, wanted, { timeout: 180000 });
  await page.waitForFunction((next) => document.querySelector('#status-text').textContent.toLowerCase() === next, wanted, { timeout: 10000 });
}

module.exports = async function (app, page, home) {
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

  const checked = await page.evaluate(() => window.elastos.checkForUpdate());
  assert.equal(checked.updateAvailable, false);
  const data = path.join(home, '.local', 'share', 'elastos');
  const update = JSON.parse(fs.readFileSync(path.join(data, 'update-check.json'), 'utf8'));
  assert.equal(update.outcome, 'up_to_date');
  console.log('PASS elastos update --check writes up_to_date');
};
