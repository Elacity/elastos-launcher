// Packaged native UI with a fixture controller; lifecycle e2e uses the real signed Home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { nativeControls } = require('./mac-native');
const { clickMenu, waitFor, trayState, noWindow } = require('./tray-e2e');
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Packaged Mac dialog e2e runs only on the disposable GitHub Mac runner.');
async function main() {
  const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'launcher-dialog-home-'));
  const env={...process.env, HOME:home, USERPROFILE:home, ELASTOS_HIDE_HOST_TOOLS:'1',
    PATH:(process.env.PATH||'').split(path.delimiter).filter(dir=>!fs.existsSync(path.join(dir,'elastos'))).join(path.delimiter)};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({executablePath:path.resolve(process.argv[2],'Contents/MacOS/ElastOS'),env,timeout:60000});
  const watchdog=setTimeout(()=>app.process().kill('SIGKILL'),180000);
  try {
    const page=await app.firstWindow();
    const native=nativeControls(app,page);
    await page.locator('#primary').waitFor();
    await app.evaluate(({app,dialog,shell})=>{
      const root=app.getAppPath();
      const fromApp=process.mainModule.require.bind(process.mainModule);
      const {launch}=fromApp(root+'/dist/main/index.js');
      global.__fixture={calls:[],dialogs:[],answer:{response:0,checkboxChecked:false},status:'not-installed'};
      const f=global.__fixture;
      launch.getStatus=async()=>f.status;
      launch.getOpenAtLogin=()=>false; launch.setOpenAtLogin=v=>f.calls.push(['login',v]);
      launch.install=async progress=>{f.calls.push(['install']);progress('Setting up');f.status='stopped';};
      launch.start=async()=>{f.calls.push(['start']);f.status='running';};
      launch.stop=async()=>{f.calls.push(['stop']);f.status='stopped';};
      launch.shutdown=async()=>{};
      launch.openInBrowser=()=>f.calls.push(['open','http://localhost:8090/home/']);
      launch.checkForUpdate=async()=>({latest:'2.0.1',updateAvailable:true,releaseUrl:'https://example.com/releases/2.0.1'});
      launch.update=async progress=>{f.calls.push(['update']);progress('Downloading');f.status='running';};
      launch.describeResetBackup=async()=>({present:true,enough:true});
      launch.resetRuntime=async choice=>{f.calls.push(['reset',choice]);};
      launch.uninstall=async(_confirm,deleteData)=>{f.calls.push(['uninstall',deleteData]);};
      launch.getDiagnostics=async()=> 'fixture diagnostics';
      launch.describeFailure=async()=>({message:'The download stopped.',fixLabel:null});
      shell.openExternal=async url=>f.calls.push(['external',url]);
      dialog.showMessageBox=async(...args)=>{f.dialogs.push(args.at(-1));return f.answer;};
      const pc2=fromApp(root+'/dist/main/legacyPc2Removal.js');
      pc2.describeLegacyPc2OnThisComputer=async()=>f.removed?[]:[{path:'/Users/runner/.pc2',label:'PC2 data'}];
      pc2.removeLegacyPc2OnThisComputer=async choice=>{f.calls.push(['pc2',choice]);f.removed=true;return {ok:true};};
    });
    await native.drag();
    await native.click('#login');
    await waitFor(async()=>!(await page.locator('#login').isChecked()),10000,'Native login click did not uncheck Open at Login');
    await native.click('#primary');
    await waitFor(async()=>await page.locator('#primary').innerText()==='Open Home',10000,'No ready screen');
    assert.equal(await page.locator('#message').innerText(),'Home is ready.');
    assert.ok(await app.evaluate(()=>global.__fixture.calls.some(c=>c[0]==='login'&&c[1]===false)));
    await native.click('#primary'); await waitFor(()=>app.evaluate(()=>global.__fixture.calls.some(c=>c[0]==='open')),10000,'Native Open Home did not open Home');
    await noWindow(app); await trayState(app,'running');
    for(const [label,action] of [['Reset ElastOS…','reset'],['Uninstall ElastOS…','uninstall'],['Remove Old PC2 Files…','pc2']]) {
      const before=await app.evaluate(()=>global.__fixture.dialogs.length);
      await app.evaluate(()=>{global.__fixture.answer={response:0,checkboxChecked:false};});
      await clickMenu(app,label);
      await waitFor(()=>app.evaluate((_e,b)=>global.__fixture.dialogs.length>b,before),10000,'Native dialog did not open');
      const options=await app.evaluate(()=>global.__fixture.dialogs.at(-1));
      assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.equal(options.buttons[0],'Cancel');
      assert.equal(await app.evaluate((_e,action)=>global.__fixture.calls.some(c=>c[0]===action),action),false);
      await app.evaluate(()=>{global.__fixture.answer={response:1,checkboxChecked:true};});
      await clickMenu(app,label);
      await waitFor(()=>app.evaluate((_e,action)=>global.__fixture.calls.some(c=>c[0]===action),action),10000,'Confirm did not reach controller');
      console.log(`PASS real menu ${label} opens native dialog, defaults to Cancel, and honors choice`);
    }
    const calls=await app.evaluate(()=>global.__fixture.calls);
    assert.ok(calls.some(c=>c[0]==='reset'&&c[1].backup));
    assert.ok(calls.some(c=>c[0]==='uninstall'&&c[1]===true));
    assert.ok(calls.some(c=>c[0]==='pc2'&&c[1].backup&&c[1].paths[0]==='/Users/runner/.pc2'));
    await clickMenu(app,'Update to 2.0.1…');
    const update=await app.firstWindow();const updateNative=nativeControls(app,update);
    await update.locator('#cancel').waitFor();
    await updateNative.click('#cancel');await noWindow(app);
    await clickMenu(app,'Update to 2.0.1…');
    const confirming=await app.firstWindow();const confirmingNative=nativeControls(app,confirming);
    await confirming.locator('#primary').waitFor();
    await confirmingNative.click('#primary');
    await waitFor(()=>app.evaluate(()=>global.__fixture.calls.some(c=>c[0]==='update')),10000,'Update did not run');
    await noWindow(app);
    console.log('PASS native update window supports Not Now and Update then closes');
  } finally {
    await app.evaluate(({app})=>app.exit(0)).catch(()=>{});clearTimeout(watchdog);
    if(app.process().exitCode===null)app.process().kill('SIGKILL');
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
