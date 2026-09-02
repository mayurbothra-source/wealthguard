/**
 * MarketDataService
 * Fetches real-time and EOD data from NSE India, Yahoo Finance, MFAPI, and macro sources.
 * Falls back to demo data when APIs are unavailable (development mode).
 */
const axios = require('axios');
const { supabaseAdmin } = require('../../config/supabase');

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
};

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── DEMO DATA (used when live APIs unavailable) ────────
const DEMO_PRICES = {
  RELIANCE: { price: 2847.35, change: 0.82, volume: 8432100 },
  TCS:      { price: 3912.50, change: -0.34, volume: 2341200 },
  HDFCBANK: { price: 1678.20, change: 1.12, volume: 12543000 },
  INFY:     { price: 1682.40, change: 0.67, volume: 6723400 },
  ICICIBANK:{ price: 1243.75, change: 0.45, volume: 9876500 },
  TATAMOTORS:{price: 712.30,  change: -0.18, volume: 15234000 },
  SBIN:     { price: 834.50,  change: 1.23, volume: 18456000 },
  NIFTY50:  { price: 24650.25,change: 0.68, volume: 0 },
  INDIAVIX: { price: 13.42,  change: -0.82, volume: 0 },
  GOLDBEES: { price: 5842.00, change: 0.34, volume: 234000 },
};

// Demo fallback for the 4 new Yahoo-sourced items — clearly marked source:'demo'
// downstream, same honesty rule as everything else: never presented as live
// unless it genuinely is.
const DEMO_YAHOO = {
  SENSEX:  { price: 80845.20, change_pct: 0.54 },
  USDINR:  { price: 83.42, change_pct: -0.12 },
  GOLD_USD_OZ: { price: 2620.50, change_pct: 0.31 },
  SILVER_USD_OZ: { price: 30.80, change_pct: 0.85 },
};

const DEMO_MF_NAV = {
  'MF-MIRAE-LC':    { nav: 94.23, date: '2026-08-25', fund_name: 'Mirae Asset Large Cap Fund' },
  'MF-SBI-BC':      { nav: 64.18, date: '2026-08-25', fund_name: 'SBI Bluechip Fund' },
  'MF-PPFAS-FLEXI': { nav: 72.45, date: '2026-08-25', fund_name: 'PPFAS Flexi Cap Fund' },
  'MF-HDFC-LIQUID': { nav: 1548.23, date: '2026-08-25', fund_name: 'HDFC Liquid Fund' },
  'MF-NIPPON-INDEX':{ nav: 184.67, date: '2026-08-25', fund_name: 'Nippon Nifty 50 Index' },
};

// ── NSE QUOTE ──────────────────────────────────────────
async function getNSEQuote(symbol) {
  try {
    const { data } = await axios.get(
      `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`,
      { headers: NSE_HEADERS, timeout: 8000 }
    );
    return {
      symbol,
      price: data.priceInfo?.lastPrice,
      open: data.priceInfo?.open,
      high: data.priceInfo?.intraDayHighLow?.max,
      low:  data.priceInfo?.intraDayHighLow?.min,
      volume: data.tradeInfo?.totalTradedVolume,
      pe_ratio: data.metadata?.pdSymbolPe,
      change_pct: data.priceInfo?.pChange,
      source: 'nse_live'
    };
  } catch {
    // Fall back to demo data
    const demo = DEMO_PRICES[symbol];
    if (demo) return { symbol, price: demo.price, change_pct: demo.change, volume: demo.volume, source: 'demo' };
    return null;
  }
}

// ── NSE INDEX ──────────────────────────────────────────
async function getNSEIndex(indexName = 'NIFTY 50') {
  try {
    const { data } = await axios.get(
      `https://www.nseindia.com/api/allIndices`,
      { headers: NSE_HEADERS, timeout: 8000 }
    );
    const idx = data.data?.find(d => d.indexSymbol === indexName);
    if (!idx) throw new Error('Index not found');
    return {
      name: idx.indexSymbol,
      price: idx.last,
      change_pct: idx.percentChange,
      open: idx.open,
      high: idx.high,
      low: idx.low,
      source: 'nse_live'
    };
  } catch {
    // BUGFIX: this fallback used to always return the Nifty demo price
    // regardless of which index was requested — meaning a blocked NSE
    // request for "INDIA VIX" silently returned ~24,650 mislabeled as VIX,
    // which would make classifyVIXRegime() always report 'crisis' and
    // incorrectly freeze every BUY signal platform-wide. Fixed by making
    // the fallback index-aware.
    const DEMO_INDEX_FALLBACK = {
      'NIFTY 50':   { price: 24650.25, change_pct: 0.68 },
      'INDIA VIX':  { price: 13.42,    change_pct: -0.82 },
    };
    const fallback = DEMO_INDEX_FALLBACK[indexName] || { price: 0, change_pct: 0 };
    return { name: indexName, price: fallback.price, change_pct: fallback.change_pct, source: 'demo' };
  }
}

// ── INDIA VIX ──────────────────────────────────────────
async function getIndiaVIX() {
  try {
    const result = await getNSEIndex('INDIA VIX');
    return result.price || 13.42;
  } catch {
    return 13.42; // demo
  }
}

// ── MUTUAL FUND NAV (MFAPI) ────────────────────────────
async function getMFNav(amfiCode) {
  try {
    const { data } = await axios.get(
      `https://api.mfapi.in/mf/${amfiCode}/latest`,
      { timeout: 8000 }
    );
    return {
      amfi_code: amfiCode,
      nav: parseFloat(data.data?.[0]?.nav),
      date: data.data?.[0]?.date,
      fund_name: data.meta?.fund_house + ' - ' + data.meta?.scheme_name,
      source: 'mfapi_live'
    };
  } catch {
    // Return demo data based on symbol mapping
    return null;
  }
}

// ── FII / DII FLOWS ────────────────────────────────────
async function getFIIDIIFlows() {
  try {
    const { data } = await axios.get(
      `https://www.nseindia.com/api/fiidiiTradeReact`,
      { headers: NSE_HEADERS, timeout: 8000 }
    );
    const today = data?.[0];
    return {
      fii_net_cr: parseFloat(today?.fiiNet || 0) / 10000000,
      dii_net_cr: parseFloat(today?.diiNet || 0) / 10000000,
      date: today?.date,
      source: 'nse_live'
    };
  } catch {
    return { fii_net_cr: 28.40, dii_net_cr: -12.30, source: 'demo' };
  }
}

// ── RBI MACRO DATA ─────────────────────────────────────
async function getMacroIndicators() {
  // RBI DBIE API - repo rate, CPI etc
  // Returning demo values as RBI API requires registration
  return {
    repo_rate: 6.50,
    cpi_latest: 4.83,
    gdp_latest: 7.2,
    usd_inr: 83.42,
    crude_usd: 78.30,
    gsec_10y_yield: 6.98,
    source: 'demo'
  };
}

// ── VIX REGIME CLASSIFICATION ──────────────────────────
function classifyVIXRegime(vix) {
  if (vix < 12)  return { regime: 'calm',     label: 'Greed Zone — exercise caution on new entries', buy_signals_active: true };
  if (vix < 16)  return { regime: 'normal',   label: 'Normal market — all signals active',          buy_signals_active: true };
  if (vix < 20)  return { regime: 'elevated', label: 'Elevated fear — favour High Conviction only', buy_signals_active: true };
  if (vix < 25)  return { regime: 'fear',     label: 'Fear regime — Standard BUY signals paused',   buy_signals_active: false };
  return         { regime: 'crisis',   label: 'CRISIS — all new BUY signals frozen',         buy_signals_active: false };
}

// ── STORE SNAPSHOT TO DB ───────────────────────────────
async function storeSnapshot(instrumentId, quoteData) {
  if (!supabaseAdmin || !instrumentId) return;
  const { error } = await supabaseAdmin.from('market_snapshots').insert({
    instrument_id: instrumentId,
    price_inr:     quoteData.price,
    open_inr:      quoteData.open,
    high_inr:      quoteData.high,
    low_inr:       quoteData.low,
    volume:        quoteData.volume,
    pe_ratio:      quoteData.pe_ratio,
    india_vix:     quoteData.india_vix,
    snapshot_type: quoteData.snapshot_type || 'intraday',
    captured_at:   new Date().toISOString(),
  });
  if (error) console.error('Snapshot store error:', error.message);
}

// ── FULL MARKET REFRESH ────────────────────────────────
// ── YAHOO FINANCE — Sensex, USD/INR, Gold, Silver ──────
// Yahoo's official public API was deprecated years ago, but this unofficial
// endpoint remains widely used and functional as of 2026, and — unlike NSE —
// is generally tolerant of automated requests from cloud servers. It is not
// an officially supported or guaranteed service; if it ever stops responding,
// we fall back honestly to demo data rather than guessing.
async function getYahooQuote(symbol) {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
      { headers: YAHOO_HEADERS, timeout: 8000 }
    );
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta || meta.regularMarketPrice == null) throw new Error('No price in response body — got: ' + JSON.stringify(data).slice(0,200));
    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    const change_pct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return { symbol, price, change_pct: parseFloat(change_pct.toFixed(2)), source: 'yahoo_live' };
  } catch (err) {
    // Previously this swallowed the error completely, making it impossible
    // to tell WHY Yahoo failed (blocked? timeout? changed response shape?)
    // from outside. Now it logs the real reason to Render's logs so we can
    // actually diagnose instead of guessing.
    const detail = err.response
      ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data).slice(0,200)}`
      : err.code === 'ECONNABORTED' ? 'Request timed out after 8s'
      : err.message;
    console.warn(`⚠️  Yahoo quote failed for ${symbol}: ${detail}`);
    return null; // caller decides the demo fallback — never silently invent a price here
  }
}

// Sensex (BSE) — same reliability tier as Nifty, just a different exchange
async function getSensex() {
  const q = await getYahooQuote('^BSESN');
  if (q) return q;
  const demo = DEMO_YAHOO.SENSEX;
  return { symbol: '^BSESN', price: demo.price, change_pct: demo.change_pct, source: 'demo' };
}

// USD/INR — generally the most reliable of the four new feeds (forex pairs
// are lightly restricted almost everywhere)
async function getUsdInr() {
  const q = await getYahooQuote('USDINR=X');
  if (q) return q;
  const demo = DEMO_YAHOO.USDINR;
  return { symbol: 'USDINR=X', price: demo.price, change_pct: demo.change_pct, source: 'demo' };
}

// Gold & Silver — Yahoo only has the GLOBAL spot price (USD per troy ounce),
// not an Indian retail price. We convert to an indicative ₹-per-10g figure
// using the live USD/INR rate. This tracks trend and % moves correctly, but
// will sit below what a local jeweller quotes (import duty, GST, dealer
// premium aren't in a global spot price). Always labeled "indicative" —
// this was an explicit, frozen decision, not an oversight.
// Gold is conventionally quoted in India as ₹ per 10 grams.
const TROY_OUNCE_TO_GRAMS = 31.1035;
const GOLD_UNIT_GRAMS = 10;
// BUGFIX (caught by testing): Silver is conventionally quoted in India as
// ₹ per KILOGRAM (1000g), not per 10g like gold. Using the gold unit here
// initially produced ~₹826 for silver instead of the realistic ~₹80,000+
// per kg — a 100x unit error, not a rounding issue.
const SILVER_UNIT_GRAMS = 1000;

async function getGoldINR(usdInrRate) {
  const q = await getYahooQuote('GC=F');
  const usdInr = usdInrRate || DEMO_YAHOO.USDINR.price;
  if (q) {
    const inrPerUnit = (q.price / TROY_OUNCE_TO_GRAMS) * GOLD_UNIT_GRAMS * usdInr;
    return { price: parseFloat(inrPerUnit.toFixed(2)), unit: 'per 10g', change_pct: q.change_pct, source: 'yahoo_live', indicative: true };
  }
  const demo = DEMO_YAHOO.GOLD_USD_OZ;
  const inrPerUnit = (demo.price / TROY_OUNCE_TO_GRAMS) * GOLD_UNIT_GRAMS * usdInr;
  return { price: parseFloat(inrPerUnit.toFixed(2)), unit: 'per 10g', change_pct: demo.change_pct, source: 'demo', indicative: true };
}

async function getSilverINR(usdInrRate) {
  const q = await getYahooQuote('SI=F');
  const usdInr = usdInrRate || DEMO_YAHOO.USDINR.price;
  if (q) {
    const inrPerUnit = (q.price / TROY_OUNCE_TO_GRAMS) * SILVER_UNIT_GRAMS * usdInr;
    return { price: parseFloat(inrPerUnit.toFixed(2)), unit: 'per kg', change_pct: q.change_pct, source: 'yahoo_live', indicative: true };
  }
  const demo = DEMO_YAHOO.SILVER_USD_OZ;
  const inrPerUnit = (demo.price / TROY_OUNCE_TO_GRAMS) * SILVER_UNIT_GRAMS * usdInr;
  return { price: parseFloat(inrPerUnit.toFixed(2)), unit: 'per kg', change_pct: demo.change_pct, source: 'demo', indicative: true };
}

// Simple in-memory cache — the actual fix for the 429 errors. Without this,
// every page load (and every widget on a page) independently re-fetches
// live data from NSE and Yahoo with zero throttling, which is exactly the
// burst pattern that trips external rate limits. A short cache means rapid
// repeat requests (multiple tabs, multiple components, a user refreshing)
// get served instantly from memory instead of hammering upstream providers.
let _snapshotCache = null;
let _snapshotCacheTime = 0;
const SNAPSHOT_CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function refreshAllMarketData() {
  const now = Date.now();
  if (_snapshotCache && (now - _snapshotCacheTime) < SNAPSHOT_CACHE_TTL_MS) {
    return _snapshotCache;
  }
  console.log('📊 Refreshing market data...');
  const [nifty, vix, flows, macro, sensex, usdInr] = await Promise.all([
    getNSEIndex('NIFTY 50'),
    getIndiaVIX(),
    getFIIDIIFlows(),
    getMacroIndicators(),
    getSensex(),
    getUsdInr(),
  ]);
  // Gold/Silver conversion needs the USD/INR rate we just fetched
  const [gold, silver] = await Promise.all([
    getGoldINR(usdInr.price),
    getSilverINR(usdInr.price),
  ]);
  const regime = classifyVIXRegime(vix);
  const snapshot = { nifty, vix, vixRegime: regime, flows, macro, sensex, usdInr, gold, silver, refreshedAt: new Date().toISOString() };
  console.log(`   Nifty: ${nifty.price} | Sensex: ${sensex.price} [${sensex.source}] | VIX: ${vix} [${regime.regime}]`);
  _snapshotCache = snapshot;
  _snapshotCacheTime = now;
  return snapshot;
}

module.exports = {
  getNSEQuote,
  getNSEIndex,
  getIndiaVIX,
  getMFNav,
  getFIIDIIFlows,
  getMacroIndicators,
  classifyVIXRegime,
  storeSnapshot,
  refreshAllMarketData,
  getYahooQuote,
  getSensex,
  getUsdInr,
  getGoldINR,
  getSilverINR,
  DEMO_PRICES,
  DEMO_MF_NAV,
};
