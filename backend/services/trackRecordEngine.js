/**
 * WealthGuard Track Record Engine
 * Runs daily at 4:30 PM IST (after market close).
 * Automatically checks all pending predictions at their 7/30/90-day
 * checkpoints, fetches current prices, and logs results to Supabase.
 * Replaces the entire manual v8 Tab 2 workflow.
 */

const { supabaseAdmin } = require('../../config/supabase');
const { getNSEQuote, getYahooQuote } = require('./marketData');

// Checkpoint definitions in days
const CHECKPOINTS = [
  { days: 7,  field: 'return_1w_pct',  label: 'Weekly'    },
  { days: 30, field: 'return_1m_pct',  label: 'Monthly'   },
  { days: 90, field: 'return_3m_pct',  label: 'Quarterly' },
];

// Tolerance window — check fires if within ±2 days of the target day
const CHECKPOINT_TOLERANCE_DAYS = 2;

/**
 * Fetch the current market price for a given instrument.
 * Tries NSE first, falls back to Yahoo Finance.
 * Returns null (never fake data) if both fail.
 */
async function fetchCurrentPrice(rec) {
  const symbol = rec.instrument_name;

  // Try NSE for equity symbols
  try {
    const nseData = await getNSEQuote(symbol);
    if (nseData && nseData.source === 'nse_live' && nseData.price) {
      return { price: nseData.price, source: 'nse_live' };
    }
  } catch {}

  // Try Yahoo Finance (.NS suffix for NSE-listed instruments)
  try {
    const yahooSymbol = symbol.includes('.') ? symbol : symbol + '.NS';
    const yahooData = await getYahooQuote(yahooSymbol);
    if (yahooData && yahooData.source === 'yahoo_live' && yahooData.price) {
      return { price: yahooData.price, source: 'yahoo_live' };
    }
    // Also try .BO (BSE) if .NS fails
    const yahooDataBSE = await getYahooQuote(symbol + '.BO');
    if (yahooDataBSE && yahooDataBSE.source === 'yahoo_live' && yahooDataBSE.price) {
      return { price: yahooDataBSE.price, source: 'yahoo_live_bse' };
    }
  } catch {}

  // For mutual funds, gold, bonds — price not available via NSE/Yahoo
  // These need manual price entry for now (flagged in logs)
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
  console.log('📋 Running automated track record checkpoints...');

  const now = new Date();

  // Fetch all house predictions (client_id IS NULL = general/house calls)
  const { data: predictions, error } = await supabaseAdmin
    .from('recommendations')
    .select('id, instrument_name, action, entry_price_inr, generated_at, confidence_score')
    .is('client_id', null)
    .eq('is_active', true)
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
      const correct = isDirectionCorrect(pred.action, returnPct);

      // Build the outcome row — only the relevant checkpoint field is set
      const outcomeRow = {
        recommendation_id: pred.id,
        direction_correct: correct,
        actual_price_inr:  priceData.price,
        price_source:      priceData.source,
        measured_at:       now.toISOString(),
        [checkpoint.field]: parseFloat(returnPct.toFixed(2)),
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
}

module.exports = { runTrackRecordCheckpoints };
