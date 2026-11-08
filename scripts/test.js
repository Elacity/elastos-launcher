const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// macOS /var is a symlink. Removal fixtures need the physical temporary root
// because the production removal guard deliberately refuses symlink parents.
const temp = fs.realpathSync(os.tmpdir());
const files = fs.readdirSync('test').filter((file) => file.endsWith('.test.js')).map((file) => path.join('test', file));
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit', env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
});
process.exit(result.status ?? 1);
