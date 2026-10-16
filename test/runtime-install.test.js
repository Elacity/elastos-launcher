const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  INTEL_MAC_MESSAGE,
  KVM_MESSAGE,
  activeRuntimePin,
  assertSignedInstaller,
  defaultLaunchTargetForPin,
  installRuntime,
  parseRuntimePin,
  planRuntimeInstall,
  runtimeDataDir,
  runtimeHostLockPath,
  wslKvmMessage,
} = require('../dist/main/targets');

const HOME = '/home/tester';
const PC2 = `${HOME}/.pc2`;
const COMPONENTS = `${HOME}/.local/share/elastos/components.json`;
const VERSION = '0.8.0-alpha.20';
const CID = 'QmTAEJ8DAprsv5PbWcudofQwXrzL7ZjSgmhRmU8nqmwirf';
const DID = 'did:key:z6MkgwHd2BCWe1jHMXPiR6H1q1RFPcv1YzhMbK5G1kBarbfe';

function canaryPin(overrides = {}) {
  return {
    channel: 'canary',
    version: VERSION,
    headCid: CID,
    maintainerDid: DID,
    publisherGateway: 'https://elastos.elacitylabs.com',
    fallbackInstallerUrl: 'https://elastos.elacitylabs.com/install.sh',
    publishable: true,
    ...overrides,
  };
}

function releaseHead(overrides = {}) {
  return JSON.stringify({
    signer_did: DID,
    payload: {
      channel: 'canary',
      version: VERSION,
      latest_release_cid: CID,
      ...overrides,
    },
  });
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
    env: {},
    pin: canaryPin(),
    pc2Dir: PC2,
    probe: async () => {
      probes += 1;
      if (probes === 1) return { kind: 'not-installed' };
      return {
        kind: 'version',
        version: `ElastOS Runtime v${VERSION}`,
        binaryPath: `${HOME}/.local/bin/elastos`,
      };
    },
    fetchText: async (url) => {
      calls.push(['fetch', url]);
      if (url.endsWith('/release-head.json')) return releaseHead();
      return '#!/bin/bash\necho stamped-installer\n';
    },
    runInstaller: async (script, args) => {
      calls.push(['installer', script, [...args]]);
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

test('unsigned git install.sh is refused before it runs', async () => {
  let ran = false;
  const { deps } = harness({
    fetchText: async (url) => {
      if (url.endsWith('/release-head.json')) return releaseHead();
      return 'MAINTAINER_DID=__MAINTAINER_DID__\nHEAD=__HEAD_CID__\n';
    },
    runInstaller: async () => {
      ran = true;
      return { stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /not signed/);
  assert.equal(ran, false);
  assert.throws(() => assertSignedInstaller('__HEAD_CID__'), /not signed/);
});

test('a matching pin installs with --install-only, then setup, and leaves PC2 alone', async () => {
  const { deps, calls, mtimes } = harness();
  const progress = [];
  await installRuntime(deps, (message) => progress.push(message));
  const install = calls.find((call) => call[0] === 'installer');
  assert.equal(install[1].endsWith('install-pinned.sh'), true);
  assert.deepEqual(install[2], ['--install-only']);
  assert.equal(calls.some((call) => call[0] === 'setup'), true);
  assert.equal(JSON.stringify(calls).includes('clone'), false);
  assert.equal(mtimes.get(PC2), 1000);
  assert.match(progress.join('\n'), /about 1 minute/);
  assert.match(progress.join('\n'), /about 2 minutes/);
});

test('an interrupted install resumes at setup and does not download again', async () => {
  const { deps, calls } = harness({
    probe: async () => ({
      kind: 'version',
      version: `ElastOS Runtime v${VERSION}`,
      binaryPath: `${HOME}/.local/bin/elastos`,
    }),
  });
  await installRuntime(deps, () => {});
  assert.equal(calls.some((call) => call[0] === 'fetch'), false);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(calls.filter((call) => call[0] === 'setup').length, 1);
});

test('a finished install does not download again', async () => {
  const { deps, calls, files } = harness({
    probe: async () => ({
      kind: 'version',
      version: `ElastOS Runtime v${VERSION}`,
      binaryPath: `${HOME}/.local/bin/elastos`,
    }),
  });
  files.set(COMPONENTS, '{}');
  await installRuntime(deps, () => {});
  assert.deepEqual(calls, []);
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
  });
  assert.equal(plan.action, 'blocked');
  assert.equal(plan.message, INTEL_MAC_MESSAGE);
});

test('a pinned install failure falls back to the hosted installer', async () => {
  let attempts = 0;
  const { deps, calls } = harness({
    runInstaller: async (script, args) => {
      attempts += 1;
      calls.push(['installer', script, [...args]]);
      if (attempts === 1) throw new Error('pinned download failed');
      return { stdout: '', stderr: '' };
    },
  });
  await installRuntime(deps, () => {});
  const installs = calls.filter((call) => call[0] === 'installer');
  assert.equal(attempts, 2);
  assert.equal(installs.length, 2);
  assert.equal(installs[0][1].endsWith('install-pinned.sh'), true);
  assert.equal(installs[1][1].endsWith('install-fallback.sh'), true);
  assert.deepEqual(installs[1][2], ['--install-only']);
});

test('a publisher mismatch uses the hosted installer', async () => {
  const { deps, calls } = harness({
    fetchText: async (url) => {
      calls.push(['fetch', url]);
      if (url.endsWith('/release-head.json')) {
        return releaseHead({ latest_release_cid: 'QmDifferent' });
      }
      return '#!/bin/bash\necho stamped\n';
    },
  });
  await installRuntime(deps, () => {});
  assert.equal(calls.find((call) => call[0] === 'installer')[1].endsWith('install-fallback.sh'), true);
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
