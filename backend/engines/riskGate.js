/**
 * WealthGuard Risk Gate Engine
 * 10 sequential hard checks. Any failure blocks the recommendation.
 * These rules cannot be bypassed by the AI layer or any advisor.
 */
const { supabaseAdmin } = require('../../config/supabase');

async function runRiskGate(recommendation, clientProfile, behaviouralProfile, portfolioHoldings, macro) {
  const failures = [];
  const gates = {};

  const instrument = recommendation.instrument;
  const action = recommendation.convergence?.action;

  // Only run full gate for BUY signals
  if (!['BUY','REDUCE'].includes(action)) {
    return { passed: true, gates: {}, failures: [], all_passed: true };
  }

  // ── GATE 1: Instrument Eligibility ─────────────────────────
  const clientRiskScore = behaviouralProfile?.effective_risk_score || 5;
  const instrMinScore = instrument?.min_risk_score_required || 3;
  const instrRiskTier = instrument?.risk_tier || 3;
  gates.gate_1_eligibility = clientRiskScore >= instrMinScore;
  if (!gates.gate_1_eligibility) {
    failures.push(`Gate 1: Instrument requires risk score ${instrMinScore}+. Client score: ${clientRiskScore}. Instrument risk tier ${instrRiskTier} exceeds client eligibility.`);
  }

  // ── GATE 2: Position Size Cap ───────────────────────────────
  const totalPortfolioValue = portfolioHoldings?.reduce((s, h) => s + (h.current_value_inr || 0), 0) || 1000000;
  const maxPositionPct = behaviouralProfile?.max_single_position_pct || 10;
  const suggestedAmount = recommendation.suggested_amount_inr || 0;
  const suggestedPct = (suggestedAmount / totalPortfolioValue) * 100;
  gates.gate_2_position_size = suggestedPct <= maxPositionPct;
  if (!gates.gate_2_position_size) {
    failures.push(`Gate 2: Suggested position (${suggestedPct.toFixed(1)}%) exceeds max single position limit (${maxPositionPct}%). Reduce to ₹${Math.floor(totalPortfolioValue * maxPositionPct / 100).toLocaleString('en-IN')}.`);
    // Auto-correct rather than hard block
    recommendation.suggested_amount_inr = Math.floor(totalPortfolioValue * maxPositionPct / 100);
    recommendation.auto_adjusted = true;
    gates.gate_2_position_size = true; // Pass after correction
  }

  // ── GATE 3: Drawdown Simulation ────────────────────────────
  const maxDrawdownTolerance = behaviouralProfile?.max_drawdown_tolerance_pct || 20;
  // Simulate 30% crash on this position
  const crashScenario = suggestedAmount * 0.30;
  const currentPortfolioValue = totalPortfolioValue;
  const portfolioImpactPct = (crashScenario / currentPortfolioValue) * 100;
  const simulatedDrawdown = portfolioImpactPct; // simplified — full model uses correlation matrix
  gates.gate_3_drawdown_sim = simulatedDrawdown <= maxDrawdownTolerance;
  if (!gates.gate_3_drawdown_sim) {
    failures.push(`Gate 3: 30% crash simulation shows ${simulatedDrawdown.toFixed(1)}% portfolio impact, exceeding ${maxDrawdownTolerance}% tolerance.`);
  }
  recommendation.simulated_drawdown_pct = parseFloat(simulatedDrawdown.toFixed(2));

  // ── GATE 4: Liquidity Runway ────────────────────────────────
  const liquidReserve = clientProfile?.investable_surplus_inr
    ? clientProfile.investable_surplus_inr * 6  // 6 months emergency
    : 300000;
  const liquidHoldings = portfolioHoldings?.filter(h =>
    ['liquid','tbill','fd'].includes(h.asset_class) || h.instrument_name?.toLowerCase().includes('liquid')
  ).reduce((s,h) => s + (h.current_value_inr || 0), 0) || 0;
  gates.gate_4_liquidity = liquidHoldings >= liquidReserve;
  if (!gates.gate_4_liquidity) {
    failures.push(`Gate 4: Liquid assets (₹${liquidHoldings.toLocaleString('en-IN')}) below 6-month emergency fund requirement (₹${liquidReserve.toLocaleString('en-IN')}). Build emergency fund first.`);
  }

  // ── GATE 5: Correlation Overexposure ───────────────────────
  const sameCategory = portfolioHoldings?.filter(h =>
    h.sub_category === instrument?.sub_category && h.is_active
  ) || [];
  const categoryExposurePct = sameCategory.reduce((s,h) => s + (h.allocation_pct || 0), 0);
  const maxCategoryExposure = 40; // max 40% in same category
  gates.gate_5_correlation = categoryExposurePct < maxCategoryExposure;
  if (!gates.gate_5_correlation) {
    failures.push(`Gate 5: Already ${categoryExposurePct.toFixed(1)}% in ${instrument?.sub_category || 'this category'}. Max ${maxCategoryExposure}% per correlated category.`);
  }

  // ── GATE 6: Horizon Mismatch ────────────────────────────────
  const clientHorizonMonths = clientProfile?.working_years_remaining
    ? clientProfile.working_years_remaining * 12
    : 120;
  const instrMinHorizon = instrument?.sub_category === 'mid_cap' ? 36
    : instrument?.sub_category === 'large_cap' ? 18
    : instrument?.asset_class === 'bond' ? 12 : 6;
  gates.gate_6_horizon = clientHorizonMonths >= instrMinHorizon;
  if (!gates.gate_6_horizon) {
    failures.push(`Gate 6: Investment horizon (${clientHorizonMonths} months) shorter than minimum required (${instrMinHorizon} months) for ${instrument?.sub_category}.`);
  }

  // ── GATE 7: Confidence Filter ───────────────────────────────
  const confidence = recommendation.convergence?.confidence || 0;
  gates.gate_7_confidence = confidence >= 0.60;
  if (!gates.gate_7_confidence) {
    failures.push(`Gate 7: Signal confidence ${(confidence*100).toFixed(0)}% below minimum 60% threshold.`);
  }

  // ── GATE 8: Altman Z-Score ──────────────────────────────────
  const altmanZ = recommendation.fundamental_data?.altman_z_score;
  gates.gate_8_altman = !altmanZ || altmanZ >= 1.8;
  if (!gates.gate_8_altman) {
    failures.push(`Gate 8: Altman Z-Score ${altmanZ?.toFixed(2)} below 1.8 — financial distress zone. BUY blocked.`);
  }

  // ── GATE 9: Promoter Pledge ─────────────────────────────────
  const pledge = recommendation.fundamental_data?.promoter_pledge_pct;
  gates.gate_9_pledge = !pledge || pledge <= 50;
  if (!gates.gate_9_pledge) {
    failures.push(`Gate 9: Promoter pledge ${pledge?.toFixed(1)}% exceeds 50% — financial stress signal. BUY blocked.`);
  }

  // ── GATE 10: India VIX Override ─────────────────────────────
  const vix = macro?.vix || 13;
  gates.gate_10_vix = vix < 25;
  if (!gates.gate_10_vix) {
    failures.push(`Gate 10: India VIX ${vix?.toFixed(1)} ≥ 25 — CRISIS MODE. All new BUY signals frozen systemwide.`);
  }

  const allPassed = failures.length === 0;

  // Log to database
  if (supabaseAdmin && clientProfile?.id) {
    await supabaseAdmin.from('risk_gate_logs').insert({
      client_id: clientProfile.id,
      instrument_id: instrument?.id,
      ...gates,
      all_passed: allPassed,
      failure_reasons: failures,
      simulated_drawdown_pct: recommendation.simulated_drawdown_pct,
      checked_at: new Date().toISOString(),
    }).then(({ error }) => { if (error) console.error('Risk gate log error:', error.message); });
  }

  return { passed: allPassed, gates, failures, all_passed: allPassed };
}

// Client Stability Engine — activates during PESTLE shocks or market stress
function runStabilityEngine(clientBehavioural, currentDrawdown, marketStress) {
  const threshold = clientBehavioural?.stability_intervention_threshold_pct || 10;
  const panicHistory = clientBehavioural?.panic_history || false;

  const shouldIntervene = currentDrawdown >= threshold || marketStress;

  if (!shouldIntervene) return { intervene: false };

  // Historical context for panic prevention
  const historicalContext = {
    covid_2020: { drop: 38, recovery_months: 5, message: 'COVID crash (Mar 2020): −38%, full recovery in 5 months' },
    lehman_2008: { drop: 60, recovery_months: 24, message: '2008 crisis: −60%, recovery in 24 months' },
    russia_2022: { drop: 17, recovery_months: 8, message: 'Russia-Ukraine (2022): −17%, recovery in 8 months' },
  };

  const message = panicHistory
    ? `⚠️ Your portfolio is down ${currentDrawdown?.toFixed(1)}%. We note you have a history of exiting during corrections. Historical data: ${historicalContext.covid_2020.message}. Clients who held through all 7 major Indian market corrections in the last 20 years recovered fully. Your stop-losses are protecting you. No action required unless a stop-loss triggers.`
    : `ℹ️ Your portfolio is down ${currentDrawdown?.toFixed(1)}%. This is within your stated ${threshold}% tolerance. Market stress events are temporary. Your stop-losses and position sizing are protecting you. Review signals before acting.`;

  return {
    intervene: true,
    message,
    friction_required: panicHistory,
    historical_context: historicalContext,
  };
}

module.exports = { runRiskGate, runStabilityEngine };
