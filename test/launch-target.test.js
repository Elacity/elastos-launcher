const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createLaunchTarget,
  createLaunchTargetFromEnv,
  currentLaunchTargetId,
  DEFAULT_LAUNCH_TARGET,
  getLaunchTargetDescriptor,
  LAUNCH_TARGET_ENV,
  parseLaunchTargetId,
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

test('runtime is opt-in and not implemented', async () => {
  assert.equal(parseLaunchTargetId('runtime'), 'runtime');
  assert.equal(parseLaunchTargetId('elastos-runtime'), 'runtime');
  assert.equal(currentLaunchTargetId({ [LAUNCH_TARGET_ENV]: 'runtime' }), 'runtime');

  const target = createLaunchTarget('runtime');
  assert.equal(target.id, 'runtime');
  assert.equal(target.descriptor.implemented, false);
  await assert.rejects(() => target.start(), /cannot start yet/);
  assert.throws(() => target.getVersion(), /cannot read version yet/);
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
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'darwin', 'x64'), false);
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'win32', 'x64'), false);
  assert.equal(targetSupportsHost(PC2_TARGET, 'win32', 'x64'), true);
  assert.equal(targetSupportsHost(PC2_TARGET, 'darwin', 'x64'), true);
});

test('PC2 target delegates to the existing manager without starting it', async () => {
  const target = createLaunchTarget('pc2');
  assert.equal(typeof target.getVersion(), 'string');
  assert.equal(typeof await target.isInstalled(), 'boolean');
});
