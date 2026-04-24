-- ============================================
-- Migration 007 — soft delete for businesses
-- ============================================
-- Super admin needs to be able to "delete" a tenant without losing
-- history (so accidental deletes are recoverable). We implement this as
-- a nullable `deleted_at` timestamp + optional `deleted_by_user_id`:
--
--   NULL      → live tenant, routes calls, appears in lists.
--   NOT NULL  → soft-deleted. Hidden from the Twilio resolver and the
--               default super-admin list, but the row + all cascaded
--               children (call_logs, credit_ledger, settings, etc.)
--               stay untouched so a restore is lossless.
--
-- Safety rails for callers (enforced at the route, not here):
--   * plan='legacy' tenants cannot be deleted. Valleymede lock.
--   * Delete requires the operator to type the slug for confirmation.
--   * Restore is a single PATCH that clears `deleted_at`.
--
-- A partial index on the live set (deleted_at IS NULL) keeps the hot
-- phone-routing query fast without bloating storage. Not strictly
-- necessary for a small tenant table, but it's cheap insurance and
-- documents intent.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- ============================================

BEGIN;

ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS deleted_by_user_id INTEGER;

-- Partial index — only the live tenants. Twilio call routing joins
-- business_phone_numbers → businesses and filters on this; an index
-- that only covers the ~N live rows keeps lookups snappy.
CREATE INDEX IF NOT EXISTS idx_businesses_live
    ON businesses (id)
    WHERE deleted_at IS NULL;

-- Belt-and-braces: also index by slug for the "restore by slug" admin
-- flow, still partial on the live set so it stays small.
CREATE INDEX IF NOT EXISTS idx_businesses_live_slug
    ON businesses (slug)
    WHERE deleted_at IS NULL;

INSERT INTO migrations (name) VALUES ('007_business_soft_delete')
ON CONFLICT (name) DO NOTHING;

COMMIT;
