/**
 * MarketDataService
 * Fetches real-time and EOD data from NSE India, MFAPI, and macro sources.
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
    return { name: indexName, price: 24650.25, change_pct: 0.68, source: 'demo' };
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
async function refreshAllMarketData() {
  console.log('📊 Refreshing market data...');
  const [nifty, vix, flows, macro] = await Promise.all([
    getNSEIndex('NIFTY 50'),
    getIndiaVIX(),
    getFIIDIIFlows(),
    getMacroIndicators(),
  ]);
  const regime = classifyVIXRegime(vix);
  const snapshot = { nifty, vix, vixRegime: regime, flows, macro, refreshedAt: new Date().toISOString() };
  console.log(`   Nifty: ${nifty.price} (${nifty.change_pct > 0 ? '+' : ''}${nifty.change_pct}%) | VIX: ${vix} [${regime.regime}]`);
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
  DEMO_PRICES,
  DEMO_MF_NAV,
};
