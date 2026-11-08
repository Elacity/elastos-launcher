const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercise the packaged loader without running launcher code or a host Runtime.
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'launcher-app-check-'));
const binary = path.join(process.argv[2], 'Contents', 'MacOS', 'ElastOS');
const marker = 'PASS packaged Electron starts';
const result = spawnSync(binary, ['-e', `console.log(${JSON.stringify(marker)})`], {
  env: { ...process.env, HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', timeout: 15000,
});
if (result.status !== 0 || result.stdout.trim() !== marker) {
  console.error(`Packaged Electron failed: status=${result.status} signal=${result.signal} error=${result.error?.message ?? ''}`);
  console.error(result.stderr);
  process.exit(1);
}
console.log(marker);
