const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
function nativeControls(app, page) {
  const helper = path.join(os.tmpdir(), `elastos-click-${process.pid}`);
  const compiled = spawnSync('swiftc', [path.join(__dirname,'mac-click.swift'), '-o', helper], {encoding:'utf8',timeout:120000});
  assert.equal(compiled.status,0,compiled.stderr);
  function event(args) {
    const result=spawnSync(helper,args.map(String),{encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,`Native OS events required: ${result.stdout} ${result.stderr}`);
  }
  async function bounds() {return app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getContentBounds());}
  return {
    async click(selector) {
      const deadline = Date.now() + 10000;
      let before = await bounds();
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const win = await bounds();
        if (['x', 'y', 'width', 'height'].every(key => win[key] === before[key])) {
          const box = await page.locator(selector).boundingBox(); assert.ok(box);
          event([win.x+box.x+box.width/2,win.y+box.y+box.height/2]);
          return;
        }
        before = win;
      }
      throw new Error(`Window content bounds did not stabilize: ${JSON.stringify(before)}`);
    },
    async drag() {
      const before=await bounds(); const strip=await page.locator('.title-bar').boundingBox();
      assert.equal(strip.width,before.width);
      const x=before.x+strip.width*.7,y=before.y+strip.height/2;
      event([x,y,x+60,y+45]); await page.waitForTimeout(300);
      const after=await bounds();
      assert.ok(after.x-before.x>=30 && after.y-before.y>=20,JSON.stringify({before,after}));
      console.log('PASS real OS drag moves the full top strip');
    },
  };
}
module.exports={nativeControls};
