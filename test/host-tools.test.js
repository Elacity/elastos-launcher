const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Writable } = require('node:stream');

const { extractTarGz } = require('../dist/main/targets/hostArchive');
const { runCurl, formatSha256Sum } = require('../dist/main/targets/hostToolEntry');
const {
  BASH_MESSAGE,
  MUSL_MESSAGE,
  PYTHON_VERIFY_MESSAGE,
  prepareInstallerEnvironment,
} = require('../dist/main/targets/hostTools');
const { evaluatePreflight } = require('../dist/main/targets/preflight');

const glibc = () => ['ld-linux-x86-64.so.2'];
const bashOk = () => true;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elastos-host-'));
}

function bodyFrom(text) {
  const data = Buffer.from(text);
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: data };
        },
        async cancel() {},
      };
    },
    async cancel() {},
  };
}

function curlDeps(fetchImpl, files) {
  return {
    fetch: fetchImpl,
    writeFile: (file, data) => { files.set(file, data); },
    stdout: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
    sleep: async () => {},
  };
}

function pythonArchive(dir) {
  const src = path.join(dir, 'src');
  const bin = path.join(src, 'python', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const longDir = path.join(src, 'python', 'lib', 'd'.repeat(90));
  fs.mkdirSync(longDir, { recursive: true });
  fs.writeFileSync(path.join(longDir, 'mod.py'), 'print("ok")\n');
  fs.writeFileSync(path.join(bin, 'python3.12'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('python3.12', path.join(bin, 'python3'));
  const tarball = path.join(dir, 'python.tar.gz');
  execFileSync('tar', ['--format=posix', '-czf', tarball, '-C', src, 'python']);
  return fs.readFileSync(tarball);
}

function pinFor(bytes) {
  return {
    release: 'test',
    version: '0',
    assets: {
      'linux-x64': {
        url: 'https://example.com/python.tar.gz',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      },
    },
  };
}

test('curl refuses a non-https URL and an https redirect to http', async () => {
  const files = new Map();
  const seen = [];
  const refused = await runCurl(
    ['--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '-fsSL', 'http://127.0.0.1/release.json'],
    curlDeps(async (url) => {
      seen.push(String(url));
      return { status: 200, headers: new Headers(), body: bodyFrom('no') };
    }, files),
  );
  assert.equal(refused.code, 1);
  assert.equal(seen.length, 0);

  const redirected = await runCurl(
    ['--proto', '=https', '--proto-redir', '=https', '-fsSL', 'https://publisher.example/release.json'],
    curlDeps(async (url) => {
      seen.push(String(url));
      return {
        status: 302,
        headers: new Headers({ location: 'http://publisher.example/release.json' }),
        body: bodyFrom(''),
      };
    }, files),
  );
  assert.equal(redirected.code, 1);
  assert.deepEqual(seen, ['https://publisher.example/release.json']);
});

test('curl -f uses exit 22 for HTTP errors and --max-redirs 0 does not follow', async () => {
  const files = new Map();
  const missing = await runCurl(
    ['-f', '-o', 'out', 'https://publisher.example/missing'],
    curlDeps(async () => ({ status: 404, headers: new Headers(), body: bodyFrom('no') }), files),
  );
  assert.equal(missing.code, 22);
  assert.equal(files.size, 0);

  const seen = [];
  const stopped = await runCurl(
    ['-fsSL', '--max-redirs', '0', 'https://publisher.example/file'],
    curlDeps(async (url) => {
      seen.push(String(url));
      return {
        status: 302,
        headers: new Headers({ location: 'https://publisher.example/other' }),
        body: bodyFrom(''),
      };
    }, files),
  );
  assert.equal(stopped.code, 47);
  assert.deepEqual(seen, ['https://publisher.example/file']);
});

test('curl writes the body and sha256sum prints a GNU line', async () => {
  const files = new Map();
  const saved = await runCurl(
    ['-fsSL', '--retry', '1', '--retry-all-errors', '-o', 'elastos', 'https://publisher.example/elastos'],
    curlDeps(async () => {
      if (files.get('tries')) {
        return { status: 200, headers: new Headers(), body: bodyFrom('binary') };
      }
      files.set('tries', Buffer.from('1'));
      throw new Error('reset');
    }, files),
  );
  assert.equal(saved.code, 0);
  assert.equal(files.get('elastos').toString(), 'binary');

  const dir = tempDir();
  const file = path.join(dir, 'blob');
  fs.writeFileSync(file, 'binary');
  const line = formatSha256Sum(file, fs.readFileSync(file));
  assert.equal(line.split(' ')[0], crypto.createHash('sha256').update('binary').digest('hex'));
  assert.equal(line.endsWith(`  ${file}\n`), true);
});

test('a hidden or stub python is provisioned and a working one is reused', async () => {
  const dir = tempDir();
  const bytes = pythonArchive(dir);
  const pin = pinFor(bytes);
  let downloads = 0;
  const prepared = await prepareInstallerEnvironment({
    homeDir: dir,
    platform: 'linux',
    arch: 'x64',
    env: { ...process.env, ELASTOS_HIDE_HOST_TOOLS: '1', PATH: '/usr/bin' },
    pin,
    listLib: glibc,
    canExec: bashOk,
    download: async () => {
      downloads += 1;
      return bytes;
    },
  });
  assert.equal(prepared.bash, '/bin/bash');
  assert.equal(downloads, 1);
  const python = spawnSync('python3', ['-c', ''], { env: prepared.env, encoding: 'utf8' });
  assert.equal(python.status, 0);
  const which = spawnSync('bash', ['-lc', 'command -v python3'], { env: prepared.env, encoding: 'utf8' });
  assert.match(which.stdout, /\/python\/bin\/python3\n$/);
  const sum = spawnSync('sha256sum', [path.join(dir, 'src', 'python', 'lib', 'd'.repeat(90), 'mod.py')], {
    env: prepared.env,
    encoding: 'utf8',
  });
  assert.equal(sum.status, 0);
  assert.equal(sum.stdout.split(' ')[0].length, 64);

  await prepareInstallerEnvironment({
    homeDir: dir,
    platform: 'linux',
    arch: 'x64',
    env: { ...process.env, ELASTOS_HIDE_HOST_TOOLS: '1', PATH: '/usr/bin' },
    pin,
    listLib: glibc,
    canExec: bashOk,
    download: async () => {
      downloads += 1;
      return bytes;
    },
  });
  assert.equal(downloads, 1);

  let skipped = 0;
  const system = await prepareInstallerEnvironment({
    homeDir: path.join(dir, 'system'),
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '/usr/bin' },
    pin,
    listLib: glibc,
    canExec: bashOk,
    pythonRuns: (command) => command === 'python3',
    download: async () => {
      skipped += 1;
      return bytes;
    },
  });
  assert.equal(skipped, 0);
  assert.equal(system.env.PATH.startsWith(path.join(dir, 'system', '.elastos-launcher', 'tools')), true);
  assert.equal(system.env.PATH.includes(`${path.sep}python${path.sep}bin`), false);
});

test('a tampered python archive is refused and nothing is unpacked', async () => {
  const published = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/host-python.json'), 'utf8'));
  const assets = Object.values(published.assets);
  assert.equal(assets.length, 3);
  for (const asset of assets) {
    assert.match(asset.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/20261013\//);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }

  const dir = tempDir();
  const bytes = pythonArchive(dir);
  const pin = pinFor(bytes);
  const tampered = Buffer.from(bytes);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  assert.notEqual(crypto.createHash('sha256').update(tampered).digest('hex'), pin.assets['linux-x64'].sha256);

  const home = path.join(dir, 'tampered');
  await assert.rejects(
    () => prepareInstallerEnvironment({
      homeDir: home,
      platform: 'linux',
      arch: 'x64',
      env: { ELASTOS_HIDE_HOST_TOOLS: '1', PATH: '/usr/bin' },
      pin,
      listLib: glibc,
      canExec: bashOk,
      download: async () => tampered,
    }),
    (err) => {
      assert.equal(err.message, PYTHON_VERIFY_MESSAGE);
      assert.equal(/xcode-select|terminal|apt-get/.test(err.message), false);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(home, '.elastos-launcher', 'python', '.sha256')), false);
  assert.equal(fs.existsSync(path.join(home, '.elastos-launcher', 'python', 'python', 'bin', 'python3')), false);
});

test('musl and a missing shell block install, and a bad python hash is refused', async () => {
  const dir = tempDir();
  await assert.rejects(
    () => prepareInstallerEnvironment({
      homeDir: dir,
      platform: 'linux',
      arch: 'x64',
      env: {},
      listLib: () => ['ld-musl-x86_64.so.1'],
      canExec: bashOk,
    }),
    (err) => {
      assert.equal(err.message, MUSL_MESSAGE);
      assert.equal(/xcode-select|apt-get|brew |sudo /.test(err.message), false);
      return true;
    },
  );
  await assert.rejects(
    () => prepareInstallerEnvironment({
      homeDir: dir,
      platform: 'linux',
      arch: 'x64',
      env: {},
      listLib: glibc,
      canExec: () => false,
    }),
    (err) => {
      assert.equal(err.message, BASH_MESSAGE);
      assert.equal(/apt-get|brew |sudo /.test(err.message), false);
      return true;
    },
  );

  const bytes = pythonArchive(dir);
  const pin = pinFor(bytes);
  await assert.rejects(
    () => prepareInstallerEnvironment({
      homeDir: path.join(dir, 'bad'),
      platform: 'linux',
      arch: 'x64',
      env: { ELASTOS_HIDE_HOST_TOOLS: '1', PATH: '/usr/bin' },
      pin,
      listLib: glibc,
      canExec: bashOk,
      download: async () => Buffer.from('not-the-archive'),
    }),
    (err) => {
      assert.equal(err.message, PYTHON_VERIFY_MESSAGE);
      assert.equal(/xcode-select/.test(err.message), false);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(dir, 'bad', '.elastos-launcher', 'python', '.sha256')), false);

  const report = evaluatePreflight({
    platform: 'linux',
    arch: 'x64',
    freeBytes: 3 * 1024 * 1024 * 1024,
    portBusy: false,
    healthOk: false,
    offline: false,
    wsl: false,
    kvm: false,
    libc: 'musl',
    bashPresent: false,
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.find((check) => check.id === 'libc').message, /musl/);
  assert.equal(report.checks.find((check) => check.id === 'kvm'), undefined);
});

test('the python archive cannot escape its folder or follow a symlink', () => {
  const dir = tempDir();
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'python'), { recursive: true });
  fs.symlinkSync(outside, path.join(src, 'python', 'escape'));
  const tarball = path.join(dir, 'bad.tar.gz');
  execFileSync('tar', ['--format=posix', '-czf', tarball, '-C', src, 'python']);
  const dest = path.join(dir, 'out');
  assert.throws(() => extractTarGz(fs.readFileSync(tarball), dest), /outside its folder/);
  assert.equal(fs.existsSync(path.join(outside, 'owned')), false);

  const header = Buffer.alloc(512);
  header.write('../escape');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('00000000014\0', 124);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const payload = Buffer.concat([Buffer.from('owned-file-ok\n'), Buffer.alloc(512), Buffer.alloc(1024)]);
  const raw = Buffer.concat([header, payload]);
  const packed = require('node:zlib').gzipSync(raw);
  assert.throws(() => extractTarGz(packed, path.join(dir, 'escape-out')), /outside its folder/);
  assert.equal(fs.existsSync(path.join(dir, 'escape')), false);
});

test('the installer path never asks for Xcode Command Line Tools', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (file.endsWith('.ts') || file.endsWith('.js')) files.push(file);
    }
  };
  walk(root);
  const hit = files.filter((file) => fs.readFileSync(file, 'utf8').includes('xcode-select'));
  assert.deepEqual(hit, []);
});
