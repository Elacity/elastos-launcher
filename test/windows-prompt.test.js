const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { evaluatePreflight, DISK_FLOOR_BYTES } = require('../dist/main/targets/preflight');
const { failureScreen, applyFix } = require('../dist/main/targets/runtimeRecovery');
const { runtimeInstallBlock } = require('../dist/main/targets/runtimeSupport');
const {
  applyWindowsFix,
  assertPinnedRootfs,
  assertPromptHasNoCommands,
  detectWindows,
  ELASTOS_ROOTFS_SHA256,
  ELASTOS_ROOTFS_URL,
  ensureElastosRootfs,
  hostPrompt,
  importDistroArgs,
  claimResumeInstall,
  finishResumeInstall,
  prepareWindowsImportDir,
  RESUME_LOCK_STALE_MS,
  RESUME_TOKEN_STALE_MS,
  markInstallResumeAfterReboot,
  planAfterWindowsRestart,
  resumeInstallPlanOnThisComputer,
  runHostAction,
  WINDOWS_REBOOT_MESSAGE,
} = require('../dist/main/targets/windowsHost');

const base = {
  platform: 'linux',
  arch: 'x64',
  freeBytes: DISK_FLOOR_BYTES,
  portBusy: false,
  healthOk: false,
  offline: false,
  wsl: false,
  kvm: true,
};

function facts(overrides) {
  return {
    error: '',
    checks: [],
    binaryPresent: false,
    componentsPresent: false,
    lockText: null,
    lockPath: null,
    pidAlive: () => false,
    ...overrides,
  };
}

test('linux and Apple silicon install, Intel waits for a signed release', () => {
  assert.equal(runtimeInstallBlock('linux', 'x64'), null);
  assert.equal(runtimeInstallBlock('linux', 'arm64'), null);
  assert.equal(runtimeInstallBlock('darwin', 'arm64'), null);
  assert.equal(runtimeInstallBlock('darwin', 'x64'), 'Intel Mac is not supported yet.');
  const intelPrompt = hostPrompt({ platform: 'darwin', arch: 'x64', wslInstalled: false, distroReady: false });
  assert.equal(intelPrompt.title, 'Intel Mac is not supported yet');
  assert.equal(/source|developer|build|signed|cargo|git/i.test(`${intelPrompt.title} ${intelPrompt.body} ${runtimeInstallBlock('darwin', 'x64')}`), false);
  assert.equal(/terminal|powershell/i.test(runtimeInstallBlock('darwin', 'x64')), false);
  const intel = failureScreen(facts({
    checks: [{ id: 'platform', level: 'block', message: runtimeInstallBlock('darwin', 'x64') }],
  }));
  assert.equal(intel.message, 'Intel Mac is not supported yet.');
  assert.equal(intel.fixLabel, null);
});

test('Windows asks once to enable Linux support and does not show a command', async () => {
  const prompt = hostPrompt({ platform: 'win32', arch: 'x64', wslInstalled: false, distroReady: false });
  assert.equal(prompt.kind, 'enable-wsl');
  assert.equal(prompt.actionLabel, 'Enable');
  assertPromptHasNoCommands(prompt);
  const report = evaluatePreflight({ ...base, platform: 'win32', arch: 'x64', wslInstalled: false });
  assert.equal(report.ok, false);
  const input = facts({
    checks: report.checks,
  });
  const screen = failureScreen(input);
  assert.equal(screen.kind, 'windows');
  assert.equal(screen.fixLabel, 'Fix it');
  assert.equal(/wsl\.exe|powershell|terminal|sudo /i.test(screen.message), false);

  const seen = [];
  await applyWindowsFix(
    { platform: 'win32', arch: 'x64', wslInstalled: false, distroReady: false },
    {
      spawnHidden: async (file, args, options) => {
        seen.push({ file, args: [...args], options });
        return 0;
      },
    },
  );
  assert.equal(seen[0].file, 'wsl.exe');
  assert.deepEqual(seen[0].args, ['--install', '--no-distribution']);
  assert.equal(seen[0].options.windowsHide, true);

  const { windowsFixResult } = require('../dist/main/targets/runtimeRecovery');
  let enabled = false;
  const enable = async () => { enabled = true; };
  assert.equal(await windowsFixResult(enable, async () => null, async () => true), 'still-blocked');
  assert.equal(enabled, true);
  assert.equal(await windowsFixResult(async () => {}, async () => ({ status: 200, body: 'not ok' }), async () => true), 'still-blocked');
  assert.equal(await windowsFixResult(async () => {}, async () => ({ status: 200, body: 'OK' }), async () => false), 'still-blocked');
  assert.equal(await windowsFixResult(async () => {}, async () => ({ status: 200, body: 'OK' }), async () => true), 'ready');
  assert.equal(await applyFix(input, {
    recheckPort: async () => 'busy',
    recheckOnline: async () => false,
    resumeSetup: async () => { throw new Error('should not set up a download'); },
    removeLock: () => { throw new Error('should not remove a lock'); },
    enableWindows: async () => {},
    healthOk: async () => false,
  }), 'still-blocked');
  assert.equal(await applyFix(input, {
    recheckPort: async () => 'busy',
    recheckOnline: async () => false,
    resumeSetup: async () => { throw new Error('should not set up a download'); },
    removeLock: () => { throw new Error('should not remove a lock'); },
    enableWindows: async () => {},
    healthOk: async () => true,
    gatewayIdentity: async () => false,
  }), 'still-blocked');
  assert.equal(await applyFix(input, {
    recheckPort: async () => 'busy',
    recheckOnline: async () => false,
    resumeSetup: async () => { throw new Error('should not set up a download'); },
    removeLock: () => { throw new Error('should not remove a lock'); },
    enableWindows: async () => {},
    healthOk: async () => true,
    gatewayIdentity: async () => true,
  }), 'ready');
});

test('a missing ElastOS distro is one Set up action, and a ready host does not ask for a command', async () => {
  const setup = hostPrompt({ platform: 'win32', arch: 'x64', wslInstalled: true, distroReady: false });
  assert.equal(setup.actionLabel, 'Set up');
  assertPromptHasNoCommands(setup);
  const seen = [];
  const prepared = [];
  await applyWindowsFix(
    { platform: 'win32', arch: 'x64', wslInstalled: true, distroReady: false },
    {
      installDir: 'C:\\ElastOS\\distro',
      ensureRootfs: async () => 'C:\\ElastOS\\rootfs.tar.gz',
      prepareImportDir: (dir) => prepared.push(dir),
      spawnHidden: async (file, args, options) => {
        seen.push({ file, args: [...args], hide: options.windowsHide });
        return 0;
      },
    },
  );
  assert.deepEqual(prepared, ['C:\\ElastOS\\distro']);
  assert.deepEqual(seen[0].args, importDistroArgs('C:\\ElastOS\\distro', 'C:\\ElastOS\\rootfs.tar.gz'));
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-import-'));
  const empty = path.join(importDir, 'distro');
  try {
    prepareWindowsImportDir(empty);
    assert.equal(fs.statSync(empty).isDirectory(), true);
    fs.writeFileSync(path.join(empty, 'keep'), 'x');
    assert.throws(() => prepareWindowsImportDir(empty), /Click Set up/);
  } finally {
    fs.rmSync(importDir, { recursive: true, force: true });
  }
  assert.equal(seen[0].hide, true);
  assert.equal(seen[0].args.includes('Ubuntu'), false);

  const ready = hostPrompt({ platform: 'win32', arch: 'x64', wslInstalled: true, distroReady: true });
  assert.equal(ready.actionLabel, null);
  assertPromptHasNoCommands(ready);
  assert.match(ready.body, /Click Install/);
  assert.equal(/cannot finish/.test(ready.body), false);
  assert.equal(/wsl\.exe|powershell|\bbash\b/.test(ready.body), false);
  const readyReport = evaluatePreflight({
    ...base,
    platform: 'win32',
    arch: 'x64',
    wslInstalled: true,
    distroReady: true,
  });
  assert.equal(readyReport.ok, true);

  await assert.rejects(
    () => applyWindowsFix(
      { platform: 'win32', arch: 'x64', wslInstalled: false, distroReady: false },
      { spawnHidden: async () => 1 },
    ),
    (err) => {
      assert.match(err.message, /Click Enable/);
      assert.equal(/wsl\.exe|powershell/.test(err.message), false);
      return true;
    },
  );
});

test('distro detection and the rootfs download are explicit', async () => {
  const missing = await detectWindows({
    platform: 'win32',
    arch: 'x64',
    lookup: async () => false,
    listDistros: async () => { throw new Error('should not list'); },
  });
  assert.equal(missing.wslInstalled, false);

  const present = await detectWindows({
    platform: 'win32',
    arch: 'arm64',
    lookup: async () => true,
    listDistros: async () => '  NAME      STATE           VERSION\n* ElastOS    Stopped         2\n',
  });
  assert.equal(present.distroReady, true);
  const wrong = await detectWindows({
    platform: 'win32',
    arch: 'x64',
    lookup: async () => true,
    listDistros: async () => '  Ubuntu    Running         2\n',
  });
  assert.equal(wrong.distroReady, false);

  let downloaded = '';
  const dest = await ensureElastosRootfs({
    dest: 'C:\\ElastOS\\rootfs.tar.gz',
    exists: () => false,
    download: async (url, file) => { downloaded = `${url} -> ${file}`; },
  });
  assert.equal(dest, 'C:\\ElastOS\\rootfs.tar.gz');
  assert.match(downloaded, /^https:\/\/cloud-images\.ubuntu\.com\/.+ubuntu-noble-wsl-amd64-wsl\.rootfs\.tar\.gz -> /);
  let called = false;
  await ensureElastosRootfs({
    dest: 'C:\\ElastOS\\rootfs.tar.gz',
    exists: () => true,
    download: async () => { called = true; },
  });
  assert.equal(called, false);

  let checks = 0;
  let replaced = false;
  const again = await ensureElastosRootfs({
    dest: 'C:\\ElastOS\\rootfs.tar.gz',
    exists: () => true,
    read: () => Buffer.from('not-the-rootfs'),
    accept: () => {
      checks += 1;
      if (checks === 1) throw new Error('hash');
    },
    download: async () => { replaced = true; },
  });
  assert.equal(again, 'C:\\ElastOS\\rootfs.tar.gz');
  assert.equal(replaced, true);
  assert.equal(downloaded.includes('/current/'), false);
  assert.match(downloaded, /\/20240423\//);
});

test('the next open continues Install only after Linux support is on', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-resume-'));
  try {
    assert.equal(planAfterWindowsRestart({ marker: false, wslInstalled: true }), 'none');
    assert.equal(await resumeInstallPlanOnThisComputer({ homeDir: home, platform: 'win32', wslInstalled: true }), 'none');
    let marked = 0;
    await assert.rejects(
      () => runHostAction('enable-wsl', {
        spawnHidden: async () => ({ code: 1, stdout: 'A reboot is required.\n', stderr: '' }),
        onReboot: () => { marked += 1; },
      }),
      (err) => {
        assert.equal(err.message, WINDOWS_REBOOT_MESSAGE);
        assert.match(err.message, /Install continues/);
        return true;
      },
    );
    assert.equal(marked, 1);
    markInstallResumeAfterReboot(home);
    const marker = path.join(home, '.elastos-launcher', 'resume-install.json');
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).resume, 'install');
    assert.equal(await resumeInstallPlanOnThisComputer({ homeDir: home, platform: 'win32', wslInstalled: false }), 'wait');
    assert.equal(fs.existsSync(marker), true);
    assert.equal(await resumeInstallPlanOnThisComputer({ homeDir: home, platform: 'linux' }), 'wait');
    assert.equal(await resumeInstallPlanOnThisComputer({
      homeDir: home,
      platform: 'win32',
      wslInstalled: true,
      installed: async () => true,
    }), 'none');
    assert.equal(fs.existsSync(marker), true);
    assert.equal(await resumeInstallPlanOnThisComputer({
      homeDir: home,
      platform: 'win32',
      installed: async () => false,
      detect: async () => { throw new Error('wsl'); },
    }), 'wait');
    assert.equal(fs.existsSync(marker), true);
    const plans = await Promise.all([
      resumeInstallPlanOnThisComputer({ homeDir: home, platform: 'win32', wslInstalled: true, installed: async () => false }),
      resumeInstallPlanOnThisComputer({ homeDir: home, platform: 'win32', wslInstalled: true, installed: async () => false }),
    ]);
    assert.deepEqual(plans.slice().sort(), ['install', 'none']);
    assert.equal(fs.existsSync(marker), true);
    finishResumeInstall(home, false);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(await resumeInstallPlanOnThisComputer({
      homeDir: home,
      platform: 'win32',
      wslInstalled: true,
      installed: async () => false,
    }), 'install');
    finishResumeInstall(home, true);
    assert.equal(fs.existsSync(marker), false);
    const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
    const firstRun = fs.readFileSync(path.join(__dirname, '../docs/FIRST_RUN.md'), 'utf8');
    assert.match(app, /plan !== 'install'/);
    assert.match(app, /finishResumeInstall/);
    assert.match(firstRun, /Install continues/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a stale resume lock can be claimed again and a live one cannot', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-resume-lock-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    markInstallResumeAfterReboot(home);
    const lock = path.join(home, '.elastos-launcher', 'resume-install.json.lock');
    fs.writeFileSync(lock, '');
    assert.equal(await resumeInstallPlanOnThisComputer({
      homeDir: home,
      platform: 'win32',
      wslInstalled: true,
      installed: async () => false,
    }), 'install');
    finishResumeInstall(home, false);
    assert.equal(fs.existsSync(lock), false);

    assert.equal(claimResumeInstall(home), true);
    assert.equal(claimResumeInstall(home), false);
    finishResumeInstall(home, false);

    fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, uptime: os.uptime() }));
    assert.equal(await resumeInstallPlanOnThisComputer({
      homeDir: home,
      platform: 'win32',
      wslInstalled: true,
      installed: async () => false,
    }), 'none');
    const staleAt = new Date(Date.now() - RESUME_LOCK_STALE_MS - 1000);
    fs.utimesSync(lock, staleAt, staleAt);
    assert.equal(await resumeInstallPlanOnThisComputer({
      homeDir: home,
      platform: 'win32',
      wslInstalled: true,
      installed: async () => false,
    }), 'install');
    finishResumeInstall(home, false);

    fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, uptime: os.uptime() + 10000 }));
    assert.equal(claimResumeInstall(home), true);

    const helper = path.join(home, 'claim.js');
    const modulePath = path.join(__dirname, '../dist/main/targets/windowsHost.js');
    fs.writeFileSync(helper, `const { claimResumeInstall } = require(${JSON.stringify(modulePath)});\nprocess.stdout.write(claimResumeInstall(process.argv[2]) ? 'yes' : 'no');\nsetInterval(() => {}, 1000);\n`);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-resume-race-'));
    fs.mkdirSync(path.join(other, '.elastos-launcher'), { recursive: true });
    const claim = () => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [helper, other], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(err || 'claim timed out'));
      }, 5000);
      proc.stdout.on('data', (chunk) => {
        out += chunk;
        if (out === 'yes' || out === 'no') {
          clearTimeout(timer);
          resolve({ proc, out });
        }
      });
      proc.stderr.on('data', (chunk) => { err += chunk; });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(err || `claim exited ${code}`));
      });
    });
    const pair = await Promise.all([claim(), claim()]);
    try {
      assert.deepEqual(pair.map((item) => item.out).sort(), ['no', 'yes']);
    } finally {
      for (const item of pair) item.proc.kill();
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('two reclaimers of one stale resume lock cannot take each others lock', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-resume-reclaim-'));
  try {
    const dir = path.join(home, '.elastos-launcher');
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'resume-install.json.lock');
    const stale = JSON.stringify({ pid: 2147483646, uptime: os.uptime() });
    fs.writeFileSync(lock, stale);
    const helper = path.join(home, 'reclaim.js');
    const modulePath = path.join(__dirname, '../dist/main/targets/windowsHost.js');
    fs.writeFileSync(helper, `
      const { claimResumeInstall } = require(${JSON.stringify(modulePath)});
      const ok = claimResumeInstall(process.argv[2], () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      });
      process.stdout.write(ok ? 'yes' : 'no');
      setInterval(() => {}, 1000);
    `);
    const claim = () => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [helper, home], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(err || 'reclaim timed out'));
      }, 5000);
      proc.stdout.on('data', (chunk) => {
        out += chunk;
        if (out === 'yes' || out === 'no') {
          clearTimeout(timer);
          resolve({ proc, out });
        }
      });
      proc.stderr.on('data', (chunk) => { err += chunk; });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(err || `reclaim exited ${code}`));
      });
    });
    const pair = await Promise.all([claim(), claim()]);
    try {
      assert.deepEqual(pair.map((item) => item.out).sort(), ['no', 'yes']);
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      assert.equal(held.pid === pair[0].proc.pid || held.pid === pair[1].proc.pid, true);
      assert.notEqual(fs.readFileSync(lock, 'utf8'), stale);
    } finally {
      for (const item of pair) item.proc.kill();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reclaim puts a changed lock back and does not replace a newer claim', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-resume-restore-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const dir = path.join(home, '.elastos-launcher');
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'resume-install.json.lock');
    const stale = JSON.stringify({ pid: 2147483646, uptime: os.uptime() });
    const fresh = JSON.stringify({ pid: child.pid, uptime: os.uptime(), start: 'held' });
    fs.writeFileSync(lock, stale);
    assert.equal(claimResumeInstall(home, {
      afterRename(junk) {
        fs.writeFileSync(junk, fresh);
      },
    }), false);
    assert.equal(fs.readFileSync(lock, 'utf8'), fresh);

    fs.writeFileSync(lock, stale);
    const third = JSON.stringify({ pid: 424242, uptime: os.uptime(), start: 'third' });
    assert.equal(claimResumeInstall(home, {
      afterRename(junk) {
        fs.writeFileSync(junk, fresh);
        const tmp = `${lock}.third`;
        fs.writeFileSync(tmp, third);
        fs.linkSync(tmp, lock);
        fs.rmSync(tmp, { force: true });
      },
    }), false);
    assert.equal(fs.readFileSync(lock, 'utf8'), third);
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a reused pid does not hold the resume lock forever', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-resume-reuse-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const dir = path.join(home, '.elastos-launcher');
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'resume-install.json.lock');
    fs.writeFileSync(lock, JSON.stringify({
      pid: child.pid,
      uptime: os.uptime(),
      start: '1',
    }));
    if (process.platform !== 'linux') {
      // No /proc start time. A fresh live pid stays. Silence past the bound is the escape.
      assert.equal(claimResumeInstall(home), false);
      const staleAt = new Date(Date.now() - RESUME_LOCK_STALE_MS - 1000);
      fs.utimesSync(lock, staleAt, staleAt);
    }
    assert.equal(claimResumeInstall(home), true);
    const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.equal(held.pid, process.pid);
    if (process.platform === 'linux') assert.notEqual(held.start, '1');
  } finally {
    child.kill();
    finishResumeInstall(home, false);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const WINDOWS_HOST = path.join(__dirname, '../dist/main/targets/windowsHost.js');
const DEAD_PID = 2147483646;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(file, ms = 10000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    sleepSync(10);
  }
}

/** Another launcher process. It claims once, prints yes or no, and exits. */
function claimInChild(home) {
  const result = spawnSync(process.execPath, ['-e', `
    const { claimResumeInstall } = require(${JSON.stringify(WINDOWS_HOST)});
    process.stdout.write(claimResumeInstall(process.argv[1]) ? 'yes' : 'no');
  `, home], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(result.stderr || `claim exited ${result.status}`);
  return result.stdout;
}

function resumeLockFixture(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(home, '.elastos-launcher');
  fs.mkdirSync(dir, { recursive: true });
  return { home, lock: path.join(dir, 'resume-install.json.lock'), token: path.join(dir, 'resume-install.json.lock.reclaim') };
}

test('three launchers reclaim one stale resume lock and exactly one wins', () => {
  const { home, lock, token } = resumeLockFixture('elastos-resume-three-');
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, uptime: os.uptime() }));
    const others = [];
    // This process holds the token and has judged the lock stale. Two more
    // launchers try now: both see the same stale lock and must stop.
    assert.equal(claimResumeInstall(home, {
      beforeRename() {
        assert.equal(JSON.parse(fs.readFileSync(token, 'utf8')).pid, process.pid);
        others.push(claimInChild(home), claimInChild(home));
      },
    }), true);
    assert.deepEqual(others, ['no', 'no']);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(token), false);
    // A fourth launcher after the claim sees a live, fresh lock.
    assert.equal(claimInChild(home), 'no');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  } finally {
    finishResumeInstall(home, false);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a reclaimer that moved a live reclaim token puts it back and stops', async () => {
  const { home, lock, token } = resumeLockFixture('elastos-resume-token-');
  const ready = path.join(home, 'c-ready');
  const go = path.join(home, 'go');
  let racer = null;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, uptime: os.uptime() }));
    // A reclaimer crashed while it held the token.
    fs.writeFileSync(token, JSON.stringify({ pid: DEAD_PID - 1, uptime: os.uptime() }));
    let out = '';
    let err = '';
    const racerDone = new Promise((resolve) => {
      // This process read the dead token. Before it moves that name, launcher C
      // takes the token the normal way and stops just before it moves the lock.
      const mine = claimResumeInstall(home, {
        beforeTokenRename() {
          racer = spawn(process.execPath, ['-e', `
            const fs = require('fs');
            const { claimResumeInstall } = require(${JSON.stringify(WINDOWS_HOST)});
            const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            const ok = claimResumeInstall(process.argv[1], {
              beforeRename() {
                fs.writeFileSync(process.argv[2], 'ready');
                const until = Date.now() + 10000;
                while (!fs.existsSync(process.argv[3]) && Date.now() < until) wait();
              },
            });
            process.stdout.write(ok ? 'yes' : 'no');
          `, home, ready, go], { stdio: ['ignore', 'pipe', 'pipe'] });
          racer.stdout.on('data', (chunk) => { out += chunk; });
          racer.stderr.on('data', (chunk) => { err += chunk; });
          racer.on('exit', (code) => resolve({ code }));
          waitForFile(ready);
          assert.equal(JSON.parse(fs.readFileSync(token, 'utf8')).pid, racer.pid);
        },
      });
      // This process moved C's live token, saw it was not the dead one, put it
      // back, and stopped. Only C may reclaim.
      assert.equal(mine, false);
      assert.equal(JSON.parse(fs.readFileSync(token, 'utf8')).pid, racer.pid);
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, DEAD_PID);
      fs.writeFileSync(go, 'go');
    });
    const { code } = await racerDone;
    assert.equal(code, 0, err);
    assert.equal(out, 'yes');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, racer.pid);
    assert.equal(fs.existsSync(token), false);
  } finally {
    if (racer && racer.exitCode == null) racer.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a reclaim token with a reused pid does not block resume forever', () => {
  const { home, lock, token } = resumeLockFixture('elastos-resume-token-age-');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, uptime: os.uptime() }));
    fs.writeFileSync(token, JSON.stringify({ pid: child.pid, uptime: os.uptime() }));
    // A live, fresh token holder is mid-reclaim. Wait for it.
    assert.equal(claimResumeInstall(home), false);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, DEAD_PID);
    // The same pid, silent past the token bound, is a crashed reclaimer whose pid was reused.
    const old = new Date(Date.now() - RESUME_TOKEN_STALE_MS - 1000);
    fs.utimesSync(token, old, old);
    assert.equal(claimResumeInstall(home), true);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(token), false);
  } finally {
    child.kill();
    finishResumeInstall(home, false);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('finishing a resume does not remove a lock another launcher claimed', () => {
  const { home, lock } = resumeLockFixture('elastos-resume-finish-');
  try {
    markInstallResumeAfterReboot(home);
    const other = JSON.stringify({ pid: DEAD_PID, uptime: os.uptime() });
    fs.writeFileSync(lock, other);
    finishResumeInstall(home, false);
    assert.equal(fs.readFileSync(lock, 'utf8'), other);
    fs.rmSync(lock);
    assert.equal(claimResumeInstall(home), true);
    finishResumeInstall(home, true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(path.join(home, '.elastos-launcher', 'resume-install.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('enabling Linux support says to restart when Windows asks for a reboot', async () => {
  await assert.rejects(
    () => applyWindowsFix(
      { platform: 'win32', arch: 'x64', wslInstalled: false, distroReady: false },
      {
        spawnHidden: async (file, args) => {
          assert.equal(file, 'wsl.exe');
          assert.deepEqual([...args], ['--install', '--no-distribution']);
          return { code: 1, stdout: 'A reboot is required to finish this operation.\n', stderr: '' };
        },
      },
    ),
    (err) => {
      assert.equal(err.message, WINDOWS_REBOOT_MESSAGE);
      assert.equal(/wsl\.exe|powershell|terminal|sudo /.test(err.message), false);
      return true;
    },
  );
});

test('a rootfs with the wrong size or hash is refused', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/windows-elastos-distro.ps1'), 'utf8');
  assert.equal(script.includes('/current/'), false);
  assert.match(script, new RegExp(ELASTOS_ROOTFS_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(script, new RegExp(ELASTOS_ROOTFS_SHA256));
  assert.match(script, /Rootfs SHA-256/);
  assert.match(script, /larger than the cap/);
  assert.throws(() => assertPinnedRootfs(Buffer.alloc(32, 1)), /not the pinned file/);
  const capped = Buffer.alloc(8);
  assert.throws(() => assertPinnedRootfs(capped), /not the pinned file/);
});
