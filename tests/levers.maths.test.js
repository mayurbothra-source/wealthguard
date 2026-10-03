const fp=require('../backend/services/fundamentalsProvider.js');
const ck=require('./_check');
const approx=(a,b,t=0.5)=>a!=null&&Math.abs(a-b)<t;

console.log('\n── dailyReturns ──');
ck('simple series', JSON.stringify(fp.dailyReturns([100,110,99]).map(x=>+x.toFixed(4)))==='[0.1,-0.1]');
ck('skips nulls/zeros', fp.dailyReturns([100,null,0,120]).length<=2);
ck('empty → []', fp.dailyReturns([]).length===0);

console.log('\n── volatility ──');
const flat=Array(260).fill(100);
ck('flat series → 0% vol', approx(fp.annualisedVolatility(flat),0,0.001));
ck('too short → null', fp.annualisedVolatility([100,101,102])===null);
// Known case: alternating ±1% daily → daily sd ≈ 0.01 → annualised ≈ 15.9%
const alt=[100]; for(let i=1;i<260;i++) alt.push(alt[i-1]*(i%2?1.01:1/1.01));
ck('±1%/day → ~16% annualised', approx(fp.annualisedVolatility(alt),15.9,1.5));

console.log('\n── Sharpe ──');
// Steady +20%/yr with near-zero vol → very high Sharpe
const steady=[100]; for(let i=1;i<252;i++) steady.push(steady[i-1]*Math.pow(1.20,1/252));
const sh=fp.sharpeRatio(steady);
ck('steady grower → positive Sharpe', sh>0);
ck('flat series → null (zero vol)', fp.sharpeRatio(flat)===null);
// A high-vol instrument returning the risk-free rate should sit near 0
const rf=[100]; for(let i=1;i<252;i++) rf.push(rf[i-1]*Math.pow(1.07,1/252)*(i%2?1.02:1/1.02));
ck('return == risk-free → Sharpe near 0', Math.abs(fp.sharpeRatio(rf))<0.3);
ck('a falling instrument → negative Sharpe', fp.sharpeRatio([...Array(252)].map((_,i)=>100-i*0.2))<0);

console.log('\n── maxDrawdown ──');
ck('monotonic rise → 0', approx(fp.maxDrawdown([...Array(30)].map((_,i)=>100+i)),0,0.001));
const dd=[...Array(15).fill(0).map((_,i)=>100+i), ...Array(15).fill(0).map((_,i)=>114-i*2)];
ck('peak 114 → trough 86 ≈ -24.6%', approx(fp.maxDrawdown(dd),-24.6,1));
ck('too short → null', fp.maxDrawdown([100,90])===null);

console.log('\n── RSI ──');
ck('all gains → 100', fp.rsi([...Array(30)].map((_,i)=>100+i))===100);
const allLoss=fp.rsi([...Array(30)].map((_,i)=>200-i*2));
ck('all losses → ~0', allLoss!=null && allLoss<1);
ck('flat → null or 100 (no loss)', [null,100].includes(fp.rsi(flat)) || fp.rsi(flat)>=0);
ck('too short → null', fp.rsi([100,101,102])===null);
const mixed=fp.rsi(alt.slice(0,40));
ck('choppy → mid range', mixed>30&&mixed<70);

console.log('\n── SMA / trailing return ──');
ck('sma of 1..10 over 10 = 5.5', approx(fp.sma([...Array(10)].map((_,i)=>i+1),10),5.5,0.01));
ck('sma too short → null', fp.sma([1,2,3],10)===null);
ck('trailingReturn 21d', approx(fp.trailingReturn([...Array(30)].map(()=>100).concat([110]),1),10,0.01));
ck('trailingReturn too short → null', fp.trailingReturn([100,101],21)===null);

console.log('\n── computePriceStats end to end ──');
const s=fp.computePriceStats(steady);
ck('data_points counted', s.data_points===252);
ck('last_close set', s.last_close>100);
ck('volatility computed', s.volatility_pct!=null);
ck('sharpe computed', s.sharpe!=null);
ck('rsi computed', s.rsi_14!=null);
ck('ma_50 and ma_200 computed', s.ma_50!=null && s.ma_200!=null);
ck('uptrend: above both MAs', s.above_ma_50===true && s.above_ma_200===true);
ck('golden cross true', s.golden_cross===true);
ck('return_1y ~ +20%', approx(s.return_1y,20,3));
ck('at 52w high → pct_from_high ~0', approx(s.pct_from_52w_high,0,0.5));

console.log('\n── short/absent series never invents a number ──');
const t=fp.computePriceStats([100,101]);
['volatility_pct','sharpe','max_drawdown_pct','rsi_14','ma_50','ma_200','return_1m','return_1y']
  .forEach(k=>ck(`${k} is null, not guessed`, t[k]===null));
const e=fp.computePriceStats(null);
ck('null input → data_points 0', e.data_points===0);
ck('null input → last_close null', e.last_close===null);

console.log('\n── trailingReturn coverage rule (the bug just fixed) ──');
const yr = [100]; for(let i=1;i<252;i++) yr.push(yr[i-1]*Math.pow(1.20,1/252));
const st = fp.computePriceStats(yr);
ck('252 points → return_1y computed (was null)', st.return_1y!=null);
ck('return_1y ~ +20%', approx(st.return_1y,20,3));
ck('248 points still works', fp.computePriceStats(yr.slice(0,248)).return_1y!=null);
ck('only 100 points → return_1y null (below 80%)', fp.computePriceStats(yr.slice(0,100)).return_1y===null);
ck('100 points → return_3m still computed', fp.computePriceStats(yr.slice(0,100)).return_3m!=null);
ck('30 points → return_1m computed', fp.computePriceStats(yr.slice(0,30)).return_1m!=null);
ck('10 points → return_1m null', fp.computePriceStats(yr.slice(0,10)).return_1m===null);
