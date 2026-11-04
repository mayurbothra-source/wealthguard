-- 009: give existing never-paid clients the launch free period (full access to 31 Dec 2026).
-- Does NOT touch anyone with a Razorpay subscription. Safe to run more than once.
UPDATE clients c
SET subscription_status = 'trial',
    subscription_plan   = COALESCE(NULLIF(c.subscription_plan,'none'),'builder'),
    subscription_expires_at = GREATEST(COALESCE(c.subscription_expires_at, '2026-12-31 18:29:59+00'), '2026-12-31 18:29:59+00'),
    grace_stage = 0, payment_failed_at = NULL
WHERE c.subscription_status IN ('none','pending','trial','payment_failed','read_only')
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.client_id = c.id AND s.razorpay_subscription_id IS NOT NULL);
