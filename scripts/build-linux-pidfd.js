const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'linux') process.exit(0);
const output = path.join(__dirname, '../dist/native/linux-pidfd');
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync('cc', [
  '-Wall', '-Wextra', '-Werror', '-O2',
  path.join(__dirname, '../src/native/linux-pidfd.c'), '-o', output,
], { stdio: 'inherit', timeout: 30000 });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
