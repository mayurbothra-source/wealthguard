const Module=require('module'), orig=Module._load;
let CLIENT={}; 
Module._load=function(r,p,i){ if(r.includes('config/supabase')) return {supabaseAdmin:CLIENT}; return orig(r,p,i); };
const db=require('../backend/lib/db.js');
const ck=(n,c)=>console.log(`  ${c?'PASS':'FAIL'}  ${n}`);
const logs=[]; const ow=console.warn, oe=console.error;
console.warn=(...a)=>logs.push(a.join(' ')); console.error=(...a)=>logs.push(a.join(' '));

(async()=>{
console.log('\n── schema-error detection ──');
[['42703 undefined_column',{code:'42703',message:'column x does not exist'},true],
 ['42P01 undefined_table',{code:'42P01',message:'relation y does not exist'},true],
 ['PGRST204 schema cache',{code:'PGRST204',message:"Could not find the 'z' column"},true],
 ['message: does not exist',{message:'column foo does not exist'},true],
 ['network blip',{message:'fetch failed'},false],
 ['permission denied',{code:'42501',message:'permission denied'},false]].forEach(([n,e,exp])=>
  ck(`${n} → ${exp?'schema':'transient'}`, db._isSchemaError(e)===exp));

console.log('\n── a read failure degrades, does not throw ──');
db.resetStats(); logs.length=0;
let r = await db.select('clients', ()=>Promise.resolve({data:null,error:{code:'42703',message:'column clients.created_at does not exist'}}));
ck('returns the fallback []', Array.isArray(r) && r.length===0);
ck('error was logged', logs.some(l=>/SCHEMA MISMATCH/.test(l)));
ck('names the table and op', logs.some(l=>/clients\.select/.test(l)));
ck('tells you what to run', logs.some(l=>/verify_schema\.sql/.test(l)));
ck('counted as a failure', db.getStats().failures===1);

console.log('\n── a write failure THROWS (never silent) ──');
db.resetStats();
let threw=false, err=null;
try { await db.write('morning_briefs','upsert',()=>Promise.resolve({data:null,error:{code:'PGRST204',message:"Could not find the 'full_text' column"}})); }
catch(e){ threw=true; err=e; }
ck('threw', threw);
ck('message carries table.op', /morning_briefs\.upsert/.test(err.message));
ck('flagged as schemaMismatch', err.schemaMismatch===true);
ck('original error attached', !!err.dbError);

console.log('\n── tryWrite reports but lets the loop continue ──');
db.resetStats(); logs.length=0;
const ok1 = await db.tryWrite('t','insert',()=>Promise.resolve({data:null,error:{message:'boom'}}));
const ok2 = await db.tryWrite('t','insert',()=>Promise.resolve({data:[{id:1}],error:null}));
ck('failure → false, no throw', ok1===false);
ck('success → true', ok2===true);
ck('failure still logged', logs.length>0);

console.log('\n── success path is untouched ──');
db.resetStats(); logs.length=0;
const rows = await db.select('clients', ()=>Promise.resolve({data:[{id:'a'},{id:'b'}],error:null}));
ck('rows returned as-is', rows.length===2 && rows[0].id==='a');
ck('nothing logged', logs.length===0);
ck('no failures counted', db.getStats().failures===0);

console.log('\n── selectOne ──');
ck('array → first row', (await db.selectOne('t',()=>Promise.resolve({data:[{id:1},{id:2}]})))?.id===1);
ck('empty → null',       (await db.selectOne('t',()=>Promise.resolve({data:[]})))===null);
ck('error → null',       (await db.selectOne('t',()=>Promise.resolve({data:null,error:{message:'x'}})))===null);

console.log('\n── repeat suppression (a 5-min cron must not bury the log) ──');
db.resetStats(); logs.length=0;
for (let i=0;i<30;i++) await db.select('t',()=>Promise.resolve({data:null,error:{code:'42703',message:'same'}}));
ck('30 identical failures → 2 log lines', logs.length===2);
ck('all 30 still counted', db.getStats().failures===30);
ck('suppressed count tracked', db.getStats().silenced===28);

console.log('\n── unconfigured Supabase is not an error ──');
db.resetStats(); logs.length=0; CLIENT=null;
delete require.cache[require.resolve('../backend/lib/db.js')];
const db2=require('../backend/lib/db.js');
ck('isConfigured false', db2.isConfigured()===false);
ck('read returns fallback', (await db2.select('t',()=>{throw new Error('should not run')})).length===0);
ck('no error logged', logs.length===0);

console.warn=ow; console.error=oe;
})();

setTimeout(()=>{
console.log('\n── writeTolerant: deploy order must not matter ──');
(async()=>{
  CLIENT = {};   // the unconfigured test above nulled it
  const logs2=[]; const w=console.warn; console.warn=(...a)=>logs2.push(a.join(' '));

  // Simulate a database WITHOUT migration 005: any insert naming the new
  // columns is rejected whole; the trimmed row succeeds.
  const NEW=['levers_measured','price_data_points','lever_sources'];
  let received=null, calls=0;
  CLIENT.from = () => ({
    insert:(row)=>{ calls++; received=row;
      const bad = NEW.filter(k=>k in row);
      return Promise.resolve(bad.length
        ? {data:null,error:{code:'PGRST204',message:`Could not find the '${bad[0]}' column of 'instrument_scores' in the schema cache`}}
        : {data:[row],error:null}); },
    upsert:(row)=>Promise.resolve({data:[row],error:null}),
  });
  delete require.cache[require.resolve('../backend/lib/db.js')];
  const db3 = require('../backend/lib/db.js');

  const full={instrument_id:'i1',composite_score:74,technical:6,
              levers_measured:7,price_data_points:252,lever_sources:{a:'measured'}};
  const r = await db3.writeTolerant('instrument_scores','insert',{...full},NEW);
  ck('the write SUCCEEDED despite the missing columns', r.ok===true);
  ck('reported as degraded', r.degraded===true);
  ck('retried exactly once', calls===2);
  ck('core score data still landed', received.composite_score===74 && received.technical===6);
  ck('only the new columns were dropped', !('levers_measured' in received) && !('lever_sources' in received));
  ck('warned once, naming the migration', logs2.some(l=>/migration/i.test(l)));
  ck('warning names the dropped columns', logs2.some(l=>/levers_measured/.test(l)));

  // Same call again must not re-warn — a weekly cron would spam otherwise
  const before=logs2.length;
  await db3.writeTolerant('instrument_scores','insert',{...full},NEW);
  ck('does not re-warn on the next instrument', logs2.length===before);

  // With the migration applied, nothing is dropped and no warning appears
  logs2.length=0; calls=0;
  CLIENT.from = () => ({ insert:(row)=>{calls++;received=row;return Promise.resolve({data:[row],error:null})} });
  delete require.cache[require.resolve('../backend/lib/db.js')];
  const db4 = require('../backend/lib/db.js');
  const r2 = await db4.writeTolerant('instrument_scores','insert',{...full},NEW);
  ck('post-migration: not degraded', r2.ok===true && r2.degraded===false);
  ck('post-migration: one call, no retry', calls===1);
  ck('post-migration: provenance columns kept', received.levers_measured===7);
  ck('post-migration: silent', logs2.length===0);

  // A failure that is NOT about the optional columns must still be reported
  logs2.length=0;
  CLIENT.from = () => ({ insert:()=>Promise.resolve({data:null,error:{code:'42501',message:'permission denied for table instrument_scores'}}) });
  delete require.cache[require.resolve('../backend/lib/db.js')];
  const db5 = require('../backend/lib/db.js');
  const r3 = await db5.writeTolerant('instrument_scores','insert',{...full},NEW);
  ck('a real error is not masked as degraded', r3.ok===false);
  ck('and it is reported', logs2.some(l=>/permission denied/.test(l)));

  console.warn=w;
})();
}, 300);
