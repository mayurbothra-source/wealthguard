# WealthGuard consolidated audit — 24 Nov 2026 (Phase 0, read-only)

Audited: `main` at `9c08a29`, the code **production is running**. Live Supabase
project `mvuezfomqtgnxwrlnrvd` (read-only queries). No code was changed.

## The one fact that explains most of what was observed

**None of the fixes from the two earlier prompts is in production.** PRs #7–#21
are open and unmerged. Production still runs `main` from 12 Nov. Every
symptom reported for 23–24 Nov is the old code behaving as it was written.
Most items in this prompt are already implemented in those PRs (map at the
end); a few are new gaps or rest on a misreading of the data.

---

## Delivery & data freshness

### Q1. Morning brief loop — the "duplicate email flood"
`backend/services/morningBriefEngine.js`:
- `generateAndSendMorningBrief` reads every client (`:559`, `select('*').limit(5000)`)
  and loops once per client (`:575`).
- Each brief is upserted on `(client_id, brief_date)` (`persistBrief` `:502`, `:517`).
- A second same-day run skips clients already emailed (`:568`).

Production data:

| brief_date | rows | distinct clients | emailed | send window (UTC) |
|---|---|---|---|---|
| 20 Nov | 12 | 12 | 11 | 09:50:12–09:50:28 |
| 23 Nov | 12 | 12 | 11 | 10:29:24–10:29:40 |
| 24 Nov | 12 | 12 | 11 | 03:01:45–03:01:59 |

- **There are 12 clients and 12 rows: one row and at most one email per client per day.**
  `items_processed: 12` means 12 clients.
- **The "7 identical emails"** arrive because **7 of the 12 clients share one Gmail inbox**: the six
  Demo accounts plus "WealthGuard House Track Record" are `+alias` addresses of the
  same `@gmail.com` mailbox (checked by normalising the address; the addresses are
  not reproduced here). Gmail delivers all seven to one inbox.
- The other 5 rows are: 1 real starter, 3 TEST accounts, and 1 `@example.com` test
  account (not emailed: HTTP 422).

**H12: rejected.** The loop is correct. The fix is about recipients, not the loop:
- demo, house and test accounts must not email a real inbox, or only the admin
  copy should, with one copy per day;
- delete or disable the `example.com` account.

A paying subscriber with one address gets one email. The DB-level guarantee the
prompt asks for already exists in PR #8 (WS1): the `brief_deliveries` unique
`(client_id, ist_date)` plus the idempotent `POST /api/jobs/morning-brief`.

### Q2. Market data — "frozen" Nifty / Sensex / VIX
`backend/services/marketData.js`:

**Nifty** — `getNSEIndex` (`:153`) tries these in order:
1. NSE `allIndices`
2. Yahoo `^NSEI`
3. the Supabase cache `market_cache.index_prices_v1`, accepted up to **3 days** old (`:129`)
4. a hard-coded demo value (24,650.25), labelled `demo` (`:191`)

**Sensex** — `getSensex` (`:405`) uses Yahoo `^BSESN` → demo.

`market_cache` today:
- `NIFTY 50`: 25,349.65, −1.75%, `nse_live`, **at 23 Nov 15:52 UTC**
  (cache not refreshed on 24 Nov: the 24 Nov 03:01 UTC fetch fell back to the cache).
- `INDIA VIX`: 17.86, `nse_live`, at **24 Nov 03:01 UTC** (fresh).
- Sensex: 82,435.99, −1.77%, `yahoo_live`, saved 24 Nov 03:01 UTC.

25,349.65 / 82,435.99 is the **23 Nov close** (both indices −1.7%).
- The 23 Nov brief was sent at 15:59 IST, **after** the close.
- The 24 Nov brief was sent at 08:31 IST, **before** the 09:15 open.

So both briefs correctly showed the latest close. The numbers are not frozen. What
is wrong:
1. The 24 Nov Nifty came from the 3-day cache, and the email did not say "as of 23 Nov close".
2. There is no "unchanged across briefs" check.
3. The demo fallbacks still exist in code.

**H13: rejected as stated** (no stale cache served a wrong number). The real gaps
are labelling and staleness rules. PR #9 (WS2) rewrites this:
- `indexData.js`, with `as_of` and `prev_close` per index
- Nifty / Sensex / VIX from NSE, then Yahoo
- `market_cache` key `index_prices_v2`
- the >4% move flagged as unverified
- no demo values, plus an admin `data-freshness` endpoint

Still missing in #9: the 4-hour TTL and the "unchanged for 2 briefs" warning.

### Q3. VIX shown, `vix_at_brief` NULL
- The snapshot text gets VIX from `snapshot.vix` (`morningBriefEngine.js:59-76`), and the
  email renders that text.
- `persistBrief` (`:502-518`) never writes `vix_at_brief`, so the column is NULL on every
  row. The value is live (17.86 from NSE), **not hard-coded**.

**H2: rejected** — not hard-coded or stale; the gap is that it is never stored.
**No open PR writes `vix_at_brief`.** This is a new gap.

### Q4. `market_regime`
- `classifyVIXRegime` (`marketData.js:314`) produces calm / normal / elevated / fear / crisis.
- Nothing writes `morning_briefs.market_regime`. **A new gap.**
- The prompt's bands (<15 Low, 15–20 Moderate, 20–30 Elevated, >30 High) differ from
  the risk gate's VIX bands (12 / 16 / 20 / 25). Storing the prompt's label is
  fine; the risk-gate thresholds stay as they are (frozen behaviour).

### Q5. Scheduler timing
`backend/services/scheduler.js` (`startSchedulers` `:203`):
- node-cron fires at `0 2 * * 1-5` UTC (07:30 IST).
- On the free plan the process is asleep then, so the cron never fires.
- The brief actually goes out when `.github/workflows/wake.yml` (`2 2 * * 1-5`) wakes the
  server and `catchUpMissedJobs` (`:105`) runs it.
- GitHub delays scheduled runs: the brief went out at **08:31 IST on 24 Nov, 15:59 IST on 23 Nov,
  and 15:20 IST on 20 Nov**.

**H4: confirmed.** PR #8 (WS1) fixes this:
- `POST /api/jobs/morning-brief` with a header secret and constant-time compare
- a `morning-brief.yml` workflow at 01:45 / 02:15 / 02:45 UTC
- warm-up with 5 retries
- the 12:00 IST cut-off with `skipped_late`
- a loud failure if the job fails

---

## Recommendation engine

### Q6. "0 recommendations on 24 Nov"
- **Recommendations come from `instrumentEngine` (scoring), not `opportunityEngine`.**
  `opportunityEngine` (`22:34 UTC 23 Nov`, "0 breakouts, 1 dual, 0 rotation") writes
  sector *opportunities*. "1 item" means one opportunity.
- Scoring is scheduled for Sunday only (`scheduler.js`), but the wake catch-up re-runs it
  whenever the last run had poor price history (`:132`). In practice it runs **every
  evening**:

  | Date | Run time (IST) | Signals |
  |---|---|---|
  | 20 Nov | 17:12 | 100 (98 WATCH + 2 SELL) |
  | 21 Nov | 19:01 | 100 (98 WATCH + 2 SELL) |
  | 22 Nov | 19:16 | 100 (98 WATCH + 2 SELL) |
  | 23 Nov | 17:50 | 100 (98 WATCH + 2 SELL) |

- The 24 Nov run had not happened yet when the 08:31 IST brief was built. The
  brief therefore used the **23 Nov evening signals**, which is by design.
- The recycled ideas are the same funds because the same funds score highest every day.

**H14: rejected** — the brief reads the latest scoring run; the evening schedule is
the issue. FIX-4's chain (data → scoring → brief) is **not** in any PR. It is a
new gap, and it is constrained by the free plan: a full scoring pass with Yahoo
pacing takes 20–40 min.

### Q7. Instrument pricing (120 active + watchlist)

| price_source | total | active | gaps |
|---|---|---|---|
| yahoo | 74 | 60 | Render gets HTTP 429 on **history** for most (`yahoo=73` live quotes, but no history) |
| mfapi | 36 | 30 | 3 with no AMFI code (AXISELSS, ICICIBAETF, MF-HDFC-BAL) and 6 dead codes |
| static | 10 | 10 | GSEC10Y, GSEC7Y, SDL, TBILL91, RECBOND, PFCBOND, NHAIBOND, RBIFLOAT, SGB, DIGITALGOLD |

- Last scoring run: "yahoo=73 mfapi=30 static=10 missing=7".
- **Dead AMFI codes** (the NAV history ends years ago, from the SA5 dry run): MF-FRK-PRM
  (2011), MF-HDFC-MC (2018), MF-AXIS-BC (2016), MF-AXIS-SD (2014), MF-NIP-MC (2016),
  MF-SBI-STD (2014).
- **H1: confirmed** for all 10 static instruments.

**Ticker claims in the prompt.** These are verified, not applied blindly:
- `BHARAT22ETF` → current `ICICIB22.NS` **works**: the GitHub dry run fetched its
  history and scored it. ICICIB22 is the ETF's NSE symbol, and `BHARAT22.NS` is
  unverified. **Do not change.**
- `SBIGOLD` is already `SETFGOLD.NS`. No change needed.
- `AXISGOLD` (`AXISGOLD.NS`) could not be checked: HTTP 429 from Yahoo on Render and
  on GitHub. `AXISGOLDETF.NS` is unverified.

PR #10 adds `GET /api/admin/verify-instruments` to check every ticker and code from
the server before any change.

### Q8. Signal decision, target / stop, reward:risk
- BUY ≥ 70, WATCH 50–69, SELL < 50, then the risk gate (`instrumentEngine.js:396`, `:913-915`).
- Target / stop on `main` are fixed percentages of entry (`:522`).
- `recommendations.risk_reward_ratio` exists (`schema.sql`) but **nothing writes it**. It
  is NULL on all 400 rows from 20–23 Nov.

**H3: confirmed.** PR #10 (WS3):
- volatility-derived levels (1.5σ / 2.5σ)
- reward:risk ≥ 1.5, else WATCH with `downgrade_reason`
- `price_mode` (live / daily_nav / static) plus a freshness gate

But #10 writes a **new** `reward_risk` column, not the existing `risk_reward_ratio`.
This is a small gap: write both, or use the existing column.

### Q9. Why only debt funds reach the brief
- With no price history, every stock and ETF is forced to WATCH by the no-data rule.
- Only mutual funds are measured, and debt funds score highest (59–69), so the
  top WATCH ideas are always debt funds.

**H5: confirmed on `main`.** PR #11 (WS4) adds breadth (no single class crowds out
the others) and risk-profile filtering. The root cause remains the Yahoo history
block (see SA5).

---

## Scoring pipeline (detail in `docs/AUDIT-SCORING-2026-11.md`)

- **Q10 — window:** the query loads only the **500 newest** rows (`trackRecordEngine.js:200-214`).
  At ~100 a day, those are younger than the 7-day checkpoint, so every run since 17 Nov logs
  "0 checkpoints in window". **H6: confirmed in effect** (the date arithmetic is fine). PR #16 fixes it.
- **Q11 — `outcome_correct`:** only `recommendation_outcomes` is written; nothing writes
  `outcome_correct`. **H7: confirmed.** PR #17.
- **Q12 — NAV:** 0.00% funds have dead AMFI codes; MFAPI returns the last NAV from years
  ago. **H8: confirmed.** PR #18 (`price_suspect`, checkpoint-date NAV, staleness).
- **Q13 — direction:** `isDirectionCorrect` uses `>= 0` / `<= 0`, so 0.00% counts as
  correct. **H9: confirmed.** PR #18.
- **Q14 — duplicates:** there are 0 duplicate (recommendation, checkpoint) outcome pairs and no
  unique index. The visible doubles are **duplicate recommendations** (two scoring runs on one day).
  PR #16 adds the index; duplicate recommendations remain open.

## AI lever

- **Q15:** every failure is Gemini **HTTP 503**, with one attempt and no retry. The Anthropic
  step is skipped because no key is set. A Depth-1 failure aborts the scan.
  **H10: confirmed.** PR #19:
  - retries with backoff
  - a second Gemini model / second free key (`GOOGLE_API_KEY_FALLBACK`)
  - Claude only if a key is ever set
  - full error logging
  - the label shown only for a real AI result
- **Q16:** the AI lever is **not** part of the composite and never gated BUY.
  **H11: rejected.** BUY stopped when category constants were replaced by measured
  levers, and the stocks are unmeasurable (Yahoo 429).
  The SA5 dry run on real Oct–Nov prices produced BUYs for KOTAKBANK (9, 16, 20 Nov)
  and ICICIBANK (20 Nov), with no AI lever and thresholds unchanged. PR #20.

## Demo accounts & alerts

### Q17. Demo accounts
- 6 Demo accounts: Beginner 1/2 (starter), Builder 1/2 (builder), Wealth Builder 1/2
  (wealth_builder), all `active`. **No risk profile, 0 holdings, 0 goals.**
- The greeting "Good morning, Demo" is the first word of "Demo Beginner 1": on `main` the
  greeting uses the first word of `full_name`.
- All six, plus the House account, are aliases of one Gmail inbox (see Q1).
- PR #12 (WS5) adds `scripts/seeds/demo_accounts_seed.sql`: DEMO-ONLY holdings, one near
  its stop, and profiles. It has not been run. PR #11 falls back to "Hello" for missing names.
  The demo names would still read "Demo"; renaming them is a data decision.

### Q18. Alerts
- **flashAlertEngine** (`main`): hourly scans; emails subscribers on index, holding and
  AI-critical events. Earlier feedback said that was too noisy. PR #15 limits subscriber
  emails to **falls only** (Nifty or Sensex −1% in an hour; a holding −3%), de-duplicated
  per event and client. AI-critical goes in-app.
- **opportunityEngine:** writes `opportunities`; shown in the brief only for Builder and
  above (PR #11).
- **trackRecordEngine:** writes outcomes; shown in the brief's track record block
  (PR #21, after the market snapshot).
- **SELL signals are not shown to subscribers on `main`.** PR #11 shows held SELLs as
  EXIT / REVIEW in "Your Portfolio", but **new SELL calls on instruments the client does not
  hold are not surfaced as "consider exiting / avoid"**. A gap for FIX-7.

---

## Hypotheses

| # | Verdict |
|---|---|
| H1 static fixed income | **Confirmed** (10 instruments) |
| H2 VIX hard-coded | **Rejected** — VIX is live (17.86 NSE); it is just never stored |
| H3 fixed % target/stop, RR null | **Confirmed** |
| H4 brief depends on an awake process | **Confirmed** |
| H5 no profile/tier differentiation | **Confirmed** on `main` (fixed in #11) |
| H6 track-record window | **Confirmed in effect** — cause is `limit(500)` |
| H7 `outcome_correct` never written | **Confirmed** |
| H8 0.00% = stale NAV | **Confirmed** — dead AMFI codes |
| H9 0.00% SELL = correct | **Confirmed** |
| H10 Gemini fails, no fallback | **Confirmed** (503, no retry, no key) |
| H11 AI lever blocks BUY | **Rejected** |
| H12 loop sends duplicates | **Rejected** — one email per client; 7 accounts share one Gmail inbox |
| H13 market data frozen in cache | **Rejected as stated** — figures were the true last close; labelling and staleness rules missing |
| H14 recommendation engine did not run | **Rejected** — it runs each evening; the morning brief used the previous evening's run |

## FIX workstreams vs. what already exists

| FIX | Already built (open PR) | Still missing |
|---|---|---|
| FIX-1 duplicates | #8: `brief_deliveries` unique (client, IST date), idempotent secret endpoint, test-mail-to-admin rule | demo / house / test accounts sharing a real inbox (data or config). `morning_briefs` **already has** `UNIQUE (client_id, brief_date)` (`morning_briefs_client_id_brief_date_key`), so there are no historical duplicate rows to clean (0 found) |
| FIX-2 market data | #9: `indexData`, NSE → Yahoo, `as_of`, prev close, >4% unverified, no demo values, admin freshness | 4-hour TTL; "unchanged for 2 briefs" warning; write `vix_at_brief` and `market_regime` |
| FIX-3 07:30 delivery | #8: crons at 01:45 / 02:15 / 02:45 UTC, warm-up, 12:00 cut-off, loud failure | — |
| FIX-4 recommendations | #10: `price_mode`, vol-based levels, RR ≥ 1.5, freshness gate, verify-instruments | data → scoring → brief chain before 07:30; write `risk_reward_ratio`; ticker changes (only after verify-instruments) |
| FIX-5 scoring | #16, #17, #18 | run migrations 016 → backfill → 018 → 017 after deploy |
| FIX-6 AI + BUY | #19 (+ second free key), #20 | Yahoo history source for stocks (decision) |
| FIX-7 brief content | #11 (greeting, rationale, breadth, why-no-ideas, AI label, confidence), #21 (track record block) | new SELL calls surfaced to subscribers |
| FIX-8 portfolio / alerts / observability | #12 (seed, portfolio, test-alert), #13 (system health, 08:30 summary), #15 (fall-only alerts) | run the demo seed |
