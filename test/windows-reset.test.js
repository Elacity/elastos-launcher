const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DISTRO_RESET_HELPER } = require('../dist/main/targets/distroResetHelper');
const {
  describeDistroBackup,
  DISTRO_PYTHON_MISSING_MESSAGE,
  distroHelperArgs,
  distroPythonProbe,
  distroPythonProbeArgs,
  parsePythonProbe,
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
    pythonPresent: async () => { calls.push('python'); return true; },
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
      'python', 'inspect', 'measure', 'stop', 'measure', 'restrict', 'restrict', 'zip', 'inspect', 'remove',
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
    assert.deepEqual(calls, ['python', 'inspect', 'measure']);
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
      assert.deepEqual(calls, ['python', 'inspect']);
    }
    assertUntouched(fx);
    assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'share', 'elastos', 'notes.txt'), 'utf8'), 'keep');
  } finally {
    fx.cleanup();
  }
});

/**
 * What a real alpha.22 install and `elastos setup` (which joins
 * elastos.community) left in the distro in Windows CI job 117369675723. Its
 * refusal named the first five and "1 more"; the sixth is the one runtime name
 * that sorts after `ipfs-repo` and is written on every Kubo start.
 */
function putCommunitySetup(fx) {
  fx.put('.local/share/elastos/.collaboration-network-choice.lock', '');
  fx.put('.local/share/elastos/collaboration/config/accepted-profile-head-v1.json', '{}');
  fx.put('.local/share/elastos/collaboration/history/room.jsonl', 'hello community');
  fx.put('.local/share/elastos/collaboration-network-v1.json', '{"network":"elastos.community"}');
  fx.put('.local/share/elastos/ipfs-coords.json', '{"kubo_pid":1}');
  fx.put('.local/share/elastos/ipfs-repo/config', '{"Identity":{}}');
  fx.put('.local/share/elastos/ipfs-startup.lock', '');
}

test('Windows Reset after a setup that joined elastos.community saves a copy and deletes the distro data', POSIX, async () => {
  const fx = distroFixture();
  try {
    putCommunitySetup(fx);
    const calls = [];
    const result = await resetRuntimeInDistro(resetDeps(fx, calls));
    assert.equal(exists(fx.paths.dataDir), false);
    assert.equal(exists(fx.paths.binary), false);
    assert.equal(fs.readFileSync(path.join(fx.root, 'Documents', 'thesis.docx'), 'utf8'), 'keep');
    // Community history, the network choice, and the Kubo repo are kept; locks and coords are not.
    const names = readStoredZipEntries(result.backupPath).map((entry) => entry.name).sort();
    assert.deepEqual(names, [
      ...KEPT,
      'elastos/collaboration-network-v1.json',
      'elastos/collaboration/config/accepted-profile-head-v1.json',
      'elastos/collaboration/history/room.jsonl',
      'elastos/ipfs-repo/config',
    ].sort());
  } finally {
    fx.cleanup();
  }
});

test('a foreign name beside a real Community setup in the distro is still refused by name', POSIX, async () => {
  const fx = distroFixture();
  try {
    putCommunitySetup(fx);
    fx.put('.local/share/elastos/holiday-photos/beach.jpg', 'keep');
    const calls = [];
    await assert.rejects(
      () => resetRuntimeInDistro(resetDeps(fx, calls)),
      /contains files that are not part of the runtime: holiday-photos\. Move those files out, then reset\. Nothing was deleted\./,
    );
    assert.deepEqual(calls, ['python', 'inspect']);
    assertUntouched(fx);
    assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'share', 'elastos', 'holiday-photos', 'beach.jpg'), 'utf8'), 'keep');
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
      assert.deepEqual(calls, ['python', 'inspect']);
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

test('Uninstall on Windows says it removes nothing, instead of saying ElastOS was removed', async () => {
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  const home = process.env.HOME;
  // A throwaway home, so a broken guard cannot touch this machine's files.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-win-uninstall-'));
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    await assert.rejects(
      () => createRuntimeTarget().uninstall(),
      /^Error: Uninstall cannot remove ElastOS on Windows yet\. Nothing was removed\. To delete your ElastOS data, click Reset\.$/,
    );
  } finally {
    Object.defineProperty(process, 'platform', real);
    fs.rmSync(process.env.HOME, { recursive: true, force: true });
    process.env.HOME = home;
  }
});

/**
 * The real helper with Python lines run before it. The lines replace an os
 * call, to fake another drive, a swap in a race, a failed step, or a crash.
 * The helper itself is not changed.
 */
function patchedRun(calls, prelude) {
  return async (op, input, options) => {
    calls.push(op);
    const args = distroHelperArgs(op);
    const [, helper, name] = args.slice(args.indexOf('--exec') + 2);
    return spawnHelper('python3', ['-c', `${prelude}\n${helper}`, name], input, options);
  };
}

/** Every stat of these names says they are on another drive (st_dev + 4242). With afterMove, only after the data folder is moved. */
function fakeDrive(names, { afterMove = false } = {}) {
  return `
import os as _o
_names = ${JSON.stringify(names)}
_armed = [${afterMove ? 'False' : 'True'}]
_stat, _fstat, _open, _close, _rename = _o.stat, _o.fstat, _o.open, _o.close, _o.rename
_fds = set()
def _shift(r):
    v = list(r[:10])
    v[2] = v[2] + 4242
    return _o.stat_result(v)
def _p_stat(p, *a, **k):
    r = _stat(p, *a, **k)
    return _shift(r) if _armed[0] and p in _names else r
def _p_open(p, *a, **k):
    fd = _open(p, *a, **k)
    if _armed[0] and p in _names:
        _fds.add(fd)
    return fd
def _p_fstat(fd):
    r = _fstat(fd)
    return _shift(r) if fd in _fds else r
def _p_close(fd):
    _fds.discard(fd)
    return _close(fd)
def _p_rename(*a, **k):
    r = _rename(*a, **k)
    _armed[0] = True
    return r
_o.stat, _o.fstat, _o.open, _o.close, _o.rename = _p_stat, _p_fstat, _p_open, _p_close, _p_rename
`;
}

/** The first call of os.<fn> on this name fails (OSError) or ends the process at once (crash). */
function failAt(fn, name, how) {
  const act = how === 'crash' ? '_o._exit(9)' : "raise OSError(5, 'injected failure')";
  return `
import os as _o
_real = _o.${fn}
def _p(*a, **k):
    if a and a[0] == ${JSON.stringify(name)}:
        ${act}
    return _real(*a, **k)
_o.${fn} = _p
`;
}

function holdings(fx) {
  return fs.readdirSync(path.join(fx.root, '.local', 'share')).filter((name) => name.startsWith('.elastos-removing-'));
}

function assertFullyReset(fx) {
  assert.equal(exists(fx.paths.binary), false);
  assert.equal(exists(fx.paths.stageFile), false);
  assert.equal(exists(fx.paths.dataDir), false);
  assert.deepEqual(fs.readdirSync(path.join(fx.root, '.local', 'share')), ['other-app']);
  assert.equal(fs.readFileSync(path.join(fx.root, '.bashrc'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(fx.root, 'Documents', 'thesis.docx'), 'utf8'), 'keep');
  assert.equal(exists(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), false);
  assert.equal(distroIsInstalled((file) => exists(inRoot(fx)(file))), false);
}

test('a name in the distro data folder on another drive is refused before Stop, and never deleted when it appears later', POSIX, async () => {
  const fx = distroFixture();
  try {
    // Seen at the first look: Reset refuses before Stop and before the copy.
    let calls = [];
    await assert.rejects(
      () => resetRuntimeInDistro(resetDeps(fx, calls, { run: patchedRun(calls, fakeDrive(['MyWebSite'])) })),
      /^Error: ElastOS will not reset \/.*\/\.local\/share\/elastos in its Linux environment, because these names in it are on another drive or are mounted from another folder: MyWebSite\. ElastOS deletes only its own files, never files on another drive\. Nothing was deleted\. Unmount them, then click Reset\.$/,
    );
    assert.deepEqual(calls, ['python', 'inspect']);
    assertUntouched(fx);
    assert.deepEqual(backupFiles(fx), []);

    // Not there at the look, there at the delete's own check: nothing changes.
    const plain = localRun([]);
    const plan = distroRemovalPlan(await inspectDistro(plain, fx.paths), fx.paths, DID);
    calls = [];
    await assert.rejects(() => removeInDistro(patchedRun(calls, fakeDrive(['alice'])), fx.paths, plan), /on another drive/);
    assertUntouched(fx);
    assert.deepEqual(holdings(fx), []);

    // It appears only after the data was moved aside: the delete leaves it and says so.
    await assert.rejects(
      () => removeInDistro(patchedRun([], fakeDrive(['MyWebSite'], { afterMove: true })), fx.paths, plan),
      /^Error: ElastOS was reset, but some old files in \/.*\/\.elastos-removing-\d+-[0-9a-f]{16}-elastos in its Linux environment were not deleted: MyWebSite\. ElastOS never deletes files on another drive\. Click Reset to try again\.$/,
    );
    const [held] = holdings(fx);
    assert.ok(held);
    assert.equal(fs.readFileSync(path.join(fx.root, '.local', 'share', held, 'MyWebSite', 'index.html'), 'utf8'), '<p>hi</p>');
    assert.deepEqual(fs.readdirSync(path.join(fx.root, '.local', 'share', held)), ['MyWebSite']);
    assert.equal(exists(fx.paths.binary), false);
    // The next Reset deletes what is left.
    await resetRuntimeInDistro({ ...resetDeps(fx, []), backup: false });
    assertFullyReset(fx);
  } finally {
    fx.cleanup();
  }
});

function canMount() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-mount-check-'));
  try {
    fs.mkdirSync(path.join(top, 'a'));
    fs.mkdirSync(path.join(top, 'b'));
    execFileSync('mount', ['--bind', path.join(top, 'a'), path.join(top, 'b')], { stdio: 'ignore' });
    execFileSync('umount', [path.join(top, 'b')], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
}

const MOUNTS = { skip: canMount() ? false : 'needs root and mount --bind (Linux)' };

function unmountAll(points) {
  for (const point of points.reverse()) {
    try { execFileSync('umount', ['-l', point], { stdio: 'ignore' }); } catch { /* not mounted */ }
  }
}

/** Every mount below top, wherever a rename moved it, so cleanup never deletes through one. */
function unmountUnder(top) {
  const points = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
    .map((line) => line.split(' ')[4])
    .filter((point) => point && point.startsWith(`${top}/`));
  unmountAll(points.sort());
}

test('a real bind mount and a real tmpfs inside the distro data folder are never entered or deleted', MOUNTS, async () => {
  const fx = distroFixture();
  const outside = path.join(fx.top, 'outside');
  const bindAt = path.join(fx.paths.dataDir, 'Users', 'alice', 'c');
  const tmpfsAt = path.join(fx.paths.dataDir, 'Users', 'alice', 't');
  const mounted = [];
  const mount = (args, at) => { execFileSync('mount', [...args, at]); mounted.push(at); };
  const precious = () => fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8');
  try {
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'on drive C');
    fs.mkdirSync(bindAt);
    fs.mkdirSync(tmpfsAt);
    // A bind of a folder on the same drive has the same st_dev. Only the mount id tells it apart.
    mount(['--bind', outside], bindAt);
    mount(['-t', 'tmpfs', 'none'], tmpfsAt);
    fs.writeFileSync(path.join(tmpfsAt, 'in-tmpfs.txt'), 'tmpfs');
    assert.equal(fs.statSync(bindAt).dev, fs.statSync(fx.paths.dataDir).dev);

    const calls = [];
    await assert.rejects(
      () => resetRuntimeInDistro(resetDeps(fx, calls)),
      /because these names in it are on another drive or are mounted from another folder: Users\/alice\/c, Users\/alice\/t\..*Nothing was deleted/,
    );
    assert.deepEqual(calls, ['python', 'inspect']);
    assertUntouched(fx);
    assert.equal(precious(), 'on drive C');
    assert.equal(fs.readFileSync(path.join(tmpfsAt, 'in-tmpfs.txt'), 'utf8'), 'tmpfs');

    // Mounted after the look: the delete's own check refuses, and nothing changes.
    unmountAll(mounted.splice(0));
    const plan = distroRemovalPlan(await inspectDistro(localRun([]), fx.paths), fx.paths, DID);
    mount(['--bind', outside], bindAt);
    await assert.rejects(() => removeInDistro(localRun([]), fx.paths, plan), /on another drive or is mounted from another folder\. .*Nothing was deleted/);
    assertUntouched(fx);
    assert.equal(precious(), 'on drive C');

    // Mounted after the data was moved aside: the delete does not enter it.
    unmountAll(mounted.splice(0));
    const plan2 = distroRemovalPlan(await inspectDistro(localRun([]), fx.paths), fx.paths, DID);
    const mountAfterMove = `
import os as _o, subprocess as _sp
_rename = _o.rename
def _p_rename(src, dst, **k):
    r = _rename(src, dst, **k)
    if src == 'elastos':
        here = _o.readlink('/proc/self/fd/' + str(k['dst_dir_fd']))
        _sp.run(['mount', '--bind', ${JSON.stringify(outside)}, here + '/' + dst + '/Users/alice/c'], check=True)
    return r
_o.rename = _p_rename
`;
    await assert.rejects(
      () => removeInDistro(patchedRun([], mountAfterMove), fx.paths, plan2),
      /were not deleted: Users\/alice\/c\. ElastOS never deletes files on another drive/,
    );
    assert.equal(holdings(fx).length, 1);
    assert.equal(precious(), 'on drive C');
    assert.deepEqual(fs.readdirSync(outside), ['precious.txt']);
    unmountUnder(fx.top);
    await resetRuntimeInDistro({ ...resetDeps(fx, []), backup: false });
    assertFullyReset(fx);
    assert.equal(precious(), 'on drive C');
  } finally {
    unmountUnder(fx.top);
    fx.cleanup();
  }
});

test('a folder swapped for a link, before or during the delete, is never followed', POSIX, async () => {
  const fx = distroFixture();
  const outside = path.join(fx.top, 'outside');
  try {
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'outside');
    // Before Reset: a folder deep in the data is a link to a folder outside it.
    const alice = path.join(fx.paths.dataDir, 'Users', 'alice');
    fs.renameSync(alice, `${alice}-real`);
    fs.symlinkSync(outside, alice);
    await resetRuntimeInDistro({ ...resetDeps(fx, []), backup: false });
    assertFullyReset(fx);
    assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'outside');
  } finally {
    fx.cleanup();
  }

  const fx2 = distroFixture();
  const outside2 = path.join(fx2.top, 'outside');
  try {
    fs.mkdirSync(outside2);
    fs.writeFileSync(path.join(outside2, 'precious.txt'), 'outside');
    const plan = distroRemovalPlan(await inspectDistro(localRun([]), fx2.paths), fx2.paths, DID);
    // During the delete: after the check of Users/alice and before it is opened, it becomes a link.
    const swap = `
import os as _o
_open, _rename = _o.open, _o.rename
_armed = [False]
def _p_rename(*a, **k):
    r = _rename(*a, **k)
    _armed[0] = True
    return r
def _p_open(p, flags, *a, **k):
    if _armed[0] and p == 'alice' and flags & _o.O_DIRECTORY:
        _armed[0] = False
        d = k.get('dir_fd')
        _rename('alice', 'alice-moved', src_dir_fd=d, dst_dir_fd=d)
        _o.symlink(${JSON.stringify(outside2)}, 'alice', dir_fd=d)
    return _open(p, flags, *a, **k)
_o.rename, _o.open = _p_rename, _p_open
`;
    await assert.rejects(() => removeInDistro(patchedRun([], swap), fx2.paths, plan), /were not deleted: Users\/alice\./);
    assert.deepEqual(fs.readdirSync(outside2), ['precious.txt']);
    assert.equal(fs.readFileSync(path.join(outside2, 'precious.txt'), 'utf8'), 'outside');

    // A file replaced by another one between its check and its delete is left.
    const fx3 = distroFixture();
    try {
      const plan3 = distroRemovalPlan(await inspectDistro(localRun([]), fx3.paths), fx3.paths, DID);
      const swapFile = `
import os as _o
_stat, _rename = _o.stat, _o.rename
_armed = [False]
_seen = [0]
def _p_rename(*a, **k):
    r = _rename(*a, **k)
    _armed[0] = True
    return r
def _p_stat(p, *a, **k):
    if _armed[0] and p == 'notes.txt' and k.get('dir_fd') is not None:
        _seen[0] += 1
        if _seen[0] == 2:
            d = k['dir_fd']
            fd = _o.open('swap.tmp', _o.O_WRONLY | _o.O_CREAT | _o.O_EXCL, 0o600, dir_fd=d)
            _o.write(fd, b'swapped in')
            _o.close(fd)
            _rename('swap.tmp', 'notes.txt', src_dir_fd=d, dst_dir_fd=d)
    return _stat(p, *a, **k)
_o.stat, _o.rename = _p_stat, _p_rename
`;
      await assert.rejects(() => removeInDistro(patchedRun([], swapFile), fx3.paths, plan3), /were not deleted: Users\/alice\/notes\.txt\./);
      const [held] = holdings(fx3);
      assert.equal(fs.readFileSync(path.join(fx3.root, '.local', 'share', held, 'Users', 'alice', 'notes.txt'), 'utf8'), 'swapped in');
    } finally {
      fx3.cleanup();
    }
  } finally {
    fx2.cleanup();
  }
});

const STEPS = [
  { step: 'move the data aside', fn: 'rename', name: 'elastos' },
  { step: 'delete the program', fn: 'unlink', name: 'elastos' },
  { step: 'delete the stage file', fn: 'unlink', name: 'install-stage.json' },
  { step: 'delete the moved data', fn: 'unlink', name: 'notes.txt' },
];

for (const { step, fn, name } of STEPS) {
  for (const how of ['error', 'crash']) {
    test(`Windows Reset that stops at "${step}" (${how}) leaves the old install or a moved folder, and Reset again finishes`, POSIX, async () => {
      const fx = distroFixture();
      try {
        const calls = [];
        const run = patchedRun([], failAt(fn, name, how));
        const deps = resetDeps(fx, calls);
        deps.removeInDistro = (plan) => removeInDistro(run, fx.paths, plan);
        const err = await resetRuntimeInDistro(deps).then(() => null, (e) => e);
        assert.ok(err, 'Reset must fail');
        // The copy was saved before the delete, and the message says where it is.
        const [copy] = backupFiles(fx);
        assert.ok(copy);
        assert.ok(err.message.endsWith(`Your copy of your data is in ${path.join(fx.winHome, BACKUP_FOLDER_NAME, copy)}.`), err.message);
        // The Windows-side files are removed only after the distro is done.
        assert.equal(exists(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), true);
        const notes = path.join(fx.paths.dataDir, 'Users', 'alice', 'notes.txt');
        if (step === 'move the data aside') {
          // Nothing was deleted: the program and the data are where they were.
          assertUntouched(fx);
          assert.deepEqual(holdings(fx), []);
          if (how === 'error') assert.match(err.message, /could not move its data folder .*\. Nothing was deleted\. Click Reset to try again\./);
        } else if (how === 'error' && step !== 'delete the moved data') {
          // The program could not be removed: the data was put back, whole.
          assert.match(err.message, /could not remove its program in its Linux environment\. Your data was not deleted\. Click Reset to try again\./);
          assert.equal(fs.readFileSync(notes, 'utf8'), 'my notes');
          assert.deepEqual(holdings(fx), []);
        } else {
          // The data is whole at its own name, or it is in one moved folder. Never half here, half there.
          const held = holdings(fx);
          if (exists(fx.paths.dataDir)) {
            assert.equal(fs.readFileSync(notes, 'utf8'), 'my notes');
            assert.deepEqual(held, []);
          } else {
            assert.equal(held.length, 1);
          }
          if (how === 'crash') assert.match(err.message, /could not finish removing its files in its Linux environment\. Click Reset to try again\./);
          else assert.match(err.message, /some old files in .* were not deleted: Users\/alice\/notes\.txt\./);
        }
        // Reset again, with no failure, finishes the job.
        await resetRuntimeInDistro({ ...resetDeps(fx, []), backup: false });
        assertFullyReset(fx);
      } finally {
        fx.cleanup();
      }
    });
  }
}

test('python3 missing in the distro gives a plain message before anything runs there', POSIX, async () => {
  // The probe itself: a marker word for yes and for no, and no marker means it did not run.
  assert.equal(parsePythonProbe((await spawnHelper('/bin/sh', ['-c', distroPythonProbe('python3')], {})).stdout), true);
  assert.equal(parsePythonProbe((await spawnHelper('/bin/sh', ['-c', distroPythonProbe('/nonexistent/python3')], {})).stdout), false);
  assert.equal(parsePythonProbe('There is no distribution with the supplied name.'), null);
  assert.deepEqual(distroPythonProbeArgs().slice(0, 7), ['-d', 'ElastOS', '-u', 'root', '--exec', '/bin/sh', '-c']);
  assert.equal(/["\\$`]/.test(distroPythonProbe()), false);

  const fx = distroFixture();
  try {
    // Without python3 every helper call fails the way wsl.exe fails, so only the probe can say why.
    const noPython = async () => ({ code: 1, stdout: '', stderr: 'execvpe(/usr/bin/python3) failed: No such file or directory' });
    const calls = [];
    const run = localRun(calls, { inspect: noPython, measure: noPython, zip: noPython, remove: noPython });
    const deps = { ...resetDeps(fx, calls, { run }), pythonPresent: async () => { calls.push('python'); return false; } };
    await assert.rejects(() => resetRuntimeInDistro(deps), (err) => err.message === DISTRO_PYTHON_MISSING_MESSAGE);
    assert.deepEqual(calls, ['python']);
    assert.match(DISTRO_PYTHON_MISSING_MESSAGE, /python3 is missing .* Nothing was deleted\. Click Install to add python3 again, then click Reset\./);
    assertUntouched(fx);

    const unsure = { ...resetDeps(fx, [], { run }), pythonPresent: async () => null };
    await assert.rejects(() => resetRuntimeInDistro(unsure), /could not check its Linux environment\. Nothing was deleted\./);
    assertUntouched(fx);
  } finally {
    fx.cleanup();
  }
});
