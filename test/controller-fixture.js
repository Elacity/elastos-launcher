const { createLaunchController } = require('../dist/main/launchController');
const gateway = require('../dist/main/targets/runtimeGateway');
const windows = require('../dist/main/targets/windowsRuntime');
const targets = require('../dist/main/targets');
const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');

// Real controller, target and supervisor. Only installation, update commands,
// process handles and health are fake. Every replacement shares the same world.
function runtimeFixtures(t, platform) {
  let world;
  function supervisor(lifetime) {
    const runtime = world;
    const sup = gateway.createGatewaySupervisor({
      lifetime, platform, binary: '/fixture/elastos', args: gateway.homeLaunchForPlatform(platform).args,
      spawn() {
        runtime.calls.push('start'); runtime.running = true;
        const proc = {
          pid: 123, spawnedHere: true, exited: false,
          onOutput() {}, onExit(fn) { this.exit = fn; },
          async hasExited() { await runtime.wait.hasExited?.(); await runtime.wait.start?.(); return this.exited; },
          signal() { this.exited = true; runtime.running = false; this.exit?.(0); },
        };
        runtime.proc = proc;
        return proc;
      },
      async fetchHealth() {
        await runtime.wait.start?.();
        return runtime.running ? { status: 200, body: 'OK' } : null;
      },
      sleep: async () => { runtime.clock += 1000; }, now: () => runtime.clock,
      openUrl() {}, log() {},
    });
    const stop = sup.stop;
    sup.stop = async (...args) => {
      runtime.calls.push('stop');
      await runtime.wait.stop?.();
      return stop(...args);
    };
    runtime.supervisors.push(sup);
    return sup;
  }
  t.mock.method(gateway, 'createDefaultGatewaySupervisor', (_file, actualPlatform, lifetime) => {
    if (actualPlatform !== platform) throw new Error(`Wrong platform: ${actualPlatform}`);
    return supervisor(lifetime);
  });
  t.mock.method(windows, 'createDistroGatewaySupervisor', supervisor);
  t.mock.method(windows, 'distroIsInstalled', () => true);
  t.mock.method(gateway, 'installedGatewayOnThisComputer', async () => 'none');
  t.mock.method(require('../dist/main/targets/runtimeProbe'), 'findRuntimeBinary', () => '/fixture/elastos');
  t.mock.method(require('../dist/main/targets/runtimePin'), 'loadActiveRuntimePin', () => ({
    maintainerDid: 'did:example:test', publisherGateway: 'https://example.invalid', version: '2.0.0',
  }));
  for (const [method, action] of [['applyRuntimeUpdate', 'update'], ['rollbackRuntime', 'rollback']]) {
    t.mock.method(require('../dist/main/targets/runtimeUpdate'), method, async () => {
      world.calls.push(action); await world.wait[action]?.();
    });
  }
  t.mock.method(targets, 'createLaunchTarget', () => createRuntimeTarget(platform, platform === 'darwin' ? 'arm64' : 'x64', world.lifetime));
  return () => {
    world = { lifetime: { shuttingDown: false, shutdown() { this.shuttingDown = true; } }, calls: [], running: false, wait: {}, clock: 0, supervisors: [] };
    const launch = createLaunchController({ env: {} });
    // These observations are controlled separately from process ownership.
    launch.target.getStatus = async () => world.running ? 'running' : 'stopped';
    launch.target.openInBrowser = () => {};
    launch.target.checkForUpdate = async () => ({ latest: '2.0.1', updateAvailable: true, releaseUrl: '' });
    launch.getOpenAtLogin = () => false;
    launch.resumeInstallPlan = async () => 'none';
    launch.describeResetBackup = async () => ({ present: true, enough: true });
    launch.describeFailure = async () => ({ message: 'The download stopped.', fixLabel: null });
    return { launch, runtime: world };
  };
}
module.exports = { runtimeFixtures };
