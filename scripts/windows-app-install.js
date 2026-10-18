#!/usr/bin/env node
/**
 * Drive the Windows Install button path: install inside the ElastOS distro,
 * start the gateway without a terminal, and require /healthz from Windows.
 * Then Reset with a copy, require the distro to hold no program or data,
 * and require Install to install again. Then Uninstall, answering yes to
 * the second question: require a saved copy of the whole Linux environment
 * in ElastOS-backups, the ElastOS distro to be gone, and the restore hint
 * (`wsl --import`) to bring back a file outside the data folder, the
 * install record, and the program. Then remove it again.
 */
const { installRuntimeOnThisComputer } = require('../dist/main/targets/runtimeInstall');
const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
const { HOME_URL, getLocalPath, isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');
const { backupFolder, readStoredZipEntries } = require('../dist/main/targets/runtimeBackup');
const { distroResetPaths, resetRuntimeInDistroOnThisComputer } = require('../dist/main/targets/windowsReset');
const { distroIsInstalled, runWslSync } = require('../dist/main/targets/windowsRuntime');
const {
  elastosRowOf, listDistroNames, uninstallRuntimeInDistroOnThisComputer, verifyExportFile, wslListLines,
} = require('../dist/main/targets/windowsUninstall');
const { isRuntimeDataName } = require('../dist/main/targets/runtimePaths');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  // A file a person could keep outside the data folder. Uninstall saves the whole
  // Linux environment first, so this file must be in the saved copy.
  const marker = runWslSync(['bash', '-c', 'mkdir -p /srv && printf kept > /srv/elastos-ci-marker.txt && cat /srv/elastos-ci-marker.txt']);
  if (marker.code !== 0 || marker.stdout !== 'kept') throw new Error('Could not write /srv/elastos-ci-marker.txt before Uninstall');
  const uninstall = await uninstallRuntimeInDistroOnThisComputer(() => target.stopForRemoval(), { backup: false }, async (prompt) => {
    console.log(`Second question: ${prompt.title} ${prompt.message} ${prompt.detail} -> ${prompt.confirmLabel}`);
    return true;
  });
  if (!uninstall.removedLinux) throw new Error('Uninstall did not remove the ElastOS Linux environment');
  const saved = uninstall.linuxCopyPath;
  if (!saved || path.dirname(saved) !== backupFolder(os.homedir())) {
    throw new Error(`Uninstall did not save the whole Linux environment in ${backupFolder(os.homedir())} (${saved})`);
  }
  console.log(`Uninstall saved the whole Linux environment in ${saved} (${verifyExportFile(saved)} bytes)`);
  console.log(execFileSync('icacls.exe', [saved], { encoding: 'utf8' }).trim());
  console.log(`Restore hint: ${uninstall.restoreHint}`);
  const after = await listDistroNames();
  const lines = wslListLines(after.stdout);
  console.log(`After Uninstall, wsl.exe --list --quiet exit ${after.code}, lines: ${JSON.stringify(lines)}`);
  if (elastosRowOf(after) !== 'absent') throw new Error('After Uninstall, wsl.exe still lists ElastOS');
  console.log('After Uninstall, the ElastOS Linux environment is gone');

  // The restore hint, run as it is written: wsl --import ElastOS C:\\ElastOS\\distro "<file>".
  const check = 'ElastOS';
  const where = 'C:\\ElastOS\\distro';
  if (uninstall.restoreHint !== `To bring it back, open PowerShell and run: wsl --import ${check} ${where} "${saved}"`) {
    throw new Error(`Unexpected restore hint: ${uninstall.restoreHint}`);
  }
  execFileSync('wsl.exe', ['--import', check, where, saved], { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  try {
    const back = spawnSync('wsl.exe', ['-d', check, '-u', 'root', '--', 'bash', '-c',
      'cat /srv/elastos-ci-marker.txt && test -f /root/.local/share/elastos/installation/release-head.json && test -x /root/.local/bin/elastos && echo " record program"'],
    { encoding: 'utf8', timeout: 5 * 60 * 1000 });
    console.log(`After wsl --import: exit ${back.status}, ${JSON.stringify((back.stdout || '').trim())}`);
    if (back.status !== 0 || (back.stdout || '').trim() !== 'kept record program') {
      throw new Error('The saved file did not bring back the marker, the install record, and the program');
    }
    console.log('The restore hint brought back /srv/elastos-ci-marker.txt, the install record, and the program');
  } finally {
    execFileSync('wsl.exe', ['--unregister', check], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
    fs.rmSync(saved, { force: true });
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
