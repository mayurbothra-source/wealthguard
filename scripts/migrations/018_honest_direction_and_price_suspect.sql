-- 018: honest direction verdicts and suspect prices (SA3)
--
-- Purpose
--   * price_at_checkpoint: the price actually used to score each checkpoint.
--   * Re-apply the SA3 rules to every row written before them:
--       - checkpoint price within ₹0.01 of the entry price → price_suspect,
--         no verdict (dead AMFI codes returned their last NAV for weeks)
--       - BUY correct only if return > 0, SELL/REDUCE only if return < 0;
--         a return that rounds to 0.00% → inconclusive, no verdict
--       - HOLD correct if the price stayed within ±2% of entry
--       - WATCH: unchanged, never a verdict
--   The engine also re-measures these legacy rows at their checkpoint-date
--   price on its next run; this migration makes the stored verdicts honest
--   immediately, without waiting for that.
--
-- Run after 016. Idempotent.
--
-- Rollback: the verdicts before this migration are kept in
-- recommendation_outcomes_pre018 (first run only):
--   UPDATE recommendation_outcomes o
--      SET direction_correct = p.direction_correct, outcome_status = p.outcome_status,
--          not_measurable_reason = p.not_measurable_reason
--     FROM recommendation_outcomes_pre018 p WHERE p.id = o.id;
--   ALTER TABLE recommendation_outcomes DROP COLUMN IF EXISTS price_at_checkpoint;
-- then re-run 017 so outcome_correct follows.

BEGIN;

ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS price_at_checkpoint numeric;

CREATE TABLE IF NOT EXISTS recommendation_outcomes_pre018 AS
  SELECT id, direction_correct, outcome_status, not_measurable_reason FROM recommendation_outcomes;

UPDATE recommendation_outcomes
   SET price_at_checkpoint = actual_price_inr
 WHERE price_at_checkpoint IS NULL AND actual_price_inr IS NOT NULL;

-- Suspect: checkpoint price equals the entry price.
UPDATE recommendation_outcomes o
   SET outcome_status = 'price_suspect',
       direction_correct = NULL,
       not_measurable_reason = 'checkpoint price equals the entry price — likely a feed that stopped updating'
  FROM recommendations r
 WHERE r.id = o.recommendation_id
   AND o.actual_price_inr IS NOT NULL
   AND r.entry_price_inr IS NOT NULL
   AND abs(o.actual_price_inr - r.entry_price_inr) <= 0.01
   AND o.outcome_status IS DISTINCT FROM 'price_suspect';

-- Direction under the SA3 rules for everything else that has a return.
WITH v AS (
  SELECT o.id, upper(r.action) AS act,
         CASE o.checkpoint_label
           WHEN 'Weekly'    THEN o.return_1w_pct
           WHEN '14-Day'    THEN o.return_14d_pct
           WHEN 'Monthly'   THEN o.return_1m_pct
           WHEN 'Quarterly' THEN o.return_3m_pct
         END AS ret
    FROM recommendation_outcomes o
    JOIN recommendations r ON r.id = o.recommendation_id
   WHERE o.outcome_status IS NULL OR o.outcome_status IN ('measured', 'inconclusive')
), d AS (
  SELECT id, act, ret,
         CASE
           WHEN ret IS NULL THEN NULL
           WHEN act IN ('BUY', 'SELL', 'REDUCE') AND abs(ret) < 0.005 THEN NULL
           WHEN act = 'BUY' THEN ret > 0
           WHEN act IN ('SELL', 'REDUCE') THEN ret < 0
           WHEN act = 'HOLD' THEN abs(ret) <= 2
           ELSE NULL
         END AS verdict
    FROM v
)
UPDATE recommendation_outcomes o
   SET direction_correct = d.verdict,
       outcome_status = CASE WHEN d.ret IS NULL THEN o.outcome_status
                             WHEN d.verdict IS NULL AND d.act IN ('BUY', 'SELL', 'REDUCE', 'HOLD') THEN 'inconclusive'
                             ELSE 'measured' END
  FROM d
 WHERE d.id = o.id
   AND (o.direction_correct IS DISTINCT FROM d.verdict OR o.outcome_status IS NULL);

COMMIT;

-- Then re-run 017 so recommendations.outcome_correct follows the new verdicts.
