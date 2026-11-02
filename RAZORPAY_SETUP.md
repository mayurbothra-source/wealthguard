# Razorpay setup (test mode first) — about 20 minutes

Never paste keys into chat or into GitHub. They go ONLY into Render → Environment.

## 1. Supabase (once)
Supabase → SQL Editor → paste the contents of `scripts/migrations/007_payments_webhook.sql` → Run.

## 2. Razorpay dashboard — switch to TEST mode (toggle, top of the page)
1. Account & Settings → API Keys → Generate Test Key. Copy Key Id and Key Secret.
2. Subscriptions → enable the product if asked, then Plans → Create Plan, three times (Period: Monthly, Interval: 1):
   - Starter — ₹299   - Builder — ₹799   - Wealth Builder — ₹1,999
   Copy each plan id (looks like `plan_XXXXXXXX`).
3. (Optional, for % codes) Offers → create a 30% offer and a 50% offer, linked to subscriptions. Copy the offer ids.
4. Webhooks → Add: URL `https://wealthguard-backend.onrender.com/api/payments/webhook`,
   choose your own long random secret (this is the webhook secret), tick: subscription.activated, subscription.charged,
   subscription.pending, subscription.halted, subscription.cancelled, subscription.completed, subscription.expired.

## 3. Render → wealthguard-backend → Environment → add
RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
RAZORPAY_PLAN_STARTER, RAZORPAY_PLAN_BUILDER, RAZORPAY_PLAN_WEALTH,
and (optional) RAZORPAY_OFFER_WGEARLY, RAZORPAY_OFFER_LAUNCH9SEP.
Save → Render redeploys.

## 4. Test purchase (test card 4111 1111 1111 1111, any future date, any CVV, OTP 1234 / success)
Pick a plan, pay. Expect: app opens, Supabase `subscriptions` row = active, Razorpay shows the subscription.

## 5. Going live
Complete Razorpay KYC, switch the toggle to LIVE, repeat steps 2–3 with LIVE keys/plans/webhook, and replace the values in Render.
Razorpay will ask for public Terms, Privacy, Refund/Cancellation and Contact pages before live activation.
