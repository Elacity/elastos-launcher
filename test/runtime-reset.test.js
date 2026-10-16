const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resetRuntime } = require('../dist/main/targets/runtimeUninstall');
const flow = require('../src/renderer/flow.js');

test('reset removes the runtime program, data, and unfinished install', async () => {
  const removed = [];
  const calls = [];
  await resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    stop: async () => { calls.push('stop'); },
    remove: (target) => {
      calls.push(target);
      removed.push(target);
    },
  });
  assert.deepEqual(calls, [
    'stop',
    '/home/tester/.local/bin/elastos',
    '/home/tester/.local/share/elastos',
    '/home/tester/.elastos-launcher/install-stage.json',
  ]);
  assert.deepEqual(removed, calls.slice(1));
});

test('reset refuses PC2, a live foreign host, and a misnamed stage file', async () => {
  const remove = () => { throw new Error('should not remove'); };
  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.pc2/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    stop: async () => {},
    remove,
  }), /PC2 directory/);

  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    stop: async () => {
      throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
    },
    remove,
  }), /another window/);

  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    stageFile: '/home/tester/.elastos-launcher/secrets.txt',
    stop: async () => { throw new Error('stop should not run'); },
    remove,
  }), /install stage/);

  const copy = flow.resetCopy();
  assert.equal(copy.title, 'Reset ElastOS?');
  assert.match(copy.body, /install it again/);
  assert.equal(/terminal|sudo|powershell/i.test(copy.body), false);
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(html, /id="reset-btn"/);
  assert.match(app, /resetRuntime/);
  assert.match(app, /resetCopy/);
});

test('reset refuses a symlink and a forward-slash PC2 path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-reset-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-outside-'));
  const data = path.join(root, 'elastos');
  fs.mkdirSync(data);
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link);
  const removed = [];
  await assert.rejects(() => resetRuntime({
    binary: path.join(link, 'elastos'),
    dataDir: data,
    stageFile: path.join(root, 'install-stage.json'),
    stop: async () => {},
    remove: (target) => { removed.push(target); },
  }), /symlink/);
  assert.deepEqual(removed, []);

  await assert.rejects(() => resetRuntime({
    binary: path.join(root, 'elastos'),
    dataDir: 'C:/Users/tester/.pc2/elastos',
    stageFile: path.join(root, 'install-stage.json'),
    stop: async () => { throw new Error('stop should not run'); },
    remove: (target) => { removed.push(target); },
  }), /PC2/);
  assert.deepEqual(removed, []);
});
