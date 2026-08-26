# 🛡️ WealthGuard — Investment Intelligence Platform v1.0

> Capital preservation first. Wealth growth as the consequence.

## What This Is

WealthGuard is a full-stack AI-powered investment intelligence platform for the Indian market. It delivers personalised buy/sell signals, daily WhatsApp morning briefs, goal-based portfolio tracking, and continuous risk monitoring — from a ₹10,000/month earner to an HNI.

---

## Architecture

```
wealthguard/
├── backend/
│   ├── server.js                    # Express server, routes, middleware
│   ├── engines/
│   │   ├── analysisEngine.js        # 8 analytical engines + AI convergence
│   │   └── riskGate.js              # 10 hard risk checks
│   ├── routes/
│   │   ├── auth.js                  # Client registration & onboarding
│   │   ├── portfolio.js             # Holdings management
│   │   ├── signals.js               # Signal generation & retrieval
│   │   ├── market.js                # Live market data
│   │   ├── brief.js                 # Morning brief generation
│   │   ├── goals.js                 # Goal bucket management
│   │   ├── clients.js               # Client profile management
│   │   └── whatsapp.js              # WhatsApp webhook & messaging
│   └── services/
│       ├── marketData.js            # NSE, MFAPI, macro data feeds
│       ├── scheduler.js             # Cron jobs: briefs, EOD, self-learning
│       └── whatsapp.js              # WhatsApp Business API service
├── frontend/
│   └── public/
│       └── index.html               # Full SPA — landing, onboarding, dashboard
├── scripts/
│   └── schema.sql                   # Complete Supabase/PostgreSQL schema
├── config/
│   └── supabase.js                  # Database client
├── .env.example                     # Environment variables template
└── README.md
```

---

## Eight Analytical Engines

| Engine | Signal | Data Source |
|--------|--------|-------------|
| 1. Technical Analysis | RSI, MACD, DMA, Bollinger | NSE live data |
| 2. Fundamental Analysis | PE, ROE, Altman Z-Score, FCF | Screener.in / NSE |
| 3. Management Quality | Promoter holding/pledge, ROCE | BSE disclosures |
| 4. Sentiment & NLP | News score, VIX regime | Moneycontrol RSS |
| 5. Institutional Flow | FII/DII daily flows | NSE data |
| 6. Sector Rotation | Economic cycle positioning | Macro indicators |
| 7. PESTLE | Political/Economic/Social/Tech/Legal/Env | AI + news |
| 8. Porter's Five Forces | Sector competitive dynamics | Quarterly update |

**Convergence Rule:** BUY requires 5/8 engines. SELL requires 3/8. High Conviction needs 7/8.

---

## Nine Accuracy Levers

1. Convergence threshold (5/8 standard, 7/8 HC)
2. Confirmation waiting period (weekly chart confirmation)
3. Multi-timeframe agreement (daily + weekly + monthly)
4. Market regime filter (VIX-based)
5. Earnings exclusion window (10 trading days)
6. PESTLE force-combination filter
7. Client Stability friction layer
8. Self-learning weekly loop
9. Focused universe (150 instruments deeply analysed)

**Target:** 75%+ direction accuracy on High Conviction signals by Month 18.

---

## Quick Start

### 1. Clone and install
```bash
git clone https://github.com/yourorg/wealthguard
cd wealthguard
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Set up Supabase
```bash
# Create a new Supabase project at supabase.com
# Run the schema in Supabase SQL editor:
cat scripts/schema.sql | # paste into Supabase SQL editor
```

### 4. Run
```bash
npm start          # Production
npm run dev        # Development (with nodemon)
```

### 5. Access
```
http://localhost:3000
```

**Demo mode:** The platform runs fully without any API keys configured. Demo data is served for all market data, AI responses, and WhatsApp messages are logged to console.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Recommended | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Recommended | Supabase anonymous key |
| `SUPABASE_SERVICE_KEY` | Recommended | Supabase service role key |
| `ANTHROPIC_API_KEY` | Optional | Claude AI for signal reasoning |
| `WHATSAPP_TOKEN` | Optional | Meta WhatsApp Business API token |
| `WHATSAPP_PHONE_ID` | Optional | WhatsApp phone number ID |
| `PORT` | No | Server port (default: 3000) |

All credentials are optional for demo/development. The platform degrades gracefully to demo mode.

---

## API Endpoints

### Authentication
- `POST /api/auth/register` — Client onboarding with full profile
- `POST /api/auth/login` — Phone-based client lookup

### Portfolio
- `GET /api/portfolio/:clientId` — Holdings with live prices
- `POST /api/portfolio/add` — Add holding manually
- `PUT /api/portfolio/:holdingId` — Update price/stop-loss
- `DELETE /api/portfolio/:holdingId` — Remove holding

### Signals
- `GET /api/signals/:clientId` — Active signals for client
- `POST /api/signals/generate` — Run analysis engine for instrument

### Market
- `GET /api/market/snapshot` — Full market snapshot
- `GET /api/market/quote/:symbol` — Single instrument quote
- `GET /api/market/regime` — Current VIX regime classification

### Morning Brief
- `GET /api/brief/:clientId` — Get/generate today's brief
- `POST /api/brief/:clientId/send` — Send brief via WhatsApp

### Goals
- `GET /api/goals/:clientId` — Client goals with progress
- `POST /api/goals/add` — Add new goal
- `PUT /api/goals/:goalId/progress` — Update corpus

### WhatsApp
- `GET /api/whatsapp/webhook` — Meta webhook verification
- `POST /api/whatsapp/webhook` — Incoming message handler

---

## Scheduled Jobs

| Job | Schedule | Action |
|-----|----------|--------|
| Morning Brief | 7:30 AM IST, Mon-Fri | Generate + send WhatsApp briefs to all clients |
| Market Data | Every 5 min, 9:15-3:30 IST | Refresh prices, check stop-losses |
| EOD Analysis | 4:30 PM IST, Mon-Fri | Full 8-engine analysis run |
| Opportunity Engine | 10 PM IST, Mon-Fri | Same-category and cross-category comparisons |
| Self-Learning Loop | Sunday 8 PM IST | Recalibrate engine weights from outcomes |

---

## Client Tiers

| Tier | Income | Products | Brief |
|------|--------|----------|-------|
| Starter | ₹10K–₹50K/mo | Liquid MF, PPF, Index SIP, ELSS | Weekly |
| Builder | ₹50K–₹3L/mo | + Nifty 50 stocks, Gold ETF, Short-duration debt | Daily |
| Wealth Builder | ₹3L–₹20L/mo | + Mid-cap, REITs, Corporate bonds | Daily + real-time |
| HNI/Ultra-HNI | ₹20L+/mo | Full universe + International + Legacy | Daily + advisor |

---

## Risk Gate — 10 Hard Rules

1. Instrument eligibility vs client risk score
2. Position size cap (default 10% per instrument)
3. 30% crash drawdown simulation
4. Liquidity runway (6-month emergency fund protected)
5. Correlation overexposure check
6. Horizon mismatch (investment period vs goal date)
7. Confidence score filter (< 60% = never pushed)
8. Altman Z-Score (< 1.8 = distress zone, BUY blocked)
9. Promoter pledge (> 50% = BUY blocked)
10. India VIX override (≥ 25 = all BUYs frozen)

F&O (Futures & Options) is **permanently blocked at architecture level** — not a configuration option.

---

## Deployment (Production)

### Backend — Railway.app
```bash
# Connect GitHub repo to Railway
# Set environment variables in Railway dashboard
# Railway auto-deploys on push to main
```

### Frontend — Already served by Express
The frontend SPA is served as static files from `frontend/public/`.

### Supabase
- Enable Row Level Security (already in schema)
- Set up realtime subscriptions for live price updates
- TimescaleDB extension recommended for market_snapshots table

---

## Regulatory Note

**India:** Operating as research/analytics with disclaimers is acceptable for Phases 1-2. SEBI RIA (Registered Investment Adviser) registration required for personalised advice for a fee at scale.

**UK (Phase 2):** FCA authorisation or Appointed Representative arrangement required before issuing personalised buy/sell recommendations. Launch as financial guidance initially.

---

*WealthGuard Platform v1.0 · India · August 2026*  
*Capital preservation is not a constraint — it is the strategy.*
