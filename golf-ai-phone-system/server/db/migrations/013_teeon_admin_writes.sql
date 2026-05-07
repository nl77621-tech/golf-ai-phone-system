-- ============================================
-- Migration 013 — Tee-On admin writes
-- ============================================
-- Adds the storage we need to track which booking_requests rows have
-- been pushed to the live Tee-On admin tee sheet, so we can later look
-- them back up to edit / cancel.
--
-- This migration ships ALONGSIDE the new server/services/teeon-admin.js
-- module, but is INERT until staff flip the feature flag in settings:
--
--   key                          value (JSON)   default
--   teeon_admin_writes_enabled   true | false   off (no flag = off)
--   teeon_admin_dry_run          true | false   on  (no flag = on, when enabled)
--
-- With the flag off (default), no code path touches Tee-On's admin and
-- this migration's columns simply stay NULL. With dry-run on, we log the
-- POST we would have sent but don't fire it. Real writes only happen
-- when both flags are deliberately set in the settings table.
--
-- Valleymede impact: ZERO at migration time. All three columns are
-- additive, NULLable, no constraints, no backfill. Existing INSERTs in
-- booking-manager.js do not reference these columns, so the column
-- defaults (NULL) apply automatically. The CHECK on `holes` is the only
-- existing constraint on this table and is unchanged.
-- ============================================

BEGIN;

-- ----------------------------------------------------------------
-- The Tee-On BookerID (e.g. "COLU4130") — the stable id Tee-On
-- assigns to a booking row. Persists across edits. We need it to
-- look the booking back up for cancel / move / edit operations.
-- ----------------------------------------------------------------
ALTER TABLE booking_requests
    ADD COLUMN IF NOT EXISTS teeon_booking_id VARCHAR(64);

-- ----------------------------------------------------------------
-- Wall-clock timestamp of the last successful push to Tee-On.
-- NULL = booking has never been synced to Tee-On (the today-and-
-- before behaviour for every existing row, and the default for
-- tenants without the feature flag enabled).
-- ----------------------------------------------------------------
ALTER TABLE booking_requests
    ADD COLUMN IF NOT EXISTS teeon_synced_at TIMESTAMP WITH TIME ZONE;

-- ----------------------------------------------------------------
-- Last error from a failed Tee-On push attempt, for ops triage.
-- Cleared when a subsequent push succeeds. NULL when no attempt
-- has been made or the most recent attempt was successful.
-- ----------------------------------------------------------------
ALTER TABLE booking_requests
    ADD COLUMN IF NOT EXISTS teeon_last_error TEXT;

-- ----------------------------------------------------------------
-- Lookup index — used when a customer phones back to modify or
-- cancel a booking and we need to find the matching live row.
-- Partial because most rows will have NULL teeon_booking_id
-- (legacy + unsynced + dry-run rows).
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_booking_requests_teeon_booking_id
    ON booking_requests (business_id, teeon_booking_id)
    WHERE teeon_booking_id IS NOT NULL;

INSERT INTO migrations (name) VALUES ('013_teeon_admin_writes')
ON CONFLICT (name) DO NOTHING;

COMMIT;
