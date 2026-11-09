const assert = require('node:assert/strict');
const test = require('node:test');
const child = require('node:child_process');

test('a release build refuses to skip notarization', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  for (const [key, value] of Object.entries({ NOTARIZE_MAC: 'false', MAC_RELEASE_STRICT: 'true' })) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  t.mock.method(child, 'execFileSync', () => assert.fail('Apple must not be contacted'));
  delete require.cache[require.resolve('../scripts/notarize')];
  await assert.rejects(require('../scripts/notarize')({ artifactPaths: ['/build/ElastOS.dmg'] }), /must be notarized/);
});

for (const status of ['Accepted', 'Invalid', 'In Progress', 'invalid-json', 'failed']) {
  test(`notarization requires Apple's Accepted verdict (${status})`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    for (const key of ['NOTARIZE_MAC', 'MAC_RELEASE_STRICT']) {
      const old = process.env[key];
      process.env[key] = 'true';
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
      const old = process.env[key];
      process.env[key] = 'test-credential';
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    const calls = [];
    t.mock.method(child, 'execFileSync', (file, args, options) => {
      calls.push([file, args]);
      assert.equal(JSON.stringify(args).includes('test-credential'), false);
      if (file === '/usr/bin/expect') {
        assert.equal(options.env.APPLE_APP_SPECIFIC_PASSWORD, 'test-credential');
        assert.match(args[1], /--wait/);
        assert.match(args[1], /--timeout 25m/);
        if (status === 'failed') throw Object.assign(new Error('submission failed'), { status: 1, stdout: 'test-credential authentication failed' });
        return status === 'invalid-json' ? 'not JSON' : JSON.stringify({ status, id: 'submission-id' });
      }
      return '';
    });
    delete require.cache[require.resolve('../scripts/notarize')];
    const notarize = require('../scripts/notarize');
    if (status === 'Accepted') {
      await notarize({ artifactPaths: ['/build/ElastOS.dmg'] });
      assert.deepEqual(calls.slice(1).map((call) => call[1]), [
        ['stapler', 'staple', '/build/ElastOS.dmg'], ['stapler', 'validate', '/build/ElastOS.dmg'],
      ]);
    } else {
      await assert.rejects(() => notarize({ artifactPaths: ['/build/ElastOS.dmg'] }), (error) => {
        assert.equal(error.message.includes('test-credential'), false);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  });
}

for (const enabled of [false, true]) {
  test(`test builds survive unavailable notarization (requested=${enabled})`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    for (const [key, value] of Object.entries({ NOTARIZE_MAC: String(enabled), MAC_RELEASE_STRICT: 'false', APPLE_ID: '' })) {
      const old = process.env[key];
      process.env[key] = value;
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    t.mock.method(child, 'execFileSync', () => { throw new Error('Apple is unavailable'); });
    delete require.cache[require.resolve('../scripts/notarize')];
    await require('../scripts/notarize')({ artifactPaths: ['/build/ElastOS.dmg'] });
  });
}
