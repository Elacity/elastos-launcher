#!/usr/bin/env node
/**
 * Drive the Windows Install button path: install inside the ElastOS distro,
 * start the gateway without a terminal, and require /healthz from Windows.
 */
const { installRuntimeOnThisComputer } = require('../dist/main/targets/runtimeInstall');
const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
const { HEALTH_URL, HOME_URL } = require('../dist/main/targets/runtimeGateway');

async function main() {
  await installRuntimeOnThisComputer((message) => {
    console.log(message);
  });
  const target = createRuntimeTarget();
  await target.start();

  let status = 0;
  let body = '';
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
  if (home.status !== 200) {
    throw new Error(`Expected /home/ to return 200, got ${home.status}`);
  }
  console.log(`Opening Home in the Windows browser: ${HOME_URL}`);
  await target.stop();
  console.log('Gateway stopped cleanly');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
