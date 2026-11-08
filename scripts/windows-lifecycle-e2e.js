const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { clickMenu, trayState, noWindow } = require('./tray-e2e');
const { isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');
const { runtimeDataDir, runtimeUpdateCheckPath } = require('../dist/main/targets/runtimePaths');

async function health(wanted) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (isHealthOk(await probeGatewayHealth()) === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Home health did not become ${wanted}`);
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}


function proveLiveController() {
  const script = [
    'import json, os, stat',
    'LIMIT = 16384',
    'ROOT = "/root/.local/share/elastos"',
    'LOCK = ROOT + "/host-process.lock"',
    'DIRECTORY = ROOT + "/update-controller"',
    'STATUS = DIRECTORY + "/status.json"',
    'REQUEST = DIRECTORY + "/request.json"',
    'ACTIVE = DIRECTORY + "/active-request.json"',
    'def read_text(path):',
    '    current = ""',
    '    parts = path.strip("/").split("/")',
    '    info = None',
    '    for index, part in enumerate(parts):',
    '        current = current + "/" + part',
    '        info = os.lstat(current)',
    '        if stat.S_ISLNK(info.st_mode):',
    '            raise SystemExit("refusing a link at " + current)',
    '        if index == len(parts) - 1:',
    '            if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:',
    '                raise SystemExit("refusing " + path)',
    '    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)',
    '    try:',
    '        data = os.read(fd, LIMIT + 1)',
    '    finally:',
    '        os.close(fd)',
    '    if len(data) > LIMIT:',
    '        raise SystemExit("refusing " + path)',
    '    return data.decode("utf-8", "replace")',
    'def start_id(pid):',
    '    raw = read_text("/proc/%d/stat" % pid)',
    '    tail = raw.rsplit(")", 1)[1].split()',
    '    start = tail[19]',
    '    boot = read_text("/proc/sys/kernel/random/boot_id").strip()',
    '    if boot:',
    '        return "linux:%s:%s" % (boot, start)',
    '    return "linux:%s" % start',
    'def ppid_of(pid):',
    '    for line in read_text("/proc/%d/status" % pid).splitlines():',
    '        if line.startswith("PPid:"):',
    '            return int(line.split()[1])',
    '    raise SystemExit("no parent")',
    'def command_of(pid):',
    '    fd = os.open("/proc/%d/cmdline" % pid, os.O_RDONLY | os.O_NOFOLLOW)',
    '    try:',
    '        data = os.read(fd, LIMIT)',
    '    finally:',
    '        os.close(fd)',
    '    return data.replace(b"\\x00", b" ").decode("utf-8", "replace")',
    'status = json.loads(read_text(STATUS))',
    'lock = json.loads(read_text(LOCK))',
    'phase = status.get("phase")',
    'if phase not in ("ready", "updated", "restored", "failed"):',
    '    raise SystemExit("phase " + str(phase))',
    'controller = status.get("controller_pid")',
    'host = status.get("host_pid")',
    'if type(controller) is not int or type(host) is not int or controller <= 1 or host <= 1:',
    '    raise SystemExit("pid")',
    'if lock.get("pid") != host or lock.get("addr") != "localhost:8090":',
    '    raise SystemExit("lock")',
    'if not status.get("generation") or lock.get("generation") != status.get("generation"):',
    '    raise SystemExit("generation")',
    'if start_id(controller) != status.get("controller_start"):',
    '    raise SystemExit("controller is not the live process")',
    'if ppid_of(host) != controller:',
    '    raise SystemExit("host parent")',
    'controller_command = command_of(controller)',
    'host_command = command_of(host)',
    'if "update-controller/runtime" not in controller_command or "__update-controller" not in controller_command:',
    '    raise SystemExit("controller command")',
    'if "home" not in host_command or "--browser" not in host_command:',
    '    raise SystemExit("host command")',
    'if os.path.lexists(REQUEST) or os.path.lexists(ACTIVE):',
    '    raise SystemExit("queue is not empty")',
    'print(json.dumps({"phase": phase, "queue": "empty", "controller": controller, "host": host}))',
  ].join('\n');
  const result = spawnSync('wsl.exe', ['-d', 'ElastOS', '-u', 'root', '--', 'python3', '-'], {
    input: script,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'The update controller was not proved.').trim());
  }
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.queue, 'empty');
  assert.equal(['ready', 'updated', 'restored', 'failed'].includes(proof.phase), true);
  console.log(`PASS controller phase ${proof.phase} is live and the update queue is empty (controller ${proof.controller}, host ${proof.host})`);
  console.log('NOT RUN: a System update apply. No newer signed release exists, and apply needs an owner step-up token.');
}

function distroUpdateCheck() {
  const file = runtimeUpdateCheckPath(runtimeDataDir('linux', '/root', {}));
  const result = spawnSync('wsl.exe', ['-d', 'ElastOS', '-u', 'root', '--', 'cat', file], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ''} ${result.stdout || ''}`;
    if (!/No such file or directory/.test(detail)) {
      throw new Error(detail.trim() || 'The update check file could not be read.');
    }
    return null;
  }
  return JSON.parse(result.stdout);
}

function launcherUpdateCheck(home) {
  const file = path.join(home, '.elastos-launcher', 'update-check.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = async function (app, page, home) {
  await app.evaluate(({ shell }) => {
    global.__openedHome = [];
    shell.openExternal = async (url) => { global.__openedHome.push(url); };
  });
  await clickMenu(app, 'Open Home');
  assert.deepEqual(await app.evaluate(() => global.__openedHome), ['http://localhost:8090/home/']);
  const response = await fetch('http://localhost:8090/home/');
  assert.equal(response.status, 200);
  console.log('PASS Open Home invokes the browser with localhost:8090/home/ and Home returns HTTP 200');

  await noWindow(app);
  await health(true);
  await clickMenu(app, 'Stop Home');
  await trayState(app, 'stopped');
  await health(false);
  console.log('PASS Stop Home closes the listener');
  await clickMenu(app, 'Start Home');
  await trayState(app, 'running');
  await health(true);
  console.log('PASS Start Home becomes healthy');
  assert.deepEqual(await app.evaluate(() => global.__openedHome), ['http://localhost:8090/home/']);
  proveLiveController();
  const runtime = distroUpdateCheck();
  if (runtime) {
    assert.equal(runtime.outcome, 'up_to_date');
    assert.equal(runtime.offered, false);
    console.log('PASS elastos update --check keeps the Runtime up_to_date record');
  } else {
    const launcher = launcherUpdateCheck(home);
    assert.ok(launcher);
    assert.equal(launcher.outcome, 'up_to_date');
    assert.equal(launcher.offered, false);
    console.log('PASS elastos update --check stores up_to_date in the launcher record');
  }
  const closed = app.waitForEvent('close');
  await clickMenu(app, 'Quit ElastOS'); await closed;
  await health(false);
  console.log('PASS Quit ElastOS stops Home');
  return app;
};
