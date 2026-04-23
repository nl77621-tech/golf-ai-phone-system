-- ============================================
-- Migration 002 — Auth & Invites (Phase 3)
-- ============================================
-- Introduces the pieces required to onboard real users:
--
--   1. Normalize `business_users.role` to the Phase 3 vocabulary
--      ('super_admin' | 'business_admin' | 'staff'). Existing 'owner'
--      rows are rewritten to 'business_admin' so the Valleymede env-var
--      admin keeps working after switching to DB-backed logins.
--   2. Add the `user_invites` table — one row per outstanding invite /
--      magic link. Consumed by POST /auth/accept-invite.
--   3. Add a boolean `businesses.setup_complete` so the super-admin UI
--      can distinguish "freshly created, no admin yet" from "active".
--
-- All changes are idempotent. Safe to run repeatedly; the init script
-- guards with the `migrations` ledger.
-- ============================================

BEGIN;

-- ----- 1. Normalize business_users.role ---------------------
-- `owner` is the Phase 2 default; Phase 3 calls it `business_admin`.
-- We keep `staff` as-is. Any NULL / blank rows collapse to 'staff'
-- so we never have a user without a role.
UPDATE business_users
   SET role = 'business_admin'
 WHERE role = 'owner';

UPDATE business_users
   SET role = 'staff'
 WHERE role IS NULL OR role = '';

-- Tighten the default for future inserts.
ALTER TABLE business_users
    ALTER COLUMN role SET DEFAULT 'business_admin';

-- ----- 2. user_invites --------------------------------------
-- Every invite / magic link gets a row here. `token` is the opaque
-- secret the invited user sees in the URL. `accepted_at` is set when
-- they complete signup; expired invites are those where NOW() >
-- expires_at AND accepted_at IS NULL.
--
-- `business_id` is NULL for super-admin invites, a tenant id for
-- business_user invites. `invited_by_super_admin_id` /
-- `invited_by_business_user_id` are mutually-exclusive provenance.
CREATE TABLE IF NOT EXISTS user_invites (
    id SERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    email VARCHAR(200) NOT NULL,
    role VARCHAR(40) NOT NULL,                              -- super_admin | business_admin | staff
    token VARCHAR(120) UNIQUE NOT NULL,
    invited_by_super_admin_id INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
    invited_by_business_user_id INTEGER REFERENCES business_users(id) ON DELETE SET NULL,
    expires_at TIMESTAMP NOT NULL,
    accepted_at TIMESTAMP,
    accepted_user_id INTEGER,                               -- id of the created super_admins OR business_users row
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_invites_business ON user_invites(business_id);
CREATE INDEX IF NOT EXISTS idx_user_invites_email    ON user_invites(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_user_invites_token    ON user_invites(token);

-- Exactly-one outstanding (un-accepted, un-expired) invite per
-- (business_id, email) pair — any new invite supersedes the prior.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_unique_open
    ON user_invites(COALESCE(business_id, 0), LOWER(email))
    WHERE accepted_at IS NULL;

-- ----- 3. businesses.setup_complete -------------------------
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS setup_complete BOOLEAN NOT NULL DEFAULT FALSE;

-- Back-fill: anything with at least one active business_admin is
-- considered set up. Valleymede (id=1) is always considered set up
-- so the existing env-var login keeps working without manual flip.
UPDATE businesses
   SET setup_complete = TRUE
 WHERE id = 1
    OR EXISTS (
        SELECT 1 FROM business_users bu
         WHERE bu.business_id = businesses.id
           AND bu.active = TRUE
           AND bu.role IN ('business_admin', 'owner')
    );

-- ----- Ledger ----------------------------------------------
INSERT INTO migrations (name) VALUES ('002_auth_and_invites')
ON CONFLICT (name) DO NOTHING;

COMMIT;
