const Module=require('module'), orig=Module._load, path=require('path');
const ROOT='/home/claude/repo/wealthguard-main';

// ── Fake database ──────────────────────────────────────────────────
let TABLES={}, WRITES=[];
const chain=(t)=>{const c={_f:[],
  select(){return c}, eq(k,v){c._f.push([k,v]);return c}, in(k,v){c._f.push([k,v,'in']);return c},
  is(){return c}, gte(){return c}, lt(){return c}, not(){return c}, order(){return c}, limit(){return c},
  maybeSingle(){return c}, single(){return c},
  insert(r){WRITES.push({t,op:'insert',r});return Promise.resolve({data:[r],error:null})},
  upsert(r){WRITES.push({t,op:'upsert',r});return Promise.resolve({data:[r],error:null})},
  update(r){WRITES.push({t,op:'update',r});return {eq(){return Promise.resolve({error:null})}}},
  then(res){let d=TABLES[t]||[];
    for(const [k,v,op] of c._f){ d = op==='in' ? d.filter(x=>v.includes(x[k])) : d.filter(x=>x[k]===v); }
    return res({data:d,error:null})}};
  return c;};
const FAKE_DB={supabaseAdmin:{from:chain}, supabase:{from:chain}};

// ── Fake Yahoo ─────────────────────────────────────────────────────
let YAHOO_MODE='ok';
const mkSeries=(n,cagr,vol)=>{const a=[100];for(let i=1;i<n;i++)
  a.push(a[i-1]*Math.pow(1+cagr,1/252)*(1+Math.sin(i*1.7)*vol));return a;};
const FAKE_AXIOS={ get:async(url,cfg)=>{
  if(YAHOO_MODE==='down') { const e=new Error('getaddrinfo ENOTFOUND'); throw e; }
  if(url.includes('/chart/')){
    if(YAHOO_MODE==='no_chart') return {data:{chart:{result:[{}]}}};
    const sym=decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
    const profile = sym.includes('STRONG')?[0.35,0.008]:sym.includes('WEAK')?[-0.25,0.02]:[0.08,0.012];
    return {data:{chart:{result:[{indicators:{quote:[{close:mkSeries(252,...profile)}]}}]}}};
  }
  if(url.includes('quoteSummary')){
    if(YAHOO_MODE==='no_fund'){ const e=new Error('r'); e.response={status:401}; throw e; }
    const sym=decodeURIComponent(url.split('quoteSummary/')[1].split('?')[0]);
    const good=sym.includes('STRONG');
    return {data:{quoteSummary:{result:[{
      summaryDetail:{trailingPE:{raw:good?18:65},forwardPE:{raw:good?16:55},marketCap:{raw:5e11}},
      defaultKeyStatistics:{priceToBook:{raw:good?2.4:9}},
      financialData:{returnOnEquity:{raw:good?0.22:0.03},debtToEquity:{raw:good?35:210},
        profitMargins:{raw:good?0.18:0.01},operatingMargins:{raw:good?0.26:0.02},
        earningsGrowth:{raw:good?0.28:-0.35}}}]}}};
  }
  return {data:{}};
}};

Module._load=function(r,p,i){
  if(r.includes('config/supabase')) return FAKE_DB;
  if(r==='axios') return FAKE_AXIOS;
  return orig(r,p,i);
};

const fp=require(ROOT+'/backend/services/fundamentalsProvider');
const le=require(ROOT+'/backend/services/leverEngine');
const ck=(n,c)=>console.log(`  ${c?'PASS':'FAIL'}  ${n}`);

const UNIVERSE=[
  {id:'1',symbol:'STRONGCO',name:'Strong Co',category:'large_cap_equity',yahoo_ticker:'STRONG.NS',price_source:'yahoo',status:'active'},
  {id:'2',symbol:'WEAKCO',  name:'Weak Co',  category:'large_cap_equity',yahoo_ticker:'WEAK.NS',  price_source:'yahoo',status:'active'},
  {id:'3',symbol:'MIDSTRONG',name:'Mid Strong',category:'mid_cap_equity',yahoo_ticker:'STRONGM.NS',price_source:'yahoo',status:'active'},
  {id:'4',symbol:'SMALLWEAK',name:'Small Weak',category:'small_cap_equity',yahoo_ticker:'WEAKS.NS',price_source:'yahoo',status:'active'},
  {id:'5',symbol:'GSEC10Y', name:'G-Sec 10Y',category:'bond_gsec',yahoo_ticker:null,price_source:'static',status:'active'},
  {id:'6',symbol:'NIFTYBEES',name:'Nifty BeES',category:'index_etf',yahoo_ticker:'NIFTYBEES.NS',price_source:'yahoo',status:'active'},
  {id:'7',symbol:'LCFUND',  name:'LC Fund',  category:'large_cap_fund',yahoo_ticker:'LCF.NS',price_source:'mfapi',status:'active'},
  {id:'8',symbol:'PEER1',   name:'Peer 1',   category:'large_cap_equity',yahoo_ticker:'P1.NS',price_source:'yahoo',status:'active'},
  {id:'9',symbol:'PEER2',   name:'Peer 2',   category:'large_cap_equity',yahoo_ticker:'P2.NS',price_source:'yahoo',status:'active'},
];
const MACRO={gdp_latest:7,cpi_latest:5,fii_net_cr:1500,dii_net_cr:800};
const act=(s)=>s._audit.insufficient_data?'WATCH*':(s.composite>=70?'BUY':s.composite>=50?'WATCH':'SELL');

(async()=>{
console.log('\n── FULL PIPELINE: Yahoo healthy ──');
YAHOO_MODE='ok'; WRITES=[]; TABLES={instrument_fundamentals:[]};
let {metrics,summary}=await fp.buildMetrics(UNIVERSE,{noWrite:true});
ck('every instrument got a metrics entry', Object.keys(metrics).length===9);
ck('price history for the 8 with a feed', summary.with_price_history===8);
ck('static bond correctly has none', summary.no_price_feed===1);
ck('company fundamentals for all 6 equity-category instruments', summary.with_fundamentals===6);
ck('funds/ETFs/bonds correctly marked not-applicable', summary.fundamentals_unavailable===3);
ck('peer medians computed per category', Object.keys(summary.category_medians).length>=4);
ck('no writes in noWrite mode', WRITES.length===0);

const scored={};
for(const inst of UNIVERSE) scored[inst.symbol]=le.scoreInstrument(inst,MACRO,metrics[inst.symbol]);
console.log('');
for(const inst of UNIVERSE){const s=scored[inst.symbol];
  console.log(`   ${inst.symbol.padEnd(11)} ${String(s.composite).padStart(3)}/100  ${act(s).padEnd(7)} ${s._audit.measured_levers}/9 measured`);}

ck('strong large-cap beats weak large-cap by >15', scored.STRONGCO.composite-scored.WEAKCO.composite>15);
ck('static G-Sec gets no directional call', scored.GSEC10Y._audit.insufficient_data===true);
ck('mid-cap can reach BUY', scored.MIDSTRONG.composite>=70);
ck('the two identical peers score the same', scored.PEER1.composite===scored.PEER2.composite);
ck('6+ levers measured for a full-data equity', scored.STRONGCO._audit.measured_levers>=6);

console.log('\n── Yahoo quoteSummary fails, chart still works ──');
YAHOO_MODE='no_fund';
({metrics,summary}=await fp.buildMetrics(UNIVERSE,{noWrite:true,force:true}));
ck('price history still obtained', summary.with_price_history===8);
ck('fundamentals absent', summary.with_fundamentals===0);
const degraded=le.scoreInstrument(UNIVERSE[0],MACRO,metrics.STRONGCO);
ck('still scores', degraded.composite>0);
ck('4 price-derived levers still measured', degraded._audit.measured_levers>=4);
ck('fundamental fell back to baseline', degraded._audit.sources.fundamental==='baseline');
ck('and says why', /unavailable/.test(degraded._audit.details.fundamental));
ck('still gets a directional call (has price data)', degraded._audit.insufficient_data===false);

console.log('\n── Yahoo entirely unreachable ──');
YAHOO_MODE='down';
({metrics,summary}=await fp.buildMetrics(UNIVERSE,{noWrite:true,force:true}));
ck('run completes, does not throw', !!metrics);
ck('all flagged as no price feed', summary.no_price_feed===9);
ck('failure reasons recorded', Object.keys(summary.reasons).length>0);
const blind=le.scoreInstrument(UNIVERSE[0],MACRO,metrics.STRONGCO);
ck('scores on baselines only', blind.composite>0);
ck('NO directional call for any of them', blind._audit.insufficient_data===true);
console.log('   → a total outage produces zero directional signals, not 120 fabricated ones');

console.log('\n── cache write path ──');
YAHOO_MODE='ok'; WRITES=[]; TABLES={instrument_fundamentals:[]};
await fp.buildMetrics(UNIVERSE,{force:true});
const upserts=WRITES.filter(w=>w.t==='instrument_fundamentals');
ck('one cache row per instrument', upserts.length===9);
ck('rows carry price_stats', upserts.some(u=>u.r.price_stats));
ck('rows carry the reason when a feed is absent', upserts.some(u=>u.r.price_reason));

console.log('\n── cache is honoured on the next run ──');
TABLES={instrument_fundamentals:upserts.map(u=>({...u.r}))};
WRITES=[]; let fetchCount=0;
const realGet=FAKE_AXIOS.get; FAKE_AXIOS.get=async(...a)=>{fetchCount++;return realGet(...a)};
({summary}=await fp.buildMetrics(UNIVERSE,{noWrite:true}));
ck('served from cache', summary.from_cache===9);
ck('zero network calls', fetchCount===0);
FAKE_AXIOS.get=realGet;

console.log('\n── WATCH accounting ──');
const tr=require(ROOT+'/backend/services/trackRecordEngine');
ck('BUY + rise  → correct',   tr.isDirectionCorrect('BUY',4.2)===true);
ck('BUY + fall  → incorrect', tr.isDirectionCorrect('BUY',-3.1)===false);
ck('SELL + fall → correct',   tr.isDirectionCorrect('SELL',-2.5)===true);
ck('WATCH       → null (was "correct" on any fall)', tr.isDirectionCorrect('WATCH',-1.2)===null);
ck('WATCH + big rise also null', tr.isDirectionCorrect('WATCH',9)===null);
ck('quiet WATCH banded as held', tr.classifyWatchOutcome(1.4)==='held');
ck('WATCH that ran up is banded', tr.classifyWatchOutcome(11)==='rose_beyond_band');
ck('WATCH that fell hard is banded', tr.classifyWatchOutcome(-8)==='fell_beyond_band');
ck('isDirectionalAction excludes WATCH', tr.isDirectionalAction('WATCH')===false);
ck('isDirectionalAction includes BUY',   tr.isDirectionalAction('BUY')===true);
})();

setTimeout(async()=>{
console.log('\n── peer-count guard: a category with <3 members ──');
YAHOO_MODE='ok';
const solo=await fp.buildMetrics([UNIVERSE[2]],{noWrite:true,force:true});
const s1=le.scoreInstrument(UNIVERSE[2],MACRO,solo.metrics.MIDSTRONG);
ck('sector_timing falls back with 1 peer', s1._audit.sources.sector_timing==='baseline');
ck('competitive does NOT claim measured with 1 peer', s1._audit.sources.competitive!=='measured');
ck('it reports partial (margin only), honestly labelled', s1._audit.sources.competitive==='partial');
ck('and says why', /too few measurable peers/.test(s1._audit.details.sector_timing));
ck('the other 7 levers still measured',    s1._audit.measured_levers===7);
console.log('   → the model will not judge a category on fewer than 3 measurable peers');

}, 2500);
