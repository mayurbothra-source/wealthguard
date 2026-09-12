/**
 * WealthGuard Morning Brief Engine
 *
 * Runs Mon–Fri at 7:30 AM IST. Generates a personalised brief for every
 * active client and emails it.
 *
 * Five sections per brief:
 *   1. Market snapshot    — Nifty, VIX regime, overnight AI-detected events
 *   2. Portfolio update   — how each held instrument moved vs our signal
 *   3. Top signals today  — filtered to the client's risk profile
 *   4. Goal progress      — SIP pace vs target for each active goal
 *   5. Education point    — rotating concept explanation
 *
 * AI usage:
 *   Sections 1 and 5 are AI-generated once per day and SHARED across all
 *   clients (they are not client-specific). This means 2 AI calls per day
 *   total, not 2 per client — the cost stays flat as the client base grows.
 *
 *   Sections 2, 3 and 4 are computed directly from the client's own data with
 *   no AI call at all. They are already personal; AI would add nothing.
 *
 *   If AI is unavailable, a deterministic template fallback produces a fully
 *   usable brief from live market data. The brief always goes out.
 */

'use strict';

const { supabaseAdmin } = require('../../config/supabase');
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
  if (nifty?.price != null) {
    const dir = (nifty.change_pct ?? 0) >= 0 ? 'up' : 'down';
    facts.push(`Nifty 50 closed ${dir} ${Math.abs(nifty.change_pct ?? 0).toFixed(2)}% at ${nifty.price.toLocaleString('en-IN')}`);
  }
  if (vix != null) {
    facts.push(`India VIX is at ${Number(vix).toFixed(1)} (${regime?.regime || 'normal'})`);
  }
  if (snapshot?.sensex?.price != null) {
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
// PER-CLIENT SECTIONS (computed, no AI needed)
// ─────────────────────────────────────────────────────────────────────

async function buildPortfolioNote(client) {
  if (!supabaseAdmin) return null;
  try {
    const { data: holdings } = await supabaseAdmin
      .from('portfolio_holdings')
      .select('instrument_name, quantity, avg_buy_price_inr')
      .eq('client_id', client.id)
      .eq('is_active', true);

    if (!holdings?.length) {
      return 'You have no holdings logged yet. Adding your existing investments lets us track them against our signals and alert you to material moves.';
    }

    // Fetch current signals for held instruments
    const names = holdings.map(h => h.instrument_name);
    const { data: signals } = await supabaseAdmin
      .from('recommendations')
      .select('instrument_name, action')
      .in('instrument_name', names)
      .is('client_id', null)
      .eq('is_active', true);

    const sigMap = {};
    (signals || []).forEach(s => { sigMap[s.instrument_name] = s.action; });

    const buys   = holdings.filter(h => sigMap[h.instrument_name] === 'BUY').length;
    const sells  = holdings.filter(h => sigMap[h.instrument_name] === 'SELL').length;
    const watch  = holdings.length - buys - sells;

    const parts = [`You hold ${holdings.length} instrument${holdings.length > 1 ? 's' : ''}.`];
    if (buys)  parts.push(`${buys} on BUY`);
    if (watch) parts.push(`${watch} on WATCH`);
    if (sells) parts.push(`${sells} on SELL — worth reviewing`);
    return parts.join(' ') + '.';
  } catch {
    return null;
  }
}

async function buildTopSignals(client) {
  if (!supabaseAdmin) return [];
  try {
    const band = riskBand(client.stated_risk_score);
    const allowedCats = RISK_CATEGORY_MAP[band];

    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('symbol, name, category')
      .in('category', allowedCats)
      .eq('status', 'active');

    if (!instruments?.length) return [];
    const symbols = instruments.map(i => i.symbol);

    const { data: signals } = await supabaseAdmin
      .from('recommendations')
      .select('instrument_name, action, confidence_score, rationale_short')
      .in('instrument_name', symbols)
      .is('client_id', null)
      .eq('is_active', true)
      .order('confidence_score', { ascending: false })
      .limit(3);

    return (signals || []).map(s => ({
      symbol:    s.instrument_name,
      action:    s.action,
      rationale: s.rationale_short || '',
    }));
  } catch {
    return [];
  }
}

async function buildGoalNote(client) {
  if (!supabaseAdmin) return null;
  try {
    const { data: goals } = await supabaseAdmin
      .from('client_goals')
      .select('goal_name, target_amount_inr, current_corpus_inr, target_date')
      .eq('client_id', client.id);

    if (!goals?.length) return null;

    const lines = goals.slice(0, 2).map(g => {
      const current = g.current_corpus_inr || 0;
      const target  = g.target_amount_inr  || 0;
      const pct     = target > 0 ? (current / target) * 100 : 0;
      return `${g.goal_name}: ${fmtINR(current)} of ${fmtINR(target)} (${pct.toFixed(0)}%)`;
    });
    return lines.join('. ') + '.';
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────

async function generateAndSendMorningBrief() {
  if (!supabaseAdmin) {
    console.log('📰 Morning brief: Supabase not configured, skipping.');
    return;
  }

  const start = Date.now();
  console.log('📰 Generating morning briefs...');

  const today = new Date().toISOString().split('T')[0];
  let sent = 0, skipped = 0, failed = 0;

  try {
    // ── Shared data — fetched once, reused for every client ──────────
    const snapshot = await refreshAllMarketData();

    const { data: aiEvents } = await supabaseAdmin
      .from('ai_events')
      .select('title, severity')
      .eq('status', 'active')
      .gte('detected_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .limit(3);

    const marketSnapshot = await buildMarketSnapshot(snapshot, aiEvents);
    const educationPoint = await buildEducationPoint();

    console.log(`   Shared sections built (AI calls used: ${aiProvider.getUsage().google + aiProvider.getUsage().anthropic})`);

    // ── Per-client briefs ─────────────────────────────────────────────
    const { data: clients } = await supabaseAdmin
      .from('clients')
      .select('*')
      .in('subscription_status', ['active', 'trial'])
      .eq('onboarding_complete', true);

    if (!clients?.length) {
      console.log('📰 No active clients to brief.');
      await reportRun({
        engineName: 'morningBriefEngine', durationMs: Date.now() - start,
        itemsProcessed: 0, itemsExpected: 0,
      });
      return;
    }

    for (const client of clients) {
      try {
        const [portfolioNote, topSignals, goalNote] = await Promise.all([
          buildPortfolioNote(client),
          buildTopSignals(client),
          buildGoalNote(client),
        ]);

        const brief = {
          market_snapshot: marketSnapshot,
          portfolio_note:  portfolioNote,
          top_signals:     topSignals,
          goal_note:       goalNote,
          education_point: educationPoint,
        };

        // Plain-text version for email clients that block HTML
        brief.full_text = [
          `WealthGuard Morning Brief — ${today}`,
          '',
          'MARKET SNAPSHOT', marketSnapshot,
          portfolioNote ? `\nYOUR PORTFOLIO\n${portfolioNote}` : '',
          topSignals.length ? `\nTODAY'S SIGNALS\n${topSignals.map(s => `${s.symbol}: ${s.action}`).join('\n')}` : '',
          goalNote ? `\nYOUR GOALS\n${goalNote}` : '',
          `\nLEARN SOMETHING TODAY\n${educationPoint}`,
        ].filter(Boolean).join('\n');

        // Persist the brief (idempotent per client per day)
        await supabaseAdmin.from('morning_briefs').upsert({
          client_id:       client.id,
          brief_date:      today,
          market_snapshot: marketSnapshot,
          portfolio_note:  portfolioNote,
          top_signals:     topSignals,
          goal_note:       goalNote,
          education_point: educationPoint,
          full_text:       brief.full_text,
          ai_provider:     aiProvider.isConfigured() ? 'ai' : 'template',
          created_at:      new Date().toISOString(),
        }, { onConflict: 'client_id,brief_date' });

        // Email it
        const emailed = await emailEngine.sendMorningBrief(client, brief);
        if (emailed) {
          sent++;
          await supabaseAdmin.from('morning_briefs')
            .update({ email_sent: true, email_sent_at: new Date().toISOString() })
            .eq('client_id', client.id).eq('brief_date', today);
          await supabaseAdmin.from('clients')
            .update({ last_brief_sent_at: new Date().toISOString() })
            .eq('id', client.id);
        } else {
          skipped++;
        }

      } catch (e) {
        console.error(`   ❌ Brief failed for client ${client.id}: ${e.message}`);
        failed++;
      }
    }

    const duration = Date.now() - start;
    console.log(`📰 Morning briefs complete: ${sent} emailed, ${skipped} skipped (no email/opted out), ${failed} failed.`);

    await reportRun({
      engineName:     'morningBriefEngine',
      durationMs:     duration,
      itemsProcessed: sent + skipped,
      itemsExpected:  clients.length,
      itemsFailed:    failed,
      detail:         `${sent} emailed, ${skipped} skipped, AI provider: ${JSON.stringify(aiProvider.getUsage())}`,
    });

  } catch (e) {
    console.error('📰 Morning brief engine error:', e.message);
    await reportRun({
      engineName: 'morningBriefEngine', durationMs: Date.now() - start,
      itemsProcessed: sent, itemsExpected: 1, itemsFailed: failed + 1, detail: e.message,
    });
  }
}

module.exports = { generateAndSendMorningBrief };
