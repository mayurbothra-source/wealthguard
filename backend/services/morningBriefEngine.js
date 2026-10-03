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

async function buildMarketSnapshot(snapshot, aiEvents) {
  const nifty = snapshot?.nifty;
  const vix   = snapshot?.vix;
  const regime = snapshot?.vixRegime;

  // Deterministic facts — always accurate, never AI-invented
  const facts = [];
  // Values tagged source:'demo' are placeholders, not market data. They are
  // never presented to a client as fact.
  if (nifty?.price != null && nifty.source !== 'demo') {
    const dir = (nifty.change_pct ?? 0) >= 0 ? 'up' : 'down';
    facts.push(`Nifty 50 is ${dir} ${Math.abs(nifty.change_pct ?? 0).toFixed(2)}% at ${nifty.price.toLocaleString('en-IN')}`);
  } else {
    facts.push('Live index data was unavailable when this brief was prepared');
  }
  if (vix != null) {
    facts.push(`India VIX is at ${Number(vix).toFixed(1)} (${regime?.regime || 'normal'})`);
  }
  if (snapshot?.sensex?.price != null && snapshot.sensex.source !== 'demo') {
    facts.push(`Sensex at ${snapshot.sensex.price.toLocaleString('en-IN')}`);
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
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
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
async function buildIdeas(riskScore, heldSymbols) {
  try {
    const allowedCats = RISK_CATEGORY_MAP[riskBand(riskScore)];
    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('symbol, name, category')
      .in('category', allowedCats).eq('status', 'active');
    if (!instruments?.length) return { ideas: [], note: 'Our instrument list is being refreshed.' };

    const meta = Object.fromEntries(instruments.map(i => [i.symbol, i]));
    const { data: sigs } = await supabaseAdmin
      .from('recommendations')
      .select('instrument_name, action, confidence_score, signal_tier, rationale_short, entry_price_inr, target_price_inr, stop_loss_inr, horizon_days')
      .in('instrument_name', Object.keys(meta))
      .is('client_id', null).eq('is_active', true).eq('risk_gate_passed', true)
      .order('confidence_score', { ascending: false }).limit(60);

    const held = new Set(heldSymbols);
    const toIdea = s => ({
      symbol: s.instrument_name,
      name: meta[s.instrument_name]?.name || s.instrument_name,
      action: s.action,
      high_conviction: s.signal_tier === 'high_conviction',
      rationale: s.rationale_short || '',
      entry: s.entry_price_inr, target: s.target_price_inr, stop: s.stop_loss_inr,
      horizon_days: s.horizon_days,
    });

    const buys = (sigs || []).filter(s => s.action === 'BUY' && !held.has(s.instrument_name)).slice(0, 3).map(toIdea);
    if (buys.length) return { ideas: buys, note: null };

    const radar = (sigs || []).filter(s => s.action === 'WATCH' && !held.has(s.instrument_name)).slice(0, 3).map(toIdea);
    return {
      ideas: radar,
      note: 'No new BUY signals pass our risk checks for your profile today. Waiting is a valid position — we only ask you to act when the evidence is strong.' +
            (radar.length ? ' These are closest to qualifying:' : ''),
    };
  } catch (e) {
    console.warn(`   ⚠ buildIdeas: ${e.message}`);
    return { ideas: [], note: null };
  }
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
    return goals.slice(0, 2).map(g => {
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
    return { marketSnapshot, news, educationPoint: await buildEducationPoint(), dataNotes: [] };
  })();
  _shared = { key, at: Date.now(), promise };
  promise.catch(() => { if (_shared && _shared.promise === promise) _shared = null; });
  return promise;
}

// ─────────────────────────────────────────────────────────────────────
// ONE CLIENT'S BRIEF
// ─────────────────────────────────────────────────────────────────────

async function buildBriefForClient(client, shared) {
  const [riskScore, holdings, goalNote] = await Promise.all([
    getRiskScore(client.id), getHoldings(client.id), buildGoalNote(client.id),
  ]);
  const actions = await buildHoldingActions(holdings);
  const { ideas, note: ideasNote } = await buildIdeas(riskScore, holdings.map(h => h.instrument_name));
  const portfolioNote = buildPortfolioNote(holdings, actions);
  const todayAction = decideTodayAction(holdings, actions, ideas);

  const brief = {
    market_snapshot: shared.marketSnapshot,
    news:            shared.news,
    today_action:    todayAction,
    portfolio_note:  portfolioNote,
    holding_actions: actions,
    ideas,
    ideas_note:      ideasNote,
    top_signals:     ideas.map(i => ({ symbol: i.symbol, action: i.action, rationale: i.rationale })),
    goal_note:       goalNote,
    education_point: shared.educationPoint,
  };

  const today = istDate();
  brief.full_text = [
    `WealthGuard Morning Brief — ${today}`,
    '',
    `TODAY: ${todayAction}`,
    '',
    'MARKET SNAPSHOT', shared.marketSnapshot,
    shared.news.length ? `\nIN THE NEWS\n${shared.news.map(n => `• ${n.title}${n.severity ? ` (${n.severity})` : ''}`).join('\n')}` : '',
    `\nYOUR PORTFOLIO\n${portfolioNote}`,
    actions.length ? actions.map(a => `• ${a.symbol} — ${a.action || 'no signal'}: ${a.advice}`).join('\n') : '',
    ideas.length || ideasNote ? `\nIDEAS WORTH A LOOK${ideasNote ? `\n${ideasNote}` : ''}` : '',
    ideas.length ? ideas.map(i => `• ${i.symbol} (${i.action})${i.entry ? ` entry ~₹${i.entry}` : ''}${i.target ? `, target ₹${i.target}` : ''}${i.stop ? `, stop-loss ₹${i.stop}` : ''}`).join('\n') : '',
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

async function generateAndSendMorningBrief() {
  if (!supabaseAdmin) {
    console.log('📰 Morning brief: Supabase not configured, skipping.');
    return;
  }

  const start = Date.now();
  console.log('📰 Generating morning briefs...');
  let sent = 0, skipped = 0, failed = 0, stored = 0;

  try {
    const shared = await getSharedSections({ force: true });
    console.log(`   Shared sections built (AI calls used: ${aiProvider.getUsage().google + aiProvider.getUsage().anthropic})`);

    // EVERY client gets an in-app brief. This used to select only clients with
    // onboarding_complete = true — a flag nothing ever set — so no brief was
    // ever generated for anyone. Whether it is also EMAILED depends on having an
    // address and an active/trial subscription.
    const { data: clients } = await supabaseAdmin.from('clients').select('*').limit(5000);

    if (!clients?.length) {
      console.log('📰 No clients to brief.');
      await reportRun({ engineName: 'morningBriefEngine', durationMs: Date.now() - start, itemsProcessed: 0, itemsExpected: 0 });
      return;
    }

    for (const client of clients) {
      try {
        const brief = await buildBriefForClient(client, shared);
        const { ok } = await persistBrief(client, brief);
        if (ok) stored++;
        else console.warn(`   ⚠ Brief for ${client.full_name || client.id} could not be stored (run migration 002/006).`);

        const emailable = ['active', 'trial'].includes(client.subscription_status);
        const emailed = emailable ? await emailEngine.sendMorningBrief(client, brief) : false;
        if (emailed) {
          sent++;
          const today = istDate();
          await db.tryWrite('morning_briefs', 'update', c =>
            c.from('morning_briefs').update({ email_sent: true, email_sent_at: new Date().toISOString() })
              .eq('client_id', client.id).eq('brief_date', today));
          await db.tryWrite('clients', 'update', c =>
            c.from('clients').update({ last_brief_sent_at: new Date().toISOString() }).eq('id', client.id));
        } else {
          skipped++;
        }
      } catch (e) {
        console.error(`   ❌ Brief failed for client ${client.id}: ${e.message}`);
        failed++;
      }
    }

    console.log(`📰 Morning briefs complete: ${stored} stored, ${sent} emailed, ${skipped} not emailed, ${failed} failed.`);
    await reportRun({
      engineName: 'morningBriefEngine', durationMs: Date.now() - start,
      itemsProcessed: stored, itemsExpected: clients.length, itemsFailed: failed,
      detail: `${stored} stored, ${sent} emailed, ${skipped} not emailed, AI: ${JSON.stringify(aiProvider.getUsage())}`,
    });
  } catch (e) {
    console.error('📰 Morning brief engine error:', e.message);
    await reportRun({
      engineName: 'morningBriefEngine', durationMs: Date.now() - start,
      itemsProcessed: stored, itemsExpected: 1, itemsFailed: failed + 1, detail: e.message,
    });
  }
}

module.exports = { generateAndSendMorningBrief, generateBriefForClient, buildBriefForClient, istDate };
