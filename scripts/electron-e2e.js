#!/usr/bin/env node
/**
 * Click Install in the Electron window and wait until the button says
 * "Open Home". Linux, macOS, and Windows CI run this against the pinned runtime.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Mac installation e2e runs only on the GitHub runner.');
}
const electronPath = require('electron');
const { _electron: electron } = require('playwright');
const { HOME_URL, isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');

// Passkeys need a localhost origin. Browsers refuse them on 127.0.0.1.
const EXPECTED_HOME = 'http://localhost:8090/home/';

const REQUIRED_LOGS = [
  'Release head signature matches the pinned maintainer',
  'install.sh SHA-256 matches the pin',
  'Installed head CID matches the pin',
];

function isolatedHome() {
  const base = path.join(os.homedir(), '.elastos-e2e');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  const home = fs.mkdtempSync(path.join(base, 'home-'));
  fs.chmodSync(home, 0o700);
  return home;
}

// Chromium reads switches that appear before the app path. Playwright places
// every launch arg after --inspect, so Windows must put --no-sandbox there.
// A switch after the app path stays in process.argv and the GPU sandbox still
// exits the process before "DevTools listening".
function launchArgs() {
  if (process.platform !== 'win32') return [root, '--no-sandbox'];
  return ['--no-sandbox', '--disable-gpu-sandbox', '--disable-gpu', root];
}

function launchEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    ELASTOS_LAUNCH_TARGET: 'runtime',
    ELASTOS_HIDE_HOST_TOOLS: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform !== 'win32') return env;
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  const temp = path.join(local, 'Temp');
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const parsed = path.win32.parse(home);
  const drive = parsed.root.replace(/[\\/]+$/, '');
  let rest = home.slice(parsed.root.length).replace(/\//g, '\\');
  if (!rest.startsWith('\\')) rest = `\\${rest}`;
  env.APPDATA = roaming;
  env.LOCALAPPDATA = local;
  env.TEMP = temp;
  env.TMP = temp;
  env.HOMEDRIVE = drive;
  env.HOMEPATH = rest;
  return env;
}

function electronStartupLog(env, args) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, ['--inspect=0', '--remote-debugging-port=0', ...args], {
      cwd: root,
      env,
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    let timer;
    const finish = (summary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(summary);
    };
    const take = (chunk) => {
      out += chunk.toString();
      if (out.length > 12000) out = out.slice(-12000);
      if (/DevTools listening on/.test(out)) {
        child.kill();
        finish(`electron printed DevTools and stayed up\n${out.trim()}`);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    timer = setTimeout(() => {
      child.kill();
      finish(out.trim() || '(electron stayed up and printed nothing)');
    }, 15000);
    child.on('exit', (code, signal) => {
      finish(`exit ${code} signal ${signal || ''}\n${out}`.trim());
    });
    child.on('error', (err) => {
      finish(`${err.message}\n${out}`.trim());
    });
  });
}

async function main() {
  const home = isolatedHome();
  const args = launchArgs();
  const env = launchEnv(home);
  console.log(`e2e home ${home}`);
  console.log('host tools hidden: curl and python3 come from the app');
  let electronApp;
  try {
    electronApp = await electron.launch({
      executablePath: electronPath,
      cwd: root,
      args,
      timeout: 120000,
      env,
    });
  } catch (err) {
    console.error(`electron executable ${electronPath} exists=${fs.existsSync(electronPath)}`);
    console.error('----- electron startup -----');
    console.error(await electronStartupLog(env, args));
    throw err;
  }

  try {
    const { waitFor: poll, focusWindow } = require('./tray-e2e');
    const waitFor = (check, timeout, message) => poll(check, timeout, message, electronApp);
    await electronApp.evaluate(({ shell }) => {
      global.__openedHome = [];
      shell.openExternal = async url => { global.__openedHome.push(url); };
    });
    const page = await electronApp.firstWindow();
    await page.locator('#primary').waitFor({ state: 'visible' });
    if ((await page.locator('#primary').innerText()) !== 'Install') throw new Error('Expected Install');
    if (process.platform === 'darwin') {
      const native = require('./mac-native').nativeControls(electronApp, page);
      await focusWindow(electronApp);
      await native.drag();
      await native.click('#primary');
    } else await page.click('#primary');
    let fixedWindows = false;
    await waitFor(async () => {
      const kind = await page.getAttribute('body', 'data-state');
      const label = await page.locator('#primary').innerText();
      if (kind === 'error') {
        const message = await page.locator('#message').innerText();
        if (process.platform === 'win32' && !fixedWindows) {
          fixedWindows = true;
          await electronApp.evaluate(({ dialog }) => {
            dialog.showMessageBox = async (...args) => ({
              response: args.at(-1).buttons?.includes('Set Up') ? 1 : 0,
              checkboxChecked: false,
            });
          });
          await page.click('#primary');
          await page.waitForFunction(() => !document.querySelector('#primary').disabled, null, { timeout: 45 * 60 * 1000 });
          return false;
        }
        throw new Error(message);
      }
      if (fixedWindows && kind === 'install' && label === 'Install') { await page.click('#primary'); return false; }
      return label === 'Open Home' && kind === 'install';
    }, process.platform === 'win32' ? 45*60*1000 : 20*60*1000, 'Install did not reach Home is ready');
    if (await page.locator('#message').innerText() !== 'Home is ready.') throw new Error('Missing ready confirmation');
    const diagnostics = await page.evaluate(() => window.elastos.copyDiagnostics());
    const text = await electronApp.evaluate(({clipboard})=>clipboard.readText());
    for (const line of REQUIRED_LOGS) if (!text.includes(line)) throw new Error(`Missing install evidence: ${line}`);
    if (HOME_URL !== EXPECTED_HOME || !isHealthOk(await probeGatewayHealth())) throw new Error('Home is not healthy');
    console.log('PASS install through window reaches Home is ready with signed-install evidence');
    if (process.platform === 'darwin') {
      if ((await electronApp.evaluate(() => global.__openedHome)).length !== 0) {
        throw new Error('Mac Install opened a duplicate browser tab after home --browser');
      }
      await focusWindow(electronApp);
      await require('./mac-native').nativeControls(electronApp,page).click('#primary');
    }
    else await page.click('#primary');
    await waitFor(()=>electronApp.evaluate(()=>global.__openedHome.includes('http://localhost:8090/home/')),10000,'Open Home did not open localhost');
    await require('./tray-e2e').noWindow(electronApp);
    const options = {executablePath:electronPath,cwd:root,args,env,timeout:120000};
    electronApp = await require(`./${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'}-lifecycle-e2e`)(electronApp, page, home, options);
    return;
  } finally {
    const exiting = electronApp.evaluate(({ app }) => {
      app.exit(0);
    }).catch(() => {});
    await Promise.race([
      exiting,
      new Promise((resolve) => { setTimeout(resolve, 3000); }),
    ]);
    try {
      electronApp.process().kill('SIGKILL');
    } catch {
      // The window already closed.
    }
  }
}

const capMs = process.platform === 'win32' ? 50 * 60 * 1000 : process.platform === 'linux' ? 45 * 60 * 1000 : 35 * 60 * 1000;
setTimeout(() => {
  console.error(`e2e did not finish within ${capMs / 60000} minutes`);
  process.exit(1);
}, capMs);

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
