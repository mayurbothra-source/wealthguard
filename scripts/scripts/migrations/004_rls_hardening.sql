-- ════════════════════════════════════════════════════════════════════
-- 004_rls_hardening.sql
--
-- ⚠  READ THIS BEFORE RUNNING. It changes who can read and write what.
--    Run 001_verify_schema.sql CHECK 9 first and look at the output. If
--    the assessment column says "OPEN TO ANON KEY" on the data tables,
--    this is the fix. If your live database already differs from
--    schema.sql, send me CHECK 9's output and I will adjust this instead.
--
-- THE PROBLEM
-- The anon key is published in frontend/public/index.html, which is normal
-- and fine for Supabase — the key is meant to be public, because RLS is
-- what protects the data behind it. Here RLS does not protect it, for two
-- reasons at once:
--
--   1. The policies in schema.sql are written against auth.uid(). This
--      platform authenticates with a bcrypt PIN through its own backend
--      and never creates a Supabase session, so auth.uid() is NULL on
--      every browser query and those policies match nothing.
--
--   2. Every table added after schema.sql (instrument_universe,
--      opportunities, ai_events, instrument_scores, recommendation_outcomes,
--      flash_alerts, email_log, discount_code_usage and the rest) never had
--      RLS enabled at all. Supabase grants anon full access by default, so
--      those are readable and writable by anyone with the key.
--
-- THE APPROACH — and why it does not change the defined architecture
-- The frozen design is: the backend owns writes and holds the service key;
-- the frontend reads display data directly from Supabase. That design is
-- kept exactly. What changes is that the frontend's key becomes
-- READ-ONLY, and only on the tables it actually needs to display:
--
--   public display  → SELECT for anon
--   everything else → no anon access; the backend reaches it with the
--                     service key, which bypasses RLS entirely
--
-- Anything client-specific (a client's own profile, holdings, goals,
-- briefs) already has a backend route, so nothing the app does today
-- stops working.
--
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- PART 1 — Replace the auth.uid() policies that can never match.
--
-- These are dropped rather than rewritten: with no Supabase session there
-- is no identity to write a policy against. Client-specific data is served
-- by the backend, which uses the service key and is not subject to RLS.
-- RLS stays ENABLED on each table, so with no anon policy the default is
-- deny — which is what we want for the browser.
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "client_own_data"    ON clients;
DROP POLICY IF EXISTS "portfolio_own_data" ON portfolios;
DROP POLICY IF EXISTS "goals_own_data"     ON client_goals;
DROP POLICY IF EXISTS "alerts_own_data"    ON alerts;
DROP POLICY IF EXISTS "briefs_own_data"    ON morning_briefs;

-- This one is the active hole. FOR ALL with only USING means Postgres
-- reuses the expression as the INSERT check, and "client_id IS NULL" is
-- satisfiable — so the anon key could insert a house-level BUY that
-- clients would see as ours.
DROP POLICY IF EXISTS "recs_own_data" ON recommendations;

ALTER TABLE clients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios     ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_goals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE morning_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;

-- House-level signals stay publicly READABLE (the Markets Dashboard is
-- public by design and this is what makes it work) but no longer writable.
CREATE POLICY "recs_house_public_read" ON recommendations
  FOR SELECT TO anon, authenticated
  USING (client_id IS NULL);


-- ────────────────────────────────────────────────────────────────────
-- PART 2 — Turn RLS on for every other table, then grant read-only
-- access to just the ones the frontend displays.
--
-- The loop covers tables added after schema.sql, so nothing is missed as
-- the schema grows.
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    RAISE NOTICE 'RLS enabled on %', t;
  END LOOP;
END $$;

-- The tables the frontend genuinely reads to render public/display data.
-- Verified against every sb.from() call in index.html.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'instrument_universe',          -- Markets Dashboard cards
    'recommendation_outcomes',      -- track record
    'category_benchmarks',          -- benchmark line
    'ai_instrument_flags',          -- the AI-influenced pill
    'ai_events',                    -- PESTLE Watch
    'opportunities',                -- Opportunities section
    'market_data_cache',            -- live prices on cards
    'ai_scan_log'                   -- admin panel
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_public_read', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (TRUE)',
        t||'_public_read', t);
      -- Read only. No INSERT/UPDATE/DELETE policy means those are denied.
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', t);
      RAISE NOTICE 'read-only anon policy on %', t;
    END IF;
  END LOOP;
END $$;

-- Views the frontend reads. Views inherit their base tables' RLS, so they
-- just need the grant.
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'category_accuracy_summary', 'instrument_accuracy_summary'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.views
               WHERE table_schema='public' AND table_name=v) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', v);
      RAISE NOTICE 'granted SELECT on view %', v;
    END IF;
  END LOOP;
END $$;


-- ────────────────────────────────────────────────────────────────────
-- PART 3 — Revoke writes from anon everywhere else.
-- The backend's service key bypasses RLS and GRANTs, so this does not
-- affect any engine.
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.role_table_grants
    WHERE grantee = 'anon' AND table_schema = 'public'
      AND privilege_type IN ('INSERT','UPDATE','DELETE')
    GROUP BY table_name
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', t);
  END LOOP;
  RAISE NOTICE 'anon write access revoked across public schema';
END $$;

NOTIFY pgrst, 'reload schema';


-- ────────────────────────────────────────────────────────────────────
-- VERIFY — no table should say OPEN, and anon should hold SELECT only
-- ────────────────────────────────────────────────────────────────────
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       COALESCE(p.n,0) AS policies,
       CASE WHEN NOT c.relrowsecurity THEN '>>> STILL OPEN' ELSE 'protected' END AS status
FROM pg_class c
JOIN pg_namespace ns ON ns.oid=c.relnamespace AND ns.nspname='public'
LEFT JOIN (SELECT polrelid, COUNT(*) n FROM pg_policy GROUP BY polrelid) p ON p.polrelid=c.oid
WHERE c.relkind='r'
ORDER BY c.relrowsecurity ASC, c.relname;

SELECT table_name, STRING_AGG(privilege_type, ', ' ORDER BY privilege_type) AS anon_can
FROM information_schema.role_table_grants
WHERE grantee='anon' AND table_schema='public'
GROUP BY table_name ORDER BY table_name;
