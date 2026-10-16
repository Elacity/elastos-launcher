const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildDiagnostics,
  saveSupportBundle,
  scrubSupportText,
  supportBundlePath,
} = require('../dist/main/targets/preflight');

test('the support bundle has versions, health, and platform, and no secrets', () => {
  const text = buildDiagnostics({
    launcherVersion: '1.4.0',
    runtimeVersion: 'ElastOS Runtime v0.8.0-alpha.20',
    target: 'runtime',
    channel: 'canary',
    pinVersion: '0.8.0-alpha.20',
    platform: 'linux',
    arch: 'arm64',
    status: 'error',
    health: 'not answering',
    error: 'The download stopped. password=hunter2',
    logs: [
      'gateway-runtime-coords.json attach_secret=sekrit',
      'Authorization: Bearer tok-123',
      '-----BEGIN PRIVATE KEY-----',
      'secret-line',
      'gateway said hello',
    ].join('\n'),
    checks: [{ id: 'network', level: 'block', message: 'You appear to be offline.' }],
  });
  assert.match(text, /launcher: 1\.4\.0/);
  assert.match(text, /runtime: ElastOS Runtime v0\.8\.0-alpha\.20/);
  assert.match(text, /health: not answering/);
  assert.match(text, /computer: linux\/arm64/);
  assert.match(text, /channel: canary/);
  assert.match(text, /gateway said hello/);
  assert.equal(text.includes('sekrit'), false);
  assert.equal(text.includes('tok-123'), false);
  assert.equal(text.includes('hunter2'), false);
  assert.equal(text.includes('BEGIN PRIVATE KEY'), false);
  assert.match(text, /bearer \[removed\]/);
  assert.match(text, /password \[removed\]/);
  assert.equal(scrubSupportText('attach_secret=nope').includes('nope'), false);
});

test('save support bundle writes only ElastOS-support.txt outside the data dirs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-support-'));
  const desktop = path.join(home, 'Desktop');
  fs.mkdirSync(desktop);
  const file = supportBundlePath(home, true);
  assert.equal(file, path.join(desktop, 'ElastOS-support.txt'));
  const written = new Map();
  saveSupportBundle(file, 'launcher: 1.4.0\nattach_secret=sekrit\n', (target, contents) => {
    written.set(target, contents);
  });
  assert.equal(written.get(file).includes('sekrit'), false);
  assert.match(written.get(file), /launcher: 1\.4\.0/);

  assert.throws(
    () => saveSupportBundle(path.join(home, '.local/share/elastos/ElastOS-support.txt'), 'x', () => {}),
    /ElastOS or PC2/,
  );
  assert.throws(
    () => saveSupportBundle(path.join(home, '.pc2/ElastOS-support.txt'), 'x', () => {}),
    /ElastOS or PC2/,
  );
  assert.throws(
    () => saveSupportBundle(path.join(desktop, 'notes.txt'), 'x', () => {}),
    /another name/,
  );

  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(html, /id="support-btn"/);
  assert.match(html, /Save support bundle/);
  assert.match(app, /saveSupportBundle/);
});
