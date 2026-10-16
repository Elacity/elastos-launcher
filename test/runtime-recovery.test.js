const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  applyFix,
  assertStaleLockPath,
  failureScreen,
} = require('../dist/main/targets/runtimeRecovery');

const LOCK = path.join('/home/tester/.local/share/elastos', 'host-process.lock');
const LOCK_TEXT = JSON.stringify({ pid: 4242, role: 'gateway', addr: '127.0.0.1:8090' });

function facts(overrides = {}) {
  return {
    error: '',
    checks: [],
    binaryPresent: false,
    componentsPresent: false,
    lockText: null,
    lockPath: null,
    pidAlive: () => false,
    ...overrides,
  };
}

function deps(overrides = {}) {
  const calls = [];
  const world = {
    calls,
    recheckPort: async () => {
      calls.push('port');
      return 'busy';
    },
    recheckOnline: async () => {
      calls.push('online');
      return false;
    },
    resumeSetup: async () => {
      calls.push('setup');
    },
    removeLock: (file) => {
      calls.push(['remove', file]);
    },
    download: () => {
      throw new Error('Fix it must not download');
    },
    kill: () => {
      throw new Error('Fix it must not kill another program');
    },
    ...overrides,
  };
  return world;
}

test('the error screen offers Try again and Fix it', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(html, /id="error-title"/);
  assert.match(html, /id="fix-btn"/);
  assert.match(html, />Fix it</);
  assert.match(html, />Try again</);
  assert.match(app, /describeFailure/);
  assert.match(app, /fixFailure/);
});

test('an offline failure does not install', async () => {
  const input = facts({
    checks: [{ id: 'network', level: 'block', message: 'You appear to be offline.' }],
  });
  const screen = failureScreen(input);
  assert.equal(screen.kind, 'offline');
  assert.equal(screen.title, 'You are offline');
  assert.equal(screen.fixLabel, 'Fix it');
  assert.equal(screen.retryLabel, 'Try again');
  const blocked = deps();
  assert.equal(await applyFix(input, blocked), 'still-blocked');
  assert.deepEqual(blocked.calls, ['online']);
  const online = deps({
    recheckOnline: async () => true,
  });
  assert.equal(await applyFix(input, online), 'ready');
});

test('a busy port is not cleared by killing another program', async () => {
  const input = facts({
    checks: [{ id: 'port', level: 'block', message: 'Port 8090 is being used by another program.' }],
  });
  const screen = failureScreen(input);
  assert.equal(screen.kind, 'port');
  assert.match(screen.message, /will not close other programs/);
  const busy = deps();
  assert.equal(await applyFix(input, busy), 'still-blocked');
  assert.deepEqual(busy.calls, ['port']);
  const free = deps({
    recheckPort: async () => 'free',
  });
  assert.equal(await applyFix(input, free), 'ready');
  const ours = deps({
    recheckPort: async () => 'ours',
  });
  assert.equal(await applyFix(input, ours), 'ready');
});

test('an interrupted install continues setup and does not download', async () => {
  const input = facts({ binaryPresent: true, componentsPresent: false });
  const screen = failureScreen(input);
  assert.equal(screen.kind, 'interrupted');
  assert.match(screen.message, /check the signed release again/);
  assert.match(screen.message, /installer is not downloaded again/);
  const world = deps();
  assert.equal(await applyFix(input, world), 'ready');
  assert.deepEqual(world.calls, ['setup']);
  const missing = deps();
  assert.equal(await applyFix(facts({ error: 'interrupted install' }), missing), 'still-blocked');
  assert.deepEqual(missing.calls, []);
});

test('a stale host lock is removed and a live one is left alone', async () => {
  const stale = facts({ lockText: LOCK_TEXT, lockPath: LOCK, pidAlive: () => false });
  const screen = failureScreen(stale);
  assert.equal(screen.kind, 'stale-lock');
  assert.match(screen.message, /left alone/);
  const world = deps();
  assert.equal(await applyFix(stale, world), 'ready');
  assert.deepEqual(world.calls, [['remove', LOCK]]);

  const live = facts({
    lockText: LOCK_TEXT,
    lockPath: LOCK,
    pidAlive: () => true,
    error: 'another ElastOS host already owns this data directory',
  });
  assert.equal(failureScreen(live).fixLabel, null);
  const untouched = deps();
  assert.equal(await applyFix(live, untouched), 'still-blocked');
  assert.deepEqual(untouched.calls, []);

  const pc2 = path.join('/home/tester/.pc2/elastos', 'host-process.lock');
  await assert.rejects(
    () => applyFix(facts({ lockText: LOCK_TEXT, lockPath: pc2, pidAlive: () => false }), deps()),
    /PC2/,
  );
  assert.throws(
    () => assertStaleLockPath(path.join('/home/tester/.local/share/elastos', 'sources.json')),
    /host lock/,
  );
});

test('deleting a stale lock re-reads the file and the pid', () => {
  const { removeStaleLockNow } = require('../dist/main/targets/runtimeRecovery');
  const stats = [{ dev: 1, ino: 2, isSymbolicLink: () => false }];
  let text = LOCK_TEXT;
  let alive = false;
  const unlinked = [];
  const deps = {
    readFile: () => text,
    lstat: () => stats[0],
    pidAlive: () => alive,
    unlink: (file) => { unlinked.push(file); },
  };
  alive = true;
  assert.throws(() => removeStaleLockNow(LOCK, deps), /running ElastOS/);
  assert.deepEqual(unlinked, []);

  alive = false;
  stats[0] = { dev: 1, ino: 2, isSymbolicLink: () => true };
  assert.throws(() => removeStaleLockNow(LOCK, deps), /symlink/);
  assert.deepEqual(unlinked, []);

  let reads = 0;
  stats[0] = { dev: 1, ino: 2, isSymbolicLink: () => false };
  assert.throws(() => removeStaleLockNow(LOCK, {
    readFile: () => LOCK_TEXT,
    lstat: () => {
      reads += 1;
      return { dev: 1, ino: reads, isSymbolicLink: () => false };
    },
    pidAlive: () => false,
    unlink: () => { unlinked.push('changed'); },
  }), /lock changed/);
  assert.deepEqual(unlinked, []);

  stats[0] = { dev: 1, ino: 2, isSymbolicLink: () => false };
  removeStaleLockNow(LOCK, deps);
  assert.deepEqual(unlinked, [LOCK]);
});

test('a secret or a stack trace is not the error screen', () => {
  const secret = failureScreen(facts({ error: 'wrote attach_secret=sekrit into the log' }));
  assert.equal(secret.fixLabel, null);
  assert.equal(secret.message.includes('sekrit'), false);
  const stack = failureScreen(facts({ error: '    at run (/tmp/app.js:10:1)' }));
  assert.match(stack.message, /Try again/);
  assert.equal(stack.message.includes('app.js'), false);
  const plain = failureScreen(facts({ error: 'The download stopped.' }));
  assert.equal(plain.message, 'The download stopped.');
});
