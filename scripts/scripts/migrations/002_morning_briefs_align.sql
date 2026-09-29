-- ════════════════════════════════════════════════════════════════════
-- 002_morning_briefs_align.sql
--
-- Brings morning_briefs into line with what morningBriefEngine.js writes.
--
-- THE BUG
-- The engine upserts ten columns the table does not have: market_snapshot,
-- portfolio_note, top_signals, goal_note, education_point, full_text,
-- ai_provider, created_at, email_sent, email_sent_at.
--
-- supabase-js does not throw on a rejected query; it resolves with
-- {error}. The call site discarded the result. So every brief silently
-- failed to persist, the log stayed clean, and the frontend's Daily Brief
-- tab has been empty since launch for a reason nobody could see.
--
-- WHY ADD COLUMNS RATHER THAN REWRITE THE ENGINE
-- The engine's shape is the newer design and the one the frontend wants
-- (full_text, market_snapshot, top_signals). The old columns
-- (nifty_prediction, actions_json, ...) are still written by
-- routes/brief.js, so nothing is dropped — this is additive only, and both
-- writers keep working while the older route is retired.
--
-- Safe to re-run. Nothing is deleted.
-- Run AFTER 001_verify_schema.sql confirms these are missing.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE morning_briefs
  ADD COLUMN IF NOT EXISTS market_snapshot  TEXT,
  ADD COLUMN IF NOT EXISTS portfolio_note   TEXT,
  ADD COLUMN IF NOT EXISTS top_signals      JSONB,
  ADD COLUMN IF NOT EXISTS goal_note        TEXT,
  ADD COLUMN IF NOT EXISTS education_point  TEXT,
  ADD COLUMN IF NOT EXISTS full_text        TEXT,
  ADD COLUMN IF NOT EXISTS ai_provider      TEXT,
  ADD COLUMN IF NOT EXISTS email_sent       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_sent_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ DEFAULT NOW();

-- The engine upserts on (client_id, brief_date). schema.sql already
-- declares that UNIQUE, but assert it — without the constraint the upsert
-- silently becomes an insert and duplicates a brief per run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'morning_briefs'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%client_id%brief_date%'
  ) THEN
    ALTER TABLE morning_briefs
      ADD CONSTRAINT morning_briefs_client_date_key UNIQUE (client_id, brief_date);
    RAISE NOTICE 'Added the missing UNIQUE(client_id, brief_date) — the upsert needed it.';
  END IF;
END $$;

-- The Daily Brief tab reads whatsapp_message. Backfill it from full_text
-- for any brief that stored one but not the other, so history is not blank.
UPDATE morning_briefs
SET whatsapp_message = full_text
WHERE whatsapp_message IS NULL AND full_text IS NOT NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'morning_briefs' AND table_schema = 'public'
ORDER BY ordinal_position;
