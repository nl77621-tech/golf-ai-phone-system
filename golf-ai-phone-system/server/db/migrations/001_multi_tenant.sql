-- ============================================
-- Migration 001 — Multi-Tenant Foundation
-- ============================================
-- Converts an existing Valleymede-only database into the
-- multi-tenant schema defined in server/db/schema.sql.
--
-- What this migration does:
--   1. Creates the tenant tables (`businesses`, `super_admins`,
--      `business_users`) plus a `migrations` ledger.
--   2. Seeds Valleymede as business_id = 1 (preserving its
--      existing Twilio number, transfer number, timezone).
--   3. Adds `business_id` to every existing tenant table
--      (`settings`, `customers`, `booking_requests`,
--      `modification_requests`, `call_logs`, `greetings`) as
--      NULLABLE first, then backfills every existing row to
--      business_id = 1, then enforces NOT NULL + FK.
--   4. Swaps single-column uniqueness constraints for
--      composite ones keyed on (business_id, ...).
--   5. Adds tenant-scoped indexes.
--
-- Safety properties:
--   * Idempotent — safe to run more than once. Every step
--     either uses IF NOT EXISTS / IF EXISTS, or is wrapped in
--     a DO block that swallows duplicate-object errors.
--   * Transactional — the whole thing is a single BEGIN/COMMIT.
--     If any step fails, nothing is applied.
--   * No data loss — we only ADD columns, backfill them, and
--     rewrite constraints. We never DROP a table, never
--     DELETE rows, never TRUNCATE.
--
-- Run with:  psql "$DATABASE_URL" -f server/db/migrations/001_multi_tenant.sql
-- Or via:    node server/db/init.js  (which applies pending migrations)
-- ============================================

BEGIN;

-- ============================================
-- 0. Migrations ledger + short-circuit if already applied
-- ============================================
CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) UNIQUE NOT NULL,
    applied_at TIMESTAMP DEFAULT NOW()
);

-- We don't short-circuit with an early return because even if
-- the ledger says "applied", we still want every IF NOT EXISTS
-- check below to run as a belt-and-braces safety net. The
-- ledger row is written at the bottom.

-- ============================================
-- 1. Core tenant tables
-- ============================================
-- Order matters: super_admins first, because businesses.created_by
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

CREATE TABLE IF NOT EXISTS businesses (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(80) UNIQUE NOT NULL,
    domain_slug VARCHAR(100) UNIQUE,
    name VARCHAR(200) NOT NULL,
    twilio_phone_number VARCHAR(20) UNIQUE,
    transfer_number VARCHAR(20),
    timezone VARCHAR(64) NOT NULL DEFAULT 'America/Toronto',
    contact_email VARCHAR(200),
    contact_phone VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    plan VARCHAR(40) NOT NULL DEFAULT 'free',
    logo_url TEXT,
    primary_color VARCHAR(7),
    branding JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
    internal_notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Legacy DBs may already have a `businesses` table from an earlier
-- partial run — make sure every column above is present.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS domain_slug   VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url      TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS primary_color VARCHAR(7);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_by    INTEGER;

DO $$ BEGIN
    ALTER TABLE businesses
        ADD CONSTRAINT businesses_domain_slug_key UNIQUE (domain_slug);
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN duplicate_table  THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE businesses
        ADD CONSTRAINT businesses_created_by_fk
        FOREIGN KEY (created_by) REFERENCES super_admins(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_businesses_status    ON businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_is_active ON businesses(is_active);

CREATE TABLE IF NOT EXISTS business_users (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    email VARCHAR(200) NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    name VARCHAR(200),
    role VARCHAR(40) NOT NULL DEFAULT 'owner',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP,
    UNIQUE(business_id, email)
);

CREATE INDEX IF NOT EXISTS idx_business_users_business ON business_users(business_id);

-- ----- Multi-DID support ------------------------------------
-- A tenant can own more than one Twilio number. The routing layer
-- (Phase 4) will look up the called number here to resolve
-- business_id; until then, `businesses.twilio_phone_number` stays
-- the canonical routing key.
CREATE TABLE IF NOT EXISTS business_phone_numbers (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    label VARCHAR(50) NOT NULL DEFAULT 'Main Line',
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_phone_numbers_business
    ON business_phone_numbers(business_id);
-- At most one primary number per business (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_phone_numbers_primary
    ON business_phone_numbers(business_id)
    WHERE is_primary = TRUE;

-- ============================================
-- 2. Seed Valleymede as business_id = 1
-- ============================================
-- We force id = 1 so the value matches every backfill below
-- and stays stable across environments. The sequence is bumped
-- afterward so future inserts use id = 2+.
INSERT INTO businesses (
    id, slug, name, twilio_phone_number, transfer_number, timezone,
    contact_email, contact_phone, status, plan
) VALUES (
    1,
    'valleymede-columbus',
    'Valleymede Columbus Golf Course',
    NULL,                         -- ops fills this in after migration; see NOTE below
    '+19056556300',
    'America/Toronto',
    'info@valleymedecolumbusgolf.com',
    '+19056556300',
    'active',
    'legacy'
)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- OPS FOLLOW-UP (Phase 1 → Phase 4 bridge)
-- ------------------------------------------------------------
-- After this migration completes, an operator must register
-- Valleymede's real Twilio DID so Phase 4 tenant routing can
-- resolve inbound calls to business_id = 1. Two writes are
-- expected — one on the tenant row (denormalized copy used by
-- the app today) and one in business_phone_numbers (canonical
-- multi-DID table used from Phase 4 onward). Both statements
-- are SAFE examples — idempotent and commented out. Uncomment
-- and replace the placeholder with the actual E.164 number
-- before running manually, e.g.:
--
--   BEGIN;
--   UPDATE businesses
--      SET twilio_phone_number = '+1XXXXXXXXXX'
--    WHERE id = 1
--      AND (twilio_phone_number IS NULL
--           OR twilio_phone_number <> '+1XXXXXXXXXX');
--
--   INSERT INTO business_phone_numbers
--       (business_id, phone_number, label, is_primary)
--   VALUES
--       (1, '+1XXXXXXXXXX', 'Main Line', TRUE)
--   ON CONFLICT (phone_number) DO NOTHING;
--   COMMIT;
--
-- Leaving these unset keeps Valleymede functioning via the
-- existing single-tenant code paths until Phase 4 ships.

-- Keep the SERIAL sequence ahead of the seeded id so new
-- businesses get id = 2, 3, ...
SELECT setval(
    pg_get_serial_sequence('businesses', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM businesses), 1)
);

-- ============================================
-- 3. Add business_id to every tenant table (nullable first)
-- ============================================
-- Only run these ALTERs if the target table already exists
-- (it will on a legacy Valleymede DB; on a brand-new DB that
--  ran schema.sql first, these are no-ops because schema.sql
--  already included business_id).

-- settings ---------------------------------------------------
ALTER TABLE IF EXISTS settings
    ADD COLUMN IF NOT EXISTS business_id INTEGER;

-- customers --------------------------------------------------
ALTER TABLE IF EXISTS customers
    ADD COLUMN IF NOT EXISTS business_id INTEGER;

-- booking_requests -------------------------------------------
ALTER TABLE IF EXISTS booking_requests
    ADD COLUMN IF NOT EXISTS business_id INTEGER;

-- modification_requests --------------------------------------
ALTER TABLE IF EXISTS modification_requests
    ADD COLUMN IF NOT EXISTS business_id INTEGER;

-- call_logs --------------------------------------------------
ALTER TABLE IF EXISTS call_logs
    ADD COLUMN IF NOT EXISTS business_id INTEGER;

-- greetings --------------------------------------------------
ALTER TABLE IF EXISTS greetings
    ADD COLUMN IF NOT EXISTS business_id INTEGER;

-- Columns added in the old init.js ALTER loop — ensure they
-- exist on legacy DBs too, so schema.sql and legacy DBs end
-- up with the same shape.
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS custom_greeting TEXT;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS custom_greetings JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS customer_knowledge TEXT;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS line_type VARCHAR(20);
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS alternate_phone VARCHAR(20);
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS no_show_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS booking_requests ADD COLUMN IF NOT EXISTS card_last_four VARCHAR(4);
ALTER TABLE IF EXISTS booking_requests ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS booking_requests ADD COLUMN IF NOT EXISTS no_show BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================
-- 4. Backfill: every existing row belongs to Valleymede
-- ============================================
UPDATE settings              SET business_id = 1 WHERE business_id IS NULL;
UPDATE customers             SET business_id = 1 WHERE business_id IS NULL;
UPDATE booking_requests      SET business_id = 1 WHERE business_id IS NULL;
UPDATE modification_requests SET business_id = 1 WHERE business_id IS NULL;
UPDATE call_logs             SET business_id = 1 WHERE business_id IS NULL;
UPDATE greetings             SET business_id = 1 WHERE business_id IS NULL;

-- ============================================
-- 5. Enforce NOT NULL + FK to businesses
-- ============================================
-- SET NOT NULL is idempotent when the column is already NOT NULL,
-- so this is safe to re-run. Adding FKs we wrap in DO blocks so
-- a second run doesn't error on "constraint already exists".

ALTER TABLE settings              ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE customers             ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE booking_requests      ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE modification_requests ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE call_logs             ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE greetings             ALTER COLUMN business_id SET NOT NULL;

DO $$ BEGIN
    ALTER TABLE settings
        ADD CONSTRAINT settings_business_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE customers
        ADD CONSTRAINT customers_business_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE booking_requests
        ADD CONSTRAINT booking_requests_business_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE modification_requests
        ADD CONSTRAINT modification_requests_business_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE call_logs
        ADD CONSTRAINT call_logs_business_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE greetings
        ADD CONSTRAINT greetings_business_fk
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================
-- 6. Swap uniqueness constraints → composite on business_id
-- ============================================

-- settings: PK changes from (key) to (business_id, key) --------
DO $$
DECLARE
    pk_name TEXT;
BEGIN
    SELECT conname INTO pk_name
    FROM pg_constraint
    WHERE conrelid = 'settings'::regclass AND contype = 'p';

    IF pk_name IS NOT NULL THEN
        -- Is the current PK just (key)? If so, drop it.
        IF EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
            WHERE c.conname = pk_name
            GROUP BY c.conname
            HAVING array_agg(a.attname ORDER BY a.attname) = ARRAY['key']
        ) THEN
            EXECUTE format('ALTER TABLE settings DROP CONSTRAINT %I', pk_name);
        END IF;
    END IF;
END $$;

DO $$ BEGIN
    ALTER TABLE settings
        ADD CONSTRAINT settings_pkey PRIMARY KEY (business_id, key);
EXCEPTION WHEN invalid_table_definition THEN NULL;   -- PK already exists
         WHEN duplicate_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- customers: UNIQUE(phone) → UNIQUE(business_id, phone) --------
DO $$
DECLARE
    cons_name TEXT;
BEGIN
    FOR cons_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'customers'::regclass
          AND c.contype = 'u'
        GROUP BY c.conname
        HAVING array_agg(a.attname ORDER BY a.attname) = ARRAY['phone']
    LOOP
        EXECUTE format('ALTER TABLE customers DROP CONSTRAINT %I', cons_name);
    END LOOP;
END $$;

DO $$ BEGIN
    ALTER TABLE customers
        ADD CONSTRAINT customers_business_phone_unique UNIQUE (business_id, phone);
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN duplicate_table  THEN NULL;
END $$;

-- ============================================
-- 7. Tenant-scoped indexes
-- ============================================
CREATE INDEX IF NOT EXISTS idx_customers_business_phone
    ON customers(business_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_business_last_call
    ON customers(business_id, last_call_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_requests_business_status
    ON booking_requests(business_id, status);
CREATE INDEX IF NOT EXISTS idx_booking_requests_business_date
    ON booking_requests(business_id, requested_date);
CREATE INDEX IF NOT EXISTS idx_booking_requests_business_phone
    ON booking_requests(business_id, customer_phone);

CREATE INDEX IF NOT EXISTS idx_modification_requests_business_status
    ON modification_requests(business_id, status);

CREATE INDEX IF NOT EXISTS idx_call_logs_business_started
    ON call_logs(business_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_business_caller
    ON call_logs(business_id, caller_phone);

CREATE INDEX IF NOT EXISTS idx_greetings_business_active
    ON greetings(business_id, active);

-- ============================================
-- 8. Migrate legacy customers.custom_greeting → custom_greetings[]
-- ============================================
-- Preserves any per-caller greeting that existed before Phase 1.
UPDATE customers
   SET custom_greetings = jsonb_build_array(custom_greeting)
 WHERE custom_greeting IS NOT NULL
   AND custom_greeting <> ''
   AND (custom_greetings IS NULL OR custom_greetings = '[]'::jsonb);

-- ============================================
-- 9. Seed booking_settings if missing (from old init.js migration)
-- ============================================
INSERT INTO settings (business_id, key, value, description)
VALUES (
    1,
    'booking_settings',
    '{"require_credit_card": false}'::jsonb,
    'Booking behavior settings (credit card requirement, etc.)'
)
ON CONFLICT (business_id, key) DO NOTHING;

-- ============================================
-- 10. Record this migration + retire pre-multi-tenant migrations
-- ============================================
-- The two existing migration files (005_phone_type_and_cc.sql and
-- 006_reminders_and_noshows.sql) were written against the old single-
-- tenant schema and INSERT into settings using the old (key) PK.
-- After this migration they would fail, so we pre-register them as
-- "already applied" — their column changes are covered by steps 3-4
-- above, and their settings seed is handled in step 9.
INSERT INTO migrations (name) VALUES
    ('001_multi_tenant'),
    ('005_phone_type_and_cc'),
    ('006_reminders_and_noshows')
ON CONFLICT (name) DO NOTHING;

COMMIT;
