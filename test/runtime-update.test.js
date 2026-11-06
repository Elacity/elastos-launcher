const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyRuntimeUpdate,
  checkRuntimeUpdate,
  parseHeadCid,
  rollbackRuntime,
  UPDATE_STATUS_UNREADABLE,
} = require('../dist/main/targets/runtimeUpdate');
const { releaseHeadCid } = require('../dist/main/targets');

const SIGNED_HEAD = '{"payload":{"channel":"stable","latest_release_cid":"release-a","release_sha256":"3dcb060f99a9b300ace45ae82ac722189a9740a349fa631bbd7eb1fd9e0dcd36","schema":"elastos.release.head/v1","version":"0.7.1"},"signature":"8a248801f576beb6b053fa2f52637b2d3087f2804e44434c4d18abea47007dd24e81781f8c390d414d1b8b34055a06b81f0bd78dc83afa2ce152b59a8fce1101","signer_did":"did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z"}';
const FIXTURE_DID = 'did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z';
const CID = releaseHeadCid(SIGNED_HEAD);

function verifiedFetch(fetched) {
  return {
    maintainerDid: FIXTURE_DID,
    publisherGateway: 'https://publisher.example',
    fetchText: async (url) => {
      fetched.push(url);
      if (url.endsWith(`/ipfs/${CID}`)) return SIGNED_HEAD;
      throw new Error(`unexpected head url ${url}`);
    },
  };
}

function memoryStore(initial) {
  return {
    value: initial,
    get() { return this.value; },
    set(cid) { this.value = cid; },
  };
}

function status(outcome, offered, latest = '1.2.0', current = '1.0.0') {
  return JSON.stringify({
    schema: 'elastos.update-check/v1',
    outcome,
    current_version: current,
    latest_version: latest,
    offered,
  });
}

test('update --check is read from the status file, not from stdout or the exit code', async () => {
  let reads = 0;
  const current = await checkRuntimeUpdate(async (args) => {
    assert.deepEqual(args, ['update', '--check']);
    return { code: 0, stdout: 'Latest available: 9.9.9\nRun `elastos update` to install.\n', stderr: '' };
  }, () => {
    reads += 1;
    return status('up_to_date', false, '1.0.0');
  });
  assert.equal(current.updateAvailable, false);
  assert.equal(current.latest, '1.0.0');
  assert.equal(reads, 1);

  const newer = await checkRuntimeUpdate(async () => ({
    code: 0,
    stdout: 'Installed release is up to date.\n',
    stderr: '',
  }), () => status('update_available', true, '0.8.0'));
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.latest, '0.8.0');

  const refused = await checkRuntimeUpdate(async () => ({
    code: 0,
    stdout: 'Run `elastos update` to install.\n',
    stderr: '',
  }), () => status('update_available', false, '0.8.0'));
  assert.equal(refused.updateAvailable, false);

  const installedNewer = await checkRuntimeUpdate(async () => ({
    code: 0,
    stdout: '',
    stderr: '',
  }), () => status('installed_newer', true, '0.7.0', '0.8.0'));
  assert.equal(installedNewer.updateAvailable, false);

  await assert.rejects(
    () => checkRuntimeUpdate(async () => ({ code: 0, stdout: 'Run `elastos update` to install.\n', stderr: '' }), () => '{'),
    new RegExp(UPDATE_STATUS_UNREADABLE.replace(/[.]/g, '\\.')),
  );

  let readOnFailure = false;
  await assert.rejects(
    () => checkRuntimeUpdate(async () => ({ code: 1, stdout: 'Installed release is up to date.\n', stderr: 'no source' }), () => {
      readOnFailure = true;
      return status('update_available', true);
    }),
    /no source/,
  );
  assert.equal(readOnFailure, false);
});

test('update stores only a head CID the launcher verified', async () => {
  const calls = [];
  const fetched = [];
  const store = memoryStore(undefined);
  await applyRuntimeUpdate(async (args) => {
    calls.push([...args]);
    if (args[0] === 'source') return { code: 0, stdout: `Channel: canary\nHead CID: ${CID}\n`, stderr: '' };
    return { code: 0, stdout: 'updated\n', stderr: '' };
  }, store, verifiedFetch(fetched));
  assert.deepEqual(calls[0], ['source', 'show']);
  assert.deepEqual(calls[1], ['update', '--yes']);
  assert.equal(store.get(), CID);
  assert.equal(store.get(), parseHeadCid(`Head CID: ${CID}`));
  assert.match(fetched[0], new RegExp(`/ipfs/${CID}$`));

  const evil = memoryStore('QmPrevious');
  const ran = [];
  await assert.rejects(
    () => applyRuntimeUpdate(async (args) => {
      ran.push([...args]);
      return { code: 0, stdout: 'Head CID: QmPrevious\n', stderr: '' };
    }, evil, verifiedFetch([])),
    /did not verify/,
  );
  assert.equal(evil.get(), 'QmPrevious');
  assert.deepEqual(ran, [['source', 'show']]);

  const lookalike = `Qm${'a'.repeat(44)}`;
  let updated = false;
  await assert.rejects(
    () => applyRuntimeUpdate(async (args) => {
      if (args[0] === 'update') updated = true;
      return { code: 0, stdout: `Head CID: ${lookalike}\n`, stderr: '' };
    }, memoryStore(undefined), {
      maintainerDid: FIXTURE_DID,
      publisherGateway: 'https://publisher.example',
      fetchText: async () => SIGNED_HEAD,
    }),
    /did not verify/,
  );
  assert.equal(updated, false);
});

test('rollback uses a verified head CID and refuses a stdout token', async () => {
  const calls = [];
  const fetched = [];
  const store = memoryStore(CID);
  await rollbackRuntime(async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: 'rolled back\n', stderr: '' };
  }, store, verifiedFetch(fetched));
  assert.deepEqual(calls[0], ['update', '--rollback-to', CID, '--yes']);
  assert.match(fetched[0], new RegExp(`/ipfs/${CID}$`));

  await assert.rejects(
    () => rollbackRuntime(async () => ({ code: 0, stdout: '', stderr: '' }), memoryStore(undefined), verifiedFetch([])),
    /no previous ElastOS release/,
  );
  let rolled = false;
  await assert.rejects(
    () => rollbackRuntime(async () => {
      rolled = true;
      return { code: 0, stdout: '', stderr: '' };
    }, memoryStore('QmPrevious'), verifiedFetch([])),
    /did not verify/,
  );
  assert.equal(rolled, false);
});

test('a cancelled update is an error', async () => {
  await assert.rejects(
    () => applyRuntimeUpdate(async (args) => {
      if (args[0] === 'source') return { code: 0, stdout: `Head CID: ${CID}\n`, stderr: '' };
      return { code: 0, stdout: 'Update cancelled.\n', stderr: '' };
    }, memoryStore(undefined), verifiedFetch([])),
    /did not run/,
  );
});
