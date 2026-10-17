const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DISTRO_RESET_HELPER } = require('../dist/main/targets/distroResetHelper');
const {
  describeDistroBackup,
  distroHelperArgs,
  distroRemovalPlan,
  distroResetPaths,
  elastosDistroPresent,
  inspectDistro,
  measureDistroBackup,
  ownerOnlyAclArgs,
  removeInDistro,
  resetRuntimeInDistro,
  spawnHelper,
  windowsRestrictToOwner,
  writeDistroBackup,
} = require('../dist/main/targets/windowsReset');
const { RESET_CHOICE_MESSAGE, removeVerifiedTarget } = require('../dist/main/targets/runtimeUninstall');
const { BACKUP_FOLDER_NAME, readStoredZipEntries } = require('../dist/main/targets/runtimeBackup');
const { distroIsInstalled } = require('../dist/main/targets/windowsRuntime');
const { installRuntime } = require('../dist/main/targets/runtimeInstall');
const { loadActiveRuntimePin } = require('../dist/main/targets/runtimePin');

const SIGNED_HEAD = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-head-0.8.0-alpha.22.json'));
const PIN = loadActiveRuntimePin();
const DID = PIN.maintainerDid;
const PLENTY = () => 1e12;
// The helper runs inside Linux. Here it runs with this machine's python3, so these tests need POSIX.
const POSIX = { skip: process.platform === 'win32' };

/**
 * The real helper, run with this machine's python3 instead of wsl.exe. The
 * arguments after the command are the same ones wsl.exe gets after --exec.
 */
function localRun(calls, override = {}) {
  return async (op, input, options) => {
    calls.push(op);
    if (override[op]) return override[op](input, options);
    const args = distroHelperArgs(op);
    const at = args.indexOf('--exec');
    return spawnHelper('python3', args.slice(at + 2), input, options);
  };
}

/** A Linux environment root holding what Install and one gateway start leave there. */
function distroFixture() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-distro-reset-'));
  const root = path.join(top, 'root');
  const winHome = path.join(top, 'Users', 'tester');
  const paths = distroResetPaths(root);
  const put = (rel, text = rel) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put('.local/bin/elastos', 'program');
  put('.elastos-launcher/install-stage.json', '{"stage":"done"}');
  put('.elastos-launcher/install.sh', 'script');
  put('.local/share/elastos/installation/release-head.json', SIGNED_HEAD);
  put('.local/share/elastos/installation/release.json', '{}');
  put('.local/share/elastos/components.json', '{}');
  put('.local/share/elastos/sources.json', JSON.stringify({
    default_source: 'default',
    sources: [{ name: 'default', head_cid: PIN.headCid }],
  }));
  put('.local/share/elastos/signing_key', 'secret key bytes');
  put('.local/share/elastos/identity/device.key', 'device key');
  put('.local/share/elastos/Users/alice/notes.txt', 'my notes');
  put('.local/share/elastos/MyWebSite/index.html', '<p>hi</p>');
  put('.local/share/elastos/capsules/qwen/weights.gguf', 'w'.repeat(9000));
  put('.local/share/elastos/bin/helper', 'x'.repeat(5000));
  put('.local/share/elastos/gateway-runtime-coords.json', '{"attach_secret":"s"}');
  put('.local/share/elastos/host-process.lock', '{"pid":1}');
  // Things Reset must leave alone.
  put('.bashrc', 'keep');
  put('Documents/thesis.docx', 'keep');
  put('.local/share/other-app/data', 'keep');
  fs.mkdirSync(path.join(winHome, '.elastos-launcher'), { recursive: true });
  fs.writeFileSync(path.join(winHome, '.elastos-launcher', 'install-stage.json'), '{"stage":"done"}');
  fs.writeFileSync(path.join(winHome, '.elastos-launcher', 'ubuntu-noble-wsl.rootfs.tar.gz'), 'rootfs');
  return { top, root, winHome, paths, put, cleanup: () => fs.rmSync(top, { recursive: true, force: true }) };
}

const KEPT = [
  'elastos/MyWebSite/index.html',
  'elastos/Users/alice/notes.txt',
  'elastos/identity/device.key',
  'elastos/signing_key',
];

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Map a /root path the launcher asks about to the fixture root. */
function inRoot(fx) {
  return (file) => path.join(fx.root, file.replace(/^\/root\/?/, ''));
}

function resetDeps(fx, calls, extra = {}) {
  const run = extra.run ?? localRun(calls, extra.override);
  return {
    backup: true,
    homeDir: fx.winHome,
    platform: 'linux',
    env: {},
    paths: fx.paths,
    stop: async () => { calls.push('stop'); },
    distroPresent: async () => true,
    inspect: () => inspectDistro(run, fx.paths),
    maintainerDid: DID,
    checkBackupSpace: async () => {
      const seen = await describeDistroBackup({ run, home: fx.winHome, paths: fx.paths, distroPresent: async () => true, freeBytes: extra.freeBytes ?? PLENTY });
      if (seen.present && !seen.enough) throw new Error('There is not enough free space for a copy of your data');
    },
    saveBackup: () => writeDistroBackup({
      run,
      paths: fx.paths,
      home: fx.winHome,
      platform: 'linux',
      restrict: extra.restrict ?? (() => { calls.push('restrict'); }),
      freeBytes: PLENTY,
    }),
    removeInDistro: (plan) => removeInDistro(run, fx.paths, plan),
    removeHost: (target) => { calls.push(`host:${path.basename(target)}`); removeVerifiedTarget(target); },
    ...extra.deps,
  };
}

function assertUntouched(fx) {
  assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'bin', 'elastos'), 'utf8'), 'program');
  assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'share', 'elastos', 'Users', 'alice', 'notes.txt'), 'utf8'), 'my notes');
  assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'share', 'elastos', 'signing_key'), 'utf8'), 'secret key bytes');
  assert.equal(exists(path.join(fx.root, '.elastos-launcher', 'install-stage.json')), true);
  assert.equal(exists(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), true);
}

function backupFiles(fx) {
  try {
    return fs.readdirSync(path.join(fx.winHome, BACKUP_FOLDER_NAME));
  } catch {
    return [];
  }
}

async function installedPlan(fx) {
  let ranInstaller = false;
  const map = inRoot(fx);
  await installRuntime({
    platform: 'linux',
    arch: 'x64',
    homeDir: '/root',
    env: {},
    pin: PIN,
    probe: async () => (exists(map('/root/.local/bin/elastos'))
      ? { kind: 'version', version: `ElastOS Runtime v${PIN.version}`, binaryPath: '/root/.local/bin/elastos' }
      : { kind: 'not-installed' }),
    fetchText: async (url) => {
      if (url.endsWith('/release-head.json')) return SIGNED_HEAD.toString('utf8');
      throw new Error('stop here: the installer download was asked for');
    },
    runInstaller: async () => { ranInstaller = true; return { stdout: '', stderr: '' }; },
    runSetup: async () => ({ stdout: '', stderr: '' }),
    writeFile() {},
    readFile: (file) => fs.readFileSync(map(file), 'utf8'),
    exists: (file) => exists(map(file)),
    statMtimeMs: () => null,
    mkdirp() {},
  }).catch((err) => {
    if (!/installer download was asked for/.test(err.message)) throw err;
    ranInstaller = 'download';
  });
  return ranInstaller;
}

test('Windows Reset saves a copy, then deletes exactly the runtime paths in the distro, and Install starts over', POSIX, async () => {
  const fx = distroFixture();
  try {
    const map = inRoot(fx);
    assert.equal(distroIsInstalled((file) => exists(map(file))), true);
    assert.equal(await installedPlan(fx), false, 'before Reset, Install sees ElastOS as installed');

    const calls = [];
    const removed = [];
    const deps = resetDeps(fx, calls);
    const remove = deps.removeInDistro;
    deps.removeInDistro = async (plan) => {
      const list = await remove(plan);
      removed.push(...list);
      return list;
    };
    const result = await resetRuntimeInDistro(deps);

    assert.deepEqual(calls, [
      'inspect', 'measure', 'stop', 'measure', 'restrict', 'restrict', 'zip', 'inspect', 'remove',
      'host:install-stage.json', 'host:resume-install.json', 'host:resume-install.json.lock',
    ]);
    assert.deepEqual(removed.sort(), [fx.paths.binary, fx.paths.dataDir, fx.paths.stageFile].sort());
    assert.equal(exists(fx.paths.binary), false);
    assert.equal(exists(fx.paths.dataDir), false);
    assert.equal(exists(fx.paths.stageFile), false);
    // Nothing else in the Linux environment, and not the environment's files on Windows.
    assert.equal(fs.readFileSync(path.join(fx.root, '.bashrc'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(fx.root, 'Documents', 'thesis.docx'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'share', 'other-app', 'data'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(fx.root, '.elastos-launcher', 'install.sh'), 'utf8'), 'script');
    assert.deepEqual(fs.readdirSync(path.join(fx.root, '.local', 'share')), ['other-app']);
    assert.equal(exists(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), false);
    assert.equal(exists(path.join(fx.winHome, '.elastos-launcher', 'ubuntu-noble-wsl.rootfs.tar.gz')), true);

    // The copy is on the Windows side, owner-only, and holds only what Install cannot get again.
    assert.ok(result.backupPath);
    assert.equal(path.dirname(result.backupPath), path.join(fx.winHome, BACKUP_FOLDER_NAME));
    assert.match(path.basename(result.backupPath), /^ElastOS-data-\d{8}-\d{6}Z\.zip$/);
    assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(result.backupPath)).mode & 0o777, 0o700);
    const entries = readStoredZipEntries(result.backupPath);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), KEPT);
    const fd = fs.openSync(result.backupPath, 'r');
    const notes = entries.find((entry) => entry.name === 'elastos/Users/alice/notes.txt');
    const buf = Buffer.alloc(notes.size);
    fs.readSync(fd, buf, 0, notes.size, notes.dataOffset);
    fs.closeSync(fd);
    assert.equal(buf.toString('utf8'), 'my notes');

    assert.equal(distroIsInstalled((file) => exists(map(file))), false);
    assert.equal(await installedPlan(fx), 'download', 'after Reset, Install downloads and installs again');
  } finally {
    fx.cleanup();
  }
});

test('Windows Reset without an answer to the backup offer does nothing', POSIX, async () => {
  const fx = distroFixture();
  try {
    for (const backup of [undefined, null, 'yes', 1]) {
      const calls = [];
      await assert.rejects(() => resetRuntimeInDistro({ ...resetDeps(fx, calls), backup }), (err) => err.message === RESET_CHOICE_MESSAGE);
      assert.deepEqual(calls, []);
    }
    assertUntouched(fx);
  } finally {
    fx.cleanup();
  }
});

test('a failed copy on Windows deletes nothing in the distro and leaves no partial file', POSIX, async () => {
  const fx = distroFixture();
  try {
    const cases = [
      // The helper stops part way: a cut-off zip, then an error.
      { zip: async (_input, options) => { fs.writeSync(options.outFd, Buffer.from('PK\x03\x04partial')); return { code: 1, stdout: '', stderr: 'boom' }; } },
      // The helper says it finished, but the zip is cut off.
      { zip: async (input, options) => {
        const args = distroHelperArgs('zip');
        const tmp = path.join(fx.top, 'full.zip');
        const out = fs.openSync(tmp, 'w');
        const full = await spawnHelper('python3', args.slice(args.indexOf('--exec') + 2), input, { outFd: out });
        fs.closeSync(out);
        const bytes = fs.readFileSync(tmp);
        fs.writeSync(options.outFd, bytes.subarray(0, bytes.length - 30));
        return full;
      } },
      // One stored byte flipped: the CRC check fails.
      { zip: async (input, options) => {
        const args = distroHelperArgs('zip');
        const tmp = path.join(fx.top, 'full.zip');
        const out = fs.openSync(tmp, 'w');
        const full = await spawnHelper('python3', args.slice(args.indexOf('--exec') + 2), input, { outFd: out });
        fs.closeSync(out);
        const bytes = fs.readFileSync(tmp);
        const at = bytes.indexOf(Buffer.from('my notes'));
        bytes[at] ^= 0xff;
        fs.writeSync(options.outFd, bytes);
        return full;
      } },
    ];
    for (const override of cases) {
      const calls = [];
      await assert.rejects(
        () => resetRuntimeInDistro(resetDeps(fx, calls, { override })),
        /ElastOS was not reset\. The copy of your data could not be saved \(.+\)\. Nothing was deleted\./,
      );
      assert.equal(calls.includes('remove'), false);
      assert.equal(calls.some((call) => call.startsWith('host:')), false);
      assertUntouched(fx);
      assert.deepEqual(backupFiles(fx), []);
    }
    // Owner-only access that cannot be set also stops Reset before any delete.
    const calls = [];
    await assert.rejects(
      () => resetRuntimeInDistro(resetDeps(fx, calls, { restrict: () => { throw new Error('ElastOS could not make the folder private to this Windows account.'); } })),
      /could not be saved \(ElastOS could not make the folder private to this Windows account\)\. Nothing was deleted\./,
    );
    assert.equal(calls.includes('remove'), false);
    assertUntouched(fx);
  } finally {
    fx.cleanup();
  }
});

test('not enough free space on Windows refuses before the distro gateway is stopped', POSIX, async () => {
  const fx = distroFixture();
  try {
    const calls = [];
    await assert.rejects(
      () => resetRuntimeInDistro(resetDeps(fx, calls, { freeBytes: () => 1024 })),
      /ElastOS was not reset\. There is not enough free space for a copy of your data\. Nothing was deleted\. Free some space, or reset without a copy\./,
    );
    assert.deepEqual(calls, ['inspect', 'measure']);
    assertUntouched(fx);
    // The dialog says the same before the person chooses.
    const seen = await describeDistroBackup({ run: localRun([]), home: fx.winHome, paths: fx.paths, distroPresent: async () => true, freeBytes: () => 1024 });
    assert.equal(seen.present, true);
    assert.equal(seen.enough, false);
    assert.equal(seen.folder, path.join(fx.winHome, BACKUP_FOLDER_NAME));
    const measured = await measureDistroBackup(localRun([]), fx.paths);
    assert.equal(measured.files, KEPT.length);
    assert.equal(measured.bytes, KEPT.reduce((sum, name) => sum + fs.statSync(path.join(fx.root, '.local', 'share', name)).size, 0));
  } finally {
    fx.cleanup();
  }
});

test('a user file in the distro data folder is refused by name, and nothing is stopped or deleted', POSIX, async () => {
  const fx = distroFixture();
  try {
    fx.put('.local/share/elastos/notes.txt', 'keep');
    fx.put('.local/share/elastos/Documents/cv.pdf', 'keep');
    for (const backup of [true, false]) {
      const calls = [];
      await assert.rejects(
        () => resetRuntimeInDistro({ ...resetDeps(fx, calls), backup }),
        /^Error: ElastOS will not reset .*\/root\/\.local\/share\/elastos in its Linux environment, because it contains files that are not part of the runtime: Documents, notes\.txt\. Move those files out, then reset\. Nothing was deleted\. To see them, open \\\\wsl\$\\ElastOS\\.*\\root\\\.local\\share\\elastos in File Explorer\.$/,
      );
      assert.deepEqual(calls, ['inspect']);
    }
    assertUntouched(fx);
    assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'share', 'elastos', 'notes.txt'), 'utf8'), 'keep');
  } finally {
    fx.cleanup();
  }
});

test('a forged, missing, foreign-signed, or linked install record in the distro is refused', POSIX, async () => {
  const fx = distroFixture();
  try {
    const record = path.join(fx.root, '.local', 'share', 'elastos', 'installation', 'release-head.json');
    const unproved = /will not reset .* in its Linux environment, because it has no signed ElastOS install record\. ElastOS deletes only a folder it can prove it installed\. Nothing was deleted\./;
    const attempt = async (did = DID) => {
      const calls = [];
      await assert.rejects(() => resetRuntimeInDistro({ ...resetDeps(fx, calls), backup: false, maintainerDid: did }), unproved);
      assert.deepEqual(calls, ['inspect']);
      assertUntouched(fx);
    };
    // Payload edited after signing.
    const head = JSON.parse(SIGNED_HEAD.toString('utf8'));
    head.payload.version = '0.8.0-alpha.99';
    fs.writeFileSync(record, JSON.stringify(head));
    await attempt();
    // Signed, but not by the pinned maintainer, or no pin at all.
    fs.writeFileSync(record, SIGNED_HEAD);
    await attempt('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    await attempt(null);
    // Missing.
    fs.rmSync(record);
    await attempt();
    // A real record reached through a link.
    fs.writeFileSync(path.join(fx.top, 'elsewhere.json'), SIGNED_HEAD);
    fs.symlinkSync(path.join(fx.top, 'elsewhere.json'), record);
    await attempt();
  } finally {
    fx.cleanup();
  }
});

test('names with spaces, quotes, and shell text go through stdin and never into the wsl.exe arguments', POSIX, async () => {
  const fx = distroFixture();
  try {
    const hostile = `a "b" 'c' $(touch PWNED) \`touch PWNED2\` ; rm -rf ~ & %USERPROFILE%`;
    fx.put(`.local/share/elastos/Users/alice/${hostile}.txt`, 'odd name');
    fx.put('.local/share/elastos/Users/alice/line\nbreak.txt', 'newline');
    fx.put('.local/share/elastos/Users/alice/back\\slash.txt', 'backslash');
    const before = distroHelperArgs('zip');
    for (const op of ['inspect', 'measure', 'zip', 'remove']) {
      const args = distroHelperArgs(op);
      assert.deepEqual(args, ['-d', 'ElastOS', '-u', 'root', '--exec', '/usr/bin/python3', '-c', DISTRO_RESET_HELPER, op]);
    }
    // The helper text itself has nothing a command line or shell could rewrite.
    assert.equal(/["\\$`]/.test(DISTRO_RESET_HELPER), false);
    const spawned = [];
    const calls = [];
    const run = async (op, input, options) => {
      calls.push(op);
      const args = distroHelperArgs(op);
      spawned.push(args);
      assert.equal(JSON.stringify(args).includes('touch'), false);
      return spawnHelper('python3', args.slice(args.indexOf('--exec') + 2), input, options);
    };
    const result = await resetRuntimeInDistro(resetDeps(fx, calls, { run }));
    assert.deepEqual(before, distroHelperArgs('zip'));
    for (const args of spawned) assert.deepEqual(args.slice(0, 8), before.slice(0, 8));
    const names = readStoredZipEntries(result.backupPath).map((entry) => entry.name);
    assert.ok(names.includes(`elastos/Users/alice/${hostile}.txt`));
    assert.ok(names.includes('elastos/Users/alice/line\nbreak.txt'));
    assert.ok(names.includes('elastos/Users/alice/back\\slash.txt'));
    assert.equal(exists(path.join(fx.root, 'PWNED')), false);
    assert.equal(exists(path.join(process.cwd(), 'PWNED')), false);
    assert.equal(exists(path.join(process.cwd(), 'PWNED2')), false);
    assert.equal(exists(fx.paths.dataDir), false);
    assert.equal(fs.readFileSync(path.join(fx.root, '.bashrc'), 'utf8'), 'keep');

    // A hostile name at the top of the data folder is named back exactly, and refused.
    const fx2 = distroFixture();
    try {
      fx2.put(`.local/share/elastos/${hostile}`, 'x');
      await assert.rejects(
        () => resetRuntimeInDistro({ ...resetDeps(fx2, []), backup: false }),
        (err) => err.message.includes(`not part of the runtime: ${hostile}. Move those files out`),
      );
      assertUntouched(fx2);
    } finally {
      fx2.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('the distro delete refuses when anything changed after the ownership check', POSIX, async () => {
  const fx = distroFixture();
  try {
    const run = localRun([]);
    const plan = distroRemovalPlan(await inspectDistro(run, fx.paths), fx.paths, DID);
    assert.notEqual(plan.recordSha256, null);
    // A user file appears.
    fx.put('.local/share/elastos/new-user-file.txt', 'keep');
    await assert.rejects(() => removeInDistro(run, fx.paths, plan), /changed\. Nothing was deleted there\. Click Reset to try again\./);
    assertUntouched(fx);
    fs.rmSync(path.join(fx.root, '.local', 'share', 'elastos', 'new-user-file.txt'));
    // The record is replaced by other bytes after it was verified.
    const record = path.join(fx.root, '.local', 'share', 'elastos', 'installation', 'release-head.json');
    fs.writeFileSync(record, `${SIGNED_HEAD.toString('utf8')} `);
    await assert.rejects(() => removeInDistro(run, fx.paths, plan), /changed/);
    assertUntouched(fx);
    fs.writeFileSync(record, SIGNED_HEAD);
    // The program is swapped for a link.
    fs.rmSync(fx.paths.binary);
    fs.symlinkSync(path.join(fx.root, '.bashrc'), fx.paths.binary);
    await assert.rejects(() => removeInDistro(run, fx.paths, plan), /changed/);
    assert.equal(fs.readFileSync(path.join(fx.root, '.bashrc'), 'utf8'), 'keep');
    assert.equal(exists(fx.paths.dataDir), true);
    // A path outside the given root is refused by the helper itself.
    await assert.rejects(() => removeInDistro(run, { ...fx.paths, binary: '/etc/passwd' }, plan), /changed/);
  } finally {
    fx.cleanup();
  }
});

test('a copy never replaces an earlier one, and a missing distro or unreadable list is handled', POSIX, async () => {
  const fx = distroFixture();
  try {
    const now = new Date(2026, 9, 17, 10, 11, 12);
    const write = () => writeDistroBackup({ run: localRun([]), paths: fx.paths, home: fx.winHome, platform: 'linux', restrict: () => {}, freeBytes: PLENTY, now });
    const first = await write();
    const firstBytes = fs.readFileSync(first);
    const second = await write();
    assert.notEqual(first, second);
    assert.match(path.basename(second), /-2\.zip$/);
    assert.deepEqual(fs.readFileSync(first), firstBytes);

    // No ElastOS distro: only the launcher files on Windows go, and the helper never runs.
    const calls = [];
    const result = await resetRuntimeInDistro({ ...resetDeps(fx, calls), backup: false, distroPresent: async () => false });
    assert.equal(result.backupPath, null);
    assert.deepEqual(calls, ['stop', 'host:install-stage.json', 'host:resume-install.json', 'host:resume-install.json.lock']);
    assert.equal(exists(fx.paths.dataDir), true);

    // The distro list could not be read: nothing is stopped or deleted.
    fs.writeFileSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json'), '{}');
    const refused = [];
    await assert.rejects(
      () => resetRuntimeInDistro({ ...resetDeps(fx, refused), backup: false, distroPresent: async () => null }),
      /could not check its Linux environment\. Nothing was deleted\./,
    );
    assert.deepEqual(refused, []);
    assertUntouched(fx);

    const wsl = async () => true;
    assert.equal(await elastosDistroPresent(async () => '  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  ElastOS   Stopped         2\n', wsl), true);
    assert.equal(await elastosDistroPresent(async () => '  NAME      STATE           VERSION\n* Ubuntu    Running         2\n', wsl), false);
    assert.equal(await elastosDistroPresent(async () => '', wsl), null);
    // No wsl.exe at all: there is no distro to reset.
    assert.equal(await elastosDistroPresent(async () => { throw new Error('should not list'); }, async () => false), false);
  } finally {
    fx.cleanup();
  }
});

test('the Windows copy folder and file get owner-only access for this account SID', () => {
  const ran = [];
  const sid = 'S-1-5-21-1004336348-1177238915-682003330-1001';
  const restrict = windowsRestrictToOwner((file, args) => {
    ran.push([file, ...args]);
    if (file === 'whoami.exe') return `"desktop-1\\tester","${sid}"\r\n`;
    return '';
  });
  restrict('C:\\Users\\tester\\ElastOS-backups', true);
  restrict('C:\\Users\\tester\\ElastOS-backups\\ElastOS-data-x.zip', false);
  assert.deepEqual(ran, [
    ['whoami.exe', '/user', '/fo', 'csv', '/nh'],
    ['icacls.exe', 'C:\\Users\\tester\\ElastOS-backups', '/reset', '/q'],
    ['icacls.exe', 'C:\\Users\\tester\\ElastOS-backups', '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/q'],
    ['icacls.exe', 'C:\\Users\\tester\\ElastOS-backups\\ElastOS-data-x.zip', '/reset', '/q'],
    ['icacls.exe', 'C:\\Users\\tester\\ElastOS-backups\\ElastOS-data-x.zip', '/inheritance:r', '/grant:r', `*${sid}:F`, '/q'],
  ]);
  assert.throws(() => ownerOnlyAclArgs('C:\\x', 'Everyone', true), /could not find this Windows account/);
  const failing = windowsRestrictToOwner((file) => {
    if (file === 'whoami.exe') return `"x","${sid}"`;
    throw new Error('Access is denied.');
  });
  assert.throws(() => failing('C:\\Users\\tester\\ElastOS-backups', true), /^Error: ElastOS could not make C:\\Users\\tester\\ElastOS-backups private to this Windows account\.$/);
});
