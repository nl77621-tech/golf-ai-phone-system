-- 015_fix_modification_status.sql
--
-- BUG (data loss): createModificationRequest() inserted cancellation and
-- modification rows WITHOUT a `status`. The production modification_requests
-- table predates schema.sql adding `status ... DEFAULT 'pending'`, and
-- `CREATE TABLE IF NOT EXISTS` never alters an existing table — so on
-- production the column had no 'pending' default and those rows landed with
-- status = NULL.
--
-- Both the staff queue (GET /api/modifications) and the dashboard counter
-- filter on `status = 'pending'`, so every phone cancellation / edit was
-- silently hidden from staff while the caller was told "request submitted".
-- The tee times stayed booked. (Bookings were unaffected — their insert sets
-- status explicitly.)
--
-- This migration:
--   1. Backfills every not-yet-actioned row to 'pending' so staff can finally
--      see and process the cancellations/edits that piled up invisibly.
--   2. Restores the column default so an omitted-status insert can never
--      vanish again (belt-and-suspenders with the code fix, which now sets
--      status = 'pending' explicitly in the INSERT).

UPDATE modification_requests
   SET status = 'pending', updated_at = NOW()
 WHERE status IS NULL
    OR status NOT IN ('pending', 'processed', 'rejected');

ALTER TABLE modification_requests ALTER COLUMN status SET DEFAULT 'pending';
