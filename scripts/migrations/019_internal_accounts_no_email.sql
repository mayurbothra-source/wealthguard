-- 019: demo / house / test accounts — in-app brief only, no email (FIX-1)
--
-- Seven accounts (six "Demo …" accounts and "WealthGuard House Track Record")
-- are +aliases of one Gmail inbox, which therefore received seven identical
-- briefs every morning. Real subscribers were never sent more than one.
-- These accounts now get the in-app brief only; the admin gets one preview
-- copy per day (briefDelivery.sendAdminPreview).
--
-- Additive and idempotent. Only rows whose account_kind is still NULL are
-- classified, so re-running never overrides a manual setting.
--
-- Rollback:
--   UPDATE clients SET account_kind = NULL WHERE account_kind IN ('demo','house','test');
--   ALTER TABLE clients DROP COLUMN IF EXISTS account_kind;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_kind text;   -- NULL/'customer' | 'demo' | 'house' | 'test'

UPDATE clients SET account_kind = 'demo'
 WHERE account_kind IS NULL AND full_name ILIKE 'Demo %';
UPDATE clients SET account_kind = 'house'
 WHERE account_kind IS NULL AND full_name ILIKE '%House Track Record%';
UPDATE clients SET account_kind = 'test'
 WHERE account_kind IS NULL AND (full_name ILIKE 'TEST %' OR full_name ILIKE 'Test Victim%' OR email ILIKE '%@example.com');

-- Check: SELECT account_kind, count(*) FROM clients GROUP BY 1;
-- Expected on 24 Nov 2026: demo 6, house 1, test 4, NULL 1 (the real starter account).
