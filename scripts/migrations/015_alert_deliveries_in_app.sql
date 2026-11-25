-- 015: allow status 'in_app' on alert_deliveries.
-- Purpose: some alert events are shown in the app only (e.g. a CRITICAL AI flag),
-- with no email; they are still logged once per client so they never repeat.
-- Run after 013. Idempotent.
-- Rollback: ALTER TABLE public.alert_deliveries DROP CONSTRAINT IF EXISTS alert_deliveries_status_check;
--           ALTER TABLE public.alert_deliveries ADD CONSTRAINT alert_deliveries_status_check
--             CHECK (status IN ('sending', 'sent', 'failed'));

ALTER TABLE public.alert_deliveries DROP CONSTRAINT IF EXISTS alert_deliveries_status_check;
ALTER TABLE public.alert_deliveries ADD CONSTRAINT alert_deliveries_status_check
  CHECK (status IN ('sending', 'sent', 'failed', 'in_app'));

SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'alert_deliveries_status_check';
