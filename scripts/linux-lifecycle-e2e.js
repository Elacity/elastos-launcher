const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { clickMenu, trayState, noWindow } = require('./tray-e2e');
const { isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');

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


async function liveController(data) {
  const statusPath = path.join(data, 'update-controller', 'status.json');
  const deadline = Date.now() + 180000;
  let last = 'absent';
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      const pid = record.controller_pid;
      if (record.phase === 'ready' && Number.isInteger(pid) && pid > 0) {
        const command = Buffer.alloc(4096);
        const fd = fs.openSync(`/proc/${pid}/cmdline`, 'r');
        let bytes = 0;
        try {
          bytes = fs.readSync(fd, command, 0, command.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (command.subarray(0, bytes).includes('__update-controller')) return record;
        last = `pid ${pid} is not the update controller`;
      } else {
        last = `phase ${record.phase}`;
      }
    } catch (err) {
      last = err && err.code ? err.code : 'unread';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Home system update check did not reach a live controller (${last})`);
}


function portClosed(port, host) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (closed) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
  });
}

module.exports = async function (app, page, home, launch) {
  assert.equal(await app.evaluate(() => global.__elastosTray), true);
  console.log('PASS the tray icon is ready');

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

  const data = path.join(home, '.local', 'share', 'elastos');
  const controller = await liveController(data);
  assert.equal(controller.phase, 'ready');
  console.log('PASS Home system update check reaches the live controller');
  console.log('NOT EXERCISED a full System update because no newer signed release exists');
  console.log('NOT EXERCISED the owner System summary because that route needs a wallet token');

  const nativeUpdate = path.join(data, 'update-check.json');
  const update = JSON.parse(fs.readFileSync(fs.existsSync(nativeUpdate) ? nativeUpdate
    : path.join(home, '.elastos-launcher', 'update-check.json'), 'utf8'));
  assert.equal(update.outcome, 'up_to_date');
  console.log('PASS elastos update --check writes up_to_date');

  const stoppedPid = controller.controller_pid;
  const closed = app.waitForEvent('close');
  await clickMenu(app, 'Quit ElastOS'); await closed;
  await health(false);
  assert.equal(await portClosed(8090, '127.0.0.1'), true);
  assert.equal(await portClosed(8090, '::1'), true);
  assert.equal(fs.existsSync(`/proc/${stoppedPid}`), false);
  console.log('PASS Quit ElastOS stops Home and its controller');
  return app;
};
