/**
 * Nifty 50, Sensex and India VIX — with where each number came from, when it
 * was true (as_of), the previous close, and whether it can be trusted.
 *
 * Sources, in order (first one that answers wins):
 *   Nifty, VIX : NSE allIndices → Yahoo query1 → Yahoo query2 → last stored reading
 *   Sensex     :                  Yahoo query1 → Yahoo query2 → last stored reading
 * NSE blocks most cloud servers, so in production Yahoo is usually the source.
 * There are NO hard-coded fallback values: if nothing answers and nothing is
 * stored, the figure is `missing` and the brief says so.
 *
 * Every successful reading is stored in market_cache (key index_prices_v2) with
 * a short history, which drives the trust checks:
 *   stale      — as_of is older than the previous trading day (IST, Mon–Fri)
 *   unverified — the day's move is more than 4%, or the value has not changed
 *                over more than 3 days of readings
 * Stale and unverified figures are labelled in the brief and raise one admin
 * warning per day.
 */
'use strict';

const axios = require('axios');
const { supabaseAdmin } = require('../../config/supabase');
const { istDate, istParts } = require('../lib/istTime');

const INDEXES = {
  nifty:  { label: 'Nifty 50',  nse: 'NIFTY 50',  yahoo: '^NSEI' },
  sensex: { label: 'Sensex',    nse: null,        yahoo: '^BSESN' },
  vix:    { label: 'India VIX', nse: 'INDIA VIX', yahoo: '^INDIAVIX' },
};
const CACHE_KEY = 'index_prices_v2';
const MAX_DAILY_MOVE_PCT = 4;
const UNCHANGED_DAYS = 3;
const HISTORY_LEN = 10;

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.nseindia.com/',
};
const YAHOO_HEADERS = { 'User-Agent': NSE_HEADERS['User-Agent'], 'Accept': 'application/json' };

const round2 = n => Math.round(n * 100) / 100;
const pct = (price, prev) => (prev ? round2(((price - prev) / prev) * 100) : null);

// ── fetchers (each returns a reading or null; never throws) ─────────────────

async function fromNse(name, http = axios) {
  try {
    const { data } = await http.get('https://www.nseindia.com/api/allIndices', { headers: NSE_HEADERS, timeout: 8000 });
    const idx = data?.data?.find(d => d.indexSymbol === name || d.index === name);
    if (!idx || idx.last == null) return null;
    const price = Number(idx.last), prev = Number(idx.previousClose) || null;
    const ts = data.timestamp ? new Date(data.timestamp.replace(/(\d{2})-(\w{3})-(\d{4})/, '$2 $1 $3') + ' GMT+0530') : new Date();
    return { price, prev_close: prev, change_pct: idx.percentChange != null ? Number(idx.percentChange) : pct(price, prev),
             as_of: isNaN(ts) ? new Date().toISOString() : ts.toISOString(), source: 'nse' };
  } catch { return null; }
}

async function fromYahoo(ticker, host, http = axios) {
  try {
    const { data } = await http.get(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}`,
      { headers: YAHOO_HEADERS, timeout: 8000, params: { range: '5d', interval: '1d' } });
    const r = data?.chart?.result?.[0];
    const m = r?.meta;
    if (!m || m.regularMarketPrice == null) return null;
    const price = Number(m.regularMarketPrice);
    // Previous close = the last daily close before the current session.
    const closes = (r.indicators?.quote?.[0]?.close || []).filter(x => x != null);
    let prev = Number(m.chartPreviousClose ?? m.previousClose) || null;
    if (closes.length >= 2) prev = Number(closes[closes.length - 2]);
    const asOf = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : new Date().toISOString();
    return { price, prev_close: prev, change_pct: pct(price, prev), as_of: asOf, source: host.startsWith('query1') ? 'yahoo' : 'yahoo-q2' };
  } catch { return null; }
}

// ── cache ────────────────────────────────────────────────────────────────────

async function loadCache() {
  if (!supabaseAdmin) return {};
  try {
    const { data } = await supabaseAdmin.from('market_cache').select('data').eq('cache_key', CACHE_KEY).maybeSingle();
    return (data && data.data) || {};
  } catch { return {}; }
}

async function saveCache(all) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('market_cache').upsert(
      { cache_key: CACHE_KEY, data: all, updated_at: new Date().toISOString() }, { onConflict: 'cache_key' });
  } catch (e) { console.warn(`   ⚠ index cache save failed: ${e.message}`); }
}

/** Adds a reading to the per-index history: one entry per IST trading date (latest wins). */
function withHistory(prevEntry, reading) {
  const d = istDate(new Date(reading.as_of));
  const hist = (prevEntry?.history || []).filter(h => h.d !== d);
  hist.push({ d, price: reading.price });
  hist.sort((a, b) => (a.d < b.d ? -1 : 1));
  return { ...reading, fetched_at: new Date().toISOString(), history: hist.slice(-HISTORY_LEN) };
}

// ── trust checks ─────────────────────────────────────────────────────────────

/** The IST trading date before `date` (Mon–Fri; exchange holidays are not modelled). */
function previousTradingDate(date) {
  const d = new Date(`${date}T12:00:00+05:30`);
  do { d.setUTCDate(d.getUTCDate() - 1); } while ([0, 6].includes(istParts(d).dow));
  return istDate(d);
}

/**
 * @returns {{status:'live'|'stale'|'missing', unverified:boolean, warnings:string[]}}
 */
function assess(entry, now = new Date()) {
  if (!entry || entry.price == null) return { status: 'missing', unverified: false, warnings: ['no reading from any source'] };
  const warnings = [];
  const asOfDate = istDate(new Date(entry.as_of));
  const today = istDate(now);
  // Fresh = today's reading, or the previous trading day's close (normal before 09:15 IST).
  const status = asOfDate >= previousTradingDate(today) ? 'live' : 'stale';
  if (status === 'stale') warnings.push(`last reading is from ${asOfDate}`);

  let unverified = false;
  if (entry.change_pct != null && Math.abs(entry.change_pct) > MAX_DAILY_MOVE_PCT) {
    unverified = true; warnings.push(`daily move of ${entry.change_pct}% is above ${MAX_DAILY_MOVE_PCT}%`);
  }
  const hist = entry.history || [];
  if (hist.length >= 2) {
    const last = hist[hist.length - 1];
    let i = hist.length - 1;
    while (i > 0 && hist[i - 1].price === last.price) i--;
    const spanDays = (new Date(last.d) - new Date(hist[i].d)) / 86400000;
    if (spanDays > UNCHANGED_DAYS) { unverified = true; warnings.push(`value ${last.price} unchanged since ${hist[i].d}`); }
  }
  return { status, unverified, warnings };
}

// ── public API ───────────────────────────────────────────────────────────────

async function fetchIndex(key, http = axios) {
  const def = INDEXES[key];
  if (def.nse) { const r = await fromNse(def.nse, http); if (r) return r; }
  return (await fromYahoo(def.yahoo, 'query1.finance.yahoo.com', http))
      || (await fromYahoo(def.yahoo, 'query2.finance.yahoo.com', http));
}

/**
 * Fetches all three indices, stores fresh readings, and returns each one
 * assessed: { key, label, price, prev_close, change_pct, as_of, source,
 * fetched_at, age_hours, status, unverified, warnings }.
 */
async function getIndexSnapshot({ now = new Date(), http = axios } = {}) {
  const cache = await loadCache();
  const out = {};
  let changed = false;
  for (const key of Object.keys(INDEXES)) {
    const fresh = await fetchIndex(key, http);
    let entry = cache[key] || null;
    if (fresh) { entry = withHistory(entry, fresh); cache[key] = entry; changed = true; }
    const fromCache = !fresh && !!entry;
    const a = assess(entry, now);
    out[key] = {
      key, label: INDEXES[key].label,
      price: entry?.price ?? null, prev_close: entry?.prev_close ?? null, change_pct: entry?.change_pct ?? null,
      as_of: entry?.as_of ?? null, fetched_at: entry?.fetched_at ?? null,
      source: entry ? (fromCache ? `stored (${entry.source})` : entry.source) : 'none',
      age_hours: entry?.as_of ? Math.round((now - new Date(entry.as_of)) / 36e5 * 10) / 10 : null,
      ...a,
    };
  }
  if (changed) await saveCache(cache);
  return out;
}

/** One admin warning per day if any figure is stale, unverified or missing. */
async function reportIndexWarnings(snapshot) {
  const bad = Object.values(snapshot).filter(x => x.status !== 'live' || x.unverified);
  if (!bad.length) return;
  try {
    const { reportRun } = require('./healthEngine');
    await reportRun({
      engineName: 'marketDataSanity', itemsProcessed: 0, itemsExpected: bad.length, itemsFailed: bad.length,
      detail: bad.map(x => `${x.label}: ${x.status}${x.unverified ? ', unverified' : ''} (${x.warnings.join('; ')}; source ${x.source})`).join(' | '),
    });
  } catch (e) { console.warn(`   ⚠ could not report index warnings: ${e.message}`); }
}

module.exports = { INDEXES, getIndexSnapshot, reportIndexWarnings, assess, previousTradingDate, fetchIndex, _test: { fromYahoo, fromNse, withHistory } };
