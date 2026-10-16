const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { installRuntime, pinnedInstallerLaunch } = require('../dist/main/targets/runtimeInstall');
const { runtimeBinaryPath, runtimeJoin } = require('../dist/main/targets/runtimePaths');
const { runtimeInstallBlock } = require('../dist/main/targets/runtimeSupport');
const {
  assertDistroPath,
  distroGatewayArgs,
  distroInstallerArgs,
  distroPackageArgs,
  DISTRO_INSTALL_DIR,
  DISTRO_SETUP_FAILED,
  ensureElastosDistro,
  factsAreElastos,
  signalDistroGateway,
  wslCommandPrefix,
  wslSpawnEnv,
} = require('../dist/main/targets/windowsRuntime');
const { importDistroArgs } = require('../dist/main/targets/windowsHost');

const HEAD = 'QmUmMZD3yNs4C7JvtichoZ727gN2ntXNnCDF1QTHkNKhXt';
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

  const script = fs.readFileSync(path.join(__dirname, '../scripts/windows-app-install.js'), 'utf8');
  assert.match(script, /installRuntimeOnThisComputer/);
  assert.match(script, /createRuntimeTarget/);
  assert.match(script, /\/healthz is OK/);
  assert.match(script, /Opening Home in the Windows browser/);
  assert.equal(/windows-elastos-distro/.test(script), false);
});
