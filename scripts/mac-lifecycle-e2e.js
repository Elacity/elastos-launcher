const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');
const { runtimeChildEnv } = require('../dist/main/targets/releaseHead');

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
  let last = '';
  try {
    await waitFor(async () => {
      last = await page.evaluate(() => window.elastos.getStatus());
      return last === wanted;
    }, 180000, `Launcher status did not become ${wanted}`);
    await waitFor(async () => (await page.locator('#status-text').innerText()).toLowerCase() === wanted,
      10000, `Window status did not become ${wanted}`);
  } catch (error) {
    console.log(`Status failure wanted=${wanted} last=${last} window=${await page.locator('#status-text').innerText()} error=${await page.locator('#error-text').innerText()}`);
    const logs = await page.locator('#logs-content').innerText();
    for (const match of logs.matchAll(/Home ownership check: (host-lock|native-host|host-proof|host-changed|controller-status|controller-metadata)\b/g)) {
      console.log(match[0]);
    }
    throw error;
  }
}

module.exports = async function (app, page, home, options) {
  assert.equal((await page.locator('#logs-content').innerText()).includes('Keep this terminal open'), false);
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
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
    10000, 'The launcher window did not regain focus');

  await page.click('#power-btn');
  await status(page, 'stopped');
  await health(false);
  console.log('PASS Stop Home closes the listener');
  await page.click('#open-btn');
  await status(page, 'running');
  await health(true);
  console.log('PASS Start Home becomes healthy');

  const data = path.join(home, 'Library', 'Application Support', 'elastos');
  const controllerStatus = path.join(data, 'update-controller', 'status.json');
  // This controller was started by this test's launcher on the disposable runner.
  const startedController = JSON.parse(fs.readFileSync(controllerStatus, 'utf8')).controller_pid;
  process.kill(startedController, 'SIGKILL');
  await status(page, 'error');
  console.log(`Home retained after controller crash: ${isHealthOk(await probeGatewayHealth())}`);
  await page.evaluate(() => window.elastos.stop());
  await health(false);
  await status(page, 'stopped');
  await page.click('#open-btn');
  await status(page, 'running');
  await health(true);
  console.log('PASS controller crash reports Error; Stop and explicit Start recover a healthy Home');

  const checked = await page.evaluate(() => window.elastos.checkForUpdate());
  assert.equal(checked.updateAvailable, false);
  const nativeUpdate = path.join(data, 'update-check.json');
  const update = JSON.parse(fs.readFileSync(fs.existsSync(nativeUpdate) ? nativeUpdate
    : path.join(home, '.elastos-launcher', 'update-check.json'), 'utf8'));
  assert.equal(update.outcome, 'up_to_date');
  console.log('PASS update check reads the Runtime record or launcher-owned signed fallback');
  // Stable has no newer signed release. Expose the existing button to exercise
  // its real handler and terminal command against the current signed release.
  await page.evaluate(() => document.querySelector('#update-btn').classList.remove('hidden'));
  await page.click('#update-btn');
  await waitFor(() => page.evaluate(() => document.querySelector('#update-btn').classList.contains('hidden')
    || document.querySelector('#update-btn-label').textContent === 'Retry'), 20 * 60 * 1000, 'Update did not finish');
  assert.notEqual(await page.locator('#update-btn-label').innerText(), 'Retry', await page.locator('#error-text').innerText());
  await status(page, 'running');
  await health(true);
  console.log('PASS Update button runs elastos update and Home is running afterward');
  console.log('NOT EXERCISED signed 2.0.0-to-newer replacement or a System-initiated upgrade because no newer signed Stable release exists');

  await page.click('#power-btn');
  await status(page, 'stopped');
  await health(false);
  await app.close();
  // curl-installed 2.0.0 can have an empty source head CID. Its signed install
  // record still proves the installation and supplies the rollback identity.
  const sourcePath = path.join(data, 'sources.json');
  const sources = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  sources.sources.find((source) => source.name === sources.default_source).head_cid = '';
  fs.writeFileSync(sourcePath, JSON.stringify(sources));
  const binary = path.join(home, '.local', 'bin', 'elastos');
  const external = spawn(binary, ['home', '--browser'], { detached: true, stdio: 'ignore', env: runtimeChildEnv(options.env) });
  console.log(`Started independent Home pid ${external.pid}`);
  let adopted;
  let foreign;
  try {
    await health(true);
    adopted = await electron.launch(options);
    const window = await adopted.firstWindow();
    await status(window, 'running');
    assert.equal(await window.locator('#open-label').innerText(), 'Open my computer');
    console.log('PASS a fresh launcher adopts an already running Home without reinstalling');
    await window.evaluate(() => window.elastos.start());
    const adoptedController = JSON.parse(fs.readFileSync(controllerStatus, 'utf8')).controller_pid;
    process.kill(adoptedController, 'SIGTERM');
    await health(false);
    await status(window, 'stopped');
    await window.click('#open-btn');
    await status(window, 'running');
    await health(true);
    console.log('PASS adopted controller exit reports Stopped and explicit Start starts Home again');
    await window.evaluate(() => window.elastos.install());
    assert.equal((await window.locator('#logs-content').innerText()).includes('Downloading ElastOS'), false);
    console.log('PASS Install adopts a proved 2.0.0 installation with an empty source head CID');
    await window.evaluate(() => window.elastos.update());
    await status(window, 'running');
    await health(true);
    console.log('PASS Update uses the signed installed record when source head CID is unknown and restarts Home');
    await window.click('#power-btn');
    await status(window, 'stopped');
    await health(false);
    console.log('PASS Stop works for the adopted Home');
    await window.click('#open-btn');
    await status(window, 'running');
    await health(true);
    await adopted.close();
    await health(false);
    console.log('PASS Quit and stop Home closes the listener');
    foreign = http.createServer((_request, response) => response.end('OK'));
    await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(8090, '127.0.0.1', resolve); });
    adopted = await electron.launch(options);
    const conflict = await adopted.firstWindow();
    await waitFor(async () => /port 8090/i.test(await conflict.locator('#error-title').innerText())
      && /another program/i.test(await conflict.locator('#error-text').innerText()),
    30000, 'A foreign listener did not get a clear port 8090 message');
    assert.equal(foreign.listening, true);
    console.log('PASS a foreign OK listener gets a clear port 8090 message and is left running');
    await adopted.close();
    assert.equal(foreign.listening, true);
    return adopted;
  } finally {
    if (adopted) await adopted.close().catch(() => {});
    if (foreign) await new Promise((resolve) => foreign.close(resolve));
    // This is the only independently spawned Home. Its ChildProcess object
    // records the pid owned by this test, including an exec into its controller.
    if (external.exitCode === null && external.signalCode === null) external.kill('SIGTERM');
  }
};
