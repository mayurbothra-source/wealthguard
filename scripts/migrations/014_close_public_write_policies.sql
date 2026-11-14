-- 014: close public write access.
-- Purpose: 20 tables had a write policy granted to role PUBLIC with `USING (true)`,
-- so anyone holding the anon key (which is public by design — it ships in
-- index.html) could insert, change or delete rows: fake house BUY signals,
-- AI events and flags, scores, opportunities, briefs, subscriptions, email and
-- health logs, notifications. The backend writes with the service-role key,
-- which bypasses RLS, and the frontend never writes through the anon key
-- (checked 14 Nov 2026), so these policies are not needed by anything.
-- Read policies are NOT changed here.
-- Idempotent: DROP POLICY IF EXISTS.
-- Rollback (re-opens the hole — only if something unexpectedly breaks):
--   recreate the dropped policy, e.g.
--   CREATE POLICY write_ai_events ON public.ai_events FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS write_ai_events               ON public.ai_events;
DROP POLICY IF EXISTS write_ai_flags                ON public.ai_instrument_flags;
DROP POLICY IF EXISTS write_ai_log                  ON public.ai_scan_log;
DROP POLICY IF EXISTS write_benchmarks              ON public.category_benchmarks;
DROP POLICY IF EXISTS backend_write_changes         ON public.category_change_log;
DROP POLICY IF EXISTS backend_write_notifications   ON public.client_notifications;
DROP POLICY IF EXISTS discount_own                  ON public.discount_code_usage;
DROP POLICY IF EXISTS write_email                   ON public.email_log;
DROP POLICY IF EXISTS backend_write_alerts          ON public.flash_alerts;
DROP POLICY IF EXISTS backend_write_prices          ON public.instrument_price_hourly;
DROP POLICY IF EXISTS write_review                  ON public.instrument_review_log;
DROP POLICY IF EXISTS backend_write_scores          ON public.instrument_scores;
DROP POLICY IF EXISTS backend_write_instruments     ON public.instrument_universe;
DROP POLICY IF EXISTS backend_write_cache           ON public.market_cache;
DROP POLICY IF EXISTS write_briefs                  ON public.morning_briefs;
DROP POLICY IF EXISTS write_opps                    ON public.opportunities;
DROP POLICY IF EXISTS recs_insert_house             ON public.recommendations;
DROP POLICY IF EXISTS write_gate                    ON public.risk_gate_log;
DROP POLICY IF EXISTS sub_own                       ON public.subscriptions;
DROP POLICY IF EXISTS write_health                  ON public.system_health_log;

-- Check: must return 0 rows (no write policy open to public / anon / authenticated).
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND cmd <> 'SELECT'
  AND roles && ARRAY['public', 'anon', 'authenticated']::name[];
