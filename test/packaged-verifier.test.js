const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('packaged verifier refuses a full local launch before starting Electron', () => {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/verify-mac-app.js'), '/nonexistent/ElastOS.app',
  ], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Full packaged launch runs only on the GitHub runner/);
  assert.doesNotMatch(result.stderr, /Packaged Electron failed/);
});
