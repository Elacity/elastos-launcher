const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyRuntimeUpdate,
  checkRuntimeUpdate,
  parseHeadCid,
  rollbackRuntime,
  UPDATE_STATUS_UNREADABLE,
} = require('../dist/main/targets/runtimeUpdate');
const { releaseHeadCid } = require('../dist/main/targets');

const { SIGNED_HEAD, FIXTURE_DID } = require('./helpers/signed-release');
const CID = releaseHeadCid(SIGNED_HEAD);

function verifiedFetch(fetched) {
  return {
    maintainerDid: FIXTURE_DID,
    publisherGateway: 'https://publisher.example',
    fetchText: async (url) => {
      fetched.push(url);
      if (url.endsWith(`/ipfs/${CID}`)) return SIGNED_HEAD;
      throw new Error(`unexpected head url ${url}`);
    },
  };
}

function memoryStore(initial) {
  return {
    value: initial,
    get() { return this.value; },
    set(cid) { this.value = cid; },
  };
}

function status(outcome, offered, latest = '1.2.0', current = '1.0.0') {
  return JSON.stringify({
    schema: 'elastos.update-check/v1',
    outcome,
    current_version: current,
    latest_version: latest,
    offered,
  });
}

test('update --check is read from the status file, not from stdout or the exit code', async () => {
  let reads = 0;
  const current = await checkRuntimeUpdate(async (args) => {
    assert.deepEqual(args, ['update', '--check']);
    return { code: 0, stdout: 'Latest available: 9.9.9\nRun `elastos update` to install.\n', stderr: '' };
  }, () => {
    reads += 1;
    return status('up_to_date', false, '1.0.0');
  });
  assert.equal(current.updateAvailable, false);
  assert.equal(current.latest, '1.0.0');
  assert.equal(reads, 1);

  const newer = await checkRuntimeUpdate(async () => ({
    code: 0,
    stdout: 'Installed release is up to date.\n',
    stderr: '',
  }), () => status('update_available', true, '0.8.0'));
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.latest, '0.8.0');

  const refused = await checkRuntimeUpdate(async () => ({
    code: 0,
    stdout: 'Run `elastos update` to install.\n',
    stderr: '',
  }), () => status('update_available', false, '0.8.0'));
  assert.equal(refused.updateAvailable, false);

  const installedNewer = await checkRuntimeUpdate(async () => ({
    code: 0,
    stdout: '',
    stderr: '',
  }), () => status('installed_newer', true, '0.7.0', '0.8.0'));
  assert.equal(installedNewer.updateAvailable, false);

  await assert.rejects(
    () => checkRuntimeUpdate(async () => ({ code: 0, stdout: 'Run `elastos update` to install.\n', stderr: '' }), () => '{'),
    new RegExp(UPDATE_STATUS_UNREADABLE.replace(/[.]/g, '\\.')),
  );

  let readOnFailure = false;
  await assert.rejects(
    () => checkRuntimeUpdate(async () => ({ code: 1, stdout: 'Installed release is up to date.\n', stderr: 'no source' }), () => {
      readOnFailure = true;
      return status('update_available', true);
    }),
    /no source/,
  );
  assert.equal(readOnFailure, false);
});

test('update stores only a head CID the launcher verified', async () => {
  const calls = [];
  const fetched = [];
  const store = memoryStore(undefined);
  await applyRuntimeUpdate(async (args) => {
    calls.push([...args]);
    if (args[0] === 'source') return { code: 0, stdout: `Channel: canary\nHead CID: ${CID}\n`, stderr: '' };
    return { code: 0, stdout: 'updated\n', stderr: '' };
  }, store, verifiedFetch(fetched));
  assert.deepEqual(calls[0], ['source', 'show']);
  assert.deepEqual(calls[1], ['update', '--yes']);
  assert.equal(store.get(), CID);
  assert.equal(store.get(), parseHeadCid(`Head CID: ${CID}`));
  assert.match(fetched[0], new RegExp(`/ipfs/${CID}$`));

  const evil = memoryStore('QmPrevious');
  const ran = [];
  await assert.rejects(
    () => applyRuntimeUpdate(async (args) => {
      ran.push([...args]);
      return { code: 0, stdout: 'Head CID: QmPrevious\n', stderr: '' };
    }, evil, verifiedFetch([])),
    /did not verify/,
  );
  assert.equal(evil.get(), 'QmPrevious');
  assert.deepEqual(ran, [['source', 'show']]);

  const lookalike = `Qm${'a'.repeat(44)}`;
  let updated = false;
  await assert.rejects(
    () => applyRuntimeUpdate(async (args) => {
      if (args[0] === 'update') updated = true;
      return { code: 0, stdout: `Head CID: ${lookalike}\n`, stderr: '' };
    }, memoryStore(undefined), {
      maintainerDid: FIXTURE_DID,
      publisherGateway: 'https://publisher.example',
      fetchText: async () => SIGNED_HEAD,
    }),
    /did not verify/,
  );
  assert.equal(updated, false);
});

test('rollback uses a verified head CID and refuses a stdout token', async () => {
  const calls = [];
  const fetched = [];
  const store = memoryStore(CID);
  await rollbackRuntime(async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: 'rolled back\n', stderr: '' };
  }, store, verifiedFetch(fetched));
  assert.deepEqual(calls[0], ['update', '--rollback-to', CID, '--yes']);
  assert.match(fetched[0], new RegExp(`/ipfs/${CID}$`));

  await assert.rejects(
    () => rollbackRuntime(async () => ({ code: 0, stdout: '', stderr: '' }), memoryStore(undefined), verifiedFetch([])),
    /no previous ElastOS release/,
  );
  let rolled = false;
  await assert.rejects(
    () => rollbackRuntime(async () => {
      rolled = true;
      return { code: 0, stdout: '', stderr: '' };
    }, memoryStore('QmPrevious'), verifiedFetch([])),
    /did not verify/,
  );
  assert.equal(rolled, false);
});

test('a cancelled update is an error', async () => {
  await assert.rejects(
    () => applyRuntimeUpdate(async (args) => {
      if (args[0] === 'source') return { code: 0, stdout: `Head CID: ${CID}\n`, stderr: '' };
      return { code: 0, stdout: 'Update cancelled.\n', stderr: '' };
    }, memoryStore(undefined), verifiedFetch([])),
    /did not run/,
  );
});

test('Mac Update stops Home, runs the update and starts the current binary even after failure', async (t) => {
  const gateway = require('../dist/main/targets/runtimeGateway');
  const updates = require('../dist/main/targets/runtimeUpdate');
  const probe = require('../dist/main/targets/runtimeProbe');
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  const calls = [];
  t.mock.method(probe, 'findRuntimeBinary', () => '/installed/elastos');
  t.mock.method(gateway, 'createDefaultGatewaySupervisor', () => ({
    stop: async () => { calls.push('stop'); }, start: async () => { calls.push('start-current-binary'); },
  }));
  let fail = false;
  t.mock.method(updates, 'applyRuntimeUpdate', async () => {
    calls.push('update');
    if (fail) throw new Error('update failed');
  });
  const target = createRuntimeTarget('darwin', 'arm64');
  await target.update();
  assert.deepEqual(calls, ['stop', 'update', 'start-current-binary']);
  calls.length = 0;
  fail = true;
  await assert.rejects(() => target.update(), /update failed/);
  assert.deepEqual(calls, ['stop', 'update', 'start-current-binary']);
});

test('Windows Update and Undo stop Home, run the release command, and start home --browser again', async (t) => {
  const windows = require('../dist/main/targets/windowsRuntime');
  const updates = require('../dist/main/targets/runtimeUpdate');
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  const calls = [];
  t.mock.method(windows, 'createDistroGatewaySupervisor', () => ({
    stop: async () => { calls.push('stop'); },
    start: async () => { calls.push('start'); },
  }));
  t.mock.method(windows, 'distroIsInstalled', () => true);
  t.mock.method(updates, 'applyRuntimeUpdate', async () => { calls.push('update'); });
  t.mock.method(updates, 'rollbackRuntime', async () => { calls.push('rollback'); });
  const target = createRuntimeTarget('win32');
  await target.update();
  assert.deepEqual(calls, ['stop', 'update', 'start']);
  calls.length = 0;
  await target.rollback();
  assert.deepEqual(calls, ['stop', 'rollback', 'start']);
  calls.length = 0;
  t.mock.method(updates, 'applyRuntimeUpdate', async () => { throw new Error('update failed'); });
  await assert.rejects(() => target.update(), /update failed/);
  assert.deepEqual(calls, ['stop', 'start']);
});

for (const mode of ['update', 'rollback']) {
  test(`Windows ${mode} does not start Home after a failed Stop`, async (t) => {
    const windows = require('../dist/main/targets/windowsRuntime');
    const updates = require('../dist/main/targets/runtimeUpdate');
    const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
    const calls = [];
    t.mock.method(windows, 'createDistroGatewaySupervisor', () => ({
      stop: async () => { calls.push('stop'); throw new Error('stop failed'); },
      start: async () => { calls.push('start'); },
      forceKill() { calls.push('force-stop'); },
    }));
    t.mock.method(windows, 'distroIsInstalled', () => true);
    t.mock.method(updates, 'applyRuntimeUpdate', async () => { calls.push('update'); });
    t.mock.method(updates, 'rollbackRuntime', async () => { calls.push('rollback'); });
    const target = createRuntimeTarget('win32');
    await assert.rejects(() => target[mode](), /stop failed/);
    assert.deepEqual(calls, ['stop']);
  });

  for (const control of ['stop', 'stopForRemoval', 'forceStop', 'quit']) {
    test(`Windows ${mode} leaves Home stopped after a later ${control}`, async (t) => {
      const windows = require('../dist/main/targets/windowsRuntime');
      const updates = require('../dist/main/targets/runtimeUpdate');
      const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
      const calls = [];
      let finish;
      let entered;
      const running = new Promise((resolve) => { entered = resolve; });
      const pending = new Promise((resolve) => { finish = resolve; });
      t.mock.method(windows, 'createDistroGatewaySupervisor', () => ({
        stop: async () => { calls.push('stop'); },
        start: async () => { calls.push('start'); },
        forceKill() { calls.push('force-stop'); },
      }));
      t.mock.method(windows, 'distroIsInstalled', () => true);
      t.mock.method(updates, mode === 'update' ? 'applyRuntimeUpdate' : 'rollbackRuntime', async () => {
        calls.push(mode);
        entered();
        await pending;
      });
      const target = createRuntimeTarget('win32');
      const operation = target[mode]();
      await running;
      let stopping;
      if (control === 'quit') {
        const { createLaunchController } = require('../dist/main/launchController');
        const launch = createLaunchController({ env: {} });
        launch.target.stop = target.stop;
        stopping = launch.shutdown();
      } else if (control === 'forceStop') {
        target.forceStop();
        stopping = Promise.resolve();
      } else {
        stopping = target[control]();
      }
      finish();
      await operation;
      await stopping;
      assert.equal(calls.includes('start'), false);
    });
  }
}

test('Windows controller exit before readiness reports error and does not start again', async (t) => {
  const child = require('node:child_process');
  const dns = require('node:dns');
  const windows = require('../dist/main/targets/windowsRuntime');
  let exitFn;
  let dataFn;
  let spawns = 0;
  let argv = [];
  t.mock.method(child, 'spawn', (_cmd, args) => {
    spawns += 1;
    argv = args;
    return {
      pid: 5150,
      stdout: { on(_event, fn) { dataFn = fn; } },
      stderr: { on() {} },
      on(event, fn) { if (event === 'exit') exitFn = fn; },
    };
  });
  t.mock.method(dns.promises, 'lookup', async () => {
    dataFn('host executable was replaced on disk');
    exitFn(75);
    return [{ address: '203.0.113.9', family: 4 }];
  });
  const supervisor = windows.createDistroGatewaySupervisor();
  await assert.rejects(() => supervisor.start(), /stopped|exit 75|restart/);
  assert.equal(supervisor.phase(), 'error');
  assert.equal(spawns, 1);
  assert.equal(argv.includes('home'), true);
  assert.equal(argv.includes('--browser'), true);
});

test('Runtime 2.0.0 gets the #61 status record only after a successful check and signed head verification', async () => {
  const fixture = require('./helpers/signed-release');
  const { writeSignedUpdateCheck } = require('../dist/main/targets/runtimeUpdate');
  const pin = { channel: 'stable', version: '2.0.0', headCid: null, publishable: true,
    maintainerDid: fixture.FIXTURE_DID, publisherGateway: 'https://publisher.example' };
  let raw;
  const bridge = (head) => writeSignedUpdateCheck('ElastOS Runtime v2.0.0', pin,
    async () => head, (value) => { raw = value; });
  const result = await checkRuntimeUpdate(async () => ({ code: 0, stdout: 'update available 9.9.9', stderr: '' }),
    () => { throw new Error('Runtime record absent'); }, async () => { await bridge(fixture.SIGNED_HEAD); return raw; });
  assert.equal(result.updateAvailable, false);
  assert.equal(JSON.parse(raw).outcome, 'up_to_date');
  await bridge(fixture.signedHead({ version: '2.0.1' }));
  assert.equal(JSON.parse(raw).offered, true);
  assert.equal(JSON.parse(raw).latest_version, '2.0.1');
  raw = undefined;
  await assert.rejects(() => bridge(fixture.SIGNED_HEAD.replace('2.0.0', '9.9.9')), /signature/);
  assert.equal(raw, undefined);
  await assert.rejects(() => bridge(fixture.signedHead({ version: '1.9.9' })), /version/);
  await assert.rejects(() => bridge(fixture.signedHead({ channel: 'canary' })), /channel/);
  await assert.rejects(() => checkRuntimeUpdate(async () => ({ code: 1, stdout: '', stderr: 'network failed' }),
    () => raw, async () => { await bridge(fixture.SIGNED_HEAD); return raw; }), /network failed/);
  assert.equal(raw, undefined);
});

test('a 2.0.0 source with unknown head uses the stored signed record and matching binary version', async () => {
  const fixture = require('./helpers/signed-release');
  const calls = [];
  let version = 'ElastOS Runtime v2.0.0';
  let record = fixture.SIGNED_HEAD;
  const store = memoryStore();
  const run = async (args) => {
    calls.push([...args]);
    return { code: 0, stdout: args[0] === 'source' ? 'Head CID:  unknown\n' : args[0] === 'version' ? version : '', stderr: '' };
  };
  const verify = { maintainerDid: fixture.FIXTURE_DID, publisherGateway: 'https://publisher.example',
    readInstalledHead: () => record, fetchText: async () => fixture.SIGNED_HEAD };
  await applyRuntimeUpdate(run, store, verify);
  assert.equal(store.get(), fixture.FIXTURE_HEAD_CID);
  assert.deepEqual(calls, [['source', 'show'], ['version'], ['update', '--yes']]);
  calls.length = 0;
  version = 'ElastOS Runtime v2.0.1';
  await assert.rejects(() => applyRuntimeUpdate(run, store, verify), /does not match/);
  assert.equal(calls.some((args) => args[0] === 'update'), false);
  record = fixture.SIGNED_HEAD.replace('2.0.0', '9.9.9');
  await assert.rejects(() => applyRuntimeUpdate(run, store, verify), /signature/);
});

test('a Mac status query overlapping Stop preserves the completed stop transition', async (t) => {
  const fs = require('node:fs');
  const gateway = require('../dist/main/targets/runtimeGateway');
  const probe = require('../dist/main/targets/runtimeProbe');
  const support = require('../dist/main/targets/runtimeSupport');
  const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
  let phase = 'stopped';
  t.mock.method(support, 'runtimeInstallBlock', () => null);
  t.mock.method(probe, 'findRuntimeBinary', () => '/installed/elastos');
  t.mock.method(probe, 'probeRuntimeInstallation', async () => ({ kind: 'version', version: 'ElastOS Runtime v2.0.0' }));
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (...args) => String(args[0]).endsWith('components.json') ? { isFile: () => true } : stat(...args));
  t.mock.method(gateway, 'createDefaultGatewaySupervisor', () => ({
    start: async () => { phase = 'running'; }, phase: () => phase,
  }));
  t.mock.method(gateway, 'probeGatewayHealth', async () => ({ status: 200, body: 'OK' }));
  t.mock.method(gateway, 'confirmInstalledGateway', async () => { phase = 'stopped'; return false; });
  const target = createRuntimeTarget('darwin', 'arm64');
  await target.start();
  assert.equal(await target.getStatus(), 'stopped');
});

test('an existing valid Runtime record wins, including offered=false and unchanged records', async () => {
  for (const offered of [true, false]) {
    const result = await checkRuntimeUpdate(async () => ({ code: 0, stdout: '', stderr: '' }),
      () => status('update_available', offered, '2.0.2', '2.0.1'),
      async () => { throw new Error('must not replace a Runtime decision'); });
    assert.equal(result.updateAvailable, offered);
    assert.equal(result.latest, '2.0.2');
  }
});

test('missing or invalid Runtime records fall back and a Runtime record arriving during fallback wins', async () => {
  for (const initial of [undefined, '{}', 'not JSON']) {
    let native = initial;
    let calls = 0;
    const fallback = async () => { calls++; return status('update_available', true, '2.0.1', '2.0.0'); };
    const result = await checkRuntimeUpdate(async () => ({ code: 0, stdout: '', stderr: '' }),
      () => { if (native === undefined) throw new Error('ENOENT'); return native; }, fallback);
    assert.equal(calls, 1);
    assert.equal(result.updateAvailable, true);
    const refused = await checkRuntimeUpdate(async () => ({ code: 0, stdout: '', stderr: '' }),
      () => native, async () => {
        native = status('update_available', false, '2.0.2', '2.0.0');
        return fallback();
      });
    assert.equal(refused.updateAvailable, false);
    assert.equal(refused.latest, '2.0.2');
  }
});

test('concurrent signed checks atomically write only the launcher data directory', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const fixture = require('./helpers/signed-release');
  const { launcherUpdateStatusStore, writeSignedUpdateCheck } = require('../dist/main/targets/runtimeUpdate');
  const home = fs.mkdtempSync(path.join(os.homedir(), 'update-concurrent-'));
  const store = launcherUpdateStatusStore(home);
  const pin = { channel: 'stable', version: '2.0.0', headCid: null, publishable: true,
    maintainerDid: fixture.FIXTURE_DID, publisherGateway: 'https://publisher.example' };
  const writes = [];
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, raw, options) => {
    writes.push(String(file));
    assert.equal(options.flag, 'wx');
    assert.equal(options.mode, 0o600);
    return write(file, raw, options);
  });
  const results = await Promise.all(Array.from({ length: 12 }, () => checkRuntimeUpdate(
    async () => ({ code: 0, stdout: 'untrusted update text', stderr: '' }),
    () => { throw new Error('Runtime record absent'); },
    async () => {
      await writeSignedUpdateCheck('2.0.0', pin, async () => fixture.signedHead({ version: '2.0.1' }), store.write);
      return store.read();
    })));
  assert.equal(results.every((result) => result.updateAvailable), true);
  assert.equal(JSON.parse(store.read()).latest_version, '2.0.1');
  assert.equal(new Set(writes).size, 12);
  assert.equal(writes.every((file) => path.dirname(file) === path.join(home, '.elastos-launcher')), true);
  assert.deepEqual(fs.readdirSync(path.join(home, '.elastos-launcher')), ['update-check.json']);
});

test('a failed atomic rename keeps the old launcher record and cleans only its own temporary file', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { launcherUpdateStatusStore } = require('../dist/main/targets/runtimeUpdate');
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), 'update-failed-'));
  const store = launcherUpdateStatusStore(home);
  store.write('old record');
  const rename = fs.renameSync;
  let first = true;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (first) { first = false; throw new Error('rename refused'); }
    return rename(...args);
  });
  assert.throws(() => store.write('new record'), /rename refused/);
  assert.equal(store.read(), 'old record');
  assert.deepEqual(fs.readdirSync(path.join(home, '.elastos-launcher')), ['update-check.json']);
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} checks use the launcher store and preserve a Runtime refusal`, async (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const child = require('node:child_process');
    const updates = require('../dist/main/targets/runtimeUpdate');
    const install = require('../dist/main/targets/runtimeInstall');
    const windows = require('../dist/main/targets/windowsRuntime');
    const probe = require('../dist/main/targets/runtimeProbe');
    const pins = require('../dist/main/targets/runtimePin');
    const fixture = require('./helpers/signed-release');
    const { runtimeDataDir, runtimeUpdateCheckPath } = require('../dist/main/targets/runtimePaths');
    const home = fs.mkdtempSync(path.join(os.homedir(), `update-${platform}-`));
    const xdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
    t.after(() => { if (xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = xdg; });
    t.mock.method(os, 'homedir', () => home);
    t.mock.method(probe, 'findRuntimeBinary', () => '/fixture/elastos');
    t.mock.method(child, 'execFileSync', () => 'ElastOS Runtime v2.0.0');
    t.mock.method(windows, 'distroIsInstalled', () => true);
    t.mock.method(windows, 'readDistroVersion', () => '2.0.0');
    const run = async () => ({ code: 0, stdout: 'untrusted update text', stderr: '' });
    t.mock.method(updates, 'runRuntimeCommand', run);
    t.mock.method(windows, 'runDistroRuntimeCommand', run);
    t.mock.method(pins, 'loadActiveRuntimePin', () => ({ channel: 'stable', version: '2.0.0', publishable: true,
      maintainerDid: fixture.FIXTURE_DID, publisherGateway: 'https://publisher.example' }));
    let fetched = 0;
    t.mock.method(install, 'fetchRuntimeText', async () => { fetched++; return fixture.signedHead({ version: '2.0.1' }); });
    let native;
    t.mock.method(windows, 'readDistroUpdateStatus', () => { if (!native) throw new Error('ENOENT'); return native; });
    const target = require('../dist/main/targets/runtimeTarget').createRuntimeTarget(platform, platform === 'darwin' ? 'arm64' : 'x64');
    assert.equal((await target.checkForUpdate()).updateAvailable, true);
    const file = path.join(home, '.elastos-launcher', 'update-check.json');
    const saved = fs.readFileSync(file, 'utf8');
    const runtimeFile = runtimeUpdateCheckPath(runtimeDataDir(platform, home, process.env));
    assert.equal(fs.existsSync(runtimeFile), false);
    native = status('update_available', false, '2.0.2', '2.0.0');
    if (platform !== 'win32') {
      fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
      fs.writeFileSync(runtimeFile, native);
    }
    const result = await target.checkForUpdate();
    assert.equal(result.updateAvailable, false);
    assert.equal(result.latest, '2.0.2');
    assert.equal(fetched, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    if (platform !== 'win32') assert.equal(fs.readFileSync(runtimeFile, 'utf8'), native);
  });
}
