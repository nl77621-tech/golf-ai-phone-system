-- ============================================
-- Migration 004 — Audit Log (Phase 6)
-- ============================================
-- Creates the `audit_log` table that the Phase 6 audit service writes
-- every high-signal mutation to. This is NOT a general "log every
-- request" firehose — it tracks deliberate state changes that an
-- operator or support engineer would need to answer questions like
-- "who disabled Valleymede's primary number on Tuesday?".
--
-- Tenancy:
--   - `business_id` is nullable because some events (super admin
--     created, platform-wide cleanup jobs, cross-tenant reads) don't
--     belong to a single tenant. Everything tenant-scoped MUST set it.
--   - `user_id` is NOT FK'd to a single table because a user can live
--     in either `super_admins` or `business_users`; `user_type` tells
--     you which table to join against. Nullable for system-initiated
--     events (scheduled jobs, webhooks).
--   - `target_id` is a TEXT/polymorphic field so we can log events
--     against rows with non-int primary keys (e.g. settings keys) and
--     against rows that may have been deleted.
--
-- Safe to run twice (IF NOT EXISTS guards + migrations ledger).
-- ============================================

BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL PRIMARY KEY,
    business_id  INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
    user_id      INTEGER,                        -- polymorphic (super_admins.id or business_users.id)
    user_type    VARCHAR(20),                    -- super_admin | business_admin | staff | system | anonymous
    actor_email  VARCHAR(200),                   -- denormalized actor email, preserved if user row is later deleted
    action       VARCHAR(80) NOT NULL,           -- dotted namespace, e.g. 'business.created', 'phone.added'
    target_type  VARCHAR(40),                    -- e.g. 'business', 'phone_number', 'setting', 'greeting', 'invite', 'user'
    target_id    VARCHAR(80),                    -- polymorphic identifier (stringified int, setting key, etc.)
    meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip           VARCHAR(64),
    user_agent   TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_business_created
    ON audit_log(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_created
    ON audit_log(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON audit_log(user_type, user_id, created_at DESC);

-- Ledger
INSERT INTO migrations (name) VALUES ('004_audit_log')
ON CONFLICT (name) DO NOTHING;

COMMIT;
