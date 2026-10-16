const assert = require('node:assert/strict');
const fs = require('node:fs');
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

  const mixed = scrubSupportText(
    'gateway said hello attach_secret=sekrit token=abc cookie=sid api_key=k authorization=raw '
    + 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozvgIdlkvz_7r_3n5h1p0s',
  );
  assert.match(mixed, /gateway said hello/);
  assert.equal(mixed.includes('sekrit'), false);
  assert.equal(mixed.includes('token=abc'), false);
  assert.equal(mixed.includes('sid'), false);
  assert.equal(mixed.includes('api_key=k'), false);
  assert.equal(mixed.includes('raw'), false);
  assert.equal(mixed.includes('eyJ'), false);
  assert.match(mixed, /attach_secret=\[removed\]/);

  const cid = 'QmXuy56RTFzXaifTuyCbMb6Ky1p5wuM9iP8eFbMghHxWij';
  const did = 'did:key:z6MkgwHd2BCWe1jHMXPiR6H1q1RFPcv1YzhMbK5G1kBarbfe';
  const token = 'aB3dE6fG9hJ2kL5mN8pQ1rS4tU7vW0';
  const unlabeled = scrubSupportText(`${cid} ${did}\n${token}\nsecret-line\ngateway said hello`);
  assert.match(unlabeled, new RegExp(cid));
  assert.match(unlabeled, new RegExp(did.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(unlabeled.includes(token), false);
  assert.match(unlabeled, /secret-line/);
  assert.match(unlabeled, /gateway said hello/);
  assert.match(unlabeled, /\[removed\]/);
});

test('save support bundle writes only ElastOS-support.txt outside the data dirs', () => {
  const home = '/home/tester';
  const desktop = path.join(home, 'Desktop');
  const file = supportBundlePath(home, true);
  assert.equal(file, path.join(desktop, 'ElastOS-support.txt'));
  const written = new Map();
  saveSupportBundle(file, 'launcher: 1.4.0\nattach_secret=sekrit\n', (target, contents) => {
    written.set(target, contents);
  }, home, 'linux');
  assert.equal(written.get(file).includes('sekrit'), false);
  assert.match(written.get(file), /launcher: 1\.4\.0/);

  const dotted = [];
  const dottedDesktop = 'C:/Users/jane.doe/Desktop/ElastOS-support.txt';
  saveSupportBundle(dottedDesktop, 'launcher: 1.4.0\n', (target) => { dotted.push(target); }, 'C:/Users/jane.doe', 'win32');
  assert.deepEqual(dotted, [dottedDesktop]);

  assert.throws(
    () => saveSupportBundle(path.join(home, '.local/share/elastos/ElastOS-support.txt'), 'x', () => {}, home, 'linux'),
    /ElastOS data directory/,
  );
  assert.throws(
    () => saveSupportBundle(path.join(home, '.other/ElastOS-support.txt'), 'x', () => {}, home, 'linux'),
    /ElastOS data directory/,
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
