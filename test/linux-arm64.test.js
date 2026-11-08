const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { plan } = require('../scripts/ci-plan');

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
  assert.match(build, /needs: \[plan, build, linux-arm64\]/);
});

test('runtime smoke and electron e2e have a linux-arm64 row on Ubuntu 22.04', () => {
  const rows = plan({ requested: 'linux' }).runtime;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].os, 'ubuntu-24.04');
  assert.match(rows[0].packages, /libasound2t64 libgtk-3-0t64/);
  assert.equal(rows[1].os, 'ubuntu-22.04-arm');
  assert.equal(rows[1].platform, 'linux-arm64');
  assert.equal(rows[1].packages.includes('t64'), false);
  assert.match(rows[1].packages, /libasound2 libgtk-3-0 libxss1 libayatana-appindicator3-1/);
});

test('the deb depends keep the electron-builder defaults and add the tray library', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.deb.depends, DEB_DEPENDS);
});
