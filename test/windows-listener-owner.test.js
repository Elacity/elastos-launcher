const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WINDOWS_LISTENER_MAX_BYTES,
  WINDOWS_LISTENER_TIMEOUT_MS,
  confirmDistroGateway,
  createDistroGatewaySupervisor,
  decodeWindowsText,
  isWslForwarderImage,
  parseWindowsListenerTable,
  readWindowsListenerTable,
  windowsForwarderOwns,
  windowsListenerScript,
} = require('../dist/main/targets/windowsRuntime');
const { ALREADY_OWNS_TEXT, FOREIGN_LISTENER_MESSAGE, HOME_URL } = require('../dist/main/targets/runtimeGateway');

const ROOTS = ['C:\\Program Files'];
const RELAY = 'C:\\Program Files\\WSL\\wslrelay.exe';
const SERVICE = 'C:\\Program Files\\WSL\\wslservice.exe';
const PACKAGE = 'C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WindowsSubsystemForLinux_2.4.11.0_x64__8wekyb3d8bbwe\\wslrelay.exe';
const HEALTH = { status: 200, body: 'OK', addresses: ['127.0.0.1', '::1'] };

function row(address, image, pid = 10) {
  return { address, pid, image };
}

function relayPair(image = RELAY) {
  return [row('127.0.0.1', image, 10), row('::1', image, 10)];
}

test('a forwarder image is the installed wslrelay or wslservice binary', () => {
  assert.equal(isWslForwarderImage(RELAY, ROOTS), true);
  assert.equal(isWslForwarderImage(SERVICE, ROOTS), true);
  assert.equal(isWslForwarderImage(PACKAGE, ROOTS), true);
  assert.equal(isWslForwarderImage('C:\\Users\\me\\wslrelay.exe', ROOTS), false);
  assert.equal(isWslForwarderImage('C:\\Program Files\\WSL\\node.exe', ROOTS), false);
  assert.equal(isWslForwarderImage('wslrelay.exe', ROOTS), false);
});

test('Windows ownership refuses a foreign listener, a shadow, a native program, and an unreadable table', () => {
  const both = ['127.0.0.1', '::1'];
  assert.equal(windowsForwarderOwns(relayPair(), both, ROOTS), true);
  assert.equal(windowsForwarderOwns(relayPair(SERVICE), both, ROOTS), true);
  assert.equal(windowsForwarderOwns([
    row('127.0.0.1', RELAY, 10),
    row('::1', 'C:\\Program Files\\nodejs\\node.exe', 11),
  ], both, ROOTS), false);
  assert.equal(windowsForwarderOwns([
    row('127.0.0.1', RELAY, 10),
    row('127.0.0.1', 'C:\\Windows\\System32\\python.exe', 12),
    row('::1', RELAY, 10),
  ], both, ROOTS), false);
  assert.equal(windowsForwarderOwns([
    row('127.0.0.1', 'C:\\Windows\\System32\\python.exe', 12),
    row('::1', 'C:\\Windows\\System32\\python.exe', 12),
  ], both, ROOTS), false);
  assert.equal(windowsForwarderOwns(null, both, ROOTS), false);
  assert.equal(windowsForwarderOwns([], both, ROOTS), false);
  assert.equal(windowsForwarderOwns([row('127.0.0.1', RELAY)], both, ROOTS), false);
  assert.equal(windowsForwarderOwns([row('[::1]', RELAY), row('127.0.0.1', RELAY)], both, ROOTS), true);
  assert.equal(windowsForwarderOwns([row('0.0.0.0', RELAY), row('::1', 'C:\\Program Files\\nodejs\\node.exe', 11)], both, ROOTS), false);
});

test('the Windows listener command is bounded and names port 8090', async () => {
  assert.equal(windowsListenerScript(8090).includes('-LocalPort 8090'), true);
  assert.throws(() => windowsListenerScript(0), /Refusing to read/);
  let seen = null;
  const text = '127.0.0.1\t10\tC:\\Program Files\\WSL\\wslrelay.exe\r\n::1\t10\tC:\\Program Files\\WSL\\wslrelay.exe\r\n';
  const rows = await readWindowsListenerTable('win32', (file, args, timeout, max) => {
    seen = { file, args, timeout, max };
    return { code: 0, stdout: text };
  });
  assert.equal(seen.file, 'powershell.exe');
  assert.deepEqual(seen.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(seen.args[3].includes('-LocalPort 8090'), true);
  assert.equal(seen.timeout, WINDOWS_LISTENER_TIMEOUT_MS);
  assert.equal(seen.max, WINDOWS_LISTENER_MAX_BYTES);
  assert.deepEqual(rows, relayPair());
});

test('a non-Windows host and a failed read do not invent listeners', async () => {
  let called = false;
  assert.equal(await readWindowsListenerTable('darwin', () => { called = true; return { code: 0, stdout: '' }; }), null);
  assert.equal(called, false);
  assert.equal(await readWindowsListenerTable('win32', () => null), null);
  assert.equal(await readWindowsListenerTable('win32', () => ({ code: 1, stdout: '' })), null);
  assert.equal(await readWindowsListenerTable('win32', () => ({ code: 0, stdout: Buffer.alloc(WINDOWS_LISTENER_MAX_BYTES + 1) })), null);
  assert.equal(parseWindowsListenerTable('127.0.0.1 10 C:\\Program Files\\WSL\\wslrelay.exe'), null);
  assert.equal(parseWindowsListenerTable('127.0.0.1\t10\t'), null);
  const coded = decodeWindowsText(Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('127.0.0.1\t10\tC:\\Program Files\\WSL\\wslrelay.exe\n', 'utf16le'),
  ]));
  assert.deepEqual(parseWindowsListenerTable(coded), [row('127.0.0.1', RELAY)]);
});

function alreadyProc() {
  return {
    pid: 42,
    onOutput(fn) { fn(`${ALREADY_OWNS_TEXT}\n`); },
    onExit(fn) { fn(0); },
    hasExited() { return true; },
    signal() {},
    dispose() {},
  };
}

function liveProc() {
  return {
    pid: 42,
    onOutput() {},
    onExit() {},
    hasExited() { return false; },
    signal() {},
    dispose() {},
  };
}

function supervisor(listeners, options = {}) {
  const opened = [];
  let now = 0;
  const gateway = createDistroGatewaySupervisor({
    spawn: () => (options.already ? alreadyProc() : liveProc()),
    fetchHealth: async () => options.health ?? HEALTH,
    openUrl: (url) => { opened.push(url); },
    now: () => now,
    sleep: async () => { now += 150000; },
    foreignIsLegacy: async () => false,
    distroKind: async () => options.kind ?? 'elastos',
    readListeners: () => listeners,
    programFiles: ROOTS,
  });
  return { gateway, opened, started: gateway.start() };
}

test('a distro Home plus a foreign Windows ::1 listener does not open Home', async () => {
  const { opened, started } = supervisor([
    row('127.0.0.1', RELAY, 10),
    row('::1', 'C:\\Program Files\\nodejs\\node.exe', 11),
  ], { already: true });
  await assert.rejects(started, new RegExp(FOREIGN_LISTENER_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(opened, []);
});

test('a foreign Windows program on 127.0.0.1 does not open Home', async () => {
  const { opened, started } = supervisor([
    row('127.0.0.1', RELAY, 10),
    row('127.0.0.1', 'C:\\Windows\\System32\\python.exe', 12),
    row('::1', RELAY, 10),
  ]);
  await assert.rejects(started, /Another program is answering/);
  assert.deepEqual(opened, []);
});

test('a native Windows program alone does not open Home', async () => {
  const { opened, started } = supervisor([
    row('127.0.0.1', 'C:\\Windows\\System32\\python.exe', 12),
    row('::1', 'C:\\Windows\\System32\\python.exe', 12),
  ], { already: true, kind: 'other' });
  await assert.rejects(started, /Another program is answering/);
  assert.deepEqual(opened, []);
});

test('an unreadable Windows table does not open Home', async () => {
  const { opened, started } = supervisor(null);
  await assert.rejects(started, /Another program is answering/);
  assert.deepEqual(opened, []);
});

test('Home opens at localhost when every Windows listener is the forwarder', async () => {
  const { opened, started } = supervisor(relayPair(), { already: true });
  assert.equal(await started, 'already-running');
  assert.deepEqual(opened, [HOME_URL]);
});

test('a mirrored wslservice listener can become ready', async () => {
  const { gateway, opened, started } = supervisor(relayPair(SERVICE));
  assert.equal(await started, 'started');
  assert.equal(gateway.phase(), 'running');
  assert.deepEqual(opened, []);
});

test('status proof requires the distro and the Windows forwarder', async () => {
  assert.equal(await confirmDistroGateway({
    distroKind: async () => 'elastos',
    readListeners: () => relayPair(),
    programFiles: ROOTS,
    answered: ['127.0.0.1', '::1'],
  }), true);
  assert.equal(await confirmDistroGateway({
    distroKind: async () => 'elastos',
    readListeners: () => null,
    programFiles: ROOTS,
  }), false);
  assert.equal(await confirmDistroGateway({
    distroKind: async () => 'other',
    readListeners: () => relayPair(),
    programFiles: ROOTS,
  }), false);
});

test('Open on Windows refuses before the browser when the forwarder check fails', async (t) => {
  const windows = require('../dist/main/targets/windowsRuntime');
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  let calls = 0;
  t.mock.method(windows, 'confirmDistroGateway', async () => {
    calls += 1;
    return false;
  });
  const target = createRuntimeTarget('win32');
  await assert.rejects(() => target.openInBrowser(), /Another program is answering on port 8090\. Home was not adopted\./);
  assert.equal(calls, 1);
});

test('Open on Windows reaches the browser after the forwarder check', async (t) => {
  const windows = require('../dist/main/targets/windowsRuntime');
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  t.mock.method(windows, 'confirmDistroGateway', async () => true);
  const target = createRuntimeTarget('win32');
  await assert.rejects(() => target.openInBrowser(), (err) => {
    assert.equal(/Another program is answering/.test(err.message), false);
    assert.match(String(err.message), /Could not open your computer in the browser|Electron failed to install correctly/);
    return true;
  });
});
