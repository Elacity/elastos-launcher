const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { isHealthOk, probeGatewayHealth } = require('../dist/main/targets/runtimeGateway');
const { runtimeChildEnv } = require('../dist/main/targets/releaseHead');
const { waitFor, clickMenu, trayState, noWindow } = require('./tray-e2e');
const health = wanted => waitFor(async()=>isHealthOk(await probeGatewayHealth())===wanted,180000,`Home health did not become ${wanted}`);
module.exports = async function(app, page, home, options) {
  await trayState(app,'running'); await noWindow(app);
  await clickMenu(app,'Open Home');
  assert.ok(await app.evaluate(()=>global.__openedHome.includes('http://localhost:8090/home/')));
  assert.equal((await fetch('http://localhost:8090/home/')).status,200);
  console.log('PASS Open Home opens localhost:8090/home/ through the real menu');
  await clickMenu(app,'Stop Home'); await trayState(app,'stopped'); await health(false);
  console.log('PASS Stop Home closes the listener and changes the icon');
  // A second process, rather than app.emit, exercises the actual single-instance lock.
  const second = spawnSync(options.executablePath,options.args,{cwd:options.cwd,env:options.env,timeout:30000,encoding:'utf8'});
  assert.equal(second.status,0,second.stderr);
  await trayState(app,'running'); await health(true); await noWindow(app);
  console.log('PASS second launch starts stopped Home and opens it without a window');
  await clickMenu(app,'Stop Home'); await trayState(app,'stopped');
  await clickMenu(app,'Start Home'); await trayState(app,'running'); await health(true);
  console.log('PASS Start Home becomes healthy and changes the icon');
  const data=path.join(home,'Library','Application Support','elastos');
  const controller=path.join(data,'update-controller','status.json');
  const started=JSON.parse(fs.readFileSync(controller,'utf8')).controller_pid;
  process.kill(started,'SIGKILL');
  await trayState(app,'attention');
  // Starting uses the existing supervisor's proved recovery path.
  await clickMenu(app,'Start Home'); await trayState(app,'running'); await health(true);
  console.log('PASS controller crash changes the icon and explicit Start recovers');
  const closed = app.waitForEvent('close');
  await clickMenu(app,'Quit ElastOS'); await closed; await health(false);
  console.log('PASS Quit ElastOS stops Home');
  const binary=path.join(home,'.local','bin','elastos');
  const external=spawn(binary,['home','--browser'],{detached:true,stdio:'ignore',env:runtimeChildEnv(options.env)});
  let adopted, foreign;
  try {
    await health(true);
    adopted=await electron.launch(options); await trayState(adopted,'running'); await noWindow(adopted);
    console.log('PASS opening an installed running Home adopts it without a window');
    await clickMenu(adopted,'Stop Home'); await trayState(adopted,'stopped'); await health(false);
    console.log('PASS Stop Home stops the proved adopted Home');
    await clickMenu(adopted,'Start Home'); await trayState(adopted,'running');
    const closed = adopted.waitForEvent('close'); await clickMenu(adopted,'Quit ElastOS'); await closed; await health(false);
    foreign=http.createServer((_req,res)=>res.end('OK'));
    await new Promise((resolve,reject)=>{foreign.once('error',reject);foreign.listen(8090,'127.0.0.1',resolve);});
    adopted=await electron.launch(options);
    const errorWindow=await adopted.firstWindow();
    await waitFor(async()=>/another|8090/i.test(await errorWindow.locator('#message').innerText()),30000,'Missing foreign-port error');
    assert.equal(foreign.listening,true);
    const foreignClosed = adopted.waitForEvent('close');
    await clickMenu(adopted,'Quit ElastOS'); await foreignClosed;
    assert.equal(foreign.listening,true);
    console.log('PASS foreign listener receives no signal on open or Quit');
    console.log('NOT EXERCISED signed update replacement: no newer signed Stable release is available');
    return adopted;
  } finally {
    if(adopted) await adopted.close().catch(()=>{});
    if(foreign) await new Promise(resolve=>foreign.close(resolve));
    if(external.exitCode===null && external.signalCode===null) external.kill('SIGTERM');
  }
};
