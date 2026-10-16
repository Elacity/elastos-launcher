#!/usr/bin/env node
/**
 * Seed an old PC2 home and a listener on port 4200, launch the app, and
 * assert Remove PC2 is offered. The folder and the listener stay in place.
 * Sudoers rules are covered by the unit test: this runner does not write
 * /etc/sudoers.d.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronPath = require('electron');
const { _electron: electron } = require('playwright');

function isolatedHome() {
  const base = path.join(os.homedir(), '.elastos-e2e');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  const home = fs.mkdtempSync(path.join(base, 'upgrade-'));
  fs.chmodSync(home, 0o700);
  return home;
}

function listenOn4200() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4200, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const xauthority = process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority');
  const home = isolatedHome();
  const pc2 = path.join(home, '.pc2');
  fs.mkdirSync(pc2, { mode: 0o700 });
  fs.writeFileSync(path.join(pc2, 'package.json'), JSON.stringify({ name: 'puter' }));
  console.log(`upgrade home ${home}`);
  console.log('seeded ~/.pc2 and a listener on 127.0.0.1:4200');
  const server = await listenOn4200();
  const electronApp = await electron.launch({
    executablePath: electronPath,
    cwd: root,
    args: [root, '--no-sandbox'],
    timeout: 120000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XAUTHORITY: xauthority,
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      ELASTOS_LAUNCH_TARGET: 'runtime',
      ELASTOS_HIDE_HOST_TOOLS: '1',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  });

  try {
    const page = await electronApp.firstWindow();
    const deadline = Date.now() + 90000;
    let visible = false;
    while (Date.now() < deadline) {
      visible = await page.locator('#remove-pc2-btn').evaluate((node) => !node.classList.contains('hidden'));
      if (visible) break;
      await page.waitForTimeout(200);
    }
    const label = (await page.locator('#remove-pc2-btn').innerText()).trim();
    if (!visible || label !== 'Remove PC2') {
      throw new Error(`Remove PC2 was not offered (visible=${visible}, label=${label})`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(pc2, 'package.json'), 'utf8'));
    if (pkg.name !== 'puter') throw new Error('~/.pc2 was changed before Remove PC2 was confirmed');
    if (!server.listening) throw new Error('the listener on port 4200 is gone');
    console.log('Remove PC2 is offered');
    console.log('~/.pc2 is still on disk and port 4200 is still listening');
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
    await new Promise((resolve) => server.close(resolve));
  }
}

setTimeout(() => {
  console.error('upgrade e2e did not finish within 3 minutes');
  process.exit(1);
}, 3 * 60 * 1000);

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
