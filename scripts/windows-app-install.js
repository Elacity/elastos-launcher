#!/usr/bin/env node
/**
 * Drive the Windows Install button path: install inside the ElastOS distro,
 * start the gateway without a terminal, and require /healthz from Windows.
 */
const { installRuntimeOnThisComputer } = require('../dist/main/targets/runtimeInstall');
const { createRuntimeTarget } = require('../dist/main/targets/runtimeTarget');
const { HOME_URL, getLocalPath, isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');

async function main() {
  await installRuntimeOnThisComputer((message) => {
    console.log(message);
  });
  const target = createRuntimeTarget();
  await target.start();

  // Probe every address localhost resolves to, as the launcher does.
  let health = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    health = await probeGatewayHealth();
    if (isHealthOk(health)) break;
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  if (!isHealthOk(health)) {
    throw new Error(`/healthz was not OK (${health ? `HTTP ${health.status} ${health.body.trim()}` : 'no answer'})`);
  }
  console.log(`/healthz is OK on ${health.addresses.join(', ')}`);

  for (const address of health.addresses) {
    const home = await getLocalPath(address, '/home/', 15000);
    console.log(`/home/ HTTP ${home ? home.status : 'no answer'} on ${address}`);
    if (!home || home.status !== 200) {
      throw new Error(`Expected /home/ to return 200 on ${address}`);
    }
  }
  console.log(`Opening Home in the Windows browser: ${HOME_URL}`);
  await target.stop();
  console.log('Gateway stopped cleanly');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
