const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const crypto = require('node:crypto');

const {
  INTEL_MAC_MESSAGE,
  KVM_MESSAGE,
  activeRuntimePin,
  defaultLaunchTargetForPin,
  installRuntime,
  installedVersionMatches,
  installerChildEnv,
  parseRuntimePin,
  releaseHeadCid,
  planRuntimeInstall,
  runtimeDataDir,
  runtimeHostLockPath,
  verifyReleaseHead,
  wslKvmMessage,
} = require('../dist/main/targets');

const HOME = '/home/tester';
const PC2 = `${HOME}/.pc2`;
const COMPONENTS = `${HOME}/.local/share/elastos/components.json`;
const VERSION = '0.8.0-alpha.20';
const CID = 'QmUmMZD3yNs4C7JvtichoZ727gN2ntXNnCDF1QTHkNKhXt';
const RELEASE_CID = 'QmTAEJ8DAprsv5PbWcudofQwXrzL7ZjSgmhRmU8nqmwirf';
const DID = 'did:key:z6MkgwHd2BCWe1jHMXPiR6H1q1RFPcv1YzhMbK5G1kBarbfe';
const FIXTURE_DID = 'did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z';
const FIXTURE_VERSION = '0.7.1';
const FIXTURE_RELEASE_CID = 'release-a';
const SIGNED_HEAD = '{"payload":{"channel":"stable","latest_release_cid":"release-a","release_sha256":"3dcb060f99a9b300ace45ae82ac722189a9740a349fa631bbd7eb1fd9e0dcd36","schema":"elastos.release.head/v1","version":"0.7.1"},"signature":"8a248801f576beb6b053fa2f52637b2d3087f2804e44434c4d18abea47007dd24e81781f8c390d414d1b8b34055a06b81f0bd78dc83afa2ce152b59a8fce1101","signer_did":"did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z"}';
const SCRIPT = '#!/bin/bash\necho stamped-installer\n';
const SCRIPT_SHA = crypto.createHash('sha256').update(SCRIPT).digest('hex');
const FIXTURE_HEAD_CID = releaseHeadCid(SIGNED_HEAD);
const SOURCES = `${HOME}/.local/share/elastos/sources.json`;

function canaryPin(overrides = {}) {
  return {
    channel: 'stable',
    version: FIXTURE_VERSION,
    headCid: FIXTURE_HEAD_CID,
    maintainerDid: FIXTURE_DID,
    publisherGateway: 'https://publisher.example',
    fallbackInstallerUrl: 'https://publisher.example/install.sh',
    installerSha256: SCRIPT_SHA,
    publishable: true,
    ...overrides,
  };
}

function releaseHead() {
  return SIGNED_HEAD;
}

function harness(overrides = {}) {
  const files = new Map();
  const mtimes = new Map([[PC2, 1000]]);
  const calls = [];
  let probes = 0;
  const deps = {
    platform: 'linux',
    arch: 'x64',
    homeDir: HOME,
    env: {
      PATH: '/usr/bin',
      ELASTOS_HEAD_CID: 'QmEvil',
      ELASTOS_MAINTAINER_DID: 'did:key:zevil',
      ELASTOS_PUBLISHER_GATEWAY: 'https://evil.example',
    },
    pin: canaryPin(),
    pc2Dir: PC2,
    probe: async () => {
      probes += 1;
      if (probes === 1) return { kind: 'not-installed' };
      return {
        kind: 'version',
        version: `ElastOS Runtime v${FIXTURE_VERSION}`,
        binaryPath: `${HOME}/.local/bin/elastos`,
      };
    },
    fetchText: async (url) => {
      calls.push(['fetch', url]);
      if (url.endsWith('/release-head.json')) return releaseHead();
      return SCRIPT;
    },
    runInstaller: async (script, args, env) => {
      calls.push(['installer', script, [...args], env]);
      const headFlag = args.indexOf('--head-cid');
      files.set(SOURCES, JSON.stringify({
        default_source: 'default',
        sources: [{ name: 'default', head_cid: args[headFlag + 1] }],
      }));
      return { stdout: '', stderr: '' };
    },
    runSetup: async (binary) => {
      calls.push(['setup', binary]);
      files.set(COMPONENTS, '{}');
      return { stdout: '', stderr: '' };
    },
    writeFile: (file, contents) => files.set(file, contents),
    readFile: (file) => files.get(file),
    exists: (file) => files.has(file),
    statMtimeMs: (file) => (mtimes.has(file) ? mtimes.get(file) : null),
    mkdirp: () => {},
    ...overrides,
  };
  return { deps, files, mtimes, calls };
}

test('the active field is the one-line channel switch', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/runtime-pin.json'), 'utf8'));
  assert.equal(file.active, 'canary');
  assert.equal(file.channels.canary.version, VERSION);
  assert.equal(file.channels.canary.headCid, CID);
  assert.notEqual(file.channels.canary.headCid, RELEASE_CID);
  assert.equal(file.installerSha256, '18768ef071a9f921fe0c1d902926c138e86f925dbaf5dfb9185fecb8789d6714');
  assert.equal(file.channels.stable.version, null);
  assert.equal(file.channels.stable.headCid, null);

  const active = activeRuntimePin(parseRuntimePin(file));
  assert.equal(active.channel, 'canary');
  assert.equal(active.publishable, true);
  assert.equal(defaultLaunchTargetForPin(active), 'runtime');

  const stable = activeRuntimePin(parseRuntimePin({ ...file, active: 'stable' }));
  assert.equal(stable.publishable, false);
  assert.equal(defaultLaunchTargetForPin(stable), 'pc2');
});

test('data dir and host lock follow the launcher contract', () => {
  assert.equal(
    runtimeDataDir('darwin', HOME, { XDG_DATA_HOME: '/ignored' }),
    `${HOME}/Library/Application Support/elastos`,
  );
  assert.equal(runtimeDataDir('linux', HOME, {}), `${HOME}/.local/share/elastos`);
  assert.equal(
    runtimeDataDir('linux', HOME, { XDG_DATA_HOME: '/xdg' }),
    '/xdg/elastos',
  );
  assert.equal(
    runtimeHostLockPath(runtimeDataDir('linux', HOME, {})),
    `${HOME}/.local/share/elastos/host-process.lock`,
  );
});

test('a tampered release head is refused before install.sh runs', async () => {
  let ran = false;
  const tampered = SIGNED_HEAD.replace('"version":"0.7.1"', '"version":"0.7.2"');
  const { deps, calls } = harness({
    fetchText: async (url) => {
      calls.push(['fetch', url]);
      if (url.endsWith('/release-head.json')) return tampered;
      return SCRIPT;
    },
    runInstaller: async () => {
      ran = true;
      return { stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /signature does not match/);
  assert.equal(ran, false);
  assert.equal(calls.some((call) => String(call[1]).endsWith('/install.sh')), false);
  assert.throws(() => verifyReleaseHead(tampered, FIXTURE_DID), /signature does not match/);
});

test('a wrong maintainer DID is refused before install.sh runs', async () => {
  let ran = false;
  const { deps } = harness({
    pin: canaryPin({ maintainerDid: DID }),
    runInstaller: async () => {
      ran = true;
      return { stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /pinned maintainer DID/);
  assert.equal(ran, false);
  assert.throws(() => verifyReleaseHead(SIGNED_HEAD, DID), /pinned maintainer DID/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-head-'));
  const file = path.join(dir, 'head.json');
  fs.writeFileSync(file, SIGNED_HEAD);
  const ok = spawnSync('python3', [
    path.join(__dirname, '../scripts/verify-release-head.py'),
    file,
    'elastos.release.head.v1',
    FIXTURE_DID,
  ], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync('python3', [
    path.join(__dirname, '../scripts/verify-release-head.py'),
    file,
    'elastos.release.head.v1',
    DID,
  ], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install.sh bytes must match the pinned hash before they run', async () => {
  let ran = false;
  const { deps } = harness({
    fetchText: async (url) => {
      if (url.endsWith('/release-head.json')) return SIGNED_HEAD;
      return 'MAINTAINER_DID=__MAINTAINER_DID__\nHEAD=__HEAD_CID__\n';
    },
    runInstaller: async () => {
      ran = true;
      return { stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /installerSha256/);
  assert.equal(ran, false);
});

test('a matching pin installs with --install-only, then setup, and leaves PC2 alone', async () => {
  const { deps, calls, mtimes } = harness();
  const progress = [];
  await installRuntime(deps, (message) => progress.push(message));
  const install = calls.filter((call) => call[0] === 'installer');
  assert.equal(install.length, 1);
  assert.equal(install[0][1].endsWith('install.sh'), true);
  assert.equal(install[0][1].includes('install-fallback.sh'), false);
  assert.deepEqual(install[0][2], [
    '--install-only',
    '--head-cid',
    FIXTURE_HEAD_CID,
    '--maintainer-did',
    FIXTURE_DID,
  ]);
  assert.equal(install[0][2].includes('--allow-unsigned'), false);
  assert.equal(install[0][3].ELASTOS_HEAD_CID, undefined);
  assert.equal(install[0][3].ELASTOS_MAINTAINER_DID, undefined);
  assert.equal(install[0][3].ELASTOS_PUBLISHER_GATEWAY, undefined);
  assert.equal(install[0][3].PATH, '/usr/bin');
  assert.deepEqual(
    installerChildEnv({ ELASTOS_HEAD_CID: 'QmEvil', PATH: '/bin' }),
    { PATH: '/bin' },
  );
  assert.equal(calls.some((call) => call[0] === 'setup'), true);
  assert.equal(JSON.stringify(calls).includes('clone'), false);
  assert.equal(mtimes.get(PC2), 1000);
  assert.match(progress.join('\n'), /about 1 minute/);
  assert.match(progress.join('\n'), /about 2 minutes/);
});

test('an interrupted install rechecks the signed head and does not download the installer again', async () => {
  const { deps, calls, files } = harness({
    probe: async () => ({
      kind: 'version',
      version: `ElastOS Runtime v${FIXTURE_VERSION}`,
      binaryPath: `${HOME}/.local/bin/elastos`,
    }),
  });
  files.set(SOURCES, JSON.stringify({
    default_source: 'default',
    sources: [{ name: 'default', head_cid: FIXTURE_HEAD_CID }],
  }));
  await installRuntime(deps, () => {});
  const headFetches = calls.filter((call) => call[0] === 'fetch' && String(call[1]).endsWith('/release-head.json'));
  assert.equal(headFetches.length, 1);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(calls.filter((call) => call[0] === 'setup').length, 1);
});

test('a finished install rechecks the signed head and does not download again', async () => {
  const { deps, calls, files } = harness({
    probe: async () => ({
      kind: 'version',
      version: `ElastOS Runtime v${FIXTURE_VERSION}`,
      binaryPath: `${HOME}/.local/bin/elastos`,
    }),
  });
  files.set(COMPONENTS, '{}');
  files.set(SOURCES, JSON.stringify({
    default_source: 'default',
    sources: [{ name: 'default', head_cid: FIXTURE_HEAD_CID }],
  }));
  await installRuntime(deps, () => {});
  const headFetches = calls.filter((call) => call[0] === 'fetch' && String(call[1]).endsWith('/release-head.json'));
  assert.equal(headFetches.length, 1);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(calls.some((call) => call[0] === 'setup'), false);
});

test('a local install that matches the pin is refused when the signed head does not', async () => {
  let setup = false;
  const { deps, calls, files } = harness({
    probe: async () => ({
      kind: 'version',
      version: `ElastOS Runtime v${FIXTURE_VERSION}`,
      binaryPath: `${HOME}/.local/bin/elastos`,
    }),
    fetchText: async () => SIGNED_HEAD.replace('"version":"0.7.1"', '"version":"0.7.2"'),
    runSetup: async () => {
      setup = true;
      return { stdout: '', stderr: '' };
    },
  });
  files.set(COMPONENTS, '{}');
  files.set(SOURCES, JSON.stringify({
    default_source: 'default',
    sources: [{ name: 'default', head_cid: FIXTURE_HEAD_CID }],
  }));
  await assert.rejects(() => installRuntime(deps, () => {}), /signature does not match/);
  assert.equal(setup, false);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
});

test('Intel Mac gets a friendly message and does not download', async () => {
  let fetched = false;
  const { deps } = harness({
    platform: 'darwin',
    arch: 'x64',
    fetchText: async () => {
      fetched = true;
      return '';
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /not yet supported on Intel Macs/);
  assert.equal(fetched, false);
  const plan = planRuntimeInstall({
    platform: 'darwin',
    arch: 'x64',
    installedVersion: null,
    componentsPresent: false,
    pin: canaryPin(),
    publisher: null,
    installedHeadCid: null,
  });
  assert.equal(plan.action, 'blocked');
  assert.equal(plan.message, INTEL_MAC_MESSAGE);
});

test('a pinned install failure does not run a second installer', async () => {
  let attempts = 0;
  const { deps, calls } = harness({
    runInstaller: async (script, args) => {
      attempts += 1;
      calls.push(['installer', script, [...args]]);
      throw new Error('pinned download failed');
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /pinned download failed/);
  const installs = calls.filter((call) => call[0] === 'installer');
  const scriptFetches = calls.filter((call) => call[0] === 'fetch' && String(call[1]).endsWith('/install.sh'));
  assert.equal(attempts, 1);
  assert.equal(installs.length, 1);
  assert.equal(scriptFetches.length, 1);
  assert.equal(installs[0][1].includes('fallback'), false);
});

test('a version prefix collision does not install', async () => {
  assert.equal(installedVersionMatches('ElastOS Runtime v0.8.0-alpha.20', '0.8.0-alpha.2'), false);
  assert.equal(installedVersionMatches('ElastOS Runtime v0.8.0-alpha.20', '0.8.0-alpha.20'), true);
  const { deps, calls, files } = harness({
    pin: canaryPin({ version: '0.7' }),
    probe: async () => ({
      kind: 'version',
      version: 'ElastOS Runtime v0.7.1',
      binaryPath: `${HOME}/.local/bin/elastos`,
    }),
  });
  files.set(COMPONENTS, '{}');
  files.set(SOURCES, JSON.stringify({
    default_source: 'default',
    sources: [{ name: 'default', head_cid: FIXTURE_HEAD_CID }],
  }));
  await assert.rejects(() => installRuntime(deps, () => {}), /version/);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
});

test('the release CID is not accepted as the head CID', async () => {
  const headCid = releaseHeadCid(SIGNED_HEAD);
  assert.notEqual(headCid, FIXTURE_RELEASE_CID);
  assert.equal(releaseHeadCid('{"a":1}\n'), 'QmesNfBa5gMx91CKmvELgz2MzeLyDWs9PX2h4LuUqvLY4K');
  const { deps, calls } = harness({
    pin: canaryPin({ headCid: FIXTURE_RELEASE_CID }),
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /headCid/);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(calls.some((call) => String(call[1]).endsWith('/install.sh')), false);
});

test('a publisher mismatch does not install', async () => {
  const { deps, calls } = harness({
    pin: canaryPin({ version: '0.7.2' }),
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /version/);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(calls.some((call) => call[0] === 'fetch' && String(call[1]).endsWith('/install.sh')), false);
});

test('changing the PC2 directory fails the install', async () => {
  const { deps, mtimes } = harness({
    runInstaller: async () => {
      mtimes.set(PC2, 2000);
      return { stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /must not modify the PC2 directory/);
});

test('WSL without /dev/kvm explains the local Browser', () => {
  assert.equal(wslKvmMessage(true, false), KVM_MESSAGE);
  assert.equal(wslKvmMessage(true, true), null);
  assert.equal(wslKvmMessage(false, false), null);
});
