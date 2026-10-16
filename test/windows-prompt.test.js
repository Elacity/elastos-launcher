const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluatePreflight, DISK_FLOOR_BYTES } = require('../dist/main/targets/preflight');
const { failureScreen, applyFix } = require('../dist/main/targets/runtimeRecovery');
const { runtimeInstallBlock } = require('../dist/main/targets/runtimeSupport');
const {
  applyWindowsFix,
  assertPromptHasNoCommands,
  detectWindows,
  ensureElastosRootfs,
  hostPrompt,
  importDistroArgs,
} = require('../dist/main/targets/windowsHost');

const base = {
  platform: 'linux',
  arch: 'x64',
  freeBytes: DISK_FLOOR_BYTES,
  portBusy: false,
  healthOk: false,
  offline: false,
  wsl: false,
  kvm: true,
};

function facts(overrides) {
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

test('linux and Apple silicon install, Intel waits for a signed release', () => {
  assert.equal(runtimeInstallBlock('linux', 'x64'), null);
  assert.equal(runtimeInstallBlock('linux', 'arm64'), null);
  assert.equal(runtimeInstallBlock('darwin', 'arm64'), null);
  assert.match(runtimeInstallBlock('darwin', 'x64'), /not yet supported on Intel Macs/);
  assert.equal(/PC2|terminal|powershell/i.test(runtimeInstallBlock('darwin', 'x64')), false);
  const intel = failureScreen(facts({
    checks: [{ id: 'platform', level: 'block', message: runtimeInstallBlock('darwin', 'x64') }],
  }));
  assert.match(intel.message, /Intel Macs/);
  assert.equal(intel.fixLabel, null);
});

test('Windows asks once to enable Linux support and does not show a command', async () => {
  const prompt = hostPrompt({ platform: 'win32', arch: 'x64', wslInstalled: false, distroReady: false });
  assert.equal(prompt.kind, 'enable-wsl');
  assert.equal(prompt.actionLabel, 'Enable');
  assertPromptHasNoCommands(prompt);
  const report = evaluatePreflight({ ...base, platform: 'win32', arch: 'x64', wslInstalled: false });
  assert.equal(report.ok, false);
  const input = facts({
    checks: report.checks,
  });
  const screen = failureScreen(input);
  assert.equal(screen.kind, 'windows');
  assert.equal(screen.fixLabel, 'Fix it');
  assert.equal(/wsl\.exe|powershell|terminal|sudo /i.test(screen.message), false);

  const seen = [];
  await applyWindowsFix(
    { platform: 'win32', arch: 'x64', wslInstalled: false, distroReady: false },
    {
      spawnHidden: async (file, args, options) => {
        seen.push({ file, args: [...args], options });
        return 0;
      },
    },
  );
  assert.equal(seen[0].file, 'wsl.exe');
  assert.deepEqual(seen[0].args, ['--install', '--no-distribution']);
  assert.equal(seen[0].options.windowsHide, true);

  let enabled = false;
  assert.equal(await applyFix(input, {
    recheckPort: async () => 'busy',
    recheckOnline: async () => false,
    resumeSetup: async () => { throw new Error('should not set up a download'); },
    removeLock: () => { throw new Error('should not remove a lock'); },
    enableWindows: async () => { enabled = true; },
  }), 'ready');
  assert.equal(enabled, true);
});

test('a missing ElastOS distro is one Set up action, and a ready host does not ask for a command', async () => {
  const setup = hostPrompt({ platform: 'win32', arch: 'x64', wslInstalled: true, distroReady: false });
  assert.equal(setup.actionLabel, 'Set up');
  assertPromptHasNoCommands(setup);
  const seen = [];
  await applyWindowsFix(
    { platform: 'win32', arch: 'x64', wslInstalled: true, distroReady: false },
    {
      installDir: 'C:\\ElastOS\\distro',
      ensureRootfs: async () => 'C:\\ElastOS\\rootfs.tar.gz',
      spawnHidden: async (file, args, options) => {
        seen.push({ file, args: [...args], hide: options.windowsHide });
        return 0;
      },
    },
  );
  assert.deepEqual(seen[0].args, importDistroArgs('C:\\ElastOS\\distro', 'C:\\ElastOS\\rootfs.tar.gz'));
  assert.equal(seen[0].hide, true);
  assert.equal(seen[0].args.includes('Ubuntu'), false);

  const ready = hostPrompt({ platform: 'win32', arch: 'x64', wslInstalled: true, distroReady: true });
  assert.equal(ready.actionLabel, null);
  assertPromptHasNoCommands(ready);
  assert.match(ready.body, /cannot finish the install/);

  await assert.rejects(
    () => applyWindowsFix(
      { platform: 'win32', arch: 'x64', wslInstalled: false, distroReady: false },
      { spawnHidden: async () => 1 },
    ),
    (err) => {
      assert.match(err.message, /Click Enable/);
      assert.equal(/wsl\.exe|powershell/.test(err.message), false);
      return true;
    },
  );
});

test('distro detection and the rootfs download are explicit', async () => {
  const missing = await detectWindows({
    platform: 'win32',
    arch: 'x64',
    lookup: async () => false,
    listDistros: async () => { throw new Error('should not list'); },
  });
  assert.equal(missing.wslInstalled, false);

  const present = await detectWindows({
    platform: 'win32',
    arch: 'arm64',
    lookup: async () => true,
    listDistros: async () => '  NAME      STATE           VERSION\n* ElastOS    Stopped         2\n',
  });
  assert.equal(present.distroReady, true);
  const wrong = await detectWindows({
    platform: 'win32',
    arch: 'x64',
    lookup: async () => true,
    listDistros: async () => '  Ubuntu    Running         2\n',
  });
  assert.equal(wrong.distroReady, false);

  let downloaded = '';
  const dest = await ensureElastosRootfs({
    dest: 'C:\\ElastOS\\rootfs.tar.gz',
    exists: () => false,
    download: async (url, file) => { downloaded = `${url} -> ${file}`; },
  });
  assert.equal(dest, 'C:\\ElastOS\\rootfs.tar.gz');
  assert.match(downloaded, /^https:\/\/cloud-images\.ubuntu\.com\/.+ubuntu-noble-wsl-amd64-wsl\.rootfs\.tar\.gz -> /);
  let called = false;
  await ensureElastosRootfs({
    dest: 'C:\\ElastOS\\rootfs.tar.gz',
    exists: () => true,
    download: async () => { called = true; },
  });
  assert.equal(called, false);
});
