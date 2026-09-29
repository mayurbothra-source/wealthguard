/**
 * WealthGuard — the nine analytical levers
 *
 * Extracted from instrumentEngine.js so it can be tested in isolation and so
 * each lever is a visible, independent unit rather than a block inside a
 * 900-line file.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * Five of the nine levers were hardcoded category lookup tables. Measured
 * empirically, the consequences were:
 *
 *   - Only `technical` and `sentiment` varied per instrument, and both read
 *     the same input (today's % change). Two large-caps on the same day
 *     scored 66 and 67.
 *   - Asset category decided the call. Price movement moved the composite
 *     ~11 points; category moved it 21.
 *   - G-Secs scored 70-81 — a permanent BUY at any price, in any market.
 *   - Mid-caps topped out at 66 and small-caps at 60, so neither could ever
 *     reach the BUY threshold of 70 regardless of merit.
 *
 * Six levers are now genuinely per-instrument, computed from one year of
 * price history and (where available) company fundamentals. Two remain
 * market-wide because they correctly are: institutional flow and the macro
 * environment apply to everything. Sector timing is per-category but now
 * derived from that category's own measured momentum instead of a constant.
 *
 * WHAT DID NOT CHANGE — these are frozen product decisions
 *   - Nine levers, each 0-10, summed and scaled to 0-100
 *   - BUY >= 70, WATCH 50-69, SELL < 50
 *   - High conviction at >= 75
 *   - The risk gate runs after scoring and can veto anything
 *
 * THE ONE BEHAVIOURAL ADDITION
 * An instrument with no price history can no longer receive a directional
 * call. Previously a statically-priced G-Sec scored 74 on category constants
 * alone and was published as a BUY, having never been measured. Now it scores
 * neutrally and is marked `insufficient_data`, which the caller turns into
 * WATCH with a plain-English reason. Saying "we cannot call this" is the
 * honest output, and it is what stops the permanent-BUY behaviour at source.
 */

'use strict';

/* ── Scoring helpers ───────────────────────────────────────────────── */

/** Clamp to the lever range and round. */
const lv = x => Math.min(10, Math.max(0, Math.round(x)));

/**
 * Maps a value onto 0-10 through ordered breakpoints.
 * `bands` is [[threshold, score], ...] descending by threshold; the first
 * threshold the value meets or exceeds wins.
 */
function band(value, bands, fallback = 5) {
  if (value == null || !isFinite(value)) return fallback;
  for (const [threshold, score] of bands) {
    if (value >= threshold) return score;
  }
  return bands[bands.length - 1][1];
}

/** Same, but for metrics where lower is better (PE, volatility, debt). */
function bandLower(value, bands, fallback = 5) {
  if (value == null || !isFinite(value)) return fallback;
  for (const [threshold, score] of bands) {
    if (value <= threshold) return score;
  }
  return bands[bands.length - 1][1];
}

/* ── The category baselines, kept ONLY as a documented fallback ─────
   These are the old hardcoded values. They are retained deliberately: when a
   data feed is unavailable, falling back to a category-appropriate baseline
   is better than a hard failure — but every fallback is recorded in
   `sources` so a scoring run reports how much of it was measured versus
   assumed, and the dry-run harness prints that breakdown.             */

const BASELINE = {
  fundamental:   { large_cap_equity:7, mid_cap_equity:6, small_cap_equity:5, large_cap_fund:7,
                   flexi_mid_fund:6, index_etf:7, gold:6, bond_gsec:8, debt_fund:8, watchlist:5 },
  management:    { large_cap_equity:7, mid_cap_equity:6, small_cap_equity:5, large_cap_fund:8,
                   flexi_mid_fund:7, index_etf:9, gold:9, bond_gsec:10, debt_fund:9, watchlist:5 },
  sector_timing: { large_cap_equity:7, mid_cap_equity:6, small_cap_equity:5, large_cap_fund:7,
                   flexi_mid_fund:6, index_etf:7, gold:6, bond_gsec:7, debt_fund:7, watchlist:5 },
  competitive:   { large_cap_equity:7, mid_cap_equity:6, small_cap_equity:5, large_cap_fund:8,
                   flexi_mid_fund:7, index_etf:8, gold:9, bond_gsec:10, debt_fund:9, watchlist:5 },
  risk_adjusted: { large_cap_equity:7, mid_cap_equity:6, small_cap_equity:5, large_cap_fund:7,
                   flexi_mid_fund:6, index_etf:7, gold:6, bond_gsec:8, debt_fund:9, watchlist:5 },
};

const baseFor = (lever, cat) => BASELINE[lever]?.[cat] ?? 6;

/** How much price history a lever needs before it will trust it. */
const MIN_POINTS_TECHNICAL = 60;    // enough for a 50-day average
const MIN_POINTS_RISK      = 60;    // enough for a meaningful volatility
const MIN_POINTS_MOMENTUM  = 25;    // enough for a 1-month return

/* ══════════════════════════════════════════════════════════════════
   THE NINE LEVERS
   Each returns { score, source, detail } so the engine can report what was
   measured and what was assumed.
   ══════════════════════════════════════════════════════════════════ */

/**
 * LEVER 1 — TECHNICAL
 * Was: today's % change, capped at ±3%.
 * Now: trend and momentum from a year of closes — position against the 50 and
 * 200 day averages, the golden cross, RSI, and distance from the 52-week
 * high. This is what a technical lever is supposed to measure.
 */
function leverTechnical(ps, cat) {
  if (!ps || (ps.data_points || 0) < MIN_POINTS_TECHNICAL) {
    return { score: 5, source: 'neutral', detail: 'not enough price history for a trend read' };
  }
  let s = 5;
  const parts = [];

  if (ps.above_ma_50  === true)  { s += 1.2; parts.push('above 50-day average'); }
  if (ps.above_ma_50  === false) { s -= 1.2; parts.push('below 50-day average'); }
  if (ps.above_ma_200 === true)  { s += 1.2; parts.push('above 200-day average'); }
  if (ps.above_ma_200 === false) { s -= 1.2; parts.push('below 200-day average'); }
  if (ps.golden_cross === true)  { s += 0.8; parts.push('50-day above 200-day'); }
  if (ps.golden_cross === false) { s -= 0.8; }

  // RSI: reward constructive strength, penalise the extremes in both
  // directions. Overbought is not a buy signal.
  if (ps.rsi_14 != null) {
    const r = ps.rsi_14;
    if (r >= 75)      { s -= 1.0; parts.push(`RSI ${r.toFixed(0)} — overbought`); }
    else if (r >= 55) { s += 1.0; parts.push(`RSI ${r.toFixed(0)} — constructive`); }
    else if (r >= 45) { s += 0.2; }
    else if (r >= 30) { s -= 0.8; parts.push(`RSI ${r.toFixed(0)} — weak`); }
    else              { s += 0.3; parts.push(`RSI ${r.toFixed(0)} — oversold`); }
  }

  // Well off the 52-week high is a real headwind
  if (ps.pct_from_52w_high != null && ps.pct_from_52w_high < -25) {
    s -= 0.8; parts.push(`${Math.abs(ps.pct_from_52w_high).toFixed(0)}% below its 52-week high`);
  }

  return { score: lv(s), source: 'measured', detail: parts.slice(0, 3).join(', ') || 'trend neutral' };
}

/**
 * LEVER 2 — FUNDAMENTAL
 * Was: a category constant. Every large-cap scored 7, always.
 * Now: PE, price-to-book, earnings growth and profit margin where Yahoo
 * supplies them. Funds, ETFs, bonds and gold have no company fundamentals, so
 * they keep the category baseline and say so — that is a fact about the
 * instrument type, not a gap.
 */
function leverFundamental(f, cat, ps) {
  if (!f) {
    const isCompany = ['large_cap_equity','mid_cap_equity','small_cap_equity'].includes(cat);
    return {
      score: baseFor('fundamental', cat),
      source: isCompany ? 'baseline' : 'not-applicable',
      detail: isCompany ? 'company fundamentals unavailable' : 'no company fundamentals for this instrument type',
    };
  }
  let s = 5; const parts = []; let used = 0;

  // PE — cheap is better, but a negative PE means losses, not value
  const pe = f.forward_pe ?? f.trailing_pe;
  if (pe != null) {
    used++;
    if (pe < 0)        { s -= 1.5; parts.push('loss-making'); }
    else {
      const v = bandLower(pe, [[15,8],[22,7],[30,6],[45,4],[Infinity,3]]);
      s += (v - 5) * 0.5;
      parts.push(`PE ${pe.toFixed(1)}`);
    }
  }
  if (f.price_to_book != null && f.price_to_book > 0) {
    used++;
    s += (bandLower(f.price_to_book, [[1.5,8],[3,7],[5,6],[8,4],[Infinity,3]]) - 5) * 0.35;
  }
  if (f.earnings_growth != null) {
    used++;
    const g = f.earnings_growth * 100;
    s += (band(g, [[25,9],[15,8],[5,6],[0,5],[-Infinity,3]]) - 5) * 0.5;
    parts.push(`earnings ${g >= 0 ? '+' : ''}${g.toFixed(0)}%`);
  }
  if (f.profit_margin != null) {
    used++;
    const m = f.profit_margin * 100;
    s += (band(m, [[20,9],[12,8],[6,6],[0,5],[-Infinity,3]]) - 5) * 0.35;
  }

  if (!used) {
    return { score: baseFor('fundamental', cat), source: 'baseline',
             detail: 'fundamentals present but no usable fields' };
  }
  return { score: lv(s), source: 'measured', detail: parts.slice(0, 2).join(', ') };
}

/**
 * LEVER 3 — MANAGEMENT QUALITY
 * Was: a category constant.
 * Now: return on equity, debt-to-equity and operating margin — the observable
 * evidence of how well a business is run. Yahoo does not expose promoter
 * pledging for Indian listings, which the AI lever flags separately when a
 * governance event is detected.
 */
function leverManagement(f, cat) {
  if (!f) {
    const isCompany = ['large_cap_equity','mid_cap_equity','small_cap_equity'].includes(cat);
    return {
      score: baseFor('management', cat),
      source: isCompany ? 'baseline' : 'not-applicable',
      detail: isCompany ? 'company data unavailable' : 'rules-based or government-backed instrument',
    };
  }
  let s = 5; const parts = []; let used = 0;

  if (f.return_on_equity != null) {
    used++;
    const roe = f.return_on_equity * 100;
    s += (band(roe, [[20,9],[15,8],[10,7],[5,5],[-Infinity,3]]) - 5) * 0.6;
    parts.push(`ROE ${roe.toFixed(0)}%`);
  }
  if (f.debt_to_equity != null) {
    used++;
    // Yahoo reports this as a percentage (45.2 = 0.45x)
    const de = f.debt_to_equity;
    s += (bandLower(de, [[25,9],[60,8],[100,6],[175,4],[Infinity,2]]) - 5) * 0.6;
    if (de > 100) parts.push(`debt/equity ${(de/100).toFixed(1)}x — high`);
  }
  if (f.operating_margin != null) {
    used++;
    s += (band(f.operating_margin * 100, [[20,8],[12,7],[5,6],[0,5],[-Infinity,3]]) - 5) * 0.35;
  }

  if (!used) return { score: baseFor('management', cat), source: 'baseline', detail: 'no usable fields' };
  return { score: lv(s), source: 'measured', detail: parts.slice(0, 2).join(', ') };
}

/**
 * LEVER 4 — SENTIMENT
 * Was: today's % change × 0.4 — the same single input as the technical lever.
 * Now: multi-horizon momentum (1m and 3m), which is what market sentiment
 * toward an instrument actually looks like over a week-to-month holding
 * period. One day's move is noise.
 */
function leverSentiment(ps, cat) {
  if (!ps || (ps.data_points || 0) < MIN_POINTS_MOMENTUM) {
    return { score: 5, source: 'neutral', detail: 'not enough history for a momentum read' };
  }
  let s = 5; const parts = [];

  if (ps.return_1m != null) {
    s += (band(ps.return_1m, [[8,9],[3,7],[0,6],[-5,4],[-Infinity,3]]) - 5) * 0.6;
    parts.push(`${ps.return_1m >= 0 ? '+' : ''}${ps.return_1m.toFixed(1)}% in a month`);
  }
  if (ps.return_3m != null) {
    s += (band(ps.return_3m, [[15,9],[6,7],[0,6],[-8,4],[-Infinity,3]]) - 5) * 0.6;
  }
  return { score: lv(s), source: 'measured', detail: parts[0] || 'momentum flat' };
}

/**
 * LEVER 5 — INSTITUTIONAL FLOW
 * Unchanged, and correctly so: FII/DII net flow is a market-wide figure and
 * applies identically to every instrument. NSE does not publish per-stock
 * institutional flow on a free feed.
 */
function leverInstitutional(macro) {
  const fii = macro?.fii_net_cr ?? 0;
  const dii = macro?.dii_net_cr ?? 0;
  const net = fii + dii;
  const score =
    net >  5000 ? 8 :
    net >  1000 ? 7 :
    net >     0 ? 6 :
    net > -1000 ? 4 :
    net > -5000 ? 3 : 2;
  const measured = macro?.fii_net_cr != null || macro?.dii_net_cr != null;
  return {
    score,
    source: measured ? 'measured' : 'neutral',
    detail: measured ? `net institutional flow ₹${net.toFixed(0)}Cr` : 'flow data unavailable',
  };
}

/**
 * LEVER 6 — SECTOR TIMING
 * Was: a category constant.
 * Now: the category's own median 3-month return, measured across its
 * constituents. This is legitimately a category-level property — sector
 * timing is about the sector — but it is now derived from what the sector
 * actually did rather than fixed at 7 forever.
 */
function leverSectorTiming(peerMedian3m, cat, peerCount) {
  if (peerMedian3m == null || (peerCount || 0) < 3) {
    return { score: baseFor('sector_timing', cat), source: 'baseline',
             detail: 'too few measurable peers to judge the category' };
  }
  const score = band(peerMedian3m, [[15,9],[8,8],[2,7],[-2,5],[-10,4],[-Infinity,3]]);
  return {
    score,
    source: 'measured',
    detail: `category median ${peerMedian3m >= 0 ? '+' : ''}${peerMedian3m.toFixed(1)}% over 3 months`,
  };
}

/**
 * LEVER 7 — MACRO / PESTLE
 * Unchanged, and correctly so: GDP and CPI are market-wide.
 */
function leverMacro(macro, cat) {
  const gdp = macro?.gdp_latest ?? 7;
  const cpi = macro?.cpi_latest ?? 5;
  const gdpScore = gdp >= 7 ? 3 : gdp >= 5 ? 2 : 1;
  const cpiScore = cpi <= 4 ? 3 : cpi <= 6 ? 2 : 1;
  const typeBonus = (cat === 'bond_gsec' || cat === 'debt_fund') ? 2 : 1;
  const measured = macro?.gdp_latest != null || macro?.cpi_latest != null;
  return {
    score: lv(gdpScore + cpiScore + typeBonus),
    source: measured ? 'measured' : 'neutral',
    detail: `GDP ${gdp}%, CPI ${cpi}%`,
  };
}

/**
 * LEVER 8 — COMPETITIVE POSITIONING
 * Was: a category constant. Every G-Sec scored 10 "by definition".
 * Now: relative strength against the instrument's own peers over 3 months,
 * plus margin quality where available. "Is this winning against comparable
 * instruments" is a measurable competitive question; "bonds have no
 * competition" was a tautology that added a fixed 10 points.
 */
function leverCompetitive(ps, f, cat, peerMedian3m, peerCount) {
  const haveRel = ps?.return_3m != null && peerMedian3m != null && (peerCount || 0) >= 3;
  if (!haveRel && !f) {
    return { score: baseFor('competitive', cat), source: 'baseline',
             detail: 'no peer comparison available' };
  }
  let s = 5; const parts = [];

  if (haveRel) {
    const rel = ps.return_3m - peerMedian3m;   // percentage points vs peers
    s += (band(rel, [[10,9],[4,8],[0,6],[-5,4],[-Infinity,3]]) - 5) * 1.0;
    parts.push(`${rel >= 0 ? '+' : ''}${rel.toFixed(1)}pp vs its peers`);
  }
  // A durable margin premium is the clearest evidence of a moat
  if (f?.operating_margin != null) {
    s += (band(f.operating_margin * 100, [[25,8],[15,7],[8,6],[0,5],[-Infinity,4]]) - 5) * 0.4;
  }
  return {
    score: lv(s),
    source: haveRel ? 'measured' : 'partial',
    detail: parts[0] || 'margin-based only',
  };
}

/**
 * LEVER 9 — RISK-ADJUSTED RETURN
 * Was: a category constant. Debt scored 9, small-cap 5, forever.
 * Now: the Sharpe-like ratio and max drawdown computed from the instrument's
 * own price history. This is the textbook definition of the lever and it was
 * always computable — it just was not being computed.
 */
function leverRiskAdjusted(ps, cat) {
  if (!ps || (ps.data_points || 0) < MIN_POINTS_RISK || ps.sharpe == null) {
    return { score: baseFor('risk_adjusted', cat), source: 'baseline',
             detail: 'not enough history to measure return per unit of risk' };
  }
  let s = band(ps.sharpe, [[1.5,9],[1.0,8],[0.5,7],[0,5],[-0.5,4],[-Infinity,2]]);
  const parts = [`Sharpe ${ps.sharpe.toFixed(2)}`];

  // A deep drawdown is risk the Sharpe ratio alone understates
  if (ps.max_drawdown_pct != null) {
    if (ps.max_drawdown_pct < -40)      { s -= 1.5; parts.push(`${ps.max_drawdown_pct.toFixed(0)}% worst fall`); }
    else if (ps.max_drawdown_pct < -25) { s -= 0.7; }
  }
  return { score: lv(s), source: 'measured', detail: parts.join(', ') };
}

/* ══════════════════════════════════════════════════════════════════
   COMPOSITE
   ══════════════════════════════════════════════════════════════════ */

/**
 * Scores an instrument across all nine levers.
 *
 * @param {object} instrument   an instrument_universe row
 * @param {object} macroData    market-wide figures (FII/DII, GDP, CPI)
 * @param {object} metrics      this instrument's entry from fundamentalsProvider
 * @returns {object} lever scores, composite, and the audit trail
 */
function scoreInstrument(instrument, macroData, metrics) {
  const cat = instrument.category;
  const ps  = metrics?.price_stats || null;
  const f   = metrics?.fundamentals || null;
  const peerMedian = metrics?.peer_median_return_3m ?? null;
  const peerCount  = metrics?.peer_count ?? 0;

  const L = {
    technical:     leverTechnical(ps, cat),
    fundamental:   leverFundamental(f, cat, ps),
    management:    leverManagement(f, cat),
    sentiment:     leverSentiment(ps, cat),
    institutional: leverInstitutional(macroData),
    sector_timing: leverSectorTiming(peerMedian, cat, peerCount),
    macro_pestle:  leverMacro(macroData, cat),
    competitive:   leverCompetitive(ps, f, cat, peerMedian, peerCount),
    risk_adjusted: leverRiskAdjusted(ps, cat),
  };

  const levers = {};
  const sources = {};
  const details = {};
  for (const [k, v] of Object.entries(L)) {
    levers[k] = v.score; sources[k] = v.source; details[k] = v.detail;
  }

  const total = Object.values(levers).reduce((a, b) => a + b, 0);
  const composite = Math.round((total / 90) * 100);   // 90 = 9 levers × 10

  // How much of this score was measured rather than assumed. The dry-run
  // harness prints it, and it belongs on the audit trail: a composite built
  // mostly from baselines is a weaker claim than one built from data, even
  // when the number is identical.
  const measuredCount = Object.values(sources).filter(s => s === 'measured').length;

  /**
   * THE NO-DATA RULE.
   *
   * An instrument with no usable price history has nothing measured about its
   * own behaviour — only category baselines and market-wide figures. It
   * previously still scored 74 on constants and published as a BUY. A
   * directional call on something never measured is exactly the kind of claim
   * this platform's track record exists to rule out.
   *
   * `insufficient_data` tells the caller to publish WATCH with a reason
   * instead of a direction, whatever the composite says.
   */
  const hasOwnPriceData = !!(ps && (ps.data_points || 0) >= MIN_POINTS_MOMENTUM);
  const insufficient_data = !hasOwnPriceData;

  return {
    ...levers,
    composite,
    _audit: {
      sources, details,
      measured_levers: measuredCount,
      total_levers: 9,
      data_points: ps?.data_points ?? 0,
      insufficient_data,
      insufficient_reason: insufficient_data
        ? (metrics?.price_reason || 'no price history available for this instrument')
        : null,
    },
  };
}

module.exports = {
  scoreInstrument,
  leverTechnical, leverFundamental, leverManagement, leverSentiment,
  leverInstitutional, leverSectorTiming, leverMacro, leverCompetitive,
  leverRiskAdjusted,
  band, bandLower, lv, BASELINE, baseFor,
  MIN_POINTS_TECHNICAL, MIN_POINTS_RISK, MIN_POINTS_MOMENTUM,
};
