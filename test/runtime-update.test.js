const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyRuntimeUpdate,
  checkRuntimeUpdate,
  parseHeadCid,
  parseUpdateCheck,
  rollbackRuntime,
} = require('../dist/main/targets/runtimeUpdate');

function memoryStore(initial) {
  return {
    value: initial,
    get() { return this.value; },
    set(cid) { this.value = cid; },
  };
}

test('update --check is parsed from stdout, not the exit code', async () => {
  const current = await checkRuntimeUpdate(async (args) => {
    assert.deepEqual(args, ['update', '--check']);
    return { code: 0, stdout: 'Installed release is up to date.\n', stderr: '' };
  });
  assert.equal(current.updateAvailable, false);

  const newer = await checkRuntimeUpdate(async () => ({
    code: 0,
    stdout: 'Latest available: 0.8.0\nRun `elastos update` to install.\n',
    stderr: '',
  }));
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.latest, '0.8.0');
  assert.equal(parseUpdateCheck('Run elastos update to install.').updateAvailable, true);

  await assert.rejects(
    () => checkRuntimeUpdate(async () => ({ code: 1, stdout: 'Installed release is up to date.\n', stderr: 'no source' })),
    /no source/,
  );
});

test('update remembers the head CID and passes --yes', async () => {
  const calls = [];
  const store = memoryStore(undefined);
  await applyRuntimeUpdate(async (args) => {
    calls.push([...args]);
    if (args[0] === 'source') return { code: 0, stdout: 'Channel: canary\nHead CID: QmPrevious\n', stderr: '' };
    return { code: 0, stdout: 'updated\n', stderr: '' };
  }, store);
  assert.deepEqual(calls[0], ['source', 'show']);
  assert.deepEqual(calls[1], ['update', '--yes']);
  assert.equal(store.get(), 'QmPrevious');
  assert.equal(parseHeadCid('Head CID: QmPrevious'), 'QmPrevious');
});

test('rollback uses the stored head CID', async () => {
  const calls = [];
  const store = memoryStore('QmPrevious');
  await rollbackRuntime(async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: 'rolled back\n', stderr: '' };
  }, store);
  assert.deepEqual(calls[0], ['update', '--rollback-to', 'QmPrevious', '--yes']);

  await assert.rejects(
    () => rollbackRuntime(async () => ({ code: 0, stdout: '', stderr: '' }), memoryStore(undefined)),
    /no previous ElastOS release/,
  );
});

test('a cancelled update is an error', async () => {
  await assert.rejects(
    () => applyRuntimeUpdate(async (args) => {
      if (args[0] === 'source') return { code: 0, stdout: 'Head CID: QmPrevious\n', stderr: '' };
      return { code: 0, stdout: 'Update cancelled.\n', stderr: '' };
    }, memoryStore(undefined)),
    /did not run/,
  );
});
