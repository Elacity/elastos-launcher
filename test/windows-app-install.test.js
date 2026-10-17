const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { installRuntime, pinnedInstallerLaunch } = require('../dist/main/targets/runtimeInstall');
const { runtimeBinaryPath, runtimeJoin } = require('../dist/main/targets/runtimePaths');
const { runtimeInstallBlock } = require('../dist/main/targets/runtimeSupport');
const {
  adoptDistroGatewayProcess,
  adoptInstalledDistroGateway,
  distroListenerKind,
  assertDistroPath,
  distroGatewayArgs,
  distroInstallerArgs,
  distroPackageArgs,
  distroPidAlive,
  distroStopArgs,
  DISTRO_INSTALL_DIR,
  DISTRO_SETUP_FAILED,
  ensureElastosDistro,
  factsAreElastos,
  readDistroLockPid,
  signalDistroGateway,
  wslCommandPrefix,
  wslSpawnEnv,
} = require('../dist/main/targets/windowsRuntime');
const { createGatewaySupervisor } = require('../dist/main/targets/runtimeGateway');
const { importDistroArgs } = require('../dist/main/targets/windowsHost');

const HEAD = 'QmXuy56RTFzXaifTuyCbMb6Ky1p5wuM9iP8eFbMghHxWij';
const DID = 'did:key:z6MkgwHd2BCWe1jHMXPiR6H1q1RFPcv1YzhMbK5G1kBarbfe';

test('distro paths stay POSIX and the installer uses ELASTOS_HEAD_CID', () => {
  assert.equal(runtimeJoin('/root', '.local', 'bin', 'elastos'), '/root/.local/bin/elastos');
  assert.equal(runtimeBinaryPath('/root'), '/root/.local/bin/elastos');
  assert.equal(runtimeBinaryPath('/root').includes('\\'), false);
  assert.equal(assertDistroPath('/root/.elastos-launcher/install.sh'), '/root/.elastos-launcher/install.sh');
  assert.throws(() => assertDistroPath('/root/../etc/passwd'), /outside the ElastOS Linux environment/);
  assert.throws(() => assertDistroPath('/tmp/install.sh'), /outside the ElastOS Linux environment/);

  const launch = pinnedInstallerLaunch(
    { headCid: HEAD, maintainerDid: DID },
    { ELASTOS_HEAD_CID: 'QmEvil', ELASTOS_MAINTAINER_DID: 'did:key:zevil', ELASTOS_PUBLISHER_GATEWAY: 'https://evil.example' },
  );
  const args = distroInstallerArgs('/root/.elastos-launcher/install.sh', launch.args, launch.env);
  assert.deepEqual(args.slice(0, 6), [
    'env',
    '-u',
    'ELASTOS_MAINTAINER_DID',
    '-u',
    'ELASTOS_PUBLISHER_GATEWAY',
    `ELASTOS_HEAD_CID=${HEAD}`,
  ]);
  assert.equal(args.includes('--head-cid'), false);
  assert.deepEqual(args.slice(6), ['bash', '/root/.elastos-launcher/install.sh', '--install-only', '--maintainer-did', DID]);
  assert.deepEqual([...wslCommandPrefix(), ...args].slice(0, 4), ['-d', 'ElastOS', '-u', 'root']);
  assert.equal(wslSpawnEnv({}).WSL_UTF8, '1');
  assert.deepEqual(distroGatewayArgs().slice(-3), ['gateway', '--addr', '127.0.0.1:8090']);
  assert.match(distroPackageArgs().join(' '), /nameserver 8\.8\.8\.8/);
  assert.match(distroPackageArgs().join(' '), /python3 curl ca-certificates/);
});

test('a native Windows installRuntime still refuses before any download', async () => {
  assert.match(runtimeInstallBlock('win32', 'x64'), /Click Enable/);
  let fetched = false;
  await assert.rejects(() => installRuntime({
    platform: 'win32',
    arch: 'x64',
    homeDir: '/root',
    pin: {},
    fetchText: async () => { fetched = true; return ''; },
    runInstaller: async () => ({ stdout: '', stderr: '' }),
    runSetup: async () => ({ stdout: '', stderr: '' }),
    writeFile() {},
    readFile() { return ''; },
    exists() { return false; },
    statMtimeMs() { return null; },
    mkdirp() {},
  }), /Click Enable/);
  assert.equal(fetched, false);
});

test('ensuring the distro imports the pinned rootfs and hides command failures', async () => {
  await assert.rejects(() => ensureElastosDistro({
    lookupWsl: async () => false,
    listDistros: async () => { throw new Error('should not list'); },
    ensureRootfs: async () => { throw new Error('should not download'); },
    importDistro: async () => 0,
    hasTools: async () => true,
    installTools: async () => 0,
    onProgress() {},
  }), (err) => {
    assert.match(err.message, /Click Enable/);
    assert.equal(/wsl\.exe|powershell|\bbash\b/.test(err.message), false);
    return true;
  });

  const seen = [];
  const progress = [];
  await ensureElastosDistro({
    lookupWsl: async () => true,
    listDistros: async () => '  NAME      STATE           VERSION\n',
    ensureRootfs: async () => 'C:\\ElastOS\\rootfs.tar.gz',
    importDistro: async (installDir, rootfs) => {
      seen.push({ installDir, rootfs, args: [...importDistroArgs(installDir, rootfs)] });
      return 0;
    },
    prepareImportDir() {},
    hasTools: async () => false,
    installTools: async () => 0,
    onProgress: (message) => progress.push(message),
  });
  assert.equal(seen[0].installDir, DISTRO_INSTALL_DIR);
  assert.deepEqual(seen[0].args, importDistroArgs(DISTRO_INSTALL_DIR, 'C:\\ElastOS\\rootfs.tar.gz'));
  assert.deepEqual(progress, ['Rootfs SHA-256 matches the pin']);

  await assert.rejects(() => ensureElastosDistro({
    lookupWsl: async () => true,
    listDistros: async () => '  NAME      STATE           VERSION\n* ElastOS    Stopped         2\n',
    ensureRootfs: async () => { throw new Error('should not download'); },
    importDistro: async () => 0,
    hasTools: async () => false,
    installTools: async () => 1,
    onProgress() {},
  }), (err) => {
    assert.equal(err.message, DISTRO_SETUP_FAILED);
    assert.equal(/wsl\.exe|powershell|\bbash\b|apt-get/.test(err.message), false);
    return true;
  });
});

test('the distro gateway identity uses the lock pid socket and a positive wsl pid', () => {
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1F9A 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 0000000000000000 100 0 0 10 0',
  ].join('\n');
  const facts = {
    lock: JSON.stringify({ pid: 7, addr: '127.0.0.1:8090' }),
    command: '/root/.local/bin/elastos gateway --addr 127.0.0.1:8090',
    tcp,
    links: ['socket:[4242]'],
    alive: true,
  };
  assert.equal(factsAreElastos(JSON.stringify(facts)), true);
  assert.equal(factsAreElastos(JSON.stringify({ ...facts, links: ['socket:[9999]'] })), false);
  assert.equal(factsAreElastos(JSON.stringify({ ...facts, command: 'python3 -m http.server 8090' })), false);

  const killed = [];
  const stopped = [];
  signalDistroGateway(42, 'SIGTERM', (pid, signal) => { killed.push([pid, signal]); }, (name) => { stopped.push(name); });
  assert.deepEqual(stopped, ['TERM']);
  assert.deepEqual(killed, [[42, 'SIGTERM']]);

  const skipped = [];
  signalDistroGateway(0, 'SIGTERM', () => { skipped.push('kill'); }, () => { skipped.push('lock'); });
  assert.deepEqual(skipped, ['lock']);

  const script = fs.readFileSync(path.join(__dirname, '../scripts/windows-app-install.js'), 'utf8');
  assert.match(script, /installRuntimeOnThisComputer/);
  assert.match(script, /createRuntimeTarget/);
  assert.match(script, /\/healthz is OK/);
  assert.match(script, /Opening Home in the Windows browser/);
  assert.equal(/windows-elastos-distro/.test(script), false);
});

test('an adopted distro gateway uses the lock pid and does not report a live pid stopped', async () => {
  assert.equal(readDistroLockPid(() => ({ code: 0, stdout: '77\n' })), 77);
  assert.equal(readDistroLockPid(() => ({ code: 0, stdout: '0\n' })), null);
  assert.equal(readDistroLockPid(() => ({ code: 0, stdout: '1\n' })), null);
  assert.equal(readDistroLockPid(() => ({ code: 1, stdout: '' })), null);
  assert.equal(distroStopArgs('TERM', 77).at(-1), '77');
  assert.equal(distroStopArgs('TERM', 77).includes('host-process.lock'), false);
  assert.throws(() => distroStopArgs('TERM', 1), /Refusing to signal/);
  assert.equal(await distroPidAlive(77, async () => { throw new Error('timeout'); }), true);
  assert.equal(await distroPidAlive(77, async () => ({ code: 1 })), false);
  assert.equal(await distroPidAlive(77, async () => ({ code: 2 })), true);
  assert.equal(await distroPidAlive(77, async () => ({ code: 0 })), true);

  const signals = [];
  const adopted = adoptDistroGatewayProcess({
    readPid: () => 77,
    alive: () => true,
    signal: (pid, signal) => { signals.push([pid, signal]); },
  });
  assert.equal(adopted.pid, 77);
  assert.equal(adopted.hasExited(), false);
  adopted.signal('SIGTERM');
  assert.deepEqual(signals, [[77, 'SIGTERM']]);
  assert.equal(adoptDistroGatewayProcess({
    readPid: () => null,
    alive: () => true,
    signal: () => { throw new Error('signaled'); },
  }), null);
  assert.equal(adoptDistroGatewayProcess({
    readPid: () => 0,
    alive: () => true,
    signal: () => { throw new Error('signaled'); },
  }), null);
  const dead = adoptDistroGatewayProcess({
    readPid: () => 77,
    alive: () => false,
    signal: () => {},
  });
  assert.equal(dead.hasExited(), true);
  const blown = adoptDistroGatewayProcess({
    readPid: () => 77,
    alive: () => { throw new Error('timeout'); },
    signal: () => { throw new Error('signaled'); },
  });
  assert.equal(blown.hasExited(), false);
  const pending = adoptDistroGatewayProcess({
    readPid: () => 77,
    alive: () => Promise.reject(new Error('timeout')),
    signal: () => {},
  });
  assert.equal(await pending.hasExited(), false);

  const argv = [];
  const signaled = adoptDistroGatewayProcess({
    readPid: () => 77,
    alive: () => true,
    runStop: (args) => { argv.push(args); },
  });
  signaled.signal('SIGTERM');
  assert.equal(argv.length, 1);
  assert.equal(argv[0].at(-1), '77');
  assert.equal(argv[0][3], 'TERM');
  assert.equal(String(argv[0][2]).includes('host-process.lock'), false);
  const adoptedCalls = [];
  assert.equal(await adoptInstalledDistroGateway({
    kind: async () => 'other',
    adopt: () => {
      adoptedCalls.push('other');
      return signaled;
    },
  }), null);
  assert.equal(await adoptInstalledDistroGateway({
    kind: async () => 'unknown',
    adopt: () => {
      adoptedCalls.push('unknown');
      return signaled;
    },
  }), null);
  assert.equal(await adoptInstalledDistroGateway({
    kind: async () => { throw new Error('facts timed out'); },
    adopt: () => {
      adoptedCalls.push('throw');
      return signaled;
    },
  }), null);
  assert.equal(await distroListenerKind(async () => { throw new Error('timeout'); }), 'unknown');
  assert.equal(await distroListenerKind(async () => ({ code: 1, stdout: '', stderr: 'closed' })), 'unknown');
  assert.deepEqual(adoptedCalls, []);
  assert.equal(await adoptInstalledDistroGateway({
    kind: async () => 'elastos',
    adopt: () => signaled,
  }), signaled);

  let clock = 0;
  let health = { status: 200, body: 'OK' };
  const sup = createGatewaySupervisor({
    binary: '/root/.local/bin/elastos',
    spawn() { throw new Error('must not spawn'); },
    fetchHealth: async () => health,
    sleep: async () => { clock += 1000; },
    now: () => clock,
    openUrl: () => {},
    log: () => {},
    graceMs: 3000,
    pollMs: 1000,
    confirmForeign: async () => true,
    adoptInstalled: () => adoptDistroGatewayProcess({
      readPid: () => 77,
      alive: () => true,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        health = null;
      },
    }),
  });
  await assert.rejects(() => sup.stop({ adopt: true }), /still running/);
  assert.equal(sup.phase(), 'error');

  let probeClock = 0;
  let probeHealth = { status: 200, body: 'OK' };
  const probeSignals = [];
  const probed = createGatewaySupervisor({
    binary: '/root/.local/bin/elastos',
    spawn() { throw new Error('must not spawn'); },
    fetchHealth: async () => probeHealth,
    sleep: async () => { probeClock += 1000; },
    now: () => probeClock,
    openUrl: () => {},
    log: () => {},
    graceMs: 3000,
    pollMs: 1000,
    adoptInstalled: () => adoptDistroGatewayProcess({
      readPid: () => 77,
      alive: () => { throw new Error('timeout'); },
      signal: (pid, signal) => {
        probeSignals.push([pid, signal]);
        probeHealth = null;
      },
    }),
  });
  await assert.rejects(() => probed.stop({ adopt: true }), /still running/);
  assert.equal(probed.phase(), 'error');
  assert.deepEqual(probeSignals, [[77, 'SIGTERM'], [77, 'SIGKILL']]);
  assert.equal(signals.some(([pid]) => pid === 0), false);
  assert.equal(signals.every(([pid]) => pid === 77), true);

  const source = fs.readFileSync(path.join(__dirname, '../src/main/targets/windowsRuntime.ts'), 'utf8');
  assert.equal(source.includes('signalDistroGateway(0'), false);
  assert.equal(source.includes('hasExited() { return true; }'), false);
  const helper = source.match(/const STOP_HELPER = `\n([\s\S]*?)`\.trim\(\)/);
  assert.ok(helper);
  assert.equal(helper[1].includes('host-process.lock'), false);
  const { spawn, spawnSync } = require('node:child_process');
  const probe = spawnSync('python3', ['-V'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    assert.fail(`python3 is required to test the distro stop helper (${probe.error ? probe.error.message : probe.stderr || probe.stdout})`);
  }
  for (const raw of ['1', '0', 'True', 'true', '-1']) {
    const result = spawnSync('python3', ['-c', helper[1], 'TERM', raw], { encoding: 'utf8' });
    assert.equal(result.error, undefined, raw);
    assert.equal(result.status, 1, `${raw} status ${result.status} ${result.stderr}`);
    assert.equal(/Traceback/.test(result.stderr || ''), false, result.stderr);
  }
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  sleeper.unref();
  try {
    const killed = spawnSync('python3', ['-c', helper[1], 'TERM', String(sleeper.pid)], { encoding: 'utf8' });
    assert.equal(killed.error, undefined);
    assert.equal(killed.status, 0, killed.stderr);
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    assert.throws(() => process.kill(sleeper.pid, 0));
  } finally {
    try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
