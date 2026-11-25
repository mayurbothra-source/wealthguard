-- 011: brief_deliveries — one row per client per IST date for the morning-brief email.
-- Purpose: makes delivery idempotent (unique client_id + ist_date) so any number of
-- triggers (cron, catch-up, GitHub job, admin) can never send a client two briefs in a day,
-- and records the provider message id / error for every send.
-- Additive and idempotent: safe to run more than once.
-- Rollback: DROP TABLE IF EXISTS public.brief_deliveries;
--           (the backend falls back to morning_briefs.email_sent when the table is absent)

CREATE TABLE IF NOT EXISTS public.brief_deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  ist_date             date NOT NULL,
  status               text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'skipped_late')),
  attempts             integer NOT NULL DEFAULT 0,
  trigger              text,
  provider_message_id  text,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brief_deliveries_client_date_uq
  ON public.brief_deliveries (client_id, ist_date);
CREATE INDEX IF NOT EXISTS brief_deliveries_date_idx
  ON public.brief_deliveries (ist_date);

-- Server-only table: RLS on, no policies, so only the service role can read or write it.
ALTER TABLE public.brief_deliveries ENABLE ROW LEVEL SECURITY;

-- Check
SELECT to_regclass('public.brief_deliveries') AS table_exists,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.brief_deliveries'::regclass) AS rls_on;
