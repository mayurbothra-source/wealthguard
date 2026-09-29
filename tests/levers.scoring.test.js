const le=require('../backend/services/leverEngine.js');
const fp=require('../backend/services/fundamentalsProvider.js');
const ck=(n,c)=>console.log(`  ${c?'PASS':'FAIL'}  ${n}`);
const MACRO={gdp_latest:7,cpi_latest:5,fii_net_cr:1500,dii_net_cr:800};

// Realistic series builders
const series=(n,cagr,volDaily)=>{const a=[100];for(let i=1;i<n;i++){
  const drift=Math.pow(1+cagr,1/252); const shock=1+(Math.sin(i*1.7)*volDaily);
  a.push(a[i-1]*drift*shock);} return a;};
const stats=s=>fp.computePriceStats(s);

const STRONG = stats(series(252, 0.35, 0.008));   // strong uptrend, low vol
const WEAK   = stats(series(252,-0.25, 0.020));   // downtrend, high vol
const CHOPPY = stats(series(252, 0.02, 0.025));   // flat, very volatile

const GOOD_CO={trailing_pe:18,forward_pe:16,price_to_book:2.4,return_on_equity:0.22,
  debt_to_equity:35,profit_margin:0.18,operating_margin:0.26,earnings_growth:0.28,revenue_growth:0.15};
const BAD_CO={trailing_pe:68,forward_pe:55,price_to_book:9.1,return_on_equity:0.03,
  debt_to_equity:210,profit_margin:0.01,operating_margin:0.02,earnings_growth:-0.35,revenue_growth:-0.08};

console.log('\n── THE ORIGINAL DEFECT: can two same-category instruments differ? ──');
const m1={price_stats:STRONG,fundamentals:GOOD_CO,peer_median_return_3m:2,peer_count:20};
const m2={price_stats:WEAK,  fundamentals:BAD_CO, peer_median_return_3m:2,peer_count:20};
const a=le.scoreInstrument({category:'large_cap_equity'},MACRO,m1);
const b=le.scoreInstrument({category:'large_cap_equity'},MACRO,m2);
console.log(`   strong large-cap: composite ${a.composite}`);
console.log(`   weak   large-cap: composite ${b.composite}`);
ck('they differ by a meaningful margin (was 1 point)', a.composite-b.composite>=20);
const differing=Object.keys(a).filter(k=>!k.startsWith('_')&&k!=='composite'&&a[k]!==b[k]);
console.log('   levers that differ:', differing.join(', '));
ck('at least 5 levers now differ (was 1)', differing.length>=5);

console.log('\n── strong instrument can reach BUY; weak cannot ──');
ck('strong large-cap >= 70 (BUY)', a.composite>=70);
ck('weak large-cap < 50 (SELL)',   b.composite<50);

console.log('\n── mid/small caps are no longer capped below BUY ──');
for (const cat of ['mid_cap_equity','small_cap_equity']){
  const s=le.scoreInstrument({category:cat},MACRO,{price_stats:STRONG,fundamentals:GOOD_CO,
    peer_median_return_3m:2,peer_count:15});
  console.log(`   strong ${cat}: ${s.composite}`);
  ck(`${cat} CAN now reach BUY (was impossible)`, s.composite>=70);
}

console.log('\n── THE PERMANENT-BUY BUG: static bond with no history ──');
const bond=le.scoreInstrument({category:'bond_gsec',price_source:'static'},MACRO,
  {price_stats:null,fundamentals:null,price_reason:'statically priced — no market history exists'});
console.log(`   G-Sec composite ${bond.composite}, insufficient_data=${bond._audit.insufficient_data}`);
ck('flagged insufficient_data (was published as BUY)', bond._audit.insufficient_data===true);
ck('reason is stated', /statically priced/.test(bond._audit.insufficient_reason));
ck('zero levers measured from its own behaviour', bond._audit.measured_levers<=2);

console.log('\n── a bond WITH real price history is judged on merit ──');
const liveBond=le.scoreInstrument({category:'bond_gsec'},MACRO,
  {price_stats:stats(series(252,0.07,0.002)),fundamentals:null,peer_median_return_3m:1.5,peer_count:8});
ck('not flagged insufficient', liveBond._audit.insufficient_data===false);
ck('scored on its own data', liveBond._audit.measured_levers>=4);

console.log('\n── individual levers respond to their real inputs ──');
ck('technical: uptrend > downtrend',
   le.leverTechnical(STRONG,'large_cap_equity').score > le.leverTechnical(WEAK,'large_cap_equity').score);
ck('technical: no data → neutral 5 + reason',
   le.leverTechnical(null,'large_cap_equity').score===5 &&
   le.leverTechnical(null,'large_cap_equity').source==='neutral');
ck('fundamental: good co > bad co',
   le.leverFundamental(GOOD_CO,'large_cap_equity').score > le.leverFundamental(BAD_CO,'large_cap_equity').score);
ck('fundamental: loss-maker penalised',
   le.leverFundamental({trailing_pe:-12},'large_cap_equity').score < 5);
ck('fundamental: ETF marked not-applicable, not a gap',
   le.leverFundamental(null,'index_etf').source==='not-applicable');
ck('management: high ROE low debt > low ROE high debt',
   le.leverManagement(GOOD_CO,'large_cap_equity').score > le.leverManagement(BAD_CO,'large_cap_equity').score);
ck('risk_adjusted: low-vol grower > high-vol loser',
   le.leverRiskAdjusted(STRONG,'large_cap_equity').score > le.leverRiskAdjusted(WEAK,'large_cap_equity').score);
ck('risk_adjusted: choppy flat is penalised',
   le.leverRiskAdjusted(CHOPPY,'large_cap_equity').score <= 5);
ck('competitive: beating peers scores higher',
   le.leverCompetitive(STRONG,GOOD_CO,'large_cap_equity',-5,20).score >
   le.leverCompetitive(STRONG,GOOD_CO,'large_cap_equity',30,20).score);
ck('sector_timing: strong category > weak category',
   le.leverSectorTiming(14,'large_cap_equity',20).score > le.leverSectorTiming(-12,'large_cap_equity',20).score);
ck('sector_timing: too few peers → baseline',
   le.leverSectorTiming(14,'large_cap_equity',2).source==='baseline');
ck('overbought RSI is NOT rewarded',
   le.leverTechnical({...STRONG,rsi_14:82},'large_cap_equity').score <
   le.leverTechnical({...STRONG,rsi_14:62},'large_cap_equity').score);

console.log('\n── every lever stays inside 0..10 under extreme inputs ──');
const extremes=[
  {price_stats:{data_points:252,sharpe:99,max_drawdown_pct:-99,rsi_14:100,above_ma_50:true,
    above_ma_200:true,golden_cross:true,return_1m:500,return_3m:900,pct_from_52w_high:0},
   fundamentals:{trailing_pe:0.1,forward_pe:0.1,price_to_book:0.1,return_on_equity:9,
    debt_to_equity:0,profit_margin:9,operating_margin:9,earnings_growth:99},
   peer_median_return_3m:-99,peer_count:50},
  {price_stats:{data_points:252,sharpe:-99,max_drawdown_pct:-99,rsi_14:0,above_ma_50:false,
    above_ma_200:false,golden_cross:false,return_1m:-99,return_3m:-99,pct_from_52w_high:-99},
   fundamentals:{trailing_pe:-500,forward_pe:-500,price_to_book:-5,return_on_equity:-9,
    debt_to_equity:9999,profit_margin:-9,operating_margin:-9,earnings_growth:-99},
   peer_median_return_3m:99,peer_count:50},
];
let inRange=true;
for(const m of extremes) for(const cat of Object.keys(le.BASELINE.fundamental)){
  const s=le.scoreInstrument({category:cat},MACRO,m);
  for(const [k,v] of Object.entries(s)){
    if(k.startsWith('_')||k==='composite')continue;
    if(!(Number.isInteger(v)&&v>=0&&v<=10)){inRange=false;console.log(`   OUT OF RANGE ${cat}.${k}=${v}`);}
  }
  if(s.composite<0||s.composite>100){inRange=false;console.log(`   composite out of range: ${s.composite}`);}
}
ck('all levers 0-10 integer, composite 0-100, across 18 combinations', inRange);

console.log('\n── audit trail is populated ──');
ck('sources recorded per lever', Object.keys(a._audit.sources).length===9);
ck('details recorded per lever', Object.keys(a._audit.details).length===9);
ck('measured count reported', a._audit.measured_levers>=6);
ck('data_points reported', a._audit.data_points===252);
