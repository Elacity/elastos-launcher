const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resetRuntime } = require('../dist/main/targets/runtimeUninstall');
const { launcherOwnedDirectories } = require('../dist/main/targets/runtimePaths');
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

test('a dotted account name is still a launcher path', async () => {
  assert.equal(launcherOwnedDirectories('/Users/jane.doe/.local/bin/elastos'), true);
  assert.equal(launcherOwnedDirectories('/home/jane.doe/.local/share/elastos'), true);
  assert.equal(launcherOwnedDirectories('/Users/jane.doe/Library/Application Support/elastos'), true);
  assert.equal(launcherOwnedDirectories('C:/Users/jane.doe/Desktop/ElastOS-support.txt'), true);
  assert.equal(launcherOwnedDirectories('/home/jane.doe/.pc2/note'), false);
  assert.equal(launcherOwnedDirectories('/home/tester/.other/elastos'), false);
  assert.equal(launcherOwnedDirectories('C:/Users/tester/.other/elastos'), false);

  const removed = [];
  await resetRuntime({
    binary: '/home/jane.doe/.local/bin/elastos',
    dataDir: '/home/jane.doe/.local/share/elastos',
    stageFile: '/home/jane.doe/.elastos-launcher/install-stage.json',
    stop: async () => {},
    remove: (target) => { removed.push(target); },
  });
  assert.deepEqual(removed, [
    '/home/jane.doe/.local/bin/elastos',
    '/home/jane.doe/.local/share/elastos',
    '/home/jane.doe/.elastos-launcher/install-stage.json',
  ]);
});

test('reset refuses a foreign directory, a live foreign host, and a misnamed stage file', async () => {
  const remove = () => { throw new Error('should not remove'); };
  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.other/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    stop: async () => {},
    remove,
  }), /not the ElastOS data directory/);

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

test('reset refuses a symlink and a dotted foreign directory', async () => {
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
    dataDir: 'C:/Users/tester/.other/elastos',
    stageFile: path.join(root, 'install-stage.json'),
    stop: async () => { throw new Error('stop should not run'); },
    remove: (target) => { removed.push(target); },
  }), /not the ElastOS data directory/);
  assert.deepEqual(removed, []);

  const inspected = [];
  await assert.rejects(() => resetRuntime({
    binary: path.join(root, 'elastos'),
    dataDir: data,
    stageFile: path.join(root, 'install-stage.json'),
    stop: async () => {},
    remove: (target) => { removed.push(target); },
    lstat: (file) => {
      inspected.push(file);
      const error = new Error('permission');
      error.code = 'EACCES';
      throw error;
    },
  }), /could not be inspected/);
  assert.deepEqual(removed, []);
});
