/**
 * WealthGuard Track Record Engine
 * Runs daily at 4:30 PM IST (after market close).
 * Automatically checks all pending predictions at their 7/30/90-day
 * checkpoints, fetches current prices, and logs results to Supabase.
 * Replaces the entire manual v8 Tab 2 workflow.
 */

const { supabaseAdmin } = require('../../config/supabase');
const { reportRun } = require('./healthEngine');
const { getNSEQuote, getYahooQuote } = require('./marketData');

// Checkpoint definitions in days
const CHECKPOINTS = [
  { days: 7,  field: 'return_1w_pct',  label: 'Weekly'    },
  { days: 30, field: 'return_1m_pct',  label: 'Monthly'   },
  { days: 90, field: 'return_3m_pct',  label: 'Quarterly' },
];

// Tolerance window — check fires if within ±2 days of the target day.
// For the first run we use a wider window (±14 days) to catch any checkpoints
// that were missed while the engine was being set up. Once the first batch
// of outcomes is logged, reduce this back to 2 for precision going forward.
const CHECKPOINT_TOLERANCE_DAYS = 14;

/**
 * Fetches the current price for a prediction, using the SAME source routing
 * as the scoring engine.
 *
 * This is critical for data integrity. Previously this function guessed at a
 * Yahoo ticker from the instrument name, which produced two failure modes:
 *
 *   1. Gold: entry price was Rs.158,660 (Indian retail per 10g) but the
 *      checkpoint fetched GC=F — gold futures in USD per troy ounce (~$4,300).
 *      Result: a reported -97% "return" that never happened.
 *
 *   2. Bonds: tried SGB.NS, GSEC10Y.NS etc. on Yahoo. These do not exist as
 *      exchange tickers, so every bond checkpoint was skipped.
 *
 * The fix is to look the instrument up in instrument_universe and use its
 * declared price_source, exactly as the scoring engine does. If the units of
 * the entry price and the current price cannot be reconciled, we skip the
 * checkpoint rather than publish a meaningless number.
 */
async function fetchCurrentPrice(rec) {
  const symbol = rec.instrument_name;
  if (!supabaseAdmin) return null;

  // Look up the instrument's declared price source
  let instrument = null;
  try {
    const { data } = await supabaseAdmin
      .from('instrument_universe')
      .select('symbol, name, instrument_type, exchange, yahoo_ticker, amfi_code, static_price, price_source')
      .or(`symbol.eq.${symbol},name.eq.${symbol}`)
      .limit(1);
    instrument = data?.[0] || null;
  } catch {}

  if (instrument) {
    // Use the scoring engine's router — single source of truth for pricing
    try {
      const { fetchInstrumentPrice } = require('./instrumentEngine');
      const priceData = await fetchInstrumentPrice(instrument);

      if (priceData) {
        // A static reference price never changes, so a "return" computed
        // against it is always 0% and tells the client nothing. Skip it.
        if (priceData.source === 'static_reference') {
          console.warn(`   ⚠ ${symbol}: static reference price — no meaningful return to measure, skipped`);
          return null;
        }
        return priceData;
      }
    } catch (e) {
      console.warn(`   ⚠ ${symbol}: price router failed — ${e.message}`);
    }
    return null;
  }

  // Not in our universe — this is a legacy manually-logged prediction.
  // Only proceed for plain NSE equity symbols where units are unambiguous.
  const looksLikeNSESymbol = /^[A-Z][A-Z0-9&-]{1,19}$/.test(symbol);
  if (!looksLikeNSESymbol) {
    console.warn(`   ⚠ ${symbol}: not in instrument universe and not a recognisable NSE symbol — skipped`);
    return null;
  }

  try {
    const nseData = await getNSEQuote(symbol);
    if (nseData?.source === 'nse_live' && nseData.price) {
      return { price: nseData.price, source: 'nse_live' };
    }
  } catch {}

  try {
    const yahooData = await getYahooQuote(symbol + '.NS');
    if (yahooData?.source === 'yahoo_live' && yahooData.price) {
      return { price: yahooData.price, source: 'yahoo_live' };
    }
  } catch {}

  console.warn(`   ⚠ No live price available for ${symbol} — checkpoint skipped`);
  return null;
}

/**
 * Determine if a prediction is correct at a given checkpoint.
 * BUY/HOLD: correct if price went up (positive return)
 * SELL/REDUCE/WATCH: correct if price stayed flat or went down
 */
function isDirectionCorrect(action, returnPct) {
  if (!action || returnPct === null || returnPct === undefined) return null;
  const bullish = ['BUY', 'HOLD'].includes(action.toUpperCase());
  const bearish = ['SELL', 'REDUCE', 'WATCH'].includes(action.toUpperCase());
  if (bullish) return returnPct >= 0;
  if (bearish) return returnPct <= 0;
  return null;
}

/**
 * Check whether a specific checkpoint has already been logged for a prediction.
 */
async function checkpointAlreadyLogged(recommendationId, checkpointField) {
  const { data } = await supabaseAdmin
    .from('recommendation_outcomes')
    .select('id')
    .eq('recommendation_id', recommendationId)
    .not(checkpointField, 'is', null)
    .limit(1);
  return (data && data.length > 0);
}

/**
 * Main engine function — called by the daily cron job at 4:30 PM IST.
 * Scans all unresolved predictions and auto-files checkpoints.
 */
async function runTrackRecordCheckpoints() {
  if (!supabaseAdmin) {
    console.log('📋 Track record engine: Supabase not configured, skipping.');
    return;
  }
  const engineStart = Date.now();
  console.log('📋 Running automated track record checkpoints...');

  const now = new Date();

  // Fetch all house predictions that need checkpoint resolution.
  // Critically: we do NOT filter by is_active here.
  // The scoring engine deactivates old signals when it generates new ones,
  // but a prediction that has been deactivated still needs its 7/30/90-day
  // checkpoints resolved — deactivation means "superseded by a newer signal",
  // not "this prediction never happened."
  // We identify predictions that still need resolution by checking whether
  // recommendation_outcomes rows exist for them at each checkpoint.
  const { data: predictions, error } = await supabaseAdmin
    .from('recommendations')
    .select('id, instrument_name, action, entry_price_inr, monday_open_price_inr, generated_at, confidence_score')
    .is('client_id', null)
    .not('entry_price_inr', 'is', null)  // must have an entry price to calculate return
    .order('generated_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('📋 Failed to fetch predictions:', error.message);
    return;
  }
  if (!predictions || !predictions.length) {
    console.log('📋 No predictions to check.');
    return;
  }

  let checked = 0, logged = 0, skipped = 0;

  for (const pred of predictions) {
    const generatedAt = new Date(pred.generated_at);
    const daysOld = (now - generatedAt) / (1000 * 60 * 60 * 24);

    for (const checkpoint of CHECKPOINTS) {
      const windowStart = checkpoint.days - CHECKPOINT_TOLERANCE_DAYS;
      const windowEnd   = checkpoint.days + CHECKPOINT_TOLERANCE_DAYS;
      if (daysOld < windowStart || daysOld > windowEnd) continue;

      checked++;

      // Skip if this checkpoint was already logged
      const alreadyDone = await checkpointAlreadyLogged(pred.id, checkpoint.field);
      if (alreadyDone) { skipped++; continue; }

      // Skip if no entry price (can't calculate return)
      if (!pred.entry_price_inr) {
        console.log(`   ⚠ ${pred.instrument_name}: no entry price — ${checkpoint.label} skipped`);
        skipped++; continue;
      }

      // Fetch current price
      const priceData = await fetchCurrentPrice(pred);
      if (!priceData) { skipped++; continue; }

      const returnPct = ((priceData.price - pred.entry_price_inr) / pred.entry_price_inr) * 100;

      // SANITY GATE — a last line of defence against unit mismatches.
      // No real instrument moves +/-50% in a week or +/-90% in a quarter.
      // A number outside these bounds means the entry price and the current
      // price are in different units (this is exactly how Gold produced a
      // "-97.2%" week). Publishing that would destroy client trust and
      // corrupt every aggregate accuracy figure, so we refuse to store it.
      const IMPLAUSIBLE = { 7: 50, 30: 70, 90: 90 };
      const bound = IMPLAUSIBLE[checkpoint.days] || 70;
      if (Math.abs(returnPct) > bound) {
        console.warn(`   🚫 ${pred.instrument_name} ${checkpoint.label}: computed ${returnPct.toFixed(1)}% ` +
                     `exceeds plausible bound of ±${bound}%. Entry ₹${pred.entry_price_inr}, ` +
                     `current ₹${priceData.price} [${priceData.source}]. ` +
                     `Likely a unit mismatch — checkpoint rejected, not stored.`);
        skipped++;
        continue;
      }

      const correct = isDirectionCorrect(pred.action, returnPct);

      // Fetch the passive baseline so we can compute honest alpha.
      // A BUY that returned +2% in a week the Nifty rose 3% actually
      // underperformed — the track record must show that.
      const niftyReturn = await getNiftyReturnForPeriod(pred.generated_at, now);
      const alpha = niftyReturn !== null
        ? parseFloat((returnPct - niftyReturn).toFixed(2))
        : null;

      // Prefer the Monday-open price as the entry reference where we have it.
      // Signals are generated Sunday evening; the earliest a client could
      // actually act is Monday's open. Using Sunday's close would flatter
      // the track record with a price nobody could have traded at.
      const effectiveEntry = pred.monday_open_price_inr || pred.entry_price_inr;
      const effectiveReturn = effectiveEntry
        ? ((priceData.price - effectiveEntry) / effectiveEntry) * 100
        : returnPct;

      const outcomeRow = {
        recommendation_id:       pred.id,
        client_id:               null,
        direction_correct:       correct,
        actual_price_inr:        priceData.price,
        price_source:            priceData.source,
        checkpoint_label:        checkpoint.label,
        nifty_return_same_period: niftyReturn,
        alpha_generated:         alpha,
        measured_at:             now.toISOString(),
        [checkpoint.field]:      parseFloat(effectiveReturn.toFixed(2)),
      };

      const { error: insertErr } = await supabaseAdmin
        .from('recommendation_outcomes')
        .insert(outcomeRow);

      if (insertErr) {
        console.error(`   ❌ ${pred.instrument_name} ${checkpoint.label}: ${insertErr.message}`);
      } else {
        logged++;
        const icon = correct ? '✓' : '✗';
        console.log(`   ${icon} ${pred.instrument_name} ${checkpoint.label}: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}% (${correct ? 'Correct' : 'Incorrect'}) [${priceData.source}]`);
      }
    }
  }

  console.log(`📋 Track record engine complete: ${checked} checkpoints evaluated, ${logged} logged, ${skipped} skipped.`);

  // Health reporting — if predictions exist but nothing was checked,
  // that is an anomaly worth an immediate alert. This is exactly the
  // silent failure that went undetected for weeks previously.
  await reportRun({
    engineName:     'trackRecordEngine',
    durationMs:     Date.now() - engineStart,
    itemsProcessed: logged,
    itemsExpected:  checked > 0 ? checked : null,
    itemsFailed:    skipped,
    detail:         `${checked} checkpoints in window, ${logged} written, ${skipped} skipped (no price or already logged)`,
  });
}

module.exports = { runTrackRecordCheckpoints };
