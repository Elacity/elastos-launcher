const assert = require('node:assert/strict');
const fs = require('node:fs');
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
});
