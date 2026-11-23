/**
 * SA5 dry run: what would the nine-lever engine have said on each Monday of
 * Oct–Nov 2026, using only the price history available on that date?
 *
 *   node scripts/sa5/simulate.js [outFile]
 *
 * Uses the production code paths (computePriceStats, scoreInstrument,
 * decideAction) and the same macro inputs production passes (getMacroIndicators,
 * no FII/DII figures). Fundamentals are not fetched, so the fundamental and
 * management levers use their category baselines — as production does when
 * Yahoo's quoteSummary is unavailable. The risk gate (VIX regime, concentration)
 * is not simulated; it can only veto, never create, a BUY.
 *
 * Runs where Yahoo and MFAPI are reachable (GitHub Actions); writes nothing to
 * any database.
 */
'use strict';
process.env.NODE_ENV = process.env.NODE_ENV || 'simulation';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const F = require('../../backend/services/fundamentalsProvider');
const L = require('../../backend/services/leverEngine');

const OUT = process.argv[2] || path.join(__dirname, 'simulation-oct-nov-2026.log');
const DATES = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-20'];
const MACRO = { repo_rate: 6.5, cpi_latest: 4.83, gdp_latest: 7.2 };   // marketData.getMacroIndicators()
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

async function yahoo(ticker) {
  for (let i = 0; i < 4; i++) {
    try {
      const { data } = await axios.get(`https://query${1 + (i % 2)}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
        { params: { range: '2y', interval: '1d' }, headers: UA, timeout: 15000 });
      const r = data?.chart?.result?.[0];
      const ts = r?.timestamp || [], c = r?.indicators?.quote?.[0]?.close || [];
      return ts.map((t, k) => ({ date: new Date((t + 19800) * 1000).toISOString().slice(0, 10), close: c[k] })).filter(p => p.close > 0);
    } catch (e) {
      if (i === 3) throw e;
      await sleep(2000 * 2 ** i);
    }
  }
}
async function mfapi(code) {
  const { data } = await axios.get(`https://api.mfapi.in/mf/${code}`, { timeout: 20000 });
  return (data?.data || []).map(r => {
    const [d, m, y] = String(r.date).split('-');
    return { date: `${y}-${m}-${d}`, close: parseFloat(r.nav) };
  }).filter(p => p.close > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
}

(async () => {
  const U = require('./universe.json').rows.map(([symbol, category, price_source, yahoo_ticker, amfi_code, status]) =>
    ({ symbol, category, price_source, yahoo_ticker, amfi_code, status }));
  log(`SA5 dry run — ${new Date().toISOString()} — ${U.length} instruments, dates ${DATES.join(', ')}`);
  log('Inputs: production lever code, BUY >= 70 / WATCH 50-69 / SELL < 50 (unchanged), macro as production, no fundamentals, no AI lever, no risk gate.\n');

  const series = {}, fetchErr = {};
  for (const inst of U) {
    if (inst.price_source === 'static') continue;
    try {
      if (inst.price_source === 'mfapi') { if (!inst.amfi_code) throw new Error('no AMFI code'); series[inst.symbol] = await mfapi(inst.amfi_code); }
      else series[inst.symbol] = await yahoo(inst.yahoo_ticker);
    } catch (e) { fetchErr[inst.symbol] = e.response ? `HTTP ${e.response.status}` : e.message; }
    await sleep(inst.price_source === 'mfapi' ? 200 : 700);
  }
  const got = Object.keys(series).filter(k => series[k].length);
  log(`Price history fetched: ${got.length} instruments; failed: ${Object.keys(fetchErr).length}` +
      (Object.keys(fetchErr).length ? ` (${Object.entries(fetchErr).map(([k, v]) => `${k}: ${v}`).join('; ')})` : ''));
  const stale = got.filter(k => series[k].at(-1).date < '2026-11-01');
  if (stale.length) log(`History ends before 1 Nov (dead codes / delisted?): ${stale.map(k => `${k} (last ${series[k].at(-1).date})`).join(', ')}`);
  log('');

  const totals = { BUY: 0, WATCH: 0, SELL: 0 };
  const buyBy = {};
  for (const date of DATES) {
    // metrics as of `date`: last ~1y of closes on or before it
    const metrics = {};
    for (const inst of U) {
      const s = (series[inst.symbol] || []).filter(p => p.date <= date);
      const closes = s.slice(-252).map(p => p.close);
      const fresh = s.length && s.at(-1).date >= isoMinus(date, 7);
      metrics[inst.symbol] = { category: inst.category, price_stats: closes.length && fresh ? F.computePriceStats(closes) : null, fundamentals: null };
    }
    const byCat = {};
    for (const m of Object.values(metrics)) if (m.price_stats?.return_3m != null) (byCat[m.category] = byCat[m.category] || []).push(m.price_stats.return_3m);
    const med = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    for (const m of Object.values(metrics)) { m.peer_median_return_3m = byCat[m.category] ? med(byCat[m.category]) : null; m.peer_count = (byCat[m.category] || []).length; }

    const rows = [];
    for (const inst of U.filter(i => i.status === 'active')) {
      const sc = L.scoreInstrument(inst, MACRO, metrics[inst.symbol]);
      const dec = L.decideAction({ composite: sc.composite, insufficient_data: sc._audit.insufficient_data, price_source: inst.price_source });
      rows.push({ sym: inst.symbol, cat: inst.category, c: sc.composite, a: dec.action, measured: !sc._audit.insufficient_data, sc });
    }
    const cnt = { BUY: 0, WATCH: 0, SELL: 0 };
    rows.forEach(r => { cnt[r.a]++; totals[r.a]++; });
    const measured = rows.filter(r => r.measured);
    log(`── ${date}: ${rows.length} active instruments, ${measured.length} measured — BUY ${cnt.BUY}, WATCH ${cnt.WATCH}, SELL ${cnt.SELL}`);
    const best = [...measured].sort((a, b) => b.c - a.c).slice(0, 8);
    log(`   top measured composites: ${best.map(r => `${r.sym} ${r.c}`).join(', ')}`);
    for (const r of rows.filter(r => r.a === 'BUY')) {
      (buyBy[r.sym] = buyBy[r.sym] || []).push(date);
      const l = r.sc;
      log(`   BUY ${r.sym} [${r.cat}] ${r.c} — tech ${l.technical} fund ${l.fundamental} mgmt ${l.management} sent ${l.sentiment} inst ${l.institutional} sector ${l.sector_timing} macro ${l.macro_pestle} comp ${l.competitive} risk ${l.risk_adjusted}`);
    }
    for (const r of rows.filter(r => r.a === 'SELL')) log(`   SELL ${r.sym} [${r.cat}] ${r.c}`);
  }
  log(`\nTotals over ${DATES.length} dates: BUY ${totals.BUY}, WATCH ${totals.WATCH}, SELL ${totals.SELL}`);
  const eq = Object.keys(buyBy).filter(s => { const u = U.find(x => x.symbol === s); return u && !['debt_fund', 'bond_gsec'].includes(u.category); });
  log(`Distinct instruments with a BUY: ${Object.keys(buyBy).length} (${Object.keys(buyBy).join(', ') || 'none'})`);
  log(`…of which equity / equity MF / index / gold: ${eq.length} (${eq.join(', ') || 'none'})`);
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`\nWritten to ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });

function isoMinus(ymd, n) { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
