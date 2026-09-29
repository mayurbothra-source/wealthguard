#!/usr/bin/env node
/**
 * WealthGuard — scoring dry run
 *
 * WHY THIS EXISTS
 * ---------------
 * The nine levers changed from five hardcoded category constants to six
 * genuinely per-instrument measures. That changes what signals your clients
 * see. Deploying it and finding out afterwards is the wrong order.
 *
 * This script scores every instrument in your live universe with BOTH the old
 * and the new engine and prints them side by side. It WRITES NOTHING — no
 * scores, no signals, no cache rows. Run it, read the output, and only then
 * deploy.
 *
 * USAGE
 *   node scripts/dry_run_scoring.js                 # 20 instruments, quick
 *   node scripts/dry_run_scoring.js --all           # the whole universe
 *   node scripts/dry_run_scoring.js --limit 40
 *   node scripts/dry_run_scoring.js --category large_cap_equity
 *   node scripts/dry_run_scoring.js --all --csv > scoring_comparison.csv
 *
 * Needs the same environment as the backend: SUPABASE_URL,
 * SUPABASE_SERVICE_KEY. Run it from the repository root.
 *
 * WHAT TO LOOK FOR
 *   1. "no directional call" on statically-priced bonds. That is the
 *      permanent-BUY bug being fixed — those used to publish as BUY having
 *      never been measured.
 *   2. Mid- and small-caps appearing as BUY. Under the old engine they
 *      mathematically could not, whatever their merit.
 *   3. The "measured" column. A low number across the board means Yahoo is
 *      not reachable from Render and the levers are falling back to
 *      baselines — fix that before deploying, or you gain nothing.
 *   4. Instruments whose action flips. Each one is a real change to what a
 *      client is told. Skim them and satisfy yourself they read sensibly.
 */

'use strict';

require('dotenv').config();

const path = require('path');
const ROOT = path.join(__dirname, '..');

const { supabaseAdmin }   = require(path.join(ROOT, 'config/supabase'));
const leverEngine         = require(path.join(ROOT, 'backend/services/leverEngine'));
const fundamentals        = require(path.join(ROOT, 'backend/services/fundamentalsProvider'));
const instrumentEngine    = require(path.join(ROOT, 'backend/services/instrumentEngine'));
const { getMacroIndicators, getIndiaVIX } = require(path.join(ROOT, 'backend/services/marketData'));

/* ── args ──────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const val  = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const ALL      = flag('--all');
const CSV      = flag('--csv');
const LIMIT    = ALL ? 10000 : parseInt(val('--limit', '20'), 10);
const CATEGORY = val('--category', null);

const actionOf = c => (c >= 70 ? 'BUY' : c >= 50 ? 'WATCH' : 'SELL');
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const num = (v, n = 0) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(n));

async function main() {
  if (!supabaseAdmin) {
    console.error('\nSUPABASE_URL and SUPABASE_SERVICE_KEY must be set. ' +
                  'Run this from the repository root with the backend .env in place.\n');
    process.exit(1);
  }

  if (!CSV) {
    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║  WealthGuard — SCORING DRY RUN.  Nothing is written.               ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');
  }

  // ── Market-wide inputs, exactly as the real run fetches them ──────
  let macroData = null, vix = null;
  try { macroData = await getMacroIndicators(); } catch (e) {
    console.warn(`  ⚠ macro unavailable: ${e.message}`);
  }
  try { vix = await getIndiaVIX(); } catch {}
  if (!CSV) {
    console.log(`  Macro: GDP ${macroData?.gdp_latest ?? '—'}%, CPI ${macroData?.cpi_latest ?? '—'}%, ` +
                `FII ₹${num(macroData?.fii_net_cr)}Cr, DII ₹${num(macroData?.dii_net_cr)}Cr, VIX ${num(vix, 1)}`);
    if (!macroData) {
      console.warn('  ⚠ No macro data. Levers 5 and 7 will be neutral for BOTH engines, ' +
                   'so the comparison is still valid — but the absolute scores are not ' +
                   'what production would produce.');
    }
  }

  // ── The universe ──────────────────────────────────────────────────
  let q = supabaseAdmin.from('instrument_universe').select('*').in('status', ['active', 'watchlist']);
  if (CATEGORY) q = q.eq('category', CATEGORY);
  const { data: instruments, error } = await q.order('category').order('symbol');

  if (error) { console.error(`\n  Could not load instruments: ${error.message}\n`); process.exit(1); }
  if (!instruments?.length) { console.error('\n  No instruments found.\n'); process.exit(1); }

  const sample = instruments.slice(0, LIMIT);
  if (!CSV) {
    console.log(`  Universe: ${instruments.length} instruments; scoring ${sample.length}` +
                `${CATEGORY ? ` in ${CATEGORY}` : ''}\n`);
    console.log('  Fetching a year of price history per instrument. Roughly 1s each — ' +
                'be patient on a full run.\n');
  }

  // noWrite: true — the whole point of a dry run
  const { metrics, summary } = await fundamentals.buildMetrics(sample, { noWrite: true });
  if (!CSV) { fundamentals.logSummary(summary); console.log(''); }

  /* ── Score with both engines ─────────────────────────────────────── */
  const rows = [];
  for (const inst of sample) {
    const m = metrics[inst.symbol] || null;

    // NEW
    const neu = leverEngine.scoreInstrument(inst, macroData, m);

    // OLD — needs the price shape the legacy scorer expected. Its only
    // per-instrument input was today's % change, which is recoverable from
    // the same history, so the comparison is apples to apples.
    const ps = m?.price_stats;
    let legacyPrice = null;
    if (ps?.last_close != null) {
      const oneDay = ps.return_1m != null ? ps.return_1m / 21 : 0;  // daily proxy
      legacyPrice = { price: ps.last_close, change_pct: oneDay, source: 'dry_run' };
    }
    const old = await instrumentEngine.scoreInstrumentLegacy(inst, macroData, legacyPrice);

    const oldAction = actionOf(old.composite);
    const newAction = neu._audit.insufficient_data ? 'WATCH*' : actionOf(neu.composite);

    rows.push({
      symbol: inst.symbol, category: inst.category,
      oldComposite: old.composite, newComposite: neu.composite,
      oldAction, newAction,
      flipped: oldAction !== newAction.replace('*', ''),
      insufficient: neu._audit.insufficient_data,
      reason: neu._audit.insufficient_reason,
      measured: neu._audit.measured_levers,
      points: neu._audit.data_points,
      sharpe: ps?.sharpe, vol: ps?.volatility_pct, rsi: ps?.rsi_14,
      ret3m: ps?.return_3m,
      levers: neu, oldLevers: old,
      details: neu._audit.details,
    });
  }

  /* ── CSV ─────────────────────────────────────────────────────────── */
  if (CSV) {
    console.log('symbol,category,old_composite,new_composite,delta,old_action,new_action,flipped,' +
                'insufficient_data,levers_measured,price_days,sharpe,volatility_pct,rsi_14,return_3m');
    for (const r of rows) {
      console.log([r.symbol, r.category, r.oldComposite, r.newComposite,
        r.newComposite - r.oldComposite, r.oldAction, r.newAction, r.flipped,
        r.insufficient, r.measured, r.points,
        r.sharpe?.toFixed(2) ?? '', r.vol?.toFixed(1) ?? '',
        r.rsi?.toFixed(0) ?? '', r.ret3m?.toFixed(1) ?? ''].join(','));
    }
    return;
  }

  /* ── Table ───────────────────────────────────────────────────────── */
  console.log('  ' + '═'.repeat(100));
  console.log('  ' + pad('SYMBOL', 15) + pad('CATEGORY', 19) +
              pad('OLD', 6) + pad('NEW', 6) + pad('Δ', 6) +
              pad('OLD CALL', 10) + pad('NEW CALL', 10) + pad('MEAS', 6) + 'DAYS');
  console.log('  ' + '═'.repeat(100));

  let lastCat = null;
  for (const r of rows) {
    if (r.category !== lastCat) { console.log('  ' + '─'.repeat(100)); lastCat = r.category; }
    const d = r.newComposite - r.oldComposite;
    const mark = r.insufficient ? ' ⓘ' : (r.flipped ? ' ←' : '');
    console.log('  ' + pad(r.symbol, 15) + pad(r.category, 19) +
      pad(r.oldComposite, 6) + pad(r.newComposite, 6) +
      pad((d >= 0 ? '+' : '') + d, 6) +
      pad(r.oldAction, 10) + pad(r.newAction + mark, 10) +
      pad(`${r.measured}/9`, 6) + (r.points || '—'));
  }
  console.log('  ' + '═'.repeat(100));

  /* ── What changed, and why it matters ────────────────────────────── */
  const flipped = rows.filter(r => r.flipped);
  const insuf   = rows.filter(r => r.insufficient);
  const wasBuy  = rows.filter(r => r.oldAction === 'BUY');
  const nowBuy  = rows.filter(r => r.newAction === 'BUY');
  const avgMeasured = rows.reduce((s, r) => s + r.measured, 0) / rows.length;

  console.log('\n  SUMMARY\n  ' + '─'.repeat(50));
  console.log(`  instruments scored            ${rows.length}`);
  console.log(`  average levers measured       ${avgMeasured.toFixed(1)} / 9   (was 2 / 9 for everything)`);
  console.log(`  BUY calls, old → new          ${wasBuy.length} → ${nowBuy.length}`);
  console.log(`  actions that changed          ${flipped.length}`);
  console.log(`  no directional call possible  ${insuf.length}`);

  if (avgMeasured < 4) {
    console.log('\n  ⚠⚠ WARNING — fewer than 4 levers measured on average.');
    console.log('     Yahoo is probably unreachable from this machine, so the levers are');
    console.log('     falling back to the same category baselines as before. Deploying now');
    console.log('     would gain you nothing. Check outbound network access first, then');
    console.log('     re-run this. Do not skip this.');
  }

  if (insuf.length) {
    console.log('\n  NO DIRECTIONAL CALL — these used to publish a direction anyway\n  ' + '─'.repeat(50));
    for (const r of insuf.slice(0, 15)) {
      console.log(`  ${pad(r.symbol, 16)} was ${pad(r.oldAction, 6)} at ${r.oldComposite}/100`);
      console.log(`  ${' '.repeat(16)} ${r.reason}`);
    }
    console.log('\n  Each of those scored on category constants alone — nothing about the');
    console.log('  individual instrument was ever measured. A G-Sec scoring 74 and');
    console.log('  publishing as BUY in every market condition was the clearest symptom.');
  }

  if (flipped.length) {
    console.log('\n  ACTIONS THAT CHANGED — read these\n  ' + '─'.repeat(50));
    for (const r of flipped.slice(0, 25)) {
      console.log(`\n  ${r.symbol} (${r.category}): ${r.oldAction} ${r.oldComposite} → ${r.newAction} ${r.newComposite}`);
      const moved = Object.keys(r.levers)
        .filter(k => !k.startsWith('_') && k !== 'composite' && r.levers[k] !== r.oldLevers[k])
        .map(k => `${k} ${r.oldLevers[k]}→${r.levers[k]}`);
      if (moved.length) console.log(`     levers: ${moved.join(', ')}`);
      const why = ['technical', 'fundamental', 'risk_adjusted', 'competitive']
        .map(k => r.details[k]).filter(Boolean).slice(0, 2);
      if (why.length) console.log(`     because: ${why.join(' · ')}`);
    }
    if (flipped.length > 25) console.log(`\n  …and ${flipped.length - 25} more. Use --csv for the full list.`);
  }

  /* ── The defect that started this, measured ──────────────────────── */
  console.log('\n  THE ORIGINAL DEFECT — can the model tell peers apart?\n  ' + '─'.repeat(50));
  const byCat = {};
  rows.forEach(r => { (byCat[r.category] = byCat[r.category] || []).push(r); });
  for (const [cat, list] of Object.entries(byCat)) {
    if (list.length < 2) continue;
    const spread = a => Math.max(...a) - Math.min(...a);
    const o = spread(list.map(r => r.oldComposite));
    const n = spread(list.map(r => r.newComposite));
    console.log(`  ${pad(cat, 20)} spread within category: ${pad(o, 4)} → ${n}` +
                (n > o * 1.5 ? '   ✓ differentiates' : n <= o ? '   ⚠ no better' : ''));
  }
  console.log('\n  A larger spread means the model distinguishes instruments rather than');
  console.log('  their asset class. Under the old engine two large-caps on the same day');
  console.log('  scored 66 and 67 — one point apart, and that point was sentiment.');

  console.log('\n  Nothing was written. Re-run with --all before deploying.\n');
}

main().catch(e => { console.error(`\nDry run failed: ${e.stack}\n`); process.exit(1); });
