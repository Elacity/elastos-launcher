const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/runtime-smoke.yml'), 'utf8');
const windows = fs.readFileSync(path.join(root, 'scripts/windows-elastos-distro.ps1'), 'utf8');

test('the runtime smoke workflow has no continue-on-error', () => {
  assert.equal(/continue-on-error/i.test(workflow), false);
  assert.equal(/\|\|\s*true/.test(workflow), false);
  assert.match(workflow, /ubuntu-24\.04/);
  assert.match(workflow, /macos-14/);
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /bash scripts\/runtime-smoke\.sh/);
  assert.match(workflow, /pwsh -File scripts\/windows-elastos-distro\.ps1/);
});

test('a missing wsl.exe fails the Windows job', () => {
  assert.equal(/SMOKE_SKIPPED/.test(windows), false);
  assert.equal(/\bexit 0\b/.test(windows), false);
  assert.match(
    windows,
    /if \(-not \(Get-Command wsl\.exe -ErrorAction SilentlyContinue\)\) \{\s*Write-Host 'wsl\.exe is not installed\.'\s*exit 1\s*\}/,
  );
  assert.match(windows, /exit \$code\s*$/);
  assert.match(windows, /\.Replace\('\\', '\/'\)/);
  assert.match(windows, /if \(\$null -eq \$unixRaw\) \{\s*Write-Host 'wslpath did not return a Linux path\.'\s*exit 1\s*\}/);
});

test('the flattened smoke pin keeps the installer hash', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/runtime-smoke.sh'), 'utf8');
  const match = script.match(/python3 - "\$\{raw_pin\}" "\$\{work\}\/pin\.json" <<'PY'\n([\s\S]*?)\nPY/);
  assert.ok(match, 'smoke flatten block');
  const pin = path.join(root, 'resources/runtime-pin.json');
  const out = path.join(os.tmpdir(), `elastos-pin-flat-${process.pid}.json`);
  const result = spawnSync('python3', ['-', pin, out], { input: match[1], encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const flat = JSON.parse(fs.readFileSync(out, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(pin, 'utf8'));
  assert.equal(flat.installerSha256, raw.installerSha256);
  assert.match(flat.installerSha256, /^[0-9a-f]{64}$/);
  assert.equal(flat.channel, 'canary');
  assert.equal(flat.headCid, raw.channels.canary.headCid);
});
