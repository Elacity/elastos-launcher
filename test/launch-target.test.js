const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createLaunchTarget,
  createLaunchTargetFromEnv,
  currentLaunchTargetId,
  DEFAULT_LAUNCH_TARGET,
  getLaunchTargetDescriptor,
  LAUNCH_TARGET_ENV,
  parseLaunchTargetId,
  resolveLaunchTargetId,
  createLaunchTargetStore,
  targetSupportsHost,
  PC2_TARGET,
  RUNTIME_TARGET,
} = require('../dist/main/targets');

test('default target is PC2', () => {
  assert.equal(DEFAULT_LAUNCH_TARGET, 'pc2');
  assert.equal(parseLaunchTargetId(undefined), 'pc2');
  assert.equal(parseLaunchTargetId(''), 'pc2');
  assert.equal(parseLaunchTargetId('  PC2  '), 'pc2');
  assert.equal(parseLaunchTargetId('pc2.net'), 'pc2');
  assert.equal(currentLaunchTargetId({}), 'pc2');
  assert.equal(createLaunchTarget().id, 'pc2');
  assert.equal(createLaunchTargetFromEnv({}).id, 'pc2');
  assert.equal(createLaunchTargetFromEnv({ OTHER: 'runtime' }).id, 'pc2');
});

test('runtime is opt-in and does not start until it is installed', async () => {
  assert.equal(parseLaunchTargetId('runtime'), 'runtime');
  assert.equal(parseLaunchTargetId('elastos-runtime'), 'runtime');
  assert.equal(currentLaunchTargetId({ [LAUNCH_TARGET_ENV]: 'runtime' }), 'runtime');

  const target = createLaunchTarget('runtime');
  assert.equal(target.id, 'runtime');
  assert.equal(target.descriptor.implemented, true);
  await assert.rejects(() => target.start(), /not installed yet/);
  assert.equal(target.getVersion(), 'not installed');
});

test('unknown target ids fail closed', () => {
  assert.throws(() => parseLaunchTargetId('serve'), /Unknown launch target/);
  assert.throws(() => currentLaunchTargetId({ [LAUNCH_TARGET_ENV]: 'gateway' }), /Unknown launch target/);
});

test('descriptors keep the PC2 and runtime health contracts apart', () => {
  assert.equal(PC2_TARGET.implemented, true);
  assert.equal(PC2_TARGET.health.url, 'http://localhost:4200/health');
  assert.equal(PC2_TARGET.openUrl, 'http://localhost:4200');

  assert.equal(RUNTIME_TARGET.health.url, 'http://127.0.0.1:8090/healthz');
  assert.equal(RUNTIME_TARGET.health.expectBodyIncludes, 'OK');
  assert.equal(RUNTIME_TARGET.openUrl, 'http://127.0.0.1:8090/home/');
  assert.deepEqual(RUNTIME_TARGET.startArgs, ['gateway', '--addr', '127.0.0.1:8090']);
  assert.equal(RUNTIME_TARGET.binary, '~/.local/bin/elastos');

  assert.equal(getLaunchTargetDescriptor('pc2').id, 'pc2');
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'darwin', 'arm64'), true);
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'darwin', 'x64'), true);
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'win32', 'x64'), false);
  assert.equal(targetSupportsHost(PC2_TARGET, 'win32', 'x64'), true);
  assert.equal(targetSupportsHost(PC2_TARGET, 'darwin', 'x64'), true);
});

test('PC2 target methods are the pc2Manager functions', async () => {
  const pc2 = require('../dist/main/pc2Manager');
  const target = createLaunchTarget('pc2');
  assert.equal(target.isInstalled, pc2.isInstalled);
  assert.equal(target.getStatus, pc2.getStatus);
  assert.equal(target.start, pc2.startPC2);
  assert.equal(target.stop, pc2.stopPC2);
  assert.equal(target.restart, pc2.restartPC2);
  assert.equal(target.install, pc2.installPC2);
  assert.equal(target.update, pc2.updatePC2);
  assert.equal(target.uninstall, pc2.uninstallPC2);
  assert.equal(target.getVersion, pc2.getPC2Version);
  assert.equal(target.checkForUpdate, pc2.checkForUpdate);
  assert.equal(target.openInBrowser, pc2.openInBrowser);
  assert.equal(target.getLogs, pc2.getLogs);
  assert.equal(typeof await target.isInstalled(), 'boolean');
});

test('forcing runtime logs the stable error and does not install PC2', async () => {
  const pc2 = require('../dist/main/pc2Manager');
  const { createLaunchController } = require('../dist/main/launchController');
  let installs = 0;
  const original = pc2.installPC2;
  pc2.installPC2 = async () => {
    installs += 1;
  };
  try {
    const logs = [];
    const controller = createLaunchController({
      env: { ELASTOS_LAUNCH_TARGET: 'runtime' },
      store: { get: () => undefined, set() {}, delete() {} },
    });
    controller.onLog((line) => logs.push(line));
    const runtimeInstall = require('../dist/main/targets/runtimeInstall');
    const originalInstall = runtimeInstall.installRuntimeOnThisComputer;
    let runtimeInstalls = 0;
    runtimeInstall.installRuntimeOnThisComputer = async () => {
      runtimeInstalls += 1;
    };
    try {
      await controller.install(() => {});
    } finally {
      runtimeInstall.installRuntimeOnThisComputer = originalInstall;
    }
    assert.equal(installs, 0);
    assert.equal(runtimeInstalls, 1);
    await assert.rejects(() => controller.start(), /not installed yet/);
    assert.match(logs.join('\n'), /not installed yet/);
    assert.equal(controller.target.id, 'runtime');

    const stored = createLaunchController({
      env: {},
      store: { get: () => 'runtime', set() {}, delete() {} },
    });
    assert.equal(stored.target.id, 'runtime');
    const envWins = createLaunchController({
      env: { ELASTOS_LAUNCH_TARGET: 'pc2' },
      store: { get: () => 'runtime', set() {}, delete() {} },
    });
    assert.equal(envWins.target.start, pc2.startPC2);
  } finally {
    pc2.installPC2 = original;
  }
});

test('launch target precedence is explicit, then env, then store, then the published pin', () => {
  const { createLaunchController } = require('../dist/main/launchController');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-launch-target-'));
  const store = createLaunchTargetStore(dir);

  assert.equal(resolveLaunchTargetId({}), 'runtime');
  assert.equal(resolveLaunchTargetId({ env: {}, store }), 'runtime');
  assert.equal(createLaunchController({
    env: {},
    store: { get: () => undefined, set() {}, delete() {} },
  }).target.id, 'runtime');

  store.set('runtime');
  assert.equal(resolveLaunchTargetId({ env: {}, store }), 'runtime');
  assert.equal(
    resolveLaunchTargetId({ env: { ELASTOS_LAUNCH_TARGET: 'pc2' }, store }),
    'pc2',
  );
  assert.equal(
    resolveLaunchTargetId({
      explicit: 'runtime',
      env: { ELASTOS_LAUNCH_TARGET: 'pc2' },
      store,
    }),
    'runtime',
  );

  assert.equal(
    resolveLaunchTargetId({
      explicit: '   ',
      env: { ELASTOS_LAUNCH_TARGET: 'runtime' },
      store,
    }),
    'runtime',
  );

  store.set('nope');
  assert.throws(() => resolveLaunchTargetId({ env: {}, store }), /Unknown launch target/);

  store.delete();
  assert.equal(store.get(), undefined);
  assert.equal(resolveLaunchTargetId({ env: {}, store }), 'runtime');
  store.set('pc2');
  assert.equal(resolveLaunchTargetId({ env: {}, store }), 'pc2');

  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.equal(main.includes('./targets'), false);
  assert.equal(main.includes('pc2Manager'), true);
});
