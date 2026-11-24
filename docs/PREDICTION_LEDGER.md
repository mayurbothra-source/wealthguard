# Prediction ledger (Google Sheet)

Every prediction the engine makes — BUY, SELL, WATCH or HOLD — is recorded
with its date and checked automatically at four checkpoints. The Google Sheet
shows each one and colours it: **green when it was right, red when it was wrong**.

## What the sheet shows

**Predictions tab** — one row per prediction (per instrument per day), newest first (illustrative row):

| Date | Instrument | Prediction | Entry price | Weekly | Monthly | Quarterly | Annual | Overall |
|---|---|---|---|---|---|---|---|---|
| 1 Oct 2026 | MF-NIP-LC | SELL | 87.70 | ✗ +1.85% (₹89.32 on 8 Oct) | ✗ +8.15% (₹94.85 on 31 Oct) | due 9 Jan 2027 | due 6 Oct 2027 | Wrong |

- Each checkpoint shows the return, **the price used and the date it was taken**, so any
  verdict can be checked against the public NAV or closing price.
- Checkpoints: Weekly = 7 days, Monthly = 30, Quarterly = 90, Annual = 365 days after
  the prediction, priced at that day's close (or the nearest earlier trading day).
- **Overall** — strictest wins: any wrong checkpoint makes the row red; right at every
  checkpoint so far makes it green. A later checkpoint can turn green to red.

**Accuracy tab** — right / wrong / accuracy for each checkpoint and each prediction
type, plus the overall figure and when the scoring engine last ran. A percentage
appears only once at least 10 predictions have a verdict; before that it says
"building (N scored)".

## Rules for right and wrong

| Prediction | Right when |
|---|---|
| BUY | the price rose |
| SELL | the price fell |
| HOLD | the price stayed within ±2% |
| WATCH | the price stayed within ±3% (no big move we failed to call) |

Never counted as right: a move that rounds to 0.00% ("inconclusive"), a price feed
that stopped updating, or an instrument with no market price (G-Secs, bonds) —
these show "no verdict" and stay uncoloured.

## How it works

1. The scoring engine records every prediction (`recommendations`).
2. The track-record engine scores each one when its checkpoint arrives
   (`recommendation_outcomes`, daily after market close).
3. `GET /api/ledger/predictions` (token-protected, read-only) returns the ledger.
4. An Apps Script in the sheet fetches it every evening (19:00 and 22:00 IST) and
   rewrites both tabs. Menu **WealthGuard → Refresh ledger now** refreshes by hand.

## Setup (about 5 minutes, once)

1. Token: the ledger accepts `LEDGER_TOKEN` if set in Render, otherwise the existing
   `JOB_SECRET` or `ADMIN_TRIGGER_KEY`. Using the existing `ADMIN_TRIGGER_KEY` needs no Render change.
2. Open the sheet → **Extensions → Apps Script**. Replace the editor contents with
   `scripts/google-sheets/PredictionLedger.gs` → Save.
3. In Apps Script: **Project Settings → Script properties → Add**:
   - `LEDGER_URL` = `https://wealthguard-backend.onrender.com/api/ledger/predictions`
   - `LEDGER_TOKEN` = that same value (e.g. your `ADMIN_TRIGGER_KEY`)
4. Back in the editor, choose `installDailyTrigger` → **Run** → approve the permissions.
5. Choose `syncLedger` → **Run**. The first run may take up to 4 minutes while the
   free-plan server wakes up. Both tabs fill in.

Needs the backend changes in this PR and migrations 016–018 and 020 deployed;
until then the ledger shows the older outcome rows only.
