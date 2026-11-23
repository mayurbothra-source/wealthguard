/**
 * Dated price series for track-record checkpoints.
 *
 * The old engine scored every checkpoint against the price on the day it
 * happened to run, so a "Weekly" checkpoint measured 14 days late used a
 * 14-day return. A checkpoint is now scored at the close on its own date,
 * taken from the instrument's daily history:
 *
 *   mutual funds  -> MFAPI full NAV history (dated)
 *   equities/ETFs -> Yahoo daily chart for the period
 *   static price  -> never measurable (a fixed reference price has no return)
 *
 * Each series is fetched once per run and cached, so a backfill across
 * ~2,000 signals makes about one request per instrument.
 */
'use strict';

const axios = require('axios');

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
};
const YAHOO_SPACING_MS = 1200;   // Yahoo rate-limits bursts from cloud IPs
const YAHOO_RETRIES = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastYahooAt = 0;

/** 'DD-MM-YYYY' (MFAPI) -> 'YYYY-MM-DD' */
function mfapiDate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

async function fetchMfapiSeries(amfiCode) {
  const { data } = await axios.get(`https://api.mfapi.in/mf/${amfiCode}`, { timeout: 15000 });
  const rows = Array.isArray(data?.data) ? data.data : [];
  const series = rows
    .map(r => ({ date: mfapiDate(r.date), close: parseFloat(r.nav) }))
    .filter(p => p.date && p.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { series, meta: { scheme_name: data?.meta?.scheme_name || null } };
}

async function fetchYahooSeries(ticker, fromYmd, toYmd) {
  const p1 = Math.floor(new Date(`${fromYmd}T00:00:00Z`).getTime() / 1000) - 10 * 86400;
  const p2 = Math.floor(new Date(`${toYmd}T00:00:00Z`).getTime() / 1000) + 2 * 86400;
  let lastErr;
  for (let attempt = 0; attempt <= YAHOO_RETRIES; attempt++) {
    const wait = lastYahooAt + YAHOO_SPACING_MS * (attempt + 1) - Date.now();
    if (wait > 0) await sleep(wait);
    lastYahooAt = Date.now();
    try {
      const { data } = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`,
        { headers: YAHOO_HEADERS, timeout: 12000 });
      const r = data?.chart?.result?.[0];
      const ts = r?.timestamp || [], close = r?.indicators?.quote?.[0]?.close || [];
      const series = [];
      ts.forEach((t, i) => {
        const c = close[i];
        // Yahoo timestamps are the session open in UTC; +5.5h gives the IST trading date.
        if (c > 0) series.push({ date: new Date((t + 19800) * 1000).toISOString().slice(0, 10), close: c });
      });
      return { series, meta: {} };
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status !== 429 && !(status >= 500)) break;   // only rate limits and server errors are worth retrying
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

let fetchers = { mfapi: fetchMfapiSeries, yahoo: fetchYahooSeries };
/** Tests swap the network fetchers. */
function _setFetchers(f) { fetchers = { ...fetchers, ...f }; }
function _resetFetchers() { fetchers = { mfapi: fetchMfapiSeries, yahoo: fetchYahooSeries }; }

function errorText(e) {
  if (e?.response) return `HTTP ${e.response.status}`;
  if (e?.code === 'ECONNABORTED') return 'timed out';
  return e?.message || String(e);
}

/**
 * A per-run cache. get(instrument) resolves to one of:
 *   { kind: 'series', series, source }
 *   { kind: 'static' }                       — fixed reference price, never measurable
 *   { kind: 'error', reason, retryable }     — could not fetch
 */
function makeSeriesCache({ fromYmd, toYmd }) {
  const cache = new Map();
  async function load(inst) {
    const src = inst.price_source;
    if (src === 'static') return { kind: 'static' };
    try {
      if (src === 'mfapi') {
        if (!inst.amfi_code) return { kind: 'error', reason: 'no AMFI code on the instrument', retryable: false };
        const { series } = await fetchers.mfapi(inst.amfi_code);
        return { kind: 'series', series, source: 'mfapi_history' };
      }
      if (inst.yahoo_ticker) {
        const { series } = await fetchers.yahoo(inst.yahoo_ticker, fromYmd, toYmd);
        return { kind: 'series', series, source: 'yahoo_history' };
      }
      return { kind: 'error', reason: 'no price source on the instrument', retryable: false };
    } catch (e) {
      return { kind: 'error', reason: `price history fetch failed (${errorText(e)})`, retryable: true };
    }
  }
  return {
    get(inst) {
      const key = inst.symbol;
      if (!cache.has(key)) cache.set(key, load(inst));
      return cache.get(key);
    },
    /** Nifty 50 daily closes, for alpha. */
    nifty() {
      if (!cache.has('^NSEI')) {
        cache.set('^NSEI', fetchers.yahoo('^NSEI', fromYmd, toYmd)
          .then(r => ({ kind: 'series', series: r.series, source: 'yahoo_history' }))
          .catch(e => ({ kind: 'error', reason: errorText(e), retryable: true })));
      }
      return cache.get('^NSEI');
    },
  };
}

module.exports = { makeSeriesCache, mfapiDate, _setFetchers, _resetFetchers };
