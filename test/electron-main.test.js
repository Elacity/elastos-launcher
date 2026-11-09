const assert = require('node:assert/strict');
const test = require('node:test');
const { readMain } = require('../scripts/electron-main');

test('main observations run outside the inspector stack and preserve results and errors', async () => {
  let inside = false, calls = 0;
  const electron = { read(value) { assert.equal(inside, false); calls++; return value; } };
  const app = { async evaluate(fn, arg) {
    inside = true;
    let result;
    try { result = fn(electron, arg); } finally { inside = false; }
    return result;
  } };
  assert.deepEqual(await readMain(app, (e, value) => e.read(value), { ready: true }), { ready: true });
  assert.equal(calls, 1);
  await assert.rejects(readMain(app, () => { throw new Error('observation failed'); }), /observation failed/);
  const closed = new Error('Electron exited');
  await assert.rejects(readMain({ evaluate: async () => { throw closed; } }, () => true), error => error === closed);
});
