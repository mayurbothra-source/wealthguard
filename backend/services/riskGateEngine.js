/**
 * WealthGuard Risk Gate Engine
 *
 * Runs AFTER 9-lever scoring and BEFORE a signal is published.
 * Can veto any signal regardless of how strong the composite score is.
 *
 * This is the difference between "we analyse instruments" and
 * "we protect client capital." Capital preservation first.
 *
 * Five gates, each independently able to veto:
 *   1. VIX gate          — no new BUYs on volatile instruments in a fearful market
 *   2. Concentration gate— prevents herding into one category in a single run
 *   3. Score gate        — the 48–52 dead zone never produces a directional call
 *   4. Price source gate — unverified prices get a caution flag, not a clean signal
 *   5. Momentum gate     — prevents premature reversal after sustained SELL
 *
 * Every veto is logged to risk_gate_log for full auditability.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');

// ─── Thresholds (frozen) ─────────────────────────────────────────────
const VIX_ELEVATED          = 20;   // above this, market is fearful
const VIX_CRISIS            = 28;   // above this, freeze all new BUYs
const SCORE_DEAD_ZONE_LOW   = 48;
const SCORE_DEAD_ZONE_HIGH  = 52;
const CONCENTRATION_CAP_PCT = 40;   // max % of BUYs in one category per run
const REVERSAL_SCORE_FLOOR  = 65;   // score needed to flip from sustained SELL to BUY

// Categories considered volatile — subject to the VIX gate
const VOLATILE_CATEGORIES = ['small_cap_equity', 'mid_cap_equity', 'flexi_mid_fund'];

/**
 * Per-run state. Reset at the start of every scoring run so concentration
 * counting is scoped to a single run, not cumulative across runs.
 */
function createGateSession() {
  return {
    buysByCategory: {},
    totalBuys:      0,
    vetoCount:      0,
    cautionCount:   0,
  };
}

/**
 * Fetches how many consecutive weeks an instrument has been on SELL.
 * Used by the momentum gate.
 */
async function getConsecutiveSellWeeks(symbol) {
  if (!supabaseAdmin) return 0;
  try {
    const { data } = await supabaseAdmin
      .from('recommendations')
      .select('action, generated_at')
      .eq('instrument_name', symbol)
      .is('client_id', null)
      .order('generated_at', { ascending: false })
      .limit(4);

    if (!data?.length) return 0;
    let count = 0;
    for (const rec of data) {
      if (rec.action === 'SELL') count++;
      else break;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Logs a gate decision (veto or caution) for audit.
 */
async function logGateDecision(instrument, proposedAction, vetoed, gateFailed, detail, composite, vix) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('risk_gate_log').insert({
      instrument_id:   instrument.id,
      symbol:          instrument.symbol,
      proposed_action: proposedAction,
      vetoed,
      gate_failed:     gateFailed,
      gate_detail:     detail,
      composite_score: composite,
      vix_at_check:    vix,
      checked_at:      new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`   ⚠ Risk gate log failed for ${instrument.symbol}: ${e.message}`);
  }
}

/**
 * Runs all five gates against a proposed signal.
 *
 * @returns {Promise<{
 *   action: string,          // possibly downgraded from the proposal
 *   vetoed: boolean,
 *   caution: boolean,
 *   reason: string|null
 * }>}
 */
async function runRiskGate(instrument, proposedAction, composite, context, session) {
  const { vix, priceSource } = context;
  const cat = instrument.category;

  // ─── GATE 3: Score dead zone ──────────────────────────────────────
  // A composite between 48 and 52 is genuinely ambiguous. Publishing a
  // directional call on a coin-flip score would be dishonest.
  if (composite >= SCORE_DEAD_ZONE_LOW && composite <= SCORE_DEAD_ZONE_HIGH
      && proposedAction !== 'WATCH') {
    await logGateDecision(instrument, proposedAction, true, 'score',
      `Composite ${composite} is in the ${SCORE_DEAD_ZONE_LOW}-${SCORE_DEAD_ZONE_HIGH} dead zone`,
      composite, vix);
    session.vetoCount++;
    return {
      action:  'WATCH',
      vetoed:  true,
      caution: false,
      reason:  `Score too close to neutral (${composite}/100) for a directional call`,
    };
  }

  // ─── GATE 1: VIX gate ─────────────────────────────────────────────
  if (proposedAction === 'BUY' && vix != null) {
    if (vix >= VIX_CRISIS) {
      await logGateDecision(instrument, proposedAction, true, 'vix',
        `India VIX at ${vix} — crisis level, all new BUYs frozen`, composite, vix);
      session.vetoCount++;
      return {
        action:  'WATCH',
        vetoed:  true,
        caution: false,
        reason:  `Market volatility is elevated (VIX ${vix}). We are not issuing new buy calls until conditions stabilise.`,
      };
    }
    if (vix >= VIX_ELEVATED && VOLATILE_CATEGORIES.includes(cat)) {
      await logGateDecision(instrument, proposedAction, true, 'vix',
        `India VIX at ${vix} with volatile category ${cat}`, composite, vix);
      session.vetoCount++;
      return {
        action:  'WATCH',
        vetoed:  true,
        caution: false,
        reason:  `Market volatility is elevated (VIX ${vix}). Higher-risk instruments are held at WATCH until conditions settle.`,
      };
    }
  }

  // ─── GATE 5: Momentum gate ────────────────────────────────────────
  if (proposedAction === 'BUY') {
    const sellWeeks = await getConsecutiveSellWeeks(instrument.symbol);
    if (sellWeeks >= 3 && composite < REVERSAL_SCORE_FLOOR) {
      await logGateDecision(instrument, proposedAction, true, 'momentum',
        `${sellWeeks} consecutive SELL weeks; score ${composite} below reversal floor ${REVERSAL_SCORE_FLOOR}`,
        composite, vix);
      session.vetoCount++;
      return {
        action:  'WATCH',
        vetoed:  true,
        caution: false,
        reason:  `This instrument has been on SELL for ${sellWeeks} weeks. We require stronger evidence (score ${REVERSAL_SCORE_FLOOR}+) before reversing to BUY.`,
      };
    }
  }

  // ─── GATE 2: Concentration gate ───────────────────────────────────
  if (proposedAction === 'BUY') {
    const catBuys   = session.buysByCategory[cat] || 0;
    const projected = session.totalBuys + 1;
    const projectedPct = projected > 0 ? ((catBuys + 1) / projected) * 100 : 0;

    // Only enforce once we have a meaningful sample (5+ BUYs this run)
    if (projected >= 5 && projectedPct > CONCENTRATION_CAP_PCT) {
      await logGateDecision(instrument, proposedAction, true, 'concentration',
        `${cat} would be ${projectedPct.toFixed(0)}% of BUYs this run (cap ${CONCENTRATION_CAP_PCT}%)`,
        composite, vix);
      session.vetoCount++;
      return {
        action:  'WATCH',
        vetoed:  true,
        caution: false,
        reason:  `We already have significant buy exposure in this category this week. Held at WATCH to avoid concentration risk.`,
      };
    }
  }

  // ─── GATE 4: Price source gate ────────────────────────────────────
  // Not a veto — a caution flag. The signal stands but is marked.
  let caution = false;
  let cautionReason = null;
  if (priceSource === 'static_reference' || priceSource === 'no_price') {
    caution = true;
    cautionReason = priceSource === 'no_price'
      ? 'Live price unavailable for this instrument — signal is based on fundamentals only.'
      : 'This instrument has no live market price. Signal reflects structural analysis, not price action.';
    await logGateDecision(instrument, proposedAction, false, 'price_source',
      `Price source: ${priceSource}`, composite, vix);
    session.cautionCount++;
  }

  // ─── PASSED — record BUY for concentration tracking ───────────────
  if (proposedAction === 'BUY') {
    session.buysByCategory[cat] = (session.buysByCategory[cat] || 0) + 1;
    session.totalBuys++;
  }

  return {
    action:  proposedAction,
    vetoed:  false,
    caution,
    reason:  cautionReason,
  };
}

module.exports = {
  runRiskGate,
  createGateSession,
  VIX_ELEVATED,
  VIX_CRISIS,
};
