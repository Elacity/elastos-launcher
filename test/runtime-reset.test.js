const assert = require('node:assert/strict');
const fs = require('node:fs');
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
