/**
 * WealthGuard Analysis Engine v1.1
 * Eight analytical frameworks + Google Gemini AI convergence layer.
 * Free tier: 15 requests/min, 1,500 requests/day — sufficient for MVP.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialise Gemini — falls back to demo text if key not set
const genAI = process.env.GOOGLE_GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY)
  : null;

const MODEL = 'gemini-1.5-flash'; // Free tier model

// ═══════════════════════════════════════════════════════════
// ENGINE 1: TECHNICAL ANALYSIS
// ═══════════════════════════════════════════════════════════
function runTechnicalEngine(signals) {
  if (!signals) return { direction: 'neutral', score: 50, reasons: ['No technical data available'] };
  const scores = [];
  const reasons = [];

  if (signals.rsi_14 != null) {
    if (signals.rsi_14 < 30)      { scores.push(80); reasons.push(`RSI oversold at ${signals.rsi_14.toFixed(1)} — bounce expected`); }
    else if (signals.rsi_14 > 70) { scores.push(20); reasons.push(`RSI overbought at ${signals.rsi_14.toFixed(1)} — caution`); }
    else if (signals.rsi_14 < 50) { scores.push(42); reasons.push(`RSI ${signals.rsi_14.toFixed(1)} — below midline`); }
    else                           { scores.push(62); reasons.push(`RSI ${signals.rsi_14.toFixed(1)} — above midline, mildly bullish`); }
  }

  if (signals.macd_crossover === 'bullish_cross')  { scores.push(76); reasons.push('MACD bullish crossover confirmed'); }
  else if (signals.macd_crossover === 'bearish_cross') { scores.push(24); reasons.push('MACD bearish crossover — momentum falling'); }
  else { scores.push(50); }

  if (signals.dma_200_signal === 'above')    { scores.push(70); reasons.push('Price above 200 DMA — primary trend bullish'); }
  else if (signals.dma_200_signal === 'below') { scores.push(30); reasons.push('Price below 200 DMA — primary trend bearish'); }
  else                                        { scores.push(55); reasons.push('Price crossing 200 DMA — watch closely'); }

  if (signals.bollinger_position === 'lower') { scores.push(75); reasons.push('At Bollinger lower band — mean reversion likely'); }
  else if (signals.bollinger_position === 'upper') { scores.push(30); reasons.push('At Bollinger upper band — stretched'); }

  if (signals.golden_cross) { scores.push(80); reasons.push('Golden cross: 50 DMA above 200 DMA — major bullish signal'); }
  if (signals.volume_spike) reasons.push('Volume spike confirms the price move');
  if (signals.adx > 25)     reasons.push(`ADX ${signals.adx.toFixed(1)} — strong trend, not random noise`);

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
  return {
    direction: avg > 60 ? 'bullish' : avg < 40 ? 'bearish' : 'neutral',
    score: Math.round(avg), reasons
  };
}

// ═══════════════════════════════════════════════════════════
// ENGINE 2: FUNDAMENTAL ANALYSIS
// ═══════════════════════════════════════════════════════════
function runFundamentalEngine(f) {
  if (!f) return { direction: 'neutral', score: 50, reasons: ['No fundamental data'] };
  const scores = [];
  const reasons = [];

  // Hard blocks
  if (f.auditor_flag)                          return { direction: 'bearish', score: 5,  reasons: ['QUALIFIED AUDIT OPINION — BUY blocked immediately'], hard_block: true };
  if (f.altman_z_score != null && f.altman_z_score < 1.8) return { direction: 'bearish', score: 8, reasons: [`Altman Z-Score ${f.altman_z_score?.toFixed(2)} — financial distress zone. BUY blocked.`], hard_block: true };

  // Valuation
  if (f.pe_ratio) {
    if (f.pe_ratio < 15)      { scores.push(80); reasons.push(`PE ${f.pe_ratio.toFixed(1)}x — attractively valued`); }
    else if (f.pe_ratio < 25) { scores.push(62); reasons.push(`PE ${f.pe_ratio.toFixed(1)}x — fair valuation`); }
    else if (f.pe_ratio < 35) { scores.push(42); reasons.push(`PE ${f.pe_ratio.toFixed(1)}x — slightly stretched`); }
    else                       { scores.push(20); reasons.push(`PE ${f.pe_ratio.toFixed(1)}x — overvalued`); }
  }

  // Profitability
  if (f.roe_pct > 18)  { scores.push(80); reasons.push(`ROE ${f.roe_pct.toFixed(1)}% — excellent capital efficiency`); }
  else if (f.roe_pct > 12) { scores.push(65); reasons.push(`ROE ${f.roe_pct.toFixed(1)}% — solid`); }
  else if (f.roe_pct < 8)  { scores.push(32); reasons.push(`ROE ${f.roe_pct?.toFixed(1)}% — weak`); }

  // Balance sheet
  if (f.debt_equity != null) {
    if (f.debt_equity > 1.5) { scores.push(28); reasons.push(`D/E ${f.debt_equity.toFixed(2)} — high leverage, risk factor`); }
    else if (f.debt_equity < 0.5) { scores.push(76); reasons.push(`D/E ${f.debt_equity.toFixed(2)} — conservative, healthy`); }
  }

  // Cash quality
  if (f.cfo_vs_profit_ratio > 0.9) { scores.push(76); reasons.push('Strong cash flow vs reported profit — high earnings quality'); }
  else if (f.cfo_vs_profit_ratio < 0.5) { scores.push(28); reasons.push('Earnings not backed by cash flow — quality concern'); }

  // Growth
  if (f.earnings_growth_3y > 15) { scores.push(76); reasons.push(`${f.earnings_growth_3y.toFixed(1)}% 3Y earnings CAGR — strong growth trajectory`); }
  if (f.fcf_positive) { scores.push(70); reasons.push('Free cash flow positive — quality business'); }

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
  return { direction: avg>60?'bullish':avg<40?'bearish':'neutral', score: Math.round(avg), reasons };
}

// ═══════════════════════════════════════════════════════════
// ENGINE 3: MANAGEMENT QUALITY
// ═══════════════════════════════════════════════════════════
function runManagementEngine(f) {
  if (!f) return { direction: 'neutral', score: 50, reasons: ['No management data'] };
  const scores = [];
  const reasons = [];

  // Hard block on excessive pledging
  if (f.promoter_pledge_pct > 50) return { direction: 'bearish', score: 12, reasons: [`Promoter pledge ${f.promoter_pledge_pct?.toFixed(1)}% — financial stress signal. BUY blocked.`], hard_block: true };

  if (f.promoter_holding_pct > 50) { scores.push(76); reasons.push(`Promoter holds ${f.promoter_holding_pct.toFixed(1)}% — strong skin in the game`); }
  else if (f.promoter_holding_pct < 25) { scores.push(40); reasons.push(`Low promoter holding ${f.promoter_holding_pct?.toFixed(1)}% — reduced alignment`); }

  if (f.promoter_pledge_pct < 10) { scores.push(76); reasons.push(`Low pledge ${f.promoter_pledge_pct?.toFixed(1)}% — management financially stable`); }
  else if (f.promoter_pledge_pct > 20) { scores.push(35); reasons.push(`Pledge ${f.promoter_pledge_pct?.toFixed(1)}% — monitor closely`); }

  if (f.roce_pct > 20) { scores.push(80); reasons.push(`ROCE ${f.roce_pct?.toFixed(1)}% — excellent capital allocation by management`); }
  else if (f.roce_pct < 10) { scores.push(34); reasons.push(`ROCE ${f.roce_pct?.toFixed(1)}% — poor capital efficiency`); }

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
  return { direction: avg>60?'bullish':avg<40?'bearish':'neutral', score: Math.round(avg), reasons };
}

// ═══════════════════════════════════════════════════════════
// ENGINE 4: SENTIMENT ANALYSIS
// ═══════════════════════════════════════════════════════════
function runSentimentEngine(sentiment, vix) {
  const scores = [];
  const reasons = [];

  if (sentiment?.news_score_48h != null) {
    const mapped = (sentiment.news_score_48h + 1) * 50;
    scores.push(mapped);
    reasons.push(`48h news sentiment: ${sentiment.news_score_48h > 0.2 ? 'positive' : sentiment.news_score_48h < -0.2 ? 'negative' : 'neutral'} (${sentiment.news_score_48h.toFixed(2)})`);
  }

  if (sentiment?.earnings_call_tone) {
    const toneMap = { confident: 76, cautious: 50, hedging: 34, distressed: 18 };
    if (toneMap[sentiment.earnings_call_tone]) {
      scores.push(toneMap[sentiment.earnings_call_tone]);
      reasons.push(`Management call tone: ${sentiment.earnings_call_tone}`);
    }
  }

  const consensusMap = { strong_buy: 86, buy: 72, hold: 50, sell: 28, strong_sell: 14 };
  if (sentiment?.analyst_consensus && consensusMap[sentiment.analyst_consensus]) {
    scores.push(consensusMap[sentiment.analyst_consensus]);
    reasons.push(`Analyst consensus: ${sentiment.analyst_consensus.replace('_',' ')}`);
  }

  if (vix) {
    if (vix < 13)      { scores.push(45); reasons.push(`VIX ${vix.toFixed(1)} — greed territory, don't chase momentum`); }
    else if (vix < 17) { scores.push(65); reasons.push(`VIX ${vix.toFixed(1)} — calm market conditions`); }
    else if (vix < 21) { scores.push(48); reasons.push(`VIX ${vix.toFixed(1)} — mildly elevated fear`); }
    else if (vix < 25) { scores.push(35); reasons.push(`VIX ${vix.toFixed(1)} — elevated fear regime`); }
    else               { scores.push(12); reasons.push(`VIX ${vix.toFixed(1)} — CRISIS: buy signals frozen`); }
  }

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
  return { direction: avg>60?'bullish':avg<40?'bearish':'neutral', score: Math.round(avg), reasons };
}

// ═══════════════════════════════════════════════════════════
// ENGINE 5: INSTITUTIONAL FLOW
// ═══════════════════════════════════════════════════════════
function runInstitutionalEngine(fii, dii) {
  const scores = [];
  const reasons = [];

  if (fii != null) {
    if (fii > 20)       { scores.push(80); reasons.push(`FII net bought Rs.${fii.toFixed(0)}Cr — strong institutional demand`); }
    else if (fii > 0)   { scores.push(65); reasons.push(`FII net buyers Rs.${fii.toFixed(0)}Cr`); }
    else if (fii > -20) { scores.push(40); reasons.push(`FII mild outflow Rs.${Math.abs(fii).toFixed(0)}Cr`); }
    else                { scores.push(22); reasons.push(`FII heavy selling Rs.${Math.abs(fii).toFixed(0)}Cr — macro caution`); }
  }

  if (dii != null) {
    if (dii > 10)       { scores.push(75); reasons.push(`DII net buyers Rs.${dii.toFixed(0)}Cr — domestic support`); }
    else if (dii < -10) { scores.push(34); reasons.push(`DII selling Rs.${Math.abs(dii).toFixed(0)}Cr`); }
    else                { scores.push(50); }
  }

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
  return { direction: avg>60?'bullish':avg<40?'bearish':'neutral', score: Math.round(avg), reasons };
}

// ═══════════════════════════════════════════════════════════
// ENGINE 6: SECTOR ROTATION
// ═══════════════════════════════════════════════════════════
function runSectorRotationEngine(instrument, macro) {
  const scores = [];
  const reasons = [];
  const sub = instrument?.sub_category || 'large_cap';
  const gdp = macro?.macro?.gdp_latest || 7.0;
  const repo = macro?.macro?.repo_rate || 6.5;

  if (gdp > 6.5) {
    if (['large_cap','mid_cap'].includes(sub)) { scores.push(74); reasons.push('GDP expansion phase — equities in sector tailwind'); }
    if (['liquid','gsec'].includes(sub))        { scores.push(40); reasons.push('Expansion: fixed income less attractive than equity'); }
  } else {
    if (['liquid','gsec','tbill'].includes(sub)) { scores.push(76); reasons.push('Slowdown: capital preservation sectors preferred'); }
    if (sub === 'mid_cap')                        { scores.push(34); reasons.push('Slowdown: mid-caps underperform in risk-off regimes'); }
  }

  if (sub === 'gold' || sub === 'sgb' || sub === 'etf') { scores.push(68); reasons.push('Gold: inflation hedge, always relevant in India'); }

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
  return { direction: avg>60?'bullish':avg<40?'bearish':'neutral', score: Math.round(avg), reasons };
}

// ═══════════════════════════════════════════════════════════
// ENGINE 7: PESTLE (Political/Economic/Social/Tech/Legal/Environmental)
// ═══════════════════════════════════════════════════════════
function runPESTLEEngine(factors, instrument) {
  if (!factors || !factors.length) return { direction: 'neutral', score: 50, reasons: ['No PESTLE data available'] };
  const scores = [];
  const reasons = [];
  let adverseCount = 0;

  for (const f of factors) {
    const relevant = !f.affected_sectors?.length ||
      f.affected_sectors.includes(instrument?.sub_category) ||
      f.affected_sectors.includes(instrument?.asset_class);
    if (!relevant) continue;
    scores.push((f.direction_score + 2) * 25); // map -2..+2 → 0..100
    if (f.direction_score < -0.5) adverseCount++;
    reasons.push(`${f.factor_type.toUpperCase()}: ${f.factor_name} (${f.direction_score > 0 ? '+':''}${f.direction_score})`);
  }

  const hard_flag = adverseCount >= 2;
  if (hard_flag) reasons.push(`WARNING: ${adverseCount} adverse PESTLE forces active simultaneously — BUY downgraded`);

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 50;
  return { direction: avg>60?'bullish':avg<40?'bearish':'neutral', score: Math.round(avg), reasons, hard_flag, adverse_count: adverseCount };
}

// ═══════════════════════════════════════════════════════════
// ENGINE 8: PORTER'S FIVE FORCES
// ═══════════════════════════════════════════════════════════
function runPortersEngine(instrument) {
  const map = {
    large_cap:  { score: 65, reason: 'Large-cap: generally strong competitive moats' },
    mid_cap:    { score: 54, reason: 'Mid-cap: moat strength varies significantly' },
    liquid:     { score: 72, reason: 'Liquid funds: regulatory moat, low competitive risk' },
    gsec:       { score: 86, reason: 'G-Sec: zero competitive risk, sovereign backing' },
    gold:       { score: 70, reason: 'Gold: globally liquid, no competitive disruption' },
    sgb:        { score: 76, reason: 'SGB: government-backed, 2.5% interest kicker' },
    index:      { score: 64, reason: 'Index fund: passive, minimal force intensity' },
    commercial: { score: 58, reason: 'REITs: rising competition from new listings' },
  };
  const sub = instrument?.sub_category || 'large_cap';
  const r = map[sub] || { score: 54, reason: 'Sector competitive dynamics: moderate' };
  return { direction: r.score>60?'bullish':r.score<40?'bearish':'neutral', score: r.score, reasons: [r.reason] };
}

// ═══════════════════════════════════════════════════════════
// CONVERGENCE ENGINE — all 8 engines feed this
// ═══════════════════════════════════════════════════════════
function runConvergenceEngine(engineResults, weights, vix) {
  const names = ['technical','fundamental','management','sentiment','institutional','sector_rotation','pestle','porters'];
  let bullish = 0, bearish = 0, hardBlock = false, pestleFlag = false;

  for (const n of names) {
    const r = engineResults[n];
    if (!r) continue;
    if (r.hard_block)  hardBlock = true;
    if (r.hard_flag)   pestleFlag = true;
    if (r.direction === 'bullish') bullish++;
    else if (r.direction === 'bearish') bearish++;
  }

  if (vix >= 25) hardBlock = true; // VIX override

  let composite = 0;
  for (const n of names) {
    const r = engineResults[n];
    const w = weights ? (weights[n+'_weight'] || 0.125) : 0.125;
    if (r) composite += r.score * w;
  }

  let action = 'HOLD', tier = 'standard';
  let confidence = composite / 100;

  if (hardBlock) {
    action = 'BLOCK'; confidence = 0;
  } else if (bullish >= 7) {
    action = 'BUY'; tier = 'high_conviction';
    confidence = Math.min(0.95, confidence + 0.10);
  } else if (bullish >= 5) {
    action = pestleFlag ? 'WATCH' : 'BUY'; tier = 'standard';
  } else if (bearish >= 5) {
    action = 'SELL';
  } else if (bearish >= 3) {
    action = 'REDUCE';
  } else if (bullish === 4) {
    action = 'WATCH'; tier = 'watchlist';
  }

  if (confidence < 0.60 && action !== 'BLOCK') action = 'WATCH';

  return {
    action, tier, bullishCount: bullish, bearishCount: bearish,
    compositeScore: Math.round(composite),
    confidence: parseFloat(confidence.toFixed(4)),
    hardBlock, pestleFlag, vixOverride: vix >= 25,
    engines_detail: Object.fromEntries(names.map(n => [n, engineResults[n]?.direction || 'neutral']))
  };
}

// ═══════════════════════════════════════════════════════════
// GOOGLE GEMINI AI — Signal rationale generation
// ═══════════════════════════════════════════════════════════
async function generateAIRationale(instrument, convergence, engineResults, clientProfile, macro) {
  const prompt = `You are WealthGuard, an investment intelligence platform for India. Write a clear, specific recommendation rationale.

INSTRUMENT: ${instrument.name} (${instrument.asset_class}, ${instrument.sub_category})
SIGNAL: ${convergence.action} | Tier: ${convergence.tier} | Confidence: ${(convergence.confidence*100).toFixed(0)}%
ENGINES: ${convergence.bullishCount}/8 bullish | Composite score: ${convergence.compositeScore}/100

KEY ENGINE SIGNALS:
${Object.entries(engineResults).map(([k,v]) => `- ${k}: ${v.direction} (${v.score}/100) — ${v.reasons?.[0]||'N/A'}`).join('\n')}

CLIENT: Risk score ${clientProfile?.effective_risk_score||5}/10 | Surplus Rs.${(clientProfile?.investable_surplus_inr||40000).toLocaleString('en-IN')}/mo | Goal: ${clientProfile?.linked_goal||'long-term growth'}

MARKET: VIX ${macro?.vix||13.4} | FII ${macro?.flows?.fii_net_cr>0?'buying':'selling'} Rs.${Math.abs(macro?.flows?.fii_net_cr||28).toFixed(0)}Cr

Write exactly two sections separated by [SHORT]:
1. Full rationale: 3-4 specific sentences with numbers, linking to client's situation
2. WhatsApp version: 1-2 sentences max 150 chars, direct and actionable

Rules: State facts, not opinions. Include specific numbers. Never say "I recommend". Be concise.`;

  if (!genAI) {
    return {
      full: `${convergence.bullishCount} of 8 analytical engines are in agreement on ${instrument.name}. The technical setup shows positive momentum with the price above key moving averages. Fundamentals are sound with healthy profitability metrics and no balance sheet concerns flagged. This signal aligns with your ${clientProfile?.linked_goal || 'long-term'} goal given your current risk profile.`,
      short: `${convergence.action} ${instrument.name} — ${convergence.bullishCount}/8 engines agree. Confidence: ${(convergence.confidence*100).toFixed(0)}%. Set stop-loss at recommended level.`
    };
  }

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parts = text.split('[SHORT]');
    return {
      full: parts[0]?.trim() || text,
      short: parts[1]?.trim() || text.substring(0, 150)
    };
  } catch (err) {
    console.error('Gemini API error:', err.message);
    return {
      full: `${convergence.bullishCount}/8 engines bullish on ${instrument.name}. Confidence ${(convergence.confidence*100).toFixed(0)}%. Position sized to your risk profile.`,
      short: `${convergence.action}: ${instrument.name} — ${convergence.bullishCount}/8 engines. Conf: ${(convergence.confidence*100).toFixed(0)}%.`
    };
  }
}

// ═══════════════════════════════════════════════════════════
// GOOGLE GEMINI AI — Morning brief generation
// ═══════════════════════════════════════════════════════════
async function generateMorningBrief(clientProfile, portfolioSummary, signals, macro) {
  const vix = macro?.vix || 13.4;
  const date = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  const prompt = `You are WealthGuard's morning brief AI for India. Generate a personalised WhatsApp morning brief.

CLIENT: ${clientProfile?.full_name||'Client'} | Tier: ${clientProfile?.client_tier||'builder'} | Risk: ${clientProfile?.effective_risk_score||5}/10
PORTFOLIO: Value Rs.${(portfolioSummary?.total_value||1843200).toLocaleString('en-IN')} | Return: ${portfolioSummary?.total_pnl_pct?.toFixed(1)||'+15.2'}%
RISK STATUS: ${portfolioSummary?.risk_status||'GREEN — all positions above stop-loss'}

MARKET TODAY (${date}):
- Nifty: ${macro?.nifty?.change_pct>0.3?'Mildly Bullish':macro?.nifty?.change_pct<-0.3?'Mildly Bearish':'Neutral'}
- VIX: ${vix} (${vix<17?'calm — normal conditions':vix<21?'slightly elevated':vix<25?'elevated fear':'CRISIS'})
- FII: ${macro?.flows?.fii_net_cr>0?`Net buyers Rs.${macro.flows.fii_net_cr.toFixed(0)}Cr`:`Net sellers Rs.${Math.abs(macro?.flows?.fii_net_cr||0).toFixed(0)}Cr`}

SIGNALS TODAY: ${signals?.length||0} active (${signals?.filter(s=>s.tier==='high_conviction').length||0} High Conviction)
TOP SIGNAL: ${signals?.[0]?`${signals[0].action} ${signals[0].instrument_name} (${(signals[0].confidence_score*100).toFixed(0)}% conf)`:'No urgent signals today'}

GOALS:
${(clientProfile?.goals||[]).map(g=>`- ${g.goal_name}: ${g.funding_pct?.toFixed(0)||'?'}% funded, ${g.on_track?'on track':'needs attention'}`).join('\n')||'- Emergency Fund: 100%\n- Long-term goals: in progress'}

Format using WhatsApp markdown (*bold*, _italic_):
🌅 *Good morning, ${clientProfile?.full_name?.split(' ')[0]||'there'}!*
_WealthGuard · ${date} · 7:30 AM_

📊 *Your Portfolio* (2-3 key numbers + risk colour GREEN/AMBER/RED)

🌍 *Market Prediction* (direction, confidence %, 1-sentence reason)

⚡ *Actions Today* (3-4 bullets, specific and actionable)

🎯 *Goal Update* (1-2 goals with % and status)

_Reply *DETAILS* · *EXPLAIN* · *PORTFOLIO* · *CALL*_

Keep total under 350 words. Be direct. Use real numbers.`;

  if (!genAI) {
    return `🌅 *Good morning, ${clientProfile?.full_name?.split(' ')[0] || 'there'}!*
_WealthGuard · ${date} · 7:30 AM_

📊 *Your Portfolio*
Value: Rs.${(portfolioSummary?.total_value||1843200).toLocaleString('en-IN')} | Return: +${portfolioSummary?.total_pnl_pct?.toFixed(1)||'15.2'}%
🟢 *GREEN* — All positions above stop-loss

🌍 *Market Prediction Today*
Nifty 50: ${vix<20?'▲ Mildly Bullish (72% confidence)':'◆ Neutral (55% confidence)'}
Range: 24,420 – 24,780
_VIX calm at ${vix}. FII buyers. Asia positive._

⚡ *Actions Today*
• HOLD all positions — stop-losses secure
• ⭐ HC BUY signal: SBI Bluechip Fund (82% conf) — check Signals tab
• ⚠ Monitor: Tata Motors — 4.2% from stop-loss today
• SIP reminder: Check any scheduled investments due

🎯 *Goal Update*
• Emergency Fund: ✅ 100% funded
• Retirement: 31% — consider step-up SIP (+Rs.3,000/mo)

_Reply *DETAILS* · *EXPLAIN* · *PORTFOLIO* · *CALL*_
_WealthGuard · Not SEBI registered advice · Capital preservation first_`;
  }

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error('Gemini brief error:', err.message);
    return `🌅 WealthGuard Morning Brief · ${date}\nPortfolio: Rs.${(portfolioSummary?.total_value||1843200).toLocaleString('en-IN')} | VIX: ${vix}\nReply DETAILS for today's signals.`;
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN: Full analysis for one instrument
// ═══════════════════════════════════════════════════════════
async function runFullAnalysis(instrument, technicalData, fundamentalData, sentimentData, pestleData, flowData, macro, clientProfile, engineWeights) {
  const engines = {
    technical:       runTechnicalEngine(technicalData),
    fundamental:     runFundamentalEngine(fundamentalData),
    management:      runManagementEngine(fundamentalData),
    sentiment:       runSentimentEngine(sentimentData, macro?.vix),
    institutional:   runInstitutionalEngine(flowData?.fii_net_cr, flowData?.dii_net_cr),
    sector_rotation: runSectorRotationEngine(instrument, macro),
    pestle:          runPESTLEEngine(pestleData, instrument),
    porters:         runPortersEngine(instrument),
  };

  const convergence = runConvergenceEngine(engines, engineWeights, macro?.vix || 13);

  if (convergence.action === 'BLOCK') return { action: 'BLOCK', engines, convergence, rationale: null };

  const rationale = await generateAIRationale(instrument, convergence, engines, clientProfile, macro);
  return { instrument, engines, convergence, rationale };
}

module.exports = {
  runFullAnalysis, runTechnicalEngine, runFundamentalEngine, runManagementEngine,
  runSentimentEngine, runInstitutionalEngine, runSectorRotationEngine,
  runPESTLEEngine, runPortersEngine, runConvergenceEngine,
  generateAIRationale, generateMorningBrief,
};
