-- ============================================
-- Migration 010 — booking_requests.holes
-- ============================================
-- A real customer booked a 9-hole tee time and staff confirmed it
-- thinking it was 18 holes. The AI knows the difference at booking
-- time (Tee-On returns separate 18-hole and 9-hole slot lists), but
-- never wrote that distinction to booking_requests, so the
-- confirmation UI couldn't show it. Adding a `holes` column to
-- close the loop.
--
-- INTEGER (not VARCHAR) so reporting / filtering stays numeric.
-- Nullable because rows created before this migration won't have a
-- value — UI shows "—" for those, and ops can update them by hand
-- via the booking detail screen if it matters.
-- CHECK constraint forces 9 or 18 (or null); anything else is a bug.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================

BEGIN;

ALTER TABLE booking_requests
    ADD COLUMN IF NOT EXISTS holes INTEGER;

-- Add the CHECK constraint only if it doesn't already exist. We use
-- a DO block because Postgres has no IF NOT EXISTS for constraints
-- and this migration must remain re-runnable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'booking_requests_holes_check'
    ) THEN
        ALTER TABLE booking_requests
            ADD CONSTRAINT booking_requests_holes_check
            CHECK (holes IS NULL OR holes IN (9, 18));
    END IF;
END $$;

INSERT INTO migrations (name) VALUES ('010_booking_holes')
ON CONFLICT (name) DO NOTHING;

COMMIT;
