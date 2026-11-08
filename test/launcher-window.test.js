const assert = require('node:assert/strict');
const test = require('node:test');
const { contentWindowBounds } = require('../dist/main/launcherWindow');
const { isLoginLaunch, startHomeAtLogin } = require('../dist/main/targets/openAtLogin');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('content sizing shrinks, grows, and clamps frame and position to the screen', () => {
  const bounds = { x: 900, y: 700, width: 420, height: 500 };
  const content = { width: 420, height: 470 };
  const work = { x: 0, y: 25, width: 1200, height: 775 };
  assert.deepEqual(contentWindowBounds(310, bounds, content, work), { x: 780, y: 460, width: 420, height: 340 });
  assert.deepEqual(contentWindowBounds(1200, bounds, content, work), { x: 780, y: 25, width: 420, height: 775 });
  assert.deepEqual(contentWindowBounds(300, bounds, content, { x: -320, y: 0, width: 320, height: 600 }),
    { x: -320, y: 270, width: 320, height: 330 });
});

test('login start is platform-explicit and starts only a stopped Home', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(isLoginLaunch(platform, ['--login'], { wasOpenedAtLogin: true }), true);
    assert.equal(isLoginLaunch(platform, [], {}), false);
    assert.equal(isLoginLaunch(platform, ['--login'], {}), platform !== 'darwin');
    for (const status of ['running', 'stopped', 'not-installed', 'error', 'starting', 'stopping', 'other-home']) {
      let starts = 0;
      const launch = { getStatus: async () => status, start: async () => { starts++; } };
      await startHomeAtLogin(false, launch);
      assert.equal(starts, 0);
      await startHomeAtLogin(true, launch);
      assert.equal(starts, status === 'stopped' ? 1 : 0, `${platform} ${status}`);
    }
  }
});

const { mainFixture } = require('./main-fixture');

test('real main: login is hidden; normal, second and activated launches open Home without a window', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const login = await mainFixture({ login: true, platform });
    assert.equal(login.windows.length, 0);
    assert.equal(login.calls.filter(c => c === 'start').length, 1);
    assert.equal(login.calls.includes('open'), false);
    login.app.emit('second-instance'); await tick(); await tick();
    assert.equal(login.windows.length, 0);
    assert.ok(login.calls.includes('open'));
    login.app.emit('activate'); await tick(); await tick();
    assert.equal(login.calls.filter(c => c === 'open').length, 2);
    const normal = await mainFixture({ platform });
    assert.equal(normal.windows.length, 0);
    assert.deepEqual(normal.calls.filter(c => ['start', 'open'].includes(c)), ['start']);
    const disabled = await mainFixture({ login: true, enabled: false, platform });
    assert.equal(disabled.calls.includes('start'), false);
  }
  const first = await mainFixture({ installed: false });
  assert.equal(first.windows.length, 1);
  assert.equal(first.windows[0].options.width, 360);
  assert.equal(first.windows[0].options.titleBarStyle, 'hiddenInset');
  assert.equal(first.app.about.applicationVersion, '2.0.0');
  const secondary = await mainFixture({ lock: false });
  assert.deepEqual(secondary.calls, ['mkdir', 'lock', 'exit']);
});

test('native maintenance confirmations default to Cancel and carry explicit choices', async () => {
  const f = await mainFixture();
  for (const label of ['Reset ElastOS…', 'Uninstall ElastOS…', 'Remove Old PC2 Files…']) {
    await f.click(label);
    const dialog = f.dialogs.at(-1);
    assert.equal(dialog.defaultId, 0); assert.equal(dialog.cancelId, 0);
    assert.equal(dialog.buttons[0], 'Cancel');
  }
  assert.equal(f.calls.some(c => Array.isArray(c) && ['reset','uninstall','pc2'].includes(c[0])), false);
  f.answers.push({ response: 1, checkboxChecked: false });
  await f.click('Uninstall ElastOS…');
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'uninstall' && c[1] === false));
  f.answers.push({ response: 1, checkboxChecked: true });
  await f.click('Reset ElastOS…');
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'reset' && c[1].backup === true));
  f.answers.push({ response: 1, checkboxChecked: true });
  await f.click('Remove Old PC2 Files…');
  assert.match(f.dialogs.at(-1).detail, /earlier ElastOS Personal Cloud app/);
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'pc2' && c[1].backup === true && c[1].paths[0] === '/fixture/.pc2'));
});

test('real install retains the ready window; Open Home closes it; Quit always shuts down', async () => {
  const f = await mainFixture({ installed: false });
  await f.invoke('install', false);
  assert.equal((await f.invoke('getWindowState')).ready, true);
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'login' && c[1] === false));
  await f.invoke('openHome');
  assert.ok(f.calls.includes('open'));
  const event = { preventDefault() {} };
  f.app.emit('before-quit', event); await tick();
  assert.ok(f.calls.includes('shutdown'));
  assert.ok(f.calls.includes('quit'));
});

test('successful control operations clear stored errors and notify every window caller', async (t) => {
  const { createLaunchController } = require('../dist/main/launchController');
  const preflight = require('../dist/main/targets/preflight');
  t.mock.method(preflight, 'collectPreflight', async () => ({ ok: true, checks: [] }));
  t.mock.method(require('../dist/main/targets/runtimeUninstall'), 'resetRuntimeOnThisComputer', async () => ({ backupPath: null }));
  t.mock.method(require('../dist/main/targets/windowsReset'), 'resetRuntimeInDistroOnThisComputer', async () => ({ backupPath: null }));
  t.mock.method(require('../dist/main/targets/windowsUninstall'), 'uninstallRuntimeInDistroOnThisComputer', async () => {});
  t.mock.method(require('../dist/main/targets/windowsUninstall'), 'uninstallDistroProgramOnThisComputer', async () => {});
  for (const method of ['start', 'stop', 'restart', 'install', 'update', 'rollback', 'resetRuntime', 'uninstall', 'openInBrowser']) {
    const controller = createLaunchController({ env: {} });
    let successes = 0;
    controller.onActionSuccess(() => { successes++; });
    controller.target.start = async () => { throw new Error('prior start failed'); };
    await assert.rejects(controller.start(), /prior start failed/);
    assert.match((await controller.describeFailure()).message, /prior start failed/);
    assert.equal(successes, 0);
    controller.target.start = async () => {};
    controller.target[method] = () => Promise.resolve();
    await controller[method]();
    assert.doesNotMatch((await controller.describeFailure()).message, /prior start failed/, method);
    assert.equal(successes, 1, method);
  }
});

test('real login settings register hidden Mac login, Windows login args, and Linux autostart', () => {
  const Module = require('node:module');
  const file = require.resolve('../dist/main/targets/openAtLogin');
  const load = Module._load;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const settings = [], files = new Map();
    try {
      Object.defineProperty(process, 'platform', { value: platform });
      Module._load = function(name, ...args) {
        if(name==='electron')return {app:{setLoginItemSettings:value=>settings.push(value)}};
        if(name==='fs')return {mkdirSync(){},writeFileSync:(file,data)=>files.set(file,data),rmSync:file=>files.delete(file)};
        return load.call(this,name,...args);
      };
      delete require.cache[file];
      const {applyOpenAtLogin}=require(file);
      applyOpenAtLogin(true,'/fixture');
      if(platform==='linux')assert.match(files.get('/fixture/.config/autostart/elastos.desktop'),/ --login\n/);
      else {
        assert.equal(settings[0].openAtLogin,true);
        if(platform==='darwin')assert.equal(settings[0].openAsHidden,true);
        else assert.deepEqual(settings[0].args,['--login']);
      }
      applyOpenAtLogin(false,'/fixture');
      assert.equal(JSON.parse(files.get('/fixture/.elastos-launcher/open-at-login.json')).enabled,false);
    } finally {Module._load=load;Object.defineProperty(process,'platform',descriptor);delete require.cache[file];}
  }
});

test('Home log folders follow each platform data location', () => {
  const { homeLogFolder } = require('../dist/main/launchController');
  assert.equal(homeLogFolder('darwin', '/fixture', {}), '/fixture/Library/Application Support/elastos/logs');
  assert.equal(homeLogFolder('linux', '/fixture', {}), '/fixture/.local/share/elastos/logs');
  assert.equal(homeLogFolder('linux', '/fixture', { XDG_DATA_HOME: '/data' }), '/data/elastos/logs');
  assert.equal(homeLogFolder('win32', 'C:\\Users\\fixture', {}), '\\\\wsl.localhost\\ElastOS\\root\\.local\\share\\elastos\\logs');
});

test('Start and Stop immediately change the real tray state while the controller is pending', async () => {
  const f = await mainFixture({status:'stopped'});
  await f.click('Stop Home');
  let release;
  const start = f.launch.start, stop = f.launch.stop;
  f.launch.start=async()=>{await new Promise(resolve=>{release=resolve;});await start();};
  await f.click('Start Home');
  assert.equal(f.tray.tooltip,'ElastOS: Starting Home…');
  assert.equal(f.tray.menu[0].label,'Starting Home…');
  release(); await tick(); await tick();
  f.launch.stop=async()=>{await new Promise(resolve=>{release=resolve;});await stop();};
  await f.click('Stop Home');
  assert.equal(f.tray.tooltip,'ElastOS: Stopping Home…');
  release(); await tick(); await tick();
});

test('unchanged status polls preserve the open menu; stale polls cannot overwrite a newer action', async () => {
  const f = await mainFixture({status:'running'});
  const menu = f.tray.menu;
  await f.timers[0]();
  assert.equal(f.tray.menu,menu);
  let release;
  const getStatus=f.launch.getStatus;
  f.launch.getStatus=()=>new Promise(resolve=>{release=resolve;});
  const polling=f.timers[0]();
  f.launch.getStatus=getStatus;
  await f.click('Stop Home');
  release('running'); await polling;
  assert.equal(f.tray.menu[0].label,'Home is stopped');
});

test('Windows setup resumes the failed install once Linux support is available', async () => {
  const f=await mainFixture({installed:false,platform:'win32'});
  const install=f.launch.install;
  let setup=false;
  f.launch.install=async progress=>{if(!setup)throw new Error('Windows needs Linux support.');await install(progress);};
  f.launch.describeFailure=async()=>({kind:'windows',message:'Windows needs Linux support.',fixLabel:'Fix it'});
  f.launch.fixFailure=async()=>{setup=true;return 'still-blocked';};
  f.launch.getPreflight=async()=>({checks:[]});
  await f.invoke('install',false);
  assert.equal((await f.invoke('getWindowState')).kind,'error');
  f.answers.push({response:1,checkboxChecked:false});
  await f.invoke('retry');
  assert.equal((await f.invoke('getWindowState')).ready,true);
});
