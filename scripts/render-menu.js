// Review artifacts use the same menu template as Electron, never a second label set.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildHomeMenu } = require('../dist/main/homeMenu');
const actions = Object.fromEntries(['open','start','stop','update','login','diagnostics','logs','removePc2','reset','uninstall','about','quit'].map(k=>[k,()=>{}]));
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function main() {
  const out = process.argv[2]; if(!out) throw new Error('Pass an output directory');
  await fs.mkdir(out,{recursive:true});
  const base = { observed: 'running', inFlight: null, failure: null, quitting: false };
  const cases = ['running','stopped','starting','stopping','error','other-home','not-installed'].map(observed=>({observed}));
  cases.push(...['start','stop','update','open','maintenance'].map(kind=>({inFlight:{kind,generation:1}})),
    {quitting:true,inFlight:{kind:'update',generation:1}}, {observed:'starting',failure:'The download stopped.'});
  cases.push({observed:'running',update:{latest:'2.0.1',updateAvailable:true}}, {observed:'running',pc2:true}, {observed:'running',login:true}, {observed:'stopped',login:false,pc2:false});
  function tree(items,indent='') { return items.map(i=>indent+(i.type==='separator'?'────────':`${i.type==='checkbox'?(i.checked?'[✓] ':'[ ] '):''}${i.label}${i.enabled===false?' (disabled)':''}${i.sublabel?' · '+i.sublabel:''}${i.accelerator?' · '+i.accelerator:''}`)+(i.submenu?'\n'+tree(i.submenu,indent+'  '):'')).join('\n'); }
  await fs.writeFile(path.join(out,'menus.txt'), cases.map(state=>JSON.stringify(state)+'\n'+tree(buildHomeMenu({...base,platform:'darwin',...state},actions))).join('\n\n')+'\n');
  const browser = await chromium.launch({headless:true});
  try { for (const status of ['running','stopped']) {
    const items=buildHomeMenu({...base,observed:status,platform:'darwin',login:true},actions);
    const page=await browser.newPage({viewport:{width:344,height:440},deviceScaleFactor:2});
    await page.setContent(`<style>body{margin:0;background:#e6e6e6;font:13px -apple-system,BlinkMacSystemFont,sans-serif;padding:10px}.menu{background:#f4f4f4;border:1px solid #bcbcbc;border-radius:7px;padding:5px;box-shadow:0 4px 12px #0002}.item{padding:4px 10px 4px 22px;position:relative}.disabled{color:#888}.selected{background:#006cdd;color:white;border-radius:4px}small{display:block;font-size:11px;opacity:.7}.key,.arrow{float:right}.check{position:absolute;left:6px}hr{border:0;border-top:1px solid #d4d4d4;margin:5px}</style><div class="menu">${items.map(i=>i.type==='separator'?'<hr>':`<div class="item ${i.enabled===false?'disabled':''} ${i.label==='Open Home'?'selected':''}">${i.checked?'<span class="check">✓</span>':''}${escape(i.label)}${i.accelerator?`<span class="key">⌘${i.accelerator.endsWith('O')?'O':'Q'}</span>`:''}${i.submenu?'<span class="arrow">›</span>':''}${i.sublabel?`<small>${escape(i.sublabel)}</small>`:''}</div>`).join('')}</div>`);
    const height = Math.ceil((await page.locator('.menu').boundingBox()).height) + 20;
    await page.setViewportSize({width:344,height});
    await page.screenshot({path:path.join(out,`menu-${status}.png`)}); await page.close();
  }} finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
