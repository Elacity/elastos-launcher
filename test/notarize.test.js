const assert = require('node:assert/strict');
const test = require('node:test');
const child = require('node:child_process');

for (const status of ['Accepted', 'Invalid', 'In Progress', 'invalid-json', 'failed']) {
  test(`notarization requires Apple's Accepted verdict (${status})`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
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
        if (status === 'failed') throw new Error('submission failed');
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
      await assert.rejects(() => notarize({ artifactPaths: ['/build/ElastOS.dmg'] }));
      assert.equal(calls.length, 1);
    }
  });
}
