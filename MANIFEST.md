# What is in this repository

Everything from both rounds of work, cumulative. Nothing from earlier rounds
was reverted.

## New files

| File | What it is |
|---|---|
| `backend/lib/db.js` | Data layer. No Supabase error can fail silently; `writeTolerant` makes deploy order safe |
| `backend/services/leverEngine.js` | The nine levers, six now per-instrument |
| `backend/services/fundamentalsProvider.js` | Price statistics and company fundamentals, cached |
| `scripts/dry_run_scoring.js` | Scores the live universe old-vs-new, writes nothing |
| `scripts/migrations/001_verify_schema.sql` | Read-only. What your live database actually has |
| `scripts/migrations/002_morning_briefs_align.sql` | Lets the brief persist for the first time |
| `scripts/migrations/003_client_columns_and_cleanup.sql` | Trial expiry, referral codes, duplicate accounts, emails, dead tickers |
| `scripts/migrations/004_rls_hardening.sql` | Closes the anon-key hole. **Read its header first** |
| `scripts/migrations/005_levers_and_track_record.sql` | Metrics cache, score provenance, WATCH correction |
| `tests/` | 181 assertions, no framework. `npm test` |
| `ARCHITECTURE.md` | The system as it actually is, and where it had drifted |
| `DEPLOY_ORDER.md` | Both rounds, in order, with what to check after each |

## Modified

**Backend services** — `opportunityEngine` (4 bugs), `morningBriefEngine`
(schema drift + portfolios), `subscriptionEngine` (`created_at` → `onboarded_at`),
`flashAlertEngine` / `instrumentEngine` / `aiLeverEngine` (portfolios),
`instrumentEngine` (new levers, no-data rule, provenance),
`trackRecordEngine` (WATCH).

**Backend routes** — `brief` (reads the stored brief instead of generating a
second one), `signals` / `portfolio` / `clients` / `goals` / `payments` (all
fabricated-data fallbacks removed).

**Frontend** — `frontend/public/index.html` is v7: escaping layer, N+1 removed,
accessibility, tier gate, PESTLE from real events, alpha display, referral,
data export, email capture. Your live Supabase credentials are preserved in it.

## Unchanged on purpose

`engines/analysisEngine.js` and `engines/riskGate.js` — the legacy stack. Still
reachable only from `POST /api/signals/generate`, which your frontend never
calls. Retiring it needs a product decision from you; see ARCHITECTURE.md §5.1.

## Deploy

Either order is safe now — every write that names a new column retries without
it and warns. But run the migrations first anyway, or you lose provenance
columns until you do, and `005` is what corrects the accuracy figure.

```
node scripts/dry_run_scoring.js --all     # writes nothing; read this first
# then migrations 001 → 005 in Supabase
# then push
npm test
```
