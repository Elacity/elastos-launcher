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
