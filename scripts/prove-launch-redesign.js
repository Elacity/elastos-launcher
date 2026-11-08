const assert = require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const {mainFixture}=require('../test/main-fixture');
async function main(){
  const raw=execFileSync('git',['show','1fd5f798e3a6ce481c06b97cc26dd79c12ec1068:src/main/index.ts'],{encoding:'utf8'});
  const baseline=path.resolve(__dirname,'../dist/main/test3-baseline.cjs');
  fs.writeFileSync(baseline,ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
  try {
    const before=await mainFixture({entry:baseline,status:'running'});
    assert.equal(before.windows.length,1);
    assert.throws(()=>assert.equal(before.windows.length,0));
    console.log('FAIL BEFORE 1fd5f798: installed/running app creates 1 standing window; expected 0.');
    const after=await mainFixture({status:'running'});
    assert.equal(after.windows.length,0);
    assert.equal(after.calls.filter(c=>c==='open').length,1);
    console.log('PASS AFTER: installed/running app creates 0 windows and opens Home once.');
  } finally {fs.unlinkSync(baseline);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
