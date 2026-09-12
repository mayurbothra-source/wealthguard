/**
 * WealthGuard Benchmark Engine
 *
 * Runs on the 1st of every month at 7:00 PM IST.
 *
 * Sets the accuracy benchmark each category is held to for the coming month.
 * Zero human input: the benchmark is derived from what the engine has
 * actually achieved over the trailing 3 months, not from what anyone hopes.
 *
 * Derivation rules:
 *   - Benchmark = rolling 3-month average of actual directional accuracy
 *   - Floor of 50% — we never publish a target worse than a coin flip
 *   - Ceiling: benchmark can never exceed (recent average + 5pp). Prevents
 *     one lucky month from setting an unrealistic bar for the next.
 *   - If fewer than MIN_SAMPLE resolved checkpoints exist for a category,
 *     the previous month's benchmark carries forward unchanged (we do not
 *     set targets on noise)
 *   - Month 1 with no history at all: seeded 60% floor (already in SQL)
 *
 * Also records what was ACTUALLY achieved last month alongside the new
 * benchmark, so the admin panel and homepage can show benchmark vs reality.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { reportRun }     = require('./healthEngine');

const ACCURACY_FLOOR       = 50;  // never publish a target below this
const IMPROVEMENT_CAP_PP   = 5;   // benchmark can't exceed recent avg + 5pp
const MIN_SAMPLE           = 10;  // minimum resolved checkpoints to set a benchmark
const DEFAULT_BENCHMARK    = 60;  // used only when there is no history at all

const CATEGORIES = [
  'large_cap_equity', 'mid_cap_equity', 'small_cap_equity',
  'large_cap_fund',   'flexi_mid_fund', 'index_etf',
  'gold',             'bond_gsec',      'debt_fund',
];

function firstOfMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
    .toISOString().split('T')[0];
}

function monthsAgo(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * Calculates actual directional accuracy for a category over a window.
 * Returns { weekly, monthly, quarterly, sample } — percentages or null.
 */
async function calculateActualAccuracy(category, sinceISO) {
  if (!supabaseAdmin) return { weekly: null, monthly: null, quarterly: null, sample: 0 };

  try {
    // Get all instruments in this category
    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('symbol')
      .eq('category', category);

    if (!instruments?.length) {
      return { weekly: null, monthly: null, quarterly: null, sample: 0 };
    }
    const symbols = instruments.map(i => i.symbol);

    // Fetch resolved outcomes for those instruments in the window
    const { data: outcomes } = await supabaseAdmin
      .from('recommendation_outcomes')
      .select('return_1w_pct, return_1m_pct, return_3m_pct, direction_correct, measured_at, recommendations!inner(instrument_name, client_id)')
      .gte('measured_at', sinceISO)
      .is('recommendations.client_id', null)
      .in('recommendations.instrument_name', symbols);

    if (!outcomes?.length) {
      return { weekly: null, monthly: null, quarterly: null, sample: 0 };
    }

    const tally = (field) => {
      const rows = outcomes.filter(o => o[field] !== null && o[field] !== undefined);
      if (!rows.length) return null;
      const correct = rows.filter(o => o.direction_correct === true).length;
      return { pct: (correct / rows.length) * 100, n: rows.length };
    };

    const w = tally('return_1w_pct');
    const m = tally('return_1m_pct');
    const q = tally('return_3m_pct');

    return {
      weekly:    w ? parseFloat(w.pct.toFixed(2)) : null,
      monthly:   m ? parseFloat(m.pct.toFixed(2)) : null,
      quarterly: q ? parseFloat(q.pct.toFixed(2)) : null,
      sample:    outcomes.length,
    };
  } catch (e) {
    console.warn(`   ⚠ Accuracy calc failed for ${category}: ${e.message}`);
    return { weekly: null, monthly: null, quarterly: null, sample: 0 };
  }
}

/**
 * Fetches the previous month's benchmark for a category (carry-forward source).
 */
async function getPreviousBenchmark(category) {
  if (!supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('category_benchmarks')
      .select('*')
      .eq('category', category)
      .order('period_month', { ascending: false })
      .limit(1);
    return data?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Applies the derivation rules to produce a benchmark from actuals.
 */
function deriveBenchmark(actual, previousBenchmark, sample) {
  // Not enough data — carry forward, or use default if nothing exists
  if (actual === null || sample < MIN_SAMPLE) {
    return {
      value: previousBenchmark ?? DEFAULT_BENCHMARK,
      note:  sample < MIN_SAMPLE
        ? `Carried forward — only ${sample} resolved checkpoints (need ${MIN_SAMPLE})`
        : 'Carried forward — no measurable accuracy this period',
    };
  }

  // Floor
  let value = Math.max(ACCURACY_FLOOR, actual);

  // Ceiling: can't jump more than IMPROVEMENT_CAP_PP above what we actually did
  const cap = actual + IMPROVEMENT_CAP_PP;
  if (value > cap) value = cap;

  return {
    value: parseFloat(value.toFixed(2)),
    note:  `Derived from ${sample} resolved checkpoints (actual: ${actual.toFixed(1)}%)`,
  };
}

/**
 * Main engine — runs monthly.
 */
async function runBenchmarkEngine() {
  if (!supabaseAdmin) {
    console.log('📐 Benchmark engine: Supabase not configured, skipping.');
    return;
  }

  const start = Date.now();
  console.log('📐 Running monthly benchmark engine...');

  const periodMonth = firstOfMonth();
  const since       = monthsAgo(3);  // rolling 3-month window
  let updated = 0, carried = 0, failed = 0;

  for (const category of CATEGORIES) {
    try {
      const actual   = await calculateActualAccuracy(category, since);
      const previous = await getPreviousBenchmark(category);

      const w = deriveBenchmark(actual.weekly,    previous?.benchmark_1w_pct, actual.sample);
      const m = deriveBenchmark(actual.monthly,   previous?.benchmark_1m_pct, actual.sample);
      const q = deriveBenchmark(actual.quarterly, previous?.benchmark_3m_pct, actual.sample);

      const isCarryForward = actual.sample < MIN_SAMPLE;

      const { error } = await supabaseAdmin
        .from('category_benchmarks')
        .upsert({
          category,
          period_month:     periodMonth,
          benchmark_1w_pct: w.value,
          benchmark_1m_pct: m.value,
          benchmark_3m_pct: q.value,
          actual_1w_pct:    actual.weekly,
          actual_1m_pct:    actual.monthly,
          actual_3m_pct:    actual.quarterly,
          sample_size:      actual.sample,
          derivation_note:  w.note,
          created_at:       new Date().toISOString(),
        }, { onConflict: 'category,period_month' });

      if (error) {
        console.warn(`   ⚠ ${category}: upsert failed — ${error.message}`);
        failed++;
      } else {
        if (isCarryForward) carried++; else updated++;
        const actualStr = actual.weekly !== null ? `${actual.weekly.toFixed(1)}%` : '—';
        console.log(`   📐 ${category.padEnd(18)} benchmark ${w.value}%  (actual ${actualStr}, n=${actual.sample})`);
      }
    } catch (e) {
      console.error(`   ❌ ${category}: ${e.message}`);
      failed++;
    }
  }

  const duration = Date.now() - start;
  console.log(`📐 Benchmark engine complete: ${updated} derived, ${carried} carried forward, ${failed} failed.`);

  await reportRun({
    engineName:     'benchmarkEngine',
    durationMs:     duration,
    itemsProcessed: updated + carried,
    itemsExpected:  CATEGORIES.length,
    itemsFailed:    failed,
    detail:         `${updated} derived from actuals, ${carried} carried forward`,
  });
}

/**
 * Reads the current benchmark for a category — used by the frontend
 * and by other engines that want to compare performance to target.
 */
async function getCurrentBenchmark(category) {
  if (!supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('category_benchmarks')
      .select('*')
      .eq('category', category)
      .order('period_month', { ascending: false })
      .limit(1);
    return data?.[0] || null;
  } catch {
    return null;
  }
}

module.exports = { runBenchmarkEngine, getCurrentBenchmark };
