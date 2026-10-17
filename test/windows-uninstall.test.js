const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  describeDistroBackup,
  distroHelperArgs,
  distroResetPaths,
  inspectDistro,
  spawnHelper,
  writeDistroBackup,
} = require('../dist/main/targets/windowsReset');
const {
  distroOutsideDirs,
  foreignOutsideData,
  listOutsideData,
  uninstallPrompt,
  uninstallRuntimeInDistro,
  UNINSTALL_CHOICE_MESSAGE,
  wslUnregisterArgs,
} = require('../dist/main/targets/windowsUninstall');
const { removeVerifiedTarget } = require('../dist/main/targets/runtimeUninstall');
const { failureScreen } = require('../dist/main/targets/runtimeRecovery');
const { readStoredZipEntries } = require('../dist/main/targets/runtimeBackup');
const { loadActiveRuntimePin } = require('../dist/main/targets/runtimePin');
const { ROOTFS_MANIFEST } = require('../dist/main/targets/rootfsManifest');
const { ELASTOS_ROOTFS_SHA256 } = require('../dist/main/targets/windowsHost');
const flow = require('../src/renderer/flow.js');

const SIGNED_HEAD = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-head-0.8.0-alpha.22.json'));
/** Files copied unchanged out of the pinned rootfs (scripts/rootfs-manifest.js checks the hashes). */
const ROOTFS = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'rootfs-noble-20240423', name));
const DID = loadActiveRuntimePin().maintainerDid;
// The helper runs inside Linux. Here it runs with this machine's python3, so these tests need POSIX.
const POSIX = { skip: process.platform === 'win32' };
const LISTED = 'NAME       STATE      VERSION\n* ElastOS  Running    2\n  Ubuntu   Stopped    2\n';
const GONE = 'NAME       STATE      VERSION\n* Ubuntu   Stopped    2\n';

/** The real helper, run with this machine's python3 instead of wsl.exe. */
function localRun(calls) {
  return async (op, input, options) => {
    calls.push(op);
    const args = distroHelperArgs(op);
    return spawnHelper('python3', args.slice(args.indexOf('--exec') + 2), input, options);
  };
}

/**
 * A Linux environment holding only what the rootfs, its first boot,
 * Install, setup, and the launcher write: the tree that run 39034483759
 * (job 117401445187) listed before Uninstall. The folder is a real path
 * (no link on the way), as /root is inside the distro.
 */
function cleanDistro() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-distro-uninstall-')));
  const root = path.join(top, 'root');
  const winHome = path.join(top, 'Users', 'tester');
  const paths = distroResetPaths(root);
  const put = (rel, text = rel) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  put('.bashrc', ROOTFS('root.bashrc'));
  put('.profile', ROOTFS('root.profile'));
  put('.motd_shown', '');
  put('.cache/motd.legal-displayed', '');
  put('.cache/elastos/rootfs-cache/index.json', '{}');
  // cloud-init on first boot: an empty authorized_keys for root, and the default user's home from /etc/skel.
  put('.ssh/authorized_keys', '');
  const userHome = path.join(top, 'home', 'ubuntu');
  fs.mkdirSync(path.join(userHome, '.ssh'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userHome, '.ssh', 'authorized_keys'), '');
  for (const name of ['.bash_logout', '.bashrc', '.profile']) fs.writeFileSync(path.join(userHome, name), ROOTFS(`skel${name}`));
  put('.local/bin/elastos', 'program');
  put('.local/bin/.elastos.install.lock', '');
  put('.elastos-launcher/install-stage.json', '{"stage":"done"}');
  put('.elastos-launcher/install.sh', 'script');
  put('.local/share/elastos/installation/release-head.json', SIGNED_HEAD);
  put('.local/share/elastos/installation/release.json', '{}');
  put('.local/share/elastos/components.json', '{}');
  put('.local/share/elastos/sources.json', '{}');
  put('.local/share/elastos/signing_key', 'secret key bytes');
  put('.local/share/elastos/Users/alice/notes.txt', 'my notes');
  fs.mkdirSync(path.join(winHome, '.elastos-launcher'), { recursive: true });
  fs.writeFileSync(path.join(winHome, '.elastos-launcher', 'install-stage.json'), '{"stage":"done"}');
  const dirs = distroOutsideDirs(paths, path.join(top, 'home'));
  return { top, root, userHome, winHome, paths, dirs, put, cleanup: () => fs.rmSync(top, { recursive: true, force: true }) };
}

function deps(fx, calls, extra = {}) {
  const run = localRun(calls);
  const state = { distros: extra.distros ?? LISTED };
  return {
    state,
    backup: true,
    homeDir: fx.winHome,
    platform: 'linux',
    env: {},
    paths: fx.paths,
    outsideDirs: fx.dirs,
    stop: async () => { calls.push('stop'); },
    hasWsl: async () => true,
    listDistros: async () => { calls.push('wsl-list'); return state.distros; },
    pythonPresent: async () => { calls.push('python'); return true; },
    inspect: () => inspectDistro(run, fx.paths, 'uninstall'),
    listOutside: () => listOutsideData(run, fx.paths, fx.dirs),
    maintainerDid: DID,
    checkBackupSpace: async () => { calls.push('space'); },
    saveBackup: () => writeDistroBackup({
      run, paths: fx.paths, home: fx.winHome, platform: 'linux', restrict: () => {}, freeBytes: () => 1e12,
    }),
    confirmRemoval: async (prompt) => { calls.push(['confirm', prompt]); return true; },
    runWsl: async (args) => {
      calls.push(['wsl', args]);
      state.distros = GONE;
      return 0;
    },
    removeHost: (target) => { calls.push(`host:${path.basename(target)}`); removeVerifiedTarget(target); },
    ...extra.deps,
  };
}

const unregisterCalls = (calls) => calls.filter((call) => Array.isArray(call) && call[0] === 'wsl');

function assertDataKept(fx) {
  assert.equal(fs.readFileSync(path.join(fx.paths.dataDir, 'Users', 'alice', 'notes.txt'), 'utf8'), 'my notes');
  assert.equal(fs.readFileSync(fx.paths.binary, 'utf8'), 'program');
  assert.ok(fs.existsSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')));
}

test('Windows Uninstall: a copy, then a second question, then wsl.exe --unregister ElastOS once, with that exact argv', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const result = await uninstallRuntimeInDistro(deps(fx, calls));
    assert.deepEqual(unregisterCalls(calls), [['wsl', ['--unregister', 'ElastOS']]]);
    assert.deepEqual(wslUnregisterArgs(), ['--unregister', 'ElastOS']);
    assert.equal(result.removedLinux, true);
    assert.ok(result.backupPath && fs.statSync(result.backupPath).isFile());
    const names = readStoredZipEntries(result.backupPath).map((entry) => entry.name);
    assert.ok(names.includes('elastos/Users/alice/notes.txt'));
    // The order: check, space, Stop, copy, look again, ask, check the name, unregister, then Windows files.
    const steps = calls.map((call) => (Array.isArray(call) ? call[0] : call));
    assert.deepEqual(steps, [
      'wsl-list', 'python', 'inspect', 'list', 'space', 'stop', 'measure', 'zip', 'inspect', 'list',
      'confirm', 'wsl-list', 'wsl', 'wsl-list',
      'host:install-stage.json', 'host:resume-install.json', 'host:resume-install.json.lock',
    ]);
    const prompt = calls.find((call) => Array.isArray(call) && call[0] === 'confirm')[1];
    assert.deepEqual(prompt, uninstallPrompt(result.backupPath));
    assert.equal(prompt.message, 'This removes the Linux environment named ElastOS from this computer, with everything in it: the ElastOS program and all your ElastOS data.');
    assert.equal(prompt.detail, `You cannot undo this. Only your copy can bring your ElastOS data back. Your copy is in ${result.backupPath}.`);
    assert.equal(uninstallPrompt(null).detail, 'You cannot undo this. You chose not to save a copy, so your ElastOS data cannot come back.');
    assert.equal(prompt.cancelLabel, 'Cancel');
    assert.equal(fs.existsSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), false);
  } finally {
    fx.cleanup();
  }
});

test('without a yes to the second question, nothing is unregistered and nothing is removed', POSIX, async () => {
  for (const answer of [false, undefined, 'yes', 1, null]) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls, { deps: { confirmRemoval: async () => answer } });
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => {
        assert.match(err.message, /^ElastOS was not uninstalled\. Nothing was removed\. Your copy of your ElastOS data is in .*\.zip\. Click Start to use ElastOS again\.$/);
        return true;
      });
      assert.deepEqual(unregisterCalls(calls), [], String(answer));
      assertDataKept(fx);
    } finally {
      fx.cleanup();
    }
  }
});

test('no answer to the copy offer removes nothing and stops nothing', POSIX, async () => {
  const fx = cleanDistro();
  try {
    for (const backup of [undefined, 'true', 1, null]) {
      const calls = [];
      await assert.rejects(() => uninstallRuntimeInDistro({ ...deps(fx, calls), backup }), (err) => err.message === UNINSTALL_CHOICE_MESSAGE);
      assert.deepEqual(calls, []);
    }
    assertDataKept(fx);
  } finally {
    fx.cleanup();
  }
});

test('a missing, tampered, or foreign-signed install record, or no data folder, is not proof: nothing is unregistered', POSIX, async () => {
  const record = (fx) => path.join(fx.paths.dataDir, 'installation', 'release-head.json');
  const cases = {
    missing: (fx) => fs.rmSync(record(fx)),
    tampered: (fx) => fs.writeFileSync(record(fx), SIGNED_HEAD.toString('utf8').replace('0.8.0-alpha.22', '0.8.0-alpha.99')),
    linked: (fx) => {
      fs.writeFileSync(path.join(fx.top, 'elsewhere.json'), SIGNED_HEAD);
      fs.rmSync(record(fx));
      fs.symlinkSync(path.join(fx.top, 'elsewhere.json'), record(fx));
    },
    'partial install': (fx) => {
      fs.rmSync(fx.paths.dataDir, { recursive: true });
      fx.put('.local/share/elastos/components.json', '{}');
    },
    'no data folder': (fx) => fs.rmSync(fx.paths.dataDir, { recursive: true }),
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    const fx = cleanDistro();
    try {
      breakIt(fx);
      const calls = [];
      let message = '';
      await assert.rejects(() => uninstallRuntimeInDistro(deps(fx, calls)), (err) => { message = err.message; return true; });
      assert.match(message, /has no signed ElastOS install record/, name);
      assert.match(message, /click Uninstall again\. Nothing was (removed|deleted)\.$/, name);
      assert.deepEqual(unregisterCalls(calls), [], name);
      assert.equal(calls.includes('stop'), false, name);
      assert.equal(calls.includes('zip'), false, name);
      // The failure screen offers Fix it, which runs Install and writes the record.
      const screen = failureScreen({ error: message, checks: [], binaryPresent: true, componentsPresent: true });
      assert.equal(screen.kind, 'no-record', name);
      assert.equal(screen.title, 'Install ElastOS again, then uninstall', name);
    } finally {
      fx.cleanup();
    }
  }
  // A record signed by another key.
  const fx = cleanDistro();
  try {
    const calls = [];
    await assert.rejects(() => uninstallRuntimeInDistro({ ...deps(fx, calls), maintainerDid: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' }), /has no signed ElastOS install record/);
    assert.deepEqual(unregisterCalls(calls), []);
  } finally {
    fx.cleanup();
  }
});

test('files a person keeps outside the data folder are refused by name, even with a copy chosen', POSIX, async () => {
  const cases = [
    ['notes.txt in /root', (fx) => fx.put('notes.txt', 'mine'), (fx) => `${fx.root}/notes.txt`],
    ['a home folder in /home', (fx) => fs.mkdirSync(path.join(fx.top, 'home', 'alice')), (fx) => `${fx.dirs.homes}/alice`],
    ['a file in /home', (fx) => fs.writeFileSync(path.join(fx.top, 'home', 'notes.txt'), 'mine'), (fx) => `${fx.dirs.homes}/notes.txt`],
    ['another app in .local/share', (fx) => fx.put('.local/share/other-app/data', 'x'), (fx) => `${fx.dirs.share}/other-app`],
    ['a script in .local/bin', (fx) => fx.put('.local/bin/myscript', 'x'), (fx) => `${fx.dirs.bin}/myscript`],
    ['Documents', (fx) => fx.put('Documents/thesis.docx', 'x'), (fx) => `${fx.root}/Documents`],
    ['a link in /root', (fx) => { fs.rmSync(path.join(fx.root, '.bashrc')); fs.symlinkSync('/etc/hostname', path.join(fx.root, '.bashrc')); }, (fx) => `${fx.root}/.bashrc`],
  ];
  for (const [name, add, shown] of cases) {
    for (const backup of [true, false]) {
      const fx = cleanDistro();
      try {
        add(fx);
        const calls = [];
        let message = '';
        await assert.rejects(() => uninstallRuntimeInDistro({ ...deps(fx, calls), backup }), (err) => { message = err.message; return true; });
        assert.ok(message.includes(`holds files that ElastOS did not make, or that were changed: ${shown(fx)}`), `${name}: ${message}`);
        assert.match(message, /the copy holds only your ElastOS data\. Move those files out, then click Uninstall\. Nothing was removed\./);
        assert.deepEqual(unregisterCalls(calls), [], name);
        assert.equal(calls.includes('stop'), false, name);
        assertDataKept(fx);
      } finally {
        fx.cleanup();
      }
    }
  }
  // A folder that cannot be read proves nothing.
  const dirs = distroOutsideDirs(distroResetPaths('/root'));
  assert.equal(foreignOutsideData({ [dirs.root]: 'unknown' }, dirs), null);
  const absent = Object.fromEntries(Object.values(dirs).map((dir) => [dir, 'absent']));
  assert.deepEqual(foreignOutsideData(absent, dirs), ['/root']);
  assert.equal(foreignOutsideData({ ...absent, [dirs.homes]: 'unknown' }, dirs), null);
});

test('the tree the pinned rootfs and its first boot make is not a person\'s files: Uninstall proceeds', POSIX, async () => {
  // As listed in run 39034483759: /root/.ssh, /home/ubuntu (drwxr-x---), .cache, .motd_shown, rootfs .bashrc/.profile.
  const variants = [
    ['with the empty authorized_keys cloud-init writes', () => {}],
    ['with /root/.ssh empty, as in the rootfs', (fx) => fs.rmSync(path.join(fx.root, '.ssh', 'authorized_keys'))],
    ['with no ubuntu home', (fx) => fs.rmSync(fx.userHome, { recursive: true })],
    ['with no .ssh in the ubuntu home', (fx) => fs.rmSync(path.join(fx.userHome, '.ssh'), { recursive: true })],
    ['with a skeleton file deleted', (fx) => fs.rmSync(path.join(fx.userHome, '.bash_logout'))],
  ];
  for (const [name, change] of variants) {
    const fx = cleanDistro();
    try {
      change(fx);
      if (fs.existsSync(fx.userHome)) fs.chmodSync(fx.userHome, 0o750);
      const calls = [];
      const result = await uninstallRuntimeInDistro({ ...deps(fx, calls), backup: false });
      assert.equal(result.removedLinux, true, name);
      assert.deepEqual(unregisterCalls(calls), [['wsl', ['--unregister', 'ElastOS']]], name);
    } finally {
      fx.cleanup();
    }
  }
});

test('a key, a changed skeleton file, or any extra file in /root/.ssh or /home/ubuntu is refused by name', POSIX, async () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg alice@laptop\n';
  const cases = [
    ['a key in /root/.ssh/authorized_keys', (fx) => fx.put('.ssh/authorized_keys', KEY), (fx) => `${fx.root}/.ssh/authorized_keys`],
    ['a private key in /root/.ssh', (fx) => fx.put('.ssh/id_ed25519', 'key'), (fx) => `${fx.root}/.ssh/id_ed25519`],
    ['an empty other file in /root/.ssh', (fx) => fx.put('.ssh/known_hosts', ''), (fx) => `${fx.root}/.ssh/known_hosts`],
    ['/root/.ssh as a file', (fx) => { fs.rmSync(path.join(fx.root, '.ssh'), { recursive: true }); fx.put('.ssh', ''); }, (fx) => `${fx.root}/.ssh`],
    ['a changed /root/.bashrc', (fx) => fs.appendFileSync(path.join(fx.root, '.bashrc'), 'alias ll="ls -l"\n'), (fx) => `${fx.root}/.bashrc`],
    ['a changed /root/.profile of the same size', (fx) => {
      const file = path.join(fx.root, '.profile');
      const bytes = fs.readFileSync(file);
      bytes[0] = bytes[0] === 0x23 ? 0x20 : 0x23;
      fs.writeFileSync(file, bytes);
    }, (fx) => `${fx.root}/.profile`],
    ['an extra file in /home/ubuntu', (fx) => fs.writeFileSync(path.join(fx.userHome, 'notes.txt'), 'mine'), (fx) => `${fx.userHome}/notes.txt`],
    ['a folder in /home/ubuntu', (fx) => fs.mkdirSync(path.join(fx.userHome, 'Documents')), (fx) => `${fx.userHome}/Documents`],
    ['a shell history in /home/ubuntu', (fx) => fs.writeFileSync(path.join(fx.userHome, '.bash_history'), 'ls\n'), (fx) => `${fx.userHome}/.bash_history`],
    ['a changed /home/ubuntu/.bashrc', (fx) => fs.appendFileSync(path.join(fx.userHome, '.bashrc'), 'export A=1\n'), (fx) => `${fx.userHome}/.bashrc`],
    ['/home/ubuntu/.profile replaced by root\'s .profile', (fx) => fs.writeFileSync(path.join(fx.userHome, '.profile'), ROOTFS('root.profile')), (fx) => `${fx.userHome}/.profile`],
    ['a link for /home/ubuntu/.bashrc', (fx) => {
      const file = path.join(fx.userHome, '.bashrc');
      fs.rmSync(file);
      fs.symlinkSync('/etc/skel/.bashrc', file);
    }, (fx) => `${fx.userHome}/.bashrc`],
    ['a key in /home/ubuntu/.ssh/authorized_keys', (fx) => fs.writeFileSync(path.join(fx.userHome, '.ssh', 'authorized_keys'), KEY), (fx) => `${fx.userHome}/.ssh/authorized_keys`],
    ['a private key in /home/ubuntu/.ssh', (fx) => fs.writeFileSync(path.join(fx.userHome, '.ssh', 'id_rsa'), 'key'), (fx) => `${fx.userHome}/.ssh/id_rsa`],
    ['/home/ubuntu as a link', (fx) => {
      fs.rmSync(fx.userHome, { recursive: true });
      fs.mkdirSync(path.join(fx.top, 'elsewhere'));
      fs.symlinkSync(path.join(fx.top, 'elsewhere'), fx.userHome);
    }, (fx) => fx.userHome],
    ['a second user home', (fx) => fs.mkdirSync(path.join(fx.top, 'home', 'alice')), (fx) => `${fx.dirs.homes}/alice`],
  ];
  for (const [name, add, shown] of cases) {
    const fx = cleanDistro();
    try {
      add(fx);
      const calls = [];
      let message = '';
      await assert.rejects(() => uninstallRuntimeInDistro({ ...deps(fx, calls), backup: true }), (err) => { message = err.message; return true; }, `not refused: ${name}`);
      assert.ok(message.includes(`holds files that ElastOS did not make, or that were changed: ${shown(fx)}`), `${name}: ${message}`);
      const folder = shown(fx).slice(0, shown(fx).lastIndexOf('/')).replace(/\//g, '\\');
      assert.ok(message.endsWith(`To see them, open \\\\wsl$\\ElastOS${folder} in File Explorer.`), `${name}: ${message}`);
      assert.deepEqual(unregisterCalls(calls), [], name);
      assert.equal(calls.includes('stop'), false, name);
      assertDataKept(fx);
    } finally {
      fx.cleanup();
    }
  }
});

test('the rootfs manifest is for the pinned rootfs, and its hashes are the bytes of the rootfs files', () => {
  // A new pin needs a new manifest: node scripts/rootfs-manifest.js <rootfs.tar.gz>.
  assert.equal(ROOTFS_MANIFEST.rootfsSha256, ELASTOS_ROOTFS_SHA256);
  const sha = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const files = { 'root.bashrc': ROOTFS_MANIFEST.rootFiles['.bashrc'], 'root.profile': ROOTFS_MANIFEST.rootFiles['.profile'] };
  for (const [name, want] of Object.entries(ROOTFS_MANIFEST.skel)) files[`skel${name}`] = want;
  assert.equal(Object.keys(files).length, 5);
  for (const [fixture, want] of Object.entries(files)) {
    const bytes = ROOTFS(fixture);
    assert.deepEqual({ size: bytes.length, sha256: sha(bytes) }, want, fixture);
  }
  assert.deepEqual(ROOTFS_MANIFEST.rootDirs, ['.ssh']);
  assert.deepEqual(ROOTFS_MANIFEST.homeEntries, []);
  assert.equal(ROOTFS_MANIFEST.defaultUser, 'ubuntu');
  const dirs = distroOutsideDirs(distroResetPaths('/root'));
  assert.deepEqual([dirs.rootSsh, dirs.userHome, dirs.userSsh], ['/root/.ssh', '/home/ubuntu', '/home/ubuntu/.ssh']);
});

test('a user file in the data folder is refused with the Reset rule and Uninstall words', POSIX, async () => {
  const fx = cleanDistro();
  try {
    fx.put('.local/share/elastos/holiday-photos/1.jpg', 'x');
    const calls = [];
    await assert.rejects(() => uninstallRuntimeInDistro(deps(fx, calls)), /^Error: ElastOS will not uninstall .* because it contains files that are not part of the runtime: holiday-photos\. Move those files out, then uninstall\./);
    assert.deepEqual(unregisterCalls(calls), []);
  } finally {
    fx.cleanup();
  }
});

test('only a distro named exactly ElastOS is ever removed, and only if it is still that one at the last step', POSIX, async () => {
  // No ElastOS distro: only the launcher's Windows files go, and wsl.exe --unregister never runs.
  for (const list of [GONE, 'NAME STATE VERSION\n* ElastOS-old Stopped 2\n', 'Windows Subsystem for Linux has no installed distributions.\n']) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const result = await uninstallRuntimeInDistro(deps(fx, calls, { distros: list }));
      assert.deepEqual(result, { backupPath: null, removedLinux: false });
      assert.deepEqual(unregisterCalls(calls), []);
      assert.equal(calls.includes('inspect'), false);
    } finally {
      fx.cleanup();
    }
  }
  // Another case of the name, or an unreadable list: refuse.
  for (const list of ['NAME STATE VERSION\n* elastos Running 2\n', '']) {
    const fx = cleanDistro();
    try {
      const calls = [];
      await assert.rejects(() => uninstallRuntimeInDistro(deps(fx, calls, { distros: list })), /could not check its Linux environment\. Nothing was removed\./);
      assert.deepEqual(unregisterCalls(calls), []);
      assertDataKept(fx);
    } finally {
      fx.cleanup();
    }
  }
  // The list changes after the second question.
  const fx = cleanDistro();
  try {
    const calls = [];
    const d = deps(fx, calls);
    d.confirmRemoval = async () => { d.state.distros = 'NAME STATE VERSION\n* elastos Running 2\n'; return true; };
    await assert.rejects(() => uninstallRuntimeInDistro(d), /because its Linux environment changed\. Nothing was removed\./);
    assert.deepEqual(unregisterCalls(calls), []);
  } finally {
    fx.cleanup();
  }
});

test('a copy the person chose that fails stops Uninstall before anything is removed', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const d = deps(fx, calls, { deps: { saveBackup: async () => { throw new Error('The disk is full'); } } });
    await assert.rejects(() => uninstallRuntimeInDistro(d), /^Error: ElastOS was not uninstalled\. The copy of your data could not be saved \(The disk is full\)\. Nothing was removed\.$/);
    assert.deepEqual(unregisterCalls(calls), []);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'confirm'), false);
    assertDataKept(fx);
    // Not enough space is refused before Stop.
    const tight = [];
    await assert.rejects(() => uninstallRuntimeInDistro(deps(fx, tight, { deps: { checkBackupSpace: async () => { throw new Error('There is not enough free space for a copy of your data'); } } })), /Free some space, or uninstall without a copy\./);
    assert.equal(tight.includes('stop'), false);
    assert.deepEqual(unregisterCalls(tight), []);
  } finally {
    fx.cleanup();
  }
});

test('wsl.exe failing or missing gives a plain message, and the launcher files stay', POSIX, async () => {
  const cases = [
    [async () => 1, /^Error: ElastOS could not remove its Linux environment \(wsl\.exe stopped with code 1\)\. Your copy of your ElastOS data is in .*\. Click Uninstall to try again\.$/],
    [async () => { throw new Error('spawn wsl.exe ENOENT'); }, /^Error: ElastOS could not run wsl\.exe to remove its Linux environment\. .*Click Uninstall to try again\.$/],
    [async () => 0, /but it is still listed\. .*Restart Windows, then click Uninstall again\.$/],
  ];
  for (const [runWsl, message] of cases) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls);
      d.runWsl = async (args) => { calls.push(['wsl', args]); return runWsl(); };
      await assert.rejects(() => uninstallRuntimeInDistro(d), message);
      assert.equal(unregisterCalls(calls).length, 1);
      assert.ok(fs.existsSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')));
    } finally {
      fx.cleanup();
    }
  }
  // No wsl.exe at all: there is no ElastOS Linux environment to remove.
  const fx = cleanDistro();
  try {
    const calls = [];
    const result = await uninstallRuntimeInDistro({ ...deps(fx, calls), hasWsl: async () => false });
    assert.deepEqual(result, { backupPath: null, removedLinux: false });
    assert.deepEqual(unregisterCalls(calls), []);
  } finally {
    fx.cleanup();
  }
});

test('python3 missing in the distro: Uninstall and its dialog say so in Uninstall words', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    await assert.rejects(
      () => uninstallRuntimeInDistro({ ...deps(fx, calls), pythonPresent: async () => { calls.push('python'); return false; } }),
      (err) => err.message === 'ElastOS was not uninstalled, because the program python3 is missing from its Linux environment, and Uninstall needs it. Nothing was deleted. Click Install to add python3 again, then click Uninstall.',
    );
    assert.deepEqual(calls, ['wsl-list', 'python']);
    const seen = await describeDistroBackup({
      run: localRun([]), home: fx.winHome, paths: fx.paths, distroPresent: async () => true, pythonPresent: async () => false, action: 'uninstall',
    });
    assert.equal(seen.blocked, 'ElastOS cannot uninstall yet, because the program python3 is missing from its Linux environment, and Uninstall needs it. Click Install to add python3 again, then click Uninstall.');
  } finally {
    fx.cleanup();
  }
});

test('the window asks for the copy on Windows Uninstall, and the second question is asked by the main process', () => {
  const copy = flow.confirmCopy('runtime', [], true);
  assert.match(copy.body, /the Linux environment named ElastOS, with the ElastOS program and all your ElastOS data in it/);
  assert.match(copy.body, /ElastOS asks you one more time before it removes anything/);
  assert.equal(flow.confirmCopy('runtime', [], false).body, 'This removes the ElastOS program and its data from this computer.');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(app, /if \(uninstallOffersCopy\) await loadBackupOffer\('uninstall'\);/);
  assert.match(app, /return confirmMode === 'reset' \|\| \(confirmMode === 'uninstall' && uninstallOffersCopy\);/);
  assert.match(app, /window\.elastos\.uninstall\(resetChoice \|\| undefined\)/);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(main, /defaultId: 0,\s*cancelId: 0,/);
  assert.match(main, /return answer\.response === 1;/);
  // wsl.exe runs with no shell and the fixed arguments only.
  const src = fs.readFileSync(path.join(__dirname, '../src/main/targets/windowsUninstall.ts'), 'utf8');
  assert.match(src, /spawn\('wsl\.exe', \[\.\.\.args\], \{ windowsHide: true, shell: false,/);
  assert.match(src, /code = await deps\.runWsl\(wslUnregisterArgs\(\)\);/);
  assert.equal((src.match(/deps\.runWsl\(/g) || []).length, 1);
});
