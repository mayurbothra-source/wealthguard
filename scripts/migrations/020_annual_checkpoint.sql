-- 020: Annual checkpoint for the prediction ledger.
-- Each signal is now also scored 365 days after it was issued (±5 trading days).
-- Additive and idempotent.
-- Rollback: ALTER TABLE recommendation_outcomes DROP COLUMN IF EXISTS return_1y_pct;
ALTER TABLE recommendation_outcomes ADD COLUMN IF NOT EXISTS return_1y_pct numeric;
