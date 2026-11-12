/**
 * Starting plan — for clients with no holdings logged.
 *
 * Turns the client's risk profile and goals into a mix per goal, the monthly
 * amount each goal needs, and named instruments for each part of the mix.
 * The client is never asked how much they can invest: the plan says what each
 * goal needs and the client invests what they choose.
 *
 * The numbers (see docs/STARTING_PLAN.md for sources, checked Nov 2026):
 *   - Equity caps follow PFRDA's NPS lifecycle funds: conservative LC25 (25%),
 *     moderate LC50 (50%), aggressive LC75 (75%). A past panic-sell lowers the cap 10 points.
 *   - Time to goal: under 3 years no equity (debt only); 3-5 years at most 25%;
 *     5-7 years at most 50% (Nifty 50 TRI has had no meaningful loss over any
 *     5-year window since 1999); over 7 years the risk cap applies.
 *   - Planning returns, deliberately below long-run history: equity 10%
 *     (Nifty 50 TRI 20-yr ~11-12.4%, recent 20-yr rolling <10%), debt 6.5%
 *     (short-duration/low-duration funds ~6.5-7.7% over 10 years), gold 8%
 *     (20-yr INR ~11-15%, inflated by the recent rally and rupee fall).
 *
 * Pure: no database access. The caller loads the data and passes it in.
 */

'use strict';

const RETURNS = { equity: 10, debt: 6.5, gold: 8 };            // % a year, for planning only
const EQUITY_CAP = { low: 25, moderate: 50, high: 75 };        // NPS LC25 / LC50 / LC75
const PANIC_CUT = 10;

// Broad, passive instruments that track a whole market or gold. Naming one
// needs no score of its own — it IS the asset class. Sector/thematic ETFs
// (BANKBEES, ITBEES, MOM100, BHARAT22ETF) are not used in a starting plan.
const BROAD_INDEX = ['NIFTYBEES', 'SBINIFTY', 'HDFCSENSEX'];
const NEXT50_INDEX = ['JUNIORBEES'];
const GOLD_ETFS = ['GOLDBEES', 'SBIGOLD', 'HDFCGOLD', 'AXISGOLD', 'MIRGOLD'];

function riskBand(score) {
  if (score == null) return 'moderate';
  if (score <= 3) return 'low';
  if (score <= 6) return 'moderate';
  return 'high';
}

function equityCap(riskScore, panicHistory) {
  const cap = EQUITY_CAP[riskBand(riskScore)];
  return Math.max(0, cap - (panicHistory ? PANIC_CUT : 0));
}

/** Equity / debt / gold percentages for a goal `years` away. */
function mixFor(years, cap) {
  if (years == null) return { equity: cap, debt: 100 - cap - 10, gold: 10 };   // no date: treat as long-term
  if (years < 3) return { equity: 0, debt: 100, gold: 0 };
  if (years < 5) { const e = Math.min(25, cap); return { equity: e, debt: 95 - e, gold: 5 }; }
  if (years < 7) { const e = Math.min(50, cap); return { equity: e, debt: 90 - e, gold: 10 }; }
  return { equity: cap, debt: 90 - cap, gold: 10 };
}

/** Monthly amount needed to reach `target` in `months`, starting from `current`. */
function monthlyNeeded(target, current, months, annualPct) {
  if (!(months > 0) || !(target > 0)) return null;
  const r = annualPct / 100 / 12;
  const growth = Math.pow(1 + r, months);
  const shortfall = target - (current || 0) * growth;
  if (shortfall <= 0) return 0;
  return r === 0 ? shortfall / months : shortfall * r / (growth - 1);
}

const blended = mix => (mix.equity * RETURNS.equity + mix.debt * RETURNS.debt + mix.gold * RETURNS.gold) / 100;

const isEmergency = g => /emergency/i.test(g.goal_name || '') || g.goal_type === 'emergency';

/**
 * Picks named instruments for each part of the mix.
 * `pool` rows: { symbol, name, category, measured (bool), action, confidence }.
 *   - actively managed funds: only if measured on real data and not on SELL
 *   - stocks: only if measured and on BUY, and in a category the risk band allows
 *   - broad index / gold ETFs: passive stand-ins for the asset class, never on SELL
 */
function chooseInstruments(pool, band) {
  const notSell = i => i.action !== 'SELL';
  const byConf = (a, b) => (b.confidence || 0) - (a.confidence || 0);
  const pick = (rows, n) => rows.sort(byConf).slice(0, n);
  const bySymbols = (list) => list.map(s => pool.find(i => i.symbol === s)).filter(i => i && notSell(i));
  const measuredFunds = cat => pool.filter(i => i.category === cat && i.measured && notSell(i) && i.instrument_type === 'mutual_fund');

  const debtFunds = measuredFunds('debt_fund');
  const liquid = pick(debtFunds.filter(i => /liquid|ultra short|savings|overnight|money market/i.test(i.name || '')), 2);
  const shortDebt = pick(debtFunds.filter(i => /short|bond|duration/i.test(i.name || '') && !liquid.includes(i)), 2);

  const stockCats = { low: ['large_cap_equity'], moderate: ['large_cap_equity', 'mid_cap_equity'], high: ['large_cap_equity', 'mid_cap_equity', 'small_cap_equity'] }[band];
  const stocks = cat => pick(pool.filter(i => i.category === cat && stockCats.includes(cat) && i.measured && i.action === 'BUY'), 2);

  return {
    liquid: liquid.length ? liquid : pick(debtFunds, 2),
    debt: shortDebt.length ? shortDebt : pick(debtFunds, 2),
    large: [...bySymbols(BROAD_INDEX).slice(0, 1), ...pick(measuredFunds('large_cap_fund'), 2), ...stocks('large_cap_equity')],
    flexiMid: [...pick(measuredFunds('flexi_mid_fund'), 2), ...bySymbols(NEXT50_INDEX), ...stocks('mid_cap_equity')],
    small: stocks('small_cap_equity'),
    gold: bySymbols(GOLD_ETFS).slice(0, 2),
  };
}

/** How the equity part is split, by risk band (low: large only). */
function equitySplit(band) {
  if (band === 'low') return [['large', 100]];
  if (band === 'moderate') return [['large', 60], ['flexiMid', 40]];
  return [['large', 50], ['flexiMid', 30], ['small', 20]];
}

const SLEEVE_LABEL = {
  liquid: 'Liquid / ultra-short debt', debt: 'Short-term debt',
  large: 'Large-cap & index', flexiMid: 'Flexi-cap & mid-cap', small: 'Small-cap', gold: 'Gold',
};

/**
 * @param {object} input
 * @param {number|null} input.riskScore
 * @param {boolean} input.panicHistory
 * @param {Array} input.goals   client_goals rows (active)
 * @param {Array} input.pool    instruments with signal/measurement info
 * @param {Date}   [input.now]
 */
function buildStartingPlan({ riskScore, panicHistory, goals, pool, now = new Date() }) {
  const band = riskBand(riskScore);
  const cap = equityCap(riskScore, panicHistory);
  const choice = chooseInstruments(pool || [], band);

  const sleevesFor = (mix, emergency) => {
    const out = [];
    const add = (key, pct) => {
      if (pct <= 0) return;
      const instruments = choice[key] || [];
      out.push({ sleeve: key, label: SLEEVE_LABEL[key], pct, instruments: instruments.map(i => ({ symbol: i.symbol, name: i.name })) });
    };
    if (emergency) { add('liquid', 100); return out; }
    // Equity: split by band; a part with nothing eligible folds into large-cap.
    // Large-cap takes whatever is left, so rounding never pushes the total off 100.
    let others = 0;
    const parts = [];
    for (const [key, share] of equitySplit(band)) {
      if (key === 'large') continue;
      if (!(choice[key] || []).length) continue;             // nothing eligible: folds into large-cap
      const pct = Math.floor(mix.equity * share / 100);
      parts.push([key, pct]); others += pct;
    }
    add('large', mix.equity - others);
    for (const [key, pct] of parts) add(key, pct);
    add(mix.equity === 0 && mix.gold === 0 ? 'liquid' : 'debt', mix.debt);
    add('gold', mix.gold);
    return out;
  };

  const ordered = [...(goals || [])].sort((a, b) => (isEmergency(b) - isEmergency(a)) ||
    (new Date(a.target_date || '2999-01-01') - new Date(b.target_date || '2999-01-01')));

  const planGoals = ordered.map(g => {
    const emergency = isEmergency(g);
    const date = g.target_date ? new Date(g.target_date) : null;
    const months = date ? Math.max(0, Math.round((date - now) / (30.4375 * 86400000))) : null;
    const years = months != null ? months / 12 : null;
    const mix = emergency ? { equity: 0, debt: 100, gold: 0 } : mixFor(years, cap);
    const rate = blended(mix);
    const monthly = months ? monthlyNeeded(Number(g.target_amount_inr) || 0, Number(g.current_corpus_inr) || 0, months, rate) : null;
    return {
      goal: g.goal_name, target: Number(g.target_amount_inr) || null, current: Number(g.current_corpus_inr) || 0,
      target_date: g.target_date || null, years: years != null ? Math.round(years * 10) / 10 : null,
      emergency, mix, expected_return_pct: Math.round(rate * 10) / 10,
      monthly_needed: monthly != null ? Math.round(monthly / 100) * 100 : null,
      sleeves: sleevesFor(mix, emergency),
    };
  });

  // No goals: one long-term plan from the risk profile alone.
  if (!planGoals.length) {
    const mix = mixFor(null, cap);
    planGoals.push({ goal: 'Long-term wealth', target: null, current: 0, target_date: null, years: null,
      emergency: false, mix, expected_return_pct: Math.round(blended(mix) * 10) / 10, monthly_needed: null,
      sleeves: sleevesFor(mix, false) });
  }

  const totalMonthly = planGoals.reduce((s, g) => s + (g.monthly_needed || 0), 0);
  return {
    risk_band: band, equity_cap_pct: cap, panic_adjusted: !!panicHistory,
    goals: planGoals,
    total_monthly_needed: totalMonthly || null,
    has_emergency_goal: planGoals.some(g => g.emergency),
    assumptions: `Planning returns: equity ${RETURNS.equity}%, debt ${RETURNS.debt}%, gold ${RETURNS.gold}% a year — below long-run history on purpose, and not guaranteed. ` +
                 `Mixes follow time to each goal; equity is capped at ${cap}% for your ${band} risk profile${panicHistory ? ' (lowered because you sold in a past fall)' : ''}.`,
  };
}

const fmtINR = n => {
  if (n == null || isNaN(n)) return '—';
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2).replace(/\.00$/, '') + ' Cr';
  if (n >= 100000) return '₹' + (n / 100000).toFixed(1).replace(/\.0$/, '') + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

/** Plain-text rendering (used in the stored brief and the app). */
function planToText(plan) {
  const lines = [`Based on your ${plan.risk_band} risk profile${plan.goals.length > 1 ? ' and goals' : ''}:`];
  plan.goals.forEach((g, i) => {
    const when = g.target_date ? ` by ${new Date(g.target_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}` : '';
    const need = g.monthly_needed != null ? ` — about ${fmtINR(g.monthly_needed)}/month` : '';
    lines.push(`${i + 1}. ${g.goal}${g.target ? ` (${fmtINR(g.target)}${when})` : ''}${need}`);
    for (const s of g.sleeves) {
      const amt = g.monthly_needed ? ` (~${fmtINR(Math.round(g.monthly_needed * s.pct / 10000) * 100)})` : '';
      const names = s.instruments.length ? `: ${s.instruments.map(x => x.name || x.symbol).join(', ')}` : '';
      lines.push(`   • ${s.pct}% ${s.label}${amt}${names}`);
    }
  });
  if (!plan.has_emergency_goal) lines.push('Before investing for other goals, most planners suggest an emergency fund of 3–6 months of expenses in a liquid fund.');
  lines.push(plan.assumptions);
  lines.push('Invest what you are comfortable with — any amount helps. Add what you buy as holdings and we will track it each morning.');
  return lines.join('\n');
}

module.exports = { buildStartingPlan, planToText, mixFor, equityCap, monthlyNeeded, RETURNS, EQUITY_CAP, fmtINR };
