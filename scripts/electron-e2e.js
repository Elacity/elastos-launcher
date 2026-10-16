#!/usr/bin/env node
/**
 * Click Install in the Electron window and wait until the button says
 * "Open my computer". Linux and macOS CI run this against the pinned runtime.
 */
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

async function main() {
  const home = isolatedHome();
  console.log(`e2e home ${home}`);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    cwd: root,
    args: [root, '--no-sandbox'],
    timeout: 120000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      ELASTOS_LAUNCH_TARGET: 'runtime',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  });

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

    const deadline = Date.now() + 20 * 60 * 1000;
    let lastPrinted = 0;
    let label = '';
    while (Date.now() < deadline) {
      label = (await page.locator('#open-label').innerText()).trim();
      const logs = await page.locator('#logs-content').innerText();
      const errorVisible = await page.locator('#error-box').evaluate((node) => !node.classList.contains('hidden'));
      const errorText = (await page.locator('#error-text').innerText()).trim();
      if (Date.now() - lastPrinted > 30000) {
        const tail = logs.split('\n').filter(Boolean).slice(-3).join(' | ');
        console.log(`button=${label} log=${tail || '(empty)'}`);
        lastPrinted = Date.now();
      }
      if (errorVisible && errorText) {
        console.log('----- install log -----');
        console.log(logs);
        throw new Error(errorText);
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

setTimeout(() => {
  console.error('e2e did not finish within 22 minutes');
  process.exit(1);
}, 22 * 60 * 1000);

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
