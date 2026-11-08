const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// macOS native Electron paths ignore HOME. Full launches belong only on the
// disposable CI runner. Local artifact verification must use --loader-only.
const loaderOnly = process.argv[3] === '--loader-only';
if (!loaderOnly && process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Full packaged launch runs only on the GitHub runner. Use --loader-only locally.');
}
const loaderHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'launcher-app-check-'));
const binary = path.join(process.argv[2], 'Contents', 'MacOS', 'ElastOS');
const marker = 'PASS packaged Electron starts';
const result = spawnSync(binary, ['-e', `console.log(${JSON.stringify(marker)})`], {
  env: { ...process.env, HOME: loaderHome, USERPROFILE: loaderHome, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', timeout: 15000,
});
if (result.status !== 0 || result.stdout.trim() !== marker) {
  console.error(`Packaged Electron failed: status=${result.status} signal=${result.signal} error=${result.error?.message ?? ''}`);
  console.error(result.stderr);
  process.exit(1);
}
console.log(marker);

async function verifyProfile() {
  const { _electron: electron } = require('playwright');
  // Use the runner's native home so Electron's old default and Runtime's path
  // reproduce the case-insensitive collision. Refuse a preexisting Runtime.
  const home = fs.realpathSync(os.homedir());
  const profile = path.join(home, '.elastos-launcher', 'electron');
  const runtime = path.join(home, 'Library', 'Application Support', 'elastos');
  assert.equal(fs.existsSync(runtime), false, 'packaged check requires a fresh CI Runtime directory');
  const sentinels = { identity: 'scratch identity', signing_key: 'scratch key', 'sources.json': '{"sources":[]}' };
  fs.mkdirSync(runtime, { recursive: true });
  for (const [name, contents] of Object.entries(sentinels)) {
    fs.writeFileSync(path.join(runtime, name), contents);
  }
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: (process.env.PATH ?? '').split(path.delimiter).filter((dir) =>
      !fs.existsSync(path.join(dir, 'elastos')) && !fs.existsSync(path.join(dir, 'elastos.exe'))).join(path.delimiter),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  for (const attempt of [1, 2]) {
    const electronApp = await electron.launch({ executablePath: binary, env, timeout: 30000 });
    const watchdog = setTimeout(() => electronApp.process().kill('SIGKILL'), 90000);
    try {
      const page = await electronApp.firstWindow({ timeout: 15000 });
      await page.waitForLoadState('domcontentloaded');
      const stored = await page.evaluate(() => {
        const prior = localStorage.getItem('packaged-profile-check');
        localStorage.setItem('packaged-profile-check', 'persisted');
        return prior;
      });
      if (attempt === 2) assert.equal(stored, 'persisted', 'profile survives launcher restart');
      const actual = await electronApp.evaluate(({ app, session }) => ({
        home: app.getPath('home'), userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData'), storage: session.defaultSession.storagePath,
        logs: app.getPath('logs'),
      }));
      console.log(`Packaged launch ${attempt}: ${JSON.stringify(actual)}`);
      const entries = fs.readdirSync(runtime);
      console.log(`Runtime entries after launch: ${entries.join(', ')}`);
      assert.deepEqual(entries.sort(), Object.keys(sentinels).sort(), 'Runtime Home has no Chromium profile entries, including Singleton*');
      assert.equal(actual.home, home);
      assert.equal(actual.userData, profile);
      assert.equal(actual.sessionData, profile);
      assert.equal(actual.storage, profile);
      assert.equal(actual.logs, path.join(profile, 'logs'));
      assert.ok(fs.statSync(path.join(profile, 'Local Storage')).isDirectory());
    } finally {
      try { await electronApp.close(); } finally { clearTimeout(watchdog); }
    }
    assert.ok(fs.statSync(path.join(profile, 'Preferences')).isFile());
    assert.deepEqual(fs.readdirSync(runtime).sort(), Object.keys(sentinels).sort(), 'Runtime Home is unchanged after quit');
    for (const [name, contents] of Object.entries(sentinels)) {
      assert.equal(fs.readFileSync(path.join(runtime, name), 'utf8'), contents);
    }
  }
  console.log('PASS packaged launcher profile and logs use ~/.elastos-launcher/electron across restart; Runtime Home is unchanged');
}

if (!loaderOnly) verifyProfile().catch((err) => { console.error(err); process.exitCode = 1; });
