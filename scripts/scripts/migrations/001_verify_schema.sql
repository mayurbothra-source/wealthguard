-- ════════════════════════════════════════════════════════════════════
-- 001_verify_schema.sql — READ ONLY. Changes nothing.
--
-- WHY THIS EXISTS
-- scripts/schema.sql is stale: the code queries 19 tables it does not
-- define, because the migrations that created them were never committed
-- to the repo. That means nobody can rebuild this database from the
-- repository, and nobody can tell which code/schema mismatches are real
-- bugs and which are just documentation drift.
--
-- This script asks the live database directly. Run it, paste the output
-- back, and every remaining question is settled with evidence instead of
-- inference.
--
-- Run in: Supabase -> SQL Editor -> New Query -> Run
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- CHECK 1 — Which tables actually exist?
-- The code queries all of these. Any row reporting MISSING is a table
-- every query against it is silently failing on.
-- ────────────────────────────────────────────────────────────────────
WITH needed(t) AS (VALUES
  ('clients'), ('client_life_profiles'), ('client_behavioural_profiles'),
  ('client_goals'), ('portfolios'), ('recommendations'),
  ('recommendation_outcomes'), ('morning_briefs'), ('alerts'),
  ('instruments'), ('instrument_universe'), ('instrument_scores'),
  ('instrument_price_hourly'), ('instrument_review_log'),
  ('ai_events'), ('ai_instrument_flags'), ('ai_scan_log'),
  ('opportunities'), ('flash_alerts'), ('category_benchmarks'),
  ('category_change_log'), ('client_notifications'), ('email_log'),
  ('risk_gate_log'), ('system_health_log'), ('subscriptions'),
  ('discount_code_usage'), ('market_cache'), ('sell_signals')
)
SELECT n.t AS table_name,
       CASE WHEN c.table_name IS NULL THEN '>>> MISSING' ELSE 'ok' END AS status
FROM needed n
LEFT JOIN information_schema.tables c
       ON c.table_name = n.t AND c.table_schema = 'public'
ORDER BY status DESC, n.t;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 2 — clients: every column the backend touches.
--
-- `created_at` is already PROVEN absent (your error on 24 Sept), and that
-- single absence is what stopped every trial from ever expiring. The code
-- fix now reads `onboarded_at` instead, so `created_at` is expected to
-- report MISSING here and that is fine. The rest must all exist.
-- ────────────────────────────────────────────────────────────────────
WITH needed(col, used_by) AS (VALUES
  ('onboarded_at',           'subscriptionEngine (trial start — the fix)'),
  ('created_at',             'NO LONGER USED — expected missing, fine'),
  ('email',                  'emailEngine, morningBriefEngine'),
  ('pin_hash',               'routes/auth'),
  ('pin_set',                'routes/auth'),
  ('pin_attempts',           'routes/auth lockout'),
  ('pin_locked_until',       'routes/auth lockout'),
  ('last_login_at',          'routes/auth'),
  ('is_admin',               'admin panel gate'),
  ('onboarding_complete',    'morningBriefEngine, subscriptionEngine'),
  ('subscription_plan',      'routes/payments'),
  ('subscription_status',    'subscriptionEngine, morningBriefEngine'),
  ('subscription_expires_at','subscriptionEngine'),
  ('grace_stage',            'subscriptionEngine grace period'),
  ('payment_failed_at',      'subscriptionEngine grace period'),
  ('referral_code',          'subscriptionEngine referral match'),
  ('referred_by',            'subscriptionEngine referral match'),
  ('referral_months_earned', 'subscriptionEngine referral reward'),
  ('email_alerts_enabled',   'flashAlertEngine, instrumentEngine'),
  ('last_brief_sent_at',     'morningBriefEngine'),
  ('stated_risk_score',      'instrumentEngine client filter')
)
SELECT n.col AS column_name,
       CASE WHEN c.column_name IS NULL THEN '>>> MISSING' ELSE 'ok' END AS status,
       n.used_by
FROM needed n
LEFT JOIN information_schema.columns c
       ON c.table_name = 'clients' AND c.table_schema = 'public'
      AND c.column_name = n.col
ORDER BY status DESC, n.col;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 3 — morning_briefs: the suspected drift.
--
-- morningBriefEngine.js upserts ten columns. schema.sql defines a
-- different, older shape (nifty_prediction, actions_json...), and
-- routes/brief.js still writes THAT shape successfully — which is the
-- evidence the live table is still the old one, and therefore that no
-- brief from the new engine has ever persisted.
--
-- If these report MISSING, run 002_morning_briefs_align.sql.
-- ────────────────────────────────────────────────────────────────────
WITH needed(col) AS (VALUES
  ('market_snapshot'), ('portfolio_note'), ('top_signals'), ('goal_note'),
  ('education_point'), ('full_text'), ('ai_provider'),
  ('email_sent'), ('email_sent_at'), ('whatsapp_message')
)
SELECT n.col AS column_name,
       CASE WHEN c.column_name IS NULL THEN '>>> MISSING' ELSE 'ok' END AS status
FROM needed n
LEFT JOIN information_schema.columns c
       ON c.table_name = 'morning_briefs' AND c.table_schema = 'public'
      AND c.column_name = n.col
ORDER BY status DESC, n.col;

-- And what it actually has today
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'morning_briefs' AND table_schema = 'public'
ORDER BY ordinal_position;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 4 — THE PORTFOLIO SPLIT. The most consequential finding.
--
-- The frontend writes holdings to `portfolios`. Four engines were reading
-- `portfolio_holdings`, which no migration ever created — so no engine had
-- ever seen a client holding. The code fix points all four at
-- `portfolios`.
--
-- Expected: portfolios has rows, portfolio_holdings does not exist (or is
-- empty). If portfolio_holdings DOES exist with rows, tell me — holdings
-- are split across two tables and we need to merge rather than repoint.
-- ────────────────────────────────────────────────────────────────────
SELECT 'portfolios' AS tbl,
       (SELECT COUNT(*) FROM information_schema.tables
         WHERE table_name='portfolios' AND table_schema='public') AS exists_,
       (SELECT COUNT(*) FROM portfolios) AS row_count;

SELECT 'portfolio_holdings' AS tbl,
       (SELECT COUNT(*) FROM information_schema.tables
         WHERE table_name='portfolio_holdings' AND table_schema='public') AS exists_;
-- If exists_ = 1 above, run this too and paste the number:
-- SELECT COUNT(*) AS portfolio_holdings_rows FROM portfolio_holdings;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 5 — recommendations: columns added by the build-phase migration.
-- These are expected to exist. If any is MISSING, signal generation is
-- dropping data.
-- ────────────────────────────────────────────────────────────────────
WITH needed(col) AS (VALUES
  ('entry_price_inr'), ('target_price_inr'), ('stop_loss_inr'),
  ('horizon_days'), ('expected_return_pct'), ('previous_action'),
  ('signal_change_note'), ('risk_gate_veto_reason'),
  ('monday_open_price_inr'), ('is_active'), ('risk_gate_passed')
)
SELECT n.col AS column_name,
       CASE WHEN c.column_name IS NULL THEN '>>> MISSING' ELSE 'ok' END AS status
FROM needed n
LEFT JOIN information_schema.columns c
       ON c.table_name = 'recommendations' AND c.table_schema = 'public'
      AND c.column_name = n.col
ORDER BY status DESC, n.col;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 6 — Are the engines producing anything at all?
-- A zero here tells you which engine to investigate first.
-- ────────────────────────────────────────────────────────────────────
SELECT 'recommendations (active)'    AS what, COUNT(*) AS n FROM recommendations WHERE is_active
UNION ALL SELECT 'recommendation_outcomes',   COUNT(*) FROM recommendation_outcomes
UNION ALL SELECT 'instrument_universe',       COUNT(*) FROM instrument_universe
UNION ALL SELECT 'instrument_scores',         COUNT(*) FROM instrument_scores
UNION ALL SELECT 'instrument_price_hourly',   COUNT(*) FROM instrument_price_hourly
UNION ALL SELECT 'ai_events (active)',        COUNT(*) FROM ai_events WHERE status='active'
UNION ALL SELECT 'ai_instrument_flags',       COUNT(*) FROM ai_instrument_flags
UNION ALL SELECT 'opportunities',             COUNT(*) FROM opportunities
UNION ALL SELECT 'flash_alerts',              COUNT(*) FROM flash_alerts
UNION ALL SELECT 'morning_briefs',            COUNT(*) FROM morning_briefs
UNION ALL SELECT 'portfolios (active)',       COUNT(*) FROM portfolios WHERE is_active
UNION ALL SELECT 'clients',                   COUNT(*) FROM clients
ORDER BY n ASC;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 7 — The two breakout dependencies.
-- instrument_price_hourly must have rows inside the 30-hour window or
-- findBreakouts() returns [] at line 51 and no breakout can ever fire.
-- Sector rotation needs two distinct scoring days per category.
-- ────────────────────────────────────────────────────────────────────
SELECT COUNT(*) AS rows_in_breakout_window,
       COUNT(DISTINCT symbol) AS distinct_symbols,
       MAX(recorded_at) AS latest
FROM instrument_price_hourly
WHERE recorded_at > NOW() - INTERVAL '30 hours';

SELECT category_at_scoring,
       COUNT(DISTINCT DATE(scored_at)) AS distinct_scoring_days
FROM instrument_scores
WHERE scored_at > NOW() - INTERVAL '21 days'
GROUP BY category_at_scoring
ORDER BY distinct_scoring_days DESC;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 8 — email readiness, and the duplicate accounts
-- ────────────────────────────────────────────────────────────────────
SELECT COUNT(*) AS total_clients,
       COUNT(email) AS can_be_emailed,
       COUNT(*) FILTER (WHERE email IS NULL OR email = '') AS cannot_be_emailed
FROM clients;

SELECT full_name, COUNT(*) AS copies, STRING_AGG(id::text, ', ') AS ids
FROM clients GROUP BY full_name HAVING COUNT(*) > 1;


-- ────────────────────────────────────────────────────────────────────
-- CHECK 9 — ROW LEVEL SECURITY.  Read this one carefully.
--
-- schema.sql enables RLS on 6 tables with policies of the form
--   USING (auth.uid()::text = client_id::text)
--
-- But this platform does NOT use Supabase Auth. It authenticates with a
-- bcrypt PIN through the backend and keeps the client id in localStorage.
-- The browser's Supabase client therefore has NO session, so auth.uid()
-- is NULL on every frontend query, and `NULL = '<id>'` is never true.
--
-- Two consequences, in opposite directions:
--
--  (a) On the six tables WITH RLS, the frontend can read nothing of its
--      own — clients, portfolios, client_goals, alerts, morning_briefs.
--      The one exception is `recommendations`, whose policy ends
--      "OR client_id IS NULL", which is why house-level signals appear on
--      the Markets Dashboard and nothing else does.
--
--  (b) On every table WITHOUT RLS, Supabase grants the anon role full
--      access by default — and the anon key is published in index.html.
--      That plausibly includes instrument_universe, opportunities,
--      ai_events, instrument_scores, recommendation_outcomes, flash_alerts,
--      email_log and discount_code_usage: readable AND writable from any
--      browser.
--
--      Worse: the `recommendations` policy is FOR ALL with only USING, so
--      Postgres reuses that expression as the INSERT check. Since
--      "client_id IS NULL" is satisfiable, anyone holding the anon key may
--      be able to INSERT a house-level BUY recommendation that clients see
--      as ours.
--
-- Run this and paste the result. If rls_enabled is false on the data
-- tables, 004_rls_hardening.sql closes it.
-- ────────────────────────────────────────────────────────────────────
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       COALESCE(p.n, 0) AS policy_count,
       CASE WHEN NOT c.relrowsecurity THEN '>>> OPEN TO ANON KEY'
            WHEN COALESCE(p.n,0) = 0   THEN '>>> RLS on, NO POLICY (denies all)'
            ELSE 'has policies' END AS assessment
FROM pg_class c
JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
LEFT JOIN (SELECT polrelid, COUNT(*) AS n FROM pg_policy GROUP BY polrelid) p
       ON p.polrelid = c.oid
WHERE c.relkind = 'r'
ORDER BY c.relrowsecurity ASC, c.relname;

-- What the anon role is actually granted
SELECT table_name, STRING_AGG(privilege_type, ', ' ORDER BY privilege_type) AS anon_can
FROM information_schema.role_table_grants
WHERE grantee = 'anon' AND table_schema = 'public'
GROUP BY table_name
ORDER BY table_name;
