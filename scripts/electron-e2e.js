#!/usr/bin/env node
/**
 * Click Install in the Electron window and wait until the button says
 * "Open my computer". Linux, macOS, and Windows CI run this against the pinned runtime.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronPath = require('electron');
const { _electron: electron } = require('playwright');

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
    const page = await electronApp.firstWindow();
    const readyDeadline = Date.now() + 60000;
    let clicked = '';
    while (Date.now() < readyDeadline && !clicked) {
      const label = (await page.locator('#open-label').innerText({ timeout: 5000 })).trim();
      const disabled = await page.locator('#open-btn').isDisabled();
      if (label === 'Install' && !disabled) {
        await page.click('#open-btn');
        clicked = label;
        break;
      }
      await page.waitForTimeout(200);
    }
    if (!clicked) {
      const label = (await page.locator('#open-label').innerText()).trim();
      const logs = await page.locator('#logs-content').innerText();
      console.log('----- install log -----');
      console.log(logs);
      throw new Error(`Install button did not become ready (button is ${label})`);
    }
    console.log(`Clicked ${clicked}`);

    // Windows has no ElastOS distro yet, so Install stops on "Click Set up".
    // Fix it imports that distro and leaves the gateway down, so the button
    // returns to Install and the click has to run the real install.
    const budgetMs = process.platform === 'win32' ? 45 * 60 * 1000 : 20 * 60 * 1000;
    const deadline = Date.now() + budgetMs;
    let lastPrinted = 0;
    let label = '';
    let windowsFix = 'pending';
    while (Date.now() < deadline) {
      label = (await page.locator('#open-label').innerText()).trim();
      const logs = await page.locator('#logs-content').innerText();
      const errorVisible = await page.locator('#error-box').evaluate((node) => !node.classList.contains('hidden'));
      const errorText = (await page.locator('#error-text').innerText()).trim();
      const openDisabled = await page.locator('#open-btn').isDisabled();
      if (Date.now() - lastPrinted > 30000) {
        const tail = logs.split('\n').filter(Boolean).slice(-3).join(' | ');
        console.log(`button=${label} log=${tail || '(empty)'}`);
        lastPrinted = Date.now();
      }
      if (label === 'Open my computer') {
        console.log('----- install log -----');
        console.log(logs);
        for (const line of REQUIRED_LOGS) {
          if (!logs.includes(line)) {
            throw new Error(`Install log is missing: ${line}`);
          }
        }
        console.log('Install reached Open my computer');
        return;
      }
      if (errorVisible && errorText && /Set up ElastOS on Windows|Windows needs Linux support|Windows needs one step/.test(errorText)) {
        const fixHidden = await page.locator('#fix-btn').evaluate((node) => node.classList.contains('hidden'));
        const fixDisabled = await page.locator('#fix-btn').isDisabled();
        if (windowsFix === 'pending' && !fixHidden && !fixDisabled) {
          await page.click('#fix-btn');
          windowsFix = 'running';
          console.log('Clicked Fix it to add the ElastOS Linux environment');
        } else if (windowsFix === 'running' && !fixHidden && !fixDisabled) {
          // Fix it imports the distro and leaves the gateway down, so the
          // screen can say it still needs attention. Install is the next click.
          if ((label === 'Install' || label === 'Try again') && !openDisabled) {
            await page.click('#open-btn');
            windowsFix = 'installing';
            console.log('Clicked Install after Windows setup');
            await page.waitForTimeout(1000);
            continue;
          }
          console.log('----- install log -----');
          console.log(logs);
          throw new Error(errorText);
        }
        await page.waitForTimeout(1000);
        continue;
      }
      const fixHidden = errorVisible
        ? await page.locator('#fix-btn').evaluate((node) => node.classList.contains('hidden'))
        : true;
      const fixDisabled = await page.locator('#fix-btn').isDisabled();
      if (windowsFix === 'running' && (label === 'Install' || label === 'Try again') && !openDisabled && fixHidden && !fixDisabled) {
        await page.click('#open-btn');
        windowsFix = 'installing';
        console.log('Clicked Install after Windows setup');
        await page.waitForTimeout(1000);
        continue;
      }
      if ((windowsFix === 'running' || windowsFix === 'installing') && (label === 'Working…' || openDisabled)) {
        await page.waitForTimeout(1000);
        continue;
      }
      if (errorVisible && errorText && errorText !== 'That still needs attention.') {
        console.log('----- install log -----');
        console.log(logs);
        throw new Error(errorText);
      }
      if (label === 'Try again') {
        console.log('----- install log -----');
        console.log(logs);
        throw new Error(errorText || 'Install ended on Try again');
      }
      await page.waitForTimeout(1000);
    }
    const logs = await page.locator('#logs-content').innerText();
    console.log('----- install log -----');
    console.log(logs);
    throw new Error(`Install did not reach Open my computer (button is ${label})`);
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

const capMs = process.platform === 'win32' ? 50 * 60 * 1000 : 22 * 60 * 1000;
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
