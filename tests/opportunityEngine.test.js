// Harness: stub supabaseAdmin and healthEngine, then exercise the real module
const fs=require('fs'), path=require('path'), Module=require('module');
let TABLES={}, INSERTED=[];
const mkChain = (table) => {
  const rows = () => TABLES[table] || [];
  const c = {
    _f:[],
    select(){ return c; }, eq(k,v){ c._f.push([k,'eq',v]); return c; },
    in(k,v){ c._f.push([k,'in',v]); return c; }, is(k,v){ c._f.push([k,'is',v]); return c; },
    gte(){ return c; }, lt(){ return c; }, order(){ return c; },
    update(){ return { eq(){ return { lt(){ return Promise.resolve({error:null}); } }; } }; },
    insert(row){ INSERTED.push({table,row}); return Promise.resolve({error:null}); },
    then(res){
      let d = rows();
      for (const [k,op,v] of c._f){
        if (op==='eq') d = d.filter(r=>r[k]===v);
        if (op==='in') d = d.filter(r=>v.includes(r[k]));
        if (op==='is') d = d.filter(r=>r[k]===v);
      }
      return res({data:d,error:null});
    }
  };
  return c;
};
const stub = {
  '../../config/supabase': { supabaseAdmin: { from: mkChain } },
  './healthEngine': { reportRun: async()=>{} },
};
const origLoad = Module._load;
Module._load = function(req, parent, isMain){
  if (stub[req]) return stub[req];
  return origLoad(req, parent, isMain);
};
const { runOpportunityEngine } = require('../backend/services/opportunityEngine.js');

const ck=require('./_check');
const reset=()=>{ TABLES={opportunities:[],instrument_price_hourly:[],instrument_universe:[],
  recommendations:[],ai_instrument_flags:[],instrument_scores:[]}; INSERTED=[]; };
const dual = () => INSERTED.filter(i=>i.row.opportunity_type==='dual_agreement').map(i=>i.row);

(async()=>{
console.log('\n── BUG 1: instrument that is BOTH high opportunity AND high risk ──');
reset();
TABLES.instrument_universe=[{id:'i1',symbol:'DELHIVERY',name:'Delhivery Ltd',category:'mid_cap_equity',current_score:71,status:'active'}];
TABLES.ai_instrument_flags=[{instrument_id:'i1',risk_level:'HIGH',opportunity_level:'HIGH',
  ai_lever_score:8,horizon_label:'Short-Term',is_active:true}];
await runOpportunityEngine();
let d=dual();
ck('exactly ONE card (was two contradictory)', d.length===1);
ck('the RISK card won, not the positive one', d[0]?.headline.includes('flags near-term risk'));
ck('no "aligned positively" card', !d.some(x=>x.headline.includes('aligned positively')));
ck('conviction medium (risk branch)', d[0]?.conviction==='medium');

console.log('\n── positive-only instrument still produces the positive card ──');
reset();
TABLES.instrument_universe=[{id:'i1',symbol:'HDFCBANK',name:'HDFC Bank Ltd',category:'large_cap_equity',current_score:74,status:'active'}];
TABLES.ai_instrument_flags=[{instrument_id:'i1',risk_level:'LOW',opportunity_level:'HIGH',
  ai_lever_score:8,horizon_label:'Mid-Term',is_active:true}];
await runOpportunityEngine();
d=dual();
ck('one positive card', d.length===1 && d[0].headline.includes('aligned positively'));
ck('conviction high', d[0]?.conviction==='high');

console.log('\n── BUG 2: one instrument, THREE active event flags ──');
reset();
TABLES.instrument_universe=[{id:'i1',symbol:'RELIANCE',name:'Reliance Industries',category:'large_cap_equity',current_score:80,status:'active'}];
TABLES.ai_instrument_flags=[
 {instrument_id:'i1',risk_level:'LOW',     opportunity_level:'HIGH',ai_lever_score:7,horizon_label:'Short-Term',is_active:true},
 {instrument_id:'i1',risk_level:'CRITICAL',opportunity_level:'NONE',ai_lever_score:9,horizon_label:'Mid-Term',  is_active:true},
 {instrument_id:'i1',risk_level:'HIGH',    opportunity_level:'NONE',ai_lever_score:6,horizon_label:'Long-Term', is_active:true}];
await runOpportunityEngine();
d=dual();
ck('ONE card, not three', d.length===1);
ck('most severe flag chosen (CRITICAL)', d[0]?.detail.includes('CRITICAL'));

console.log('\n── score below threshold produces nothing ──');
reset();
TABLES.instrument_universe=[{id:'i1',symbol:'X',name:'X Ltd',category:'small_cap_equity',current_score:60,status:'active'}];
TABLES.ai_instrument_flags=[{instrument_id:'i1',risk_level:'HIGH',opportunity_level:'HIGH',ai_lever_score:9,is_active:true}];
await runOpportunityEngine();
ck('score 60 < 68 → no dual card', dual().length===0);

console.log('\n── BUG 3: idempotence on re-trigger ──');
reset();
TABLES.instrument_universe=[{id:'i1',symbol:'HDFCBANK',name:'HDFC Bank Ltd',category:'large_cap_equity',current_score:74,status:'active'}];
TABLES.ai_instrument_flags=[{instrument_id:'i1',risk_level:'LOW',opportunity_level:'HIGH',ai_lever_score:8,is_active:true}];
await runOpportunityEngine();
const firstRun = INSERTED.length;
// simulate the row now being live, then run again the same day
TABLES.opportunities=[{symbol:'HDFCBANK',opportunity_type:'dual_agreement',is_active:true}];
INSERTED=[];
await runOpportunityEngine();
ck(`first run inserted ${firstRun}`, firstRun===1);
ck('second run inserted 0 (was 1 duplicate)', INSERTED.length===0);

console.log('\n── BUG 4: zero opening price must not become Infinity ──');
reset();
TABLES.instrument_universe=[{id:'i1',symbol:'BADPRICE',name:'Bad Price Ltd',category:'mid_cap_equity',current_score:70,status:'active'}];
TABLES.instrument_price_hourly=[
 {instrument_id:'i1',symbol:'BADPRICE',price:0,   recorded_at:'2026-09-24T04:00:00Z'},
 {instrument_id:'i1',symbol:'BADPRICE',price:500, recorded_at:'2026-09-24T09:00:00Z'}];
await runOpportunityEngine();
ck('no breakout from a zero open', INSERTED.filter(i=>i.row.opportunity_type==='technical_breakout').length===0);

console.log('\n── BUG 4b: null category must not throw ──');
reset();
TABLES.instrument_universe=[{id:'i1',symbol:'NOCAT',name:'No Category Ltd',category:null,current_score:70,status:'active'}];
TABLES.instrument_price_hourly=[
 {instrument_id:'i1',symbol:'NOCAT',price:100,recorded_at:'2026-09-24T04:00:00Z'},
 {instrument_id:'i1',symbol:'NOCAT',price:110,recorded_at:'2026-09-24T09:00:00Z'}];
await runOpportunityEngine();
const bo=INSERTED.filter(i=>i.row.opportunity_type==='technical_breakout');
ck('breakout still produced (did not throw)', bo.length===1);
ck('reads "tracked instrument" not a crash', bo[0]?.row.detail.includes('tracked instrument'));

console.log('\n── unchanged: 8-per-day cap, high conviction first ──');
reset();
TABLES.instrument_universe=Array.from({length:14},(_,i)=>(
 {id:'i'+i,symbol:'S'+i,name:'S'+i+' Ltd',category:'large_cap_equity',current_score:75,status:'active'}));
TABLES.ai_instrument_flags=TABLES.instrument_universe.map((x,i)=>(
 {instrument_id:x.id,risk_level: i<4?'LOW':'HIGH',
  opportunity_level:i<4?'HIGH':'NONE',ai_lever_score:8,is_active:true}));
await runOpportunityEngine();
ck('capped at 8', INSERTED.length===8);
const first4 = INSERTED.slice(0,4).map(i=>i.row.conviction);
ck('high conviction first', first4.every(c=>c==='high'));
})();
