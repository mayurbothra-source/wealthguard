-- ════════════════════════════════════════════════════════════════════
-- 005_levers_and_track_record.sql
--
-- Supports three changes in the code:
--
--   1. instrument_fundamentals — the per-instrument metrics cache that makes
--      six of the nine levers vary by instrument instead of by category.
--   2. instrument_scores — provenance columns, so any historical score can be
--      read back with how much of it was measured versus assumed.
--   3. recommendation_outcomes + category_accuracy_summary — WATCH stops
--      counting as a correct bearish prediction.
--
-- ⚠ SECTION 3 CHANGES YOUR PUBLISHED ACCURACY NUMBER, and it should go DOWN.
--    That is the point. Read the note there before running it.
--
-- Safe to re-run. Nothing is deleted.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- 1. instrument_fundamentals — the metrics cache
--
-- One row per instrument, refreshed by fundamentalsProvider before each
-- weekly scoring run. Caching matters for two reasons: it avoids 120 Yahoo
-- calls on every run, and it means a Yahoo outage degrades to slightly stale
-- data rather than to no data at all.
--
-- price_stats and fundamentals are JSONB on purpose. The set of metrics will
-- grow as levers are sharpened, and a schema migration per metric would be
-- friction with no benefit — nothing filters on the individual fields.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS instrument_fundamentals (
  symbol                 TEXT PRIMARY KEY,
  category               TEXT,

  -- Computed from one year of daily closes. Keys: data_points, last_close,
  -- volatility_pct, sharpe, max_drawdown_pct, rsi_14, ma_50, ma_200,
  -- above_ma_50, above_ma_200, golden_cross, return_1m/3m/6m/1y,
  -- pct_from_52w_high, pct_above_52w_low.
  price_stats            JSONB,

  -- From Yahoo quoteSummary, listed companies only. Keys: trailing_pe,
  -- forward_pe, price_to_book, return_on_equity, debt_to_equity,
  -- profit_margin, operating_margin, earnings_growth, revenue_growth,
  -- market_cap. NULL for funds, ETFs, bonds and gold — they have no company
  -- fundamentals, which is a fact about the instrument, not a gap.
  fundamentals           JSONB,

  -- Why a feed is absent, in plain English. Stored rather than logged so the
  -- admin panel can explain an unmeasured instrument without a log dive.
  price_reason           TEXT,
  fundamentals_reason    TEXT,

  -- The category's own median 3-month return. Lever 8 (competitive
  -- positioning) scores an instrument against this instead of against a
  -- hardcoded constant.
  peer_median_return_3m  NUMERIC(10,4),

  refreshed_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instr_fund_refreshed ON instrument_fundamentals (refreshed_at DESC);
CREATE INDEX IF NOT EXISTS idx_instr_fund_category  ON instrument_fundamentals (category);


-- ────────────────────────────────────────────────────────────────────
-- 2. instrument_scores — score provenance
--
-- A composite of 74 built from five category constants is a much weaker claim
-- than a 74 built from measured data, even though the number is identical.
-- Without these columns that distinction is unrecoverable after the fact.
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE instrument_scores
  ADD COLUMN IF NOT EXISTS levers_measured    INTEGER,
  ADD COLUMN IF NOT EXISTS price_data_points  INTEGER,
  ADD COLUMN IF NOT EXISTS lever_sources      JSONB;

COMMENT ON COLUMN instrument_scores.levers_measured IS
  'How many of the 9 levers came from live data rather than a category baseline.';
COMMENT ON COLUMN instrument_scores.lever_sources IS
  'Per-lever provenance: measured | baseline | neutral | not-applicable | partial.';


-- ────────────────────────────────────────────────────────────────────
-- 3. recommendation_outcomes — WATCH is not a directional prediction
--
-- ⚠ READ THIS. YOUR PUBLISHED ACCURACY WILL FALL, AND IT SHOULD.
--
-- The old code did this:
--     const bearish = ['SELL', 'REDUCE', 'WATCH'].includes(action);
--     if (bearish) return returnPct <= 0;
--
-- Most instruments scored 50-69 and therefore landed on WATCH. So in any flat
-- or mildly falling week, a large share of the track record was automatically
-- marked correct — for predicting nothing. That is how 80.4% weekly accuracy
-- coexisted with a model whose five constant levers could barely tell two
-- large-caps apart.
--
-- The number was not fabricated, but it was not measuring predictive skill
-- either, and it is the number the whole positioning rests on.
--
-- direction_correct is now NULL for WATCH, and the view below excludes NULL
-- from the numerator AND the denominator. Counting a WATCH as a miss would be
-- as wrong as counting it as a hit — no claim was made.
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE recommendation_outcomes
  ADD COLUMN IF NOT EXISTS watch_outcome TEXT;

COMMENT ON COLUMN recommendation_outcomes.watch_outcome IS
  'For WATCH only: held (within ±3%) | rose_beyond_band | fell_beyond_band. '
  'Reported separately from directional accuracy, never folded into it.';

-- direction_correct must be nullable for this to work at all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='recommendation_outcomes'
               AND column_name='direction_correct' AND is_nullable='NO') THEN
    ALTER TABLE recommendation_outcomes ALTER COLUMN direction_correct DROP NOT NULL;
    RAISE NOTICE 'direction_correct made nullable — WATCH needs to record "no claim".';
  END IF;
END $$;

-- Backfill: every historical WATCH was scored as a bearish prediction. Clear
-- those verdicts and band them instead, so the published history is corrected
-- rather than left overstated alongside honest new rows.
UPDATE recommendation_outcomes o
SET direction_correct = NULL,
    watch_outcome = CASE
      WHEN ABS(COALESCE(o.return_1w_pct, o.return_1m_pct, o.return_3m_pct, 0)) <= 3 THEN 'held'
      WHEN COALESCE(o.return_1w_pct, o.return_1m_pct, o.return_3m_pct, 0) > 3 THEN 'rose_beyond_band'
      ELSE 'fell_beyond_band'
    END
FROM recommendations r
WHERE r.id = o.recommendation_id
  AND UPPER(r.action) = 'WATCH'
  AND o.direction_correct IS NOT NULL;


-- ────────────────────────────────────────────────────────────────────
-- 4. category_accuracy_summary — rebuilt
--
-- The homepage and the Markets Dashboard both read this view.
--
-- The critical change is the denominator: COUNT(*) FILTER (WHERE
-- direction_correct IS NOT NULL). Leaving WATCH rows in the denominator while
-- they can never be in the numerator would push accuracy DOWN artificially —
-- the opposite error, equally wrong.
--
-- ⚠ If your live view has columns beyond these, this replaces it. Run
--   001_verify_schema.sql first, and if the definition differs from what is
--   reconstructed here, send it to me rather than running this section.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW category_accuracy_summary AS
SELECT
  i.category,

  -- Directional accuracy: BUY / SELL / HOLD / REDUCE only
  COUNT(*) FILTER (WHERE o.return_1w_pct IS NOT NULL AND o.direction_correct IS NOT NULL) AS weekly_total,
  COUNT(*) FILTER (WHERE o.return_1w_pct IS NOT NULL AND o.direction_correct IS TRUE)     AS weekly_correct,
  COUNT(*) FILTER (WHERE o.return_1m_pct IS NOT NULL AND o.direction_correct IS NOT NULL) AS monthly_total,
  COUNT(*) FILTER (WHERE o.return_1m_pct IS NOT NULL AND o.direction_correct IS TRUE)     AS monthly_correct,
  COUNT(*) FILTER (WHERE o.return_3m_pct IS NOT NULL AND o.direction_correct IS NOT NULL) AS quarterly_total,
  COUNT(*) FILTER (WHERE o.return_3m_pct IS NOT NULL AND o.direction_correct IS TRUE)     AS quarterly_correct,

  -- Alpha versus the Nifty over the same period
  ROUND(AVG(o.alpha_generated) FILTER (WHERE o.alpha_generated IS NOT NULL), 2) AS avg_alpha,

  -- WATCH reported separately, never mixed into accuracy above
  COUNT(*) FILTER (WHERE o.watch_outcome IS NOT NULL)        AS watch_total,
  COUNT(*) FILTER (WHERE o.watch_outcome = 'held')           AS watch_held,

  MAX(o.measured_at) AS last_measured_at
FROM recommendation_outcomes o
JOIN recommendations      r ON r.id = o.recommendation_id
JOIN instrument_universe  i ON (i.symbol = r.instrument_name OR i.name = r.instrument_name)
GROUP BY i.category;


-- ────────────────────────────────────────────────────────────────────
-- 5. instrument_accuracy_summary — same correction, per instrument
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW instrument_accuracy_summary AS
SELECT
  r.instrument_name,
  COUNT(*) FILTER (WHERE o.return_1w_pct IS NOT NULL AND o.direction_correct IS NOT NULL) AS weekly_total,
  COUNT(*) FILTER (WHERE o.return_1w_pct IS NOT NULL AND o.direction_correct IS TRUE)     AS weekly_correct,
  COUNT(*) FILTER (WHERE o.return_1m_pct IS NOT NULL AND o.direction_correct IS NOT NULL) AS monthly_total,
  COUNT(*) FILTER (WHERE o.return_1m_pct IS NOT NULL AND o.direction_correct IS TRUE)     AS monthly_correct,
  COUNT(*) FILTER (WHERE o.watch_outcome IS NOT NULL)                                     AS watch_total,
  COUNT(*) FILTER (WHERE o.watch_outcome = 'held')                                        AS watch_held
FROM recommendation_outcomes o
JOIN recommendations r ON r.id = o.recommendation_id
GROUP BY r.instrument_name;

GRANT SELECT ON category_accuracy_summary   TO anon, authenticated;
GRANT SELECT ON instrument_accuracy_summary TO anon, authenticated;

NOTIFY pgrst, 'reload schema';


-- ────────────────────────────────────────────────────────────────────
-- VERIFY — expect the totals to FALL and the percentage to change.
-- This is the honest number. Look at it before you publish it.
-- ────────────────────────────────────────────────────────────────────
SELECT category,
       weekly_total, weekly_correct,
       CASE WHEN weekly_total >= 3
            THEN ROUND(100.0 * weekly_correct / weekly_total, 1) END AS weekly_pct,
       watch_total, watch_held,
       avg_alpha
FROM category_accuracy_summary
ORDER BY weekly_total DESC;

-- How many historical checkpoints were WATCH, i.e. how much of the old
-- headline figure was made of predictions that claimed nothing
SELECT
  COUNT(*)                                          AS total_outcomes,
  COUNT(*) FILTER (WHERE direction_correct IS NOT NULL) AS directional,
  COUNT(*) FILTER (WHERE watch_outcome IS NOT NULL)     AS watch_only,
  ROUND(100.0 * COUNT(*) FILTER (WHERE watch_outcome IS NOT NULL)
        / NULLIF(COUNT(*), 0), 1)                       AS pct_that_were_watch
FROM recommendation_outcomes;
