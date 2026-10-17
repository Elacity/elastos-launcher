const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BACKUP_FOLDER_NAME,
  BackupSpaceError,
  RUNTIME_BACKUP_EXCLUDES,
  assertBackupSpace,
  backupExcluded,
  describeRuntimeBackup,
  measureRuntimeBackup,
  prepareBackupFolder,
  writeRuntimeBackup,
} = require('../dist/main/targets/runtimeBackup');
const { RESET_CHOICE_MESSAGE, resetRuntime } = require('../dist/main/targets/runtimeUninstall');
const flow = require('../src/renderer/flow.js');

const PLENTY = () => 1e12;

/** Entry names from a zip's central directory. */
function zipNames(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'zip has an end record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    names.push(buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names.sort();
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-backup-'));
  const data = path.join(home, '.local', 'share', 'elastos');
  const put = (rel, text = rel) => {
    const file = path.join(data, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // Kept: what a person cannot download again.
  put('Users/alice/notes.txt', 'my notes');
  put('signing_key', 'secret key bytes');
  put('identity/did.json');
  put('browser-vm/profile-state/cookies');
  put('MyWebSite/index.html');
  put('unknown-new-thing/file');
  // Left out: rebuildable.
  put('bin/elastos', 'x'.repeat(5000));
  put('capsules/qwen/weights.gguf', 'w'.repeat(9000));
  put('libexec/browser/crosvm');
  put('browser-vm/image-set/rootfs.ext4');
  put('browser-vm/rootfs.ext4');
  put('cache/blob');
  put('content_cache/blob');
  put('installation/release-head.json');
  put('components.json', '{}');
  put('host-process.lock', '{"pid":1}');
  put('gateway-runtime-coords.json', '{"attach_secret":"s"}');
  return { home, data, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const KEPT = [
  'elastos/MyWebSite/index.html',
  'elastos/Users/alice/notes.txt',
  'elastos/browser-vm/profile-state/cookies',
  'elastos/identity/did.json',
  'elastos/signing_key',
  'elastos/unknown-new-thing/file',
];

test('a backup leaves out only rebuildable runtime data', () => {
  for (const name of ['bin', 'capsules', 'libexec', 'tools', 'scripts', 'browser-vm/image-set', 'installation', 'cache', 'runtime-coords.json']) {
    assert.ok(RUNTIME_BACKUP_EXCLUDES.includes(name), name);
  }
  assert.equal(backupExcluded('capsules/qwen/weights.gguf'), true);
  assert.equal(backupExcluded('browser-vm/image-set'), true);
  assert.equal(backupExcluded('browser-vm/profile-state/cookies'), false);
  assert.equal(backupExcluded('binder/file'), false);
  for (const kept of ['Users/a', 'signing_key', 'identity', 'did', 'ca.key', 'tls.key', 'capability_store/x', 'namespaces/x', 'audit.log', 'storage/x', 'shares/x', 'config.toml']) {
    assert.equal(backupExcluded(kept), false, kept);
  }
});

test('the size is shown first and counts only what the copy holds', () => {
  const { home, data, cleanup } = fixture();
  try {
    const measured = measureRuntimeBackup(data);
    assert.equal(measured.files, KEPT.length);
    const keptBytes = ['my notes', 'secret key bytes', 'identity/did.json', 'browser-vm/profile-state/cookies', 'MyWebSite/index.html', 'unknown-new-thing/file']
      .reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    assert.equal(measured.bytes, keptBytes);
    assert.ok(measured.neededBytes > measured.bytes);
    const seen = describeRuntimeBackup({ dataDir: data, home, freeBytes: PLENTY });
    assert.deepEqual({ present: seen.present, bytes: seen.bytes, enough: seen.enough, folder: seen.folder },
      { present: true, bytes: keptBytes, enough: true, folder: path.join(home, BACKUP_FOLDER_NAME) });
    assert.equal(fs.existsSync(path.join(home, BACKUP_FOLDER_NAME)), false, 'describe writes nothing');
    assert.equal(describeRuntimeBackup({ dataDir: path.join(home, 'missing'), home }).present, false);
  } finally {
    cleanup();
  }
});

test('the backup is a dated 0600 zip in a 0700 folder under home, and it never overwrites', { skip: process.platform === 'win32' }, () => {
  const { home, data, cleanup } = fixture();
  try {
    const now = new Date('2026-10-17T09:08:07Z');
    const first = writeRuntimeBackup({ dataDir: data, home, now, freeBytes: PLENTY });
    assert.equal(first, path.join(home, 'ElastOS-backups', 'ElastOS-data-20261017-090807Z.zip'));
    assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(first).mode & 0o777, 0o600);
    assert.deepEqual(zipNames(first), KEPT);

    // A file already has the next name. It is kept as it is.
    const taken = path.join(home, 'ElastOS-backups', 'ElastOS-data-20261017-090807Z-2.zip');
    fs.writeFileSync(taken, 'someone else');
    const second = writeRuntimeBackup({ dataDir: data, home, now, freeBytes: PLENTY });
    assert.equal(second, path.join(home, 'ElastOS-backups', 'ElastOS-data-20261017-090807Z-3.zip'));
    assert.equal(fs.readFileSync(taken, 'utf8'), 'someone else');
    assert.deepEqual(zipNames(second), KEPT);

    // A loose existing folder mode is tightened.
    fs.chmodSync(path.dirname(first), 0o755);
    prepareBackupFolder(home, data);
    assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700);
  } finally {
    cleanup();
  }
});

test('insufficient space refuses before anything is written', () => {
  const { home, data, cleanup } = fixture();
  try {
    assert.throws(() => writeRuntimeBackup({ dataDir: data, home, freeBytes: () => 10 }), BackupSpaceError);
    assert.deepEqual(fs.readdirSync(path.join(home, BACKUP_FOLDER_NAME)), []);
    assert.throws(() => assertBackupSpace({ dataDir: data, home, freeBytes: () => 10 }), /not enough free space/);
    assert.throws(() => assertBackupSpace({ dataDir: data, home, freeBytes: () => null }), /could not check the free space/);
    assert.equal(describeRuntimeBackup({ dataDir: data, home, freeBytes: () => 10 }).enough, false);
  } finally {
    cleanup();
  }
});

test('a symlinked backup folder is refused', { skip: process.platform === 'win32' }, () => {
  const { home, data, cleanup } = fixture();
  try {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(home, BACKUP_FOLDER_NAME));
    assert.throws(() => writeRuntimeBackup({ dataDir: data, home, freeBytes: PLENTY }), /is not a folder/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

function resetDeps(home, data, calls, extra = {}) {
  const binary = path.join(home, '.local', 'bin', 'elastos');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');
  return {
    binary,
    dataDir: data,
    stageFile: path.join(home, '.elastos-launcher', 'install-stage.json'),
    homeDir: home,
    platform: 'linux',
    env: {},
    stop: async () => { calls.push('stop'); },
    remove: (target) => { calls.push(`remove ${target}`); },
    ...extra,
  };
}

test('Reset without an answer to the backup offer does nothing', async () => {
  const { home, data, cleanup } = fixture();
  try {
    for (const backup of [undefined, null, 'yes', 1]) {
      const calls = [];
      await assert.rejects(() => resetRuntime(resetDeps(home, data, calls, { backup, saveBackup: async () => { calls.push('save'); return 'x'; } })),
        (err) => err.message === RESET_CHOICE_MESSAGE);
      assert.deepEqual(calls, [], `backup=${String(backup)}`);
    }
    assert.ok(fs.existsSync(path.join(data, 'signing_key')));
  } finally {
    cleanup();
  }
});

test('a failed backup leaves the data untouched and says nothing was deleted', async () => {
  const { home, data, cleanup } = fixture();
  try {
    const calls = [];
    await assert.rejects(
      () => resetRuntime(resetDeps(home, data, calls, {
        backup: true,
        saveBackup: async () => { calls.push('save'); throw new Error('disk full'); },
      })),
      /ElastOS was not reset\. The copy of your data could not be saved \(disk full\)\. Nothing was deleted\./,
    );
    assert.deepEqual(calls, ['stop', 'save']);
    assert.equal(fs.readFileSync(path.join(data, 'signing_key'), 'utf8'), 'secret key bytes');

    // The writer fails part way (a full disk). Nothing is deleted.
    const full = [];
    await assert.rejects(() => resetRuntime(resetDeps(home, data, full, {
      backup: true,
      saveBackup: async (dir) => writeRuntimeBackup({
        dataDir: dir,
        home,
        freeBytes: PLENTY,
        zip: () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); },
      }),
    })), /could not be saved \(ENOSPC: no space left on device, write\)\. Nothing was deleted\./);
    assert.deepEqual(full, ['stop']);
    assert.ok(fs.existsSync(path.join(data, 'Users', 'alice', 'notes.txt')));

    // The real writer fails on a file that cannot be read (not as root). Nothing is deleted.
    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      fs.chmodSync(path.join(data, 'signing_key'), 0o000);
      const real = [];
      await assert.rejects(() => resetRuntime(resetDeps(home, data, real, {
        backup: true,
        saveBackup: async (dir) => writeRuntimeBackup({ dataDir: dir, home, freeBytes: PLENTY }),
      })), /Nothing was deleted/);
      assert.deepEqual(real, ['stop']);
      fs.chmodSync(path.join(data, 'signing_key'), 0o600);
      assert.deepEqual(fs.readdirSync(path.join(home, BACKUP_FOLDER_NAME)), [], 'a broken zip is not left behind');
    }
  } finally {
    cleanup();
  }
});

test('not enough space refuses Reset before the gateway is stopped', async () => {
  const { home, data, cleanup } = fixture();
  try {
    const calls = [];
    await assert.rejects(() => resetRuntime(resetDeps(home, data, calls, {
      backup: true,
      checkBackupSpace: (dir) => assertBackupSpace({ dataDir: dir, home, freeBytes: () => 10 }),
      saveBackup: async () => { calls.push('save'); return null; },
    })), /ElastOS was not reset\. There is not enough free space for a copy of your data\. It needs about \d+ MB, and 1 KB is free\. Nothing was deleted\./);
    assert.deepEqual(calls, []);
  } finally {
    cleanup();
  }
});

test('Reset with a backup writes it after Stop and before any delete', async () => {
  const { home, data, cleanup } = fixture();
  try {
    const calls = [];
    const result = await resetRuntime(resetDeps(home, data, calls, {
      backup: true,
      checkBackupSpace: (dir) => { calls.push('check'); assertBackupSpace({ dataDir: dir, home, freeBytes: PLENTY }); },
      saveBackup: async (dir) => {
        calls.push('save');
        return writeRuntimeBackup({ dataDir: dir, home, freeBytes: PLENTY });
      },
    }));
    assert.deepEqual(calls.slice(0, 4), ['check', 'stop', 'save', `remove ${path.join(home, '.local', 'bin', 'elastos')}`]);
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    assert.deepEqual(zipNames(result.backupPath), KEPT);

    const none = [];
    const plain = await resetRuntime(resetDeps(home, data, none, { backup: false, saveBackup: async () => { none.push('save'); return 'x'; } }));
    assert.equal(plain.backupPath, null);
    assert.equal(none.includes('save'), false);

    await assert.rejects(() => resetRuntime(resetDeps(home, data, [], { backup: true })), /cannot be saved here\. Nothing was deleted/);
  } finally {
    cleanup();
  }
});

test('the Reset dialog says the size, the folder, and that the copy holds keys', () => {
  const offer = flow.resetBackupCopy({ present: true, bytes: 5 * 1024 * 1024, neededBytes: 22 * 1024 * 1024, freeBytes: 1e12, enough: true, folder: '/home/a/ElastOS-backups' });
  assert.equal(offer.needsChoice, true);
  assert.equal(offer.canSave, true);
  assert.match(offer.text, /about 5\.0 MB/);
  assert.match(offer.text, /\/home\/a\/ElastOS-backups/);
  assert.match(offer.warning, /keys and your sign-in identity/);
  assert.equal(offer.yes, 'Save a copy of your ElastOS data first');
  const tight = flow.resetBackupCopy({ present: true, bytes: 5, neededBytes: 2 * 1024 * 1024 * 1024, freeBytes: 1024, enough: false, folder: '/h' });
  assert.equal(tight.canSave, false);
  assert.equal(tight.needsChoice, true);
  assert.match(tight.space, /not enough free space.*2\.0 GB.*1\.0 KB is free/);
  assert.equal(flow.resetBackupCopy({ present: false }).needsChoice, false);
  const unknown = flow.resetBackupCopy(null);
  assert.equal(unknown.canSave, false);
  assert.equal(unknown.needsChoice, true);
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /if \(resetOffer\.needsChoice && !resetBackupYes\.checked && !resetBackupNo\.checked\) return;/);
});

test('the worker measures and writes the copy off the window thread', async () => {
  const { runBackupWorker } = require('../dist/main/targets/runtimeBackup');
  const { home, data, cleanup } = fixture();
  try {
    const seen = await runBackupWorker({ op: 'describe', dataDir: data, home }, 60000);
    assert.equal(seen.present, true);
    assert.equal(seen.folder, path.join(home, BACKUP_FOLDER_NAME));
    const written = await runBackupWorker({ op: 'write', dataDir: data, home }, 60000);
    assert.match(path.basename(written), /^ElastOS-data-\d{8}-\d{6}Z\.zip$/);
    assert.deepEqual(zipNames(written), KEPT);
    await assert.rejects(() => runBackupWorker({ op: 'write', dataDir: 7, home }, 60000), /could not be saved/);
  } finally {
    cleanup();
  }
});
