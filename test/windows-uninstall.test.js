const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  distroHelperArgs,
  distroResetPaths,
  inspectDistro,
  removeInDistro,
  resetRuntimeInDistro,
  spawnHelper,
  writeDistroBackup,
} = require('../dist/main/targets/windowsReset');
const {
  decodeWslText,
  distroUsedBytes,
  elastosRowOf,
  exportDistroToBackups,
  exportNeededBytes,
  linuxCopyMessage,
  planDistroExport,
  restoreCommand,
  uninstallPrompt,
  uninstallRuntimeInDistro,
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
const { plainBytes, readStoredZipEntries } = require('../dist/main/targets/runtimeBackup');
const { RESET_CHOICE_MESSAGE } = require('../dist/main/targets/runtimeUninstall');
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
 * The disk numbers every Uninstall test passes in, so no result depends on
 * the disk of the machine that runs the tests. USED is the size of the
 * whole-environment copy on real Windows (run 39085928916).
 */
const USED = 1646233600;
const NEEDED = exportNeededBytes(USED);
const FREE = 100e9;

/**
 * Every outside call is recorded in `calls`. wsl.exe is a fake: --terminate
 * returns 0, --export writes `state.exportBytes` (a complete tar by default),
 * --unregister removes ElastOS from the list. The bytes in use and the free
 * space are `state.used` and `state.free`.
 */
function deps(fx, calls, extra = {}) {
  const run = localRun(calls);
  const state = { list: extra.list ?? LISTED, exportBytes: tarBytes(), exportCode: 0, used: USED, free: FREE };
  const usedBytes = async () => { calls.push('used'); return state.used; };
  const freeBytes = () => { calls.push('free'); return state.free; };
  const d = {
    state,
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
    planLinuxCopy: () => planDistroExport({ home: fx.winHome, usedBytes, freeBytes }),
    saveLinux: (plan) => exportDistroToBackups({
      plan,
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
    assert.match(path.basename(result.linuxCopyPath), /^ElastOS-linux-\d{8}-\d{6}Z\.tar$/);
    assert.equal(path.dirname(result.linuxCopyPath), backups(fx));
    assert.equal(verifyExportFile(result.linuxCopyPath), 2048);
    assert.equal(result.restoreHint, `To bring it back, open PowerShell and run: wsl --import ElastOS C:\\ElastOS\\distro "${result.linuxCopyPath}"`);
    const steps = calls.map((call) => (Array.isArray(call) ? (call[0] === 'wsl' ? `wsl ${call[1][0]}` : call[0]) : call));
    assert.deepEqual(steps, [
      'wsl-list', 'python', 'inspect', 'used', 'free', 'stop',
      'confirm',
      'wsl-list', 'inspect',
      'restrict', 'used', 'free', 'wsl --terminate', 'wsl --export', 'restrict',
      'wsl-list', 'wsl --unregister', 'wsl-list',
      'host:install-stage.json', 'host:resume-install.json', 'host:resume-install.json.lock',
    ]);
    assert.deepEqual(exportCalls(calls), [['wsl', ['--export', 'ElastOS', result.linuxCopyPath]]]);
    // The folder and then the file get owner-only access.
    assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'restrict'), [
      ['restrict', 'ElastOS-backups', true],
      ['restrict', path.basename(result.linuxCopyPath), false],
    ]);
    // The second question, before the copy: the exact file it then wrote, an estimated size, the several-GB warning, and the restore command.
    const prompt = calls.find((call) => Array.isArray(call) && call[0] === 'confirm')[1];
    const lines = prompt.detail.split('\n');
    assert.equal(lines[1], result.linuxCopyPath);
    assert.equal(lines[2], 'Estimated size: about 1.6 GB. This is an estimate, not the exact size. The file can be several GB.');
    assert.equal(lines[5], `wsl --import ElastOS C:\\ElastOS\\distro "${result.linuxCopyPath}"`);
    assert.equal(prompt.detail, [
      'Before it removes anything, ElastOS saves the whole Linux environment in this file:',
      result.linuxCopyPath,
      lines[2],
      'If ElastOS cannot save the file, it stops and removes nothing.',
      'You cannot undo the removal. To bring the Linux environment back from the file, open PowerShell and run:',
      restoreCommand(result.linuxCopyPath),
    ].join('\n'));
    assert.equal(prompt.title, 'Remove the ElastOS Linux environment?');
    assert.equal(prompt.message, 'This removes the Linux environment named ElastOS from this computer, with everything in it: the ElastOS program and all your ElastOS data.');
    assert.equal(prompt.cancelLabel, 'Cancel');
    assert.equal(prompt.confirmLabel, 'Remove ElastOS');
    // After the copy: the real path and the real size.
    assert.equal(result.linuxCopyBytes, 2048);
    assert.equal(result.linuxCopyMessage, `ElastOS saved the whole Linux environment in ${result.linuxCopyPath}. The file is 3 KB. Keep it private: it holds your ElastOS keys and data. To bring it back, open PowerShell and run: wsl --import ElastOS C:\\ElastOS\\distro "${result.linuxCopyPath}"`);
    assert.equal(fs.existsSync(path.join(fx.winHome, '.elastos-launcher', 'install-stage.json')), false);
  } finally {
    fx.cleanup();
  }
});

test('files outside the data folder no longer stop Uninstall: the whole-environment copy holds them', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const result = await uninstallRuntimeInDistro(deps(fx, calls));
    assert.equal(result.removedLinux, true);
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
      assert.deepEqual(result, { linuxCopyPath: null, linuxCopyBytes: null, linuxCopyMessage: null, restoreHint: null, removedLinux: false });
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
    }, new RegExp(`\\(There is not enough free space for a copy of the whole ElastOS Linux environment\\. It needs about ${plainBytes(NEEDED).replace('.', '\\.')}, and 1 KB is free\\)`)],
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
      assert.match(message, /\. Nothing was removed\. Click Uninstall to try again\.$/, `${name}: ${message}`);
      assertNothingRemoved(fx, calls, name);
      assert.deepEqual(tars(fx), [], name);
    } finally {
      fx.cleanup();
    }
  }
});

test('space (a): exactly enough free space for the estimated copy lets Uninstall go on', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const d = deps(fx, calls);
    d.state.free = NEEDED;
    const result = await uninstallRuntimeInDistro(d);
    assert.equal(result.removedLinux, true);
    assert.equal(exportCalls(calls).length, 1);
    assert.deepEqual(unregisterCalls(calls), [['wsl', ['--unregister', 'ElastOS']]]);
    // Measured and checked twice: before Stop, and again right before the copy.
    assert.equal(calls.filter((call) => call === 'used').length, 2);
    assert.equal(calls.filter((call) => call === 'free').length, 2);
    assert.equal(exportNeededBytes(1000), 1000 + 100 + 64 * 1024 * 1024);
  } finally {
    fx.cleanup();
  }
});

test('space (b): too little free space for the estimated copy is refused before Stop, with a plain message', POSIX, async () => {
  for (const [free, said] of [[1e9, '1.0 GB'], [NEEDED - 1, plainBytes(NEEDED - 1)]]) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls);
      d.state.free = free;
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => {
        assert.equal(err.message, `ElastOS was not uninstalled. There is not enough free space for a copy of the whole ElastOS Linux environment. It needs about ${plainBytes(NEEDED)}, and ${said} is free. Nothing was removed. Free some space, then click Uninstall.`);
        return true;
      });
      assert.deepEqual(calls, ['wsl-list', 'python', 'inspect', 'used', 'free'], String(free));
      assert.deepEqual(wslCalls(calls, '--terminate'), [], String(free));
      assert.deepEqual(exportCalls(calls), [], String(free));
      assertNothingRemoved(fx, calls, String(free));
      assert.deepEqual(tars(fx), [], String(free));
    } finally {
      fx.cleanup();
    }
  }
});

test('space (c): free space that drops, or a size that grows, after the question is refused before the copy', POSIX, async () => {
  const cases = [
    ['free space drops by one byte too many', (d) => { d.state.free = NEEDED - 1; }, `It needs about ${plainBytes(NEEDED)}, and ${plainBytes(NEEDED - 1)} is free`],
    ['the environment grows', (d) => { d.state.free = NEEDED; d.state.used = USED + 1; }, `It needs about ${plainBytes(exportNeededBytes(USED + 1))}, and ${plainBytes(NEEDED)} is free`],
  ];
  for (const [name, change, said] of cases) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls);
      d.state.free = NEEDED;
      d.confirmRemoval = async (prompt) => { calls.push(['confirm', prompt]); change(d); return true; };
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => {
        assert.equal(err.message, `ElastOS was not uninstalled. It could not save a copy of its whole Linux environment (There is not enough free space for a copy of the whole ElastOS Linux environment. ${said}). Nothing was removed. Click Uninstall to try again.`, name);
        return true;
      });
      assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'confirm'), name);
      assert.deepEqual(wslCalls(calls, '--terminate'), [], name);
      assert.deepEqual(exportCalls(calls), [], name);
      assertNothingRemoved(fx, calls, name);
      assert.deepEqual(tars(fx), [], name);
    } finally {
      fx.cleanup();
    }
  }
});

test('without a yes to the second question, nothing is saved, unregistered, or removed', POSIX, async () => {
  for (const answer of [false, undefined, 'yes', 1, null]) {
    const fx = cleanDistro();
    try {
      const calls = [];
      const d = deps(fx, calls, { deps: { confirmRemoval: async () => answer } });
      await assert.rejects(() => uninstallRuntimeInDistro(d), (err) => {
        assert.equal(err.message, 'ElastOS was not uninstalled. Nothing was removed. Click Start to use ElastOS again.');
        return true;
      });
      assert.deepEqual(exportCalls(calls), [], String(answer));
      assertNothingRemoved(fx, calls, String(answer));
    } finally {
      fx.cleanup();
    }
  }
});

test('Uninstall never offers or writes a data zip, even with the old answer and copy functions handed in; Reset still offers its zip', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    const trap = (name) => async () => { calls.push(`trap:${name}`); throw new Error(`${name} must not run`); };
    // The old Uninstall shape: an answer and the copy functions. None of them may be used.
    const d = { ...deps(fx, calls), backup: true, checkBackupSpace: trap('checkBackupSpace'), saveBackup: trap('saveBackup') };
    const result = await uninstallRuntimeInDistro(d);
    assert.equal(result.removedLinux, true);
    assert.equal('backupPath' in result, false);
    assert.deepEqual(calls.filter((call) => typeof call === 'string' && (call.startsWith('trap:') || call === 'measure' || call === 'zip')), []);
    assert.deepEqual(fs.readdirSync(backups(fx)).filter((name) => !name.endsWith('.tar')), []);
    // Any answer, or none, is the same Uninstall: the answer is not read.
    for (const backup of [undefined, false, 'true', null]) {
      const again = cleanDistro();
      try {
        const seen = [];
        const r = await uninstallRuntimeInDistro({ ...deps(again, seen), backup });
        assert.equal(r.removedLinux, true, String(backup));
        assert.equal(seen.includes('zip'), false, String(backup));
      } finally {
        again.cleanup();
      }
    }
  } finally {
    fx.cleanup();
  }
  // The window: only Reset loads the copy offer and sends an answer; Uninstall sends nothing.
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const uninstallClick = app.slice(app.indexOf("uninstallBtn.addEventListener('click'"), app.indexOf("removePc2Btn.addEventListener('click'"));
  assert.equal(/loadBackupOffer|resetBackup/.test(uninstallClick), false);
  assert.match(app, /await loadBackupOffer\('reset'\);/);
  assert.equal((app.match(/loadBackupOffer\(/g) || []).length, 2);
  assert.match(app, /function syncResetButton\(\) \{\n  if \(confirmMode !== 'reset'\) return;/);
  assert.match(app, /const result = await window\.elastos\.uninstall\(\);/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8');
  assert.match(preload, /uninstall: \(\) => ipcRenderer\.invoke\('elastos:uninstall'\),/);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\('elastos:uninstall', \(\) => \{/);
  const src = fs.readFileSync(path.join(__dirname, '../src/main/targets/windowsUninstall.ts'), 'utf8');
  assert.equal(/saveBackup|checkBackupSpace|writeDistroBackup|runBackupWorker|deps\.backup/.test(src), false);

  // Reset on Windows still needs the answer, and with yes it writes the data zip.
  const rx = cleanDistro();
  try {
    const run = localRun([]);
    const resetDeps = {
      backup: true,
      homeDir: rx.winHome,
      platform: 'linux',
      env: {},
      paths: rx.paths,
      stop: async () => {},
      distroPresent: async () => true,
      pythonPresent: async () => true,
      inspect: () => inspectDistro(run, rx.paths),
      maintainerDid: DID,
      saveBackup: () => writeDistroBackup({ run, paths: rx.paths, home: rx.winHome, platform: 'linux', restrict: () => {}, freeBytes: () => 1e12 }),
      removeInDistro: (plan) => removeInDistro(run, rx.paths, plan),
      removeHost: (target) => removeVerifiedTarget(target),
    };
    await assert.rejects(() => resetRuntimeInDistro({ ...resetDeps, backup: undefined }), (err) => err.message === RESET_CHOICE_MESSAGE);
    const reset = await resetRuntimeInDistro(resetDeps);
    assert.match(path.basename(reset.backupPath), /^ElastOS-data-.*\.zip$/);
    assert.ok(readStoredZipEntries(reset.backupPath).some((entry) => entry.name === 'elastos/Users/alice/notes.txt'));
  } finally {
    rx.cleanup();
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
    const input = { home: fx.winHome, usedBytes: async () => 2.5e9, freeBytes: () => 1e12, now };
    const plan = await planDistroExport(input);
    assert.deepEqual(plan, { file: path.join(backups(fx), 'ElastOS-linux-20261018-120000Z-2.tar'), estimatedBytes: 2.5e9 });
    assert.match(uninstallPrompt(plan).detail, /\nEstimated size: about 2\.5 GB\. This is an estimate, not the exact size\. The file can be several GB\.\n/);
    const { file: saved, bytes } = await exportDistroToBackups({
      ...input, plan, dataDir: fx.paths.dataDir, platform: 'linux', restrict: () => {}, runWsl: d.runWsl,
    });
    assert.equal(saved, plan.file);
    assert.equal(bytes, 2048);
    assert.equal(linuxCopyMessage(saved, bytes).includes(`in ${saved}. The file is ${plainBytes(2048)}.`), true);
    // The size of the real copy on Windows (run 39085928916), in decimal GB.
    assert.equal(linuxCopyMessage(saved, 1646233600).includes(`in ${saved}. The file is 1.6 GB.`), true);
    assert.equal(fs.readFileSync(path.join(backups(fx), 'ElastOS-linux-20261018-120000Z.tar'), 'utf8'), 'older copy');
    assert.deepEqual(calls.map((call) => call[1]), [wslTerminateArgs(), wslExportArgs(saved)]);
    // A file that appears at the planned name after the question is never replaced: nothing runs.
    const late = await planDistroExport({ ...input, now: new Date(Date.UTC(2026, 9, 18, 13, 0, 0)) });
    fs.writeFileSync(late.file, 'made after the question');
    const before = calls.length;
    await assert.rejects(() => exportDistroToBackups({ ...input, plan: late, dataDir: fx.paths.dataDir, platform: 'linux', restrict: () => {}, runWsl: d.runWsl }), /The file for the copy changed/);
    assert.equal(calls.length, before);
    assert.equal(fs.readFileSync(late.file, 'utf8'), 'made after the question');
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

test('python3 missing in the distro: Uninstall says so in Uninstall words', POSIX, async () => {
  const fx = cleanDistro();
  try {
    const calls = [];
    await assert.rejects(
      () => uninstallRuntimeInDistro({ ...deps(fx, calls), pythonPresent: async () => { calls.push('python'); return false; } }),
      (err) => err.message === 'ElastOS was not uninstalled, because the program python3 is missing from its Linux environment, and Uninstall needs it. Nothing was deleted. Click Install to add python3 again, then click Uninstall.',
    );
    assert.deepEqual(calls, ['wsl-list', 'python']);
  } finally {
    fx.cleanup();
  }
});

test('the Windows Uninstall window says what happens, the main process asks the second question, and wsl.exe runs with no shell', () => {
  const copy = flow.confirmCopy('runtime', [], true);
  assert.match(copy.body, /the Linux environment named ElastOS, with the ElastOS program and all your ElastOS data in it/);
  assert.match(copy.body, /Next, ElastOS asks you one more time, and shows the file where it will save the whole Linux environment before it removes anything\./);
  assert.equal(/copy of your data/.test(copy.body), false);
  assert.equal(flow.confirmCopy('runtime', [], false).body, 'This removes the ElastOS program and its data from this computer.');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(app, /if \(result && result\.linuxCopyMessage\) addLog\(result\.linuxCopyMessage\);/);
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
