const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  probeRuntimeInstallation,
  RUNTIME_VERSION_ARGS,
  UnsupportedRuntimePlatformError,
  unsupportedPlatformError,
} = require('../dist/main/targets');

function writeFakeElastos(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'elastos');
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

const VERSION_SCRIPT = `#!/bin/sh
if [ "$1" = "version" ] && [ "$#" -eq 1 ]; then
  echo "0.7.1"
  exit 0
fi
echo "refusing: $*" >&2
exit 2
`;

test('a fixture elastos on PATH parses version and only runs version', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-path-'));
  writeFakeElastos(binDir, VERSION_SCRIPT);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-home-'));

  const result = await probeRuntimeInstallation({
    platform: 'linux',
    arch: 'x64',
    homeDir: home,
    pathEnv: binDir,
  });

  assert.equal(result.kind, 'version');
  assert.equal(result.version, '0.7.1');
  assert.equal(result.binaryPath, path.join(binDir, 'elastos'));
  assert.deepEqual(RUNTIME_VERSION_ARGS, ['version']);
});

test('darwin-x64 probes the binary the same way as arm64', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-intel-'));
  writeFakeElastos(binDir, VERSION_SCRIPT);
  const result = await probeRuntimeInstallation({
    platform: 'darwin',
    arch: 'x64',
    homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-intel-home-')),
    pathEnv: binDir,
  });
  assert.equal(result.kind, 'version');
  assert.equal(result.version, '0.7.1');
});

test('the home install path wins over PATH', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-prefer-'));
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-other-'));
  writeFakeElastos(path.join(home, '.local', 'bin'), '#!/bin/sh\necho "9.9.9"\n');
  writeFakeElastos(pathDir, VERSION_SCRIPT);
  const result = await probeRuntimeInstallation({
    platform: 'linux',
    arch: 'arm64',
    homeDir: home,
    pathEnv: pathDir,
  });
  assert.equal(result.kind, 'version');
  assert.equal(result.version, '9.9.9');
  assert.equal(result.binaryPath, path.join(home, '.local', 'bin', 'elastos'));
});

test('win32 is unsupported and does not exec', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-win-'));
  writeFakeElastos(binDir, VERSION_SCRIPT);
  let called = false;
  const result = await probeRuntimeInstallation({
    platform: 'win32',
    arch: 'x64',
    homeDir: binDir,
    pathEnv: binDir,
    execFile: async () => {
      called = true;
      return { stdout: 'should-not-run', stderr: '' };
    },
  });
  assert.equal(result.kind, 'unsupported-platform');
  assert.equal(called, false);
  const error = unsupportedPlatformError(result);
  assert.ok(error instanceof UnsupportedRuntimePlatformError);
  assert.equal(error.code, 'UNSUPPORTED_RUNTIME_PLATFORM');
});

test('a supported host with no binary does not exec', async () => {
  let called = false;
  const result = await probeRuntimeInstallation({
    platform: 'linux',
    arch: 'x64',
    homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-probe-missing-')),
    pathEnv: '',
    execFile: async () => {
      called = true;
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(result.kind, 'not-installed');
  assert.equal(called, false);
});
