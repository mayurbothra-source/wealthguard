/**
 * WealthGuard Instrument Scoring Engine
 * Runs weekly (Sunday at 8 PM IST).
 * Scores all 100 active instruments across 9 levers.
 * Detects category drops → moves instrument → notifies affected clients immediately.
 * Also promotes watchlist instruments that consistently score above threshold.
 */

const { supabaseAdmin } = require('../../config/supabase');
const { getYahooQuote, getNSEQuote, getMacroIndicators } = require('./marketData');

// Score thresholds per risk action
const SCORE_DOWNGRADE  = 55; // drop below this → move down one category
const SCORE_REMOVE     = 30; // drop below this → remove from active list
const SCORE_PROMOTE    = 68; // watchlist instrument scoring above this → candidate for promotion

// Category ordering (lower index = lower risk)
const CATEGORY_ORDER = [
  'debt_fund', 'bond_gsec', 'gold',
  'large_cap_fund', 'index_etf',
  'large_cap_equity',
  'flexi_mid_fund', 'mid_cap_equity',
  'small_cap_equity',
];

const CATEGORY_RISK = {
  'debt_fund':       'low',
  'bond_gsec':       'low',
  'gold':            'low_moderate',
  'large_cap_fund':  'moderate',
  'index_etf':       'moderate',
  'large_cap_equity':'moderate',
  'flexi_mid_fund':  'moderate_high',
  'mid_cap_equity':  'moderate_high',
  'small_cap_equity':'high',
};

function categoryOneStepDown(current) {
  const idx = CATEGORY_ORDER.indexOf(current);
  if (idx <= 0) return current; // already at lowest, can't go lower
  return CATEGORY_ORDER[idx - 1];
}

/**
 * 9-levers scoring for a given instrument.
 * Uses available data sources — price data from NSE/Yahoo plus macro indicators.
 * This is a data-driven approximation of the full analytical engine.
 * Each lever scored 0–10; composite = sum scaled to 0–100.
 *
 * For full AI-powered analysis, this function is the injection point —
 * replace or augment individual lever functions as data becomes available.
 */
async function scoreInstrument(instrument, macroData) {
  const scores = {
    technical:    null,
    fundamental:  null,
    management:   null,
    sentiment:    null,
    institutional:null,
    sector_timing:null,
    macro_pestle: null,
    competitive:  null,
    risk_adjusted:null,
  };

  let priceData = null;
  if (instrument.yahoo_ticker) {
    try {
      const q = await getYahooQuote(instrument.yahoo_ticker);
      if (q && q.source === 'yahoo_live') priceData = q;
    } catch {}
  }
  if (!priceData && instrument.exchange === 'NSE') {
    try {
      const q = await getNSEQuote(instrument.symbol);
      if (q && q.source === 'nse_live') priceData = q;
    } catch {}
  }

  // ── Lever 1: Technical ────────────────────────────────────
  // Uses 1-day price change as a proxy when full history is unavailable.
  // In production: add 50MA/200MA crossover, RSI, MACD.
  if (priceData) {
    const chg = priceData.change_pct || 0;
    scores.technical = Math.min(10, Math.max(0, 5 + chg)); // centre on 5
  } else {
    scores.technical = 5; // neutral when no price available
  }

  // ── Lever 2: Fundamental ─────────────────────────────────
  // Static baseline by category — ideally fed from quarterly earnings data.
  const fundamentalBase = {
    'large_cap_equity': 7, 'mid_cap_equity': 6, 'small_cap_equity': 5,
    'large_cap_fund': 7,   'flexi_mid_fund': 6, 'index_etf': 7,
    'gold': 6,             'bond_gsec': 8,       'debt_fund': 8,
    'watchlist': 5,
  };
  scores.fundamental = fundamentalBase[instrument.category] || 6;

  // ── Lever 3: Management quality ──────────────────────────
  // Static baseline — updated manually when governance issues arise.
  const mgmtBase = {
    'large_cap_equity': 7, 'mid_cap_equity': 6, 'small_cap_equity': 5,
    'large_cap_fund': 8,   'flexi_mid_fund': 7, 'index_etf': 9,
    'gold': 9,             'bond_gsec': 10,      'debt_fund': 9,
    'watchlist': 5,
  };
  scores.management = mgmtBase[instrument.category] || 7;

  // ── Lever 4: Sentiment ───────────────────────────────────
  // Proxy: positive price movement = positive sentiment.
  if (priceData) {
    const chg = priceData.change_pct || 0;
    scores.sentiment = Math.min(10, Math.max(0, 5 + chg * 0.5));
  } else {
    scores.sentiment = 5;
  }

  // ── Lever 5: Institutional flow ──────────────────────────
  // Uses macro FII/DII data as a proxy for individual instruments.
  const fii = macroData?.fii_net_cr || 0;
  const dii = macroData?.dii_net_cr || 0;
  const netFlow = fii + dii;
  scores.institutional = Math.min(10, Math.max(0, 5 + Math.sign(netFlow) * 2));

  // ── Lever 6: Sector timing ───────────────────────────────
  // Static baseline — updated when sector rotation signals change.
  const sectorBase = {
    'large_cap_equity': 7, 'mid_cap_equity': 6, 'small_cap_equity': 5,
    'large_cap_fund': 7,   'flexi_mid_fund': 6, 'index_etf': 7,
    'gold': 6,             'bond_gsec': 7,       'debt_fund': 7,
    'watchlist': 5,
  };
  scores.sector_timing = sectorBase[instrument.category] || 6;

  // ── Lever 7: Macro / PESTLE ──────────────────────────────
  // Uses macro indicators: GDP, CPI, repo rate environment.
  const gdp = macroData?.gdp_latest || 7;
  const cpi = macroData?.cpi_latest || 5;
  const macroScore = (gdp >= 7 ? 3 : gdp >= 5 ? 2 : 1) +
                     (cpi <= 4 ? 3 : cpi <= 6 ? 2 : 1) +
                     (instrument.category === 'bond_gsec' ? 2 : 1);
  scores.macro_pestle = Math.min(10, macroScore);

  // ── Lever 8: Competitive positioning ─────────────────────
  // Static baseline — ideally Porter's Five Forces analysis.
  const competitiveBase = {
    'large_cap_equity': 7, 'mid_cap_equity': 6, 'small_cap_equity': 5,
    'large_cap_fund': 8,   'flexi_mid_fund': 7, 'index_etf': 8,
    'gold': 9,             'bond_gsec': 10,      'debt_fund': 9,
    'watchlist': 5,
  };
  scores.competitive = competitiveBase[instrument.category] || 7;

  // ── Lever 9: Risk-adjusted return ────────────────────────
  // Expected return per unit of risk — higher for defensive categories.
  const riskAdjBase = {
    'large_cap_equity': 7, 'mid_cap_equity': 6, 'small_cap_equity': 5,
    'large_cap_fund': 7,   'flexi_mid_fund': 6, 'index_etf': 7,
    'gold': 6,             'bond_gsec': 8,       'debt_fund': 9,
    'watchlist': 5,
  };
  scores.risk_adjusted = riskAdjBase[instrument.category] || 6;

  // ── Composite (sum all 9 levers, scale to 0–100) ─────────
  const total = Object.values(scores).reduce((sum, s) => sum + (s || 0), 0);
  const composite = Math.round((total / 90) * 100); // 90 = max possible (9 × 10)

  return { ...scores, composite };
}

/**
 * Notify all clients holding an instrument that has moved category.
 */
async function notifyClientsOfCategoryChange(instrument, oldCategory, newCategory, newRiskLevel) {
  if (!supabaseAdmin) return 0;
  try {
    // Find clients in any recommendation or portfolio holding this instrument
    const { data: holdings } = await supabaseAdmin
      .from('portfolio_holdings')
      .select('client_id')
      .eq('instrument_name', instrument.symbol)
      .eq('is_active', true);

    if (!holdings || !holdings.length) return 0;

    const riskDirection = CATEGORY_ORDER.indexOf(newCategory) < CATEGORY_ORDER.indexOf(oldCategory)
      ? 'downgraded (lower risk)' : 'upgraded (higher risk)';

    const message = `🔄 PORTFOLIO UPDATE: ${instrument.name} has been ${riskDirection} in our risk matrix. It has moved from ${oldCategory.replace(/_/g,' ')} to ${newCategory.replace(/_/g,' ')} based on our latest 9-levers score. Please review this position against your risk profile.`;

    const notifications = holdings.map(h => ({
      client_id:    h.client_id,
      type:         'category_change',
      title:        `Category Change: ${instrument.name}`,
      body:         message,
      instrument_id: instrument.id,
      is_read:      false,
      created_at:   new Date().toISOString(),
    }));

    await supabaseAdmin.from('client_notifications').insert(notifications);
    return holdings.length;
  } catch (e) {
    console.warn('   ⚠ Could not notify clients of category change:', e.message);
    return 0;
  }
}

/**
 * Main engine — runs weekly (Sunday 8 PM IST).
 */
async function runInstrumentScoringEngine() {
  if (!supabaseAdmin) {
    console.log('🎯 Instrument engine: Supabase not configured, skipping.');
    return;
  }
  console.log('🎯 Running weekly instrument scoring engine...');

  // Load macro data (shared across all scorings this run)
  let macroData = null;
  try {
    macroData = await getMacroIndicators();
  } catch {}

  // Load all instruments (active + watchlist)
  const { data: instruments, error } = await supabaseAdmin
    .from('instrument_universe')
    .select('*')
    .in('status', ['active', 'watchlist']);

  if (error || !instruments) {
    console.error('🎯 Could not load instruments:', error?.message);
    return;
  }

  let scored = 0, downgraded = 0, removed = 0, promoted = 0;

  for (const instrument of instruments) {
    try {
      const scores = await scoreInstrument(instrument, macroData);
      const composite = scores.composite;
      scored++;

      // Store this week's scores
      await supabaseAdmin.from('instrument_scores').insert({
        instrument_id:      instrument.id,
        technical:          scores.technical,
        fundamental:        scores.fundamental,
        management:         scores.management,
        sentiment:          scores.sentiment,
        institutional:      scores.institutional,
        sector_timing:      scores.sector_timing,
        macro_pestle:       scores.macro_pestle,
        competitive:        scores.competitive,
        risk_adjusted:      scores.risk_adjusted,
        composite_score:    composite,
        category_at_scoring:instrument.category,
        scored_at:          new Date().toISOString(),
      });

      // Update current score on instrument
      await supabaseAdmin.from('instrument_universe')
        .update({ current_score: composite, last_scored_at: new Date().toISOString() })
        .eq('id', instrument.id);

      // ── Category movement logic ──────────────────────────
      if (instrument.status === 'active') {
        if (composite <= instrument.exit_score_threshold) {
          // Remove from active list entirely
          await supabaseAdmin.from('instrument_universe')
            .update({ status: 'removed' })
            .eq('id', instrument.id);

          await supabaseAdmin.from('category_change_log').insert({
            instrument_id: instrument.id,
            old_category:  instrument.category,
            new_category:  'removed',
            trigger_score: composite,
            reason:        `Score ${composite} fell below exit threshold ${instrument.exit_score_threshold}`,
          });

          console.log(`   🔴 REMOVED: ${instrument.symbol} (score: ${composite})`);
          const n = await notifyClientsOfCategoryChange(instrument, instrument.category, 'removed', 'n/a');
          if (n) console.log(`      → ${n} client(s) notified`);
          removed++;

        } else if (composite <= SCORE_DOWNGRADE && instrument.category !== 'debt_fund') {
          // Move down one category
          const newCategory = categoryOneStepDown(instrument.category);
          if (newCategory !== instrument.category) {
            const newRisk = CATEGORY_RISK[newCategory] || instrument.risk_level;

            await supabaseAdmin.from('instrument_universe').update({
              category:   newCategory,
              risk_level: newRisk,
            }).eq('id', instrument.id);

            await supabaseAdmin.from('category_change_log').insert({
              instrument_id:  instrument.id,
              old_category:   instrument.category,
              new_category:   newCategory,
              old_risk_level: instrument.risk_level,
              new_risk_level: newRisk,
              trigger_score:  composite,
              reason:         `Score ${composite} fell below downgrade threshold ${SCORE_DOWNGRADE}`,
            });

            console.log(`   🟡 DOWNGRADED: ${instrument.symbol} ${instrument.category} → ${newCategory} (score: ${composite})`);
            const n = await notifyClientsOfCategoryChange(instrument, instrument.category, newCategory, newRisk);
            if (n) console.log(`      → ${n} client(s) notified immediately`);
            downgraded++;
          }
        }
      }

      // ── Watchlist promotion logic ────────────────────────
      if (instrument.status === 'watchlist' && composite >= SCORE_PROMOTE) {
        // Check consistency: has scored above threshold last 2 weeks too?
        const { data: recentScores } = await supabaseAdmin
          .from('instrument_scores')
          .select('composite_score')
          .eq('instrument_id', instrument.id)
          .order('scored_at', { ascending: false })
          .limit(3);

        const allAboveThreshold = recentScores &&
          recentScores.every(s => s.composite_score >= SCORE_PROMOTE);

        if (allAboveThreshold) {
          // Promote to active — determine appropriate category from risk level
          const targetCategory = instrument.risk_level === 'high'
            ? 'small_cap_equity'
            : instrument.risk_level === 'moderate_high'
            ? 'mid_cap_equity' : 'large_cap_equity';

          await supabaseAdmin.from('instrument_universe').update({
            status:   'active',
            category: targetCategory,
            is_watchlist: false,
          }).eq('id', instrument.id);

          console.log(`   🟢 PROMOTED: ${instrument.symbol} → active (${targetCategory}, score: ${composite})`);
          promoted++;
        }
      }

      console.log(`   📊 ${instrument.symbol}: ${composite}/100`);

    } catch (e) {
      console.warn(`   ⚠ Scoring failed for ${instrument.symbol}:`, e.message);
    }
  }

  console.log(`🎯 Instrument engine complete: ${scored} scored, ${downgraded} downgraded, ${removed} removed, ${promoted} promoted to active.`);
}

module.exports = { runInstrumentScoringEngine };
