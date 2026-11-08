const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchRendererBrowser, openRenderer, settleRendererLayout } = require('./renderer-fixture');

const states = ['not-installed', 'installing', 'running', 'stopped', 'error', 'update-offered', 'pc2-found', 'pc2-removed', 'details-open'];

test('real renderer hides every hidden element and fits every launcher state', { timeout: 60000 }, async () => {
  const browser = await launchRendererBrowser();
  const shots = process.env.ELASTOS_RENDERER_SHOTS;
  try {
    if (shots) await fs.mkdir(shots, { recursive: true });
    const reports = [];
    for (const state of states) {
      const { page, errors } = await openRenderer(browser, { state });
      try {
        assert.deepEqual(errors, [], state);
        const leaked = await page.locator('.hidden').evaluateAll((nodes) => nodes
          .filter((node) => getComputedStyle(node).display !== 'none').map((node) => node.id));
        assert.deepEqual(leaked, [], `${state} hidden elements`);
        assert.equal(await page.locator('#browser-row').isVisible(), false, `${state} Mac Browser note`);
        assert.equal(await page.locator('#remove-pc2-btn').isVisible(), state === 'pc2-found');
        assert.equal(await page.locator('#remove-pc2-btn').textContent(), 'Remove old PC2 files');
        const height = await page.evaluate(() => window.fixture.height);
        await page.setViewportSize({ width: 420, height });
        await settleRendererLayout(page);
        const geometry = await page.evaluate(() => {
          const main = document.querySelector('main').getBoundingClientRect();
          const bottom = document.querySelector('#details').getBoundingClientRect().bottom;
          const strip = document.querySelector('.title-bar').getBoundingClientRect();
          return { contentHeight: document.querySelector('#window-content').getBoundingClientRect().height,
            viewportHeight: innerHeight, bottomPadding: main.bottom - bottom,
            width: document.documentElement.scrollWidth, stripWidth: strip.width, stripTop: strip.top };
        });
        assert.equal(geometry.contentHeight, height, `${state} stable height`);
        assert.equal(geometry.viewportHeight, height);
        assert.equal(geometry.bottomPadding, 24, `${state} ends at content padding`);
        assert.equal(geometry.width, 420, `${state} no horizontal overflow`);
        assert.equal(geometry.stripWidth, 420);
        assert.equal(geometry.stripTop, 0);
        if (shots) await page.screenshot({ path: path.join(shots, `${state}.png`) });
        if (state === 'pc2-removed') {
          await page.click('summary');
          assert.match(await page.locator('#logs-content').textContent(), /Old PC2 files removed/);
        }
        reports.push({ state, height, emptyBelowContent: 0 });
        console.log(`PASS renderer ${state}: ${height}px, empty below content 0px, hidden leaks 0`);
      } finally { await page.close(); }
    }
    if (shots) await fs.writeFile(path.join(shots, 'heights.json'), JSON.stringify(reports, null, 2) + '\n');
  } finally { await browser.close(); }
});

test('real renderer actions recover errors, dispatch retry by installation, and open Home links', { timeout: 60000 }, async () => {
  const browser = await launchRendererBrowser();
  try {
    for (const installed of [true, false]) {
      const { page, errors } = await openRenderer(browser, { state: 'error' });
      await page.evaluate((installed) => { window.fixture.installed = installed; }, installed);
      await page.click('#open-btn');
      await page.getByText('Home is running', { exact: true }).waitFor();
      const calls = await page.evaluate(() => window.fixture.calls.map((call) => call.name));
      assert.equal(calls.filter((name) => name === 'install').length, installed ? 0 : 1);
      assert.equal(calls.filter((name) => name === 'start').length, 1);
      await page.click('#url-value');
      assert.ok(await page.evaluate(() => window.fixture.calls.some((call) => call.name === 'openBrowser')));
      assert.deepEqual(errors, []);
      await page.close();
    }
    const { page } = await openRenderer(browser, { state: 'pc2-found' });
    await page.evaluate(() => { window.fixture.failPc2 = true; });
    await page.click('#remove-pc2-btn');
    assert.match(await page.locator('#confirm-body').innerText(), /earlier ElastOS Personal Cloud app/);
    await page.click('#confirm-delete');
    await page.locator('#status-text').filter({ hasText: 'could not be removed' }).waitFor();
    assert.equal(await page.locator('#remove-pc2-btn').isVisible(), true);
    await page.evaluate(() => window.fixture.emitStatus('stopped'));
    assert.match(await page.locator('#status-text').innerText(), /could not be removed/);
    await page.evaluate(() => { window.fixture.callbacks.success(); window.fixture.emitStatus('stopped'); });
    assert.equal(await page.locator('#status-text').innerText(), 'Home is stopped');
    await page.click('#open-btn');
    await page.getByText('Home is running', { exact: true }).waitFor();
    await page.close();
    for (const platform of ['win32', 'linux']) {
      const { page, errors } = await openRenderer(browser, { platform });
      assert.equal(await page.locator('#browser-row').isVisible(), platform === 'win32');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('CI renderer selectors refer to elements in the real interface', async () => {
  const html = await fs.readFile(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1]));
  const scripts = ['electron-e2e.js', 'legacy-upgrade-e2e.js', 'mac-dialog-e2e.js',
    'mac-lifecycle-e2e.js', 'linux-lifecycle-e2e.js', 'windows-lifecycle-e2e.js'];
  for (const script of scripts) {
    const source = await fs.readFile(path.join(__dirname, '../scripts', script), 'utf8');
    const selectors = [...source.matchAll(/(?:locator|querySelector|click|check)\(['"]#([\w-]+)/g)];
    for (const [, id] of selectors) assert.ok(ids.has(id), `${script} refers to missing #${id}`);
  }
});

test('real confirmation screens fit their content and preserve backup consent', { timeout: 60000 }, async () => {
  const browser = await launchRendererBrowser();
  const shots = process.env.ELASTOS_RENDERER_SHOTS;
  const reports = [];
  try {
    for (const [name, trigger] of [['reset-dialog', '#reset-btn'], ['uninstall-dialog', '#uninstall-btn'], ['pc2-dialog', '#remove-pc2-btn']]) {
      const { page, errors } = await openRenderer(browser, { state: 'pc2-found' });
      if (name !== 'pc2-dialog') await page.click('summary');
      await page.click(trigger);
      await page.locator('#confirm-modal').waitFor({ state: 'visible' });
      if (name === 'reset-dialog') {
        assert.equal(await page.locator('#confirm-delete').isDisabled(), true);
        await page.check('#reset-backup-yes');
        assert.equal(await page.locator('#confirm-delete').isEnabled(), true);
      }
      if (name === 'pc2-dialog') {
        assert.match(await page.locator('#confirm-body').textContent(), /earlier ElastOS Personal Cloud app/);
        assert.match(await page.locator('#confirm-path').textContent(), /\/fixture\/\.pc2/);
        await page.check('#confirm-backup');
      }
      await settleRendererLayout(page);
      const height = await page.evaluate(() => window.fixture.height);
      await page.setViewportSize({ width: 420, height });
      const geometry = await page.evaluate(() => ({
        height: document.querySelector('#window-content').getBoundingClientRect().height,
        bottom: document.querySelector('#confirm-modal').getBoundingClientRect().bottom,
        mainBottom: document.querySelector('main').getBoundingClientRect().bottom,
        leaks: [...document.querySelectorAll('.hidden')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id),
      }));
      assert.equal(geometry.height, height);
      assert.equal(geometry.mainBottom - geometry.bottom, 24);
      assert.deepEqual(geometry.leaks, []);
      assert.deepEqual(errors, []);
      if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
      reports.push({ state: name, height, emptyBelowContent: 0 });
      console.log(`PASS renderer ${name}: ${height}px, empty below content 0px, hidden leaks 0`);
      await page.click('#confirm-cancel');
      assert.equal(await page.locator('#confirm-modal').isVisible(), false);
      await page.close();
    }
    if (shots) await fs.writeFile(path.join(shots, 'dialogs.json'), JSON.stringify(reports, null, 2) + '\n');
  } finally { await browser.close(); }
});
