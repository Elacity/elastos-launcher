const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
  assertExportSpace,
  decodeWslText,
  distroUsedBytes,
  elastosRowOf,
  exportDistroToBackups,
  exportNeededBytes,
  uninstallPrompt,
  uninstallRuntimeInDistro,
  UNINSTALL_CHOICE_MESSAGE,
  verifyExportFile,
  wslExportArgs,
  wslListArgs,
  wslListLines,
  wslTerminateArgs,
  wslUnregisterArgs,
} = require('../dist/main/targets/windowsUninstall');
const { parseWslDistroList } = require('../dist/main/legacyPc2Removal');
const { removeVerifiedTarget } = require('../dist/main/targets/runtimeUninstall');
const { failureScreen } = require('../dist/main/targets/runtimeRecovery');
const { readStoredZipEntries } = require('../dist/main/targets/runtimeBackup');
const { loadActiveRuntimePin } = require('../dist/main/targets/runtimePin');
const flow = require('../src/renderer/flow.js');

const SIGNED_HEAD = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-head-0.8.0-alpha.22.json'));
const DID = loadActiveRuntimePin().maintainerDid;
// The helper runs inside Linux. Here it runs with this machine's python3, so these tests need POSIX.
const POSIX = { skip: process.platform === 'win32' };

/** `wsl.exe --list --quiet` as Windows writes it: UTF-16LE with a byte order mark, CRLF line ends. */
function utf16(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}
const LISTED = { code: 0, stdout: utf16('ElastOS\r\nUbuntu\r\n') };
const GONE = { code: 0, stdout: utf16('Ubuntu\r\n') };
/** What run 39053766139 printed after unregister on a runner with no other distro (exit code is non-zero). */
const NO_DISTROS = {
  code: 4294967295,
  stdout: utf16('Windows Subsystem for Linux has no installed distributions.\r\nYou can resolve this by installing a distribution with the instructions below:\r\n\r\nUse \'wsl.exe --list --online\' to list available distributions\r\nand \'wsl.exe --install <Distro>\' to install.\r\n'),
};

/** A small, complete tar file: one header, one data block, and the two zero blocks that end it. */
function tarBytes() {
  const header = Buffer.alloc(512);
  header.write('etc/hostname', 0, 'latin1');
  header.write('0000644\0', 100, 'latin1');
  header.write('00000000002\0', 124, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  const data = Buffer.alloc(512);
  data.write('x\n');
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

/** The real helper, run with this machine's python3 instead of wsl.exe. */
function localRun(calls) {
  return async (op, input, options) => {
    calls.push(op);
    const args = distroHelperArgs(op);
    return spawnHelper('python3', args.slice(args.indexOf('--exec') + 2), input, options);
  };
}

/**
 * A Linux environment as Install leaves it, plus files a person keeps
 * outside the data folder. The whole-environment copy holds those too, so
 * they no longer stop Uninstall.
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
  put('.bashrc', 'changed by the person');
  put('notes.txt', 'mine, outside the data folder');
  put('.ssh/authorized_keys', 'ssh-ed25519 AAAA alice@laptop\n');
  fs.mkdirSync(path.join(top, 'home', 'alice'), { recursive: true });
  fs.mkdirSync(path.join(top, 'srv'), { recursive: true });
  fs.writeFileSync(path.join(top, 'srv', 'site.html'), 'mine');
  put('.local/bin/elastos', 'program');
  put('.elastos-launcher/install-stage.json', '{"stage":"done"}');
  put('.local/share/elastos/installation/release-head.json', SIGNED_HEAD);
  put('.local/share/elastos/installation/release.json', '{}');
  put('.local/share/elastos/components.json', '{}');
  put('.local/share/elastos/sources.json', '{}');
  put('.local/share/elastos/signing_key', 'secret key bytes');
  put('.local/share/elastos/Users/alice/notes.txt', 'my notes');
  fs.mkdirSync(path.join(winHome, '.elastos-launcher'), { recursive: true });
  fs.writeFileSync(path.join(winHome, '.elastos-launcher', 'install-stage.json'), '{"stage":"done"}');
  return { top, root, winHome, paths, put, cleanup: () => fs.rmSync(top, { recursive: true, force: true }) };
}

/**
 * Every outside call is recorded in `calls`. wsl.exe is a fake: --terminate
 * returns 0, --export writes `state.exportBytes` (a complete tar by default),
 * --unregister removes ElastOS from the list.
 */
function deps(fx, calls, extra = {}) {
  const run = localRun(calls);
  const state = { list: extra.list ?? LISTED, exportBytes: tarBytes(), exportCode: 0, free: 1e12 };
  const usedBytes = () => distroUsedBytes(run, fx.paths);
  const freeBytes = () => state.free;
  const d = {
    state,
    backup: true,
    homeDir: fx.winHome,
    platform: 'linux',
    env: {},
    paths: fx.paths,
    stop: async () => { calls.push('stop'); },
    hasWsl: async () => true,
    listDistros: async () => { calls.push('wsl-list'); return state.list; },
    pythonPresent: async () => { calls.push('python'); return true; },
    inspect: () => inspectDistro(run, fx.paths, 'uninstall'),
    maintainerDid: DID,
    checkBackupSpace: async () => { calls.push('space'); },
    saveBackup: () => writeDistroBackup({
      run, paths: fx.paths, home: fx.winHome, platform: 'linux', restrict: () => {}, freeBytes: () => 1e12,
    }),
    checkLinuxSpace: () => assertExportSpace({ home: fx.winHome, usedBytes, freeBytes }),
    saveLinux: () => exportDistroToBackups({
      home: fx.winHome,
      dataDir: fx.paths.dataDir,
      platform: 'linux',
      restrict: (target, folder) => { calls.push(['restrict', path.basename(target), folder]); },
      usedBytes,
      freeBytes,
      runWsl: (args, timeoutMs) => d.runWsl(args, timeoutMs),
    }),
    confirmRemoval: async (prompt) => { calls.push(['confirm', prompt]); return true; },
    runWsl: async (args) => {
      calls.push(['wsl', args]);
      if (args[0] === '--export') {
        if (state.exportBytes) fs.writeFileSync(args[2], state.exportBytes);
        return state.exportCode;
      }
      if (args[0] === '--unregister') state.list = GONE;
      return 0;
    },
    removeHost: (target) => { calls.push(`host:${path.basename(target)}`); removeVerifiedTarget(target); },
    ...extra.deps,
  };
  return d;
}

const wslCalls = (calls, verb) => calls.filter((call) => Array.isArray(call) && call[0] === 'wsl' && call[1][0] === verb);
const unregisterCalls = (calls) => wslCalls(calls, '--unregister');
const exportCalls = (calls) => wslCalls(calls, '--export');
const backups = (fx) => path.join(fx.winHome, 'ElastOS-backups');
const tars = (fx) => (fs.existsSync(backups(fx)) ? fs.readdirSync(backups(fx)).filter((name) => name.endsWith('.tar')) : []);

function assertNothingRemoved(fx, calls, name = '') {
  assert.deepEqual(unregisterCalls(calls), [], name);
  assert.equal(fs.readFileSync(path.join(fx.paths.dataDir, 'Users', 'alice', 'notes.txt'), 'utf8'), 'my notes', name);
  assert.equal(fs.readFileSync(fx.paths.binary, 'utf8'), 'program', name);
  assert.ok(fs.existsSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), name);
}

test('Windows Uninstall: second question, list, record, whole-environment copy, list, unregister once, gone', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const result = await uninstallRuntimeInDistro(deps(fx, calls));
    assert.deepEqual(unregisterCalls(calls), [['wsl', ['--unregister', 'ElastOS']]]);
    assert.equal(result.removedLinux, true);
    assert.ok(result.backupPath && readStoredZipEntries(result.backupPath).some((entry) => entry.name === 'elastos/Users/alice/notes.txt'));
    assert.match(path.basename(result.linuxCopyPath), /^ElastOS-linux-\d{8}-\d{6}Z\.tar$/);
    assert.equal(path.dirname(result.linuxCopyPath), backups(fx));
    assert.equal(verifyExportFile(result.linuxCopyPath), 2048);
    assert.equal(result.restoreHint, `To bring it back, open PowerShell and run: wsl --import ElastOS C:\\ElastOS\\distro "${result.linuxCopyPath}"`);
    const steps = calls.map((call) => (Array.isArray(call) ? (call[0] === 'wsl' ? `wsl ${call[1][0]}` : call[0]) : call));
    assert.deepEqual(steps, [
      'wsl-list', 'python', 'inspect', 'space', 'used', 'stop', 'measure', 'zip',
      'confirm',
      'wsl-list', 'inspect',
      'restrict', 'used', 'wsl --terminate', 'wsl --export', 'restrict',
      'wsl-list', 'wsl --unregister', 'wsl-list',
      'host:install-stage.json', 'host:resume-install.json', 'host:resume-install.json.lock',
    ]);
    assert.deepEqual(exportCalls(calls), [['wsl', ['--export', 'ElastOS', result.linuxCopyPath]]]);
    // The folder and then the file get owner-only access.
    assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'restrict'), [
      ['restrict', 'ElastOS-backups', true],
      ['restrict', path.basename(result.linuxCopyPath), false],
    ]);
    const prompt = calls.find((call) => Array.isArray(call) && call[0] === 'confirm')[1];
    assert.deepEqual(prompt, uninstallPrompt(result.backupPath, backups(fx)));
    assert.equal(prompt.detail, `First, ElastOS saves the whole Linux environment as one file in ${backups(fx)}. If it cannot save that file, nothing is removed. Your copy of your ElastOS data is in ${result.backupPath}. You cannot undo the removal. Only the saved file can bring the Linux environment back.`);
    assert.equal(prompt.cancelLabel, 'Cancel');
    assert.equal(fs.existsSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), false);
  } finally {
    fx.cleanup();
  }
});

test('files outside the data folder no longer stop Uninstall: the whole-environment copy holds them', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const result = await uninstallRuntimeInDistro({ ...deps(fx, calls), backup: false });
    assert.equal(result.removedLinux, true);
    assert.equal(result.backupPath, null);
    assert.equal(exportCalls(calls).length, 1);
    assert.ok(calls.indexOf(exportCalls(calls)[0]) < calls.indexOf(unregisterCalls(calls)[0]));
  } finally {
    fx.cleanup();
  }
});

test('wsl.exe --list output is read by line, as UTF-16LE with a byte order mark and CRLF, or as UTF-8', () => {
  assert.deepEqual(wslListLines(utf16('ElastOS\r\nUbuntu\r\n')), ['ElastOS', 'Ubuntu']);
  assert.deepEqual(wslListLines(Buffer.from('ElastOS\r\nUbuntu\r\n', 'utf16le')), ['ElastOS', 'Ubuntu']);
  assert.deepEqual(wslListLines(Buffer.from('\uFEFFElastOS\nUbuntu\n', 'utf8')), ['ElastOS', 'Ubuntu']);
  assert.equal(decodeWslText(utf16('ElastOS')), 'ElastOS');
  assert.equal(elastosRowOf(LISTED), 'present');
  assert.equal(elastosRowOf({ code: 0, stdout: Buffer.from('Ubuntu\nElastOS\n') }), 'present');
  // A line with a space in it is one name. Split at the space, it would read as ElastOS.
  const spaced = utf16('ElastOS dev\r\n');
  assert.equal(parseWslDistroList(spaced.toString('utf8').replace(/\0/g, ''))[0].name.endsWith('ElastOS'), true);
  assert.deepEqual(wslListLines(spaced), ['ElastOS dev']);
  assert.equal(elastosRowOf({ code: 0, stdout: spaced }), 'absent');
  assert.equal(parseWslDistroList('ElastOS dev\n')[0].name, 'ElastOS');
  assert.equal(elastosRowOf({ code: 0, stdout: Buffer.from('ElastOS dev\r\n', 'utf8') }), 'absent');
  // The no-distro message is not a list of names (run 39053766139 read it as "You, Use, and").
  assert.equal(elastosRowOf(NO_DISTROS), 'absent');
  assert.equal(elastosRowOf(GONE), 'absent');
  assert.equal(elastosRowOf({ code: 0, stdout: utf16('ElastOS-dev\r\nUbuntu\r\n') }), 'absent');
  assert.equal(elastosRowOf({ code: 0, stdout: Buffer.alloc(0) }), 'absent');
  // Refused: two, another case (WSL names ignore case), wsl.exe not run, a failed list that names ElastOS, a failed empty list.
  assert.equal(elastosRowOf({ code: 0, stdout: utf16('ElastOS\r\nElastOS\r\n') }), 'unknown');
  assert.equal(elastosRowOf({ code: 0, stdout: utf16('elastos\r\n') }), 'unknown');
  assert.equal(elastosRowOf({ code: 0, stdout: utf16('ElastOS\r\nELASTOS\r\n') }), 'unknown');
  assert.equal(elastosRowOf({ code: null, stdout: LISTED.stdout }), 'unknown');
  assert.equal(elastosRowOf({ code: 1, stdout: LISTED.stdout }), 'unknown');
  assert.equal(elastosRowOf({ code: 1, stdout: Buffer.alloc(0) }), 'unknown');
  assert.deepEqual(wslListArgs(), ['--list', '--quiet']);
});

test('at the start: two ElastOS lines or another case refuse; a look-alike or no ElastOS removes no Linux environment', POSIX, async () => {
  for (const stdout of [utf16('ElastOS\r\nElastOS\r\n'), utf16('elastos\r\n')]) {
    const fx = cleanDistro();
    try {
      const calls = [];
      await assert.rejects(() => uninstallRuntimeInDistro(deps(fx, calls, { list: { code: 0, stdout } })), /could not check its Linux environment\. Nothing was removed\./);
      assert.equal(calls.includes('stop'), false);
      assertNothingRemoved(fx, calls);
    } finally {
      fx.cleanup();
    }
  }
  for (const list of [GONE, NO_DISTROS, { code: 0, stdout: utf16('ElastOS-dev\r\n') }, { code: 0, stdout: utf16('ElastOS dev\r\n') }]) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const result = await uninstallRuntimeInDistro(deps(fx, calls, { list }));
      assert.deepEqual(result, { backupPath: null, linuxCopyPath: null, restoreHint: null, removedLinux: false });
      assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'wsl'), []);
      assert.equal(calls.includes('inspect'), false);
    } finally {
      fx.cleanup();
    }
  }
});

test('the list changes after the second question: zero, two, or another case of ElastOS means no copy and no unregister', POSIX, async () => {
  for (const [name, list] of [
    ['zero', GONE],
    ['two', { code: 0, stdout: utf16('ElastOS\r\nElastOS\r\n') }],
    ['another case', { code: 0, stdout: utf16('elastos\r\n') }],
    ['ElastOS-dev only', { code: 0, stdout: utf16('ElastOS-dev\r\n') }],
    ['list failed', { code: null, stdout: Buffer.alloc(0) }],
  ]) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls);
      d.confirmRemoval = async () => { d.state.list = list; return true; };
      await assert.rejects(() => uninstallRuntimeInDistro(d), /because its Linux environment changed\. Nothing was removed\./, name);
      assert.deepEqual(exportCalls(calls), [], name);
      assertNothingRemoved(fx, calls, name);
    } finally {
      fx.cleanup();
    }
  }
});

test('the list changes between the copy and unregister: no unregister, and the message names the saved file', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const d = deps(fx, calls);
    const real = d.runWsl;
    d.runWsl = async (args, ms) => {
      const code = await real(args, ms);
      if (args[0] === '--export') d.state.list = { code: 0, stdout: utf16('ElastOS\r\nElastOS\r\n') };
      return code;
    };
    let message = '';
    await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => { message = err.message; return true; });
    assert.match(message, /because its Linux environment changed\. Nothing was removed\./);
    assert.equal(exportCalls(calls).length, 1);
    const saved = exportCalls(calls)[0][1][2];
    assert.ok(message.endsWith(`A copy of the whole Linux environment is saved in ${saved}. Click Uninstall to try again.`), message);
    assertNothingRemoved(fx, calls);
  } finally {
    fx.cleanup();
  }
});

test('the whole-environment copy failing stops Uninstall: no unregister, and no part file is left', POSIX, async () => {
  const cases = [
    ['export exits 1', (d) => { d.state.exportCode = 1; }, /\(wsl\.exe stopped with code 1\)/],
    ['export exits 1 and writes nothing', (d) => { d.state.exportCode = 1; d.state.exportBytes = null; }, /\(wsl\.exe stopped with code 1\)/],
    ['export cannot run or times out', (d) => {
      const real = d.runWsl;
      d.runWsl = async (args, ms) => { if (args[0] === '--export') { d.calls.push(['wsl', args]); throw new Error('timeout'); } return real(args, ms); };
    }, /\(wsl\.exe could not save it, or took too long\)/],
    ['export writes an empty file', (d) => { d.state.exportBytes = Buffer.alloc(0); }, /\(The saved file is empty\)/],
    ['export is cut short', (d) => { d.state.exportBytes = tarBytes().subarray(0, 1536); }, /\(The saved file is not a complete copy\)/],
    ['export is not a tar file', (d) => { d.state.exportBytes = Buffer.alloc(4096, 1); }, /\(The saved file is not a complete copy\)/],
    ['export exits 0 and writes nothing', (d) => { d.state.exportBytes = null; }, /could not save a copy of its whole Linux environment/],
    ['the environment cannot be stopped first', (d) => {
      const real = d.runWsl;
      d.runWsl = async (args, ms) => (args[0] === '--terminate' ? (d.calls.push(['wsl', args]), 1) : real(args, ms));
    }, /\(ElastOS could not stop its Linux environment before saving it\)/],
    ['too little space when the copy starts', (d) => {
      const real = d.confirmRemoval;
      d.confirmRemoval = async (prompt) => { d.state.free = 10; return real(prompt); };
    }, /\(There is not enough free space for a copy of the whole ElastOS Linux environment\. It needs about [\d.]+ [KMG]B, and 1 KB is free\)/],
    ['free space cannot be read', (d) => {
      const real = d.confirmRemoval;
      d.confirmRemoval = async (prompt) => { d.state.free = null; return real(prompt); };
    }, /\(ElastOS could not check the free space for a copy of its whole Linux environment\)/],
  ];
  for (const [name, change, reason] of cases) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls);
      d.calls = calls;
      change(d);
      let message = '';
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => { message = err.message; return true; }, name);
      assert.match(message, /^ElastOS was not uninstalled\. It could not save a copy of its whole Linux environment \(/, `${name}: ${message}`);
      assert.match(message, reason, `${name}: ${message}`);
      assert.match(message, /Nothing was removed\. Your copy of your ElastOS data is in .*\.zip\. Click Uninstall to try again\.$/, `${name}: ${message}`);
      assertNothingRemoved(fx, calls, name);
      assert.deepEqual(tars(fx), [], name);
    } finally {
      fx.cleanup();
    }
  }
});

test('too little space for the whole-environment copy is refused before Stop', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const d = deps(fx, calls);
    d.state.free = 1024;
    await assert.rejects(() => uninstallRuntimeInDistro(d), /^Error: ElastOS was not uninstalled\. There is not enough free space for a copy of the whole ElastOS Linux environment\. It needs about [\d.]+ [KMG]B, and 1 KB is free\. Nothing was removed\. Free some space, then click Uninstall\.$/);
    assert.equal(calls.includes('stop'), false);
    assertNothingRemoved(fx, calls);
    assert.equal(exportNeededBytes(1000), 1000 + 100 + 64 * 1024 * 1024);
  } finally {
    fx.cleanup();
  }
});

test('without a yes to the second question, nothing is saved, unregistered, or removed', POSIX, async () => {
  for (const answer of [false, undefined, 'yes', 1, null]) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls, { deps: { confirmRemoval: async () => answer } });
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => {
        assert.match(err.message, /^ElastOS was not uninstalled\. Nothing was removed\. Your copy of your ElastOS data is in .*\.zip\. Click Start to use ElastOS again\.$/);
        return true;
      });
      assert.deepEqual(exportCalls(calls), [], String(answer));
      assertNothingRemoved(fx, calls, String(answer));
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
    assertNothingRemoved(fx, []);
  } finally {
    fx.cleanup();
  }
});

test('a missing, tampered, or foreign-signed install record, or no data folder, is not proof: nothing is saved or unregistered', POSIX, async () => {
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
      assert.deepEqual(exportCalls(calls), [], name);
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
    assert.deepEqual(exportCalls(calls), []);
  } finally {
    fx.cleanup();
  }
});

test('the record or ownership changing after the second question stops Uninstall before the copy and unregister', POSIX, async () => {
  const record = (fx) => path.join(fx.paths.dataDir, 'installation', 'release-head.json');
  const cases = [
    ['record tampered', (fx) => fs.writeFileSync(record(fx), SIGNED_HEAD.toString('utf8').replace('0.8.0-alpha.22', '0.8.0-alpha.99')), /has no signed ElastOS install record/],
    ['record removed', (fx) => fs.rmSync(record(fx)), /has no signed ElastOS install record/],
    ['a person\'s file in the data folder', (fx) => fx.put('.local/share/elastos/holiday-photos/1.jpg', 'x'), /because it contains files that are not part of the runtime: holiday-photos/],
    ['the data folder as a link', (fx) => {
      fs.renameSync(fx.paths.dataDir, path.join(fx.top, 'moved'));
      fs.symlinkSync(path.join(fx.top, 'moved'), fx.paths.dataDir);
    }, /is not a real folder/],
  ];
  for (const [name, change, reason] of cases) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls);
      d.confirmRemoval = async () => { change(fx); return true; };
      let message = '';
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => { message = err.message; return true; }, name);
      assert.match(message, reason, `${name}: ${message}`);
      assert.match(message, /Your copy of your ElastOS data is in .*\.zip\.$/, `${name}: ${message}`);
      assert.deepEqual(exportCalls(calls), [], name);
      assert.deepEqual(unregisterCalls(calls), [], name);
      assert.equal(calls.filter((call) => call === 'inspect').length, 2, name);
    } finally {
      fx.cleanup();
    }
  }
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

test('a copy of the data the person chose that fails stops Uninstall before anything is removed', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const d = deps(fx, calls, { deps: { saveBackup: async () => { throw new Error('The disk is full'); } } });
    await assert.rejects(() => uninstallRuntimeInDistro(d), /^Error: ElastOS was not uninstalled\. The copy of your data could not be saved \(The disk is full\)\. Nothing was removed\.$/);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'confirm'), false);
    assert.deepEqual(exportCalls(calls), []);
    assertNothingRemoved(fx, calls);
    const tight = [];
    await assert.rejects(() => uninstallRuntimeInDistro(deps(fx, tight, { deps: { checkBackupSpace: async () => { throw new Error('There is not enough free space for a copy of your data'); } } })), /Free some space, or uninstall without a copy\./);
    assert.equal(tight.includes('stop'), false);
    assert.deepEqual(unregisterCalls(tight), []);
  } finally {
    fx.cleanup();
  }
});

test('unregister failing, or ElastOS still listed after it, gives a plain message that names the saved file', POSIX, async () => {
  const cases = [
    [async () => 1, /^Error: ElastOS could not remove its Linux environment \(wsl\.exe stopped with code 1\)\. .*Click Uninstall to try again\.$/],
    [async () => { throw new Error('spawn wsl.exe ENOENT'); }, /^Error: ElastOS could not run wsl\.exe to remove its Linux environment\. .*Click Uninstall to try again\.$/],
    [async () => 0, /^Error: ElastOS asked Windows to remove its Linux environment, but it is still listed\. .*Restart Windows, then click Uninstall again\.$/],
  ];
  for (const [unregister, message] of cases) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls);
      const real = d.runWsl;
      d.runWsl = async (args, ms) => {
        if (args[0] !== '--unregister') return real(args, ms);
        calls.push(['wsl', args]);
        return unregister();
      };
      let text = '';
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => { text = err.message; return true; });
      assert.match(`Error: ${text}`, message);
      assert.ok(text.includes(`A copy of the whole Linux environment is saved in ${exportCalls(calls)[0][1][2]}.`), text);
      assert.equal(unregisterCalls(calls).length, 1);
      assert.ok(fs.existsSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')));
    } finally {
      fx.cleanup();
    }
  }
  // A list that cannot be read after unregister is not proof that it is gone.
  const fx = cleanDistro();
  try {
    const calls = [];
    const d = deps(fx, calls);
    const real = d.runWsl;
    d.runWsl = async (args, ms) => {
      const code = await real(args, ms);
      if (args[0] === '--unregister') d.state.list = { code: null, stdout: Buffer.alloc(0) };
      return code;
    };
    await assert.rejects(() => uninstallRuntimeInDistro(d), /but it is still listed/);
  } finally {
    fx.cleanup();
  }
  // No wsl.exe at all: there is no ElastOS Linux environment to remove.
  const none = cleanDistro();
  try {
    const calls = [];
    const result = await uninstallRuntimeInDistro({ ...deps(none, calls), hasWsl: async () => false });
    assert.equal(result.removedLinux, false);
    assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'wsl'), []);
  } finally {
    none.cleanup();
  }
});

test('the saved file never replaces a file, and a real GNU tar file passes the check', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const now = new Date(Date.UTC(2026, 9, 18, 12, 0, 0));
    fs.mkdirSync(backups(fx), { recursive: true });
    fs.writeFileSync(path.join(backups(fx), 'ElastOS-linux-20261018-120000Z.tar'), 'older copy');
    const calls = [];
    const d = deps(fx, calls);
    const saved = await exportDistroToBackups({
      home: fx.winHome, dataDir: fx.paths.dataDir, platform: 'linux', restrict: () => {}, usedBytes: async () => 1, freeBytes: () => 1e12, runWsl: d.runWsl, now,
    });
    assert.equal(path.basename(saved), 'ElastOS-linux-20261018-120000Z-2.tar');
    assert.equal(fs.readFileSync(path.join(backups(fx), 'ElastOS-linux-20261018-120000Z.tar'), 'utf8'), 'older copy');
    assert.deepEqual(calls.map((call) => call[1]), [wslTerminateArgs(), wslExportArgs(saved)]);
    // The same check on what tar itself writes.
    const real = path.join(fx.top, 'real.tar');
    execFileSync('tar', ['-cf', real, '-C', fx.root, '.local/share/elastos/components.json']);
    assert.ok(verifyExportFile(real) >= 2048);
    // A link in place of the file is refused.
    fs.symlinkSync(real, path.join(fx.top, 'link.tar'));
    assert.throws(() => verifyExportFile(path.join(fx.top, 'link.tar')), /not a complete copy/);
  } finally {
    fx.cleanup();
  }
});

test('the helper measures the bytes in use in the Linux environment', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const bytes = await distroUsedBytes(localRun([]), fx.paths);
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
    await assert.rejects(() => distroUsedBytes(async () => ({ code: 0, stdout: '{"bytes":-1}', stderr: '' }), fx.paths), /could not measure/);
    await assert.rejects(() => distroUsedBytes(async () => ({ code: 3, stdout: '', stderr: '' }), fx.paths), /could not measure/);
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

test('the window asks for the copy on Windows Uninstall, the main process asks the second question, and wsl.exe runs with no shell', () => {
  const copy = flow.confirmCopy('runtime', [], true);
  assert.match(copy.body, /the Linux environment named ElastOS, with the ElastOS program and all your ElastOS data in it/);
  assert.match(copy.body, /Before it removes anything, it saves the whole Linux environment as one file in your ElastOS-backups folder\./);
  assert.equal(flow.confirmCopy('runtime', [], false).body, 'This removes the ElastOS program and its data from this computer.');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(app, /if \(uninstallOffersCopy\) await loadBackupOffer\('uninstall'\);/);
  assert.match(app, /window\.elastos\.uninstall\(resetChoice \|\| undefined\)/);
  assert.match(app, /The whole ElastOS Linux environment is saved in \$\{result\.linuxCopyPath\}\. Keep it private\. \$\{result\.restoreHint\}\./);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(main, /defaultId: 0,\s*cancelId: 0,/);
  assert.match(main, /return answer\.response === 1;/);
  const src = fs.readFileSync(path.join(__dirname, '../src/main/targets/windowsUninstall.ts'), 'utf8');
  assert.equal(/\bspawn\(|exec\(|execSync/.test(src), false);
  assert.equal((src.match(/execFile\('wsl\.exe', /g) || []).length, 2);
  assert.equal((src.match(/shell: false,/g) || []).length, 2);
  assert.equal((src.match(/deps\.runWsl\(/g) || []).length, 1);
  assert.match(src, /code = await deps\.runWsl\(wslUnregisterArgs\(\), /);
  assert.deepEqual(wslUnregisterArgs(), ['--unregister', 'ElastOS']);
  assert.deepEqual(wslTerminateArgs(), ['--terminate', 'ElastOS']);
  assert.deepEqual(wslExportArgs('C:\\Users\\a b\\ElastOS-backups\\x.tar'), ['--export', 'ElastOS', 'C:\\Users\\a b\\ElastOS-backups\\x.tar']);
});
