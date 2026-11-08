const crypto = require('node:crypto');
const { releaseHeadCid, canonicalJson } = require('../../dist/main/targets/releaseHead');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
function base58(bytes) {
  let number = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while (number) { out = alphabet[Number(number % 58n)] + out; number /= 58n; }
  return out;
}
const FIXTURE_DID = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), publicBytes]))}`;
const FIXTURE_VERSION = '2.0.0';
const FIXTURE_RELEASE_CID = 'release-a';
const SCRIPT = '#!/bin/bash\necho stamped-installer\n';
const SCRIPT_SHA = crypto.createHash('sha256').update(SCRIPT).digest('hex');
function signed(payload, domain) {
  const digest = crypto.createHash('sha256').update(`${domain}\0${canonicalJson(payload)}`).digest();
  return JSON.stringify({ payload, signature: crypto.sign(null, digest, privateKey).toString('hex'), signer_did: FIXTURE_DID });
}
const MANIFEST = signed({ schema: 'elastos.release/v1', version: FIXTURE_VERSION, channel: 'stable', installer_sha256: SCRIPT_SHA }, 'elastos.release.v1');
function signedHead(overrides = {}, manifest = MANIFEST) {
  return signed({ schema: 'elastos.release.head/v1', channel: 'stable', version: FIXTURE_VERSION,
    latest_release_cid: FIXTURE_RELEASE_CID, release_sha256: crypto.createHash('sha256').update(manifest).digest('hex'), ...overrides }, 'elastos.release.head.v1');
}
const SIGNED_HEAD = signedHead();
const FIXTURE_HEAD_CID = releaseHeadCid(SIGNED_HEAD);

module.exports = { FIXTURE_DID, FIXTURE_VERSION, FIXTURE_RELEASE_CID, SCRIPT, SCRIPT_SHA, MANIFEST, SIGNED_HEAD, FIXTURE_HEAD_CID, signed, signedHead };
