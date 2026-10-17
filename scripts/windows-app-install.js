#!/usr/bin/env node
/**
 * Drive the Windows Install button path: install inside the ElastOS distro,
 * start the gateway without a terminal, and require /healthz from Windows.
 * Then Reset with a copy, require the distro to hold no program or data,
 * and require Install to install again.
 */
const { installRuntimeOnThisComputer } = require('../dist/main/targets/runtimeInstall');
const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
const { HOME_URL, getLocalPath, isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');
const { readStoredZipEntries } = require('../dist/main/targets/runtimeBackup');
const { distroResetPaths, resetRuntimeInDistroOnThisComputer } = require('../dist/main/targets/windowsReset');
const { distroIsInstalled, runWslSync } = require('../dist/main/targets/windowsRuntime');
const { isRuntimeDataName } = require('../dist/main/targets/runtimePaths');
const { execFileSync } = require('child_process');
const fs = require('fs');

async function main() {
  await installRuntimeOnThisComputer((message) => {
    console.log(message);
  });
  const target = createRuntimeTarget();
  await target.start();

  // Probe every address localhost resolves to, as the launcher does.
  let health = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    health = await probeGatewayHealth();
    if (isHealthOk(health)) break;
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  if (!isHealthOk(health)) {
    throw new Error(`/healthz was not OK (${health ? `HTTP ${health.status} ${health.body.trim()}` : 'no answer'})`);
  }
  console.log(`/healthz is OK on ${health.addresses.join(', ')}`);

  for (const address of health.addresses) {
    const home = await getLocalPath(address, '/home/', 15000);
    console.log(`/home/ HTTP ${home ? home.status : 'no answer'} on ${address}`);
    if (!home || home.status !== 200) {
      throw new Error(`Expected /home/ to return 200 on ${address}`);
    }
  }
  console.log(`Opening Home in the Windows browser: ${HOME_URL}`);
  await target.stop();
  console.log('Gateway stopped cleanly');

  // Print every top-level entry of the distro data folder, so a name Reset
  // does not know is visible in this log in full, not cut after five.
  const { dataDir } = distroResetPaths();
  const listing = runWslSync(['ls', '-lA', '--full-time', dataDir]);
  console.log(`Top-level entries of ${dataDir} before Reset:\n${listing.stdout.trimEnd()}`);
  const names = runWslSync(['ls', '-1A', dataDir]).stdout.split('\n').filter(Boolean);
  const unknown = names.filter((name) => !isRuntimeDataName(name));
  console.log(unknown.length ? `Names Reset does not know (${unknown.length}): ${unknown.join(', ')}` : 'Reset knows every name');

  // Reset with a copy, as the Reset button does on Windows.
  const reset = await resetRuntimeInDistroOnThisComputer(() => target.stopForRemoval(), { backup: true });
  if (!reset.backupPath || !fs.statSync(reset.backupPath).isFile()) {
    throw new Error('Reset did not save a copy of the ElastOS data');
  }
  const entries = readStoredZipEntries(reset.backupPath);
  if (!entries.length || entries.some((entry) => !entry.name.startsWith('elastos/'))) {
    throw new Error(`The copy has unexpected entries (${entries.length})`);
  }
  console.log(`Reset saved ${entries.length} files in ${reset.backupPath} (${fs.statSync(reset.backupPath).size} bytes)`);
  console.log(execFileSync('icacls.exe', [reset.backupPath], { encoding: 'utf8' }).trim());
  if (distroIsInstalled()) {
    throw new Error('After Reset, the ElastOS distro still has the program or its data');
  }
  console.log('After Reset, the ElastOS distro has no program and no data');

  const again = [];
  await installRuntimeOnThisComputer((message) => {
    again.push(message);
    console.log(`(after Reset) ${message}`);
  });
  if (again.includes('ElastOS is already installed.') || !again.includes('install.sh SHA-256 matches the pin')) {
    throw new Error('After Reset, Install did not install ElastOS again');
  }
  console.log('After Reset, Install installed ElastOS again');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
