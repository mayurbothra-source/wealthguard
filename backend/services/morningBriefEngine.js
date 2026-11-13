/**
 * WealthGuard Morning Brief Engine
 *
 * Runs Mon–Fri at 7:30 AM IST (and builds on demand when a client opens the app
 * and today's brief does not exist yet — see generateBriefForClient).
 *
 * Every client gets an in-app brief; only active/trial subscribers with an email
 * address are also emailed.
 *
 * Sections:
 *   Today        — the one thing to do (or "no action needed")
 *   Market       — Nifty, VIX regime (placeholder 'demo' values are never shown)
 *   In the news  — events from the AI scan, last 72 hours
 *   Your holdings— what our signal says about each, and what that means
 *   Ideas        — BUYs that fit the client's risk profile and are not already held;
 *                  if none qualify it says so plainly
 *   Goals, Learn — progress, and a rotating concept
 *
 * AI usage: only the market snapshot uses AI, once per hour, shared by all clients
 * (memoised in getSharedSections). Everything per-client is computed from data.
 * If AI is unavailable a deterministic template is used — the brief always works.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
const db = require('../lib/db');
const aiProvider        = require('./aiProvider');
const startingPlan      = require('./startingPlan');
const emailEngine       = require('./emailEngine');
const { reportRun }     = require('./healthEngine');
const { refreshAllMarketData } = require('./marketData');

// Risk score → which categories a client should see signals from
const RISK_CATEGORY_MAP = {
  low:      ['large_cap_equity', 'large_cap_fund', 'bond_gsec', 'debt_fund', 'gold', 'index_etf'],
  moderate: ['large_cap_equity', 'large_cap_fund', 'index_etf', 'flexi_mid_fund', 'mid_cap_equity', 'gold', 'bond_gsec', 'debt_fund'],
  high:     ['large_cap_equity', 'mid_cap_equity', 'small_cap_equity', 'flexi_mid_fund', 'large_cap_fund', 'index_etf', 'gold'],
};

function riskBand(score) {
  if (score == null) return 'moderate';
  if (score <= 3) return 'low';
  if (score <= 6) return 'moderate';
  return 'high';
}

function fmtINR(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(1) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

// ─────────────────────────────────────────────────────────────────────
// SHARED SECTIONS (generated once per day, reused for all clients)
// ─────────────────────────────────────────────────────────────────────

/**
 * Nifty, Sensex and India VIX as the client sees them: level, day change, and
 * when the number was true — with an honest label when it is not live
 * ("as of <date>"), unverified (sanity check failed), or missing.
 */
function buildMarketFigures(snapshot) {
  const fmtWhen = iso => new Date(iso).toLocaleString('en-IN',
    { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const fmtDay = iso => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  const legacy = {
    nifty: snapshot?.nifty && { label: 'Nifty 50', price: snapshot.nifty.price, change_pct: snapshot.nifty.change_pct, as_of: snapshot.nifty.as_of,
                                status: snapshot.nifty.source === 'demo' || snapshot.nifty.price == null ? 'missing' : (snapshot.nifty.status || 'live'), unverified: !!snapshot.nifty.unverified },
    sensex: snapshot?.sensex && { label: 'Sensex', price: snapshot.sensex.price, change_pct: snapshot.sensex.change_pct, as_of: snapshot.sensex.as_of,
                                  status: snapshot.sensex.source === 'demo' || snapshot.sensex.price == null ? 'missing' : (snapshot.sensex.status || 'live'), unverified: !!snapshot.sensex.unverified },
    vix: { label: 'India VIX', price: snapshot?.vix ?? null, change_pct: null, as_of: snapshot?.vixAsOf || null,
           status: snapshot?.vix == null || snapshot?.vixSource === 'demo' ? 'missing' : (snapshot?.vixStatus || 'live'), unverified: false },
  };
  const src = snapshot?.indices || legacy;
  return ['nifty', 'sensex', 'vix'].map(k => {
    const x = src[k] || { label: legacy[k]?.label || k, price: null, status: 'missing' };
    const missing = x.status === 'missing' || x.price == null;
    const level = missing ? null : Number(x.price).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const chg = x.change_pct == null || missing ? null : `${x.change_pct >= 0 ? '▲' : '▼'} ${Math.abs(x.change_pct).toFixed(2)}%`;
    let note = '';
    if (missing) note = 'not available today';
    else if (x.status === 'stale') note = `not live — as of ${fmtDay(x.as_of)}`;
    else if (x.as_of) note = `as of ${fmtWhen(x.as_of)} IST`;
    if (!missing && x.unverified) note += `${note ? ' · ' : ''}unverified`;
    const line = missing ? `${x.label}: not available today` : `${x.label} ${level}${chg ? ` ${chg}` : ''} (${note})`;
    return { key: k, label: x.label, level, change: chg, change_pct: missing ? null : x.change_pct, as_of: x.as_of || null,
             status: missing ? 'missing' : x.status, unverified: !missing && !!x.unverified, note, line };
  });
}

async function buildMarketSnapshot(snapshot, aiEvents) {
  // Deterministic facts — always accurate, never AI-invented. Only figures that
  // passed the trust checks go to the AI, labelled with when they were true.
  const figures = buildMarketFigures(snapshot);
  const facts = figures.filter(f => f.status !== 'missing' && !f.unverified).map(f => f.line);
  if (!facts.length) {
    return 'Live market data could not be fetched this morning, so we are not quoting index levels rather than show numbers that may be wrong.';
  }

  const eventLine = aiEvents?.length
    ? `Our AI scan flagged ${aiEvents.length} market event${aiEvents.length > 1 ? 's' : ''} overnight: ${aiEvents.map(e => e.title).slice(0, 2).join('; ')}.`
    : null;

  // Try AI for a readable one-paragraph synthesis
  if (aiProvider.isConfigured()) {
    const prompt = `You are writing the market snapshot section of a daily brief for Indian retail investors.

FACTS (use only these, do not invent any numbers):
${facts.join('\n')}
${eventLine ? `\nAI-detected events: ${aiEvents.map(e => `${e.title} (${e.severity})`).join('; ')}` : ''}

Write 2-3 plain sentences summarising where the market stands today. Be factual and calm.
Do not give investment advice. Do not use jargon. Do not invent any numbers not listed above.
If a figure says "not live", say it is an earlier reading, not today's.

Return JSON: {"snapshot": "your text here"}`;

    const result = await aiProvider.ask(prompt, true);
    if (result?.snapshot) return result.snapshot;
  }

  // Template fallback — always works
  return [facts.join('. ') + '.', eventLine].filter(Boolean).join(' ');
}

async function buildEducationPoint() {
  // Rotating concept — deterministic list so it works without AI
  const CONCEPTS = [
    'Rupee-cost averaging means investing a fixed amount regularly regardless of price. When prices are low your money buys more units; when high, fewer. Over time this smooths out your average purchase price.',
    'An expense ratio is the annual fee a mutual fund charges, taken from your returns. A 0.5% ratio on ₹1 lakh costs ₹500 a year. Small differences compound significantly over a decade.',
    'India VIX measures expected market volatility over the next 30 days. Below 15 suggests calm; above 20 suggests fear. It often rises sharply when markets fall.',
    'Large-cap companies are the 100 largest listed firms by market value. They are generally more stable but grow slower than mid or small-caps. Most balanced portfolios hold a majority in large-caps.',
    'Long-term capital gains tax on equity applies after 12 months of holding and is lower than short-term rates. Holding a winning position past the one-year mark can meaningfully change your net return.',
    'Diversification means not concentrating your money in one instrument or sector. If one holding falls sharply, others may hold steady — reducing the damage to your overall portfolio.',
    'An emergency fund should cover 6 months of expenses and sit in liquid instruments you can access within a day. It exists so you never have to sell long-term investments at a bad time.',
    'A stop-loss is a pre-decided price at which you exit a position to limit further loss. Setting it before you invest removes emotion from the decision later.',
    'Asset allocation is how you split money across equity, debt, and gold. It matters more to long-term returns than picking individual instruments.',
    'Compounding means your returns start earning returns. ₹10,000 growing at 12% becomes ₹31,000 in 10 years — but ₹96,000 in 20 years. Time matters more than timing.',
  ];
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return CONCEPTS[dayOfYear % CONCEPTS.length];
}

// ─────────────────────────────────────────────────────────────────────
// DATES
// ─────────────────────────────────────────────────────────────────────

/** Today's date in IST (YYYY-MM-DD). brief_date is an IST calendar day. */
function istDate(now = Date.now()) {
  return require('../lib/istTime').istDate(new Date(now));
}

// ─────────────────────────────────────────────────────────────────────
// PER-CLIENT SECTIONS (computed from the client's own data, no AI call)
// ─────────────────────────────────────────────────────────────────────

const ACTION_ADVICE = {
  BUY:   'Our signal is positive. Hold it; add only within your position-size limit.',
  WATCH: 'Neutral for now. Hold it — no action needed.',
  SELL:  'Our signal has turned negative. Review this holding and consider reducing it.',
  NONE:  'We do not currently score this instrument, so there is no signal either way.',
};

const short = (t, n = 170) => {
  const x = String(t || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
};

/** Risk score lives in client_behavioural_profiles, NOT on the clients row. */
async function getRiskScore(clientId) {
  try {
    const { data } = await supabaseAdmin
      .from('client_behavioural_profiles')
      .select('stated_risk_score, effective_risk_score')
      .eq('client_id', clientId)
      .order('assessed_at', { ascending: false }).limit(1).maybeSingle();
    return data?.effective_risk_score ?? data?.stated_risk_score ?? null;
  } catch { return null; }
}

async function getHoldings(clientId) {
  try {
    const { data } = await supabaseAdmin
      .from('portfolios')
      .select('instrument_name, quantity, avg_buy_price_inr')
      .eq('client_id', clientId).eq('is_active', true);
    return data || [];
  } catch { return []; }
}

/**
 * What our current signal says about each thing the client holds, and what
 * that means for them in plain words.
 */
async function buildHoldingActions(holdings) {
  if (!holdings.length) return [];
  const symbols = holdings.map(h => h.instrument_name);
  let sigs = [];
  try {
    const { data } = await supabaseAdmin
      .from('recommendations')
      .select('instrument_name, action, stop_loss_inr, target_price_inr, entry_price_inr')
      .in('instrument_name', symbols).is('client_id', null).eq('is_active', true)
      // A stale signal is no longer our view — show "no current signal" instead.
      .gte('generated_at', new Date(Date.now() - 10 * 86400000).toISOString())
      .order('generated_at', { ascending: false });
    sigs = data || [];
  } catch {}
  const bySymbol = {};
  for (const s of sigs) if (!bySymbol[s.instrument_name]) bySymbol[s.instrument_name] = s;   // newest wins

  return holdings.map(h => {
    const s = bySymbol[h.instrument_name];
    const action = s?.action || null;
    return {
      symbol: h.instrument_name,
      action,
      advice: ACTION_ADVICE[action || 'NONE'] || ACTION_ADVICE.NONE,
      stop: s?.stop_loss_inr ?? null,
      target: s?.target_price_inr ?? null,
    };
  });
}

function buildPortfolioNote(holdings, actions) {
  if (!holdings.length) {
    return 'You have no holdings logged yet. Add your existing investments so we can track them against our signals and tell you each morning what, if anything, needs attention.';
  }
  const n = (a) => actions.filter(x => x.action === a).length;
  const none = actions.filter(x => !x.action).length;
  const parts = [`You hold ${holdings.length} instrument${holdings.length > 1 ? 's' : ''}`];
  if (n('BUY'))   parts.push(`${n('BUY')} on BUY`);
  if (n('WATCH')) parts.push(`${n('WATCH')} on WATCH`);
  if (n('SELL'))  parts.push(`${n('SELL')} on SELL — worth reviewing`);
  if (none)       parts.push(`${none} not currently scored`);
  return parts.join(', ') + '.';
}

/**
 * New ideas that fit the client's risk band and that they do not already hold.
 * BUYs first. If there are none, say so plainly — "no trade" is a valid, honest
 * answer for a capital-preservation product — and show what is closest.
 */
const ASSET_CLASS = {
  large_cap_equity: 'equity', mid_cap_equity: 'equity', small_cap_equity: 'equity',
  large_cap_fund: 'equity', flexi_mid_fund: 'equity',
  index_etf: 'etf', gold: 'gold', debt_fund: 'debt', bond_gsec: 'debt',
};
const LEVERS = ['technical', 'fundamental', 'management', 'sentiment', 'institutional', 'sector_timing', 'macro_pestle', 'competitive', 'risk_adjusted'];

/** Confidence band from the risk-adjusted lever (0–10). Client-safe: no number shown. */
const confidenceBand = s => (s == null ? null : s >= 7 ? 'High' : s >= 5 ? 'Medium' : 'Low');

/** One plain-English line from the strongest of the 9 levers, no jargon. */
function whyLine(score) {
  if (!score) return null;
  const best = LEVERS.filter(k => score[k] != null).sort((x, y) => score[y] - score[x])[0];
  if (!best) return null;
  const phrase = require('./instrumentEngine').leverPhrase(best, Number(score[best]));
  return phrase ? `Why now: ${phrase}.` : null;
}

/** Pick up to n ideas, best of each asset class first, so one class cannot crowd out the rest. */
function pickAcrossClasses(sorted, n) {
  const picked = [], seenClass = new Set();
  for (const s of sorted) {
    const c = ASSET_CLASS[s._category] || 'other';
    if (!seenClass.has(c)) { picked.push(s); seenClass.add(c); }
    if (picked.length === n) return picked;
  }
  for (const s of sorted) { if (!picked.includes(s)) picked.push(s); if (picked.length === n) break; }
  return picked;
}

/**
 * New ideas that fit the client's risk band and that they do not already hold.
 * BUYs first, drawn across equity, ETFs, gold and debt. If none qualify, says
 * why in counts ("N screened, 0 passed, main reason …") and shows the closest
 * WATCH items, clearly labelled as not a buy.
 */
async function buildIdeas(riskScore, heldSymbols, now = new Date()) {
  try {
    const allowedCats = RISK_CATEGORY_MAP[riskBand(riskScore)];
    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('*')
      .in('category', allowedCats).eq('status', 'active');
    const { priceModeOf, priceIsFresh } = require('./signalLevels');
    const screened = instruments || [];
    // A statically-priced instrument (e.g. RBI Floating Rate Bond) has no market
    // price and cannot be bought or sold on an exchange, so it is never an "idea".
    const tradeable = screened.filter(i => priceModeOf(i) !== 'static');
    if (!screened.length) return { ideas: [], note: 'Our instrument list is being refreshed.', no_ideas: null };

    const meta = Object.fromEntries(tradeable.map(i => [i.symbol, i]));
    const since = new Date(now.getTime() - 10 * 86400000).toISOString();
    const { data: sigs } = tradeable.length ? await supabaseAdmin
      .from('recommendations')
      // '*' so the brief keeps working whether or not migration 012's columns exist yet.
      .select('*')
      .in('instrument_name', Object.keys(meta))
      .is('client_id', null).eq('is_active', true)
      // Only FRESH signals. Without this, a signal from an old scoring run stayed "active"
      // forever and kept being sold as a new idea (three month-old bond BUYs were).
      .gte('generated_at', since)
      .order('generated_at', { ascending: false }).limit(300) : { data: [] };

    // Latest score per instrument: was it measured on real prices, and its levers.
    const scoreOf = {};
    try {
      const { data: scores } = await supabaseAdmin
        .from('instrument_scores').select('*')
        .in('instrument_id', tradeable.map(i => i.id)).gte('scored_at', since)
        .order('scored_at', { ascending: false }).limit(2000);
      for (const sc of scores || []) if (!scoreOf[sc.instrument_id]) scoreOf[sc.instrument_id] = sc;
    } catch (e) {
      console.warn(`   ⚠ buildIdeas: could not read scores — ${e.message}`);
    }
    const measured = id => { const sc = scoreOf[id]; return !!sc && ((sc.price_data_points || 0) > 0 || sc.data_complete === true); };

    // AI lever: instruments with an active flag carry the client-safe label only.
    const aiLabel = {};
    try {
      const { data: flags } = await supabaseAdmin.from('ai_instrument_flags')
        .select('instrument_id, horizon_label, is_active').eq('is_active', true)
        .in('instrument_id', tradeable.map(i => i.id));
      for (const f of flags || []) aiLabel[f.instrument_id] = `🤖 AI Influenced — ${f.horizon_label || 'Mid-Term'}`;
    } catch { /* table absent → no labels */ }

    const newest = {};
    for (const s of sigs || []) if (!newest[s.instrument_name]) newest[s.instrument_name] = s;   // one per instrument
    const held = new Set(heldSymbols);

    // ── Why nothing passed: client-safe counts only ──────────────────────
    const blockers = { 'price not live or not recent': screened.length - tradeable.length,
                       'not enough price history to measure': 0, 'held back by our risk checks': 0,
                       'possible gain too small for the risk': 0, 'score below our buy level': 0 };
    for (const i of tradeable) {
      const s = newest[i.symbol];
      if (!measured(i.id)) { blockers['not enough price history to measure']++; continue; }
      if (!s) { blockers['not enough price history to measure']++; continue; }
      if (s.action === 'BUY' && s.risk_gate_passed) continue;
      if (/reward:risk/.test(s.downgrade_reason || '')) blockers['possible gain too small for the risk']++;
      else if (/stale|static|unknown|no current price/.test(s.downgrade_reason || '')) blockers['price not live or not recent']++;
      else if (s.risk_gate_passed === false) blockers['held back by our risk checks']++;
      else blockers['score below our buy level']++;
    }

    const levelsTrusted = s => s.target_price_inr != null && s.stop_loss_inr != null
      && priceModeOf(meta[s.instrument_name]) !== 'static'
      && priceIsFresh(s.price_as_of, new Date(s.generated_at));
    const toIdea = s => {
      const inst = meta[s.instrument_name] || {};
      const sc = scoreOf[inst.id];
      const ok = levelsTrusted(s);
      const entry = Number(s.entry_price_inr) || null;
      const mode = priceModeOf(inst);
      return {
        symbol: s.instrument_name,
        name: inst.name || s.instrument_name,
        asset_class: ASSET_CLASS[inst.category] || 'other',
        action: s.action,
        high_conviction: s.signal_tier === 'high_conviction',
        why: whyLine(sc),
        rationale: short(s.rationale_text || s.rationale_short || '', 220),
        confidence: confidenceBand(sc?.risk_adjusted),
        ai_label: aiLabel[inst.id] || null,
        entry,
        // Entry zone: ±1% around the last traded price; a fund simply buys at the day's NAV.
        entry_zone: !ok || !entry ? null : mode === 'daily_nav' ? "at the day's NAV"
          : `₹${(entry * 0.99).toFixed(2)}–₹${(entry * 1.01).toFixed(2)}`,
        levels_ok: ok,
        target: ok ? s.target_price_inr : null,
        stop: ok ? s.stop_loss_inr : null,
        reward_risk: ok && s.reward_risk != null ? Number(s.reward_risk) : null,
        horizon_days: s.horizon_days,
      };
    };

    const usable = Object.values(newest)
      .filter(s => meta[s.instrument_name] && measured(meta[s.instrument_name].id) && !held.has(s.instrument_name))
      .map(s => ({ ...s, _category: meta[s.instrument_name].category }))
      .sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0));

    const buys = pickAcrossClasses(usable.filter(s => s.action === 'BUY' && s.risk_gate_passed), 3).map(toIdea);
    if (buys.length) return { ideas: buys, note: null, no_ideas: null };

    const top = Object.entries(blockers).sort((x, y) => y[1] - x[1])[0];
    const no_ideas = {
      screened: screened.length, passed: 0,
      top_blocker: top && top[1] > 0 ? top[0] : null, top_blocker_count: top ? top[1] : 0,
      blockers,
      text: `${screened.length} instruments screened for your profile, 0 passed all our checks today.` +
            (top && top[1] > 0 ? ` Main reason: ${top[0]} (${top[1]}).` : ''),
    };
    if (!usable.length) {
      return { ideas: [], no_ideas,
        note: 'No ideas today. Our weekly analysis has not completed with live price data, and we would rather say nothing than suggest something we have not properly measured.' };
    }
    const radar = pickAcrossClasses(usable.filter(s => s.action === 'WATCH'), 3).map(toIdea);
    return {
      ideas: radar, no_ideas,
      note: 'No new BUY signals pass our risk checks for your profile today. Waiting is a valid position — we only ask you to act when the evidence is strong.' +
            (radar.length ? ' These are on our watchlist — not a recommendation to buy yet:' : ''),
    };
  } catch (e) {
    console.warn(`   ⚠ buildIdeas: ${e.message}`);
    return { ideas: [], note: null, no_ideas: null };
  }
}

/** Builder and Wealth Builder include opportunities (min_tier in the opportunities table). */
const TIER_RANK = { starter: 1, builder: 2, wealth_builder: 3 };
async function buildOpportunities(plan) {
  try {
    const { data } = await supabaseAdmin.from('opportunities')
      .select('symbol, instrument_name, headline, detail, min_tier, expires_at')
      .eq('is_active', true).order('generated_at', { ascending: false }).limit(10);
    const rank = TIER_RANK[plan] || 0;
    return (data || [])
      .filter(o => rank >= (TIER_RANK[o.min_tier] || 2))
      .filter(o => !o.expires_at || new Date(o.expires_at) > new Date())
      .slice(0, 3)
      .map(o => ({ symbol: o.symbol, name: o.instrument_name, headline: short(o.headline, 140), detail: short(o.detail, 200) }));
  } catch { return []; }
}

async function buildNews() {
  try {
    const { data } = await supabaseAdmin
      .from('ai_events')
      .select('title, severity, description, horizon_label, detected_at')
      .eq('status', 'active')
      .gte('detected_at', new Date(Date.now() - 72 * 3600 * 1000).toISOString())
      .order('detected_at', { ascending: false }).limit(5);
    return (data || []).map(e => ({
      title: e.title, severity: e.severity, summary: short(e.description), horizon: e.horizon_label || null,
    }));
  } catch { return []; }
}

async function buildGoalNote(clientId) {
  try {
    const { data: goals } = await supabaseAdmin
      .from('client_goals')
      .select('goal_name, target_amount_inr, current_corpus_inr, target_date')
      .eq('client_id', clientId).eq('is_active', true);
    if (!goals?.length) return null;
    return goals.slice(0, 6).map(g => {
      const current = g.current_corpus_inr || 0, target = g.target_amount_inr || 0;
      const pct = target > 0 ? (current / target) * 100 : 0;
      return `${g.goal_name}: ${fmtINR(current)} of ${fmtINR(target)} (${pct.toFixed(0)}%)`;
    }).join('. ') + '.';
  } catch { return null; }
}

function decideTodayAction(holdings, actions, ideas) {
  const sells = actions.filter(a => a.action === 'SELL');
  if (sells.length) return `Review ${sells.map(s => s.symbol).join(', ')} — our signal on ${sells.length > 1 ? 'them has' : 'it has'} turned negative.`;
  if (ideas.length && ideas[0].action === 'BUY') {
    return `${ideas.length} new BUY idea${ideas.length > 1 ? 's fit' : ' fits'} your profile (${ideas.map(i => i.symbol).join(', ')}). Size any position within your limits and set the stop-loss first.`;
  }
  if (!holdings.length) return 'Add your holdings so we can track them and tell you each morning what needs attention.';
  return 'No action needed today. Your holdings are on BUY or WATCH and nothing new meets our bar.';
}

// ─────────────────────────────────────────────────────────────────────
// SHARED SECTIONS — built once, reused for every client
// ─────────────────────────────────────────────────────────────────────

const SHARED_TTL_MS = 60 * 60 * 1000;
let _shared = null;   // { key, at, promise }

/**
 * Market snapshot, news and the education point are the same for everyone, so
 * they are built once and memoised for an hour. That is what makes it safe to
 * build a brief on demand when a client logs in: ten logins cost one AI call,
 * not ten, and a free-tier key is not burned through.
 */
function getSharedSections({ force = false } = {}) {
  const key = istDate();
  if (!force && _shared && _shared.key === key && Date.now() - _shared.at < SHARED_TTL_MS) return _shared.promise;
  const promise = (async () => {
    const snapshot = await refreshAllMarketData();
    const news = await buildNews();
    const marketSnapshot = await buildMarketSnapshot(snapshot, news);
    const marketFigures = buildMarketFigures(snapshot);
    let trackRecord = null;
    try { trackRecord = await require('./trackRecordSummary').getTrackRecordSummary(); } catch (e) { console.warn(`   ⚠ track record summary: ${e.message}`); }
    return { marketSnapshot, marketFigures, news, trackRecord, educationPoint: await buildEducationPoint(), dataNotes: [] };
  })();
  _shared = { key, at: Date.now(), promise };
  promise.catch(() => { if (_shared && _shared.promise === promise) _shared = null; });
  return promise;
}

// ─────────────────────────────────────────────────────────────────────
// ONE CLIENT'S BRIEF
// ─────────────────────────────────────────────────────────────────────

/** Panic history lives on the behavioural profile; it lowers the equity cap. */
async function getPanicHistory(clientId) {
  try {
    const { data } = await supabaseAdmin.from('client_behavioural_profiles')
      .select('panic_history').eq('client_id', clientId)
      .order('assessed_at', { ascending: false }).limit(1).maybeSingle();
    return !!data?.panic_history;
  } catch { return false; }
}

async function getGoals(clientId) {
  try {
    const { data } = await supabaseAdmin.from('client_goals')
      .select('goal_name, goal_type, target_amount_inr, current_corpus_inr, target_date')
      .eq('client_id', clientId).eq('is_active', true);
    return data || [];
  } catch { return []; }
}

/**
 * Every tradeable instrument with what we know about it: was its latest score
 * measured on real price data, and what is our current signal. Shared by all
 * clients, so cached for an hour like the other shared sections.
 */
let _pool = null;
async function getInstrumentPool() {
  if (_pool && Date.now() - _pool.at < SHARED_TTL_MS) return _pool.rows;
  const since = new Date(Date.now() - 10 * 86400000).toISOString();
  const { data: inst } = await supabaseAdmin.from('instrument_universe')
    .select('id, symbol, name, category, instrument_type, price_source').eq('status', 'active');
  const tradeable = (inst || []).filter(i => !['static', 'static_reference'].includes(i.price_source));
  const ids = tradeable.map(i => i.id);
  const { data: scores } = await supabaseAdmin.from('instrument_scores')
    .select('instrument_id, scored_at, price_data_points, data_complete')
    .in('instrument_id', ids).gte('scored_at', since)
    .order('scored_at', { ascending: false }).limit(2000);
  const measured = new Set(), seen = new Set();
  for (const sc of scores || []) {
    if (seen.has(sc.instrument_id)) continue;
    seen.add(sc.instrument_id);
    if ((sc.price_data_points || 0) > 0 || sc.data_complete === true) measured.add(sc.instrument_id);
  }
  const { data: sigs } = await supabaseAdmin.from('recommendations')
    .select('instrument_name, action, confidence_score, generated_at')
    .in('instrument_name', tradeable.map(i => i.symbol))
    .is('client_id', null).eq('is_active', true).gte('generated_at', since)
    .order('generated_at', { ascending: false }).limit(1000);
  const sig = {};
  for (const r of sigs || []) if (!sig[r.instrument_name]) sig[r.instrument_name] = r;
  const rows = tradeable.map(i => ({
    symbol: i.symbol, name: i.name, category: i.category, instrument_type: i.instrument_type,
    measured: measured.has(i.id), action: sig[i.symbol]?.action || null,
    confidence: Number(sig[i.symbol]?.confidence_score) || 0,
  }));
  _pool = { at: Date.now(), rows };
  return rows;
}

async function buildStartingPlanForClient(clientId, riskScore) {
  try {
    const [panicHistory, goals, pool] = await Promise.all([getPanicHistory(clientId), getGoals(clientId), getInstrumentPool()]);
    return startingPlan.buildStartingPlan({ riskScore, panicHistory, goals, pool });
  } catch (e) {
    console.warn(`   ⚠ starting plan: ${e.message}`);
    return null;
  }
}

async function buildBriefForClient(client, shared) {
  const [riskScore, holdings, goalNote] = await Promise.all([
    getRiskScore(client.id), getHoldings(client.id), buildGoalNote(client.id),
  ]);
  const actions = await buildHoldingActions(holdings);
  const { ideas, note: ideasNote, no_ideas: noIdeas } = await buildIdeas(riskScore, holdings.map(h => h.instrument_name));
  // Tier: only what the code already defines — opportunities carry min_tier 'builder'.
  const tierPlan = require('../lib/entitlements').entitlementFromRow(client).plan;
  const opportunities = await buildOpportunities(tierPlan);
  const portfolioNote = buildPortfolioNote(holdings, actions);
  // A client with nothing logged gets a starting plan built from their profile and goals.
  const plan = holdings.length ? null : await buildStartingPlanForClient(client.id, riskScore);
  const todayAction = plan
    ? 'Your starting plan is below — monthly amounts for each goal and where to put them. Add what you buy as holdings and we will track it every morning.'
    : decideTodayAction(holdings, actions, ideas);

  const brief = {
    market_snapshot: shared.marketSnapshot,
    market_figures:  shared.marketFigures || [],
    news:            shared.news,
    today_action:    todayAction,
    portfolio_note:  portfolioNote,
    holding_actions: actions,
    ideas,
    ideas_note:      ideasNote,
    no_ideas:        noIdeas,
    opportunities,
    track_record:    shared.trackRecord || null,
    top_signals:     ideas.map(i => ({ symbol: i.symbol, action: i.action, rationale: i.rationale })),
    goal_note:       goalNote,
    starting_plan:   plan,
    education_point: shared.educationPoint,
  };

  const today = istDate();
  brief.full_text = [
    `WealthGuard Morning Brief — ${today}`,
    '',
    `TODAY: ${todayAction}`,
    '',
    'MARKET SNAPSHOT', ...(shared.marketFigures || []).map(f => `• ${f.line}`), shared.marketSnapshot,
    shared.news.length ? `\nIN THE NEWS\n${shared.news.map(n => `• ${n.title}${n.severity ? ` (${n.severity})` : ''}`).join('\n')}` : '',
    `\nYOUR PORTFOLIO\n${portfolioNote}`,
    plan ? `\nYOUR STARTING PLAN\n${startingPlan.planToText(plan)}` : '',
    actions.length ? actions.map(a => `• ${a.symbol} — ${a.action || 'no signal'}: ${a.advice}`).join('\n') : '',
    ideas.length || ideasNote ? `\nIDEAS WORTH A LOOK${ideasNote ? `\n${ideasNote}` : ''}` : '',
    ideas.length ? ideas.map(i => [
      `• ${i.symbol} (${i.action === 'WATCH' ? 'watching — not a buy yet' : i.action})${i.ai_label ? ` ${i.ai_label}` : ''}${i.confidence ? ` · confidence ${i.confidence}` : ''}`,
      i.why ? `  ${i.why}` : '',
      i.levels_ok ? `  Entry ${i.entry_zone || `~₹${i.entry}`}, target ₹${i.target}, stop-loss ₹${i.stop}, reward:risk ${Number(i.reward_risk).toFixed(1)}, ${i.horizon_days}-day view` : '',
    ].filter(Boolean).join('\n')).join('\n') : '',
    noIdeas ? `WHY NO NEW IDEAS TODAY\n${noIdeas.text}` : '',
    opportunities.length ? `\nOPPORTUNITIES\n${opportunities.map(o => `• ${o.headline}`).join('\n')}` : '',
    shared.trackRecord ? `\nOUR TRACK RECORD\n${shared.trackRecord.text}` : '',
    goalNote ? `\nYOUR GOALS\n${goalNote}` : '',
    `\nLEARN SOMETHING TODAY\n${shared.educationPoint}`,
    '\nNot investment advice. WealthGuard is not a SEBI-registered investment adviser.',
  ].filter(x => x !== '').join('\n');

  return brief;
}

/** Writes the brief. brief_json is optional so a not-yet-migrated DB still works. */
async function persistBrief(client, brief) {
  const row = {
    client_id:        client.id,
    brief_date:       istDate(),
    market_snapshot:  brief.market_snapshot,
    portfolio_note:   brief.portfolio_note,
    top_signals:      brief.top_signals,
    goal_note:        brief.goal_note,
    education_point:  brief.education_point,
    full_text:        brief.full_text,
    whatsapp_message: brief.full_text,     // the column the in-app tab already reads
    ai_provider:      aiProvider.isConfigured() ? 'ai' : 'template',
    brief_json:       { ...brief, generated_at: new Date().toISOString() },
  };
  const r = await db.writeTolerant('morning_briefs', 'upsert', row, ['brief_json'],
    { onConflict: 'client_id,brief_date' });
  return { ok: r.ok, row };
}

/**
 * Builds (and stores) today's brief for ONE client, on demand. Used when a
 * client opens the app and their 7:30 brief does not exist yet — a client who
 * registered after 7:30, or a morning the scheduler missed, now gets a brief
 * instead of "arrives tomorrow". Does not send email.
 */
async function generateBriefForClient(clientId) {
  if (!supabaseAdmin) return null;
  const { data: client } = await supabaseAdmin.from('clients').select('*').eq('id', clientId).maybeSingle();
  if (!client) return null;
  const shared = await getSharedSections();
  const brief = await buildBriefForClient(client, shared);
  const { row } = await persistBrief(client, brief);
  return row;
}

// ─────────────────────────────────────────────────────────────────────
// MAIN ENGINE (07:30 IST, Mon–Fri)
// ─────────────────────────────────────────────────────────────────────

/**
 * Builds today's briefs and emails them — once per client per IST day, between
 * 07:30 and 12:00 IST. All the rules live in briefDelivery.js; every trigger
 * (cron, catch-up, GitHub job, admin) comes through here.
 */
async function generateAndSendMorningBrief(opts = {}) {
  if (!supabaseAdmin) {
    console.log('📰 Morning brief: Supabase not configured, skipping.');
    return { status: 'no_database' };
  }
  return require('./briefDelivery').deliverMorningBriefs(opts);
}

module.exports = { generateAndSendMorningBrief, generateBriefForClient, buildBriefForClient, persistBrief, getSharedSections, istDate, _test: { buildMarketSnapshot, buildMarketFigures, buildIdeas, pickAcrossClasses, whyLine, confidenceBand } };
