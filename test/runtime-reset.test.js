const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeVerifiedTarget, resetRuntime, sweepRemovalHoldings } = require('../dist/main/targets/runtimeUninstall');
const { foreignRuntimeDataMessage, launcherOwnedDirectories, signedInstallRecord } = require('../dist/main/targets/runtimePaths');
const { ForeignGatewayError } = require('../dist/main/targets/runtimeGateway');
const flow = require('../src/renderer/flow.js');

test('reset removes the runtime program, data, and unfinished install', async () => {
  const removed = [];
  const calls = [];
  await resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => { calls.push('stop'); },
    remove: (target) => {
      calls.push(target);
      removed.push(target);
    },
  });
  assert.deepEqual(calls, [
    'stop',
    '/home/tester/.local/bin/elastos',
    '/home/tester/.local/share/elastos',
    '/home/tester/.elastos-launcher/install-stage.json',
    '/home/tester/.elastos-launcher/resume-install.json',
    '/home/tester/.elastos-launcher/resume-install.json.lock',
  ]);
  assert.deepEqual(removed, calls.slice(1));
});

test('a dotted account name is still a launcher path', async () => {
  assert.equal(launcherOwnedDirectories('/Users/jane.doe/.local/bin/elastos', '/Users/jane.doe', 'darwin', {}), true);
  assert.equal(launcherOwnedDirectories('/home/jane.doe/.local/share/elastos', '/home/jane.doe', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('/Users/jane.doe/Library/Application Support/elastos', '/Users/jane.doe', 'darwin', {}), true);
  assert.equal(launcherOwnedDirectories('C:/Users/jane.doe/Desktop/ElastOS-support.txt', 'C:/Users/jane.doe', 'win32', {}), true);
  assert.equal(launcherOwnedDirectories('/home/jane.doe/.local/share/elastos/host-process.lock', '/home/jane.doe', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('/home/jane.doe/.elastos-launcher/install-stage.json', '/home/jane.doe', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('/home/jane.doe/ElastOS-support.txt', '/home/jane.doe', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('/home/jane.doe/.pc2/note', '/home/jane.doe', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/home/tester/.other/elastos', '/home/tester', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('C:/Users/tester/.other/elastos', 'C:/Users/tester', 'win32', {}), false);
  assert.equal(launcherOwnedDirectories('/usr/local/bin/elastos', '/home/tester', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/home/u/Documents/elastos', '/home/u', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/home/tester/../tester/.local/bin/elastos', '/home/tester', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/home/tester/.LOCAL/bin/elastos', '/home/tester', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/Users/Jane.Doe/.local/bin/elastos', '/Users/jane.doe', 'darwin', {}), true);
  assert.equal(launcherOwnedDirectories('/root/.local/bin/elastos', '/root', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('/var/home/u/.local/bin/elastos', '/var/home/u', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('D:/Profiles/u/.local/bin/elastos', 'D:/Profiles/u', 'win32', {}), true);
  assert.equal(launcherOwnedDirectories('home/u/.local/bin/elastos', '/home/u', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/home/other/.local/bin/elastos', '/home/tester', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/home/tester/.xdg/elastos', '/home/tester', 'linux', { XDG_DATA_HOME: '/home/tester/.xdg' }), false);
  assert.equal(launcherOwnedDirectories('/home/tester/elastos', '/home/tester', 'linux', { XDG_DATA_HOME: '/home/tester' }), false);
  assert.equal(launcherOwnedDirectories('/home/tester/Documents/elastos', '/home/tester', 'linux', { XDG_DATA_HOME: '/home/tester/Documents' }), false);
  assert.equal(launcherOwnedDirectories('/home/tester/xdg/elastos', '/home/tester', 'linux', { XDG_DATA_HOME: 'xdg' }), false);
  assert.equal(launcherOwnedDirectories('/home/t2/.local/share/elastos', '/home/t', 'linux', {}), false);
  assert.equal(launcherOwnedDirectories('/home/tester/.elastos-launcher/resume-install.json', '/home/tester', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('/home/tester/.elastos-launcher/resume-install.json.lock', '/home/tester', 'linux', {}), true);
  assert.equal(launcherOwnedDirectories('/var/lib/elastos', '/home/tester', 'linux', { XDG_DATA_HOME: '/var/lib' }), false);
  assert.equal(launcherOwnedDirectories('/home/tester/.local/share/elastos', '/home/tester', 'linux', { XDG_DATA_HOME: '/var/lib' }), true);

  const removed = [];
  await resetRuntime({
    binary: '/home/jane.doe/.local/bin/elastos',
    dataDir: '/home/jane.doe/.local/share/elastos',
    stageFile: '/home/jane.doe/.elastos-launcher/install-stage.json',
    homeDir: '/home/jane.doe',
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove: (target) => { removed.push(target); },
  });
  assert.deepEqual(removed, [
    '/home/jane.doe/.local/bin/elastos',
    '/home/jane.doe/.local/share/elastos',
    '/home/jane.doe/.elastos-launcher/install-stage.json',
    '/home/jane.doe/.elastos-launcher/resume-install.json',
    '/home/jane.doe/.elastos-launcher/resume-install.json.lock',
  ]);
});

test('reset refuses a foreign directory, a live foreign host, and a misnamed stage file', async () => {
  const remove = () => { throw new Error('should not remove'); };
  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.other/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove,
  }), /not the ElastOS data directory/);

  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => {
      throw new ForeignGatewayError();
    },
    remove,
  }), /another window/);

  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    stageFile: '/home/tester/.elastos-launcher/install-stage.json',
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => {
      throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
    },
    remove,
  }), (err) => {
    assert.match(err.message, /did not start it/);
    assert.equal(/another window/.test(err.message), false);
    return true;
  });

  await assert.rejects(() => resetRuntime({
    binary: '/home/tester/.local/bin/elastos',
    dataDir: '/home/tester/.local/share/elastos',
    stageFile: '/home/tester/.elastos-launcher/secrets.txt',
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => { throw new Error('stop should not run'); },
    remove,
  }), /install stage/);

  const copy = flow.resetCopy();
  assert.equal(copy.title, 'Reset ElastOS?');
  assert.match(copy.body, /install it again/);
  assert.equal(/terminal|sudo|powershell/i.test(copy.body), false);
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(html, /id="reset-btn"/);
  assert.match(app, /resetRuntime/);
  assert.match(app, /resetCopy/);
});

test('reset refuses a symlink and a dotted foreign directory', async () => {
  const binary = '/home/tester/.local/bin/elastos';
  const data = '/home/tester/.local/share/elastos';
  const stage = '/home/tester/.elastos-launcher/install-stage.json';
  const removed = [];
  await assert.rejects(() => resetRuntime({
    binary,
    dataDir: data,
    stageFile: stage,
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove: (target) => { removed.push(target); },
    lstat: (file) => ({
      isSymbolicLink: () => file === '/home/tester/.local',
      dev: 1,
      ino: 1,
    }),
  }), /symlink/);
  assert.deepEqual(removed, []);

  await assert.rejects(() => resetRuntime({
    binary: '/usr/local/bin/elastos',
    dataDir: '/home/u/Documents/elastos',
    stageFile: stage,
    homeDir: '/home/u',
    platform: 'linux',
    env: {},
    stop: async () => { throw new Error('stop should not run'); },
    remove: (target) => { removed.push(target); },
  }), /not the ElastOS data directory/);

  await assert.rejects(() => resetRuntime({
    binary,
    dataDir: 'C:/Users/tester/.other/elastos',
    stageFile: stage,
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => { throw new Error('stop should not run'); },
    remove: (target) => { removed.push(target); },
  }), /not the ElastOS data directory/);
  assert.deepEqual(removed, []);

  const inspected = [];
  await assert.rejects(() => resetRuntime({
    binary,
    dataDir: data,
    stageFile: stage,
    homeDir: '/home/tester',
    platform: 'linux',
    env: {},
    stop: async () => {},
    remove: (target) => { removed.push(target); },
    lstat: (file) => {
      inspected.push(file);
      const error = new Error('permission');
      error.code = 'EACCES';
      throw error;
    },
  }), /could not be inspected/);
  assert.deepEqual(removed, []);
});

test('real home names are owned and a real symlink is not followed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-owned-'));
  try {
    const spaced = path.join(root, 'John Smith');
    const unicode = path.join(root, 'José García');
    fs.mkdirSync(spaced);
    fs.mkdirSync(unicode);
    assert.equal(launcherOwnedDirectories(path.join(spaced, '.local', 'bin', 'elastos'), spaced, 'linux', {}), true);
    assert.equal(launcherOwnedDirectories(path.join(unicode, '.local', 'share', 'elastos'), unicode, 'linux', {}), true);
    assert.equal(launcherOwnedDirectories(path.join(spaced, '.local', 'bin', 'elastos'), unicode, 'linux', {}), false);
    assert.equal(launcherOwnedDirectories(path.join(root, '.local', 'bin', 'elastos'), root, 'linux', {}), true);

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'SECRET');
    fs.symlinkSync(outside, path.join(spaced, '.local'));
    const removed = [];
    await assert.rejects(() => resetRuntime({
      binary: path.join(spaced, '.local', 'bin', 'elastos'),
      dataDir: path.join(spaced, '.local', 'share', 'elastos'),
      stageFile: path.join(spaced, '.elastos-launcher', 'install-stage.json'),
      homeDir: spaced,
      platform: 'linux',
      env: {},
      stop: async () => {},
      remove: (target) => { removed.push(target); },
    }), /symlink/);
    assert.deepEqual(removed, []);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'SECRET');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an XDG data directory with only partial-install files is owned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-xdg-'));
  try {
    const home = path.join(root, 'home');
    const data = path.join(home, 'Documents', 'elastos');
    fs.mkdirSync(data, { recursive: true });
    const env = { XDG_DATA_HOME: path.join(home, 'Documents') };
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), true);
    const lock = path.join(data, 'host-process.lock');
    fs.symlinkSync(path.join(root, 'missing'), lock);
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
    fs.rmSync(lock);
    fs.writeFileSync(lock, '{}\n');
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), true);
    fs.rmSync(lock);
    fs.writeFileSync(path.join(data, 'components.json'), '{}\n');
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), true);
    assert.equal(launcherOwnedDirectories(path.join(home, '.local', 'share', 'elastos'), home, 'linux', env), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SIGNED_HEAD = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-head-0.8.0-alpha.22.json'));

/** The layout a real 0.8.0-alpha.22 install and one gateway start left in a custom XDG folder. */
function realXdgInstall(data) {
  for (const dir of ['AppCapsules', 'ElastOS/System/Auth', 'Local', 'MyWebSite', 'Public', 'Users', 'UsersAI',
    'capability_store', 'gateway-cache', 'identity', 'installation', 'namespaces', 'capsules', 'bin']) {
    fs.mkdirSync(path.join(data, dir), { recursive: true });
  }
  for (const file of ['ca.key', 'ca.pem', 'tls.key', 'tls.pem', 'tls.ips', 'signing_key', 'sources.json',
    'gateway-runtime-ownership.lock', 'identity/device.key', 'installation/release.json']) {
    fs.writeFileSync(path.join(data, file), 'x');
  }
  fs.writeFileSync(path.join(data, 'host-process.lock'), JSON.stringify({ pid: 13608, role: 'gateway', addr: '127.0.0.1:8090' }));
  fs.writeFileSync(path.join(data, 'components.json'), JSON.stringify({ components: { home: {} } }));
  fs.writeFileSync(path.join(data, 'installation', 'release-head.json'), SIGNED_HEAD);
}

function resetDeps(home, data, env, removed) {
  const binary = path.join(home, '.local', 'bin', 'elastos');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');
  return {
    binary,
    dataDir: data,
    stageFile: path.join(home, '.elastos-launcher', 'install-stage.json'),
    homeDir: home,
    platform: 'linux',
    env,
    stop: async () => {},
    remove: (target) => { removed.push(target); },
  };
}

const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a real custom XDG install with a signed install record is reset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-xdg-real-'));
  try {
    const home = path.join(root, 'home');
    const data = path.join(home, 'custom', 'elastos');
    const env = { XDG_DATA_HOME: path.join(home, 'custom') };
    realXdgInstall(data);
    assert.equal(signedInstallRecord(data), true);
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), true);
    const removed = [];
    await resetRuntime(resetDeps(home, data, env, removed));
    assert.equal(removed.includes(data), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a custom XDG reset leaves user files beside a signed install record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-xdg-user-'));
  try {
    const home = path.join(root, 'home');
    const data = path.join(home, 'custom', 'elastos');
    const env = { XDG_DATA_HOME: path.join(home, 'custom') };
    realXdgInstall(data);
    const thesis = path.join(data, 'Documents', 'thesis.docx');
    fs.mkdirSync(path.dirname(thesis), { recursive: true });
    fs.writeFileSync(thesis, 'keep');
    fs.writeFileSync(path.join(data, 'notes.txt'), 'keep');
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
    const refused = [];
    await assert.rejects(
      () => resetRuntime(resetDeps(home, data, env, refused)),
      new RegExp(`will not reset ${quote(data)} because it contains files that are not part of the runtime: Documents, notes\\.txt\\.`),
    );
    assert.deepEqual(refused, []);
    assert.equal(fs.readFileSync(thesis, 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(data, 'notes.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lock, a components manifest, or a forged install record does not prove a custom XDG folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-xdg-forged-'));
  try {
    const home = path.join(root, 'home');
    const data = path.join(home, 'custom', 'elastos');
    const env = { XDG_DATA_HOME: path.join(home, 'custom') };
    const unproved = new RegExp(`will not reset ${quote(data)} because it has no signed ElastOS install record`);
    // The markers that used to be enough: a gateway lock, a manifest, coordinates, and folders with runtime names.
    fs.mkdirSync(path.join(data, 'capsules'), { recursive: true });
    fs.mkdirSync(path.join(data, 'Users', 'me'), { recursive: true });
    fs.writeFileSync(path.join(data, 'Users', 'me', 'photo.jpg'), 'keep');
    fs.writeFileSync(path.join(data, 'host-process.lock'), JSON.stringify({ pid: 42, role: 'gateway', addr: '127.0.0.1:8090' }));
    fs.writeFileSync(path.join(data, 'components.json'), JSON.stringify({ components: { home: {} } }));
    fs.writeFileSync(path.join(data, 'runtime-coords.json'), '{}');
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
    const refused = [];
    await assert.rejects(() => resetRuntime(resetDeps(home, data, env, refused)), unproved);
    // A record whose payload was edited after signing.
    fs.mkdirSync(path.join(data, 'installation'));
    const head = JSON.parse(SIGNED_HEAD.toString('utf8'));
    head.payload.version = '0.8.0-alpha.99';
    fs.writeFileSync(path.join(data, 'installation', 'release-head.json'), JSON.stringify(head));
    assert.equal(signedInstallRecord(data), false);
    await assert.rejects(() => resetRuntime(resetDeps(home, data, env, refused)), unproved);
    // A record signed by a different key than the pinned maintainer.
    fs.writeFileSync(path.join(data, 'installation', 'release-head.json'), SIGNED_HEAD);
    assert.equal(signedInstallRecord(data, 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'), false);
    assert.equal(signedInstallRecord(data, null), false);
    // A real record reached through a link.
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'release-head.json'), SIGNED_HEAD);
    fs.rmSync(path.join(data, 'installation'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(data, 'installation'));
    assert.equal(signedInstallRecord(data), false);
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
    assert.deepEqual(refused, []);
    assert.equal(fs.readFileSync(path.join(data, 'Users', 'me', 'photo.jpg'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a source checkout or a publisher key in a custom XDG folder is refused by name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-xdg-checkout-'));
  try {
    const home = path.join(root, 'home');
    const data = path.join(home, 'code', 'elastos');
    const env = { XDG_DATA_HOME: path.join(home, 'code') };
    // A clone of the runtime repository has components.json and capsules/ too.
    realXdgInstall(data);
    for (const name of ['README.md', 'docs', '.git']) {
      if (name.includes('.')) fs.writeFileSync(path.join(data, name), 'x');
      else fs.mkdirSync(path.join(data, name));
    }
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
    assert.match(foreignRuntimeDataMessage(data, home, 'linux', env), /not part of the runtime: \.git, README\.md, docs\./);
    for (const name of ['README.md', 'docs', '.git']) fs.rmSync(path.join(data, name), { recursive: true });
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), true);
    fs.writeFileSync(path.join(data, 'release-key.hex'), 'secret');
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
    assert.match(foreignRuntimeDataMessage(data, home, 'linux', env), /not part of the runtime: release-key\.hex\./);
    fs.rmSync(path.join(data, 'release-key.hex'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(data, 'Public-link'));
    fs.rmSync(path.join(data, 'Public'), { recursive: true });
    fs.renameSync(path.join(data, 'Public-link'), path.join(data, 'Public'));
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a replacement between look and delete is not removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-swap-'));
  try {
    const target = path.join(root, 'elastos');
    const sibling = path.join(root, 'sibling.txt');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'old'), 'old');
    fs.writeFileSync(sibling, 'keep');
    removeVerifiedTarget(target);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep');
    removeVerifiedTarget(path.join(root, 'missing'));

    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'old'), 'old');
    assert.throws(() => removeVerifiedTarget(target, {
      beforeRename() {
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'secret'), 'SECRET');
      },
    }), /changed/);
    assert.equal(fs.readFileSync(path.join(target, 'secret'), 'utf8'), 'SECRET');

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'SECRET');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target);
    assert.throws(() => removeVerifiedTarget(target, {
      beforeRename() {
        fs.rmSync(target, { recursive: true, force: true });
        fs.symlinkSync(outside, target);
      },
    }), /changed|symlink/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'SECRET');

    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, 'original');
    assert.throws(() => removeVerifiedTarget(target, {
      beforeRename() {
        fs.rmSync(target);
        fs.writeFileSync(target, 'decoy');
      },
      afterHoldingCheck() {
        fs.writeFileSync(target, 'SECRET');
      },
    }), /changed/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'SECRET');
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.elastos-removing-')) fs.rmSync(path.join(root, name), { force: true });
    }

    fs.rmSync(target, { force: true });
    fs.mkdirSync(target);
    assert.throws(() => removeVerifiedTarget(target, {
      afterHoldingCheck() {
        const holding = fs.readdirSync(root).find((name) => name.startsWith('.elastos-removing-'));
        fs.rmSync(path.join(root, holding), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(root, holding));
      },
    }), /symlink|changed|inspected/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'SECRET');

    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('.elastos-removing-')) fs.rmSync(path.join(root, name), { force: true });
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target);
    assert.throws(() => removeVerifiedTarget(target, {
      remove() { throw new Error('disk full'); },
    }), /\.elastos-removing-[0-9]+-[0-9a-f]{16}-/);
    const leaked = fs.readdirSync(root).filter((name) => name.startsWith('.elastos-removing-'));
    assert.equal(leaked.length, 1);
    sweepRemovalHoldings(root);
    assert.equal(fs.existsSync(path.join(root, leaked[0])), false);

    const linked = path.join(root, '.elastos-removing-2147483646-aaaaaaaaaaaaaaaa-elastos');
    fs.symlinkSync(outside, linked);
    assert.throws(() => sweepRemovalHoldings(root), /could not finish removing/);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'SECRET');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweep removes only a dead holding this launcher wrote', () => {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-sweep-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const live = path.join(root, `.elastos-removing-${child.pid}-aaaaaaaaaaaaaaaa-elastos`);
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(root, 'sibling.txt'), 'keep');
    fs.writeFileSync(path.join(root, '.elastos-removing-notes'), 'keep');
    fs.mkdirSync(path.join(root, '.elastos-removing-2147483646-bbbbbbbbbbbbbbbb-notes.txt'));
    const dead = path.join(root, '.elastos-removing-2147483646-bbbbbbbbbbbbbbbb-elastos');
    fs.mkdirSync(dead);
    sweepRemovalHoldings(root);
    assert.equal(fs.existsSync(live), true);
    assert.equal(fs.existsSync(dead), false);
    assert.equal(fs.readFileSync(path.join(root, 'sibling.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(root, '.elastos-removing-notes'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(root, '.elastos-removing-2147483646-bbbbbbbbbbbbbbbb-notes.txt')), true);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a custom data directory with unknown files is refused by name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-xdg-foreign-'));
  try {
    const home = path.join(root, 'home');
    const data = path.join(home, 'custom', 'elastos');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'sources.json'), '{}\n');
    const env = { XDG_DATA_HOME: path.join(home, 'custom') };
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), true);
    fs.writeFileSync(path.join(data, 'notes.txt'), 'keep');
    assert.equal(launcherOwnedDirectories(data, home, 'linux', env), false);
    const removed = [];
    await assert.rejects(() => resetRuntime({
      binary: path.join(home, '.local', 'bin', 'elastos'),
      dataDir: data,
      stageFile: path.join(home, '.elastos-launcher', 'install-stage.json'),
      homeDir: home,
      platform: 'linux',
      env,
      stop: async () => {},
      remove: (target) => { removed.push(target); },
    }), new RegExp(`will not reset ${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} because it contains files`));
    assert.deepEqual(removed, []);
    assert.equal(fs.readFileSync(path.join(data, 'notes.txt'), 'utf8'), 'keep');

    fs.rmSync(path.join(data, 'notes.txt'));
    fs.rmSync(path.join(data, 'sources.json'));
    await resetRuntime({
      binary: path.join(home, '.local', 'bin', 'elastos'),
      dataDir: data,
      stageFile: path.join(home, '.elastos-launcher', 'install-stage.json'),
      homeDir: home,
      platform: 'linux',
      env,
      stop: async () => {},
      remove: (target) => { removed.push(target); },
    });
    assert.equal(removed.includes(data), true);

    await assert.rejects(() => resetRuntime({
      binary: path.join(home, '.local', 'bin', 'elastos'),
      dataDir: '/var/lib/elastos',
      stageFile: path.join(home, '.elastos-launcher', 'install-stage.json'),
      homeDir: home,
      platform: 'linux',
      env: { XDG_DATA_HOME: '/var/lib' },
      stop: async () => {},
      remove: () => { throw new Error('should not remove'); },
    }), /not the ElastOS data directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reset removes the resume lock and still deletes when a later sweep fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-reset-lock-'));
  try {
    const home = path.join(root, 'home');
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(home, '.elastos-launcher'), { recursive: true });
    const lock = path.join(home, '.elastos-launcher', 'resume-install.json.lock');
    fs.writeFileSync(lock, '{}\n');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'SECRET');
    fs.symlinkSync(outside, path.join(bin, '.elastos-removing-2147483646-aaaaaaaaaaaaaaaa-elastos'));
    const removed = [];
    await assert.rejects(() => resetRuntime({
      binary: path.join(bin, 'elastos'),
      dataDir: path.join(home, '.local', 'share', 'elastos'),
      stageFile: path.join(home, '.elastos-launcher', 'install-stage.json'),
      homeDir: home,
      platform: 'linux',
      env: {},
      stop: async () => {},
      remove: (target) => {
        removed.push(target);
        if (target === lock) fs.rmSync(target, { force: true });
      },
    }), /could not finish removing/);
    assert.equal(removed.includes(path.join(bin, 'elastos')), true);
    assert.equal(removed.includes(path.join(home, '.local', 'share', 'elastos')), true);
    assert.equal(removed.includes(lock), true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'SECRET');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows removal does not open a directory and does not use O_NOFOLLOW', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-win-rm-'));
  try {
    const opened = [];
    const open = (file, flags) => {
      opened.push(flags);
      return fs.openSync(file, flags);
    };
    const dir = path.join(root, 'elastos');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'components.json'), '{}\n');
    removeVerifiedTarget(dir, { platform: 'win32', open });
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(opened, []);

    const file = path.join(root, 'install-stage.json');
    fs.writeFileSync(file, '{}\n');
    removeVerifiedTarget(file, { platform: 'win32', open });
    assert.equal(fs.existsSync(file), false);
    assert.ok(opened.length > 0);
    for (const flags of opened) {
      assert.equal(flags, fs.constants.O_RDONLY);
      if (typeof fs.constants.O_NOFOLLOW === 'number') {
        assert.equal(flags & fs.constants.O_NOFOLLOW, 0);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
