# Deploy order — security + morning-brief release

Do these in this order. Each step is safe on its own.

1. **Supabase → SQL editor:** run `scripts/migrations/006_auth_brief_and_integrity.sql`.
   - Marks existing clients that have profile data as onboarding-complete (this is what unblocks the morning brief).
   - Adds `morning_briefs.brief_json`, the `auth_codes` table, and the one-redemption-per-client rule for discount codes.
   - The check at the bottom should show `brief_json` present and `auth_codes` with `relrowsecurity = true`.
2. **Render → Environment:** confirm `JWT_SECRET` is a long random string (64+ chars). Do not set `AUTH_ENFORCE`.
3. **GitHub:** copy the changed files into the repo (same paths), **delete** `backend/engines/`, `scripts/scripts/` and `config/config/`, commit; Render deploys the backend automatically.
4. **Vercel:** deploy the new `frontend/public/index.html` **right after** step 3.
   Between 3 and 4 the old page cannot call private routes — keep the gap short.
5. **Everyone logs in once more** (old sessions had no token).
6. **Accounts with no PIN:** on login they are sent a 6-digit code by email. If the account has no email on file:
   `GET /api/admin/issue-setup-code?phone=<exact stored number>` with header `x-admin-key: <ADMIN_TRIGGER_KEY>`
   → give the code to the client; they enter it on the login screen and choose a PIN.
7. **Check the brief:** log in, open the dashboard — "Today / In the news / Ideas" fills in within a few seconds.
   Tomorrow 07:30 IST the scheduler stores a brief for every client (log line: `📰 Morning briefs complete: N stored`).

Rotate `ADMIN_TRIGGER_KEY` once after deploying (it has appeared in URLs).
