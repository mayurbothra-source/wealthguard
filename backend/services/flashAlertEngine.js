/**
 * WealthGuard Flash Alert Engine
 * Runs every hour during market hours (9:15 AM – 3:30 PM IST, Mon–Fri).
 * Scans all 100 active instruments for sudden steep moves.
 * Cross-checks India VIX to distinguish stock-specific vs market-wide moves.
 * Never uses fake/demo data — skips an instrument honestly if price unavailable.
 */

const { supabaseAdmin } = require('../../config/supabase');
const { getYahooQuote, getIndiaVIX, getNSEQuote } = require('./marketData');

// Thresholds (frozen in design discussions, Sept 2026)
const THRESHOLD_EQUITY   = 3.0;  // ≥3% hourly move for individual stocks/ETFs
const THRESHOLD_INDEX     = 1.0;  // ≥1% for broad indices (Nifty, Sensex)
const INDEX_SYMBOLS = ['NIFTY50', 'SENSEX', 'INDIAVIX'];

// VIX levels that classify market mood
const VIX_ELEVATED = 20;  // above this = volatile market day, lower flash sensitivity

async function fetchPrice(instrument) {
  // Try NSE first for equity
  if (instrument.exchange === 'NSE' && instrument.instrument_type === 'equity') {
    try {
      const nse = await getNSEQuote(instrument.symbol);
      if (nse && nse.source === 'nse_live') return { price: nse.price, source: 'nse_live' };
    } catch {}
  }
  // Yahoo Finance fallback
  if (instrument.yahoo_ticker) {
    try {
      const yahoo = await getYahooQuote(instrument.yahoo_ticker);
      if (yahoo && yahoo.source === 'yahoo_live') return { price: yahoo.price, source: 'yahoo_live' };
    } catch {}
  }
  return null; // honestly no price — skip this instrument
}

async function getLastHourPrice(instrumentId) {
  if (!supabaseAdmin) return null;
  try {
    const oneHourAgo = new Date(Date.now() - 65 * 60 * 1000).toISOString(); // 65 min buffer
    const { data } = await supabaseAdmin
      .from('instrument_price_hourly')
      .select('price, recorded_at')
      .eq('instrument_id', instrumentId)
      .gte('recorded_at', oneHourAgo)
      .order('recorded_at', { ascending: true })
      .limit(1);
    return data && data.length ? data[0].price : null;
  } catch { return null; }
}

async function storePriceSnapshot(instrumentId, symbol, price, source) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('instrument_price_hourly').insert({
      instrument_id: instrumentId,
      symbol,
      price,
      source,
      recorded_at: new Date().toISOString(),
    });
    // Keep only last 48 hours of data to avoid table bloat
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin.from('instrument_price_hourly')
      .delete().lt('recorded_at', cutoff).eq('symbol', symbol);
  } catch {}
}

async function logFlashAlert(instrument, movePct, priceNow, pricePrev, isMarketWide, vix) {
  if (!supabaseAdmin) return;
  const direction = movePct > 0 ? 'steep_rise' : 'steep_fall';
  const threshold = INDEX_SYMBOLS.includes(instrument.symbol)
    ? THRESHOLD_INDEX : THRESHOLD_EQUITY;

  let contextNote;
  if (isMarketWide) {
    contextNote = `Market-wide move — Nifty and VIX (${vix}) both elevated. May affect multiple holdings.`;
  } else {
    contextNote = `Stock-specific move — broad market calm (VIX ${vix}). Likely an instrument-specific event.`;
  }

  const { data: alert, error } = await supabaseAdmin.from('flash_alerts').insert({
    instrument_id:    instrument.id,
    symbol:           instrument.symbol,
    instrument_name:  instrument.name,
    alert_type:       direction,
    move_pct:         parseFloat(movePct.toFixed(2)),
    price_now:        priceNow,
    price_prev_hour:  pricePrev,
    threshold_used:   threshold,
    is_market_wide:   isMarketWide,
    vix_at_alert:     vix,
    context_note:     contextNote,
    generated_at:     new Date().toISOString(),
  }).select().single();

  if (error) {
    console.error(`   ⚡ Failed to log flash alert for ${instrument.symbol}:`, error.message);
    return null;
  }
  return alert;
}

async function notifyClientsForAlert(alert, instrument) {
  if (!supabaseAdmin || !alert) return 0;
  // Find clients who hold this instrument
  try {
    const { data: holdings } = await supabaseAdmin
      .from('portfolio_holdings')
      .select('client_id')
      .eq('instrument_name', instrument.symbol)
      .eq('is_active', true);

    if (!holdings || !holdings.length) return 0;

    const direction = alert.move_pct > 0 ? '📈 Rising steeply' : '📉 Falling steeply';
    const message = `⚡ FLASH ALERT: ${instrument.name} is ${direction} (${alert.move_pct > 0 ? '+' : ''}${alert.move_pct.toFixed(1)}% this hour). ${alert.context_note}`;

    // Store notification for dashboard display
    const notifications = holdings.map(h => ({
      client_id:    h.client_id,
      type:         'flash_alert',
      title:        `Flash Alert: ${instrument.name}`,
      body:         message,
      instrument_id: instrument.id,
      alert_id:     alert.id,
      is_read:      false,
      created_at:   new Date().toISOString(),
    }));

    await supabaseAdmin.from('client_notifications').insert(notifications);
    await supabaseAdmin.from('flash_alerts')
      .update({ clients_notified: holdings.length })
      .eq('id', alert.id);

    return holdings.length;
  } catch (e) {
    console.warn('   ⚠ Could not notify clients:', e.message);
    return 0;
  }
}

async function isMarketHours() {
  const now = new Date();
  // IST = UTC + 5:30
  const istHours = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const day = (now.getUTCDay() + (istHours < 0 ? -1 : 0) + 7) % 7; // Mon=1, Fri=5
  if (day === 0 || day === 6) return false; // weekend
  const marketOpen  = 9 * 60 + 15;  // 9:15 AM IST
  const marketClose = 15 * 60 + 30; // 3:30 PM IST
  return istHours >= marketOpen && istHours <= marketClose;
}

/**
 * Main engine — called hourly during market hours.
 */
async function runFlashAlertScan() {
  if (!await isMarketHours()) {
    console.log('⚡ Flash alert engine: outside market hours, skipping.');
    return;
  }
  if (!supabaseAdmin) {
    console.log('⚡ Flash alert engine: Supabase not configured, skipping.');
    return;
  }
  console.log('⚡ Running flash alert scan...');

  // Get current VIX for context
  let currentVix = null;
  try {
    currentVix = await getIndiaVIX();
  } catch {}

  // Load all active instruments (not watchlist, not removed)
  const { data: instruments, error } = await supabaseAdmin
    .from('instrument_universe')
    .select('*')
    .eq('status', 'active')
    .eq('is_watchlist', false);

  if (error || !instruments) {
    console.error('⚡ Could not load instruments:', error?.message);
    return;
  }

  // Fetch Nifty move this hour for market-wide context
  let niftyMovePct = null;
  try {
    const niftyQuote = await getNSEQuote('NIFTY 50');
    if (niftyQuote && niftyQuote.source === 'nse_live') {
      niftyMovePct = niftyQuote.change_pct;
    }
  } catch {}
  const isMarketStressed = (Math.abs(niftyMovePct || 0) >= THRESHOLD_INDEX)
    || (currentVix && currentVix > VIX_ELEVATED);

  let alertsFired = 0;

  for (const instrument of instruments) {
    // Skip instruments with no price feed
    if (!instrument.yahoo_ticker && instrument.exchange !== 'NSE') continue;

    const priceData = await fetchPrice(instrument);
    if (!priceData) continue;

    // Store this hour's price snapshot (used next hour for comparison)
    await storePriceSnapshot(instrument.id, instrument.symbol, priceData.price, priceData.source);

    // Get last hour's price
    const prevPrice = await getLastHourPrice(instrument.id);
    if (!prevPrice) continue; // first scan for this instrument — no comparison yet

    const movePct = ((priceData.price - prevPrice) / prevPrice) * 100;
    const threshold = INDEX_SYMBOLS.includes(instrument.symbol)
      ? THRESHOLD_INDEX : THRESHOLD_EQUITY;

    if (Math.abs(movePct) < threshold) continue;

    // Alert fires — determine if market-wide or stock-specific
    const isMarketWide = isMarketStressed && INDEX_SYMBOLS.includes(instrument.symbol);

    console.log(`   ⚡ ALERT: ${instrument.symbol} moved ${movePct.toFixed(1)}% this hour`);
    const alert = await logFlashAlert(
      instrument, movePct, priceData.price, prevPrice, isMarketWide, currentVix
    );
    const notified = await notifyClientsForAlert(alert, instrument);
    alertsFired++;
    if (notified) console.log(`      → ${notified} client(s) notified`);
  }

  if (alertsFired === 0) {
    console.log('⚡ Flash alert scan complete — no steep moves detected.');
  } else {
    console.log(`⚡ Flash alert scan complete — ${alertsFired} alert(s) fired.`);
  }
}

module.exports = { runFlashAlertScan, isMarketHours };
