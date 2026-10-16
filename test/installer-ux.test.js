const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildDiagnostics,
  evaluatePreflight,
  DISK_FLOOR_BYTES,
  publisherHost,
  publisherOffline,
} = require('../dist/main/targets/preflight');
const { linuxAutostartFile, syncLinuxAutostart } = require('../dist/main/targets/openAtLogin');
const flow = require('../src/renderer/flow.js');

const base = {
  platform: 'linux',
  arch: 'x64',
  freeBytes: DISK_FLOOR_BYTES,
  portBusy: false,
  healthOk: false,
  offline: false,
  wsl: false,
  kvm: true,
};

test('preflight blocks disk, offline, a busy port, and Intel Mac', () => {
  assert.equal(evaluatePreflight(base).ok, true);

  const disk = evaluatePreflight({ ...base, freeBytes: 10 });
  assert.equal(disk.ok, false);
  assert.match(disk.checks.find((check) => check.id === 'disk').message, /2 GB/);

  const offline = evaluatePreflight({ ...base, offline: true });
  assert.match(offline.checks.find((check) => check.id === 'network').message, /offline/);

  const port = evaluatePreflight({ ...base, portBusy: true, healthOk: false });
  assert.match(port.checks.find((check) => check.id === 'port').message, /8090/);

  const already = evaluatePreflight({ ...base, portBusy: true, healthOk: true });
  assert.equal(already.checks.find((check) => check.id === 'port').level, 'pass');

  const intel = evaluatePreflight({ ...base, platform: 'darwin', arch: 'x64' });
  assert.match(intel.checks.find((check) => check.id === 'platform').message, /Intel Macs/);

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
  assert.match(linuxAutostartFile('/usr/bin/elastos'), /Exec=\/usr\/bin\/elastos/);
  assert.equal(syncLinuxAutostart(false, '/home/tester', '/usr/bin/elastos', fs), null);
  assert.equal(files.size, 0);
});

test('the install button is the primary action until the computer is healthy', () => {
  assert.equal(flow.primaryAction({ targetId: 'runtime', status: 'not-installed', busy: false }).label, 'Install');
  assert.equal(flow.primaryAction({ targetId: 'runtime', status: 'running', busy: false }).label, 'Open my computer');
  assert.equal(flow.primaryAction({ targetId: 'runtime', status: 'error', busy: false }).id, 'retry');
  assert.match(flow.firstRunCopy('runtime', 'not-installed'), /One button/);
  assert.equal(flow.firstRunCopy('runtime', 'running'), '');
  const copy = flow.confirmCopy('runtime', []);
  assert.match(copy.title, /ElastOS/);
  assert.match(copy.body, /removes the ElastOS program/);
  const steps = flow.stepStates('Downloading ElastOS (about 1 minute)');
  assert.equal(steps[1].state, 'active');
  assert.equal(steps[0].state, 'done');
  assert.equal(flow.urlLabel('http://127.0.0.1:8090/home/'), '127.0.0.1:8090/home');
});
