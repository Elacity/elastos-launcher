const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildDiagnostics,
  evaluatePreflight,
  DISK_FLOOR_BYTES,
  LOCALHOST_MESSAGE,
  portBusy,
  tryListen,
  publisherHost,
  publisherOffline,
} = require('../dist/main/targets/preflight');
const { linuxAutostartFile, linuxAutostartExecPath, syncLinuxAutostart } = require('../dist/main/targets/openAtLogin');

const base = { platform: 'linux', arch: 'x64', freeBytes: DISK_FLOOR_BYTES, portBusy: false, healthOk: false, offline: false, wsl: false, kvm: true };

test('preflight blocks disk, offline, a busy port, and Intel Mac', () => {
  assert.equal(evaluatePreflight(base).ok, true);

  const disk = evaluatePreflight({ ...base, freeBytes: 10 });
  assert.equal(disk.ok, false);
  assert.match(disk.checks.find((check) => check.id === 'disk').message, /2 GB/);

  const offline = evaluatePreflight({ ...base, offline: true });
  assert.match(offline.checks.find((check) => check.id === 'network').message, /internet/);

  const port = evaluatePreflight({ ...base, portBusy: true, healthOk: false });
  assert.match(port.checks.find((check) => check.id === 'port').message, /Another app/);

  const already = evaluatePreflight({ ...base, portBusy: true, healthOk: true });
  assert.equal(already.checks.find((check) => check.id === 'port').level, 'pass');

  const intel = evaluatePreflight({ ...base, platform: 'darwin', arch: 'x64' });
  assert.equal(intel.checks.find((check) => check.id === 'platform').message, 'Intel Mac is not supported yet.');

  const kvm = evaluatePreflight({ ...base, wsl: true, kvm: false });
  assert.equal(kvm.ok, true);
  assert.match(kvm.checks.find((check) => check.id === 'kvm').message, /\/dev\/kvm/);
});

test('cold preflight does not connect to the publisher', async () => {
  assert.equal(publisherHost('https://elastos.elacitylabs.com'), 'elastos.elacitylabs.com');
  const seen = [];
  assert.equal(await publisherOffline('https://elastos.elacitylabs.com/ignored', async (host, port) => {
    seen.push({ host, port });
    return true;
  }), false);
  assert.deepEqual(seen, [{ host: 'elastos.elacitylabs.com', port: 443 }]);
  assert.equal(await publisherOffline('https://elastos.elacitylabs.com', async () => false), true);
  assert.equal(await publisherOffline('not a url', async () => true), true);

  const source = fs.readFileSync(path.join(__dirname, '../src/main/targets/preflight.ts'), 'utf8');
  const collect = source.match(/export async function collectPreflight[\s\S]*?\n\}/);
  assert.ok(collect, 'collectPreflight');
  assert.equal(collect[0].includes('publisherOffline'), false);
  assert.equal(collect[0].includes('release-head.json'), false);
  assert.equal(collect[0].includes('fetch('), false);
  assert.equal(collect[0].includes('net.connect'), false);
  const probe = source.match(/export async function publisherOffline[\s\S]*?\n\}/);
  assert.ok(probe, 'publisherOffline');
  assert.equal(probe[0].includes('release-head.json'), false);
  assert.equal(probe[0].includes('fetch('), false);
});

test('diagnostics leave out local secrets', () => {
  const text = buildDiagnostics({
    launcherVersion: '1.2.7',
    target: 'runtime',
    channel: 'canary',
    pinVersion: '0.8.0-alpha.20',
    platform: 'linux',
    arch: 'x64',
    status: 'error',
    error: 'The download stopped.',
    logs: 'gateway-runtime-coords.json attach_secret=sekrit',
    checks: [],
  });
  assert.equal(text.includes('sekrit'), false);
  assert.match(text, /canary/);
  assert.match(text, /The download stopped/);
});

test('sign-in launch writes a desktop file and can remove it', () => {
  const files = new Map();
  const fs = {
    mkdirp() {},
    writeFile(file, contents) { files.set(file, contents); },
    remove(file) { files.delete(file); },
  };
  const written = syncLinuxAutostart(true, '/home/tester', '/usr/bin/elastos', fs);
  assert.match(files.get(written), /Name=ElastOS/);
  assert.match(files.get(written), /X-GNOME-Autostart-enabled=true/);
  assert.match(linuxAutostartFile('/usr/bin/elastos'), /Exec=\/usr\/bin\/elastos --login\n/);
  assert.equal(
    linuxAutostartExecPath({ APPIMAGE: '/home/me/ElastOS.AppImage' }, '/tmp/.mount_abc/elastos'),
    '/home/me/ElastOS.AppImage',
  );
  assert.equal(linuxAutostartExecPath({ APPIMAGE: '  ' }, '/usr/bin/elastos'), '/usr/bin/elastos');
  assert.match(linuxAutostartFile('/home/me/ElastOS App.AppImage'), /Exec="\/home\/me\/ElastOS App\.AppImage"/);
  assert.match(linuxAutostartFile('/home/me/ElastOS-$APP.AppImage'), /Exec="\/home\/me\/ElastOS-\\\$APP\.AppImage"/);
  assert.equal(syncLinuxAutostart(false, '/home/tester', '/usr/bin/elastos', fs), null);
  assert.equal(files.size, 0);
});

test('the port check covers 127.0.0.1 and ::1, and a host without IPv6 checks 127.0.0.1 only', async () => {
  const asked = [];
  const answer = (map) => async (port, host) => { asked.push(host); return map[host]; };
  assert.equal(await portBusy(8090, undefined, answer({ '127.0.0.1': 'free', '::1': 'free' })), false);
  assert.deepEqual(asked, ['127.0.0.1', '::1']);
  // Tamper: another program holds ::1:8090 only. The browser can land there for localhost.
  assert.equal(await portBusy(8090, undefined, answer({ '127.0.0.1': 'free', '::1': 'busy' })), true);
  assert.equal(await portBusy(8090, undefined, answer({ '127.0.0.1': 'busy', '::1': 'free' })), true);
  assert.equal(await portBusy(8090, undefined, answer({ '127.0.0.1': 'free', '::1': 'no-address' })), false);
});

test('a real listener on 127.0.0.1 makes the port busy', async () => {
  const net = require('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
  try {
    const port = server.address().port;
    assert.equal(await tryListen(port, '127.0.0.1'), 'busy');
    assert.equal(await portBusy(port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('preflight blocks when localhost does not point to this computer', () => {
  const good = evaluatePreflight({ ...base, localhostAddresses: ['::1', '127.0.0.1'] });
  assert.equal(good.checks.find((check) => check.id === 'localhost').level, 'pass');
  for (const bad of [['127.0.0.1', '192.168.1.9'], [], null]) {
    const report = evaluatePreflight({ ...base, localhostAddresses: bad });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.id === 'localhost').message, LOCALHOST_MESSAGE);
  }
  assert.equal(evaluatePreflight(base).checks.some((check) => check.id === 'localhost'), false);
});

test('passing preflight checks say nothing and failures use one plain sentence', () => {
  for (const input of [base, { ...base, healthOk: true }, { ...base, networkChecked: false },
    { ...base, platform: 'darwin', arch: 'arm64' },
    { ...base, platform: 'win32', wslInstalled: true, distroReady: true }]) {
    for (const check of evaluatePreflight(input).checks) {
      if (check.level === 'pass') assert.equal(check.message, '', check.id);
    }
  }
  for (const input of [{ ...base, portBusy: true }, { ...base, offline: true }, { ...base, freeBytes: 0 },
    { ...base, platform: 'win32' }, { ...base, localhostAddresses: [] }]) {
    for (const check of evaluatePreflight(input).checks.filter(check => check.level === 'block')) {
      assert.match(check.message, /^[^.?!\n]+[.!?]$/, check.id);
      assert.doesNotMatch(check.message, /\bport\b|\block\b|JSON|commands|click|hosts file/i);
    }
  }
});
