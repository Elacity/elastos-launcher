#!/usr/bin/env node
/**
 * Install the pinned runtime with host tools hidden, then require /healthz.
 * The parent environment must not have curl or python3 on PATH.
 */
const { spawnSync } = require('node:child_process');
const { installRuntimeOnThisComputer } = require('../dist/main/targets/runtimeInstall');
const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
const { HEALTH_URL, HOME_URL } = require('../dist/main/targets/runtimeGateway');

function present(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0;
}

async function main() {
  for (const command of ['curl', 'python3', 'gcc']) {
    if (present(command)) {
      throw new Error(`clean machine still has ${command}`);
    }
  }
  console.log('clean image: no curl, python3, or gcc');
  process.env.ELASTOS_HIDE_HOST_TOOLS = '1';
  await installRuntimeOnThisComputer((message) => {
    console.log(message);
  });
  const target = createRuntimeTarget();
  await target.start();
  let status = 0;
  let body = '';
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await fetch(HEALTH_URL);
        status = response.status;
        body = (await response.text()).trim();
        if (status === 200 && body === 'OK') break;
      } catch {
        body = '';
      }
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
    if (status !== 200 || body !== 'OK') {
      throw new Error(`/healthz was not OK (HTTP ${status} ${body})`);
    }
    console.log('/healthz is OK');
    const home = await fetch(HOME_URL);
    console.log(`/home/ HTTP ${home.status}`);
    if (home.status !== 200) throw new Error(`Expected /home/ to return 200, got ${home.status}`);
    const ldd = spawnSync('ldd', [`${process.env.HOME}/.local/bin/elastos`], { encoding: 'utf8' });
    const listed = `${ldd.stdout || ''}${ldd.stderr || ''}`;
    console.log(listed.trim());
    if (listed.includes('not found')) {
      throw new Error('The runtime program is missing a system library.');
    }
    console.log('Clean machine install finished');
  } finally {
    await target.stop();
    console.log('Gateway stopped cleanly');
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
