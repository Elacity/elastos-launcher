const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { states, launchRendererBrowser, openRenderer } = require('./renderer-fixture');

test('real small window: every state fits, has keyboard focus and no hidden controls leak', { timeout: 60000 }, async () => {
  const browser = await launchRendererBrowser();
  const shots = process.env.ELASTOS_RENDERER_SHOTS;
  try {
    if (shots) await fs.mkdir(shots, { recursive: true });
    for (const platform of ['darwin', 'win32', 'linux']) for (const state of Object.keys(states)) {
      const { page, errors } = await openRenderer(browser, { state, platform });
      assert.deepEqual(errors, []);
      const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth,
        bottom: document.querySelector('main').getBoundingClientRect().bottom, height: innerHeight,
        hiddenLeaks: [...document.querySelectorAll('[hidden]')].filter(e => getComputedStyle(e).display !== 'none').length }));
      assert.equal(size.width, 360); assert.ok(size.bottom <= size.height); assert.equal(size.hiddenLeaks, 0);
      assert.equal(await page.locator('#login-row').isVisible(), state === 'install');
      assert.equal(await page.locator('#progress').isVisible(), state === 'progress');
      if (state !== 'progress') {
        assert.equal(await page.locator('#primary').evaluate(e => e.getBoundingClientRect().height >= 44), true);
        assert.equal(await page.locator('#primary').evaluate(e => document.activeElement === e), true);
        if (state === 'update') assert.equal(await page.locator('#cancel').evaluate(e => {
          const range=document.createRange();range.selectNodeContents(e);return range.getClientRects().length;
        }),1,'Not Now stays on one line');
      }
      for (const control of await page.locator('button, input, a').all()) if (await control.isVisible()) {
        assert.equal(await control.evaluate(e => getComputedStyle(e).webkitAppRegion), 'no-drag');
      }
      if (shots) await page.screenshot({ path: path.join(shots, `${platform}-${state}.png`) });
      console.log(`PASS renderer ${platform}/${state}: ${size.width} × ${size.height}, overflow 0, hidden leaks 0`);
      await page.close();
    }
    if (shots) for (const state of Object.keys(states)) {
      const {page} = await openRenderer(browser, {state, colorScheme:'dark'});
      await page.screenshot({path:path.join(shots,`darwin-${state}-dark.png`)}); await page.close();
    }
  } finally { await browser.close(); }
});
test('real window controls honor consent, Return, Escape, update cancellation and diagnostics', async () => {
  const browser = await launchRendererBrowser();
  try {
    const { page } = await openRenderer(browser);
    assert.equal(await page.locator('#login').isChecked(), true);
    await page.uncheck('#login'); await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [['install', false]]);
    await page.keyboard.press('Escape');
    assert.deepEqual((await page.evaluate(() => window.fixture.calls)).at(-1), ['closeWindow']);
    await page.evaluate(() => window.fixture.render({kind:'error',message:'The download stopped.',actionLabel:'Try Again'}));
    await page.click('#diagnostics');
    assert.equal(await page.locator('#diagnostics').textContent(), 'Copied');
    await page.click('#primary');
    assert.deepEqual((await page.evaluate(() => window.fixture.calls)).at(-1), ['retry']);
    await page.evaluate(() => window.fixture.render({kind:'update',message:'Update ElastOS to 2.0.1?',releaseNotes:true}));
    await page.click('#release-notes'); await page.click('#cancel'); await page.click('#primary');
    assert.deepEqual((await page.evaluate(() => window.fixture.calls)).slice(-3), [['releaseNotes'],['closeWindow'],['update']]);
    await page.evaluate(() => window.fixture.render({kind:'install',ready:true,message:'Home is ready.'}));
    await page.keyboard.press('Enter');
    assert.deepEqual((await page.evaluate(() => window.fixture.calls)).at(-1), ['openHome']);
  } finally { await browser.close(); }
});
