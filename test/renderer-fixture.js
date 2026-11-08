const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function launchRendererBrowser() {
  return chromium.launch({
    executablePath: process.env.ELASTOS_TEST_CHROMIUM || undefined,
    headless: true,
    args: ['--headless=new'],
  });
}

async function settleRendererLayout(page) {
  // Observe a completed layout instead of guessing when ResizeObserver has run.
  await page.evaluate(() => new Promise((resolve) => {
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(document.getElementById('window-content'));
  }));
}

async function openRenderer(browser, { state = 'stopped', platform = 'darwin' } = {}) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ state, platform }) => {
    const callbacks = {};
    const calls = [];
    let status = ['installing', 'not-installed'].includes(state) ? 'not-installed'
      : ['running', 'update-offered', 'details-open'].includes(state) ? 'running'
        : state === 'error' ? 'error' : 'stopped';
    let items = state === 'pc2-found' ? [{ path: '/fixture/.pc2', label: 'Old PC2 data', bytes: 1024, scope: 'host' }] : [];
    const info = () => ({ status, openUrl: 'http://localhost:8090/home/', openAtLogin: false,
      browserNote: 'Browser is not available on this computer yet.',
      preflight: { ok: true, checks: [] }, error: state === 'error' ? 'Home could not start.' : null,
      runtimeOpensBrowser: true });
    const action = (name, result) => async (...args) => {
      calls.push({ name, args });
      return typeof result === 'function' ? result(...args) : result;
    };
    window.fixture = {
      calls, callbacks, info,
      installed: state !== 'not-installed',
      failStart: false, failPc2: false,
      emitStatus(value) { status = value; callbacks.status(value); },
    };
    window.elastos = {
      platform,
      contentSize(height) { window.fixture.height = height; },
      getLaunchInfo: async () => info(),
      getStatus: async () => status,
      isInstalled: async () => window.fixture.installed,
      getVersion: async () => '2.0.0',
      getPreflight: async () => ({ ok: true, checks: [] }),
      getLogs: async () => 'Launcher started.\nHome is ready.',
      checkForUpdate: async () => ({ updateAvailable: state === 'update-offered', latest: '2.0.1' }),
      describeFailure: async () => ({ fixLabel: null }),
      describeLegacyPc2: async () => ({ items }),
      describeResetBackup: async () => ({ present: true, enough: true, bytes: 1000, folder: '/fixture/Desktop' }),
      resumeInstallPlan: async () => 'none',
      finishResumeInstall: async () => {},
      start: action('start', () => {
        if (window.fixture.failStart) throw new Error('Home could not start.');
        window.fixture.emitStatus('running');
      }),
      stop: action('stop', () => window.fixture.emitStatus('stopped')),
      install: action('install', () => {
        callbacks.install('Downloading ElastOS');
        if (state === 'installing') return new Promise(() => {});
        window.fixture.installed = true;
      }),
      openBrowser: action('openBrowser'),
      update: action('update'), rollback: action('rollback'),
      resetRuntime: action('resetRuntime', () => window.fixture.emitStatus('not-installed')),
      uninstall: action('uninstall', () => window.fixture.emitStatus('not-installed')),
      removeLegacyPc2: action('removeLegacyPc2', () => {
        if (window.fixture.failPc2) throw new Error('Old PC2 files could not be removed.');
        items = [];
        return { ok: true, message: 'PC2 removed' };
      }),
      getDiagnostics: action('getDiagnostics', 'Diagnostics'),
      saveSupportBundle: action('saveSupportBundle'),
      openLogFolder: action('openLogFolder'),
      setOpenAtLogin: action('setOpenAtLogin', (value) => value),
      fixFailure: action('fixFailure', 'ready'),
      onActionSuccess(fn) { callbacks.success = fn; },
      onStatus(fn) { callbacks.status = fn; },
      onLog(fn) { callbacks.log = fn; },
      onInstallProgress(fn) { callbacks.install = fn; },
      onUpdateProgress(fn) { callbacks.update = fn; },
    };
  }, { state, platform });
  await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
  await page.locator('#open-btn[data-action]').waitFor();
  if (state === 'installing') {
    await page.click('#open-btn');
    await page.getByText('Installing…', { exact: true }).waitFor();
  }
  if (state === 'details-open') {
    await page.click('summary');
    await page.locator('#logs-content').filter({ hasText: 'Home is ready.' }).waitFor();
  }
  if (state === 'pc2-removed') {
    // Exercise removal from discovery through the real confirmation handler.
    await page.evaluate(() => showLegacyPc2([{ path: '/fixture/.pc2', scope: 'host', label: 'Old PC2 data', bytes: 1024 }]));
    await page.click('#remove-pc2-btn');
    await page.check('#confirm-backup');
    await page.click('#confirm-delete');
    await page.getByText('Old PC2 files removed.', { exact: true }).waitFor();
  }
  await settleRendererLayout(page);
  return { page, errors };
}

module.exports = { launchRendererBrowser, openRenderer, settleRendererLayout };
