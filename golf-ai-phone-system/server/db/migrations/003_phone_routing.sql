-- ============================================
-- Migration 003 — Phone routing & status (Phase 5)
-- ============================================
-- Phase 5 promotes `business_phone_numbers` from a side table to the
-- authoritative source of truth for inbound Twilio routing. This
-- migration does three things:
--
--   1. Adds `status` ('active' | 'inactive') to business_phone_numbers
--      so an operator can disable a DID without deleting the row.
--      Resolving inbound calls will only accept `status = 'active'`
--      entries from Phase 5 onward; the resolver falls back to the
--      legacy `businesses.twilio_phone_number` column for anything
--      that hasn't been migrated yet.
--
--   2. Backfills `business_phone_numbers` from every non-null
--      `businesses.twilio_phone_number` so tenants that were
--      onboarded before Phase 5 have a canonical row in the new
--      table. The row is flagged `is_primary = TRUE` so downstream
--      code can find "the From number" deterministically.
--
--   3. Adds `updated_at` auto-touch trigger so PATCH-style updates
--      bump the timestamp without every caller having to remember.
--
-- Valleymede (id = 1) is always preserved: if its
-- `twilio_phone_number` is still NULL (ops hasn't wired it yet),
-- we do not invent a row. The Phase 2 bootstrap fallback in
-- `resolveBusinessFromTwilioTo` still routes calls to the sole
-- tenant until the ops step runs.
--
-- Everything is idempotent. Safe to re-run.
-- ============================================

BEGIN;

-- ----- 1. Add status column ---------------------------------
ALTER TABLE business_phone_numbers
    ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active';

-- Defend the enum-ish contract at the DB level so a stray INSERT
-- can't land an unknown status and break the resolver.
DO $$
BEGIN
    ALTER TABLE business_phone_numbers
        ADD CONSTRAINT business_phone_numbers_status_check
        CHECK (status IN ('active', 'inactive'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Index for the common "active numbers for this tenant" query.
CREATE INDEX IF NOT EXISTS idx_business_phone_numbers_status
    ON business_phone_numbers(business_id, status);

-- ----- 2. Backfill from businesses.twilio_phone_number ------
-- For every business with a legacy denormalized DID, make sure a
-- matching row exists in business_phone_numbers and is marked
-- primary. Existing rows are left alone — we only INSERT when the
-- exact (business_id, phone_number) pair is missing.
INSERT INTO business_phone_numbers (business_id, phone_number, label, is_primary, status)
SELECT b.id, b.twilio_phone_number, 'Main Line', TRUE, 'active'
  FROM businesses b
 WHERE b.twilio_phone_number IS NOT NULL
   AND b.twilio_phone_number <> ''
   AND NOT EXISTS (
       SELECT 1 FROM business_phone_numbers bpn
        WHERE bpn.business_id = b.id
          AND bpn.phone_number = b.twilio_phone_number
   )
ON CONFLICT (phone_number) DO NOTHING;

-- Guarantee that any backfilled row whose phone_number matches
-- `businesses.twilio_phone_number` is flagged as primary. This is
-- the row the app treats as "the From number" for SMS.
UPDATE business_phone_numbers bpn
   SET is_primary = TRUE,
       updated_at = NOW()
  FROM businesses b
 WHERE bpn.business_id = b.id
   AND bpn.phone_number = b.twilio_phone_number
   AND bpn.is_primary = FALSE;

-- ----- 3. updated_at auto-touch trigger ---------------------
-- Keep updated_at honest so the Super Admin UI can show "last
-- edited" without every endpoint having to remember to bump it.
CREATE OR REPLACE FUNCTION touch_business_phone_numbers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_business_phone_numbers_touch ON business_phone_numbers;
CREATE TRIGGER trg_business_phone_numbers_touch
    BEFORE UPDATE ON business_phone_numbers
    FOR EACH ROW
    EXECUTE FUNCTION touch_business_phone_numbers_updated_at();

-- ----- Ledger ----------------------------------------------
INSERT INTO migrations (name) VALUES ('003_phone_routing')
ON CONFLICT (name) DO NOTHING;

COMMIT;
