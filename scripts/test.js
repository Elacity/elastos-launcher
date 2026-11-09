const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// macOS /var is a symlink. Removal fixtures need the physical temporary root
// because the production removal guard deliberately refuses symlink parents.
const temp = fs.realpathSync(os.tmpdir());
// Unit tests must never discover or run a host installation through HOME or PATH.
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), '.launcher-unit-'));
const safePath = (process.env.PATH ?? '').split(path.delimiter).filter((dir) =>
  !fs.existsSync(path.join(dir, 'elastos')) && !fs.existsSync(path.join(dir, 'elastos.exe'))).join(path.delimiter);
const files = fs.readdirSync('test').filter((file) => file.endsWith('.test.js')).map((file) => path.join('test', file));
// Renderer Chromium and wall-clock process tests must not contend for the host.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit', env: {
    ...process.env,
    ELASTOS_TEST_CHROMIUM: process.env.ELASTOS_TEST_CHROMIUM || require('playwright').chromium.executablePath(),
    HOME: home, USERPROFILE: home, PATH: safePath,
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: temp, TMP: temp, TEMP: temp,
  },
});
// Keep nonempty failure fixtures for diagnosis. Remove only this empty directory.
try { fs.rmdirSync(home); } catch {}
process.exit(result.status ?? 1);
