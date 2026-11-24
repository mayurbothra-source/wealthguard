-- 016: track-record checkpoints (SA1)
--
-- Purpose
--   * New columns so each checkpoint records the date it was measured AT, the
--     close actually used, whether it was measurable, and which run wrote it.
--   * return_14d_pct for the new 14-Day checkpoint (the horizon signals claim).
--   * One outcome per (recommendation, checkpoint): remove duplicates, keeping
--     the most recent, then enforce it with a unique index so two overlapping
--     runs can never double-count a signal.
--
-- Additive and idempotent: safe to run more than once.
--
-- Rollback (the columns are harmless if left; this removes them):
--   DROP INDEX IF EXISTS recommendation_outcomes_rec_checkpoint_uq;
--   ALTER TABLE recommendation_outcomes
--     DROP COLUMN IF EXISTS return_14d_pct, DROP COLUMN IF EXISTS checkpoint_date,
--     DROP COLUMN IF EXISTS price_as_of, DROP COLUMN IF EXISTS outcome_status,
--     DROP COLUMN IF EXISTS not_measurable_reason, DROP COLUMN IF EXISTS run_label;
--   Deleted duplicate rows are copied to recommendation_outcomes_dupes_016 first
--   and can be restored with:
--   INSERT INTO recommendation_outcomes SELECT * FROM recommendation_outcomes_dupes_016;
--   (only after dropping the unique index).

BEGIN;

ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS return_14d_pct        numeric;
ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS checkpoint_date       date;
ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS price_as_of           date;
ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS outcome_status        text;   -- measured | not_measurable (SA3 adds price_suspect, inconclusive)
ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS not_measurable_reason text;
ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS run_label             text;   -- daily | backfill_2026_11

-- Keep a copy of every duplicate before removing it.
CREATE TABLE IF NOT EXISTS recommendation_outcomes_dupes_016
  (LIKE recommendation_outcomes INCLUDING DEFAULTS);

WITH ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY recommendation_id, checkpoint_label
           ORDER BY measured_at DESC NULLS LAST, id DESC) AS rn
  FROM recommendation_outcomes
  WHERE checkpoint_label IS NOT NULL
)
INSERT INTO recommendation_outcomes_dupes_016
SELECT o.* FROM recommendation_outcomes o JOIN ranked r ON r.id = o.id
WHERE r.rn > 1
  AND NOT EXISTS (SELECT 1 FROM recommendation_outcomes_dupes_016 d WHERE d.id = o.id);

DELETE FROM recommendation_outcomes o
USING recommendation_outcomes_dupes_016 d
WHERE o.id = d.id;

-- Rows written before this migration were scored at whatever price was live
-- on the day the job ran. Mark them so they can be told apart.
UPDATE recommendation_outcomes
   SET outcome_status = CASE WHEN actual_price_inr IS NULL THEN 'not_measurable' ELSE 'measured' END,
       run_label = 'legacy_live_price'
 WHERE outcome_status IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS recommendation_outcomes_rec_checkpoint_uq
  ON recommendation_outcomes (recommendation_id, checkpoint_label);

-- The engine pages house signals by date.
CREATE INDEX IF NOT EXISTS recommendations_house_generated_idx
  ON recommendations (generated_at) WHERE client_id IS NULL;

COMMIT;
