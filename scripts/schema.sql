-- ═══════════════════════════════════════════════════════════════
-- WEALTHGUARD DATABASE SCHEMA v1.0
-- Supabase / PostgreSQL
-- All tables append-only where noted — never delete, only timestamp
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for text search

-- ─────────────────────────────────────────────────────────────
-- DOMAIN 1: CLIENTS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE clients (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name             TEXT NOT NULL,
  pan_hash              TEXT,                          -- hashed PAN, never plain
  email                 TEXT UNIQUE,
  phone_wa              TEXT NOT NULL,                 -- WhatsApp number
  tax_bracket           INT DEFAULT 30,                -- 5 / 20 / 30
  kyc_status            TEXT DEFAULT 'pending' CHECK (kyc_status IN ('pending','verified','flagged')),
  is_active             BOOLEAN DEFAULT TRUE,
  onboarded_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE client_life_profiles (
  id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id                    UUID NOT NULL REFERENCES clients(id),
  age                          INT,
  retirement_age               INT DEFAULT 60,
  working_years_remaining      INT GENERATED ALWAYS AS (GREATEST(0, COALESCE(retirement_age,60) - COALESCE(age,35))) STORED,
  income_type                  TEXT CHECK (income_type IN ('salaried','business','freelance','rental','retired')),
  monthly_income_inr           NUMERIC(14,2),
  income_stability             TEXT CHECK (income_stability IN ('stable','variable','seasonal','uncertain')),
  monthly_committed_expenses   NUMERIC(14,2),
  investable_surplus_inr       NUMERIC(14,2) GENERATED ALWAYS AS (GREATEST(0, COALESCE(monthly_income_inr,0) - COALESCE(monthly_committed_expenses,0))) STORED,
  client_tier                  TEXT DEFAULT 'starter' CHECK (client_tier IN ('starter','builder','wealth_builder','hni')),
  marital_status               TEXT CHECK (marital_status IN ('single','married','divorced','widowed')),
  num_children                 INT DEFAULT 0,
  dual_income                  BOOLEAN DEFAULT FALSE,
  dependents_json              JSONB DEFAULT '[]',     -- [{type, age, dependency_level}]
  upcoming_events_json         JSONB DEFAULT '[]',     -- [{event, timeline_months}]
  health_status                TEXT DEFAULT 'good' CHECK (health_status IN ('excellent','good','managing','serious')),
  health_insurance_cover_inr   NUMERIC(14,2),
  term_cover_inr               NUMERIC(14,2),
  has_critical_illness_cover   BOOLEAN DEFAULT FALSE,
  has_disability_cover         BOOLEAN DEFAULT FALSE,
  protection_gaps_json         JSONB DEFAULT '[]',     -- computed gaps
  existing_investments_json    JSONB DEFAULT '{}',     -- PF, PPF, LIC etc
  outstanding_loans_json       JSONB DEFAULT '[]',     -- [{type, emi, outstanding}]
  version                      INT DEFAULT 1,
  assessed_at                  TIMESTAMPTZ DEFAULT NOW()  -- versioned, never overwritten
);

CREATE TABLE client_behavioural_profiles (
  id                                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id                           UUID NOT NULL REFERENCES clients(id),
  stated_risk_score                   INT CHECK (stated_risk_score BETWEEN 1 AND 10),
  effective_risk_score                INT CHECK (effective_risk_score BETWEEN 1 AND 10),
  risk_category                       TEXT GENERATED ALWAYS AS (
    CASE
      WHEN effective_risk_score <= 3 THEN 'conservative'
      WHEN effective_risk_score <= 6 THEN 'moderate'
      ELSE 'aggressive'
    END
  ) STORED,
  panic_history                       BOOLEAN DEFAULT FALSE,  -- sold in 2020/2022
  portfolio_check_frequency           TEXT CHECK (portfolio_check_frequency IN ('multiple_daily','daily','weekly','monthly','rarely')),
  money_relationship                  TEXT CHECK (money_relationship IN ('security','freedom','legacy','growth')),
  decision_style                      TEXT CHECK (decision_style IN ('deliberate','intuitive','collaborative')),
  prior_loss_experience               BOOLEAN DEFAULT FALSE,
  prior_loss_amount_inr               NUMERIC(14,2),
  communication_preference            TEXT DEFAULT 'summary' CHECK (communication_preference IN ('detailed','summary','numbers_only')),
  trust_disposition                   TEXT DEFAULT 'trusts_system' CHECK (trust_disposition IN ('wants_to_understand','trusts_system')),
  stability_intervention_threshold_pct NUMERIC(5,2) DEFAULT 10.0,
  sleep_test_threshold_pct            NUMERIC(5,2) DEFAULT 15.0,
  max_single_position_pct             NUMERIC(5,2) DEFAULT 10.0,
  max_drawdown_tolerance_pct          NUMERIC(5,2) DEFAULT 20.0,
  version                             INT DEFAULT 1,
  assessed_at                         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE client_goals (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id                 UUID NOT NULL REFERENCES clients(id),
  goal_name                 TEXT NOT NULL,              -- "Priya's MBA", "Retirement at 55"
  goal_type                 TEXT CHECK (goal_type IN ('emergency','short','medium','long','legacy')),
  bucket_number             INT DEFAULT 3,              -- 0=emergency,1=short,2=medium,3=long
  target_amount_inr         NUMERIC(14,2),
  inflation_rate_pct        NUMERIC(5,2) DEFAULT 6.0,
  target_date               DATE,
  current_corpus_inr        NUMERIC(14,2) DEFAULT 0,
  funding_pct               NUMERIC(6,2) DEFAULT 0,
  monthly_sip_required_inr  NUMERIC(14,2),
  on_track                  BOOLEAN DEFAULT FALSE,
  priority_rank             INT DEFAULT 1,
  is_non_negotiable         BOOLEAN DEFAULT FALSE,
  is_active                 BOOLEAN DEFAULT TRUE,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE client_goal_buckets (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  goal_id             UUID NOT NULL REFERENCES client_goals(id),
  client_id           UUID NOT NULL REFERENCES clients(id),
  instrument_id       UUID,                            -- FK to instruments (nullable for cash)
  instrument_name     TEXT,                            -- denormalised for display
  allocation_inr      NUMERIC(14,2),
  allocation_pct      NUMERIC(5,2),
  current_value_inr   NUMERIC(14,2),
  de_risk_date        DATE,                            -- goal_date - 18 months
  de_risk_triggered   BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE profile_change_events (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id               UUID NOT NULL REFERENCES clients(id),
  event_type              TEXT CHECK (event_type IN ('initial','annual_review','life_event','client_initiated')),
  trigger_description     TEXT,
  fields_changed_json     JSONB DEFAULT '{}',
  strategy_impact_json    JSONB DEFAULT '{}',
  changed_at              TIMESTAMPTZ DEFAULT NOW()    -- immutable
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN 2: MARKET DATA
-- ─────────────────────────────────────────────────────────────

CREATE TABLE instruments (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol                    TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  asset_class               TEXT CHECK (asset_class IN ('equity','mutual_fund','gold','bond','fd','reit','invit','commodity','index')),
  sub_category              TEXT,                      -- large_cap, mid_cap, liquid, hybrid etc
  risk_tier                 INT CHECK (risk_tier BETWEEN 1 AND 5),
  min_risk_score_required   INT DEFAULT 3,
  exchange                  TEXT,                      -- NSE / BSE / MCX / AMFI
  isin                      TEXT,
  amfi_code                 TEXT,                      -- for mutual funds
  nse_code                  TEXT,
  expense_ratio_pct         NUMERIC(5,3),              -- for MFs
  is_active                 BOOLEAN DEFAULT TRUE,
  is_derivatives_blocked    BOOLEAN DEFAULT TRUE,      -- F&O permanently blocked
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE market_snapshots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instrument_id   UUID NOT NULL REFERENCES instruments(id),
  price_inr       NUMERIC(14,4) NOT NULL,
  open_inr        NUMERIC(14,4),
  high_inr        NUMERIC(14,4),
  low_inr         NUMERIC(14,4),
  volume          BIGINT,
  pe_ratio        NUMERIC(10,2),
  pb_ratio        NUMERIC(10,2),
  market_cap_cr   NUMERIC(18,2),
  india_vix       NUMERIC(8,4),
  fii_net_cr      NUMERIC(14,2),                      -- FII net buy/sell on this day
  dii_net_cr      NUMERIC(14,2),
  snapshot_type   TEXT DEFAULT 'eod' CHECK (snapshot_type IN ('intraday','eod','nav')),
  captured_at     TIMESTAMPTZ DEFAULT NOW()            -- indexed, append-only
);
CREATE INDEX idx_snapshots_instrument_time ON market_snapshots(instrument_id, captured_at DESC);
CREATE INDEX idx_snapshots_time ON market_snapshots(captured_at DESC);

CREATE TABLE macro_indicators (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  indicator_name  TEXT NOT NULL,                       -- 'repo_rate', 'cpi', 'india_vix', 'usd_inr'
  value           NUMERIC(14,6),
  direction       TEXT CHECK (direction IN ('rising','falling','stable')),
  impact_sectors  TEXT[],                              -- which sectors this affects
  sentiment_score NUMERIC(4,2),                        -- -2 to +2
  source          TEXT,
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE technical_signals (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instrument_id       UUID NOT NULL REFERENCES instruments(id),
  rsi_14              NUMERIC(8,4),
  macd_value          NUMERIC(12,6),
  macd_signal_line    NUMERIC(12,6),
  macd_histogram      NUMERIC(12,6),
  macd_crossover      TEXT CHECK (macd_crossover IN ('bullish_cross','bearish_cross','neutral')),
  ema_20              NUMERIC(14,4),
  ema_50              NUMERIC(14,4),
  dma_50              NUMERIC(14,4),
  dma_200             NUMERIC(14,4),
  dma_200_signal      TEXT CHECK (dma_200_signal IN ('above','below','crossing')),
  golden_cross        BOOLEAN,                         -- 50 DMA crossed above 200 DMA
  bollinger_upper     NUMERIC(14,4),
  bollinger_lower     NUMERIC(14,4),
  bollinger_position  TEXT CHECK (bollinger_position IN ('upper','lower','mid','squeeze')),
  adx                 NUMERIC(8,4),                    -- trend strength
  obv_trend           TEXT CHECK (obv_trend IN ('accumulation','distribution','neutral')),
  volume_spike        BOOLEAN DEFAULT FALSE,           -- > 2x 20-day avg
  support_level       NUMERIC(14,4),
  resistance_level    NUMERIC(14,4),
  composite_score     NUMERIC(5,2),                    -- 0-100 weighted signal strength
  signal_direction    TEXT CHECK (signal_direction IN ('bullish','bearish','neutral')),
  computed_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tech_signals_instrument ON technical_signals(instrument_id, computed_at DESC);

CREATE TABLE fundamental_scores (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instrument_id         UUID NOT NULL REFERENCES instruments(id),
  pe_ratio              NUMERIC(10,2),
  pb_ratio              NUMERIC(10,2),
  ev_ebitda             NUMERIC(10,2),
  peg_ratio             NUMERIC(10,2),
  roe_pct               NUMERIC(8,2),
  roce_pct              NUMERIC(8,2),
  operating_margin_pct  NUMERIC(8,2),
  net_margin_pct        NUMERIC(8,2),
  debt_equity           NUMERIC(8,4),
  interest_coverage     NUMERIC(10,2),
  current_ratio         NUMERIC(8,4),
  altman_z_score        NUMERIC(8,4),                 -- <1.8 = distress, auto-blocks BUY
  cfo_vs_profit_ratio   NUMERIC(8,4),                 -- cash quality check
  accrual_ratio         NUMERIC(8,4),
  promoter_holding_pct  NUMERIC(6,2),
  promoter_pledge_pct   NUMERIC(6,2),                 -- >50% auto-blocks BUY
  earnings_growth_3y    NUMERIC(8,2),
  revenue_growth_3y     NUMERIC(8,2),
  fcf_positive          BOOLEAN,
  auditor_flag          BOOLEAN DEFAULT FALSE,         -- qualified audit opinion
  composite_score       NUMERIC(5,2),                 -- 0-100
  signal_direction      TEXT CHECK (signal_direction IN ('bullish','bearish','neutral')),
  scored_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sentiment_scores (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instrument_id       UUID NOT NULL REFERENCES instruments(id),
  news_score_48h      NUMERIC(5,3),                   -- -1 to +1 rolling 48h
  earnings_call_tone  TEXT CHECK (earnings_call_tone IN ('confident','cautious','hedging','distressed')),
  social_sentiment    NUMERIC(5,3),
  analyst_consensus   TEXT CHECK (analyst_consensus IN ('strong_buy','buy','hold','sell','strong_sell')),
  vix_regime          TEXT CHECK (vix_regime IN ('calm','normal','elevated','fear','crisis')),
  composite_score     NUMERIC(5,2),
  signal_direction    TEXT CHECK (signal_direction IN ('bullish','bearish','neutral')),
  scored_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pestle_scores (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  factor_type         TEXT NOT NULL CHECK (factor_type IN ('political','economic','social','technological','legal','environmental')),
  factor_name         TEXT NOT NULL,
  description         TEXT,
  direction_score     NUMERIC(4,2),                   -- -2 to +2
  affected_sectors    TEXT[],
  affected_instruments UUID[],
  severity            TEXT CHECK (severity IN ('low','medium','high','critical')),
  duration_estimate   TEXT,
  source              TEXT,
  recorded_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN 3: PORTFOLIOS & HOLDINGS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE portfolios (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID NOT NULL REFERENCES clients(id),
  instrument_id       UUID REFERENCES instruments(id),
  instrument_name     TEXT NOT NULL,                  -- denormalised
  asset_class         TEXT,
  quantity            NUMERIC(18,6) NOT NULL,
  avg_buy_price_inr   NUMERIC(14,4) NOT NULL,
  current_price_inr   NUMERIC(14,4),
  current_value_inr   NUMERIC(14,2),
  unrealised_pnl_inr  NUMERIC(14,2),
  unrealised_pnl_pct  NUMERIC(8,4),
  stop_loss_price     NUMERIC(14,4),                  -- MANDATORY for equity positions
  trailing_sl_price   NUMERIC(14,4),                  -- auto-updated as price rises
  target_price        NUMERIC(14,4),
  allocation_pct      NUMERIC(6,2),
  linked_goal_id      UUID REFERENCES client_goals(id),
  buy_date            DATE,
  holding_days        INT GENERATED ALWAYS AS (
    EXTRACT(DAY FROM NOW() - COALESCE(buy_date, NOW()))::INT
  ) STORED,
  ltcg_eligible       BOOLEAN GENERATED ALWAYS AS (
    EXTRACT(DAY FROM NOW() - COALESCE(buy_date, NOW())) > 365
  ) STORED,
  is_active           BOOLEAN DEFAULT TRUE,
  entry_source        TEXT DEFAULT 'manual',           -- manual / broker_api
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_portfolios_client ON portfolios(client_id) WHERE is_active = TRUE;

CREATE TABLE portfolio_valuations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id         UUID NOT NULL REFERENCES clients(id),
  total_value_inr   NUMERIC(18,2),
  total_cost_inr    NUMERIC(18,2),
  total_pnl_inr     NUMERIC(18,2),
  total_pnl_pct     NUMERIC(8,4),
  sharpe_ratio      NUMERIC(8,4),
  sortino_ratio     NUMERIC(8,4),
  max_drawdown_pct  NUMERIC(8,4),
  valuation_json    JSONB,                             -- full holdings snapshot
  captured_at       TIMESTAMPTZ DEFAULT NOW()          -- append-only
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN 4: RECOMMENDATIONS & SIGNALS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE recommendations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id             UUID REFERENCES clients(id),    -- null = universe-wide signal
  instrument_id         UUID REFERENCES instruments(id),
  instrument_name       TEXT,
  action                TEXT NOT NULL CHECK (action IN ('BUY','SELL','HOLD','REDUCE','EXIT','WATCH')),
  signal_tier           TEXT DEFAULT 'standard' CHECK (signal_tier IN ('high_conviction','standard','watchlist')),
  engines_agreed        INT,                            -- of 8
  engines_detail_json   JSONB,                          -- {technical:'bullish', fundamental:'bullish'...}
  confidence_score      NUMERIC(5,4),                   -- 0.0 to 1.0 — <0.60 never pushed
  entry_price_inr       NUMERIC(14,4),
  stop_loss_inr         NUMERIC(14,4),                  -- MANDATORY, NOT NULL enforced at app layer
  target_price_inr      NUMERIC(14,4),
  risk_reward_ratio     NUMERIC(6,2),
  suggested_qty         NUMERIC(18,6),
  suggested_amount_inr  NUMERIC(14,2),
  rationale_text        TEXT,                           -- AI-generated plain English
  rationale_short       TEXT,                           -- WhatsApp-length summary
  market_regime         TEXT,                           -- bull/bear/neutral at time of signal
  india_vix_at_signal   NUMERIC(8,4),
  risk_gate_passed      BOOLEAN DEFAULT FALSE,           -- FALSE = never shown to client
  risk_gate_failures    TEXT[],                         -- which gates failed
  pestle_context        TEXT,                           -- AI summary of macro backdrop
  linked_goal_type      TEXT,                           -- which bucket this fits
  outcome_pct           NUMERIC(8,4),                   -- filled post-close for accountability
  outcome_correct       BOOLEAN,
  outcome_measured_at   TIMESTAMPTZ,
  generated_at          TIMESTAMPTZ DEFAULT NOW(),       -- immutable
  valid_until           TIMESTAMPTZ,
  is_active             BOOLEAN DEFAULT TRUE
);
CREATE INDEX idx_recs_client ON recommendations(client_id, generated_at DESC);
CREATE INDEX idx_recs_instrument ON recommendations(instrument_id, generated_at DESC);

CREATE TABLE sell_signals (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id              UUID NOT NULL REFERENCES portfolios(id),
  client_id                 UUID NOT NULL REFERENCES clients(id),
  instrument_name           TEXT,
  trigger_type              TEXT NOT NULL CHECK (trigger_type IN ('stop_loss','trailing_sl','target','thesis_broken','rebalance','horizon_expiry')),
  exit_pct_recommended      NUMERIC(5,2),               -- 30/60/100
  exit_price_inr            NUMERIC(14,4),
  rationale_text            TEXT,
  engines_agreeing          INT,
  urgency                   TEXT DEFAULT 'normal' CHECK (urgency IN ('immediate','today','this_week','normal')),
  client_notified           BOOLEAN DEFAULT FALSE,
  client_acted              BOOLEAN,
  actual_exit_price         NUMERIC(14,4),
  pnl_inr                   NUMERIC(14,2),
  generated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE opportunity_comparisons (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id             UUID NOT NULL REFERENCES clients(id),
  test_type             TEXT CHECK (test_type IN ('same_category','cross_category','dead_weight')),
  current_instrument_id UUID REFERENCES instruments(id),
  current_score         NUMERIC(5,2),
  alt_instrument_id     UUID REFERENCES instruments(id),
  alt_score             NUMERIC(5,2),
  score_improvement_pct NUMERIC(8,2),
  switch_cost_inr       NUMERIC(14,2),
  payback_days          INT,
  recommendation        TEXT,
  threshold_met         BOOLEAN DEFAULT FALSE,          -- meets 15% improvement threshold
  generated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE recommendation_outcomes (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recommendation_id         UUID NOT NULL REFERENCES recommendations(id),
  client_id                 UUID NOT NULL REFERENCES clients(id),
  direction_correct         BOOLEAN,
  return_1w_pct             NUMERIC(8,4),
  return_1m_pct             NUMERIC(8,4),
  return_3m_pct             NUMERIC(8,4),
  nifty_return_same_period  NUMERIC(8,4),              -- benchmark comparison
  alpha_generated           NUMERIC(8,4),              -- return_3m - nifty_return
  profit_factor_contribution NUMERIC(8,4),
  engines_that_agreed       JSONB,
  client_held_to_horizon    BOOLEAN,
  entry_efficiency_pct      NUMERIC(8,2),
  exit_efficiency_pct       NUMERIC(8,2),
  measured_at               TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN 5: ALERTS & COMMUNICATION
-- ─────────────────────────────────────────────────────────────

CREATE TABLE alerts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID NOT NULL REFERENCES clients(id),
  recommendation_id   UUID REFERENCES recommendations(id),
  sell_signal_id      UUID REFERENCES sell_signals(id),
  alert_type          TEXT CHECK (alert_type IN ('morning_brief','buy_signal','sell_signal','stop_loss','goal_update','protection_gap','market_stress','weekly_review')),
  channel             TEXT CHECK (channel IN ('whatsapp','email','push','sms')),
  message_text        TEXT,
  message_preview     TEXT,                            -- first 160 chars for display
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','delivered','read','failed')),
  client_action       TEXT CHECK (client_action IN ('followed','ignored','partial','pending')),
  wa_message_id       TEXT,                            -- WhatsApp message ID for tracking
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_alerts_client ON alerts(client_id, created_at DESC);

CREATE TABLE morning_briefs (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id             UUID NOT NULL REFERENCES clients(id),
  brief_date            DATE NOT NULL,
  nifty_prediction      TEXT,                          -- bullish/bearish/neutral
  nifty_confidence      NUMERIC(5,2),
  nifty_range_low       NUMERIC(10,2),
  nifty_range_high      NUMERIC(10,2),
  vix_at_brief          NUMERIC(8,4),
  market_regime         TEXT,
  actions_json          JSONB,                         -- [{priority, text, type}]
  goals_update_json     JSONB,                         -- goal progress summary
  portfolio_summary     JSONB,
  macro_context         TEXT,
  whatsapp_message      TEXT,                          -- full formatted WA message
  alert_id              UUID REFERENCES alerts(id),
  generated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, brief_date)
);

CREATE TABLE whatsapp_interactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id),
  phone_number    TEXT,
  direction       TEXT CHECK (direction IN ('inbound','outbound')),
  message_type    TEXT CHECK (message_type IN ('text','template','interactive','command')),
  body            TEXT,
  command         TEXT,                                -- DETAILS / EXPLAIN / CALL / PORTFOLIO
  response_sent   TEXT,
  wa_message_id   TEXT,
  timestamp       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN 6: RISK GATE AUDIT
-- ─────────────────────────────────────────────────────────────

CREATE TABLE risk_gate_logs (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id               UUID NOT NULL REFERENCES clients(id),
  recommendation_id       UUID REFERENCES recommendations(id),
  instrument_id           UUID REFERENCES instruments(id),
  gate_1_eligibility      BOOLEAN,
  gate_2_position_size    BOOLEAN,
  gate_3_drawdown_sim     BOOLEAN,
  gate_4_liquidity        BOOLEAN,
  gate_5_correlation      BOOLEAN,
  gate_6_horizon          BOOLEAN,
  gate_7_confidence       BOOLEAN,
  gate_8_altman           BOOLEAN,
  gate_9_pledge           BOOLEAN,
  gate_10_vix             BOOLEAN,
  all_passed              BOOLEAN,
  failure_reasons         TEXT[],
  simulated_drawdown_pct  NUMERIC(8,4),
  checked_at              TIMESTAMPTZ DEFAULT NOW()   -- immutable audit trail
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN 7: SELF-LEARNING ENGINE
-- ─────────────────────────────────────────────────────────────

CREATE TABLE engine_weight_history (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_ending               DATE NOT NULL,
  technical_weight          NUMERIC(5,4) DEFAULT 0.125,
  fundamental_weight        NUMERIC(5,4) DEFAULT 0.125,
  management_weight         NUMERIC(5,4) DEFAULT 0.125,
  sentiment_weight          NUMERIC(5,4) DEFAULT 0.125,
  institutional_weight      NUMERIC(5,4) DEFAULT 0.125,
  sector_rotation_weight    NUMERIC(5,4) DEFAULT 0.125,
  pestle_weight             NUMERIC(5,4) DEFAULT 0.125,
  porters_weight            NUMERIC(5,4) DEFAULT 0.125,
  direction_accuracy_pct    NUMERIC(6,2),
  profit_factor             NUMERIC(6,4),
  sharpe_ratio              NUMERIC(6,4),
  signals_issued            INT,
  hc_signals_issued         INT,
  adjustment_rationale      TEXT,
  calculated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (Supabase)
-- ─────────────────────────────────────────────────────────────

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE morning_briefs ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend only)
-- Anon/authenticated users see only their own data
CREATE POLICY "client_own_data" ON clients FOR ALL USING (auth.uid()::text = id::text);
CREATE POLICY "portfolio_own_data" ON portfolios FOR ALL USING (auth.uid()::text = client_id::text);
CREATE POLICY "goals_own_data" ON client_goals FOR ALL USING (auth.uid()::text = client_id::text);
CREATE POLICY "recs_own_data" ON recommendations FOR ALL USING (auth.uid()::text = client_id::text OR client_id IS NULL);
CREATE POLICY "alerts_own_data" ON alerts FOR ALL USING (auth.uid()::text = client_id::text);
CREATE POLICY "briefs_own_data" ON morning_briefs FOR ALL USING (auth.uid()::text = client_id::text);

-- Instruments and market data are public read
CREATE POLICY "instruments_public_read" ON instruments FOR SELECT USING (TRUE);
CREATE POLICY "snapshots_public_read" ON market_snapshots FOR SELECT USING (TRUE);
CREATE POLICY "tech_signals_public_read" ON technical_signals FOR SELECT USING (TRUE);

-- ─────────────────────────────────────────────────────────────
-- SEED: INSTRUMENT UNIVERSE (150 instruments - key ones here)
-- ─────────────────────────────────────────────────────────────

INSERT INTO instruments (symbol, name, asset_class, sub_category, risk_tier, min_risk_score_required, exchange, nse_code) VALUES
-- Nifty 50 (sample)
('RELIANCE','Reliance Industries Ltd','equity','large_cap',3,5,'NSE','RELIANCE'),
('TCS','Tata Consultancy Services','equity','large_cap',3,5,'NSE','TCS'),
('HDFCBANK','HDFC Bank Ltd','equity','large_cap',3,5,'NSE','HDFCBANK'),
('INFY','Infosys Ltd','equity','large_cap',3,5,'NSE','INFY'),
('ICICIBANK','ICICI Bank Ltd','equity','large_cap',3,5,'NSE','ICICIBANK'),
('KOTAKBANK','Kotak Mahindra Bank','equity','large_cap',3,5,'NSE','KOTAKBANK'),
('LT','Larsen & Toubro Ltd','equity','large_cap',3,5,'NSE','LT'),
('ITC','ITC Ltd','equity','large_cap',3,5,'NSE','ITC'),
('SBIN','State Bank of India','equity','large_cap',3,5,'NSE','SBIN'),
('AXISBANK','Axis Bank Ltd','equity','large_cap',3,5,'NSE','AXISBANK'),
('BAJFINANCE','Bajaj Finance Ltd','equity','large_cap',3,6,'NSE','BAJFINANCE'),
('WIPRO','Wipro Ltd','equity','large_cap',3,5,'NSE','WIPRO'),
('MARUTI','Maruti Suzuki India','equity','large_cap',3,5,'NSE','MARUTI'),
('TATAMOTORS','Tata Motors Ltd','equity','large_cap',3,5,'NSE','TATAMOTORS'),
('SUNPHARMA','Sun Pharmaceutical','equity','large_cap',3,5,'NSE','SUNPHARMA'),
-- Mid cap (sample)
('PERSISTENT','Persistent Systems','equity','mid_cap',4,7,'NSE','PERSISTENT'),
('POLYCAB','Polycab India Ltd','equity','mid_cap',4,7,'NSE','POLYCAB'),
('ABBOTINDIA','Abbott India Ltd','equity','mid_cap',4,7,'NSE','ABBOTINDIA'),
-- Mutual Funds
('MF-MIRAE-LC','Mirae Asset Large Cap Fund','mutual_fund','large_cap',3,4,'AMFI',NULL),
('MF-SBI-BC','SBI Bluechip Fund','mutual_fund','large_cap',3,4,'AMFI',NULL),
('MF-AXIS-BC','Axis Bluechip Fund','mutual_fund','large_cap',3,4,'AMFI',NULL),
('MF-MIRAE-FLEXI','Mirae Asset Flexi Cap','mutual_fund','flexi_cap',3,5,'AMFI',NULL),
('MF-PPFAS-FLEXI','PPFAS Flexi Cap Fund','mutual_fund','flexi_cap',3,5,'AMFI',NULL),
('MF-HDFC-MID','HDFC Mid-Cap Opportunities','mutual_fund','mid_cap',4,7,'AMFI',NULL),
('MF-NIPPON-MID','Nippon India Mid Cap','mutual_fund','mid_cap',4,7,'AMFI',NULL),
('MF-HDFC-LIQUID','HDFC Liquid Fund','mutual_fund','liquid',1,1,'AMFI',NULL),
('MF-SBI-LIQUID','SBI Liquid Fund','mutual_fund','liquid',1,1,'AMFI',NULL),
('MF-AXIS-ELSS','Axis Long Term Equity (ELSS)','mutual_fund','elss',3,5,'AMFI',NULL),
('MF-NIPPON-INDEX','Nippon India Nifty 50 Index','mutual_fund','index',2,3,'AMFI',NULL),
('MF-UTI-NIFTY','UTI Nifty 50 Index Fund','mutual_fund','index',2,3,'AMFI',NULL),
-- Gold
('GOLDBEES','Nippon India Gold ETF (GoldBEES)','gold','etf',2,2,'NSE','GOLDBEES'),
('SGB-2026','Sovereign Gold Bond 2026','gold','sgb',1,2,'NSE',NULL),
-- Debt/G-Sec
('GSEC-726-2032','G-Sec 7.26% 2032','bond','gsec',1,1,'NSE',NULL),
('TBILL-91','91-Day Treasury Bill','bond','tbill',1,1,'NSE',NULL),
-- REITs
('EMBASSY','Embassy Office Parks REIT','reit','commercial',3,5,'NSE','EMBASSY'),
('MINDSPACE','Mindspace Business Parks REIT','reit','commercial',3,5,'NSE','MINDSPACE'),
-- Indices (for prediction/benchmark)
('NIFTY50','Nifty 50 Index','index','benchmark',0,0,'NSE','NIFTY'),
('SENSEX','BSE Sensex','index','benchmark',0,0,'BSE','SENSEX'),
('INDIAVIX','India VIX','index','volatility',0,0,'NSE','INDIAVIX');
