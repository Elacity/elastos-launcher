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
  RETIRED_PC2_NOTICE,
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
  assert.equal(parseLaunchTargetId('pc2'), 'runtime');
  assert.equal(parseLaunchTargetId(' PC2 '), 'runtime');
  assert.equal(resolveLaunchTargetId({ explicit: 'pc2' }), 'runtime');
});

test('ELASTOS_LAUNCH_TARGET=pc2 opens the runtime', async () => {
  const { createDefaultLaunchController, createLaunchController } = require('../dist/main/launchController');
  const fromEnv = createDefaultLaunchController({ [LAUNCH_TARGET_ENV]: 'pc2' });
  assert.equal(fromEnv.target.id, 'runtime');
  assert.match(await fromEnv.getLogs(), new RegExp(RETIRED_PC2_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const fromExplicit = createLaunchController({ explicit: ' PC2 ', env: {} });
  assert.equal(fromExplicit.target.id, 'runtime');
  assert.match(await fromExplicit.getLogs(), /Opening the ElastOS runtime/);
  const untouched = createLaunchController({ env: {} });
  assert.equal((await untouched.getLogs()).includes('pc2 is retired'), false);
});

test('quit waits for the gateway this launcher started and leaves one it did not', async () => {
  const { createLaunchController, finishQuitAfterGatewayStop, QUIT_STOP_BUDGET_MS } = require('../dist/main/launchController');
  const { ForeignGatewayError, STOP_GRACE_MS } = require('../dist/main/targets/runtimeGateway');
  assert.ok(QUIT_STOP_BUDGET_MS >= 2 * STOP_GRACE_MS + 3 * 2000);
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
    throw new ForeignGatewayError();
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

  const plain = createLaunchController({ env: {} });
  plain.target.stop = async () => {
    throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
  };
  await assert.rejects(() => plain.shutdown(), /did not start it/);

  const unhandled = [];
  const onUnhandled = (err) => { unhandled.push(err); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const logs = [];
    const quits = [];
    let stopped = false;
    await finishQuitAfterGatewayStop(
      { started: false, ready: false },
      { preventDefault() {} },
      () => new Promise(() => {}),
      () => { quits.push('quit'); stopped = true; },
      {
        budgetMs: 30,
        log: (line) => logs.push(line),
        onStopping: () => logs.push('stopping'),
      },
    );
    await finishQuitAfterGatewayStop(
      { started: false, ready: false },
      { preventDefault() {} },
      () => Promise.reject(new Error('shutdown failed')),
      () => { quits.push('quit'); },
      { budgetMs: 200, log: (line) => logs.push(line) },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0);
    assert.equal(stopped, true);
    assert.deepEqual(quits, ['quit', 'quit']);
    assert.equal(logs.includes('stopping'), true);
    assert.match(logs.join('\n'), /did not stop before quit finished/);
    assert.match(logs.join('\n'), /shutdown failed/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  const order = [];
  await finishQuitAfterGatewayStop(
    { started: false, ready: false },
    { preventDefault() {} },
    () => new Promise(() => {}),
    () => { order.push('quit'); },
    { budgetMs: 30, onBudget: () => { order.push('kill'); } },
  );
  assert.deepEqual(order, ['kill', 'quit']);

  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(main, /Stopping ElastOS/);
  assert.match(main, /elastos:resumeInstallPlan/);
  assert.match(main, /forceStopGateway/);
  const controllerSrc = fs.readFileSync(path.join(__dirname, '../src/main/launchController.ts'), 'utf8');
  const targetSrc = fs.readFileSync(path.join(__dirname, '../src/main/targets/runtimeTarget.ts'), 'utf8');
  assert.match(controllerSrc, /resetRuntimeOnThisComputer\(\(\) => active\.stopForRemoval\(\)\)/);
  assert.match(controllerSrc, /await active\.stop\(\)/);
  assert.match(targetSrc, /stop: \(\) => stopGateway\(false\)/);
  assert.match(targetSrc, /stopForRemoval: \(\) => stopGateway\(true\)/);
  assert.match(targetSrc, /await stopGateway\(false\)/);
  assert.match(targetSrc, /runtimeUninstall\(\(\) => stopGateway\(true\)\)/);
  assert.equal(main.includes('./targets'), false);
  assert.match(app, /resumeInstallPlan/);
  assert.match(app, /finishResumeInstall/);
  const replay = main.slice(main.indexOf('ready-to-show'), main.indexOf('Check initial status'));
  assert.match(replay, /elastos:log/);
  assert.equal(/log\.info/.test(replay), false);
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
