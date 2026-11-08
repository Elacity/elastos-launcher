const assert = require('node:assert/strict');
const test = require('node:test');

const { installedGatewayKind } = require('../dist/main/targets/runtimeGateway');

test('a proved kernel path accepts a gateway whose command does not start with that path', () => {
  const kernel = '/Users/example/.local/share/elastos/elastos';
  const facts = {
    lockText: JSON.stringify({ pid: 10, addr: 'localhost:8090' }),
    verifiedExecutable: kernel,
    pidAlive: () => true,
    ownsSocket: () => true,
  };
  assert.equal(installedGatewayKind({
    ...facts,
    command: 'elastos gateway --addr localhost:8090',
  }), 'current');
  assert.equal(installedGatewayKind({
    ...facts,
    command: 'elastos serve',
  }), null);
});
