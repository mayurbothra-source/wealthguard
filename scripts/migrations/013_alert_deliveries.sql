-- 013: alert_deliveries — one row per (client, alert event).
-- Purpose: holding alerts (stop-loss reached, CRITICAL AI flag) and flash alerts are
-- emailed at most once per event per client, and every send is logged with its
-- recipient (client or admin), provider message id and error.
-- Additive and idempotent: safe to run more than once.
-- Rollback: DROP TABLE IF EXISTS public.alert_deliveries;
--           (without the table, holding alerts are NOT emailed — fail-safe against repeats)

CREATE TABLE IF NOT EXISTS public.alert_deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  event_key            text NOT NULL,
  event_type           text NOT NULL,
  recipient            text NOT NULL CHECK (recipient IN ('client', 'admin')),
  status               text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  provider_message_id  text,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_deliveries_client_event_uq
  ON public.alert_deliveries (client_id, event_key);

ALTER TABLE public.alert_deliveries ENABLE ROW LEVEL SECURITY;

SELECT to_regclass('public.alert_deliveries') AS table_exists,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.alert_deliveries'::regclass) AS rls_on;
