const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);
const output = path.join(__dirname, '../dist/native/mac-process-info');
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync('cc', [
  '-Wall', '-Wextra', '-Werror', '-O2', '-arch', 'arm64', '-arch', 'x86_64',
  path.join(__dirname, '../src/native/mac-process-info.c'), '-lproc', '-o', output,
], { stdio: 'inherit', timeout: 30000 });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
