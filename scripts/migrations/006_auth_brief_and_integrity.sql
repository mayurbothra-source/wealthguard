-- ════════════════════════════════════════════════════════════════════
-- 006_auth_brief_and_integrity.sql        Safe to re-run.
--
-- 1. onboarding_complete backfill — nothing in the code ever set this to TRUE,
--    and the morning-brief engine only briefed clients where it was TRUE, so no
--    brief was ever generated. Existing clients who answered onboarding
--    questions (or have goals/holdings) are marked complete.
-- 2. morning_briefs.brief_json — the structured brief (news, holding actions,
--    ideas) the app now renders. Optional: the code works without it.
-- 3. auth_codes — one-time codes for setting a PIN on an account that has none.
--    RLS is enabled with NO policies, so the browser (anon key) cannot touch it.
-- 4. discount_code_usage unique (code, client_id) — a client cannot redeem the
--    same code twice (this also stops the free trial being re-claimed by
--    clearing browser storage).
-- ════════════════════════════════════════════════════════════════════

-- 1 ─────────────────────────────────────────────────────────────────
UPDATE clients c
SET onboarding_complete = TRUE
WHERE onboarding_complete IS NOT TRUE
  AND (   EXISTS (SELECT 1 FROM client_life_profiles       x WHERE x.client_id = c.id)
       OR EXISTS (SELECT 1 FROM client_behavioural_profiles x WHERE x.client_id = c.id)
       OR EXISTS (SELECT 1 FROM client_goals                x WHERE x.client_id = c.id)
       OR EXISTS (SELECT 1 FROM portfolios                  x WHERE x.client_id = c.id));

-- 2 ─────────────────────────────────────────────────────────────────
ALTER TABLE morning_briefs ADD COLUMN IF NOT EXISTS brief_json JSONB;

-- 3 ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  channel     TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_codes_client_idx ON auth_codes (client_id, created_at DESC);
ALTER TABLE auth_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON auth_codes FROM anon, authenticated;

-- 4 ─────────────────────────────────────────────────────────────────
-- Keep the earliest redemption per (code, client) and drop later duplicates.
DELETE FROM discount_code_usage a
USING discount_code_usage b
WHERE a.ctid > b.ctid AND a.code = b.code AND a.client_id = b.client_id;

CREATE UNIQUE INDEX IF NOT EXISTS discount_code_usage_code_client_key
  ON discount_code_usage (code, client_id);

NOTIFY pgrst, 'reload schema';

-- VERIFY ────────────────────────────────────────────────────────────
SELECT 'clients onboarding_complete' AS check_name,
       COUNT(*) FILTER (WHERE onboarding_complete) AS complete, COUNT(*) AS total FROM clients;
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'morning_briefs' AND column_name = 'brief_json';
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'auth_codes';
