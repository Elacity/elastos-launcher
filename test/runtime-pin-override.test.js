const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadRuntimePinFile,
  pinLoadMode,
  runtimePinCandidates,
} = require('../dist/main/targets/runtimePin');

function writePin(pin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-pin-'));
  const file = path.join(dir, 'pin.json');
  fs.writeFileSync(file, JSON.stringify(pin));
  return file;
}

test('production ignores an environment pin that replaces the trust root', () => {
  const packaged = loadRuntimePinFile({}, 'production');
  const evil = writePin({ ...packaged, maintainerDid: 'did:key:zevil' });
  assert.equal(pinLoadMode({}), 'production');
  assert.equal(pinLoadMode({ NODE_TEST_CONTEXT: 'child' }), 'dev');
  assert.equal(runtimePinCandidates({ ELASTOS_RUNTIME_PIN: evil }, 'production').includes(evil), false);

  assert.throws(
    () => loadRuntimePinFile({ ELASTOS_RUNTIME_PIN: evil }, 'production'),
    /cannot replace the packaged trust root/,
  );
  assert.equal(loadRuntimePinFile({ ELASTOS_RUNTIME_PIN: evil }, 'dev').maintainerDid, 'did:key:zevil');

  const moved = writePin({
    ...packaged,
    channels: {
      ...packaged.channels,
      canary: { ...packaged.channels.canary, headCid: 'QmEvilHeadNotInThePackage' },
    },
  });
  assert.throws(
    () => loadRuntimePinFile({ ELASTOS_RUNTIME_PIN: moved }, 'production'),
    /cannot replace the packaged trust root/,
  );

  const emptyStable = writePin({ ...packaged, active: 'stable' });
  assert.throws(
    () => loadRuntimePinFile({ ELASTOS_RUNTIME_PIN: emptyStable }, 'production'),
    /cannot replace the packaged trust root/,
  );

  const same = writePin(packaged);
  const loaded = loadRuntimePinFile({ ELASTOS_RUNTIME_PIN: same }, 'production');
  assert.equal(loaded.maintainerDid, packaged.maintainerDid);
  assert.equal(loaded.installerSha256, packaged.installerSha256);
  assert.equal(loaded.channels.canary.headCid, packaged.channels.canary.headCid);
});
