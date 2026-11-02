-- 007: Razorpay webhook support. Safe to run more than once.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id    text PRIMARY KEY,          -- Razorpay's x-razorpay-event-id, so retries are ignored
  event_type  text,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;   -- backend (service key) only

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_rzp_sub_uniq
  ON subscriptions (razorpay_subscription_id) WHERE razorpay_subscription_id IS NOT NULL;
