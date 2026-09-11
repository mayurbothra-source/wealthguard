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

// Tolerance window — check fires if within ±2 days of the target day.
// For the first run we use a wider window (±14 days) to catch any checkpoints
// that were missed while the engine was being set up. Once the first batch
// of outcomes is logged, reduce this back to 2 for precision going forward.
const CHECKPOINT_TOLERANCE_DAYS = 14;

// Map of non-symbol instrument names to their Yahoo Finance tickers.
// These are instruments logged via v8 using plain names rather than
// NSE symbols — Gold, mutual funds, etc.
const NAME_TO_YAHOO = {
  'Gold':                   'GC=F',
  'Silver':                 'SI=F',
  'Nifty 50':               '^NSEI',
  'Nifty':                  '^NSEI',
  'Sensex':                 '^BSESN',
  'Invesco India Smallcap': null,  // MF — no Yahoo ticker, skip
};

/**
 * Fetch the current market price for a given instrument.
 * Handles both NSE symbols (HDFCBANK, RELIANCE) and plain names
 * (Gold, Invesco India Smallcap) that v8 logs use.
 * Returns null (never fake data) if price unavailable.
 */
async function fetchCurrentPrice(rec) {
  const symbol = rec.instrument_name;

  // Check if this is a known non-symbol name first
  if (Object.prototype.hasOwnProperty.call(NAME_TO_YAHOO, symbol)) {
    const yahooTicker = NAME_TO_YAHOO[symbol];
    if (!yahooTicker) {
      console.warn(`   ⚠ ${symbol}: no Yahoo ticker available — checkpoint skipped`);
      return null;
    }
    try {
      const q = await getYahooQuote(yahooTicker);
      if (q && q.source === 'yahoo_live' && q.price) {
        return { price: q.price, source: 'yahoo_live' };
      }
    } catch {}
    console.warn(`   ⚠ ${symbol}: Yahoo fetch failed — checkpoint skipped`);
    return null;
  }

  // Standard NSE equity symbol — try NSE first, then Yahoo .NS
  try {
    const nseData = await getNSEQuote(symbol);
    if (nseData && nseData.source === 'nse_live' && nseData.price) {
      return { price: nseData.price, source: 'nse_live' };
    }
  } catch {}

  try {
    const yahooSymbol = symbol.includes('.') ? symbol : symbol + '.NS';
    const yahooData = await getYahooQuote(yahooSymbol);
    if (yahooData && yahooData.source === 'yahoo_live' && yahooData.price) {
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
    .select('id, instrument_name, action, entry_price_inr, generated_at, confidence_score')
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
      const correct = isDirectionCorrect(pred.action, returnPct);

      // Build the outcome row — only the relevant checkpoint field is set.
      // client_id is explicitly set to null for house calls — the column
      // allows null for house-level outcomes (client-specific outcomes
      // reference an actual client_id).
      const outcomeRow = {
        recommendation_id: pred.id,
        client_id:         null,
        direction_correct: correct,
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
