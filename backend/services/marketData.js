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
  GOLDBEES: { price: 5842.00, change: 0.34, volume: 234000 },
};

// Demo fallback for the 4 new Yahoo-sourced items — clearly marked source:'demo'
// downstream, same honesty rule as everything else: never presented as live
// unless it genuinely is.
const DEMO_YAHOO = {
  USDINR:  { price: 83.42, change_pct: -0.12 },
  GOLD_USD_OZ: { price: 2620.50, change_pct: 0.31 },
  SILVER_USD_OZ: { price: 30.80, change_pct: 0.85 },
};

// ── SUPABASE-BACKED PRICE CACHE ────────────────────────────
// The real fix for data reverting after Render restarts.
// In-memory cache (_snapshotCache) resets every time the free-tier
// server spins down. This layer persists the last verified-live Yahoo
// prices to Supabase so restarts always serve real data, not stale
// hardcoded placeholders from months ago.
const YAHOO_CACHE_KEY = 'yahoo_prices_v1';

async function loadYahooCacheFromSupabase() {
  if (!supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('market_cache')
      .select('data, updated_at')
      .eq('cache_key', YAHOO_CACHE_KEY)
      .single();
    if (!data) return null;
    const ageMs = Date.now() - new Date(data.updated_at).getTime();
    // Use cached value if it's less than 6 hours old — old enough to
    // survive overnight restarts, fresh enough to track real trends.
    if (ageMs < 6 * 60 * 60 * 1000) {
      console.log(`   Using Supabase-cached Yahoo prices (${Math.round(ageMs/60000)} min old)`);
      return data.data;
    }
    return null;
  } catch { return null; }
}

async function saveYahooCacheToSupabase(prices) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('market_cache').upsert({
      cache_key: YAHOO_CACHE_KEY,
      data: prices,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'cache_key' });
  } catch (e) {
    console.warn('Could not save Yahoo prices to Supabase cache:', e.message);
  }
}

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

// ── INDICES (Nifty 50, Sensex, India VIX) ─────────────────
// All index figures come from indexData.js: NSE → Yahoo → Yahoo (2nd host) →
// last stored reading, each with as_of, previous close and trust checks.
// There are deliberately no hard-coded fallback values any more.
const indexData = require('./indexData');
const INDEX_KEY = { 'NIFTY 50': 'nifty', 'INDIA VIX': 'vix', 'SENSEX': 'sensex' };

/** Legacy shape: { name, price, change_pct, source, as_of, status } — price null when missing. */
async function getNSEIndex(indexName = 'NIFTY 50') {
  const key = INDEX_KEY[indexName];
  if (!key) return { name: indexName, price: null, change_pct: null, source: 'none', status: 'missing' };
  const snap = await indexData.getIndexSnapshot();
  const x = snap[key];
  return { name: indexName, price: x.price, change_pct: x.change_pct, prev_close: x.prev_close,
           source: x.source, as_of: x.as_of, status: x.status, unverified: x.unverified };
}

/** VIX with its provenance. price is null when no source and no stored reading exist. */
async function getIndiaVIXQuote() {
  return getNSEIndex('INDIA VIX');
}

/**
 * VIX as a plain number for the risk gate and flash alerts, or null when it is
 * unknown. Callers must handle null (the risk gate treats unknown VIX
 * conservatively); there is no default value.
 */
async function getIndiaVIX() {
  try {
    const q = await getIndiaVIXQuote();
    if (q.price == null) console.warn('   ⚠ India VIX unavailable from every source — treated as unknown');
    return q.price ?? null;
  } catch {
    return null;
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
      // MFAPI dates are dd-mm-yyyy; NAVs are struck at the day's close (IST).
      as_of: (/^(\d{2})-(\d{2})-(\d{4})$/.exec(data.data?.[0]?.date || '') || []).length
        ? (([, d, m, y]) => `${y}-${m}-${d}T15:30:00+05:30`)(/^(\d{2})-(\d{2})-(\d{4})$/.exec(data.data[0].date)) : null,
      fund_name: data.meta?.fund_house + ' - ' + data.meta?.scheme_name,
      source: 'mfapi_live'
    };
  } catch {
    // Return demo data based on symbol mapping
    return null;
  }
}

// ── MUTUAL FUND NAV HISTORY ─────────────────────────────
// Same MFAPI scheme, without /latest — this returns the FULL historical NAV
// series (typically years of daily values), newest first. Mutual funds route
// through MFAPI for price (equities/ETFs use Yahoo), but until now nothing
// ever fetched their history — only ever the single current NAV. That meant
// every mutual fund permanently failed the scoring engine's no-data rule
// (which requires a price *history*, not just a current price) and was
// capped at WATCH forever, regardless of its actual score. This is what
// fundamentalsProvider.js needs to give mutual funds the same technical/
// sentiment/risk-adjusted levers equities already get from Yahoo's history.
async function getMFNavHistory(amfiCode) {
  if (!amfiCode) return { closes: null, reason: 'no amfi_code on this instrument' };
  try {
    const { data } = await axios.get(
      `https://api.mfapi.in/mf/${amfiCode}`,
      { timeout: 10000 }
    );
    const rows = data?.data;
    if (!Array.isArray(rows) || !rows.length) {
      return { closes: null, reason: 'MFAPI returned no NAV history for this code' };
    }
    // MFAPI returns newest-first; the scoring maths (returns, moving averages,
    // drawdown) all expect oldest-first, same order Yahoo's chart data comes in.
    const closes = rows
      .map(r => parseFloat(r.nav))
      .filter(n => !isNaN(n) && n > 0)
      .reverse();
    if (!closes.length) {
      return { closes: null, reason: 'MFAPI history had no valid NAV values' };
    }
    return { closes, reason: null };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}`
      : err.code === 'ECONNABORTED' ? 'timed out' : err.message;
    return { closes: null, reason: `MFAPI history fetch failed (${detail})` };
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
  if (vix == null || isNaN(vix)) return { regime: 'unknown', label: 'India VIX unavailable — volatility cannot be judged', buy_signals_active: true };
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
    // as_of: when this price was true (market time), so callers can tell a live price from a stale one.
    const as_of = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null;
    return { symbol, price, change_pct: parseFloat(change_pct.toFixed(2)), source: 'yahoo_live', as_of };
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

/**
 * Nifty 50 % return between two dates, from Yahoo daily closes (^NSEI).
 * Returns null (never a guess) when either end cannot be priced. Used by the track
 * record to compute honest alpha; it was referenced but never written, so the daily
 * track-record job crashed on every run.
 */
async function getNiftyReturnForPeriod(from, to) {
  try {
    const t1 = Math.floor(new Date(from).getTime() / 1000) - 5 * 86400;
    const t2 = Math.floor(new Date(to).getTime() / 1000) + 86400;
    if (!(t1 > 0) || !(t2 > t1)) return null;
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent('^NSEI')}?period1=${t1}&period2=${t2}&interval=1d`,
      { headers: YAHOO_HEADERS, timeout: 8000 });
    const r = data?.chart?.result?.[0];
    const ts = r?.timestamp, close = r?.indicators?.quote?.[0]?.close;
    if (!ts || !close) return null;
    const want = new Date(from).getTime() / 1000;
    let startIdx = -1;                       // last close on or before the start date
    for (let i = 0; i < ts.length; i++) if (ts[i] <= want + 86400 && close[i] != null) startIdx = i;
    let endIdx = -1;
    for (let i = ts.length - 1; i >= 0; i--) if (close[i] != null) { endIdx = i; break; }
    if (startIdx < 0 || endIdx <= startIdx) return null;
    return parseFloat((((close[endIdx] - close[startIdx]) / close[startIdx]) * 100).toFixed(2));
  } catch (e) {
    console.warn('⚠️  Nifty period return unavailable:', e.message);
    return null;
  }
}

// Sensex (BSE) — from indexData (Yahoo ^BSESN, then the last stored reading). No default.
async function getSensex() {
  const x = (await indexData.getIndexSnapshot()).sensex;
  return { symbol: '^BSESN', price: x.price, change_pct: x.change_pct, prev_close: x.prev_close,
           source: x.source, as_of: x.as_of, status: x.status, unverified: x.unverified };
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
  const [indices, flows, macro, usdInr] = await Promise.all([
    indexData.getIndexSnapshot(),
    getFIIDIIFlows(),
    getMacroIndicators(),
    getUsdInr(),
  ]);
  const [gold, silver] = await Promise.all([
    getGoldINR(usdInr.price),
    getSilverINR(usdInr.price),
  ]);

  // USD/INR, gold and silver: if Yahoo answered, store them; if not, use the
  // stored values (labelled) before the placeholders. Indices have their own store.
  const yahooLive = [usdInr, gold, silver].every(x => x.source === 'yahoo_live');
  if (yahooLive) {
    await saveYahooCacheToSupabase({ usdInr, gold, silver, savedAt: new Date().toISOString() });
  } else {
    const cached = await loadYahooCacheFromSupabase();
    if (cached) {
      if (usdInr.source === 'demo' && cached.usdInr) Object.assign(usdInr, cached.usdInr, { source: 'supabase_cache' });
      if (gold.source === 'demo' && cached.gold) Object.assign(gold, cached.gold, { source: 'supabase_cache' });
      if (silver.source === 'demo' && cached.silver) Object.assign(silver, cached.silver, { source: 'supabase_cache' });
    }
  }

  const asLegacy = (x, symbol) => ({ symbol, name: x.label, price: x.price, change_pct: x.change_pct, prev_close: x.prev_close,
                                     source: x.source, as_of: x.as_of, status: x.status, unverified: x.unverified });
  const nifty = asLegacy(indices.nifty, '^NSEI');
  const sensex = asLegacy(indices.sensex, '^BSESN');
  const vix = indices.vix.price;            // null when unknown — never a default
  const regime = classifyVIXRegime(vix);
  const snapshot = {
    nifty, vix, vixSource: indices.vix.source, vixAsOf: indices.vix.as_of, vixStatus: indices.vix.status,
    vixRegime: regime, flows, macro, sensex, usdInr, gold, silver, indices, refreshedAt: new Date().toISOString(),
  };
  const fmt = x => `${x.price ?? '—'} [${x.source}, ${x.status}${x.unverified ? ', unverified' : ''}]`;
  console.log(`   Nifty: ${fmt(indices.nifty)} | Sensex: ${fmt(indices.sensex)} | VIX: ${fmt(indices.vix)} (${regime.regime})`);
  await indexData.reportIndexWarnings(indices);
  _snapshotCache = snapshot;
  _snapshotCacheTime = now;
  return snapshot;
}

module.exports = {
  getNiftyReturnForPeriod,
  getNSEQuote,
  getNSEIndex,
  getIndiaVIX,
  getIndiaVIXQuote,
  getMFNav,
  getMFNavHistory,
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
