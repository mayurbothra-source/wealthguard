/**
 * WealthGuard AI Lever Engine (10th Lever)
 * Three-depth probabilistic reasoning engine.
 *
 * Depth 1: Event detection via Google News RSS + Gemini classification
 * Depth 2: Historical analogue matching + probability estimation
 * Depth 3: Company/fund-specific positioning analysis from public sources
 *
 * Requires: GOOGLE_API_KEY in environment variables (Gemini free tier)
 * Free tier: 1,500 Gemini requests/day — well within daily scan budget
 */

const axios       = require('axios');
const { supabaseAdmin } = require('../../config/supabase');
const aiProvider  = require('./aiProvider');
const { reportRun } = require('./healthEngine');

// Model selection and provider fallback are handled entirely by aiProvider.
// It auto-discovers the current Google model name (immune to Google's
// frequent renames) and falls back to Anthropic if Google is unavailable.

// ── SECTOR MAPPING ────────────────────────────────────────────
// Maps real-world event keywords to instrument_universe categories.
const SECTOR_MAP = {
  'oil|crude|petroleum|opec|refinery': ['large_cap_equity','mid_cap_equity','small_cap_equity'],
  'gold|silver|precious metal|safe haven': ['gold'],
  'rupee|usd|inr|dollar|forex|rbi rate|repo': ['bond_gsec','debt_fund','large_cap_equity'],
  'inflation|cpi|wpi|consumer price': ['bond_gsec','debt_fund','large_cap_fund'],
  'bank|nbfc|credit|npa|lending': ['large_cap_equity','mid_cap_equity'],
  'it|software|tech|ai|outsourcing': ['large_cap_equity','mid_cap_equity','large_cap_fund'],
  'pharma|drug|fda|healthcare': ['large_cap_equity','mid_cap_equity'],
  'fmcg|consumer|retail': ['large_cap_equity','large_cap_fund'],
  'infra|construction|roads|capex': ['mid_cap_equity','small_cap_equity'],
  'sebi|regulation|mutual fund|amfi': ['large_cap_fund','flexi_mid_fund','debt_fund','index_etf'],
  'budget|tax|fiscal|government': ['large_cap_equity','large_cap_fund','bond_gsec'],
  'war|conflict|geopolitic|sanction': ['gold','large_cap_equity','bond_gsec'],
  'market|nifty|sensex|crash|rally': ['index_etf','large_cap_fund','large_cap_equity'],
};

// ── HORIZON CLASSIFICATION ────────────────────────────────────
function classifyHorizon(days) {
  if (days <= 30)  return { label: 'Short-Term', days };
  if (days <= 90)  return { label: 'Mid-Term',   days };
  return               { label: 'Long-Term',  days };
}

// ── GEMINI HELPER ─────────────────────────────────────────────
async function askGemini(prompt, expectJSON = true) {
  const result = await aiProvider.ask(prompt, expectJSON);
  if (result === null) throw new Error('All AI providers unavailable');
  return result;
}

// ── DEPTH 1: EVENT DETECTION ──────────────────────────────────
/**
 * Fetch Google News RSS for Indian markets — completely free, no API key.
 */
async function fetchNewsRSS(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const { data } = await axios.get(url, { timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WealthGuard/1.0)' }
    });
    // Simple RSS item extraction without xml parser dependency
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(data)) !== null && items.length < 15) {
      const itemXML = match[1];
      const title   = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(itemXML) ||
                       /<title>(.*?)<\/title>/.exec(itemXML))?.[1] || '';
      const link    = (/<link>(.*?)<\/link>/.exec(itemXML))?.[1] || '';
      const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(itemXML))?.[1] || '';
      if (title) items.push({ title: title.trim(), link: link.trim(), pubDate });
    }
    return items;
  } catch (e) {
    console.warn(`   RSS fetch failed for "${query}":`, e.message);
    return [];
  }
}

async function gatherMarketNews() {
  const [indiaMarket, regulatory, global, sectoral] = await Promise.all([
    fetchNewsRSS('Indian stock market economy Nifty Sensex'),
    fetchNewsRSS('RBI SEBI budget India regulation 2026'),
    fetchNewsRSS('global economy oil gold war geopolitical India impact'),
    fetchNewsRSS('earnings India quarterly results corporate announcement'),
  ]);
  return [...indiaMarket, ...regulatory, ...global, ...sectoral]
    .filter((item, idx, arr) => arr.findIndex(i => i.title === item.title) === idx)
    .slice(0, 50); // deduplicated, max 50 items
}

async function detectEventsFromNews(newsItems) {
  if (!newsItems.length) return [];
  const headlines = newsItems.map((n, i) => `${i+1}. ${n.title}`).join('\n');
  const sourceMap = Object.fromEntries(newsItems.map((n, i) => [i+1, n.link]));

  const result = await askGemini(`
You are a financial markets analyst for Indian investors. Analyze these recent news headlines and identify MAJOR events that could materially affect Indian stock market instruments.

HEADLINES:
${headlines}

For each significant event, return a JSON array with objects containing:
{
  "title": "concise event name",
  "event_type": "geopolitical|regulatory|macro|sector|company",
  "description": "2-3 sentence summary of the event and its relevance to Indian markets",
  "severity": "LOW|HIGH|CRITICAL",
  "affected_sectors_keywords": ["keyword1", "keyword2"],
  "source_headline_indices": [1, 3],
  "estimated_duration_days": 45,
  "rationale": "why this matters to Indian investors"
}

Rules:
- Only include events that are MATERIAL and ACTIONABLE for Indian market instruments
- CRITICAL = existential threat (major fraud, sector ban, war directly hitting India)
- HIGH = significant impact (policy change, sustained geopolitical event, major earnings miss)
- LOW = worth monitoring but not immediately actionable
- If no significant events found, return []
- Maximum 5 events per scan
`);

  if (!Array.isArray(result)) return [];

  return result.map(event => ({
    ...event,
    source_urls: (event.source_headline_indices || [])
      .map(i => sourceMap[i]).filter(Boolean),
    source_headlines: (event.source_headline_indices || [])
      .map(i => newsItems[i-1]?.title).filter(Boolean),
  }));
}

// ── DEPTH 2: HISTORICAL ANALOGUE + PROBABILITY ESTIMATION ─────
async function estimateProbabilities(event) {
  const result = await askGemini(`
You are a quantitative analyst specializing in Indian markets and historical pattern matching.

EVENT: ${event.title}
DESCRIPTION: ${event.description}
TYPE: ${event.event_type}
CURRENT SEVERITY: ${event.severity}

Find the best historical analogues for this event and estimate probabilities.

Return JSON:
{
  "historical_analogue": "Name and brief description of most similar historical event",
  "analogue_outcome": "How did that historical event ultimately resolve and over what timeframe",
  "probability_30d": 0.72,
  "probability_90d": 0.55,
  "probability_180d": 0.38,
  "confidence_pct": 65,
  "duration_estimate_days": 75,
  "reasoning": "Why these probabilities based on the historical analogue"
}

Guidelines:
- probabilities represent P(event continues to materially affect markets at that timeframe)
- confidence_pct reflects how confident you are in the historical analogue quality
- Use real Indian and global market history: 2008 crisis, IL&FS collapse, COVID, Russia-Ukraine, Demonetisation, COVID, SEBI circulars, RBI rate cycles
- Be conservative — financial analysis requires calibrated pessimism
`);
  return result;
}

// ── DEPTH 3: COMPANY / FUND POSITIONING ANALYSIS ─────────────
async function analyzeInstrumentPositioning(instrument, events) {
  const eventSummaries = events.map(e =>
    `${e.title} (${e.severity}, est. ${e.estimated_duration_days || 60} days)`
  ).join('; ');

  // Use Google Custom Search for earnings/fund info if available
  let publicInfo = '';
  if (process.env.GOOGLE_CSE_ID && process.env.GOOGLE_API_KEY) {
    try {
      const query = `"${instrument.name}" earnings hedging management strategy 2025 2026`;
      const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=3`;
      const { data } = await axios.get(searchUrl, { timeout: 8000 });
      if (data.items) {
        publicInfo = data.items.map(i => `${i.title}: ${i.snippet}`).join('\n');
      }
    } catch {} // graceful fallback to Gemini's training knowledge
  }

  const result = await askGemini(`
You are a senior equity/fund analyst specializing in Indian markets.

INSTRUMENT: ${instrument.name} (${instrument.symbol})
TYPE: ${instrument.instrument_type}
CATEGORY: ${instrument.category}
RISK LEVEL: ${instrument.risk_level}

EVENTS AFFECTING THIS INSTRUMENT:
${eventSummaries}

${publicInfo ? `RECENT PUBLIC INFORMATION:\n${publicInfo}\n` : ''}

Analyze this instrument's exposure to the above events and management/fund readiness.

Return JSON:
{
  "exposure_score": 45,
  "exposure_reasoning": "Why and how much is this instrument exposed",
  "mitigation_score": 70,
  "mitigation_reasoning": "What hedges/preparations reduce the risk",
  "net_risk_pct": 12.5,
  "net_opportunity_pct": 8.0,
  "positioning_notes": "Overall assessment for admin review",
  "earnings_evidence": "Any specific earnings/report evidence supporting the view",
  "ai_lever_score": 6,
  "signal_recommendation": "BUY|WATCH|SELL",
  "horizon_label": "Short-Term|Mid-Term|Long-Term",
  "horizon_days": 60,
  "risk_level": "NONE|LOW|HIGH|CRITICAL"
}

Guidelines:
- exposure_score: 0=no exposure, 100=completely exposed
- mitigation_score: 0=no protection, 100=fully hedged
- net_risk_pct: actual probability of meaningful negative impact
- net_opportunity_pct: probability of meaningful positive impact from this event
- ai_lever_score: 0=very bad news for this instrument, 5=neutral, 10=very positive
- For mutual funds: analyze underlying portfolio exposure and fund manager strategy
- For bonds/gold: analyze macro correlation and safe-haven characteristics
- CRITICAL only for existential threats (company fraud, complete sector regulation ban)
- Be specific and cite real characteristics of this instrument where known
`);
  return result;
}

// ── MAP SECTORS FROM EVENT KEYWORDS ──────────────────────────
function mapEventToCategories(event) {
  const text = `${event.title} ${event.description} ${(event.affected_sectors_keywords||[]).join(' ')}`.toLowerCase();
  const affected = new Set();
  for (const [keywords, categories] of Object.entries(SECTOR_MAP)) {
    if (new RegExp(keywords).test(text)) {
      categories.forEach(c => affected.add(c));
    }
  }
  // Severe/critical events affect all equity categories
  if (event.severity === 'CRITICAL') {
    ['large_cap_equity','mid_cap_equity','small_cap_equity','large_cap_fund','index_etf'].forEach(c => affected.add(c));
  }
  return Array.from(affected);
}

// ── STORE EVENT AND FLAGS ─────────────────────────────────────
async function storeEvent(event, probData) {
  const horizon = classifyHorizon(probData.duration_estimate_days || event.estimated_duration_days || 60);
  const { data, error } = await supabaseAdmin.from('ai_events').insert({
    title:               event.title,
    event_type:          event.event_type,
    description:         event.description,
    affected_sectors:    mapEventToCategories(event),
    severity:            event.severity,
    horizon_label:       horizon.label,
    horizon_days:        horizon.days,
    probability_30d:     probData.probability_30d,
    probability_90d:     probData.probability_90d,
    probability_180d:    probData.probability_180d,
    historical_analogue: probData.historical_analogue,
    confidence_pct:      probData.confidence_pct,
    source_urls:         event.source_urls || [],
    source_headlines:    event.source_headlines || [],
    detected_at:         new Date().toISOString(),
    auto_resolve_at:     new Date(Date.now() + horizon.days * 24*60*60*1000).toISOString(),
  }).select().single();
  if (error) { console.error('   Failed to store event:', error.message); return null; }
  return data;
}

async function storeFlag(instrument, event, positioning, storedEvent) {
  const originalSignal = 'WATCH'; // default; ideally fetched from latest recommendation
  const aiSignal = positioning.signal_recommendation || 'WATCH';
  const signalChanged = aiSignal !== originalSignal;
  const expiresAt = new Date(Date.now() + (positioning.horizon_days || 60) * 24*60*60*1000).toISOString();

  const { error } = await supabaseAdmin.from('ai_instrument_flags').insert({
    instrument_id:       instrument.id,
    event_id:            storedEvent?.id || null,
    risk_level:          positioning.risk_level || 'LOW',
    opportunity_level:   positioning.net_opportunity_pct > 15 ? 'HIGH' : positioning.net_opportunity_pct > 8 ? 'MEDIUM' : 'NONE',
    ai_lever_score:      positioning.ai_lever_score,
    exposure_score:      positioning.exposure_score,
    mitigation_score:    positioning.mitigation_score,
    net_risk_pct:        positioning.net_risk_pct,
    net_opportunity_pct: positioning.net_opportunity_pct,
    positioning_notes:   positioning.positioning_notes,
    earnings_evidence:   positioning.earnings_evidence,
    original_signal:     originalSignal,
    ai_signal:           aiSignal,
    signal_changed:      signalChanged,
    horizon_label:       positioning.horizon_label,
    expires_at:          expiresAt,
    source_urls:         storedEvent?.source_urls || [],
    is_active:           true,
    created_at:          new Date().toISOString(),
  });
  if (error) console.error(`   Failed to store flag for ${instrument.symbol}:`, error.message);
  return !error;
}

// ── AUTO-RESOLVE EXPIRED FLAGS ────────────────────────────────
async function resolveExpiredFlags() {
  if (!supabaseAdmin) return;
  const now = new Date().toISOString();
  await supabaseAdmin.from('ai_instrument_flags')
    .update({ is_active: false, resolved_at: now })
    .eq('is_active', true)
    .lt('expires_at', now);
  await supabaseAdmin.from('ai_events')
    .update({ status: 'expired', resolved_at: now })
    .eq('status', 'active')
    .lt('auto_resolve_at', now);
}

// ── CORPORATE ACTION DETECTION (fully automated) ──────────────
/**
 * Scans news for corporate actions affecting tracked instruments and sets
 * the corporate_action_flag automatically. No manual monitoring required.
 *
 * Corporate actions materially distort price signals — a stock that drops
 * 40% on an ex-dividend or split date has not "fallen"; the price simply
 * reflects a structural change. Flagging these prevents the engine from
 * generating a misleading signal and warns clients before they act.
 */
async function detectCorporateActions(newsItems) {
  if (!supabaseAdmin || !newsItems?.length) return 0;

  try {
    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('id, symbol, name')
      .in('status', ['active', 'watchlist']);

    if (!instruments?.length) return 0;

    // Only send headlines that mention a tracked instrument — keeps the
    // prompt small and the AI focused
    const relevant = [];
    for (const item of newsItems) {
      const title = item.title.toLowerCase();
      for (const inst of instruments) {
        const nameFirst = inst.name.split(' ')[0].toLowerCase();
        if (nameFirst.length >= 4 && title.includes(nameFirst)) {
          relevant.push({ headline: item.title, symbol: inst.symbol, id: inst.id, link: item.link });
          break;
        }
      }
    }

    if (!relevant.length) return 0;

    const result = await askGemini(`
You are monitoring Indian listed companies for CORPORATE ACTIONS that would
structurally distort their share price or NAV.

Corporate actions include: stock splits, bonus issues, rights issues, dividends
with an ex-date, mergers, demergers, buybacks, delisting, fund manager changes,
scheme mergers for mutual funds, or a change in fund mandate.

NOT corporate actions: routine earnings results, analyst rating changes,
general market commentary, price movement stories.

HEADLINES (each tagged with the instrument it mentions):
${relevant.slice(0, 25).map((r, i) => `${i + 1}. [${r.symbol}] ${r.headline}`).join('\n')}

Return a JSON array. Include ONLY genuine corporate actions:
[{"index": 1, "symbol": "RELIANCE", "action_type": "bonus issue", "note": "one sentence plain-English summary for an investor"}]

If none of these are corporate actions, return []
`, true);

    if (!Array.isArray(result) || !result.length) return 0;

    let flagged = 0;
    for (const action of result) {
      const match = relevant.find(r => r.symbol === action.symbol);
      if (!match) continue;

      const { error } = await supabaseAdmin
        .from('instrument_universe')
        .update({
          corporate_action_flag:   true,
          corporate_action_note:   `${action.action_type}: ${action.note}`,
          corporate_action_set_at: new Date().toISOString(),
        })
        .eq('id', match.id);

      if (!error) {
        flagged++;
        console.log(`   🏷  CORPORATE ACTION: ${action.symbol} — ${action.action_type}`);
      }
    }
    return flagged;
  } catch (e) {
    console.warn(`   ⚠ Corporate action detection failed: ${e.message}`);
    return 0;
  }
}

/**
 * Clears corporate action flags older than 30 days. Most corporate actions
 * resolve within a month; leaving a stale flag would permanently caveat an
 * instrument for no reason.
 */
async function expireCorporateActions() {
  if (!supabaseAdmin) return;
  try {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    await supabaseAdmin
      .from('instrument_universe')
      .update({ corporate_action_flag: false, corporate_action_note: null })
      .eq('corporate_action_flag', true)
      .lt('corporate_action_set_at', cutoff);
  } catch {}
}

// ── MAIN ENGINE ───────────────────────────────────────────────
async function runAILeverScan() {
  if (!aiProvider.isConfigured()) {
    console.log('🤖 AI Lever: no AI provider configured. Set GOOGLE_API_KEY (free) or ANTHROPIC_API_KEY in Render.');
    return;
  }
  if (!supabaseAdmin) {
    console.log('🤖 AI Lever: Supabase not configured, skipping.');
    return;
  }

  const scanStart = Date.now();
  console.log('🤖 Running AI Lever scan (3-depth probabilistic engine)...');
  aiProvider.resetUsage();
  const errors = [];
  let eventsDetected = 0, flagsGenerated = 0, signalsOverridden = 0, criticalFires = 0;

  try {
    // Auto-resolve expired flags from previous scans
    await resolveExpiredFlags();

    // ── DEPTH 1: Gather and parse news ─────────────────────
    console.log('   Depth 1: Fetching market news...');
    const newsItems = await gatherMarketNews();
    console.log(`   Parsed ${newsItems.length} news items`);

    // Corporate action detection runs on the same news set — no extra fetch
    await expireCorporateActions();
    const corpFlagged = await detectCorporateActions(newsItems);
    if (corpFlagged) console.log(`   Flagged ${corpFlagged} corporate action(s)`);

    const events = await detectEventsFromNews(newsItems);
    console.log(`   Detected ${events.length} significant market events`);
    eventsDetected = events.length;

    if (!events.length) {
      console.log('🤖 AI Lever scan complete — no material events detected today.');
      const usage0 = aiProvider.getUsage();
      await logScan(0, 0, 0, 0, usage0.google + usage0.anthropic, newsItems.length, Date.now()-scanStart, []);
      return;
    }

    // ── DEPTH 2: Probability estimation ────────────────────
    console.log('   Depth 2: Estimating event probabilities via historical analogues...');
    const eventsWithProb = [];
    for (const event of events) {
      try {
        const probData = await estimateProbabilities(event);
        event.probData = probData;
        const affectedCategories = mapEventToCategories(event);
        event.affectedCategories = affectedCategories;
        eventsWithProb.push(event);
        const storedEvent = await storeEvent(event, probData);
        event.storedEvent = storedEvent;
        console.log(`   ✓ ${event.title} [${event.severity}] → ${affectedCategories.join(', ')}`);
      } catch (e) {
        errors.push(`Depth2 ${event.title}: ${e.message}`);
      }
    }

    // ── DEPTH 3: Instrument-level positioning ──────────────
    console.log('   Depth 3: Analyzing instrument-specific positioning...');

    // Load all instruments
    const { data: instruments } = await supabaseAdmin
      .from('instrument_universe')
      .select('*')
      .in('status', ['active', 'watchlist']);

    if (!instruments) return;

    for (const instrument of instruments) {
      // Only analyze if this instrument's category is in any affected sector
      const relevantEvents = eventsWithProb.filter(e =>
        e.affectedCategories.includes(instrument.category) ||
        e.severity === 'CRITICAL'
      );
      if (!relevantEvents.length) continue;

      try {
        const positioning = await analyzeInstrumentPositioning(instrument, relevantEvents);

        // Only store flags for non-trivial findings
        if (positioning.risk_level !== 'NONE' && positioning.risk_level !== 'LOW') {
          const primaryEvent = relevantEvents.find(e => e.storedEvent) || relevantEvents[0];
          const flagStored = await storeFlag(instrument, primaryEvent, positioning, primaryEvent.storedEvent);
          if (flagStored) {
            flagsGenerated++;
            if (positioning.signal_recommendation !== 'WATCH') signalsOverridden++;
            if (positioning.risk_level === 'CRITICAL') criticalFires++;
            console.log(`   ⚡ ${instrument.symbol}: ${positioning.risk_level} [${positioning.horizon_label}] score=${positioning.ai_lever_score}/10`);
          }
        }
      } catch (e) {
        errors.push(`Depth3 ${instrument.symbol}: ${e.message}`);
      }
    }

  } catch (e) {
    errors.push(`Main scan: ${e.message}`);
    console.error('🤖 AI scan error:', e.message);
  }

  const aiUsage = aiProvider.getUsage();
  await logScan(eventsDetected, flagsGenerated, signalsOverridden, criticalFires, aiUsage.google + aiUsage.anthropic, 0, Date.now()-scanStart, errors);
  console.log(`🤖 AI Lever scan complete: ${eventsDetected} events, ${flagsGenerated} flags, ${signalsOverridden} overrides, ${aiUsage.google + aiUsage.anthropic} AI calls (google=${aiUsage.google} anthropic=${aiUsage.anthropic} fallbacks=${aiUsage.fallbacks}).`);

  await reportRun({
    engineName:     'aiLeverEngine',
    durationMs:     Date.now() - scanStart,
    itemsProcessed: eventsDetected,
    itemsExpected:  null,   // zero events on a quiet news day is valid
    itemsFailed:    errors.length,
    detail:         `${flagsGenerated} flags, ${criticalFires} critical, AI: ${JSON.stringify(aiUsage)}`,
  });
}

async function logScan(events, flags, overrides, critical, calls, news, duration, errors) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from('ai_scan_log').insert({
    instruments_scanned: 120,
    events_detected:     events,
    flags_generated:     flags,
    signals_overridden:  overrides,
    critical_fires:      critical,
    gemini_calls_used:   calls,
    news_items_parsed:   news,
    scan_duration_ms:    duration,
    errors:              errors,
    scanned_at:          new Date().toISOString(),
  });
}

module.exports = { runAILeverScan };
