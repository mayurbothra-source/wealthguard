# WealthGuard scoring & accuracy audit — 23 Nov 2026 (Phase 0, read-only)

Audited: `main` at `9c08a29` — **production is still running `main`**; none of PRs
#7–#15 is merged. Live Supabase project `mvuezfomqtgnxwrlnrvd`, Render logs 16–23 Nov.
No code was changed for this audit.

## Headline

**Prediction accuracy cannot be stated today, and the little that exists is not honest.**

| | Count |
|---|---|
| House recommendations | 2,005 — 1,938 WATCH, 38 SELL, 27 BUY, 2 HOLD |
| Recommendations with an outcome row | 552 WATCH (no direction claimed), 14 SELL, 1 HOLD, **0 BUY** |
| Outcomes with a correct/wrong verdict | 15 — 6 "correct", 9 wrong |
| Of the 6 "correct" | **all 6 are SELLs on two mutual funds whose NAV never moved (0.00%)** because their scheme codes are dead |
| Honest directional record | **0 correct of 9** measurable SELLs (all 9 rose 1.9%–8.6%); the 1 HOLD was wrong |
| `recommendations.outcome_correct` filled | **0 of 2,005** |
| Last BUY | 12 Sep 2026 — and all 27 BUYs ever issued were bonds or debt funds |

---

## Q1. Track-record checkpoint window — why "0 checkpoints in window"

`backend/services/trackRecordEngine.js`

- Checkpoints: `CHECKPOINTS` (`:15-19`) = 7 d (Weekly), 30 d (Monthly), 90 d (Quarterly). There is no 14-day checkpoint, although standard signals claim a 14-day horizon.
- Window: `checkpointDue` (`:36-38`) — due when `daysOld ≥ checkpoint − 0.5` and `≤ checkpoint + 14` (`CHECKPOINT_TOLERANCE_DAYS`, `:25`). **This arithmetic is correct.**
- **The bug is the query, not the window** (`runTrackRecordCheckpoints`, `:190`, query at `:200-214`):

  ```js
  .from('recommendations') … .is('client_id', null).not('entry_price_inr', 'is', null)
  .order('generated_at', { ascending: false })
  .limit(500);
  ```

  It loads only the **500 newest** recommendations. The scoring engine writes ~114 a day
  (last 7 days), so those 500 are only ~4–5 days old — younger than the 7-day Weekly
  checkpoint. Nothing older is ever loaded, so nothing is ever due.
- The health log shows the window draining exactly as the newest-500 slide forward:
  500 (11 Nov) → 404 (12 Nov) → 384 → 308 (13 Nov) → 96 (14–16 Nov) → 20 (16–17 Nov) → **0 (from 17 Nov 11:00 UTC to today)**.
- The 14-day *late* tolerance also means a missed checkpoint is lost for good (the 27 BUYs of 28 Aug–12 Sep passed every window while the engine was not running).

**H6: confirmed in effect, wrong in mechanism** — the date arithmetic is fine; the `limit(500)` on newest rows excludes every recommendation old enough to score.

## Q2. Outcome writing

- Writes only to `recommendation_outcomes` (`db.writeTolerant(... 'insert', outcomeRow ...)`, `:315`).
- Nothing in the codebase writes `recommendations.outcome_correct` (column exists — `scripts/schema.sql:345`; `grep` finds no writer). 0 of 2,005 are filled.

**H7: confirmed.**

## Q3. NAV freshness for the 0.00% funds

Price path: `fetchCurrentPrice` (`trackRecordEngine.js:59`) → `instrumentEngine.fetchInstrumentPrice` → `marketData.getMFNav(amfi_code)` → `https://api.mfapi.in/mf/<code>/latest`. No cache in this path.

| Fund | AMFI code | Entry (1 Oct, 2 Nov) | "Current" (11 Nov) | Stored history |
|---|---|---|---|---|
| MF-FRK-PRM | 100035 | ₹14.55 / ₹14.55 | ₹14.55 | 1,371 NAVs, last ₹14.55, 1-y return −15.7% |
| MF-HDFC-MC | 118990 | ₹34.885 / ₹34.885 | ₹34.885 | 1,333 NAVs, last ₹34.885, 1-y return −5.0% |

Live funds carry ~3,400 NAVs; these two stop at ~1,350 and never change. MFAPI is returning
the **last NAV of a scheme code that no longer publishes** — a wrong/dead AMFI code (likely an
old or merged plan), not caching. Same pattern: MF-SBI-STD (constant ₹10.4807, 319 NAVs),
MF-AXIS-SD (243), MF-AXIS-BC (358). MFAPI is not reachable from this sandbox, so the raw API
response could not be logged here; PR #10 adds `GET /api/admin/verify-instruments`, which
logs scheme name, latest NAV date and duplicates for every code from the server.

**H8: confirmed — stale NAV, cause is dead scheme codes.**

## Q4. Direction correctness

`isDirectionCorrect` (`trackRecordEngine.js:143-158`):

```js
const bullish = ['BUY', 'HOLD'].includes(a);
const bearish = ['SELL', 'REDUCE'].includes(a);
if (bullish) return returnPct >= 0;
if (bearish) return returnPct <= 0;
return null;   // WATCH
```

- **0.00% counts as correct for both BUY and SELL.** All 6 "correct" verdicts are 0.00% SELLs on the two dead-code funds above.
- HOLD is scored as bullish (correct if ≥ 0), not "held steady".
- WATCH: `classifyWatchOutcome` (`:162-167`), ±3% band, no direction — correct as designed.

**H9: confirmed.**

## Q5. "Duplicate" outcomes

- `recommendation_outcomes` has **no** duplicate `(recommendation_id, checkpoint_label)` pairs (0), and **no unique constraint** either; the engine relies on `checkpointAlreadyLogged` (`:176`), a check-then-insert that two overlapping runs could race.
- The apparent duplicates are **duplicate recommendations**: two scoring runs on the same day each wrote a row for the same instrument (e.g. MF-FRK-PRM ×2 on 1 Oct). **200 instrument-days** have more than one recommendation, so the same call is counted twice in any tally. (Since PR #4 the engine deactivates older active rows, but each run still inserts a new one.)

## Q6. AI lever failures

From Render logs 16–23 Nov:

- **Every failure is `Request failed with status code 503`** from Gemini (model overloaded/unavailable).
- `aiProvider.ask` (`backend/services/aiProvider.js:298`, loop `:305`) makes **one attempt per provider with no retry or backoff** for 503 (only 429s feed a circuit breaker).
- The fallback **is** implemented (Anthropic is the second provider in the loop), but `ANTHROPIC_API_KEY` is not set in Render, so it is skipped — hence `anthropic: 0` in every run. (Anthropic is deferred by decision.)
- `aiLeverEngine.runAILeverScan`: the Depth-1 call (`detectEventsFromNews`, `:456`) is inside the main `try`; one 503 there aborts the whole scan (`errors.push('Main scan …')`, `:567`) — the 17 and 23 Nov runs ("1 AI call, 1 failed, 0 events").
- Depth-2/3 per-event and per-instrument errors are caught and counted; 2–5 of ~27–32 calls fail per run (7–18%).
- Health status was inflated: errors were divided by *events*, not calls (fixed in PR #15).
- **The AI lever never writes to `recommendations`** — it only stores `ai_events` / `ai_instrument_flags`. It cannot block or create a BUY.

**H10: confirmed (503s, no retry, no Anthropic key).**

## Q7. BUY drought

- Decision: composite of 9 levers → `BUY ≥ 70`, `WATCH 50–69`, `SELL < 50` (`instrumentEngine.js:419`, `:922`); the risk gate can veto.
- **No-data rule** (`leverEngine.js:430-440`, applied `instrumentEngine.js:920-924`): an instrument without its own price history is forced to WATCH.
- Latest scores (live data):

  | Category | Instruments | Measured on real prices | Best measured composite |
  |---|---|---|---|
  | Stocks, index ETFs, gold ETFs | 59 | **0** (Yahoo HTTP 429 from Render) | — |
  | Bonds / G-Secs | 10 | 0 (static price) | — (baseline 71) |
  | Debt funds | 10 | 10 | **69** |
  | Large-cap funds | 18 | 16 | 66 |
  | Flexi / mid-cap funds | 3 | 1 | 64 |

  Nothing measured reaches 70.
- What changed around 12 Sep: the lever rewrite (`leverEngine.js`, committed 29 Sep) replaced category constants with measured levers and added the no-data rule. **The 27 BUYs before it were all bonds and debt funds scoring 70–71 on category constants** (10 of them static-priced, unmeasurable). After it, unmeasured instruments cannot be directional, and the only measured ones (funds) top out at 69.

**H11: rejected.** The AI lever is not part of the composite and does not gate BUY. The drought is (a) no price history for 74 Yahoo instruments and (b) measured funds scoring 59–69.

## Q8. Hypotheses

| | Verdict |
|---|---|
| H6 window excludes everything | Confirmed in effect — cause is `limit(500)` on newest rows, not date maths |
| H7 `outcome_correct` never written | Confirmed |
| H8 0.00% = stale NAV | Confirmed — dead AMFI scheme codes |
| H9 0.00% SELL counted correct | Confirmed (`returnPct <= 0`; BUY likewise `>= 0`) |
| H10 Gemini fails, no fallback | Confirmed — HTTP 503, no retry, no Anthropic key |
| H11 AI lever blocks BUY | Rejected — AI lever never touches the composite or `recommendations` |

## Other facts checked

- **"7 identical briefs" on 23 Nov:** the brief engine ran once; `email_log` shows 11 sends to **11 different addresses**, one each. The 7 are the seven `@gmail.com` recipients (6 demo accounts + House Track Record), which likely land in one inbox. Not a duplicate send.
- Brief send time 12:30–16:00 IST: production still lacks PR #8 (WS1).
- `example.com` failure: still present (out of scope).
