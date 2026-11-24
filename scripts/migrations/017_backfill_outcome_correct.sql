-- 017: back-fill recommendations.outcome_correct from recommendation_outcomes (SA2)
--
-- Strictest checkpoint wins: any checkpoint wrong → false; all verdicts right
-- → true. Checkpoints without a verdict (WATCH, not_measurable, inconclusive)
-- are ignored; a recommendation with no verdict at all is left NULL.
-- From now on the track record engine keeps this in step on every run.
--
-- Idempotent: only rows whose value differs are touched.
-- Run AFTER 016 and after the SA1 backfill, and again after SA3's re-score (018).
--
-- Rollback: before this migration 0 of 2,005 rows had a value, so
--   UPDATE recommendations SET outcome_correct = NULL WHERE outcome_correct IS NOT NULL;
-- restores the previous state exactly.

UPDATE recommendations r
   SET outcome_correct = v.val
  FROM (
    SELECT recommendation_id,
           CASE WHEN bool_or(direction_correct = false) THEN false ELSE true END AS val
      FROM recommendation_outcomes
     WHERE direction_correct IS NOT NULL
     GROUP BY recommendation_id
  ) v
 WHERE r.id = v.recommendation_id
   AND r.outcome_correct IS DISTINCT FROM v.val;

-- Acceptance (must return 0):
-- SELECT count(*) FROM recommendations WHERE outcome_correct IS NULL
--   AND id IN (SELECT DISTINCT recommendation_id FROM recommendation_outcomes WHERE direction_correct IS NOT NULL);
