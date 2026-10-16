const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const {
  discoverLegacyPc2,
  isPc2DistroName,
  defaultUserDistro,
  parseWslDistroList,
  privilegedRemovalScript,
  removeDiscoveredLegacyPc2,
  removeLegacyPc2,
  selectPc2Pids,
  withSupportBundle,
  wslRemovalArgs,
  zipDirectories,
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
  const rootResult = await removeLegacyPc2(diskProbe(home), act);
  assert.equal(rootResult.ok, false);
  assert.match(rootResult.message, /symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'keep-me');
  assert.deepEqual(act.calls, []);

  fs.unlinkSync(linked);
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, 'note.txt'), 'mine');
  fs.symlinkSync(outside, path.join(linked, 'escape'));
  const nested = await removeLegacyPc2(diskProbe(home), act);
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
  const sudoers = '/etc/sudoers.d/elastos';
  box.dir(home);
  box.dir(pc2);
  box.file(path.join(pc2, 'note.txt'), 'hello');
  box.file(sudoers, 'rule');

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
  const first = await removeLegacyPc2(box.probe(), act);
  assert.equal(first.ok, false);
  assert.notEqual(first.message, 'PC2 removed');
  assert.match(first.message, /could not be fully removed/i);
  assert.match(first.message, /Still there: \/etc\/sudoers\.d\/elastos/);
  assert.match(first.message, /administrator permission was denied/);
  assert.deepEqual(first.removed, [pc2]);
  assert.equal(first.failed[0].path, sudoers);
  assert.deepEqual(act.calls.map((call) => call[0]), ['stop', 'remove', 'privileged']);
  assert.deepEqual(act.calls[2][1], [sudoers]);

  const second = await removeLegacyPc2(box.probe(), act);
  assert.equal(second.ok, false);
  assert.match(second.message, /Still there/);

  box.nodes.delete(sudoers);
  const gone = await removeLegacyPc2(box.probe(), act);
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
  const result = await removeLegacyPc2(box.probe(), act);
  assert.equal(result.ok, true);
  assert.equal(result.message, 'PC2 removed');
  assert.equal(act.calls[0][0], 'zip');
  assert.deepEqual(act.calls[0][1], [pc2]);
  assert.match(act.calls[0][2], /PC2-backup-20261016-100800Z\.zip$/);
  assert.equal(act.calls[1][0], 'stop');
  assert.ok(act.calls.slice(2).every((call) => call[0] === 'remove'));

  const copy = flow.legacyPc2Copy([
    { label: 'PC2 folder', path: pc2, bytes: 5 },
    { label: 'PC2 sudoers rule', path: '/etc/sudoers.d/elastos', bytes: null },
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
  const listing = execFileSync('python3', ['-m', 'zipfile', '-l', dest], { encoding: 'utf8' });
  assert.match(listing, /\.pc2\/note\.txt/);
  assert.equal(listing.includes('SECRET-OUTSIDE'), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SECRET-OUTSIDE');
});

test('the privileged prompt and the WSL removal stay on known PC2 paths', () => {
  const script = privilegedRemovalScript(['/etc/sudoers.d/elastos', '/usr/local/bin/sing-box']);
  assert.match(script, /rm -f -- '\/etc\/sudoers\.d\/elastos'/);
  assert.match(script, /rm -f -- '\/usr\/local\/bin\/sing-box'/);
  assert.throws(() => privilegedRemovalScript(['/etc/passwd']), /not part of the old PC2 install/);
  const wslArgs = wslRemovalArgs('Ubuntu', '/home/user/.pc2');
  assert.deepEqual(wslArgs.slice(0, 3), ['-d', 'Ubuntu', '--']);
  execFileSync('bash', ['-n', '-c', wslArgs[5]]);
  assert.throws(() => wslRemovalArgs('ElastOS', '/home/user/.pc2'), /Refusing to remove ElastOS/);
  assert.throws(() => wslRemovalArgs('Ubuntu', '/home/user/.local/share/elastos'), /not part of the old PC2 install/);
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
  assert.match(app, /removeLegacyPc2/);
  assert.match(app, /legacyItems\.length === 0/);
  assert.match(app, /confirmMode === 'pc2'/);
  assert.equal(main.includes('./targets'), false);
  assert.match(main, /elastos:describeLegacyPc2/);
  assert.match(main, /elastos:removeLegacyPc2/);
  assert.match(main, /withSupportBundle/);
  assert.match(preload, /describeLegacyPc2/);
  assert.equal(flow.primaryAction({ targetId: 'runtime', status: 'not-installed', busy: false }).label, 'Install');
});
