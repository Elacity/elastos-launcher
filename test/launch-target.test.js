const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  targetSupportsHost,
  RUNTIME_TARGET,
} = require('../dist/main/targets');

test('the only target is the runtime', () => {
  assert.equal(DEFAULT_LAUNCH_TARGET, 'runtime');
  assert.equal(parseLaunchTargetId(undefined), 'runtime');
  assert.equal(parseLaunchTargetId(''), 'runtime');
  assert.equal(parseLaunchTargetId('runtime'), 'runtime');
  assert.equal(parseLaunchTargetId('elastos-runtime'), 'runtime');
  assert.equal(currentLaunchTargetId({}), 'runtime');
  assert.equal(currentLaunchTargetId({ [LAUNCH_TARGET_ENV]: 'runtime' }), 'runtime');
  assert.equal(createLaunchTarget().id, 'runtime');
  assert.equal(createLaunchTargetFromEnv({}).id, 'runtime');
  assert.equal(createLaunchTargetFromEnv({ OTHER: 'runtime' }).id, 'runtime');
});

test('a missing runtime does not start', async () => {
  const target = createLaunchTarget('runtime');
  assert.equal(target.descriptor.implemented, true);
  await assert.rejects(() => target.start(), /not installed yet/);
  assert.equal(target.getVersion(), 'not installed');
});

test('unknown target ids fail closed', () => {
  assert.throws(() => parseLaunchTargetId('serve'), /Unknown launch target/);
  assert.throws(() => currentLaunchTargetId({ [LAUNCH_TARGET_ENV]: 'gateway' }), /Unknown launch target/);
  assert.throws(() => resolveLaunchTargetId({ explicit: 'other' }), /Unknown launch target/);
  assert.throws(() => resolveLaunchTargetId({ explicit: 'pc2' }), /Unknown launch target/);
});

test('ELASTOS_LAUNCH_TARGET=pc2 opens the runtime', () => {
  const { createDefaultLaunchController, createLaunchController } = require('../dist/main/launchController');
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    const controller = createDefaultLaunchController({ [LAUNCH_TARGET_ENV]: 'pc2' });
    assert.equal(controller.target.id, 'runtime');
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /pc2 is retired/);
  assert.throws(
    () => createLaunchController({ env: { [LAUNCH_TARGET_ENV]: 'pc2' } }),
    /Unknown launch target/,
  );
});

test('quit waits for the gateway this launcher started and leaves one it did not', async () => {
  const { createLaunchController, finishQuitAfterGatewayStop } = require('../dist/main/launchController');
  const controller = createLaunchController({ env: {} });
  let stopped = false;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  controller.target.stop = async () => {
    await pending;
    stopped = true;
  };
  const gate = { started: false, ready: false };
  const events = [];
  const quits = [];
  const done = finishQuitAfterGatewayStop(
    gate,
    { preventDefault() { events.push('prevent'); } },
    () => controller.shutdown(),
    () => { quits.push('quit'); },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['prevent']);
  assert.equal(stopped, false);
  assert.deepEqual(quits, []);
  release();
  await done;
  assert.equal(stopped, true);
  assert.equal(gate.ready, true);
  assert.deepEqual(quits, ['quit']);

  const again = [];
  await finishQuitAfterGatewayStop(
    gate,
    { preventDefault() { again.push('prevent'); } },
    async () => { again.push('stop'); },
    () => { again.push('quit'); },
  );
  assert.deepEqual(again, []);

  const foreign = createLaunchController({ env: {} });
  foreign.target.stop = async () => {
    throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
  };
  await foreign.shutdown();
  const foreignQuits = [];
  await finishQuitAfterGatewayStop(
    { started: false, ready: false },
    { preventDefault() {} },
    () => foreign.shutdown(),
    () => { foreignQuits.push('quit'); },
  );
  assert.deepEqual(foreignQuits, ['quit']);
});

test('the runtime health contract is the gateway', () => {
  assert.equal(RUNTIME_TARGET.health.url, 'http://127.0.0.1:8090/healthz');
  assert.equal(RUNTIME_TARGET.health.expectBodyIncludes, 'OK');
  assert.equal(RUNTIME_TARGET.openUrl, 'http://127.0.0.1:8090/home/');
  assert.deepEqual(RUNTIME_TARGET.startArgs, ['gateway', '--addr', '127.0.0.1:8090']);
  assert.equal(RUNTIME_TARGET.binary, '~/.local/bin/elastos');
  assert.equal(getLaunchTargetDescriptor('runtime').id, 'runtime');
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'darwin', 'arm64'), true);
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'darwin', 'x64'), true);
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'linux', 'x64'), true);
  assert.equal(targetSupportsHost(RUNTIME_TARGET, 'win32', 'x64'), false);
});

test('install logs a missing runtime and does not spawn another product', async () => {
  const { createLaunchController } = require('../dist/main/launchController');
  const logs = [];
  const controller = createLaunchController({ env: {} });
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
  assert.equal(runtimeInstalls, 1);
  await assert.rejects(() => controller.start(), /not installed yet/);
  assert.match(logs.join('\n'), /not installed yet/);
  assert.equal(controller.target.id, 'runtime');
  assert.equal(resolveLaunchTargetId({}), 'runtime');
  assert.equal(resolveLaunchTargetId({ env: { [LAUNCH_TARGET_ENV]: 'elastos-runtime' } }), 'runtime');

  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8');
  assert.equal(main.includes('./targets'), false);
  assert.equal(main.includes('elastos:start'), true);
  assert.equal(preload.includes("exposeInMainWorld('elastos'"), true);
  assert.equal(preload.includes('elastos:install'), true);
});
