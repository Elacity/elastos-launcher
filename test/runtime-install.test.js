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
  runtimeUpdateCheckPath,
  verifyReleaseHead,
  wslKvmMessage,
} = require('../dist/main/targets');

const HOME = '/home/tester';
const COMPONENTS = `${HOME}/.local/share/elastos/components.json`;
const VERSION = '2.0.0';
const DID = 'did:key:z6MkgwHd2BCWe1jHMXPiR6H1q1RFPcv1YzhMbK5G1kBarbfe';
const { verifiedInstallerSha256 } = require('../dist/main/targets/releaseHead');
const { versionAtLeast, pinMismatchField } = require('../dist/main/targets/runtimeInstall');
const { FIXTURE_DID, FIXTURE_VERSION, FIXTURE_RELEASE_CID, SCRIPT, SCRIPT_SHA, MANIFEST, SIGNED_HEAD, FIXTURE_HEAD_CID, signed, signedHead } = require('./helpers/signed-release');
const SOURCES = `${HOME}/.local/share/elastos/sources.json`;
const RECORD = `${HOME}/.local/share/elastos/installation/release-head.json`;
const { installRecordTextProves } = require('../dist/main/targets/runtimePaths');

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
  const mtimes = new Map();
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
      if (url.endsWith('/release.json')) return MANIFEST;
      return SCRIPT;
    },
    runInstaller: async (script, args, env) => {
      calls.push(['installer', script, [...args], env]);
      files.set(SOURCES, JSON.stringify({
        default_source: 'default',
        sources: [{ name: 'default', head_cid: env.ELASTOS_HEAD_CID }],
      }));
      // install-release writes the verified head as the install record.
      files.set(RECORD, SIGNED_HEAD);
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
    // The same check Reset uses, on the in-memory record.
    installRecordProved: (dataDir) => {
      const text = files.get(`${dataDir}/installation/release-head.json`);
      return typeof text === 'string' && installRecordTextProves(text, deps.pin.maintainerDid);
    },
    ...overrides,
  };
  return { deps, files, mtimes, calls };
}

test('Stable is the default and both channels use a 2.0.0 rollback floor', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/runtime-pin.json'), 'utf8'));
  assert.equal(file.active, 'stable');
  assert.equal(file.maintainerDid, DID);
  for (const channel of ['stable', 'canary']) {
    assert.equal(file.channels[channel].version, VERSION);
    assert.equal(file.channels[channel].headCid, null);
    const active = activeRuntimePin(parseRuntimePin({ ...file, active: channel }));
    assert.equal(active.channel, channel);
    assert.equal(active.publishable, true);
    assert.equal(defaultLaunchTargetForPin(active), 'runtime');
  }
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
  assert.equal(
    runtimeUpdateCheckPath(runtimeDataDir('darwin', HOME, { XDG_DATA_HOME: '/ignored' })),
    `${HOME}/Library/Application Support/elastos/update-check.json`,
  );
  assert.equal(
    runtimeUpdateCheckPath(runtimeDataDir('linux', HOME, {})),
    `${HOME}/.local/share/elastos/update-check.json`,
  );
  assert.equal(
    runtimeUpdateCheckPath(runtimeDataDir('linux', HOME, { XDG_DATA_HOME: '/xdg' })),
    '/xdg/elastos/update-check.json',
  );
});

test('a tampered release head is refused before install.sh runs', async () => {
  let ran = false;
  const tampered = SIGNED_HEAD.replace('"version":"2.0.0"', '"version":"2.0.1"');
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
      if (url.endsWith('/release.json')) return MANIFEST;
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

test('a matching pin installs with --install-only, then setup', async () => {
  const { deps, calls } = harness();
  const progress = [];
  await installRuntime(deps, (message) => progress.push(message));
  const install = calls.filter((call) => call[0] === 'installer');
  assert.equal(install.length, 1);
  assert.equal(install[0][1].endsWith('install.sh'), true);
  assert.equal(install[0][1].includes('install-fallback.sh'), false);
  assert.deepEqual(install[0][2], [
    '--install-only',
    '--maintainer-did',
    FIXTURE_DID,
    '--publisher-gateway',
    'https://publisher.example',
  ]);
  assert.equal(install[0][2].includes('--head-cid'), false);
  assert.equal(install[0][2].includes('--allow-unsigned'), false);
  assert.equal(install[0][3].ELASTOS_HEAD_CID, FIXTURE_HEAD_CID);
  assert.notEqual(install[0][3].ELASTOS_HEAD_CID, 'QmEvil');
  assert.equal(install[0][3].ELASTOS_MAINTAINER_DID, undefined);
  assert.equal(install[0][3].ELASTOS_PUBLISHER_GATEWAY, undefined);
  assert.equal(install[0][3].PATH, '/usr/bin');
  assert.deepEqual(
    installerChildEnv({ ELASTOS_HEAD_CID: 'QmEvil', PATH: '/bin' }),
    { PATH: '/bin' },
  );
  assert.equal(calls.some((call) => call[0] === 'setup'), true);
  assert.equal(JSON.stringify(calls).includes('clone'), false);
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
  files.set(RECORD, SIGNED_HEAD);
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
  files.set(RECORD, SIGNED_HEAD);
  await installRuntime(deps, () => {});
  const headFetches = calls.filter((call) => call[0] === 'fetch' && String(call[1]).endsWith('/release-head.json'));
  assert.equal(headFetches.length, 1);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(calls.some((call) => call[0] === 'setup'), false);
});

function installedWithoutProof(record) {
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
  if (record != null) files.set(RECORD, record);
  return { deps, calls, files };
}

test('the pinned version with no signed install record is not installed: Install runs install.sh again', async () => {
  const { deps, calls, files } = installedWithoutProof(null);
  await installRuntime(deps, () => {});
  assert.equal(calls.filter((call) => call[0] === 'installer').length, 1);
  assert.equal(files.get(RECORD), SIGNED_HEAD);
  // components.json is there, so setup does not run again.
  assert.equal(calls.some((call) => call[0] === 'setup'), false);
  // Now the record proves the install, and a second Install changes nothing.
  calls.length = 0;
  await installRuntime(deps, () => {});
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
});

test('a tampered or foreign-signed install record is not proof: Install runs install.sh again', async () => {
  const tampered = SIGNED_HEAD.replace('"version":"2.0.0"', '"version":"2.0.9"');
  for (const record of [tampered, '{}', '', SIGNED_HEAD.replace(FIXTURE_DID, DID)]) {
    const { deps, calls, files } = installedWithoutProof(record);
    await installRuntime(deps, () => {});
    assert.equal(calls.filter((call) => call[0] === 'installer').length, 1, record);
    assert.equal(files.get(RECORD), SIGNED_HEAD);
  }
  // A record check that throws (an unreadable file) is not proof either.
  const { deps, calls } = installedWithoutProof(SIGNED_HEAD);
  deps.installRecordProved = () => { throw new Error('unreadable'); };
  await assert.rejects(() => installRuntime(deps, () => {}), /did not save its signed install record/);
  assert.equal(calls.filter((call) => call[0] === 'installer').length, 1);
});

test('an install.sh run that leaves no valid record fails in plain words', async () => {
  const { deps, calls } = harness({
    runInstaller: async (script, args, env) => {
      calls.push(['installer', script, [...args], env]);
      deps.writeFile(SOURCES, JSON.stringify({
        default_source: 'default',
        sources: [{ name: 'default', head_cid: env.ELASTOS_HEAD_CID }],
      }));
      return { stdout: '', stderr: '' };
    },
  });
  await assert.rejects(() => installRuntime(deps, () => {}), {
    message: 'ElastOS was installed, but it did not save its signed install record, so ElastOS cannot prove this install. Click Install to try again.',
  });
  assert.equal(calls.some((call) => call[0] === 'setup'), false);
});

test('the plan needs version, head CID and the signed record before it says already installed', () => {
  const base = {
    platform: 'linux',
    arch: 'x64',
    installedVersion: `ElastOS Runtime v${FIXTURE_VERSION}`,
    installedHeadCid: FIXTURE_HEAD_CID,
    installRecordProved: true,
    componentsPresent: true,
    pin: canaryPin(),
    publisher: { ...verifyReleaseHead(SIGNED_HEAD, FIXTURE_DID) },
  };
  assert.equal(planRuntimeInstall(base).action, 'already-installed');
  assert.equal(planRuntimeInstall({ ...base, componentsPresent: false }).action, 'resume-setup');
  assert.equal(planRuntimeInstall({ ...base, installRecordProved: false }).action, 'pinned');
  assert.equal(planRuntimeInstall({ ...base, installRecordProved: false, componentsPresent: false }).action, 'pinned');
});

test('a local install that matches the pin is refused when the signed head does not', async () => {
  let setup = false;
  const { deps, calls, files } = harness({
    probe: async () => ({
      kind: 'version',
      version: `ElastOS Runtime v${FIXTURE_VERSION}`,
      binaryPath: `${HOME}/.local/bin/elastos`,
    }),
    fetchText: async () => SIGNED_HEAD.replace('"version":"2.0.0"', '"version":"2.0.1"'),
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
  await assert.rejects(() => installRuntime(deps, () => {}), /Error: Intel Mac is not supported yet\.$/);
  assert.equal(fetched, false);
  const plan = planRuntimeInstall({
    platform: 'darwin',
    arch: 'x64',
    installedVersion: null,
    componentsPresent: false,
    pin: canaryPin(),
    publisher: null,
    installedHeadCid: null,
    installRecordProved: false,
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

test('the installer receives the verified head CID, never the release CID or packaged snapshot', async () => {
  const { deps, calls } = harness({ pin: canaryPin({ headCid: FIXTURE_RELEASE_CID }) });
  await installRuntime(deps);
  const install = calls.find((call) => call[0] === 'installer');
  assert.equal(install[3].ELASTOS_HEAD_CID, FIXTURE_HEAD_CID);
  assert.notEqual(install[3].ELASTOS_HEAD_CID, FIXTURE_RELEASE_CID);
  assert.equal(releaseHeadCid('{"a":1}\n'), 'QmesNfBa5gMx91CKmvELgz2MzeLyDWs9PX2h4LuUqvLY4K');
});

test('a publisher mismatch does not install', async () => {
  const { deps, calls } = harness({
    pin: canaryPin({ version: '2.0.1' }),
  });
  await assert.rejects(() => installRuntime(deps, () => {}), /version/);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(calls.some((call) => call[0] === 'fetch' && String(call[1]).endsWith('/install.sh')), false);
});

test('the pinned install.sh accepts the Install button invocation and rejects a head flag', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/runtime-pin.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-installer-parse-'));
  const script = path.join(dir, 'install.sh');
  const downloaded = spawnSync('curl', ['-fsSL', '--max-time', '60', pin.fallbackInstallerUrl, '-o', script], { encoding: 'utf8' });
  assert.equal(downloaded.status, 0, downloaded.stderr);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  const headRaw = spawnSync('curl', ['-fsSL', '--max-time', '30', `${pin.publisherGateway}/release-head.json`], { encoding: 'utf8' });
  assert.equal(headRaw.status, 0, headRaw.stderr);
  const manifest = spawnSync('curl', ['-fsSL', '--max-time', '30', `${pin.publisherGateway}/release.json`], { encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
  const head = verifyReleaseHead(headRaw.stdout, pin.maintainerDid);
  assert.equal(hash, verifiedInstallerSha256(manifest.stdout, head));
  const rejected = spawnSync('bash', [
    script,
    '--install-only',
    '--head-cid',
    FIXTURE_HEAD_CID,
    '--help',
  ], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stderr}\n${rejected.stdout}`, /Unknown option: --head-cid/);
  const env = { ...process.env, ELASTOS_HEAD_CID: FIXTURE_HEAD_CID };
  delete env.ELASTOS_MAINTAINER_DID;
  delete env.ELASTOS_PUBLISHER_GATEWAY;
  const accepted = spawnSync('bash', [
    script,
    '--install-only',
    '--maintainer-did',
    pin.maintainerDid,
    '--help',
  ], { encoding: 'utf8', env });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(/Unknown option/.test(`${accepted.stderr}\n${accepted.stdout}`), false);
  assert.match(accepted.stdout, /ElastOS Installer/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WSL without /dev/kvm explains the local Browser', () => {
  assert.equal(wslKvmMessage(true, false), KVM_MESSAGE);
  assert.equal(wslKvmMessage(true, true), null);
  assert.equal(wslKvmMessage(false, false), null);
});

const TRUST_OVERRIDES = {
  ELASTOS_MAINTAINER_DID: 'did:key:zevil',
  ELASTOS_HEAD_CID: 'QmEvilEvilEvilEvilEvilEvilEvilEvilEvilEvilEvil',
  ELASTOS_PUBLISHER_GATEWAY: 'https://evil.example',
  ELASTOS_PUBLISHER_NODE_ID: 'evil-node',
  ELASTOS_SOURCE_CONNECT_TICKET: 'evil-ticket',
  ELASTOS_IPNS_NAME: 'evil-name',
  ELASTOS_DATA_DIR: '/tmp/evil-data',
  elastos_components_manifest: '/tmp/evil.json',
};

async function withEnv(values, run) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    process.env[key] = values[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a real install.sh run gets the pinned head and no inherited ELASTOS_* override', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell');
  if (spawnSync('python3', ['-c', ''], { stdio: 'ignore' }).status !== 0) return t.skip('needs python3, or the app downloads one');
  const { defaultRuntimeInstallDeps, pinnedInstallerLaunch } = require('../dist/main/targets/runtimeInstall');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-env-scrub-'));
  try {
    const script = path.join(home, 'install.sh');
    fs.writeFileSync(script, 'env | grep -i "^ELASTOS_" | sort\n');
    const out = await withEnv({ ...TRUST_OVERRIDES, HOME: home }, async () => {
      const pin = canaryPin();
      const deps = defaultRuntimeInstallDeps(pin);
      const launch = pinnedInstallerLaunch(pin, deps.env);
      return deps.runInstaller(script, launch.args, launch.env);
    });
    assert.equal(out.stdout.trim(), `ELASTOS_HEAD_CID=${FIXTURE_HEAD_CID}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the gateway process gets no inherited ELASTOS_* variable', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX env');
  const { spawnGatewayProcess } = require('../dist/main/targets/runtimeGateway');
  const output = await withEnv(TRUST_OVERRIDES, () => new Promise((resolve) => {
    const proc = spawnGatewayProcess('/usr/bin/env', []);
    let text = '';
    proc.onOutput((chunk) => { text += chunk; });
    proc.onExit(() => resolve(text));
  }));
  assert.match(output, /^PATH=/m);
  assert.equal(/^ELASTOS_/im.test(output), false, output.split('\n').filter((line) => /^ELASTOS_/i.test(line)).join('\n'));
});

test('runtimeChildEnv drops every ELASTOS_ name, in any case, and keeps the rest', () => {
  const { INSTALLER_ENV_NAMES, runtimeChildEnv } = require('../dist/main/targets/releaseHead');
  assert.deepEqual(runtimeChildEnv({ ...TRUST_OVERRIDES, PATH: '/bin', HOME: '/h', XDG_DATA_HOME: '/x' }), { PATH: '/bin', HOME: '/h', XDG_DATA_HOME: '/x' });
  for (const name of INSTALLER_ENV_NAMES) assert.match(name, /^ELASTOS_/);
  assert.equal(INSTALLER_ENV_NAMES.length, 12);
});


test('a new signed publisher head above the floor installs without a launcher release', async () => {
  const newerManifest = signed({ schema: 'elastos.release/v1', channel: 'stable', version: '2.0.1', installer_sha256: SCRIPT_SHA }, 'elastos.release.v1');
  const newer = signedHead({ version: '2.0.1' }, newerManifest);
  let probes = 0;
  const { deps, calls, files } = harness({
    pin: canaryPin({ headCid: null, installerSha256: '0'.repeat(64) }),
    fetchText: async (url) => url.endsWith('/release-head.json') ? newer : url.endsWith('/release.json') ? newerManifest : SCRIPT,
    probe: async () => probes++ === 0 ? { kind: 'not-installed' } : { kind: 'version', version: 'ElastOS Runtime v2.0.1' },
  });
  const run = deps.runInstaller;
  deps.runInstaller = async (...args) => {
    const result = await run(...args);
    files.set(RECORD, newer);
    return result;
  };
  await installRuntime(deps);
  assert.equal(calls.find((call) => call[0] === 'installer')[3].ELASTOS_HEAD_CID, releaseHeadCid(newer));
  // The publisher then serves 2.0.0. Keep the newer proved installation.
  calls.length = 0;
  deps.fetchText = async () => SIGNED_HEAD;
  await installRuntime(deps);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  assert.equal(pinMismatchField(canaryPin({ headCid: null }), verifyReleaseHead(newer, FIXTURE_DID)), null);
  assert.equal(versionAtLeast('2.0.1', '2.0.0'), true);
  for (const version of ['1.99.99', '2.0.0-rc.1', '2.0', '2.0.00', '2.0.1-rc.02', '2.0.1+build..1', 'garbage']) {
    assert.equal(versionAtLeast(version, '2.0.0'), false, version);
    assert.equal(pinMismatchField(canaryPin(), verifyReleaseHead(signedHead({ version }), FIXTURE_DID)), 'version');
  }
  assert.equal(versionAtLeast('2.0.10', '2.0.9'), true);
  assert.equal(versionAtLeast('2.0.1-rc.10', '2.0.1-rc.2'), true);
  assert.equal(pinMismatchField(canaryPin(), verifyReleaseHead(signedHead({ channel: 'canary' }), FIXTURE_DID)), 'channel');
});

test('the head, manifest signature and installer hash each fail closed', () => {
  const head = verifyReleaseHead(SIGNED_HEAD, FIXTURE_DID);
  assert.equal(verifiedInstallerSha256(MANIFEST, head), SCRIPT_SHA);
  assert.throws(() => verifiedInstallerSha256(MANIFEST + ' ', head), /manifest SHA-256/);
  for (const manifest of [MANIFEST.replace(SCRIPT_SHA, '0'.repeat(64)),
    signed({ schema: 'elastos.release/v1', channel: 'stable', version: FIXTURE_VERSION }, 'elastos.release.v1'),
    signed({ schema: 'elastos.release/v1', channel: 'canary', version: FIXTURE_VERSION, installer_sha256: SCRIPT_SHA }, 'elastos.release.v1')]) {
    const boundHead = verifyReleaseHead(signedHead({}, manifest), FIXTURE_DID);
    assert.throws(() => verifiedInstallerSha256(manifest, boundHead));
  }
});


test('release metadata and installer downloads have enforced bounds', async (t) => {
  const { fetchRuntimeText } = require('../dist/main/targets/runtimeInstall');
  assert.throws(() => verifyReleaseHead(' '.repeat(256 * 1024 + 1), FIXTURE_DID), /exceeds its limit/);
  let cancelled = false;
  t.mock.method(global, 'fetch', async () => ({
    ok: true, status: 200, url: 'https://publisher.example/install.sh',
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(2 * 1024 * 1024 + 1) }),
      cancel: async () => { cancelled = true; },
    }) },
  }));
  await assert.rejects(() => fetchRuntimeText('http://publisher.example/install.sh'), /require HTTPS/);
  await assert.rejects(() => fetchRuntimeText('https://publisher.example/install.sh'), /exceeds the download limit/);
  assert.equal(cancelled, true);
});

test('a curl-installed 2.0.0 with an empty source head is adopted through its matching signed record', async () => {
  const { deps, calls, files } = installedWithoutProof(SIGNED_HEAD);
  files.set(SOURCES, JSON.stringify({ default_source: 'default', sources: [{ name: 'default', head_cid: '' }] }));
  await installRuntime(deps);
  assert.equal(calls.some((call) => call[0] === 'installer'), false);
  // A nonempty conflicting source remains an integrity failure and needs repair.
  files.set(SOURCES, JSON.stringify({ default_source: 'default', sources: [{ name: 'default', head_cid: 'QmWrong' }] }));
  await installRuntime(deps);
  assert.equal(calls.filter((call) => call[0] === 'installer').length, 1);
});
