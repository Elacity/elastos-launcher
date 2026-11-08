const { createLaunchController } = require('../dist/main/launchController');

// Keep the real controller, replacing its Runtime boundary and host-only queries.
function controllerFixture() {
  const launch = createLaunchController({ env: {} });
  const runtime = { calls: [], running: true, wait: {} };
  for (const action of ['start', 'stop', 'restart', 'update', 'rollback']) {
    launch.target[action] = async () => {
      runtime.calls.push(action);
      runtime.running = action === 'start' || action === 'restart';
      await runtime.wait[action]?.();
    };
  }
  launch.target.getStatus = async () => runtime.running ? 'running' : 'stopped';
  launch.target.openInBrowser = () => {};
  launch.target.checkForUpdate = async () => ({ latest: '2.0.1', updateAvailable: true, releaseUrl: '' });
  launch.getOpenAtLogin = () => false;
  launch.resumeInstallPlan = async () => 'none';
  launch.describeResetBackup = async () => ({ present: true, enough: true });
  launch.describeFailure = async () => ({ message: 'The download stopped.', fixLabel: null });
  return { launch, runtime };
}

module.exports = { controllerFixture };
