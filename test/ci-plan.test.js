const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const workflows = Object.fromEntries(['test', 'runtime-smoke', 'linux-arm64', 'build'].map((name) => [
  name, yaml.load(fs.readFileSync(path.join(root, `.github/workflows/${name}.yml`), 'utf8')),
]));

// Import the actual planner only inside tests, so the original YAML policy
// checks can also run before the planner exists.
const plan = (context) => require('../scripts/ci-plan').plan(context);

for (const [name, workflow] of Object.entries(workflows)) {
  test(`${name} cancels superseded runs in a distinct workflow group`, () => {
    assert.equal(workflow.concurrency?.['cancel-in-progress'], true);
    assert.equal(workflow.concurrency.group, `${name}-` + '${{ github.head_ref || github.ref }}');
  });
  if (workflow.on.pull_request !== undefined) {
    test(`${name} ignores documentation-only pull requests`, () => {
      assert.deepEqual(workflow.on.pull_request['paths-ignore'], ['**/*.md', 'docs/**']);
    });
  }
}

test('every platform job depends on and checks the shared plan', () => {
  for (const name of ['runtime-smoke', 'linux-arm64', 'build']) {
    const workflow = workflows[name];
    assert.equal(workflow.jobs.plan['runs-on'], 'ubuntu-latest');
    const step = workflow.jobs.plan.steps.find((step) => step.run === 'node scripts/ci-plan.js');
    assert.ok(step, `${name} runs the real planner`);
    assert.equal(step.env.INPUT_PLATFORMS, '${{ inputs.platforms }}');
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id === 'plan') continue;
      assert.ok(job.needs.includes('plan'), `${name}/${id} needs plan`);
      assert.match(job.if, /needs\.plan\.outputs\.platforms/, `${name}/${id} checks plan`);
    }
  }
});

test('manual dispatch defaults to none and build keeps tag-only automatic triggers', () => {
  for (const name of ['runtime-smoke', 'linux-arm64', 'build']) {
    assert.equal(workflows[name].on.workflow_dispatch.inputs.platforms.default, 'none');
  }
  assert.deepEqual(Object.keys(workflows.build.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflows.build.on.push, { tags: ['v*'] });
  assert.equal(workflows.build.on.workflow_dispatch.inputs.notarize.default, false);
  assert.equal(workflows.build.jobs.build.env.NOTARIZE_MAC, '${{ inputs.notarize == true }}');
  assert.equal(workflows.build.jobs['linux-arm64'].with.platforms, 'linux');
  assert.equal(workflows.build.jobs.release.steps.find((step) => step.uses?.startsWith('softprops/')).uses,
    'softprops/action-gh-release@v2');
  for (const name of ['test', 'runtime-smoke', 'linux-arm64']) {
    assert.deepEqual(workflows[name].on.push, { branches: ['main'] });
  }
});

test('only HEAD is packaged for Mac dialogs and workflows contain no obsolete release', () => {
  const steps = workflows['runtime-smoke'].jobs['mac-dialogs'].steps;
  assert.ok(steps.some((step) => step.run === 'node scripts/mac-dialog-e2e.js dist-electron/mac-arm64/ElastOS.app'));
  for (const workflow of Object.values(workflows)) {
    assert.doesNotMatch(JSON.stringify(workflow), /a66ca52|launcher-baseline|0\.8\.0-alpha\.22/);
  }
});

for (const [branch, expected] of [
  ['test/launcher-mac-dmg', ['mac']], ['test/launcher-mac-other', ['mac']],
  ['test/launcher-jetson', ['linux']], ['test/launcher-linux-x64', ['linux']],
  ['test/launcher-windows', ['windows']], ['feature/unknown', []],
  ['test/launcher-macos', ['mac']], ['feature/test/launcher-mac', []],
]) {
  for (const eventName of ['pull_request', 'push']) {
    test(`${eventName} ${branch} selects ${expected.join(',') || 'none'}`, () => {
      assert.deepEqual(plan({ eventName, ref: `refs/heads/${branch}`, headRef: branch, baseRef: 'develop' }).platforms, expected);
    });
  }
}

test('main takes precedence over a platform PR head and a push ignores head/base fields', () => {
  const all = ['mac', 'linux', 'windows'];
  assert.deepEqual(plan({ eventName: 'pull_request', ref: 'refs/pull/63/merge', headRef: 'test/launcher-mac-dmg', baseRef: 'main' }).platforms, all);
  assert.deepEqual(plan({ eventName: 'push', ref: 'refs/heads/main' }).platforms, all);
  assert.deepEqual(plan({ eventName: 'push', ref: 'refs/heads/unknown', headRef: 'test/launcher-mac-dmg', baseRef: 'main' }).platforms, []);
  assert.deepEqual(plan({ eventName: 'push', ref: 'refs/tags/v2.0.0' }).platforms, all);
});

test('dispatch is explicit even on main and reusable calls accept the caller selection', () => {
  for (const requested of ['none', 'mac', 'linux', 'windows', 'all']) {
    const expected = requested === 'all' ? ['mac', 'linux', 'windows'] : requested === 'none' ? [] : [requested];
    assert.deepEqual(plan({ eventName: 'workflow_dispatch', ref: 'refs/heads/main', requested }).platforms, expected);
  }
  assert.deepEqual(plan({ eventName: 'workflow_dispatch', ref: 'refs/heads/main' }).platforms, []);
  assert.deepEqual(plan({ eventName: 'push', ref: 'refs/tags/v2.0.0', requested: 'linux' }).platforms, ['linux']);
  assert.throws(() => plan({ eventName: 'workflow_dispatch', requested: 'bogus' }), /Invalid platforms/);
});

test('runtime and build matrices contain only selected platforms, preserving both Linux architectures', () => {
  assert.deepEqual(plan({ requested: 'none' }).runtime, []);
  assert.deepEqual(plan({ requested: 'windows' }).runtime, []);
  assert.deepEqual(plan({ requested: 'mac' }).runtime.map((row) => row.platform), ['darwin-arm64']);
  assert.deepEqual(plan({ requested: 'linux' }).runtime.map((row) => row.platform), ['linux-x64', 'linux-arm64']);
  for (const requested of ['none', 'mac', 'linux', 'windows', 'all']) {
    const result = plan({ requested });
    assert.deepEqual(result.build.map((row) => row.platform), result.platforms.map((platform) => platform === 'windows' ? 'win' : platform));
  }
  const smoke = workflows['runtime-smoke'].jobs;
  for (const id of ['smoke', 'electron-e2e']) {
    assert.equal(smoke[id].strategy.matrix.include, '${{ fromJSON(needs.plan.outputs.runtime) }}');
    assert.equal(smoke[id].if, "contains(needs.plan.outputs.platforms, 'mac') || contains(needs.plan.outputs.platforms, 'linux')");
  }
  for (const id of ['windows-wsl', 'electron-e2e-windows', 'windows-app', 'clean-machine-windows']) {
    assert.equal(smoke[id].if, "contains(needs.plan.outputs.platforms, 'windows')");
  }
  assert.equal(smoke['mac-dialogs'].if, "contains(needs.plan.outputs.platforms, 'mac')");
  assert.equal(smoke['clean-machine-linux'].if, "contains(needs.plan.outputs.platforms, 'linux')");
  assert.equal(workflows['linux-arm64'].jobs.package.if, "contains(needs.plan.outputs.platforms, 'linux')");
  assert.equal(workflows.build.jobs.build.strategy.matrix.include, '${{ fromJSON(needs.plan.outputs.build) }}');
});

test('planner CLI reads GitHub context and emits workflow output using the same function', (t) => {
  const output = path.join(require('node:os').tmpdir(), `ci-plan-${process.pid}.txt`);
  t.after(() => fs.unlinkSync(output));
  const result = spawnSync(process.execPath, ['scripts/ci-plan.js'], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_HEAD_REF: 'test/launcher-mac-dmg',
      GITHUB_BASE_REF: 'develop', GITHUB_REF: 'refs/pull/63/merge', INPUT_PLATFORMS: '', GITHUB_OUTPUT: output,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const emitted = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), JSON.parse(line.slice(split + 1))];
  }));
  assert.deepEqual(emitted, plan({ eventName: 'pull_request', headRef: 'test/launcher-mac-dmg', baseRef: 'develop' }));
});
