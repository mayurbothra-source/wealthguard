-- 012: price_mode on instruments; reward:risk, downgrade reason and price time on signals.
-- Purpose: WS3 signal integrity. A signal may only carry a target/stop (and only be a BUY)
-- when its instrument has a trustworthy, recent price.
--   price_mode  live      — exchange price via Yahoo (stocks, ETFs)
--               daily_nav — mutual-fund NAV via MFAPI (with an amfi_code)
--               static    — a stored reference price, or no price source at all
-- Additive and idempotent: safe to run more than once.
-- Rollback:
--   ALTER TABLE public.instrument_universe DROP CONSTRAINT IF EXISTS instrument_universe_price_mode_chk;
--   ALTER TABLE public.instrument_universe DROP COLUMN IF EXISTS price_mode;
--   ALTER TABLE public.recommendations DROP COLUMN IF EXISTS reward_risk,
--     DROP COLUMN IF EXISTS downgrade_reason, DROP COLUMN IF EXISTS price_as_of;
--   (the backend derives price_mode from price_source when the column is absent)

ALTER TABLE public.instrument_universe ADD COLUMN IF NOT EXISTS price_mode text;

-- Populate from the Phase 0 audit rules (only rows not yet set).
UPDATE public.instrument_universe
SET price_mode = CASE
    WHEN price_source IN ('static', 'static_reference') THEN 'static'
    WHEN price_source = 'mfapi' AND amfi_code IS NOT NULL THEN 'daily_nav'
    WHEN price_source = 'mfapi' THEN 'static'            -- no scheme code: no price at all
    WHEN price_source = 'yahoo' AND yahoo_ticker IS NOT NULL THEN 'live'
    ELSE 'static'
  END
WHERE price_mode IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instrument_universe_price_mode_chk') THEN
    ALTER TABLE public.instrument_universe
      ADD CONSTRAINT instrument_universe_price_mode_chk CHECK (price_mode IN ('live', 'daily_nav', 'static'));
  END IF;
END $$;

ALTER TABLE public.recommendations ADD COLUMN IF NOT EXISTS reward_risk numeric;
ALTER TABLE public.recommendations ADD COLUMN IF NOT EXISTS downgrade_reason text;
ALTER TABLE public.recommendations ADD COLUMN IF NOT EXISTS price_as_of timestamptz;

-- Check: expected on 13 Nov 2026 — live 74, daily_nav 33, static 13 (10 static + 3 watchlist funds without a code).
SELECT price_mode, status, count(*) FROM public.instrument_universe GROUP BY 1, 2 ORDER BY 1, 2;
