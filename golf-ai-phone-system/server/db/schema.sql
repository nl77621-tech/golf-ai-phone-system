-- ============================================
-- Golf AI Phone System — Multi-Tenant Schema
-- ============================================
-- This file is the canonical schema for a FRESH install.
-- It produces a database that is already multi-tenant aware.
--
-- Tenancy model:
--   - Every tenant ("business") lives in the `businesses` table.
--   - Every row in a tenant table carries `business_id` NOT NULL.
--   - Valleymede is hardcoded as business_id = 1 by the seed.
--
-- Existing production databases are converted via
-- server/db/migrations/001_multi_tenant.sql (do NOT run this
-- file against an existing Valleymede production DB — use the
-- migration instead).
--
-- Safe to run multiple times: every object uses IF NOT EXISTS.
-- ============================================

-- ============================================
-- Migrations ledger
-- ============================================
CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) UNIQUE NOT NULL,
    applied_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Platform operators (us)
-- ============================================
-- Declared before `businesses` because `businesses.created_by`
-- references it.
CREATE TABLE IF NOT EXISTS super_admins (
    id SERIAL PRIMARY KEY,
    email VARCHAR(200) UNIQUE NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    name VARCHAR(200),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP
);

-- ============================================
-- Tenants
-- ============================================
CREATE TABLE IF NOT EXISTS businesses (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(80) UNIQUE NOT NULL,                  -- used in URLs, subdomains, super-admin dashboards
    domain_slug VARCHAR(100) UNIQUE,                   -- reserved for future custom-domain / subdomain routing
    name VARCHAR(200) NOT NULL,
    -- Telephony identity (resolves inbound calls to this tenant).
    -- NOTE: once `business_phone_numbers` is wired up in Phase 4 this
    -- column becomes a denormalized copy of the primary row in that table.
    twilio_phone_number VARCHAR(20) UNIQUE,
    transfer_number VARCHAR(20),                       -- human fallback when AI transfers
    -- Locale / contact
    timezone VARCHAR(64) NOT NULL DEFAULT 'America/Toronto',
    contact_email VARCHAR(200),
    contact_phone VARCHAR(20),
    -- Platform state
    status VARCHAR(20) NOT NULL DEFAULT 'active',      -- active, suspended, trial, cancelled (lifecycle — source of truth)
    is_active BOOLEAN NOT NULL DEFAULT TRUE,           -- quick on/off switch used by the app/UI
    plan VARCHAR(40) NOT NULL DEFAULT 'free',          -- free, starter, pro, enterprise (free-form until Phase 7)
    -- Branding / presentation
    logo_url TEXT,                                     -- public URL to the tenant's logo
    primary_color VARCHAR(7),                          -- hex accent colour, e.g. '#2E7D32'
    branding JSONB NOT NULL DEFAULT '{}'::jsonb,       -- extra per-tenant branding knobs
    -- Provenance
    created_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
    -- Internal notes (super-admin only)
    internal_notes TEXT,
    -- True once the tenant has an active business_admin user and is
    -- ready for staff logins. Used by the super-admin UI to flag
    -- "newly created, awaiting first admin" rows.
    setup_complete BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_is_active ON businesses(is_active);

-- ============================================
-- Business phone numbers (multi-DID support)
-- ============================================
-- A tenant can own more than one Twilio number (main line, after-hours,
-- marketing campaign, etc.). Every inbound call's `To` number is looked
-- up here to resolve business_id. Exactly one row per tenant should have
-- is_primary = TRUE; this is enforced by a partial unique index below.
CREATE TABLE IF NOT EXISTS business_phone_numbers (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) UNIQUE NOT NULL,          -- E.164, globally unique (routing key)
    label VARCHAR(50) NOT NULL DEFAULT 'Main Line',    -- human-readable tag ("Main Line", "Tournament Line"...)
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,         -- the default number shown in UI and used as denormalized copy
    -- Phase 5: status gate. Only 'active' rows resolve inbound calls. 'inactive'
    -- is used by ops to disable a DID without deleting the historical record
    -- (needed for audit and easy re-enable).
    status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_phone_numbers_business ON business_phone_numbers(business_id);
-- Common query: all active numbers for a tenant.
CREATE INDEX IF NOT EXISTS idx_business_phone_numbers_status
    ON business_phone_numbers(business_id, status);
-- At most one primary number per business.
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_phone_numbers_primary
    ON business_phone_numbers(business_id)
    WHERE is_primary = TRUE;

-- Keep updated_at honest automatically (Phase 5). Migration 003 creates
-- the same trigger so an existing DB stays in sync.
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

-- ============================================
-- Tenant staff users
-- ============================================
CREATE TABLE IF NOT EXISTS business_users (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    email VARCHAR(200) NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    name VARCHAR(200),
    role VARCHAR(40) NOT NULL DEFAULT 'business_admin', -- business_admin, staff (legacy 'owner' = business_admin)
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP,
    UNIQUE(business_id, email)
);

CREATE INDEX IF NOT EXISTS idx_business_users_business ON business_users(business_id);

-- ============================================
-- User invites (magic-link signup)
-- ============================================
-- Each invite is a one-time token a super-admin or business-admin can
-- send to a new user. Consumed by POST /auth/accept-invite. NULL
-- business_id means super-admin invite.
CREATE TABLE IF NOT EXISTS user_invites (
    id SERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    email VARCHAR(200) NOT NULL,
    role VARCHAR(40) NOT NULL,                          -- super_admin | business_admin | staff
    token VARCHAR(120) UNIQUE NOT NULL,
    invited_by_super_admin_id INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
    invited_by_business_user_id INTEGER REFERENCES business_users(id) ON DELETE SET NULL,
    expires_at TIMESTAMP NOT NULL,
    accepted_at TIMESTAMP,
    accepted_user_id INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_invites_business ON user_invites(business_id);
CREATE INDEX IF NOT EXISTS idx_user_invites_email    ON user_invites(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_user_invites_token    ON user_invites(token);
-- At most one outstanding (un-accepted) invite per (business, email).
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_unique_open
    ON user_invites(COALESCE(business_id, 0), LOWER(email))
    WHERE accepted_at IS NULL;

-- ============================================
-- Settings (key/value per tenant)
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (business_id, key)
);

-- ============================================
-- Customers (callers / bookers)
-- ============================================
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    phone VARCHAR(20) NOT NULL,
    name VARCHAR(200),
    email VARCHAR(200),
    notes TEXT,
    call_count INTEGER NOT NULL DEFAULT 0,
    first_call_at TIMESTAMP DEFAULT NOW(),
    last_call_at TIMESTAMP DEFAULT NOW(),
    line_type VARCHAR(20),
    alternate_phone VARCHAR(20),
    custom_greeting TEXT,                              -- legacy single-greeting field (kept for back-compat)
    custom_greetings JSONB NOT NULL DEFAULT '[]'::jsonb,
    customer_knowledge TEXT,
    no_show_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(business_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_customers_business_phone ON customers(business_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_business_last_call ON customers(business_id, last_call_at DESC);

-- ============================================
-- Booking requests
-- ============================================
CREATE TABLE IF NOT EXISTS booking_requests (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id),
    customer_name VARCHAR(200),
    customer_phone VARCHAR(20),
    customer_email VARCHAR(200),
    requested_date DATE NOT NULL,
    requested_time TIME,
    party_size INTEGER NOT NULL DEFAULT 1,
    num_carts INTEGER NOT NULL DEFAULT 0,
    special_requests TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',     -- pending, confirmed, rejected, cancelled
    card_last_four VARCHAR(4),
    staff_notes TEXT,
    call_id INTEGER,
    reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
    no_show BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_requests_business_status ON booking_requests(business_id, status);
CREATE INDEX IF NOT EXISTS idx_booking_requests_business_date ON booking_requests(business_id, requested_date);
CREATE INDEX IF NOT EXISTS idx_booking_requests_business_phone ON booking_requests(business_id, customer_phone);

-- ============================================
-- Modification requests (edit / cancel existing bookings)
-- ============================================
CREATE TABLE IF NOT EXISTS modification_requests (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id),
    customer_name VARCHAR(200),
    customer_phone VARCHAR(20),
    request_type VARCHAR(20) NOT NULL,                 -- modify, cancel
    original_date DATE,
    original_time TIME,
    new_date DATE,
    new_time TIME,
    details TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',     -- pending, processed, rejected
    staff_notes TEXT,
    call_id INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modification_requests_business_status ON modification_requests(business_id, status);

-- ============================================
-- Call logs
-- ============================================
CREATE TABLE IF NOT EXISTS call_logs (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    twilio_call_sid VARCHAR(100),
    caller_phone VARCHAR(20),
    customer_id INTEGER REFERENCES customers(id),
    duration_seconds INTEGER,
    summary TEXT,
    transcript TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',      -- active, completed, transferred, failed
    transferred_to VARCHAR(20),
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_business_started ON call_logs(business_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_business_caller ON call_logs(business_id, caller_phone);

-- ============================================
-- Greetings pool (random openers the AI uses)
-- ============================================
CREATE TABLE IF NOT EXISTS greetings (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    for_known_caller BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_greetings_business_active ON greetings(business_id, active);

-- ============================================
-- Audit log (Phase 6)
-- ============================================
-- Append-only record of high-signal mutations: business created,
-- phone added, settings changed, invites sent, etc. Used both for
-- ops incident response and the super-admin "recent activity" feed.
-- `business_id` is nullable because platform-wide events (super
-- admin bootstrap, cross-tenant reads) have no single tenant.
CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL PRIMARY KEY,
    business_id  INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
    user_id      INTEGER,                        -- polymorphic (super_admins.id or business_users.id)
    user_type    VARCHAR(20),                    -- super_admin | business_admin | staff | system | anonymous
    actor_email  VARCHAR(200),                   -- denormalized; survives user deletion
    action       VARCHAR(80) NOT NULL,           -- dotted namespace, e.g. 'business.created', 'phone.added'
    target_type  VARCHAR(40),                    -- 'business' | 'phone_number' | 'setting' | 'greeting' | 'invite' | 'user'
    target_id    VARCHAR(80),                    -- polymorphic id (stringified int, setting key, etc.)
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
