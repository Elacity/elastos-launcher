const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const states = {
  install: { kind: 'install' },
  progress: { kind: 'progress', message: 'Downloading' },
  ready: { kind: 'install', ready: true, message: 'Home is ready.' },
  error: { kind: 'error', message: 'The download stopped before it finished.', actionLabel: 'Try Again' },
  'error-logs': { kind: 'error', message: 'Home could not start.', actionLabel: 'Show Logs' },
  update: { kind: 'update', message: 'Update ElastOS to 2.0.1?', releaseNotes: true },
};
// Render production recovery copy for every error state, including raw parser failures.
const { failureScreen } = require('../dist/main/targets/runtimeRecovery');
const failures = {
  offline: { checks: [{ id: 'network', level: 'block' }] },
  port: { checks: [{ id: 'port', level: 'block' }] },
  interrupted: { binaryPresent: true },
  'stale-lock': { lockText: JSON.stringify({ pid: 4242 }) },
  windows: { checks: [{ id: 'windows', level: 'block' }] },
  'no-record': { error: 'This folder has no signed ElastOS install record.' },
  other: { error: 'Release head is not valid JSON.' },
  backup: { error: 'ElastOS was not reset. A copy of your data cannot be saved here. Nothing was deleted.' },
  disk: { checks: [{ id: 'disk', level: 'block' }] },
  platform: { checks: [{ id: 'platform', level: 'block', message: 'Intel Mac is not supported yet.' }] },
  localhost: { checks: [{ id: 'localhost', level: 'block' }] },
  restart: { error: 'Restart Windows.' },
  'other-home': { error: 'Your computer is already running.' },
};
for (const [kind, overrides] of Object.entries(failures)) {
  const screen = failureScreen({ error: '', checks: [], binaryPresent: false, componentsPresent: false,
    lockText: null, lockPath: null, pidAlive: () => false, ...overrides });
  states[`error-${kind}`] = { kind: 'error', message: screen.message, actionLabel: screen.fixLabel ? 'Try Again' : 'Show Logs' };
}
async function launchRendererBrowser() {
  return chromium.launch({ executablePath: process.env.ELASTOS_TEST_CHROMIUM || undefined, headless: true });
}
async function settleRendererLayout(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function openRenderer(browser, { state = 'install', platform = 'darwin', colorScheme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width: 360, height: 320 }, colorScheme });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ state, platform }) => {
    const calls = []; window.fixture = { calls, state, height: 320 };
    const record = name => async (...args) => { calls.push([name, ...args]); };
    window.elastos = {
      platform, getWindowState: async () => state, onWindowState: fn => { window.fixture.render = fn; },
      contentSize: height => { window.fixture.height = Math.max(320, height); },
      ...Object.fromEntries(['install','update','retry','openHome','copyDiagnostics','closeWindow','releaseNotes'].map(name => [name, record(name)])),
    };
  }, { state: states[state], platform });
  await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
  await page.waitForFunction(() => document.body.dataset.state);
  await settleRendererLayout(page);
  await page.setViewportSize({ width: 360, height: await page.evaluate(() => window.fixture.height) });
  return { page, errors };
}
module.exports = { states, launchRendererBrowser, openRenderer, settleRendererLayout };
