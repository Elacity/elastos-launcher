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
  assert.match(workflow, /bash scripts\/runtime-rollback\.sh/);
  assert.match(workflow, /npm run e2e/);
  assert.match(workflow, /scripts\/legacy-upgrade-e2e\.js/);
  assert.match(workflow, /xvfb-run/);
  assert.match(workflow, /macos-14/);
  assert.match(workflow, /node scripts\/windows-app-install\.js/);
  assert.match(workflow, /bash scripts\/clean-machine-linux\.sh/);
  assert.match(workflow, /scripts\/windows-clean-machine\.ps1/);
  assert.equal(/windows-elastos-distro\.ps1/.test(
    workflow.split('windows-app:')[1] || '',
  ), false);
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

test('the smoke header does not describe a fallback install', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/runtime-smoke.sh'), 'utf8');
  const workflowHead = workflow.split('\n').slice(0, 8).join('\n');
  const scriptHead = script.split('\n').slice(0, 8).join('\n');
  assert.equal(/falls back/i.test(workflowHead), false);
  assert.equal(/falls back/i.test(scriptHead), false);
  assert.match(workflowHead, /install stops/);
  assert.match(scriptHead, /install stops/);
});

test('the smoke passes the pinned head the way the pinned installer accepts it', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/runtime-smoke.sh'), 'utf8');
  assert.match(script, /Release head signature matches the pinned maintainer/);
  assert.match(
    script,
    /env -u ELASTOS_MAINTAINER_DID -u ELASTOS_PUBLISHER_GATEWAY \\\n {2}ELASTOS_HEAD_CID="\$\{head_cid\}" \\\n {2}bash "\$\{installer\}" --install-only --maintainer-did "\$\{maintainer\}"/,
  );
  assert.equal(/--head-cid/.test(script), false);
});

test('rollback uses the real binary between alpha.19 and alpha.20', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/runtime-rollback.sh'), 'utf8');
  assert.match(script, /0\.8\.0-alpha\.19/);
  assert.match(script, /0\.8\.0-alpha\.20/);
  assert.match(script, /update --rollback-to "\$\{PREV_CID\}" --yes/);
  assert.match(script, /update --yes/);
  assert.match(script, /\/healthz is OK/);
  assert.equal(/--head-cid/.test(script), false);
  assert.match(script, /ELASTOS_RETAIN_FILE/);
});

test('the electron e2e clicks Install and waits for Open my computer', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/electron-e2e.js'), 'utf8');
  assert.match(script, /Open my computer/);
  assert.match(script, /#open-btn/);
  assert.match(script, /Release head signature matches the pinned maintainer/);
  assert.match(script, /install\.sh SHA-256 matches the pin/);
  assert.match(script, /Installed head CID matches the pin/);
  assert.match(script, /app\.exit\(0\)/);
  assert.match(script, /ELASTOS_LAUNCH_TARGET: 'runtime'/);
  assert.match(script, /ELASTOS_HIDE_HOST_TOOLS: '1'/);
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
