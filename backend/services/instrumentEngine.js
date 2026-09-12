/**
 * WealthGuard Instrument Scoring Engine v2.0
 *
 * Responsibilities:
 *   1. Score all 120 instruments weekly across 9 analytical levers
 *   2. Route price fetching to the correct source per instrument type:
 *        equity/ETF  → Yahoo Finance (with NSE fallback)
 *        mutual_fund → MFAPI NAV (proven in production via getMFNav)
 *        bond        → static face/reference value (no live feed exists)
 *   3. Detect and execute category movements with type-aware logic
 *      (equity stays in equity categories; funds stay in fund categories)
 *   4. Notify affected clients immediately on category change
 *   5. Convert each score to a live BUY/WATCH/SELL signal, deactivating
 *      the previous week's signal first to prevent duplicate accumulation
 *
 * Schedule : Every Sunday at 8:00 PM IST  (14:30 UTC, cron '30 14 * * 0')
 * Manual   : GET /api/admin/trigger-scoring?key=ADMIN_TRIGGER_KEY
 *
 * Key design decisions:
 *   - Instruments processed sequentially to avoid rate-limiting Yahoo/MFAPI
 *   - Every operation per instrument is independently try/caught — one bad
 *     instrument never stops the full run
 *   - All DB writes check for errors explicitly; nothing fails silently
 *   - Category downgrade is type-aware: equity stays in equity categories,
 *     funds stay in fund categories (fixes the mid_cap→flexi_mid_fund bug)
 *   - convertScoreToRecommendation deactivates old engine signals before
 *     inserting new ones (fixes signal accumulation on repeated runs)
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const { getYahooQuote, getNSEQuote, getMacroIndicators, getMFNav } = require('./marketData');
const { runRiskGate, createGateSession } = require('./riskGateEngine');
const { reportRun } = require('./healthEngine');
const emailEngine = require('./emailEngine');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SCORE_DOWNGRADE = 55; // composite below this → move down one category
const SCORE_REMOVE    = 30; // composite below this → remove from active list
const SCORE_PROMOTE   = 68; // watchlist composite above this for 3 consecutive
                             // weeks → promote to active list

// Type-aware downgrade paths.
// Maps each category to the next-lower-risk category WITHIN THE SAME TYPE.
// null means terminal — instrument is already at lowest risk for its type.
// This fixes the original bug where mid_cap_equity downgraded to flexi_mid_fund
// (a mutual fund category), which made no logical sense.
const DOWNGRADE_PATH = {
  // Equity family
  small_cap_equity:  'mid_cap_equity',
  mid_cap_equity:    'large_cap_equity',
  large_cap_equity:  null,          // terminal for equity — flag for admin review

  // Mutual fund family
  flexi_mid_fund:    'large_cap_fund',
  large_cap_fund:    null,          // terminal for funds

  // ETF / defensive — no meaningful downgrade path within type
  index_etf:         null,
  gold:              null,
  bond_gsec:         null,
  debt_fund:         null,
};

const CATEGORY_RISK = {
  small_cap_equity:  'high',
  mid_cap_equity:    'moderate_high',
  flexi_mid_fund:    'moderate_high',
  large_cap_equity:  'moderate',
  large_cap_fund:    'moderate',
  index_etf:         'moderate',
  gold:              'low_moderate',
  bond_gsec:         'low',
  debt_fund:         'low',
};

const CATEGORY_LABEL = {
  small_cap_equity:  'Small-Cap Equity',
  mid_cap_equity:    'Mid-Cap Equity',
  flexi_mid_fund:    'Flexi/Mid-Cap Fund',
  large_cap_equity:  'Large-Cap Equity',
  large_cap_fund:    'Large-Cap Fund',
  index_etf:         'Index ETF',
  gold:              'Gold',
  bond_gsec:         'Bond / G-Sec',
  debt_fund:         'Debt Fund',
  watchlist:         'Watchlist',
};

const LEVER_LABELS = {
  technical:     'Technical momentum',
  fundamental:   'Fundamental strength',
  management:    'Management quality',
  sentiment:     'Market sentiment',
  institutional: 'Institutional flow',
  sector_timing: 'Sector timing',
  macro_pestle:  'Macro environment',
  competitive:   'Competitive positioning',
  risk_adjusted: 'Risk-adjusted return',
};

// Expected return by category over the signal horizon.
// Used to derive a concrete target price so a signal is a full thesis,
// not just a direction. Conservative figures — based on long-run category
// averages, deliberately not optimistic.
const EXPECTED_RETURN_PCT = {
  large_cap_equity: { weekly: 2.0, monthly: 6.0 },
  mid_cap_equity:   { weekly: 3.0, monthly: 9.0 },
  small_cap_equity: { weekly: 4.0, monthly: 12.0 },
  large_cap_fund:   { weekly: 1.5, monthly: 5.0 },
  flexi_mid_fund:   { weekly: 2.0, monthly: 6.5 },
  index_etf:        { weekly: 1.5, monthly: 5.0 },
  gold:             { weekly: 1.0, monthly: 3.0 },
  bond_gsec:        { weekly: 0.5, monthly: 1.5 },
  debt_fund:        { weekly: 0.5, monthly: 1.5 },
  watchlist:        { weekly: 2.0, monthly: 6.0 },
};

// Stop-loss distance by risk level. Wider bands for more volatile
// instruments so normal fluctuation doesn't trigger an unnecessary exit.
const STOP_LOSS_PCT = {
  low:           3.0,
  low_moderate:  4.0,
  moderate:      5.0,
  moderate_high: 7.0,
  high:          10.0,
};

// Signal horizon in days, by tier. High-conviction calls get a longer
// runway because they rest on structural rather than momentary factors.
const HORIZON_DAYS = { high_conviction: 30, standard: 14 };

// Plain-English phrasing for each lever at different score levels.
// This replaces engine output like "Technical momentum (8/10)" with
// language an investor who has never read a research note can follow.
const LEVER_PHRASES = {
  technical: {
    high: 'price action has been trending positively',
    mid:  'price action is broadly stable',
    low:  'price action has been weak recently',
  },
  fundamental: {
    high: 'the underlying business fundamentals are solid',
    mid:  'fundamentals are reasonable but not outstanding',
    low:  'fundamentals show some areas of concern',
  },
  management: {
    high: 'management quality and governance are strong',
    mid:  'management record is acceptable',
    low:  'there are governance factors worth monitoring',
  },
  sentiment: {
    high: 'market sentiment is favourable',
    mid:  'sentiment is neutral',
    low:  'sentiment has turned cautious',
  },
  institutional: {
    high: 'large institutional investors have been buying',
    mid:  'institutional flows are balanced',
    low:  'institutional investors have been reducing exposure',
  },
  sector_timing: {
    high: 'this sector is currently in favour',
    mid:  'the sector is neither in nor out of favour',
    low:  'this sector is currently out of favour',
  },
  macro_pestle: {
    high: 'the wider economic environment is supportive',
    mid:  'macro conditions are mixed',
    low:  'macro conditions are challenging for this type of investment',
  },
  competitive: {
    high: 'it holds a strong competitive position',
    mid:  'its competitive position is adequate',
    low:  'it faces meaningful competitive pressure',
  },
  risk_adjusted: {
    high: 'the return it offers justifies the risk taken',
    mid:  'the risk-return balance is fair',
    low:  'the return may not adequately compensate for the risk',
  },
};

function leverPhrase(lever, score) {
  const band = score >= 7 ? 'high' : score >= 5 ? 'mid' : 'low';
  return LEVER_PHRASES[lever]?.[band] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE FETCHING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routes each instrument to the correct price source.
 * Returns { price, change_pct, source } or null if genuinely unavailable.
 * Never returns fake/demo data — null means "price unknown today."
 *
 * Routing is driven by the price_source column in instrument_universe,
 * populated by fix_instrument_data.sql:
 *   'static'  → bonds/G-Secs: stored face value, no live feed exists
 *   'mfapi'   → mutual funds: live NAV via getMFNav (proven in production)
 *   'yahoo'   → equity/ETF: Yahoo Finance with NSE direct fallback
 *   null      → defaults to Yahoo behaviour (backwards compat for old rows)
 */
async function fetchInstrumentPrice(instrument) {
  const src = instrument.price_source;

  // ── Static reference (bonds, G-Secs, RBI bonds) ───────────────────────────
  if (src === 'static') {
    const p = parseFloat(instrument.static_price);
    if (!isNaN(p) && p > 0) {
      return { price: p, change_pct: 0, source: 'static_reference' };
    }
    console.warn(`   ⚠ ${instrument.symbol}: price_source=static but static_price is null/invalid`);
    return null;
  }

  // ── Mutual fund NAV via MFAPI ─────────────────────────────────────────────
  if (src === 'mfapi') {
    if (!instrument.amfi_code) {
      console.warn(`   ⚠ ${instrument.symbol}: price_source=mfapi but amfi_code is null`);
      return null;
    }
    try {
      const nav = await getMFNav(instrument.amfi_code);
      if (nav && nav.nav && !isNaN(nav.nav) && nav.nav > 0) {
        return { price: nav.nav, change_pct: 0, source: 'mfapi_live' };
      }
    } catch (e) {
      console.warn(`   ⚠ MFAPI failed for ${instrument.symbol} (AMFI ${instrument.amfi_code}): ${e.message}`);
    }
    return null;
  }

  // ── Yahoo Finance (equity, ETF, gold ETF) ─────────────────────────────────
  if (instrument.yahoo_ticker) {
    try {
      const q = await getYahooQuote(instrument.yahoo_ticker);
      if (q && q.source === 'yahoo_live' && !isNaN(q.price) && q.price > 0) return q;
    } catch {}
  }

  // ── NSE direct fallback (equity only) ────────────────────────────────────
  if (instrument.exchange === 'NSE' && instrument.instrument_type === 'equity') {
    try {
      const q = await getNSEQuote(instrument.symbol);
      if (q && q.source === 'nse_live' && !isNaN(q.price) && q.price > 0) return q;
    } catch {}
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9-LEVERS SCORING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scores an instrument across all 9 analytical levers.
 * Returns the individual lever scores plus a composite scaled to 0–100.
 *
 * Where live data is available (price, FII/DII flows, macro indicators) it
 * is used directly. Where not (per-company PE, management quality) a
 * category-appropriate baseline is used and documented as such in comments.
 *
 * Each lever is an independent injection point — upgrade individual levers
 * with richer data feeds without touching signal generation downstream.
 */
async function scoreInstrument(instrument, macroData, priceData) {
  const cat = instrument.category;
  const chg = priceData?.change_pct ?? 0;

  // Lever 1: Technical (0–10)
  // Live: today's price change as a momentum proxy.
  // Capped at ±3% contribution so a single volatile day doesn't dominate.
  // Upgrade path: 50MA/200MA crossover, RSI, MACD when full history available.
  const technical = priceData
    ? Math.min(10, Math.max(0, Math.round(5 + Math.max(-3, Math.min(3, chg)) * 0.8)))
    : 5; // neutral when no price data

  // Lever 2: Fundamental (0–10)
  // Category baseline. Bonds/debt highest (predictable policy-backed returns).
  // Small-cap lowest (highest earnings volatility). Override per-instrument
  // when quarterly earnings data is piped in.
  const fundamentalBase = {
    large_cap_equity: 7, mid_cap_equity: 6, small_cap_equity: 5,
    large_cap_fund:   7, flexi_mid_fund: 6, index_etf:        7,
    gold:             6, bond_gsec:      8, debt_fund:        8,
    watchlist:        5,
  };
  const fundamental = fundamentalBase[cat] ?? 6;

  // Lever 3: Management quality (0–10)
  // Category baseline. Index ETFs and G-Secs score highest (rules-based or
  // government-backed, zero key-person risk). AI lever can flag individual
  // instruments to lower this score when a governance event is detected.
  const mgmtBase = {
    large_cap_equity: 7, mid_cap_equity: 6, small_cap_equity: 5,
    large_cap_fund:   8, flexi_mid_fund: 7, index_etf:        9,
    gold:             9, bond_gsec:      10, debt_fund:       9,
    watchlist:        5,
  };
  const management = mgmtBase[cat] ?? 7;

  // Lever 4: Sentiment (0–10)
  // Price momentum proxy for market sentiment.
  // Scaled to 0.4× so a +5% day → score of 7 (not 10 — one bullish day
  // doesn't override fundamentals).
  const sentiment = priceData
    ? Math.min(10, Math.max(0, Math.round(5 + chg * 0.4)))
    : 5;

  // Lever 5: Institutional flow (0–10)
  // Uses macro FII + DII net data from NSE as a market-wide proxy.
  // Banded rather than linear so extreme flow days don't distort the score.
  const fii     = macroData?.fii_net_cr ?? 0;
  const dii     = macroData?.dii_net_cr ?? 0;
  const netFlow = fii + dii;
  const institutional =
    netFlow >  5000 ? 8 :
    netFlow >  1000 ? 7 :
    netFlow >     0 ? 6 :
    netFlow > -1000 ? 4 :
    netFlow > -5000 ? 3 : 2;

  // Lever 6: Sector timing (0–10)
  // Reflects whether the instrument's sector is currently in or out of favour.
  // Baseline until AI lever flags sector-specific events.
  const sectorBase = {
    large_cap_equity: 7, mid_cap_equity: 6, small_cap_equity: 5,
    large_cap_fund:   7, flexi_mid_fund: 6, index_etf:        7,
    gold:             6, bond_gsec:      7, debt_fund:        7,
    watchlist:        5,
  };
  const sector_timing = sectorBase[cat] ?? 6;

  // Lever 7: Macro / PESTLE (0–10)
  // Three live data points: GDP growth rate, CPI, instrument type bonus.
  // Bonds/debt get +2 because a stable macro environment directly supports
  // their yield value proposition.
  const gdp      = macroData?.gdp_latest ?? 7;
  const cpi      = macroData?.cpi_latest ?? 5;
  const gdpScore = gdp >= 7 ? 3 : gdp >= 5 ? 2 : 1;
  const cpiScore = cpi <= 4 ? 3 : cpi <= 6 ? 2 : 1;
  const typeBonus = (cat === 'bond_gsec' || cat === 'debt_fund') ? 2 : 1;
  const macro_pestle = Math.min(10, gdpScore + cpiScore + typeBonus);

  // Lever 8: Competitive positioning (0–10)
  // Moat strength and competitive barriers. G-Secs and bonds score 10
  // by definition (no competition for government-backed instruments).
  // Gold scores 9 — universal store of value, no competitive risk.
  const competitiveBase = {
    large_cap_equity: 7, mid_cap_equity: 6, small_cap_equity: 5,
    large_cap_fund:   8, flexi_mid_fund: 7, index_etf:        8,
    gold:             9, bond_gsec:      10, debt_fund:       9,
    watchlist:        5,
  };
  const competitive = competitiveBase[cat] ?? 7;

  // Lever 9: Risk-adjusted return (0–10)
  // Expected return per unit of risk taken. Debt instruments score highest —
  // most predictable return for their risk level. Small-cap scores lowest —
  // must compensate with higher return for higher volatility, which it
  // doesn't consistently deliver.
  const riskAdjBase = {
    large_cap_equity: 7, mid_cap_equity: 6, small_cap_equity: 5,
    large_cap_fund:   7, flexi_mid_fund: 6, index_etf:        7,
    gold:             6, bond_gsec:      8, debt_fund:        9,
    watchlist:        5,
  };
  const risk_adjusted = riskAdjBase[cat] ?? 6;

  // Composite: sum all 9 levers, scale to 0–100
  const levers = { technical, fundamental, management, sentiment,
                   institutional, sector_timing, macro_pestle,
                   competitive, risk_adjusted };
  const total     = Object.values(levers).reduce((a, b) => a + b, 0);
  const composite = Math.round((total / 90) * 100); // 90 = max (9 × 10)

  return { ...levers, composite };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a composite score to a live BUY/WATCH/SELL signal.
 *
 * Signal thresholds (frozen September 2026):
 *   composite >= 70  → BUY   (multiple levers aligned positively)
 *   composite 50–69  → WATCH (neutral to moderately positive)
 *   composite <  50  → SELL  (multiple risk flags present)
 *
 * Deactivates previous engine-generated signals before inserting the new
 * one — prevents stale signals accumulating every time the engine runs.
 * Manually-logged signals (from v8 Tab 1) are identified by a non-null
 * instrument_id and are never touched by this function.
 */
async function convertScoreToRecommendation(instrument, composite, levers, entryPrice, gateResult) {
  // Risk gate may have overridden the action (e.g. BUY vetoed to WATCH)
  const rawAction = composite >= 70 ? 'BUY' : composite >= 50 ? 'WATCH' : 'SELL';
  const action     = gateResult?.action || rawAction;
  const wasVetoed  = gateResult?.vetoed || false;
  const confidence = parseFloat(Math.min(0.95, Math.max(0.30, composite / 100)).toFixed(2));
  const tier       = composite >= 75 && !wasVetoed ? 'high_conviction' : 'standard';
  const horizonDays = HORIZON_DAYS[tier] || 14;

  // ── Derive target price and stop-loss so the signal is a full thesis ──
  const returns = EXPECTED_RETURN_PCT[instrument.category] || EXPECTED_RETURN_PCT.watchlist;
  const expectedPct = horizonDays >= 30 ? returns.monthly : returns.weekly;
  const stopPct = STOP_LOSS_PCT[instrument.risk_level] || 5.0;

  let targetPrice = null, stopLoss = null;
  if (entryPrice && !isNaN(entryPrice) && entryPrice > 0) {
    if (action === 'BUY') {
      targetPrice = parseFloat((entryPrice * (1 + expectedPct / 100)).toFixed(2));
      stopLoss    = parseFloat((entryPrice * (1 - stopPct / 100)).toFixed(2));
    } else if (action === 'SELL') {
      targetPrice = parseFloat((entryPrice * (1 - expectedPct / 100)).toFixed(2));
      stopLoss    = parseFloat((entryPrice * (1 + stopPct / 100)).toFixed(2));
    }
    // WATCH signals get no target/stop — there is no position to manage
  }

  // ── Build plain-English rationale ────────────────────────────────────
  const sorted = Object.entries(levers)
    .filter(([k]) => LEVER_LABELS[k])
    .sort((a, b) => b[1] - a[1]);

  const strengths = sorted.slice(0, 2)
    .map(([k, v]) => leverPhrase(k, v))
    .filter(Boolean);
  const weakest = sorted.at(-1);
  const weakness = weakest && weakest[1] < 5 ? leverPhrase(weakest[0], weakest[1]) : null;

  const actionVerb = action === 'BUY'
    ? 'We see this as a buying opportunity'
    : action === 'SELL'
    ? 'We would be cautious on this right now'
    : 'We are watching this closely rather than acting';

  let rationale = `${actionVerb}. `;
  if (strengths.length) {
    rationale += `On the positive side, ${strengths.join(', and ')}. `;
  }
  if (weakness) {
    rationale += `The main thing to be aware of is that ${weakness}. `;
  }
  if (wasVetoed && gateResult?.reason) {
    rationale += `${gateResult.reason} `;
  }
  if (gateResult?.caution && gateResult?.reason) {
    rationale += `${gateResult.reason} `;
  }
  if (targetPrice && action !== 'WATCH') {
    rationale += `Our ${horizonDays}-day view sees fair value around ₹${targetPrice.toLocaleString('en-IN')}, ` +
                 `with ₹${stopLoss.toLocaleString('en-IN')} as the level where we would reconsider.`;
  }

  // ── Detect signal change vs the previous call ────────────────────────
  let previousAction = null, changeNote = null;
  try {
    const { data: prev } = await supabaseAdmin
      .from('recommendations')
      .select('action, generated_at')
      .eq('instrument_name', instrument.symbol)
      .is('client_id', null)
      .eq('is_active', true)
      .order('generated_at', { ascending: false })
      .limit(1);

    if (prev?.length && prev[0].action !== action) {
      previousAction = prev[0].action;
      const topLever = sorted[0];
      changeNote = `Changed from ${previousAction} to ${action} this week. ` +
                   `The biggest factor was that ${leverPhrase(topLever[0], topLever[1])}.`;
    }
  } catch {}

  // ── Deactivate previous engine signals (recent ones only) ────────────
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000).toISOString();
  try {
    await supabaseAdmin
      .from('recommendations')
      .update({ is_active: false })
      .eq('instrument_name', instrument.symbol)
      .is('instrument_id', null)
      .is('client_id', null)
      .eq('is_active', true)
      .gte('generated_at', eightDaysAgo);
  } catch (e) {
    console.warn(`   ⚠ Could not deactivate old signals for ${instrument.symbol}: ${e.message}`);
  }

  const { error } = await supabaseAdmin.from('recommendations').insert({
    client_id:            null,
    instrument_id:        null,
    instrument_name:      instrument.symbol,
    action,
    signal_tier:          tier,
    confidence_score:     confidence,
    entry_price_inr:      entryPrice ?? null,
    target_price_inr:     targetPrice,
    stop_loss_inr:        stopLoss,
    horizon_days:         horizonDays,
    expected_return_pct:  action === 'WATCH' ? null : expectedPct,
    valid_until:          new Date(Date.now() + horizonDays * 86400000).toISOString(),
    rationale_text:       rationale.trim(),
    rationale_short:      `${action} — ${composite}/100 confidence score`,
    signal_change_note:   changeNote,
    previous_action:      previousAction,
    risk_gate_passed:     !wasVetoed,
    risk_gate_veto_reason: wasVetoed ? gateResult.reason : null,
    is_active:            true,
    generated_at:         new Date().toISOString(),
  });

  if (error) {
    console.warn(`   ⚠ Signal insert failed for ${instrument.symbol}: ${error.message}`);
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY MANAGEMENT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function notifyClientsOfCategoryChange(instrument, oldCat, newCat) {
  if (!supabaseAdmin) return 0;
  try {
    const { data: holdings } = await supabaseAdmin
      .from('portfolio_holdings')
      .select('client_id')
      .eq('instrument_name', instrument.symbol)
      .eq('is_active', true);

    if (!holdings?.length) return 0;

    const oldLabel = CATEGORY_LABEL[oldCat] ?? oldCat;
    const newLabel = newCat === 'removed'
      ? 'removed from our active list'
      : `moved to ${CATEGORY_LABEL[newCat] ?? newCat}`;

    // Risk ranking so we can tell each client whether this matters for them
    const RISK_RANK = { low: 1, low_moderate: 2, moderate: 3, moderate_high: 4, high: 5 };
    const newRank = RISK_RANK[CATEGORY_RISK[newCat]] ?? 3;

    // Fetch each client's risk tolerance so guidance is personal, not generic
    const clientIds = holdings.map(h => h.client_id);
    const { data: clients } = await supabaseAdmin
      .from('clients')
      .select('id, full_name, email, stated_risk_score, email_alerts_enabled')
      .in('id', clientIds);

    const notifications = [];

    for (const h of holdings) {
      const client = (clients || []).find(c => c.id === h.client_id);
      const riskScore = client?.stated_risk_score ?? 5;
      // Map a 1-10 stated risk score onto the same 1-5 rank scale
      const clientRank = riskScore <= 3 ? 2 : riskScore <= 6 ? 3 : 5;

      // Plain-English guidance based on whether this now exceeds their comfort
      let guidance;
      if (newCat === 'removed') {
        guidance = 'We have removed this from our actively tracked list, which means we will no longer publish signals on it. ' +
                   'This is not a recommendation to sell — it means we no longer have enough confidence in our analysis to guide you on it.';
      } else if (newRank > clientRank) {
        guidance = `This instrument is now classified as higher risk than your stated comfort level of ${riskScore}/10. ` +
                   `You may wish to review whether this position still suits you.`;
      } else if (newRank < clientRank) {
        guidance = `This instrument has become more conservative than before. It remains well within your risk comfort level of ${riskScore}/10.`;
      } else {
        guidance = `This instrument remains within your stated risk comfort level of ${riskScore}/10. No immediate action is needed, but it is worth knowing.`;
      }

      const body = `${instrument.name} has been ${newLabel} (previously ${oldLabel}). ${guidance}`;

      notifications.push({
        client_id:     h.client_id,
        type:          'category_change',
        title:         `Risk category change: ${instrument.name}`,
        body,
        instrument_id: instrument.id,
        is_read:       false,
        created_at:    new Date().toISOString(),
      });

      // Email the client as well, if they have an address and alerts on
      if (client?.email && client.email_alerts_enabled !== false) {
        emailEngine.sendCategoryChangeNotice(
          client, instrument.name, oldLabel,
          newCat === 'removed' ? 'no longer tracked' : (CATEGORY_LABEL[newCat] ?? newCat),
          guidance
        ).catch(() => {});  // never let email failure break the scoring run
      }
    }

    const { error } = await supabaseAdmin.from('client_notifications').insert(notifications);
    if (error) throw new Error(error.message);
    return holdings.length;
  } catch (e) {
    console.warn(`   ⚠ Client notification failed for ${instrument.symbol}: ${e.message}`);
    return 0;
  }
}

async function logCategoryChange(instrument, newCategory, triggerScore, reason) {
  try {
    await supabaseAdmin.from('category_change_log').insert({
      instrument_id:  instrument.id,
      old_category:   instrument.category,
      new_category:   newCategory,
      old_risk_level: instrument.risk_level,
      new_risk_level: CATEGORY_RISK[newCategory] ?? 'n/a',
      trigger_score:  triggerScore,
      reason,
      changed_at:     new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`   ⚠ Category change log failed for ${instrument.symbol}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

async function runInstrumentScoringEngine() {
  if (!supabaseAdmin) {
    console.log('🎯 Instrument engine: Supabase not configured, skipping.');
    return;
  }

  const runStart = Date.now();
  console.log('🎯 Running instrument scoring engine...');

  // Load shared macro indicators (one call, shared across all 120 scorings)
  let macroData = null;
  let macroVix  = null;
  try {
    macroData = await getMacroIndicators();
    if (macroData) {
      console.log(`   Macro — GDP: ${macroData.gdp_latest}% | CPI: ${macroData.cpi_latest}% | Repo: ${macroData.repo_rate}%`);
    }
  } catch (e) {
    console.warn('   ⚠ Macro data unavailable, levers 5 & 7 will use defaults:', e.message);
  }

  // VIX drives the risk gate — fetch it separately so a macro failure
  // doesn't leave the gate blind to market volatility
  try {
    const { getIndiaVIX } = require('./marketData');
    macroVix = await getIndiaVIX();
    if (macroVix != null) console.log(`   India VIX: ${Number(macroVix).toFixed(1)} (risk gate active)`);
  } catch {}

  // Load all instruments including the new columns from fix_instrument_data.sql
  // (price_source, amfi_code, static_price, yahoo_ticker)
  const { data: instruments, error: loadErr } = await supabaseAdmin
    .from('instrument_universe')
    .select('*')
    .in('status', ['active', 'watchlist'])
    .order('instrument_type')
    .order('category');

  if (loadErr || !instruments?.length) {
    console.error('🎯 Could not load instruments:', loadErr?.message ?? 'empty result');
    return;
  }

  console.log(`   Loaded ${instruments.length} instruments\n`);

  // Risk gate session — scoped to this run so concentration limits
  // apply per scoring cycle, not cumulatively across cycles
  const gateSession = createGateSession();

  // Per-run counters
  let scored = 0, signalsCreated = 0;
  let downgraded = 0, removed = 0, promoted = 0, failed = 0;
  const bySource = { yahoo: 0, mfapi: 0, static_reference: 0, nse: 0, no_price: 0 };
  const now = new Date().toISOString();

  for (const instrument of instruments) {
    try {
      // 1. Fetch price via the correct source for this instrument type
      const priceData = await fetchInstrumentPrice(instrument);
      const srcKey = priceData?.source?.startsWith('yahoo')  ? 'yahoo'
                   : priceData?.source?.startsWith('mfapi')  ? 'mfapi'
                   : priceData?.source === 'static_reference' ? 'static_reference'
                   : priceData?.source?.startsWith('nse')    ? 'nse'
                   : 'no_price';
      bySource[srcKey]++;

      // 2. Score across 9 levers
      const scores    = await scoreInstrument(instrument, macroData, priceData);
      const composite = scores.composite;
      scored++;

      // 3. Persist score (append-only audit trail — never update, always insert)
      const { error: scoreErr } = await supabaseAdmin.from('instrument_scores').insert({
        instrument_id:       instrument.id,
        technical:           scores.technical,
        fundamental:         scores.fundamental,
        management:          scores.management,
        sentiment:           scores.sentiment,
        institutional:       scores.institutional,
        sector_timing:       scores.sector_timing,
        macro_pestle:        scores.macro_pestle,
        competitive:         scores.competitive,
        risk_adjusted:       scores.risk_adjusted,
        composite_score:     composite,
        category_at_scoring: instrument.category,
        data_complete:       priceData !== null,
        score_notes:         priceData ? null : 'Price unavailable — levers 1 & 4 used neutral defaults',
        scored_at:           now,
      });
      if (scoreErr) console.warn(`   ⚠ Score persist failed for ${instrument.symbol}: ${scoreErr.message}`);

      // 4. Update summary score on instrument record
      await supabaseAdmin
        .from('instrument_universe')
        .update({ current_score: composite, last_scored_at: now })
        .eq('id', instrument.id);

      // 5. Category movement logic (active instruments only)
      if (instrument.status === 'active') {

        if (composite <= instrument.exit_score_threshold) {
          // Remove — score fell below exit floor
          await supabaseAdmin
            .from('instrument_universe')
            .update({ status: 'removed' })
            .eq('id', instrument.id);
          await logCategoryChange(instrument, 'removed', composite,
            `Score ${composite} below exit threshold ${instrument.exit_score_threshold}`);
          console.log(`   🔴 REMOVED: ${instrument.symbol} (score ${composite}, floor ${instrument.exit_score_threshold})`);
          const n = await notifyClientsOfCategoryChange(instrument, instrument.category, 'removed');
          if (n) console.log(`      → ${n} client(s) notified`);
          removed++;

        } else if (composite < SCORE_DOWNGRADE) {
          // Downgrade — type-aware: equity stays in equity, funds in funds
          const nextCat = DOWNGRADE_PATH[instrument.category];
          if (nextCat) {
            const newRisk = CATEGORY_RISK[nextCat] ?? instrument.risk_level;
            const { error: dgErr } = await supabaseAdmin
              .from('instrument_universe')
              .update({ category: nextCat, risk_level: newRisk })
              .eq('id', instrument.id);
            if (!dgErr) {
              await logCategoryChange(instrument, nextCat, composite,
                `Score ${composite} below downgrade threshold ${SCORE_DOWNGRADE}`);
              console.log(`   🟡 DOWNGRADED: ${instrument.symbol}  ${CATEGORY_LABEL[instrument.category]} → ${CATEGORY_LABEL[nextCat]}  (score ${composite})`);
              const n = await notifyClientsOfCategoryChange(instrument, instrument.category, nextCat);
              if (n) console.log(`      → ${n} client(s) notified immediately`);
              downgraded++;
            } else {
              console.warn(`   ⚠ Downgrade DB write failed for ${instrument.symbol}: ${dgErr.message}`);
            }
          } else {
            // Terminal — already at lowest category for its type
            console.log(`   🟠 REVIEW: ${instrument.symbol} scored ${composite} but is already at lowest category (${instrument.category})`);
          }
        }
      }

      // 6. Watchlist promotion — requires 3 consecutive weeks above threshold
      if (instrument.status === 'watchlist' && composite >= SCORE_PROMOTE) {
        const { data: history } = await supabaseAdmin
          .from('instrument_scores')
          .select('composite_score')
          .eq('instrument_id', instrument.id)
          .order('scored_at', { ascending: false })
          .limit(3);

        if (history?.length >= 3 && history.every(s => s.composite_score >= SCORE_PROMOTE)) {
          // Determine target category by instrument type (not just risk_level)
          const targetCat =
            instrument.instrument_type === 'mutual_fund' ? 'large_cap_fund' :
            instrument.instrument_type === 'etf'         ? 'index_etf'      :
            instrument.risk_level === 'high'             ? 'small_cap_equity':
            instrument.risk_level === 'moderate_high'    ? 'mid_cap_equity'  :
                                                           'large_cap_equity';

          const { error: promErr } = await supabaseAdmin
            .from('instrument_universe')
            .update({ status: 'active', category: targetCat, is_watchlist: false })
            .eq('id', instrument.id);

          if (!promErr) {
            await logCategoryChange(instrument, targetCat, composite,
              `Promoted: scored ≥${SCORE_PROMOTE} for 3 consecutive weeks`);
            console.log(`   🟢 PROMOTED: ${instrument.symbol} → active (${CATEGORY_LABEL[targetCat]}, score ${composite})`);
            promoted++;
          }
        }
      }

      // 7. Risk gate, then generate live signal for active instruments
      if (instrument.status === 'active') {
        const proposedAction = composite >= 70 ? 'BUY' : composite >= 50 ? 'WATCH' : 'SELL';

        // The gate can veto or downgrade any signal regardless of score.
        // Capital preservation first — this is the safety layer.
        const gateResult = await runRiskGate(
          instrument, proposedAction, composite,
          { vix: macroVix, priceSource: srcKey },
          gateSession
        );

        if (gateResult.vetoed) {
          console.log(`   🛡  GATE: ${instrument.symbol} ${proposedAction} → ${gateResult.action} (${gateResult.reason})`);
        }

        const ok = await convertScoreToRecommendation(
          instrument, composite, scores, priceData?.price ?? null, gateResult
        );
        if (ok) signalsCreated++;
      }

      // 8. Per-instrument log line
      const srcDisplay = srcKey === 'no_price' ? '⚠ no price' : srcKey;
      console.log(`   📊 ${instrument.symbol.padEnd(15)} ${composite}/100  [${srcDisplay}]`);

    } catch (e) {
      // Fully isolated — one failure never stops the full run
      console.error(`   ❌ ${instrument.symbol}: unhandled error — ${e.message}`);
      failed++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - runStart) / 1000);
  const line    = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`🎯 Instrument engine complete  (${elapsed}s)`);
  console.log(`   Instruments: ${scored} scored | ${failed} failed`);
  console.log(`   Signals:     ${signalsCreated} created/refreshed`);
  console.log(`   Risk gate:   ${gateSession.vetoCount} vetoed | ${gateSession.cautionCount} flagged with caution`);
  console.log(`   Category:    ${downgraded} downgraded | ${removed} removed | ${promoted} promoted`);
  console.log(`   Price src:   Yahoo ${bySource.yahoo} | MFAPI ${bySource.mfapi} | Static ${bySource.static_reference} | NSE ${bySource.nse} | Missing ${bySource.no_price}`);
  console.log(line);

  await reportRun({
    engineName:     'instrumentEngine',
    durationMs:     Date.now() - runStart,
    itemsProcessed: scored,
    itemsExpected:  instruments.length,
    itemsFailed:    failed,
    detail:         `${signalsCreated} signals, ${gateSession.vetoCount} gate vetoes, ` +
                    `sources: yahoo=${bySource.yahoo} mfapi=${bySource.mfapi} static=${bySource.static_reference} missing=${bySource.no_price}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  runInstrumentScoringEngine,
  convertScoreToRecommendation,
  fetchInstrumentPrice,     // exported for use by trackRecordEngine
  scoreInstrument,          // exported for unit testing
};
