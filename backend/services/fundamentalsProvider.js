/**
 * WealthGuard — per-instrument fundamentals and price statistics
 *
 * WHY THIS EXISTS
 * ---------------
 * Five of the nine analytical levers were hardcoded category lookup tables.
 * Every large-cap equity scored exactly 7 for fundamental, 7 for management,
 * 7 for competitive positioning and 7 for risk-adjusted return — forever,
 * regardless of the instrument. Two large-caps on the same day differed by a
 * single point, and that point came from `sentiment`.
 *
 * The consequence was that the signal was decided by asset CATEGORY rather
 * than by anything about the instrument: G-Secs scored 70-81 and were a
 * permanent BUY at any price, while mid- and small-caps topped out at 66 and
 * 60 and could never reach BUY at all.
 *
 * This module supplies the real per-instrument inputs those levers need.
 *
 * THREE DATA SOURCES, DELIBERATELY RANKED BY RELIABILITY
 * -------------------------------------------------------
 * 1. Yahoo's chart endpoint (v8/finance/chart with range=1y), for equities,
 *    ETFs and anything else priced via Yahoo. This is the SAME endpoint
 *    marketData.js already uses successfully in production, so its response
 *    shape is known-good. One year of daily closes yields:
 *
 *      realized volatility · Sharpe-like ratio · max drawdown
 *      RSI(14) · 50/200 DMA position · 1m/3m/6m/1y returns
 *      distance from the 52-week high and low
 *
 *    Four levers become genuinely per-instrument from this alone.
 *
 * 2. MFAPI's full (non-/latest) NAV history endpoint, for mutual funds
 *    (price_source = 'mfapi'). Until this was added, mutual funds only ever
 *    had a single current NAV point (via marketData.getMFNav) and NO history
 *    at all — which meant every mutual fund permanently failed the no-data
 *    rule below and was capped at WATCH regardless of its real score. MFAPI's
 *    full history is the same computation as #1 above, just fed NAV values
 *    instead of stock closes — same four levers, same maths, same reliability.
 *
 * 3. Yahoo's quoteSummary endpoint, for PE, price-to-book, ROE,
 *    debt-to-equity, profit margin and earnings growth. This one is LESS
 *    reliable — Yahoo has progressively restricted it and it may require a
 *    cookie/crumb handshake. It is therefore treated as optional: when it
 *    fails, the two levers that depend on it fall back to the old category
 *    baseline and say so in the log. The four price-derived levers are
 *    unaffected. This only applies to individual companies — funds, ETFs,
 *    bonds and gold have no PE or ROE and are never asked for it.
 *
 * NOTHING HERE FAILS SILENTLY. A missing feed produces `null` for the
 * affected metrics and an explicit reason string, which the scoring engine
 * turns into a neutral score plus a visible note — never an invented number.
 */

'use strict';

const axios = require('axios');
const db = require('../lib/db');
const { getMFNavHistory } = require('./marketData');

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Yahoo tolerates automated requests but not a burst of 120. The weekly
// scoring run has plenty of time, so pace it.
const FETCH_GAP_MS      = 350;
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_MAX_AGE_HRS  = 30;   // one scoring cycle plus slack

// Trading days, for annualising
const TRADING_DAYS_YEAR = 252;

// India's ~10-year G-Sec yield, used as the risk-free rate in the Sharpe
// calculation. A rough figure is fine: it shifts every instrument's ratio by
// the same amount, and the lever is scored on relative standing.
const RISK_FREE_ANNUAL_PCT = 7.0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════════
   PURE MATHS — no I/O, fully unit-testable
   ══════════════════════════════════════════════════════════════════ */

/** Daily simple returns from a close series. */
function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const p0 = closes[i - 1], p1 = closes[i];
    if (!p0 || !p1 || !isFinite(p0) || !isFinite(p1)) continue;
    out.push((p1 - p0) / p0);
  }
  return out;
}

/** Annualised realized volatility, in percent. */
function annualisedVolatility(closes) {
  const r = dailyReturns(closes);
  if (r.length < 20) return null;           // too short to mean anything
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_YEAR) * 100;
}

/**
 * Sharpe-like ratio: (annualised return − risk-free) / annualised volatility.
 *
 * This is what lever 9 was always supposed to measure — "expected return per
 * unit of risk taken" — and it is computable exactly, per instrument, from
 * the price history. It was a category constant instead.
 */
function sharpeRatio(closes) {
  const vol = annualisedVolatility(closes);
  if (vol == null || vol === 0) return null;
  const first = closes.find(c => c && isFinite(c));
  const last  = [...closes].reverse().find(c => c && isFinite(c));
  if (!first || !last) return null;
  const years = closes.length / TRADING_DAYS_YEAR;
  if (years <= 0) return null;
  // Annualised (CAGR) rather than simple, so a 2-year series is not flattered
  const cagrPct = (Math.pow(last / first, 1 / years) - 1) * 100;
  return (cagrPct - RISK_FREE_ANNUAL_PCT) / vol;
}

/** Worst peak-to-trough fall in the window, as a negative percent. */
function maxDrawdown(closes) {
  let peak = null, worst = 0;
  for (const c of closes) {
    if (!c || !isFinite(c)) continue;
    if (peak === null || c > peak) peak = c;
    const dd = ((c - peak) / peak) * 100;
    if (dd < worst) worst = dd;
  }
  return closes.length >= 20 ? worst : null;
}

/** Wilder's RSI over `period` days. */
function rsi(closes, period = 14) {
  const r = dailyReturns(closes);
  if (r.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 0; i < period; i++) {
    if (r[i] >= 0) gain += r[i]; else loss -= r[i];
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period; i < r.length; i++) {
    const g = r[i] > 0 ? r[i] : 0;
    const l = r[i] < 0 ? -r[i] : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/** Simple moving average of the last `n` closes. */
function sma(closes, n) {
  const valid = closes.filter(c => c && isFinite(c));
  if (valid.length < n) return null;
  const tail = valid.slice(-n);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

/**
 * Percent return over the last `days` trading days.
 *
 * Yahoo's range=1y returns roughly 248-252 trading days, not 253, so a strict
 * `length >= days + 1` test made return_1y null for virtually every
 * instrument in production. Instead: use the full window when at least 80% of
 * the requested period is present, and report null below that. 80% of a year
 * is still a year-ish return; 40% of one is not, and would quietly mislead.
 */
function trailingReturn(closes, days, minCoverage = 0.8) {
  const valid = closes.filter(c => c && isFinite(c));
  if (valid.length < 2) return null;
  const available = valid.length - 1;               // usable lookback
  if (available < Math.floor(days * minCoverage)) return null;
  const span = Math.min(days, available);
  const then = valid[valid.length - 1 - span];
  const now  = valid[valid.length - 1];
  if (!then) return null;
  return ((now - then) / then) * 100;
}

/**
 * Computes every price-derived statistic from a close series.
 * Returns nulls (never guesses) for anything the series is too short for, so
 * the scoring engine can tell "neutral because no data" from "neutral because
 * the data says neutral".
 */
function computePriceStats(closes) {
  const valid = (closes || []).filter(c => c && isFinite(c));
  const last  = valid[valid.length - 1] ?? null;
  const ma50  = sma(valid, 50);
  const ma200 = sma(valid, 200);
  const high52 = valid.length ? Math.max(...valid) : null;
  const low52  = valid.length ? Math.min(...valid) : null;

  return {
    data_points:  valid.length,
    last_close:   last,
    volatility_pct: annualisedVolatility(valid),
    sharpe:       sharpeRatio(valid),
    max_drawdown_pct: maxDrawdown(valid),
    rsi_14:       rsi(valid, 14),
    ma_50:        ma50,
    ma_200:       ma200,
    // Above both averages is the classic "uptrend intact" condition
    above_ma_50:  (last != null && ma50  != null) ? last > ma50  : null,
    above_ma_200: (last != null && ma200 != null) ? last > ma200 : null,
    golden_cross: (ma50 != null && ma200 != null) ? ma50 > ma200 : null,
    return_1m:    trailingReturn(valid, 21),
    return_3m:    trailingReturn(valid, 63),
    return_6m:    trailingReturn(valid, 126),
    return_1y:    trailingReturn(valid, 252),
    pct_from_52w_high: (last != null && high52) ? ((last - high52) / high52) * 100 : null,
    pct_above_52w_low: (last != null && low52)  ? ((last - low52)  / low52)  * 100 : null,
  };
}

/* ══════════════════════════════════════════════════════════════════
   FETCHING
   ══════════════════════════════════════════════════════════════════ */

/**
 * One year of daily closes. Uses the endpoint marketData.js already relies
 * on, with range/interval parameters added — so the response shape is the
 * one already proven to work against this deployment.
 */
async function fetchPriceHistory(yahooTicker) {
  if (!yahooTicker) return { closes: null, reason: 'no yahoo_ticker on this instrument' };
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`,
      { headers: YAHOO_HEADERS, timeout: REQUEST_TIMEOUT_MS,
        params: { range: '1y', interval: '1d', includePrePost: false } }
    );
    const result = data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes) || !closes.filter(Boolean).length) {
      return { closes: null, reason: 'chart returned no close series' };
    }
    return { closes: closes.filter(c => c != null), reason: null };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}`
      : err.code === 'ECONNABORTED' ? 'timed out' : err.message;
    return { closes: null, reason: `chart fetch failed (${detail})` };
  }
}

/**
 * Company fundamentals. OPTIONAL BY DESIGN — Yahoo has progressively
 * restricted quoteSummary and it may require a cookie/crumb handshake this
 * module deliberately does not attempt. A failure here costs two levers,
 * which fall back to the category baseline and log that they did. It never
 * costs the four price-derived levers.
 */
async function fetchFundamentals(yahooTicker) {
  if (!yahooTicker) return { data: null, reason: 'no yahoo_ticker' };
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}`,
      { headers: YAHOO_HEADERS, timeout: REQUEST_TIMEOUT_MS,
        params: { modules: 'defaultKeyStatistics,financialData,summaryDetail' } }
    );
    const r = data?.quoteSummary?.result?.[0];
    if (!r) return { data: null, reason: 'quoteSummary returned no result' };

    // Yahoo wraps numbers as { raw, fmt }. Accept either shape.
    const num = v => {
      if (v == null) return null;
      const n = typeof v === 'object' ? v.raw : v;
      return (typeof n === 'number' && isFinite(n)) ? n : null;
    };

    const ks = r.defaultKeyStatistics || {};
    const fd = r.financialData       || {};
    const sd = r.summaryDetail       || {};

    const out = {
      trailing_pe:     num(sd.trailingPE) ?? num(ks.trailingPE),
      forward_pe:      num(sd.forwardPE)  ?? num(ks.forwardPE),
      price_to_book:   num(ks.priceToBook),
      return_on_equity: num(fd.returnOnEquity),        // fraction, e.g. 0.18
      debt_to_equity:  num(fd.debtToEquity),           // percent, e.g. 45.2
      profit_margin:   num(fd.profitMargins),          // fraction
      operating_margin: num(fd.operatingMargins),
      earnings_growth: num(fd.earningsGrowth),         // fraction
      revenue_growth:  num(fd.revenueGrowth),
      market_cap:      num(sd.marketCap) ?? num(ks.marketCap ?? null),
    };
    const anything = Object.values(out).some(v => v != null);
    if (!anything) return { data: null, reason: 'quoteSummary had no usable fields' };
    return { data: out, reason: null };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}`
      : err.code === 'ECONNABORTED' ? 'timed out' : err.message;
    return { data: null, reason: `quoteSummary unavailable (${detail})` };
  }
}

/* ══════════════════════════════════════════════════════════════════
   CACHE
   ══════════════════════════════════════════════════════════════════ */

async function loadCache() {
  const rows = await db.select('instrument_fundamentals', c =>
    c.from('instrument_fundamentals').select('*'));
  const map = {};
  (rows || []).forEach(r => { map[r.symbol] = r; });
  return map;
}

function isFresh(row) {
  if (!row?.refreshed_at) return false;
  const ageHrs = (Date.now() - new Date(row.refreshed_at).getTime()) / 3600000;
  return ageHrs < CACHE_MAX_AGE_HRS;
}

/* ══════════════════════════════════════════════════════════════════
   PUBLIC ENTRY POINT
   ══════════════════════════════════════════════════════════════════ */

/**
 * Builds a metrics map keyed by symbol, for the instruments supplied.
 *
 * @param {Array}  instruments  rows from instrument_universe
 * @param {object} [opts]
 * @param {boolean} opts.force    ignore the cache and refetch everything
 * @param {boolean} opts.noWrite  compute but do not persist (dry runs)
 * @returns {Promise<{metrics: object, summary: object}>}
 */
async function buildMetrics(instruments, opts = {}) {
  const { force = false, noWrite = false } = opts;
  const cache = force ? {} : await loadCache();

  const metrics = {};
  const summary = {
    total: instruments.length,
    from_cache: 0, fetched: 0,
    with_price_history: 0, with_fundamentals: 0,
    no_price_feed: 0, fundamentals_unavailable: 0,
    reasons: {},
  };

  const note = reason => {
    if (!reason) return;
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
  };

  for (const inst of instruments) {
    const symbol = inst.symbol;
    if (!symbol) continue;

    const cached = cache[symbol];
    if (cached && isFresh(cached)) {
      metrics[symbol] = {
        ...cached,
        price_stats: cached.price_stats || null,
        fundamentals: cached.fundamentals || null,
      };
      summary.from_cache++;
      if (cached.price_stats?.data_points) summary.with_price_history++;
      else summary.no_price_feed++;
      if (cached.fundamentals) summary.with_fundamentals++;
      else summary.fundamentals_unavailable++;
      continue;
    }

    // A statically-priced instrument has no history to fetch, and that is a
    // fact about the instrument, not a failure.
    const staticPriced = inst.price_source === 'static' || inst.price_source === 'static_reference';
    // Mutual funds route through MFAPI for price, not Yahoo. Until now nothing
    // ever fetched their NAV *history* — only the single current NAV via
    // getMFNav — so every mutual fund failed the no-data rule and was capped
    // at WATCH forever regardless of its real score. getMFNavHistory pulls
    // MFAPI's full historical series (same shape/role as Yahoo's chart data
    // for equities), so funds now get real technical/sentiment/risk-adjusted
    // levers instead of a permanent "no yahoo_ticker" excuse.
    const isMutualFund = inst.price_source === 'mfapi';

    let priceStats = null, priceReason = null;
    if (staticPriced) {
      priceReason = 'statically priced — no market history exists';
    } else if (isMutualFund) {
      const { closes, reason } = await getMFNavHistory(inst.amfi_code);
      priceReason = reason;
      if (closes) priceStats = computePriceStats(closes);
      await sleep(FETCH_GAP_MS);
    } else {
      const { closes, reason } = await fetchPriceHistory(inst.yahoo_ticker);
      priceReason = reason;
      if (closes) priceStats = computePriceStats(closes);
      await sleep(FETCH_GAP_MS);
    }

    // Fundamentals only make sense for a listed company. A fund, ETF, bond or
    // gold instrument has no PE or ROE, so we do not pretend to look.
    const isCompany = ['large_cap_equity', 'mid_cap_equity', 'small_cap_equity'].includes(inst.category);
    let fundamentals = null, fundReason = null;
    if (isCompany && !staticPriced) {
      const f = await fetchFundamentals(inst.yahoo_ticker);
      fundamentals = f.data; fundReason = f.reason;
      await sleep(FETCH_GAP_MS);
    } else if (!isCompany) {
      fundReason = 'not a listed company — company fundamentals do not apply';
    }

    metrics[symbol] = {
      symbol,
      category: inst.category,
      price_stats: priceStats,
      fundamentals,
      price_reason: priceReason,
      fundamentals_reason: fundReason,
      refreshed_at: new Date().toISOString(),
    };

    summary.fetched++;
    if (priceStats?.data_points) summary.with_price_history++; else { summary.no_price_feed++; note(priceReason); }
    if (fundamentals) summary.with_fundamentals++; else { summary.fundamentals_unavailable++; note(fundReason); }
  }

  // Peer context: relative strength needs the category's own median return,
  // which can only be computed once every instrument has been measured.
  // This is what turns lever 8 from a constant into "is this beating its
  // peers" — a real competitive-position measure.
  const byCategory = {};
  for (const m of Object.values(metrics)) {
    const r = m.price_stats?.return_3m;
    if (r == null) continue;
    (byCategory[m.category] = byCategory[m.category] || []).push(r);
  }
  const medians = {};
  for (const [cat, arr] of Object.entries(byCategory)) {
    const s = [...arr].sort((a, b) => a - b);
    medians[cat] = s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }
  for (const m of Object.values(metrics)) {
    m.peer_median_return_3m = medians[m.category] ?? null;
    m.peer_count = (byCategory[m.category] || []).length;
  }
  summary.category_medians = medians;

  if (!noWrite) {
    for (const m of Object.values(metrics)) {
      await db.tryWrite('instrument_fundamentals', 'upsert', c =>
        c.from('instrument_fundamentals').upsert({
          symbol:               m.symbol,
          category:             m.category,
          price_stats:          m.price_stats,
          fundamentals:         m.fundamentals,
          price_reason:         m.price_reason,
          fundamentals_reason:  m.fundamentals_reason,
          peer_median_return_3m: m.peer_median_return_3m,
          refreshed_at:         m.refreshed_at || new Date().toISOString(),
        }, { onConflict: 'symbol' }));
    }
  }

  return { metrics, summary };
}

/** One line so a scoring run cannot look clean while flying blind. */
function logSummary(summary) {
  console.log(`   Fundamentals: ${summary.with_price_history}/${summary.total} with price history, ` +
              `${summary.with_fundamentals}/${summary.total} with company fundamentals ` +
              `(${summary.from_cache} cached, ${summary.fetched} fetched)`);
  if (summary.no_price_feed) {
    console.warn(`   ⚠ ${summary.no_price_feed} instrument(s) have no price history. ` +
                 `Those cannot receive a directional signal — see the reasons below.`);
  }
  for (const [reason, n] of Object.entries(summary.reasons)) {
    console.log(`      ${n}x ${reason}`);
  }
}

module.exports = {
  buildMetrics, logSummary,
  // exported for tests and the dry-run harness
  computePriceStats, annualisedVolatility, sharpeRatio, maxDrawdown,
  rsi, sma, trailingReturn, dailyReturns,
  fetchPriceHistory, fetchFundamentals,
  RISK_FREE_ANNUAL_PCT,
};
