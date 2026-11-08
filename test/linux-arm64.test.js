const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

const DEB_DEPENDS = [
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0',
  'libayatana-appindicator3-1',
];

test('the arm64 package job uses the Jetson glibc and the bundled fpm', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/linux-arm64.yml'), 'utf8');
  const build = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /runs-on: ubuntu-22\.04-arm/);
  assert.match(workflow, /--arm64/);
  assert.equal(workflow.includes('USE_SYSTEM_FPM'), false);
  assert.equal(workflow.includes('APPIMAGE_EXTRACT_AND_RUN'), false);
  assert.equal(workflow.includes('gem install fpm'), false);
  assert.match(build, /uses: \.\/\.github\/workflows\/linux-arm64\.yml/);
  assert.match(build, /needs: \[build, linux-arm64\]/);
});

test('runtime smoke and electron e2e have a linux-arm64 row on Ubuntu 22.04', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/runtime-smoke.yml'), 'utf8');
  assert.match(workflow, /ubuntu-24\.04/);
  assert.match(workflow, /libasound2t64 libgtk-3-0t64/);
  const armRows = workflow.match(/os: ubuntu-22\.04-arm\n\s+platform: linux-arm64/g) || [];
  assert.equal(armRows.length, 2);
  const armPackages = workflow.match(/os: ubuntu-22\.04-arm\n\s+platform: linux-arm64\n\s+packages: (.*)/);
  assert.ok(armPackages, 'linux-arm64 e2e package list');
  assert.equal(armPackages[1].includes('t64'), false);
  assert.match(armPackages[1], /libasound2 libgtk-3-0 libxss1 libayatana-appindicator3-1/);
});

test('the deb depends keep the electron-builder defaults and add the tray library', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.deb.depends, DEB_DEPENDS);
});

test('linux e2e runs the linux lifecycle and leaves the mac lifecycle on darwin', () => {
  const e2e = fs.readFileSync(path.join(root, 'scripts/electron-e2e.js'), 'utf8');
  const life = fs.readFileSync(path.join(root, 'scripts/linux-lifecycle-e2e.js'), 'utf8');
  assert.match(e2e, /process\.platform === 'darwin'/);
  assert.match(e2e, /mac-lifecycle-e2e/);
  assert.match(e2e, /process\.platform === 'linux'/);
  assert.match(e2e, /linux-lifecycle-e2e/);
  assert.match(life, /PASS Open Home/);
  assert.match(life, /PASS closing the window keeps Home running/);
  assert.match(life, /PASS Stop Home closes the listener/);
  assert.match(life, /PASS Start Home becomes healthy/);
  assert.match(life, /PASS Home system update check reaches the live controller/);
  assert.match(life, /NOT EXERCISED a full System update because no newer signed release exists/);
  assert.match(life, /NOT EXERCISED the owner System summary because that route needs a wallet token/);
  assert.match(life, /update-controller', 'status.json'/);
  assert.match(life, /__update-controller/);
  assert.match(life, /PASS elastos update --check writes up_to_date/);
  assert.match(life, /PASS the tray icon is ready/);
  assert.match(life, /__elastosTray/);
  assert.match(life, /quit-keep-home/);
  assert.match(life, /quit-stop-home/);
  assert.match(life, /PASS Quit and keep Home leaves the controller running/);
  assert.match(life, /PASS Quit and stop Home after reopen stops the retained Home/);
  assert.equal(life.includes('waitForFunction'), false);
  assert.equal(life.includes('command ${'), false);
  assert.equal(life.includes('Application Support'), false);
  assert.equal(life.includes('home --browser'), false);
  assert.match(life, /\.local', 'share', 'elastos'/);
});
