const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mainFixture, tick } = require('./main-fixture');
const { createLaunchController } = require('../dist/main/launchController');
const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
const gateway = require('../dist/main/targets/runtimeGateway');
const preflight = require('../dist/main/targets/preflight');
const probe = require('../dist/main/targets/runtimeProbe');
const { runtimeDataDir, runtimeComponentsPath, runtimeHostLockPath } = require('../dist/main/targets/runtimePaths');

const portMessage = 'Another app is preventing Home from starting; ElastOS will not close the other app.';

async function fixture(t, staleLock = false) {
  for (const [name, value] of [['platform', 'darwin'], ['arch', 'arm64']]) {
    const original = Object.getOwnPropertyDescriptor(process, name);
    Object.defineProperty(process, name, { value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  // Everything on disk belongs to this clone. The foreign listener uses an OS-assigned port.
  const home = fs.mkdtempSync(path.join(__dirname, '.failure-home-'));
  const directories = [home, path.join(home, 'Library'), path.join(home, 'Library', 'Application Support'), runtimeDataDir('darwin', home)];
  for (const directory of directories.slice(1)) fs.mkdirSync(directory);
  const data = directories.at(-1);
  const components = runtimeComponentsPath(data);
  const lock = runtimeHostLockPath(data);
  const lockText = JSON.stringify({ pid: 4242, role: 'gateway', addr: '127.0.0.1:8090' });
  fs.writeFileSync(components, '{}');
  if (staleLock) fs.writeFileSync(lock, lockText);
  t.after(() => {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    fs.unlinkSync(components);
    for (const directory of directories.reverse()) fs.rmdirSync(directory);
  });
  t.mock.method(os, 'homedir', () => home);
  t.mock.method(process, 'kill', () => { throw new Error('No fixture process is alive or may be signalled'); });
  t.mock.method(preflight, 'collectPreflight', async () => ({ ok: true, checks: [{ id: 'port', level: 'pass', message: '' }] }));
  t.mock.method(probe, 'probeRuntimeInstallation', async () => ({ kind: 'version', version: '2.0.0' }));
  t.mock.method(probe, 'findRuntimeBinary', () => path.join(home, 'elastos'));
  t.mock.method(require('../dist/main/targets/runtimePin'), 'loadActiveRuntimePin', () => ({ version: '2.0.0' }));

  const listener = http.createServer((_request, response) => response.end('OK'));
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = `http://127.0.0.1:${listener.address().port}`;
  t.mock.method(gateway, 'probeGatewayHealth', async () => ({ status: 200, body: 'OK' }));
  t.mock.method(gateway, 'confirmInstalledGateway', async () => false);
  t.mock.method(preflight, 'portBusy', async () => listener.listening);
  t.mock.method(gateway, 'createDefaultGatewaySupervisor', (_file, platform, lifetime) => gateway.createGatewaySupervisor({
    platform, lifetime, binary: path.join(home, 'elastos'), args: ['home', '--browser'], adoptForControls: true,
    fetchHealth: () => gateway.probeGatewayHealth(), adoptInstalled: async () => null,
    spawn() { throw new Error('Must not spawn while a foreign listener is running'); },
    sleep: async () => {}, now: Date.now, openUrl() {}, log() {},
  }));
  t.mock.method(require('../dist/main/targets'), 'createLaunchTarget', () => createRuntimeTarget('darwin', 'arm64', {
    shuttingDown: false, shutdown() { this.shuttingDown = true; },
  }));
  const launch = createLaunchController({ env: {} });
  launch.target.openInBrowser = () => {};
  launch.getOpenAtLogin = () => false;
  launch.resumeInstallPlan = async () => 'none';
  launch.checkForUpdate = async () => null;
  return { launch, listener, url, lock, lockText };
}

for (const staleLock of [true, false]) {
  test(`real controller startup shows its foreign-port error with ${staleLock ? 'a stale lock' : 'no lock'}`, async t => {
    const { launch, listener, url, lock, lockText } = await fixture(t, staleLock);
    const f = await mainFixture({ controller: launch, platform: 'darwin' });
    const state = await f.invoke('getWindowState');
    assert.equal(state.kind, 'error');
    assert.equal(state.message, portMessage);
    assert.equal(state.actionLabel, 'Try Again');
    await f.invoke('retry');
    assert.equal((await f.invoke('getWindowState')).message, portMessage);
    assert.equal(listener.listening, true);
    assert.equal(await (await fetch(url)).text(), 'OK');
    assert.equal(fs.existsSync(lock), staleLock);
    if (staleLock) assert.equal(fs.readFileSync(lock, 'utf8'), lockText);
    f.app.emit('before-quit', { preventDefault() {} });
    for (let attempt = 0; attempt < 100 && !f.calls.includes('quit'); attempt++) await tick();
    assert.ok(f.calls.includes('quit'));
    assert.equal(listener.listening, true);
    assert.equal(await (await fetch(url)).text(), 'OK');
    assert.ok(process.kill.mock.calls.every(call => call.arguments[1] === 0));
  });
}

test('real controller action screen uses the caught error even when a later action replaces lastError', async t => {
  const { launch } = await fixture(t);
  launch.target.getStatus = async () => 'running';
  const f = await mainFixture({ controller: launch, platform: 'darwin' });
  launch.target.stop = async () => { throw new Error('Another program is answering on port 8090. Home was not adopted.'); };
  launch.target.start = async () => { throw new Error('The download failed.'); };
  const collect = preflight.collectPreflight;
  t.mock.method(preflight, 'collectPreflight', async () => {
    await assert.rejects(launch.start(), /download failed/);
    return collect();
  });
  await f.click('Stop Home');
  assert.equal((await f.invoke('getWindowState')).message, portMessage);
  assert.equal((await launch.describeFailure()).message, 'The download stopped.');
  assert.equal((await launch.describeFailure('Another program is answering on port 8090.')).message, portMessage);
});

test('main publishes the actual logger path for e2e diagnostics', async () => {
  delete global.__elastosLogPath;
  await mainFixture();
  assert.equal(global.__elastosLogPath, '/fixture/main.log');
  delete global.__elastosLogPath;
});
