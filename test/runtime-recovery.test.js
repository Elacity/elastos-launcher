const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyFix,
  assertStaleLockPath,
  failureScreen,
  recheckPortWith,
} = require('../dist/main/targets/runtimeRecovery');
const { runtimeDataDir, runtimeHostLockPath } = require('../dist/main/targets/runtimePaths');

const LOCK = runtimeHostLockPath(runtimeDataDir(process.platform, os.homedir(), process.env));
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

test('an offline failure does not install', async () => {
  const input = facts({
    checks: [{ id: 'network', level: 'block', message: 'You appear to be offline.' }],
  });
  const screen = failureScreen(input);
  assert.equal(screen.kind, 'offline');
  assert.equal(screen.title, 'You are offline');
  assert.equal(screen.fixLabel, 'Try Again');
  assert.equal(screen.retryLabel, 'Try Again');
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
  assert.match(screen.message, /Another app is preventing Home from starting/);
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

  let confirms = 0;
  assert.equal(await recheckPortWith({
    portBusy: async () => false,
    confirm: async () => { confirms += 1; return true; },
  }), 'free');
  assert.equal(confirms, 0);
  assert.equal(await recheckPortWith({
    portBusy: async () => true,
    confirm: async () => false,
  }), 'busy');
  assert.equal(await recheckPortWith({
    portBusy: async () => true,
    confirm: async () => true,
  }), 'ours');
  assert.equal(await recheckPortWith({
    portBusy: async () => true,
    confirm: async () => { throw new Error('lock'); },
  }), 'busy');
});

test('an interrupted install continues setup and does not download', async () => {
  const input = facts({ binaryPresent: true, componentsPresent: false });
  const screen = failureScreen(input);
  assert.equal(screen.kind, 'interrupted');
  assert.equal(screen.message, 'ElastOS setup did not finish.');
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
  assert.match(screen.message, /did not close properly/);
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

  const foreign = path.join('/home/tester/.other/elastos', 'host-process.lock');
  await assert.rejects(
    () => applyFix(facts({ lockText: LOCK_TEXT, lockPath: foreign, pidAlive: () => false }), deps()),
    /ElastOS data directory/,
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
  assert.match(stack.message, /ElastOS could not finish/);
  assert.equal(stack.message.includes('app.js'), false);
  const plain = failureScreen(facts({ error: 'The download stopped.' }));
  assert.equal(plain.message, 'The download stopped.');
});

test('every failure screen uses short plain copy with safety facts and a verb action', () => {
  const inputs = [
    facts({ checks: [{ id: 'network', level: 'block', message: 'offline' }] }),
    facts({ checks: [{ id: 'port', level: 'block', message: 'Port 8090 is busy' }] }),
    facts({ binaryPresent: true }),
    facts({ lockText: LOCK_TEXT }),
    facts({ checks: [{ id: 'windows', level: 'block', message: 'WSL JSON internals. Click Fix it.' }] }),
    facts({ error: 'Release head is not valid JSON.' }),
    facts({ error: 'Unexpected token in JSON at /private/secret' }),
    facts({ error: 'Your computer is already running.' }),
    facts({ error: 'Restart Windows. When you open ElastOS again, Install continues.' }),
    facts({ error: 'ElastOS did not reset /private/data. This folder has no signed ElastOS install record. Click Fix it.' }),
  ];
  for (const input of inputs) {
    const screen = failureScreen(input);
    assert.match(screen.message, /^[^.?!\n]+[.!?](?: [^.?!\n]+[.!?])?$/, screen.kind);
    assert.doesNotMatch(`${screen.title} ${screen.message}`, /port|lock|session|signed|JSON|WSL|\/private|click|already running|commands/i);
    assert.equal(screen.retryLabel, 'Try Again');
    if (screen.fixLabel) assert.equal(screen.fixLabel, 'Try Again');
  }
});

test('the no-record screen keeps Home data and says nothing was deleted', () => {
  const screen = failureScreen(facts({ error: 'This folder has no signed ElastOS install record.' }));
  assert.equal(screen.kind, 'no-record');
  assert.match(screen.message, /Home data is kept/);
  assert.match(screen.message, /nothing was deleted/i);
});

test('the backup refusal screen says nothing was deleted', () => {
  for (const error of [
    'ElastOS was not reset. A copy of your data cannot be saved here. Nothing was deleted.',
    'ElastOS was not reset. The copy of your data could not be saved (disk full). Nothing was deleted.',
    'ElastOS was not reset. There is not enough free space for a copy of your data. Nothing was deleted.',
  ]) {
    const screen = failureScreen(facts({ error }));
    assert.match(screen.message, /ElastOS could not finish/);
    assert.match(screen.message, /nothing was deleted/i);
  }
});

test('the busy port screen says ElastOS will not close the other app', () => {
  const screen = failureScreen(facts({ checks: [{ id: 'port', level: 'block', message: 'busy' }] }));
  assert.match(screen.message, /ElastOS will not close the other app/);
});

test('the stale lock screen says a running Home is left alone', () => {
  const screen = failureScreen(facts({ lockText: LOCK_TEXT }));
  assert.match(screen.message, /a running Home is left alone/);
});
