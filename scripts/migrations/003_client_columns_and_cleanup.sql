-- ════════════════════════════════════════════════════════════════════
-- 003_client_columns_and_cleanup.sql
--
-- Three things, in order of importance:
--
--   1. The columns subscriptionEngine, auth and the alert engines need.
--      Additive and safe to re-run. Any of these missing means that
--      feature has silently done nothing.
--
--   2. The duplicate client accounts, and per-account email addresses.
--      clients.email is UNIQUE, so the previous single-address backfill
--      collided the moment two rows matched.
--
--   3. The three Yahoo tickers that have 404'd since launch.
--
-- NOTE: clients.created_at is deliberately NOT added. The code now reads
-- `onboarded_at`, which already exists and means the same thing. Adding a
-- second timestamp column would just be a second thing to keep in sync.
--
-- Run AFTER 001_verify_schema.sql so you know which parts you need.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- PART 1 — clients columns
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE clients
  -- auth
  ADD COLUMN IF NOT EXISTS pin_hash                TEXT,
  ADD COLUMN IF NOT EXISTS pin_set                 BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pin_attempts            INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_admin                BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_complete     BOOLEAN DEFAULT FALSE,
  -- subscription lifecycle
  ADD COLUMN IF NOT EXISTS subscription_plan       TEXT DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_stage             INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_failed_at       TIMESTAMPTZ,
  -- referrals (subscriptionEngine already credits both parties; it just
  -- had no code to match on)
  ADD COLUMN IF NOT EXISTS referral_code           TEXT,
  ADD COLUMN IF NOT EXISTS referred_by             UUID REFERENCES clients(id),
  ADD COLUMN IF NOT EXISTS referral_months_earned  INTEGER DEFAULT 0,
  -- delivery
  ADD COLUMN IF NOT EXISTS email_verified          BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_alerts_enabled    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_opt_in_brief      BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_brief_sent_at      TIMESTAMPTZ,
  -- profile
  ADD COLUMN IF NOT EXISTS stated_risk_score       INTEGER;

-- Every client needs a trial expiry for the (now working) expiry pass to
-- act on. Frozen policy: joined before 31 Dec 2026 -> trial runs to then;
-- joined after -> 30 days from joining.
UPDATE clients
SET subscription_expires_at = CASE
      WHEN onboarded_at < '2026-12-31 23:59:59+00' THEN '2026-12-31 23:59:59+00'::timestamptz
      ELSE onboarded_at + INTERVAL '30 days'
    END
WHERE subscription_expires_at IS NULL;


-- ────────────────────────────────────────────────────────────────────
-- PART 2 — referral codes
-- Matches the code the frontend shows: 'WG' + first 6 hex of the id,
-- uppercased. Deterministic, so the two always agree.
-- ────────────────────────────────────────────────────────────────────
UPDATE clients
SET referral_code = 'WG' || UPPER(SUBSTRING(REPLACE(id::text, '-', ''), 1, 6))
WHERE referral_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS clients_referral_code_key
  ON clients (referral_code) WHERE referral_code IS NOT NULL;


-- ────────────────────────────────────────────────────────────────────
-- PART 3 — duplicates and email addresses
-- ────────────────────────────────────────────────────────────────────

-- 3a. Show the duplicates before touching anything
SELECT full_name, COUNT(*) AS copies, STRING_AGG(id::text, ', ' ORDER BY onboarded_at) AS ids
FROM clients GROUP BY full_name HAVING COUNT(*) > 1;

-- 3b. Clear anything left from the earlier failed backfill
UPDATE clients SET email = NULL WHERE email LIKE 'REPLACE_ME%';

-- 3c. One distinct address per row. email is UNIQUE, so a single shared
-- address cannot work — ROW_NUMBER gives each row its own, and Gmail
-- plus-addressing delivers them all to one inbox.
--
-- >>> CHANGE THE ADDRESS ON THE NEXT LINE IF YOU WANT A DIFFERENT INBOX.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY onboarded_at, id) AS rn
  FROM clients
  WHERE email IS NULL OR email = ''
)
UPDATE clients c
SET email = 'mayurbothra+wg' || n.rn || '@gmail.com',
    email_verified = TRUE
FROM numbered n
WHERE c.id = n.id;

-- 3d. Your own admin row gets the clean address
UPDATE clients
SET email = 'mayurbothra@gmail.com', email_verified = TRUE
WHERE is_admin IS TRUE
  AND NOT EXISTS (SELECT 1 FROM clients c2
                  WHERE c2.email = 'mayurbothra@gmail.com' AND c2.id <> clients.id);


-- ────────────────────────────────────────────────────────────────────
-- PART 4 — the three tickers that have 404'd since launch
-- ────────────────────────────────────────────────────────────────────
UPDATE instrument_universe SET yahoo_ticker = 'BHARAT22.NS'
  WHERE symbol = 'BHARAT22ETF' OR yahoo_ticker = 'BHARAT22ETF';
UPDATE instrument_universe SET yahoo_ticker = 'SETFGOLD.NS'
  WHERE symbol = 'SBIGOLD' OR yahoo_ticker = 'SBIGOLD';
UPDATE instrument_universe SET yahoo_ticker = 'AXISGOLDETF.NS'
  WHERE symbol = 'AXISGOLD' OR yahoo_ticker = 'AXISGOLD';


-- ────────────────────────────────────────────────────────────────────
-- PART 5 — make the API see the new columns immediately
-- PostgREST caches the schema; without this, columns added above can stay
-- invisible to the backend until the cache expires on its own.
-- ────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';


-- ────────────────────────────────────────────────────────────────────
-- VERIFY — every row must show an email, a code and an expiry
-- ────────────────────────────────────────────────────────────────────
SELECT full_name, email, referral_code, subscription_plan,
       subscription_status, subscription_expires_at, is_admin, onboarded_at
FROM clients
ORDER BY onboarded_at, id;

SELECT COUNT(*) AS total,
       COUNT(email) AS with_email,
       COUNT(referral_code) AS with_referral_code,
       COUNT(subscription_expires_at) AS with_expiry
FROM clients;
