/**
 * WealthGuard Opportunity Engine
 *
 * Runs Mon–Fri at 10:00 PM IST, after the day's data has settled.
 *
 * Surfaces opportunities the weekly scoring run would not catch, because
 * they emerge between scoring cycles:
 *
 *   1. Technical breakout  — price crossed a meaningful level today
 *   2. Dual agreement      — 9-lever engine and AI lever both strongly aligned
 *   3. Sector rotation     — a whole category's average score improved sharply
 *
 * Output goes to the `opportunities` table, gated to Builder and Wealth
 * Builder tiers. This is what justifies the Builder tier premium over Starter.
 *
 * Fully automated. No AI call required for types 1 and 3 (pure computation).
 * Type 2 uses existing AI lever output — no new AI calls.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { reportRun }     = require('./healthEngine');

const BREAKOUT_THRESHOLD_PCT   = 4.0;  // single-day move that counts as a breakout
const SECTOR_ROTATION_MIN_PP   = 4.0;  // category avg score improvement to flag
const DUAL_AGREEMENT_MIN_SCORE = 68;   // 9-lever score required for dual agreement
const OPPORTUNITY_TTL_DAYS     = 3;    // how long an opportunity stays live

function expiryISO(days = OPPORTUNITY_TTL_DAYS) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────
// TYPE 1 — TECHNICAL BREAKOUT
// ─────────────────────────────────────────────────────────────────────

async function findBreakouts() {
  if (!supabaseAdmin) return [];
  const found = [];

  try {
    // Compare today's latest price snapshot against ~24h ago for each instrument
    const since = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    const { data: prices } = await supabaseAdmin
      .from('instrument_price_hourly')
      .select('instrument_id, symbol, price, recorded_at')
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true });

    if (!prices?.length) return [];

    // Group by symbol, take first and last of the window
    const bySymbol = {};
    prices.forEach(p => {
      if (!bySymbol[p.symbol]) bySymbol[p.symbol] = { first: p, last: p, id: p.instrument_id };
      else bySymbol[p.symbol].last = p;
    });

    // Fetch instrument metadata and current signals in bulk
    const symbols = Object.keys(bySymbol);
    if (!symbols.length) return [];

    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('id, symbol, name, category')
      .in('symbol', symbols)
      .eq('status', 'active');

    const { data: signals } = await supabaseAdmin
      .from('recommendations')
      .select('instrument_name, action')
      .in('instrument_name', symbols)
      .is('client_id', null)
      .eq('is_active', true);

    const sigMap = {};
    (signals || []).forEach(s => { sigMap[s.instrument_name] = s.action; });

    for (const inst of (instruments || [])) {
      const pair = bySymbol[inst.symbol];
      if (!pair || pair.first.price === pair.last.price) continue;

      const movePct = ((pair.last.price - pair.first.price) / pair.first.price) * 100;
      if (Math.abs(movePct) < BREAKOUT_THRESHOLD_PCT) continue;

      const dir = movePct > 0 ? 'upward' : 'downward';
      const currentSignal = sigMap[inst.symbol] || 'WATCH';

      found.push({
        instrument_id:    inst.id,
        symbol:           inst.symbol,
        instrument_name:  inst.name,
        opportunity_type: 'technical_breakout',
        headline:         `${inst.name} moved ${movePct > 0 ? '+' : ''}${movePct.toFixed(1)}% in a single session`,
        detail:           `A ${dir} move of this size in one session is unusual for a ${inst.category.replace(/_/g, ' ')} instrument. ` +
                          `Our current signal is ${currentSignal}. A move of this magnitude between weekly scoring cycles ` +
                          `may indicate new information entering the market that our next scoring run will pick up.`,
        conviction:       Math.abs(movePct) >= BREAKOUT_THRESHOLD_PCT * 1.5 ? 'high' : 'medium',
        current_signal:   currentSignal,
      });
    }
  } catch (e) {
    console.warn(`   ⚠ Breakout scan failed: ${e.message}`);
  }

  return found;
}

// ─────────────────────────────────────────────────────────────────────
// TYPE 2 — DUAL AGREEMENT (9-lever + AI lever aligned)
// ─────────────────────────────────────────────────────────────────────

async function findDualAgreement() {
  if (!supabaseAdmin) return [];
  const found = [];

  try {
    // Instruments with a high 9-lever score AND an active AI flag
    const { data: flags } = await supabaseAdmin
      .from('ai_instrument_flags')
      .select('instrument_id, risk_level, opportunity_level, ai_lever_score, horizon_label, net_opportunity_pct')
      .eq('is_active', true);

    if (!flags?.length) return [];

    const ids = flags.map(f => f.instrument_id).filter(Boolean);
    if (!ids.length) return [];

    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('id, symbol, name, category, current_score')
      .in('id', ids)
      .eq('status', 'active');

    const { data: signals } = await supabaseAdmin
      .from('recommendations')
      .select('instrument_name, action')
      .is('client_id', null)
      .eq('is_active', true);

    const sigMap = {};
    (signals || []).forEach(s => { sigMap[s.instrument_name] = s.action; });

    for (const flag of flags) {
      const inst = (instruments || []).find(i => i.id === flag.instrument_id);
      if (!inst || inst.current_score == null) continue;

      const strongNineLever  = inst.current_score >= DUAL_AGREEMENT_MIN_SCORE;
      const strongAIPositive = flag.opportunity_level === 'HIGH' && (flag.ai_lever_score ?? 5) >= 7;
      const strongAINegative = flag.risk_level === 'HIGH' || flag.risk_level === 'CRITICAL';

      // Positive dual agreement: both engines bullish
      if (strongNineLever && strongAIPositive) {
        found.push({
          instrument_id:    inst.id,
          symbol:           inst.symbol,
          instrument_name:  inst.name,
          opportunity_type: 'dual_agreement',
          headline:         `${inst.name}: both our engines are aligned positively`,
          detail:           `Our structural 9-lever analysis scores this ${inst.current_score}/100, and our AI event analysis ` +
                            `independently identifies a positive positioning over a ${flag.horizon_label || 'medium'} horizon. ` +
                            `When two independent methods agree, conviction is higher than either alone.`,
          conviction:       'high',
          current_signal:   sigMap[inst.symbol] || 'WATCH',
        });
      }

      // Negative dual agreement: strong score but AI sees material risk — worth flagging
      if (strongNineLever && strongAINegative) {
        found.push({
          instrument_id:    inst.id,
          symbol:           inst.symbol,
          instrument_name:  inst.name,
          opportunity_type: 'dual_agreement',
          headline:         `${inst.name}: strong fundamentals, but our AI flags near-term risk`,
          detail:           `Structurally this scores ${inst.current_score}/100 — genuinely strong. However our AI event analysis ` +
                            `has identified a ${flag.risk_level} risk over a ${flag.horizon_label || 'medium'} horizon. ` +
                            `This is a case where the long-term case and the short-term picture differ. Position sizing matters here.`,
          conviction:       'medium',
          current_signal:   sigMap[inst.symbol] || 'WATCH',
        });
      }
    }
  } catch (e) {
    console.warn(`   ⚠ Dual agreement scan failed: ${e.message}`);
  }

  return found;
}

// ─────────────────────────────────────────────────────────────────────
// TYPE 3 — SECTOR ROTATION
// ─────────────────────────────────────────────────────────────────────

async function findSectorRotation() {
  if (!supabaseAdmin) return [];
  const found = [];

  try {
    // Compare the last two scoring rounds' average composite per category
    const { data: scores } = await supabaseAdmin
      .from('instrument_scores')
      .select('composite_score, category_at_scoring, scored_at')
      .gte('scored_at', new Date(Date.now() - 21 * 86400000).toISOString())
      .order('scored_at', { ascending: false });

    if (!scores?.length) return [];

    // Bucket by category and by scoring date (day granularity)
    const byCat = {};
    scores.forEach(s => {
      const cat = s.category_at_scoring;
      const day = s.scored_at.split('T')[0];
      if (!cat || s.composite_score == null) return;
      byCat[cat] = byCat[cat] || {};
      byCat[cat][day] = byCat[cat][day] || [];
      byCat[cat][day].push(s.composite_score);
    });

    for (const [cat, days] of Object.entries(byCat)) {
      const sortedDays = Object.keys(days).sort().reverse();
      if (sortedDays.length < 2) continue;

      const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
      const latest   = avg(days[sortedDays[0]]);
      const previous = avg(days[sortedDays[1]]);
      const deltaPP  = latest - previous;

      if (Math.abs(deltaPP) < SECTOR_ROTATION_MIN_PP) continue;

      const dir = deltaPP > 0 ? 'strengthening' : 'weakening';
      const label = cat.replace(/_/g, ' ');

      found.push({
        instrument_id:    null,
        symbol:           cat.toUpperCase(),
        instrument_name:  label.replace(/\b\w/g, c => c.toUpperCase()),
        opportunity_type: 'sector_rotation',
        headline:         `${label.replace(/\b\w/g, c => c.toUpperCase())} is ${dir} as a category`,
        detail:           `The average 9-lever score across all ${label} instruments moved from ${previous.toFixed(0)} to ` +
                          `${latest.toFixed(0)} (${deltaPP > 0 ? '+' : ''}${deltaPP.toFixed(1)} points) between our last two scoring runs. ` +
                          `Category-wide moves like this usually reflect a macro or sector-level shift rather than company-specific news.`,
        conviction:       Math.abs(deltaPP) >= SECTOR_ROTATION_MIN_PP * 1.5 ? 'high' : 'medium',
        current_signal:   null,
      });
    }
  } catch (e) {
    console.warn(`   ⚠ Sector rotation scan failed: ${e.message}`);
  }

  return found;
}

// ─────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────

async function runOpportunityEngine() {
  if (!supabaseAdmin) {
    console.log('💡 Opportunity engine: Supabase not configured, skipping.');
    return;
  }

  const start = Date.now();
  console.log('💡 Running opportunity engine...');

  let stored = 0, failed = 0;

  try {
    // Expire old opportunities first
    await supabaseAdmin
      .from('opportunities')
      .update({ is_active: false })
      .eq('is_active', true)
      .lt('expires_at', new Date().toISOString());

    const [breakouts, dualAgreements, rotations] = await Promise.all([
      findBreakouts(),
      findDualAgreement(),
      findSectorRotation(),
    ]);

    const all = [...breakouts, ...dualAgreements, ...rotations];
    console.log(`   Found: ${breakouts.length} breakouts, ${dualAgreements.length} dual agreements, ${rotations.length} rotations`);

    // Cap at 8 per day, prioritising high conviction — avoids noise
    all.sort((a, b) => (a.conviction === 'high' ? -1 : 1) - (b.conviction === 'high' ? -1 : 1));
    const selected = all.slice(0, 8);

    for (const opp of selected) {
      try {
        const { error } = await supabaseAdmin.from('opportunities').insert({
          ...opp,
          min_tier:     'builder',
          generated_at: new Date().toISOString(),
          expires_at:   expiryISO(),
          is_active:    true,
        });
        if (error) { failed++; console.warn(`   ⚠ ${opp.symbol}: ${error.message}`); }
        else { stored++; console.log(`   💡 ${opp.opportunity_type}: ${opp.headline}`); }
      } catch (e) {
        failed++;
      }
    }

    const duration = Date.now() - start;
    console.log(`💡 Opportunity engine complete: ${stored} stored, ${failed} failed.`);

    await reportRun({
      engineName:     'opportunityEngine',
      durationMs:     duration,
      itemsProcessed: stored,
      itemsExpected:  null,   // zero opportunities is a valid outcome on a quiet day
      itemsFailed:    failed,
      detail:         `${breakouts.length} breakouts, ${dualAgreements.length} dual, ${rotations.length} rotation`,
    });

  } catch (e) {
    console.error('💡 Opportunity engine error:', e.message);
    await reportRun({
      engineName: 'opportunityEngine', durationMs: Date.now() - start,
      itemsProcessed: stored, itemsFailed: failed + 1, detail: e.message,
    });
  }
}

module.exports = { runOpportunityEngine };
