const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const {
  clearLegacyPc2DescribeCache,
  describeLegacyPc2OnThisComputer,
  discoverLegacyPc2,
  isPc2DistroName,
  defaultUserDistro,
  legacyPc2DescribeRuns,
  parseWslDistroList,
  isPc2ServiceFile,
  pkexecPromptMessage,
  pkexecShouldTrySudo,
  privilegedRemovalScript,
  removeDiscoveredLegacyPc2,
  removeLegacyPc2,
  selectPc2Pids,
  sudoersIsPc2,
  withSupportBundle,
  wslRemovalArgs,
  zipCentralDirectoryFooter,
  zipDirectories,
  zipStoredSizeFields,
} = require('../dist/main/legacyPc2Removal');
const { runtimeBinaryPath, runtimeDataDir, runtimeInstallStagePath } = require('../dist/main/targets/runtimePaths');
const flow = require('../src/renderer/flow.js');

function enoent() {
  const error = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
}

function stat(type, size = 0) {
  return {
    isSymbolicLink: () => type === 'link',
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
    size,
  };
}

function world(home) {
  const nodes = new Map();
  function ensureParent(file) {
    const parent = path.dirname(file);
    const parentNode = nodes.get(parent);
    if (parentNode && parentNode.type === 'dir') {
      const name = path.basename(file);
      if (!parentNode.children.includes(name)) parentNode.children.push(name);
    }
  }
  return {
    nodes,
    dir(file) {
      nodes.set(file, { type: 'dir', size: 0, children: [], body: '' });
      ensureParent(file);
    },
    file(file, body) {
      nodes.set(file, { type: 'file', size: Buffer.byteLength(body), children: [], body });
      ensureParent(file);
    },
    link(file, target) {
      nodes.set(file, { type: 'link', size: 0, children: [], body: '', target });
      ensureParent(file);
    },
    probe() {
      return {
        home,
        platform: 'linux',
        env: {},
        lstat: (file) => {
          const node = nodes.get(file);
          if (!node) throw enoent();
          return stat(node.type, node.size);
        },
        realpath: (file) => {
          const node = nodes.get(file);
          if (!node) throw enoent();
          if (node.type === 'link') {
            if (!nodes.has(node.target)) throw enoent();
            return node.target;
          }
          return file;
        },
        readdir: (dir) => {
          const node = nodes.get(dir);
          if (!node || node.type !== 'dir') throw enoent();
          return node.children.slice();
        },
        readFile: (file) => {
          const node = nodes.get(file);
          if (!node) throw enoent();
          return node.body;
        },
      };
    },
  };
}

const AMNEZIA_SUDOERS = [
  'tester ALL=(ALL) NOPASSWD:SETENV: /usr/local/bin/awg-quick',
  'tester ALL=(ALL) NOPASSWD: /usr/bin/killall amneziawg-go',
  'tester ALL=(ALL) NOPASSWD: /bin/rm -rf /var/run/amneziawg/',
].join('\n');

function tracker(extra = {}) {
  const calls = [];
  return {
    calls,
    backup: false,
    downloadsDir: '/tmp/pc2-downloads',
    now: new Date('2026-10-16T10:08:00Z'),
    remove(file) {
      calls.push(['remove', file]);
    },
    async stop() {
      calls.push(['stop']);
    },
    async privilegedRemove(files) {
      calls.push(['privileged', files.slice()]);
    },
    zipDirectories(dirs, dest) {
      calls.push(['zip', dirs, dest]);
    },
    async unregisterDistro(name) {
      calls.push(['unregister', name]);
    },
    removeWslPath(distro, file) {
      calls.push(['wsl', distro, file]);
    },
    ...extra,
  };
}

function diskProbe(home) {
  return {
    home,
    platform: 'linux',
    env: {},
    lstat(file) {
      if (!file.startsWith(home)) throw enoent();
      return fs.lstatSync(file);
    },
    realpath(file) {
      return fs.realpathSync(file);
    },
    readdir(dir) {
      if (!dir.startsWith(home)) throw enoent();
      return fs.readdirSync(dir);
    },
    readFile(file) {
      if (!file.startsWith(home)) throw enoent();
      return fs.readFileSync(file, 'utf8');
    },
  };
}

test('refuses runtime paths, unknown paths, and the ElastOS distro', async () => {
  const home = '/home/tester';
  const box = world(home);
  box.dir(home);
  const runtime = [
    runtimeBinaryPath(home),
    runtimeDataDir('linux', home, {}),
    runtimeInstallStagePath(home),
  ];
  const act = tracker();
  for (const file of runtime) {
    const result = await removeDiscoveredLegacyPc2(
      [{ scope: 'user', path: file, label: 'runtime', bytes: 1 }],
      box.probe(),
      act,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /PC2 was not removed/);
    assert.match(result.message, /Refusing to remove ElastOS/);
  }

  for (const file of ['/etc/passwd', path.join(home, 'pc2.net'), '/etc/sudoers.d/other']) {
    const result = await removeDiscoveredLegacyPc2(
      [{ scope: 'user', path: file, label: 'unknown', bytes: 1 }],
      box.probe(),
      act,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /not part of the old PC2 install/);
  }

  const distro = await removeDiscoveredLegacyPc2(
    [{ scope: 'distro', path: 'ElastOS', label: 'distro', bytes: null, distro: 'ElastOS' }],
    box.probe(),
    act,
  );
  assert.match(distro.message, /Refusing to remove ElastOS/);

  const guest = await removeDiscoveredLegacyPc2(
    [{
      scope: 'wsl',
      path: '/home/user/.pc2',
      label: 'guest',
      bytes: 1,
      distro: 'ElastOS',
      wslHome: '/home/user',
    }],
    box.probe(),
    act,
  );
  assert.match(guest.message, /Refusing to remove ElastOS/);
  assert.deepEqual(act.calls, []);
  assert.equal(isPc2DistroName('ElastOS'), false);
  assert.equal(isPc2DistroName('PC2'), true);
  assert.equal(defaultUserDistro(parseWslDistroList('  NAME\n* ElastOS    Running\n  PC2        Stopped\n')), null);
  const legacy = require('../dist/main/legacyPc2Removal');
  assert.deepEqual(legacy.parseWslPc2Probe('PC2 4096\nNODE 12\n'), {
    pc2Bytes: 4096,
    nodeBytes: 12,
  });
  execFileSync('bash', ['-n', '-c', legacy.wslPc2ProbeScript()]);
});

test('refuses a symlink root and a symlink that escapes the PC2 folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc2-escape-'));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'keep-me');
  const linked = path.join(home, '.pc2');
  fs.symlinkSync(outside, linked);
  const act = tracker({
    remove(file) {
      this.calls.push(['remove', file]);
      fs.rmSync(file, { recursive: true, force: true });
    },
  });
  const rootResult = await removeLegacyPc2(diskProbe(home), act, [linked]);
  assert.equal(rootResult.ok, false);
  assert.match(rootResult.message, /symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'keep-me');
  assert.deepEqual(act.calls, []);

  fs.unlinkSync(linked);
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, 'note.txt'), 'mine');
  fs.symlinkSync(outside, path.join(linked, 'escape'));
  const nested = await removeLegacyPc2(diskProbe(home), act, [linked]);
  assert.equal(nested.ok, false);
  assert.match(nested.message, /symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'keep-me');
  assert.equal(fs.readFileSync(path.join(linked, 'note.txt'), 'utf8'), 'mine');
  assert.deepEqual(act.calls, []);
});

test('removal is idempotent and a partial failure is reported', async () => {
  const home = '/home/tester';
  const box = world(home);
  const pc2 = path.join(home, '.pc2');
  const sudoers = '/etc/sudoers.d/amneziawg';
  box.dir(home);
  box.dir(pc2);
  box.file(path.join(pc2, 'note.txt'), 'hello');
  box.file(sudoers, AMNEZIA_SUDOERS);

  const act = tracker({
    remove: (file) => {
      act.calls.push(['remove', file]);
      box.nodes.delete(file);
    },
    privilegedRemove: async () => {
      act.calls.push(['privileged', [sudoers]]);
      throw new Error('administrator permission was denied');
    },
  });
  const confirmed = [pc2, sudoers];
  const first = await removeLegacyPc2(box.probe(), act, confirmed);
  assert.equal(first.ok, false);
  assert.notEqual(first.message, 'PC2 removed');
  assert.match(first.message, /could not be fully removed/i);
  assert.match(first.message, /Still there: \/etc\/sudoers\.d\/amneziawg/);
  assert.match(first.message, /administrator permission was denied/);
  assert.deepEqual(first.removed, [pc2]);
  assert.equal(first.failed[0].path, sudoers);
  assert.deepEqual(act.calls.map((call) => call[0]), ['stop', 'remove', 'privileged']);
  assert.deepEqual(act.calls[2][1], [sudoers]);

  const second = await removeLegacyPc2(box.probe(), act, confirmed);
  assert.equal(second.ok, false);
  assert.match(second.message, /Still there/);

  box.nodes.delete(sudoers);
  const gone = await removeLegacyPc2(box.probe(), act, confirmed);
  assert.equal(gone.ok, true);
  assert.equal(gone.message, 'PC2 removed');
  assert.deepEqual(gone.removed, []);

  const stale = await removeDiscoveredLegacyPc2(
    [{ scope: 'user', path: pc2, label: 'PC2 folder', bytes: 0 }],
    box.probe(),
    act,
  );
  assert.equal(stale.ok, true);
  assert.equal(stale.message, 'PC2 removed');
});

test('lists only a real PC2 node tree and backs up the PC2 folder before deleting it', async () => {
  const home = '/home/tester';
  const box = world(home);
  const node = path.join(home, '.elastos', 'node');
  box.dir(home);
  box.dir(path.join(home, '.elastos'));
  box.dir(node);
  assert.deepEqual(discoverLegacyPc2(box.probe()).map((entry) => entry.path), []);

  const versionDir = path.join(node, 'node-v22.13.1-linux-x64');
  box.dir(versionDir);
  box.dir(path.join(versionDir, 'bin'));
  box.file(path.join(versionDir, 'bin', 'node'), 'node');
  const found = discoverLegacyPc2(box.probe());
  assert.deepEqual(found.map((entry) => entry.path), [node]);
  assert.equal(found[0].bytes, Buffer.byteLength('node'));

  const pc2 = path.join(home, '.pc2');
  box.dir(pc2);
  box.file(path.join(pc2, 'note.txt'), 'hello');
  const act = tracker({ backup: true });
  const probe = box.probe();
  const result = await removeLegacyPc2(probe, act, discoverLegacyPc2(probe).map((entry) => entry.path));
  assert.equal(result.ok, true);
  assert.equal(result.message, 'PC2 removed');
  assert.equal(act.calls[0][0], 'zip');
  assert.deepEqual(act.calls[0][1], [pc2]);
  assert.match(act.calls[0][2], /PC2-backup-20261016-100800Z\.zip$/);
  assert.equal(act.calls[1][0], 'stop');
  assert.ok(act.calls.slice(2).every((call) => call[0] === 'remove'));

  const copy = flow.legacyPc2Copy([
    { label: 'PC2 folder', path: pc2, bytes: 5 },
    { label: 'PC2 sudoers rule', path: '/etc/sudoers.d/amneziawg', bytes: null },
  ]);
  assert.equal(copy.title, 'Remove PC2?');
  assert.equal(copy.backup, 'Back up my PC2 data first');
  assert.equal(copy.done, 'PC2 removed');
  assert.match(copy.list, /PC2 folder — .*\/\.pc2 \(5 bytes\)/);
  assert.match(copy.list, /size unavailable/);
  assert.match(withSupportBundle(copy.done, '/home/tester/Desktop/ElastOS-support.txt'), /support bundle/);
});

test('backup zip stores PC2 files and does not follow a symlink outside them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc2-zip-'));
  const pc2 = path.join(root, '.pc2');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(pc2);
  fs.writeFileSync(path.join(pc2, 'note.txt'), 'hello');
  fs.writeFileSync(outside, 'SECRET-OUTSIDE');
  fs.symlinkSync(outside, path.join(pc2, 'escape'));
  const dest = path.join(root, 'Downloads', 'PC2-backup-test.zip');
  zipDirectories([pc2], dest);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  execFileSync('python3', ['-m', 'zipfile', '-t', dest], { encoding: 'utf8' });
  const listing = execFileSync('python3', ['-m', 'zipfile', '-l', dest], { encoding: 'utf8' });
  assert.match(listing, /\.pc2\/note\.txt/);
  assert.equal(listing.includes('escape'), false);
  assert.equal(listing.includes('SECRET-OUTSIDE'), false);
  const extracted = path.join(root, 'out');
  fs.mkdirSync(extracted);
  execFileSync('python3', ['-m', 'zipfile', '-e', dest, extracted]);
  assert.equal(fs.readFileSync(path.join(extracted, '.pc2', 'note.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SECRET-OUTSIDE');

  const footer = zipCentralDirectoryFooter(70000, 100, 0x100000000);
  assert.equal(footer.readUInt32LE(0), 0x06064b50);
  assert.equal(footer.readUInt32LE(footer.length - 22), 0x06054b50);
  const small = zipCentralDirectoryFooter(1, 10, 20);
  assert.equal(small.readUInt32LE(0), 0x06054b50);
  assert.equal(small.readUInt16LE(8), 1);
  const huge = zipStoredSizeFields(0x100000000);
  assert.equal(huge.version, 45);
  assert.equal(huge.sizeField, 0xffffffff);
  assert.equal(huge.extra.readUInt16LE(0), 0x0001);
});

test('the privileged prompt and the WSL removal stay on known PC2 paths', () => {
  const script = privilegedRemovalScript(['/etc/sudoers.d/amneziawg'], () => AMNEZIA_SUDOERS);
  assert.match(script, /rm -f -- '\/etc\/sudoers\.d\/amneziawg'/);
  assert.throws(() => privilegedRemovalScript(['/etc/sudoers.d/elastos']), /not part of the old PC2 install/);
  assert.throws(() => privilegedRemovalScript(['/usr/local/bin/sing-box']), /not part of the old PC2 install/);
  assert.throws(() => privilegedRemovalScript(['/etc/sudoers.d/../passwd']), /not part of the old PC2 install/);
  assert.throws(() => privilegedRemovalScript(['/etc/passwd']), /not part of the old PC2 install/);
  const injected = "/Library/LaunchDaemons/pc2'$(id).plist";
  const quoted = privilegedRemovalScript([injected]);
  assert.match(quoted, /pc2'\\''\$\(id\)\.plist'/);
  assert.equal(quoted.includes("$(id)"), true);
  execFileSync('bash', ['-n', '-c', quoted]);
  const wslArgs = wslRemovalArgs('Ubuntu', '/home/user/.pc2');
  assert.deepEqual(wslArgs.slice(0, 3), ['-d', 'Ubuntu', '--']);
  execFileSync('bash', ['-n', '-c', wslArgs[5]]);
  assert.throws(() => wslRemovalArgs('ElastOS', '/home/user/.pc2'), /Refusing to remove ElastOS/);
  assert.throws(() => wslRemovalArgs('Ubuntu', '/home/user/.local/share/elastos'), /not part of the old PC2 install/);
  assert.throws(() => wslRemovalArgs('Ubuntu', '/home/../.pc2'), /not part of the old PC2 install/);
  assert.throws(() => wslRemovalArgs('Ubuntu', '/home/./.pc2'), /not part of the old PC2 install/);
  const dottedAccount = wslRemovalArgs('Ubuntu', '/home/jane.doe/.pc2');
  assert.equal(dottedAccount[1], 'Ubuntu');
  assert.equal(dottedAccount[dottedAccount.length - 1], '/home/jane.doe/.pc2');
});

test('a shared PM2 unit is not removed as PC2', () => {
  const home = '/home/tester';
  const box = world(home);
  box.dir(home);
  box.dir('/etc/systemd/system');
  const shared = '/etc/systemd/system/pm2-root.service';
  const owned = '/etc/systemd/system/pc2.service';
  box.file(shared, '[Service]\nExecStart=/usr/bin/pm2 resurrect\n# mentions pc2-node\n');
  box.file(owned, '[Service]\nExecStart=/home/tester/.pc2/pc2-node\n');
  const found = discoverLegacyPc2(box.probe()).map((entry) => entry.path);
  assert.equal(found.includes(shared), false);
  assert.equal(found.includes(owned), true);
  assert.equal(isPc2ServiceFile('pm2-root.service', 'pc2-node .pc2'), false);
  assert.equal(isPc2ServiceFile('pc2.service', null), true);
  assert.throws(() => privilegedRemovalScript([shared], () => 'pc2'), /not part of the old PC2 install/);
});

test('pkexec exits 126 and 127 do not continue as sudo', () => {
  assert.equal(pkexecShouldTrySudo(126, ''), false);
  assert.equal(pkexecShouldTrySudo(127, 'ENOENT'), false);
  assert.equal(pkexecShouldTrySudo(1, ''), false);
  assert.equal(pkexecShouldTrySudo(null, 'ENOENT'), true);
  for (const status of [126, 127]) {
    const message = pkexecPromptMessage(status);
    assert.match(message, /administrator prompt could not be shown/);
    assert.match(message, new RegExp(`pkexec exited ${status}`));
    assert.match(message, /PC2 system files are still there/);
  }
});

test('PC2 process selection ignores the ElastOS runtime', () => {
  const pids = selectPc2Pids([
    { pid: 4, command: '/home/tester/.local/bin/elastos gateway' },
    { pid: 7, command: 'node /home/tester/.pc2/pc2-node/dist/index.js' },
    { pid: process.pid, command: 'node /home/tester/.pc2/pc2-node/dist/index.js' },
  ], process.pid);
  assert.deepEqual(pids, [7]);
});

test('Remove PC2 stays hidden until a legacy install is reported', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8');
  assert.match(html, /class="control-btn hidden" id="remove-pc2-btn"/);
  assert.match(html, /id="confirm-backup"/);
  assert.match(html, /Back up my PC2 data first/);
  assert.match(app, /describeLegacyPc2/);
  assert.match(app, /removeLegacyPc2\(backup, paths\)/);
  assert.match(app, /legacyConfirmPaths/);
  assert.match(app, /legacyItems\.length === 0/);
  assert.match(app, /confirmMode === 'pc2'/);
  assert.equal(main.includes('./targets'), false);
  assert.match(main, /elastos:describeLegacyPc2/);
  assert.match(main, /elastos:removeLegacyPc2/);
  assert.match(main, /withSupportBundle/);
  assert.match(preload, /describeLegacyPc2/);
  assert.match(preload, /elastos:removeLegacyPc2/);
  assert.equal(flow.primaryAction({ targetId: 'runtime', status: 'not-installed', busy: false }).label, 'Install');
});

test('sudoers and VPN programs are not PC2 just because of their names', async () => {
  assert.equal(sudoersIsPc2('/etc/sudoers.d/elastos', AMNEZIA_SUDOERS), false);
  assert.equal(sudoersIsPc2('/etc/sudoers.d/wireguard', 'tester ALL=(ALL) NOPASSWD: /usr/bin/apt'), false);
  assert.equal(sudoersIsPc2('/etc/sudoers.d/wireguard', 'tester ALL=(ALL) NOPASSWD: /usr/bin/wg-quick'), true);
  assert.equal(sudoersIsPc2('/etc/sudoers.d/amneziawg', AMNEZIA_SUDOERS), true);

  const home = '/home/tester';
  const box = world(home);
  box.dir(home);
  box.file('/etc/sudoers.d/wireguard', 'tester ALL=(ALL) NOPASSWD: /usr/bin/apt');
  box.file('/etc/sudoers.d/elastos', 'tester ALL=(ALL) NOPASSWD: /usr/bin/wg-quick');
  box.file('/usr/local/bin/sing-box', 'not-pc2');
  assert.deepEqual(discoverLegacyPc2(box.probe()), []);

  box.file('/etc/sudoers.d/amneziawg', AMNEZIA_SUDOERS);
  assert.deepEqual(discoverLegacyPc2(box.probe()).map((entry) => entry.path), []);

  const pc2 = path.join(home, '.pc2');
  box.dir(pc2);
  const found = discoverLegacyPc2(box.probe()).map((entry) => entry.path);
  assert.deepEqual(found, [pc2, '/etc/sudoers.d/amneziawg']);
  assert.equal(found.includes('/usr/local/bin/sing-box'), false);
  assert.equal(found.includes('/etc/sudoers.d/wireguard'), false);
  assert.equal(found.includes('/etc/sudoers.d/elastos'), false);
});

test('a WSL PC2 folder is not deleted when the requested backup cannot be taken', async () => {
  const home = '/home/tester';
  const box = world(home);
  box.dir(home);
  const probe = box.probe();
  probe.wsl = [{ distro: 'Ubuntu', home: '/home/u', pc2Bytes: 12, nodeBytes: null }];
  const items = discoverLegacyPc2(probe);
  assert.deepEqual(items.map((entry) => entry.path), ['/home/u/.pc2']);
  const act = tracker({ backup: true });
  const refused = await removeLegacyPc2(probe, act, items.map((entry) => entry.path));
  assert.equal(refused.ok, false);
  assert.equal(refused.backupPath, undefined);
  assert.match(refused.message, /backup/i);
  assert.equal(act.calls.some((call) => call[0] === 'wsl' || call[0] === 'remove'), false);

  const saved = tracker({
    backup: true,
    backupWslPath(distro, file, dest) {
      this.calls.push(['backup-wsl', distro, file, dest]);
    },
  });
  const removed = await removeLegacyPc2(probe, saved, ['/home/u/.pc2']);
  assert.equal(removed.ok, true);
  assert.match(removed.backupPath, /PC2-wsl-Ubuntu-backup-/);
  assert.deepEqual(saved.calls[0].slice(0, 3), ['backup-wsl', 'Ubuntu', '/home/u/.pc2']);
  assert.equal(saved.calls.some((call) => call[0] === 'wsl'), true);
});

test('a WSL distro is unregistered only after a PC2 marker, and a backup is required when asked', async () => {
  assert.equal(isPc2DistroName('pc2 '), false);
  assert.equal(isPc2DistroName('Pc2'), true);
  const home = '/home/tester';
  const box = world(home);
  box.dir(home);
  const probe = box.probe();
  probe.distroList = '  NAME\n* PC2    Running\n  pc2    Stopped\n';
  probe.provenDistros = [];
  assert.equal(discoverLegacyPc2(probe).some((entry) => entry.scope === 'distro'), false);
  const unnamed = tracker();
  const refused = await removeLegacyPc2(probe, unnamed, ['PC2', 'pc2 ']);
  assert.equal(refused.ok, false);
  assert.equal(unnamed.calls.some((call) => call[0] === 'unregister'), false);

  probe.provenDistros = ['PC2'];
  assert.deepEqual(discoverLegacyPc2(probe).map((entry) => entry.path), ['PC2']);
  const noExport = tracker({ backup: true });
  const missing = await removeLegacyPc2(probe, noExport, ['PC2']);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /backup/i);
  assert.equal(noExport.calls.some((call) => call[0] === 'unregister'), false);

  const exported = tracker({
    backup: true,
    async exportDistro(name, dest) {
      this.calls.push(['export', name, dest]);
    },
  });
  const removed = await removeLegacyPc2(probe, exported, ['PC2']);
  assert.equal(removed.ok, true);
  assert.match(removed.backupPath, /PC2-distro-PC2-backup-/);
  const kinds = exported.calls.map((call) => call[0]);
  assert.ok(kinds.indexOf('export') < kinds.indexOf('unregister'));
  assert.equal(exported.calls.find((call) => call[0] === 'unregister')[1], 'PC2');
});

test('removal deletes the confirmed paths and refuses a path that is no longer PC2', async () => {
  const home = '/home/tester';
  const box = world(home);
  const pc2 = path.join(home, '.pc2');
  const serviceDir = path.join(home, '.config', 'systemd', 'user');
  const service = path.join(serviceDir, 'pc2.service');
  box.dir(home);
  box.dir(path.join(home, '.config'));
  box.dir(path.join(home, '.config', 'systemd'));
  box.dir(serviceDir);
  box.dir(pc2);
  box.file(service, '[Service]\nExecStart=/usr/bin/pc2\n');
  const probe = box.probe();
  const before = discoverLegacyPc2(probe).map((entry) => entry.path);
  assert.deepEqual(before.sort(), [pc2, service].sort());
  const extra = path.join(serviceDir, 'pc2-extra.service');
  box.file(extra, '[Service]\nExecStart=/usr/bin/pc2\n');
  const act = tracker();
  const result = await removeLegacyPc2(probe, act, before);
  assert.equal(result.ok, true);
  const removed = act.calls.filter((call) => call[0] === 'remove').map((call) => call[1]);
  assert.deepEqual(removed.sort(), [pc2, service].sort());
  assert.equal(removed.includes(extra), false);

  box.dir(pc2);
  box.file('/etc/passwd', 'root:x:0:0:root:/root:/bin/bash');
  const blocked = tracker();
  const refusal = await removeLegacyPc2(box.probe(), blocked, [pc2, '/etc/passwd']);
  assert.equal(refusal.ok, false);
  assert.match(refusal.message, /not part of the old PC2 install/);
  assert.deepEqual(blocked.calls, []);

  const empty = tracker();
  const nothing = await removeLegacyPc2(box.probe(), empty, []);
  assert.equal(nothing.ok, true);
  assert.deepEqual(nothing.removed, []);
  assert.deepEqual(empty.calls, []);
});

test('describing PC2 does not block the main thread and is cached', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc2-describe-'));
  process.env.ELASTOS_PC2_PROBE_DELAY_MS = '500';
  clearLegacyPc2DescribeCache();
  try {
    let ticked = false;
    setTimeout(() => { ticked = true; }, 20);
    let settled = false;
    const pending = describeLegacyPc2OnThisComputer(home).then((items) => {
      settled = true;
      return items;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(ticked, true);
    assert.equal(settled, false);
    assert.deepEqual(await pending, []);
  } finally {
    delete process.env.ELASTOS_PC2_PROBE_DELAY_MS;
    clearLegacyPc2DescribeCache();
  }

  const runs = legacyPc2DescribeRuns();
  assert.deepEqual(await describeLegacyPc2OnThisComputer(home), []);
  assert.deepEqual(await describeLegacyPc2OnThisComputer(home), []);
  assert.equal(legacyPc2DescribeRuns(), runs + 1);
  clearLegacyPc2DescribeCache();
});
