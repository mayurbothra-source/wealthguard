-- ════════════════════════════════════════════════════════════════════════
-- DEMO ONLY — fake holdings and risk profiles for the 6 "Demo …" accounts.
-- Never run against real client accounts; rows are matched by the exact demo
-- names below. Idempotent: running it again adds nothing.
--
-- What it adds
--   • a risk profile per demo account (only if it has none):
--       Beginner 1/2 → 3 (low) · Builder 1/2 → 6 (moderate) · Wealth Builder 1/2 → 8 (high)
--     marked version = 900 so it can be removed
--   • 4 holdings per account across equity, ETF, gold and debt, entry_source = 'demo_seed',
--     notes = 'DEMO ONLY'. Prices come from each instrument's latest known price
--     (its newest recommendation entry price), so the numbers are realistic.
--   • ONE holding per account deliberately near its stop-loss: stop = last price × 0.99
--     (shows as REVIEW in the brief; POST /api/admin/test-alert pushes it through the stop)
--
-- Alerts for these holdings go to the ADMIN address, not the demo account,
-- unless DEMO_ALERTS_TO_CLIENTS=true is set in Render.
--
-- Rollback:
--   DELETE FROM public.portfolios WHERE entry_source = 'demo_seed';
--   DELETE FROM public.client_behavioural_profiles WHERE version = 900;
-- ════════════════════════════════════════════════════════════════════════

-- 1. Risk profiles
INSERT INTO public.client_behavioural_profiles (client_id, stated_risk_score, panic_history, version, assessed_at)
SELECT c.id, p.risk, false, 900, now()
FROM (VALUES ('Demo Beginner 1', 3), ('Demo Beginner 2', 3),
             ('Demo Builder 1', 6),  ('Demo Builder 2', 6),
             ('Demo Wealth Builder 1', 8), ('Demo Wealth Builder 2', 8)) AS p(name, risk)
JOIN public.clients c ON c.full_name = p.name
WHERE NOT EXISTS (SELECT 1 FROM public.client_behavioural_profiles b WHERE b.client_id = c.id);

-- 2. Holdings. cost_factor: average buy price as a multiple of the last price.
WITH plan(name, symbol, qty, cost_factor, near_stop) AS (VALUES
  ('Demo Beginner 1',       'NIFTYBEES',   40, 0.95, false),
  ('Demo Beginner 1',       'MF-KOT-STB', 200, 0.97, false),
  ('Demo Beginner 1',       'GOLDBEES',   100, 0.92, false),
  ('Demo Beginner 1',       'HDFCBANK',     5, 1.04, true),
  ('Demo Beginner 2',       'SBINIFTY',    60, 0.96, false),
  ('Demo Beginner 2',       'MF-HDFC-LQ',   2, 0.99, false),
  ('Demo Beginner 2',       'HDFCGOLD',    80, 0.93, false),
  ('Demo Beginner 2',       'ITC',         20, 1.03, true),
  ('Demo Builder 1',        'TCS',          8, 0.90, false),
  ('Demo Builder 1',        'JUNIORBEES',  15, 0.97, false),
  ('Demo Builder 1',        'GOLDBEES',   150, 0.95, false),
  ('Demo Builder 1',        'INFY',        12, 1.05, true),
  ('Demo Builder 2',        'RELIANCE',    10, 0.94, false),
  ('Demo Builder 2',        'NIFTYBEES',   50, 0.96, false),
  ('Demo Builder 2',        'MF-ICICI-ST',300, 0.98, false),
  ('Demo Builder 2',        'ASTRAL',      10, 1.06, true),
  ('Demo Wealth Builder 1', 'PERSISTENT',   4, 0.85, false),
  ('Demo Wealth Builder 1', 'BANKBEES',    30, 0.97, false),
  ('Demo Wealth Builder 1', 'SBIGOLD',    200, 0.94, false),
  ('Demo Wealth Builder 1', 'DMART',        6, 1.04, true),
  ('Demo Wealth Builder 2', 'BAJFINANCE',   3, 0.92, false),
  ('Demo Wealth Builder 2', 'MOM100',      40, 0.95, false),
  ('Demo Wealth Builder 2', 'MF-UTI-STI', 400, 0.98, false),
  ('Demo Wealth Builder 2', 'KPITTECH',    15, 1.05, true)
),
last_price AS (
  SELECT DISTINCT ON (instrument_name) instrument_name, entry_price_inr AS price
  FROM public.recommendations
  WHERE client_id IS NULL AND entry_price_inr IS NOT NULL
  ORDER BY instrument_name, generated_at DESC
)
INSERT INTO public.portfolios
  (client_id, instrument_id, instrument_name, asset_class, quantity, avg_buy_price_inr,
   stop_loss_price, buy_date, is_active, entry_source, notes)
SELECT c.id, u.id, p.symbol, u.category, p.qty,
       round((lp.price * p.cost_factor)::numeric, 2),
       CASE WHEN p.near_stop THEN round((lp.price * 0.99)::numeric, 2) ELSE NULL END,
       (now() - interval '45 days')::date, true, 'demo_seed', 'DEMO ONLY'
FROM plan p
JOIN public.clients c            ON c.full_name = p.name
JOIN public.instrument_universe u ON u.symbol = p.symbol
JOIN last_price lp               ON lp.instrument_name = p.symbol
WHERE NOT EXISTS (
  SELECT 1 FROM public.portfolios x
  WHERE x.client_id = c.id AND x.instrument_name = p.symbol AND x.entry_source = 'demo_seed');

-- Check: 4 holdings and one near-stop per demo account
SELECT c.full_name, count(*) AS holdings, count(x.stop_loss_price) AS near_stop,
       (SELECT stated_risk_score FROM public.client_behavioural_profiles b WHERE b.client_id = c.id ORDER BY assessed_at DESC LIMIT 1) AS risk
FROM public.clients c JOIN public.portfolios x ON x.client_id = c.id AND x.entry_source = 'demo_seed'
GROUP BY c.full_name ORDER BY c.full_name;
