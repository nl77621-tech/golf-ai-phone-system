-- ============================================
-- Migration 014 — Admin call-in line + business announcements
-- ============================================
-- Adds the storage for the "admin can call in and update ops" feature.
-- Two tables, both multi-tenant scoped per CLAUDE.md §3.1:
--
-- 1) business_admins
--    Phone-number-based admin identity per business. When a call comes
--    in from a number listed here, the AI switches to admin mode and
--    requires the PIN (stored bcrypt-hashed) before any state changes.
--    Each business can have multiple admins (owner + GM + head pro).
--
-- 2) business_announcements
--    Free-text operations notes set by an admin (e.g. "no carts today —
--    wet conditions"). Each row has a scope ('today' or 'persistent')
--    and an optional expires_at. Active announcements get injected into
--    the customer-facing system prompt at the top so the AI weaves them
--    into normal conversation. Staff can also see + remove via the
--    Command Center UI.
--
-- Both tables ship INACTIVE — until an admin is added for a business,
-- the existing call flow is unchanged. Valleymede impact at migration
-- time: ZERO (additive, no backfill).
-- ============================================

BEGIN;

-- ----------------------------------------------------------------
-- business_admins
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_admins (
    id             SERIAL PRIMARY KEY,
    business_id    INTEGER     NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    phone_number   VARCHAR(20) NOT NULL,    -- E.164 normalized, e.g. +14168276921
    name           VARCHAR(100) NOT NULL,   -- display name for "Hi Nelson, PIN?"
    pin_hash       TEXT        NOT NULL,    -- bcryptjs hash, never plaintext
    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_used_at   TIMESTAMP WITH TIME ZONE,
    UNIQUE (business_id, phone_number)
);

-- Active-admin lookup by phone — used on every inbound call to decide
-- between admin and customer mode. Partial index keeps it small even
-- as inactive rows accumulate.
CREATE INDEX IF NOT EXISTS idx_business_admins_phone_lookup
    ON business_admins (business_id, phone_number)
    WHERE is_active = TRUE;

-- Listing admins for a business (used by the Command Center Settings
-- page). Same partial filter.
CREATE INDEX IF NOT EXISTS idx_business_admins_by_business
    ON business_admins (business_id)
    WHERE is_active = TRUE;

-- ----------------------------------------------------------------
-- business_announcements
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_announcements (
    id                     SERIAL PRIMARY KEY,
    business_id            INTEGER     NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    instruction_text       TEXT        NOT NULL CHECK (length(instruction_text) > 0),
    -- 'today'      → expires at end of local day (admin set "for today")
    -- 'persistent' → no auto-expiry (admin set "moving forward")
    scope                  VARCHAR(20) NOT NULL DEFAULT 'today'
                                   CHECK (scope IN ('today', 'persistent')),
    -- Set when scope='today' to the end of local day; NULL for persistent.
    -- The fetch query uses (expires_at IS NULL OR expires_at > NOW())
    -- so persistent rows survive indefinitely and 'today' rows fall off
    -- automatically without a cron job.
    expires_at             TIMESTAMP WITH TIME ZONE,
    is_active              BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Provenance — who set this? Admin row if known; phone is a fallback
    -- for ops queries even after the admin row is soft-deleted.
    created_by_admin_id    INTEGER     REFERENCES business_admins(id) ON DELETE SET NULL,
    created_by_phone       VARCHAR(20),
    -- Soft-delete fields — staff "remove" via UI sets is_active=false
    -- and stamps these. Hard delete is never used; we keep the audit
    -- trail.
    deactivated_at         TIMESTAMP WITH TIME ZONE,
    deactivated_by         VARCHAR(100)
);

-- The customer system-prompt assembly hits this every call. We need
-- the active rows for one business fast.
CREATE INDEX IF NOT EXISTS idx_business_announcements_active
    ON business_announcements (business_id, created_at DESC)
    WHERE is_active = TRUE;

INSERT INTO migrations (name) VALUES ('014_admin_line_and_announcements')
ON CONFLICT (name) DO NOTHING;

COMMIT;
