/**
 * WealthGuard Instrument Review Engine
 *
 * Runs monthly on the 1st at 8:00 PM IST (after the benchmark engine).
 *
 * Maintains the 100 active + 20 watchlist universe with zero human input.
 *
 * REMOVAL criteria (any one triggers removal to watchlist):
 *   - Composite score below exit threshold for 2 consecutive scoring runs
 *   - Data feed failed for 4+ consecutive weeks (no honest signal possible)
 *   - Trailing-quarter directional accuracy below 40% (worse than a coin flip)
 *
 * PROMOTION criteria (all must be true):
 *   - Composite score >= 68 for 3 consecutive scoring runs
 *   - Working price feed confirmed
 *   - Target category has room, OR the instrument outscores the weakest
 *     instrument currently in that category
 *
 * CATEGORY CAPS are hard. Promotion into a full category REPLACES the weakest
 * member (which moves to watchlist) rather than expanding the category.
 *
 * Every decision is logged to instrument_review_log with its reason.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { reportRun }     = require('./healthEngine');

// Hard caps per category — the 100 active instruments
const CATEGORY_CAPS = {
  large_cap_equity: 20,
  mid_cap_equity:   15,
  small_cap_equity: 10,
  large_cap_fund:   10,
  flexi_mid_fund:   10,
  index_etf:         8,
  gold:              7,
  bond_gsec:        10,
  debt_fund:        10,
};
const WATCHLIST_CAP = 20;

const PROMOTE_SCORE        = 68;
const PROMOTE_RUNS         = 3;   // consecutive runs above threshold
const DEMOTE_RUNS          = 2;   // consecutive runs below exit threshold
const ACCURACY_FLOOR_PCT   = 40;  // trailing quarter directional accuracy
const MIN_ACCURACY_SAMPLE  = 6;   // need this many checkpoints before judging on accuracy
const DATA_FEED_FAIL_WEEKS = 4;

async function logReview(instrument, action, reason, score, accuracy, replacedBy) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('instrument_review_log').insert({
      review_date:     new Date().toISOString().split('T')[0],
      instrument_id:   instrument.id,
      symbol:          instrument.symbol,
      action_taken:    action,
      reason,
      composite_score: score ?? null,
      accuracy_pct:    accuracy ?? null,
      replaced_by:     replacedBy ?? null,
      created_at:      new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`   ⚠ Review log failed for ${instrument.symbol}: ${e.message}`);
  }
}

/**
 * Recent composite scores for an instrument, newest first.
 */
async function getRecentScores(instrumentId, limit = 4) {
  if (!supabaseAdmin) return [];
  try {
    const { data } = await supabaseAdmin
      .from('instrument_scores')
      .select('composite_score, scored_at')
      .eq('instrument_id', instrumentId)
      .order('scored_at', { ascending: false })
      .limit(limit);
    return (data || []).map(d => d.composite_score).filter(s => s != null);
  } catch {
    return [];
  }
}

/**
 * Trailing-quarter directional accuracy for an instrument.
 * Returns { pct, sample } — pct is null if sample is too small to judge.
 */
async function getTrailingAccuracy(symbol) {
  if (!supabaseAdmin) return { pct: null, sample: 0 };
  try {
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const { data } = await supabaseAdmin
      .from('recommendation_outcomes')
      .select('direction_correct, recommendations!inner(instrument_name, client_id)')
      .gte('measured_at', since)
      .is('recommendations.client_id', null)
      .eq('recommendations.instrument_name', symbol);

    if (!data?.length || data.length < MIN_ACCURACY_SAMPLE) {
      return { pct: null, sample: data?.length || 0 };
    }
    const correct = data.filter(d => d.direction_correct === true).length;
    return { pct: (correct / data.length) * 100, sample: data.length };
  } catch {
    return { pct: null, sample: 0 };
  }
}

/**
 * Determines which category a watchlist instrument should be promoted into,
 * based on its type and risk level.
 */
function targetCategoryFor(instrument) {
  if (instrument.instrument_type === 'mutual_fund') {
    return instrument.risk_level === 'moderate_high' ? 'flexi_mid_fund' : 'large_cap_fund';
  }
  if (instrument.instrument_type === 'etf')  return 'index_etf';
  if (instrument.instrument_type === 'bond') return 'bond_gsec';
  // equity
  if (instrument.risk_level === 'high')          return 'small_cap_equity';
  if (instrument.risk_level === 'moderate_high') return 'mid_cap_equity';
  return 'large_cap_equity';
}

// ─────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────

async function runInstrumentReview() {
  if (!supabaseAdmin) {
    console.log('🔍 Instrument review: Supabase not configured, skipping.');
    return;
  }

  const start = Date.now();
  console.log('🔍 Running monthly instrument universe review...');

  let demoted = 0, promoted = 0, replaced = 0, retained = 0, failed = 0;

  try {
    const { data: all } = await supabaseAdmin
      .from('instrument_universe')
      .select('*')
      .in('status', ['active', 'watchlist']);

    if (!all?.length) {
      console.log('🔍 No instruments to review.');
      return;
    }

    const active    = all.filter(i => i.status === 'active');
    const watchlist = all.filter(i => i.status === 'watchlist');

    console.log(`   Reviewing ${active.length} active + ${watchlist.length} watchlist instruments\n`);

    // ── PASS 1: Identify active instruments that should be demoted ────
    const toDemote = [];

    for (const inst of active) {
      try {
        const scores   = await getRecentScores(inst.id, DEMOTE_RUNS);
        const accuracy = await getTrailingAccuracy(inst.symbol);

        // Criterion 1: sustained low score
        const sustainedLow = scores.length >= DEMOTE_RUNS &&
          scores.slice(0, DEMOTE_RUNS).every(s => s <= (inst.exit_score_threshold ?? 30));

        // Criterion 2: dead data feed
        const feedDead = (inst.data_feed_failures || 0) >= DATA_FEED_FAIL_WEEKS;

        // Criterion 3: accuracy below floor (only if we have enough sample)
        const poorAccuracy = accuracy.pct !== null && accuracy.pct < ACCURACY_FLOOR_PCT;

        if (sustainedLow || feedDead || poorAccuracy) {
          const reason = sustainedLow
            ? `Composite score below exit threshold ${inst.exit_score_threshold} for ${DEMOTE_RUNS} consecutive runs`
            : feedDead
            ? `Price feed failed ${inst.data_feed_failures} consecutive weeks — no honest signal possible`
            : `Trailing-quarter directional accuracy ${accuracy.pct.toFixed(0)}% below ${ACCURACY_FLOOR_PCT}% floor (n=${accuracy.sample})`;

          toDemote.push({ inst, reason, score: scores[0], accuracy: accuracy.pct });
        } else {
          retained++;
        }
      } catch (e) {
        console.warn(`   ⚠ Review failed for ${inst.symbol}: ${e.message}`);
        failed++;
      }
    }

    // ── PASS 2: Identify watchlist instruments ready for promotion ────
    const toPromote = [];

    for (const inst of watchlist) {
      try {
        const scores = await getRecentScores(inst.id, PROMOTE_RUNS);
        const qualified = scores.length >= PROMOTE_RUNS &&
          scores.slice(0, PROMOTE_RUNS).every(s => s >= PROMOTE_SCORE);
        const feedOk = (inst.data_feed_failures || 0) < DATA_FEED_FAIL_WEEKS;

        if (qualified && feedOk) {
          toPromote.push({ inst, score: scores[0], targetCat: targetCategoryFor(inst) });
        }
      } catch (e) {
        failed++;
      }
    }

    console.log(`   Candidates: ${toDemote.length} for demotion, ${toPromote.length} for promotion\n`);

    // ── PASS 3: Execute demotions ─────────────────────────────────────
    for (const { inst, reason, score, accuracy } of toDemote) {
      try {
        await supabaseAdmin.from('instrument_universe').update({
          status:       'watchlist',
          is_watchlist: true,
          category:     'watchlist',
        }).eq('id', inst.id);

        await logReview(inst, 'demoted_to_watchlist', reason, score, accuracy, null);
        console.log(`   🔻 DEMOTED: ${inst.symbol} — ${reason}`);
        demoted++;
      } catch (e) {
        failed++;
      }
    }

    // ── PASS 4: Execute promotions, respecting category caps ──────────
    // Recount categories after demotions so caps reflect current reality
    const { data: current } = await supabaseAdmin
      .from('instrument_universe')
      .select('id, symbol, category, current_score')
      .eq('status', 'active');

    const catCounts = {};
    (current || []).forEach(i => {
      catCounts[i.category] = (catCounts[i.category] || 0) + 1;
    });

    for (const { inst, score, targetCat } of toPromote) {
      try {
        const cap     = CATEGORY_CAPS[targetCat] ?? 10;
        const count   = catCounts[targetCat] || 0;

        if (count < cap) {
          // Room available — straight promotion
          await supabaseAdmin.from('instrument_universe').update({
            status:       'active',
            is_watchlist: false,
            category:     targetCat,
          }).eq('id', inst.id);

          await logReview(inst, 'promoted',
            `Scored >=${PROMOTE_SCORE} for ${PROMOTE_RUNS} consecutive runs; ${targetCat} had capacity`,
            score, null, null);
          console.log(`   🔺 PROMOTED: ${inst.symbol} → ${targetCat} (score ${score})`);
          catCounts[targetCat] = count + 1;
          promoted++;

        } else {
          // Category full — replace the weakest member if this one is stronger
          const inCat = (current || [])
            .filter(i => i.category === targetCat && i.current_score != null)
            .sort((a, b) => a.current_score - b.current_score);

          const weakest = inCat[0];
          if (weakest && score > weakest.current_score) {
            // Demote the weakest
            await supabaseAdmin.from('instrument_universe').update({
              status: 'watchlist', is_watchlist: true, category: 'watchlist',
            }).eq('id', weakest.id);

            await logReview({ id: weakest.id, symbol: weakest.symbol }, 'replaced',
              `Replaced by ${inst.symbol} (score ${score} vs ${weakest.current_score}) — ${targetCat} at cap ${cap}`,
              weakest.current_score, null, inst.symbol);

            // Promote the candidate
            await supabaseAdmin.from('instrument_universe').update({
              status: 'active', is_watchlist: false, category: targetCat,
            }).eq('id', inst.id);

            await logReview(inst, 'promoted',
              `Promoted into full category by outscoring ${weakest.symbol} (${score} vs ${weakest.current_score})`,
              score, null, weakest.symbol);

            console.log(`   🔄 REPLACED: ${weakest.symbol} (${weakest.current_score}) → ${inst.symbol} (${score}) in ${targetCat}`);
            replaced++;
          } else {
            console.log(`   ⏸ ${inst.symbol} qualified but ${targetCat} is full and it does not outscore the weakest member`);
          }
        }
      } catch (e) {
        console.warn(`   ⚠ Promotion failed for ${inst.symbol}: ${e.message}`);
        failed++;
      }
    }

    // ── PASS 5: Report final universe state ───────────────────────────
    const { data: final } = await supabaseAdmin
      .from('instrument_universe')
      .select('status, category')
      .in('status', ['active', 'watchlist']);

    const activeCount    = (final || []).filter(i => i.status === 'active').length;
    const watchlistCount = (final || []).filter(i => i.status === 'watchlist').length;

    const duration = Date.now() - start;
    console.log(`\n🔍 Instrument review complete (${Math.round(duration / 1000)}s)`);
    console.log(`   Retained: ${retained} | Demoted: ${demoted} | Promoted: ${promoted} | Replaced: ${replaced} | Failed: ${failed}`);
    console.log(`   Universe now: ${activeCount} active / ${watchlistCount} watchlist`);

    if (activeCount !== 100) {
      console.log(`   ⚠ Active count is ${activeCount}, target is 100 — watchlist promotions will rebalance next cycle`);
    }

    await reportRun({
      engineName:     'instrumentReviewEngine',
      durationMs:     duration,
      itemsProcessed: retained + demoted + promoted + replaced,
      itemsExpected:  all.length,
      itemsFailed:    failed,
      detail:         `Universe: ${activeCount} active / ${watchlistCount} watchlist. ` +
                      `${demoted} demoted, ${promoted} promoted, ${replaced} replaced.`,
    });

  } catch (e) {
    console.error('🔍 Instrument review error:', e.message);
    await reportRun({
      engineName: 'instrumentReviewEngine', durationMs: Date.now() - start,
      itemsProcessed: 0, itemsExpected: 120, itemsFailed: 1, detail: e.message,
    });
  }
}

module.exports = { runInstrumentReview, CATEGORY_CAPS };
