-- ============================================
-- Migration 009 — per-tenant team directory
-- ============================================
-- Each tenant can list named people who can receive a message left by a
-- caller. When the AI determines the caller wants to leave a message for
-- "John", it looks up "John" in this table for the tenant, and (via the
-- take_message_for_team_member tool) fires an SMS to that person's
-- `sms_phone` containing a short transcript + callback number.
--
-- Design notes:
--   * Globally unique IDs (PK serial), tenant scope via business_id FK.
--   * One person = one row. A person who answers under multiple names
--     (e.g. "Bob"/"Robert") is solved with a separate `aliases` JSON
--     column rather than duplicate rows — keeps notification routing
--     unambiguous (one phone number per person).
--   * `sms_phone` is the destination DID for the SMS. Stored E.164.
--   * `is_active` lets the tenant toggle delivery off without losing the
--     row (out-of-office, leaves business, etc.).
--   * `(business_id, lower(name))` unique index — name collisions inside
--     a single tenant would make routing ambiguous. Different tenants
--     can each have their own "John" without conflict.
--   * No unique constraint on phone_number across the whole table —
--     same phone can legitimately notify multiple people on different
--     tenants, and even multiple roles within the same tenant.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS.
-- ============================================

BEGIN;

CREATE TABLE IF NOT EXISTS business_team_members (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            VARCHAR(80)  NOT NULL,
  role            VARCHAR(80),
  sms_phone       VARCHAR(20)  NOT NULL,
  email           VARCHAR(120),
  aliases         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  notes           TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Unique active name per tenant. Case-insensitive — "john" and "John"
-- collide because the AI matches case-insensitively at lookup time and
-- two case-different rows would silently shadow each other otherwise.
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_unique_name
  ON business_team_members (business_id, LOWER(name));

-- Hot path: lookup by tenant + name during a call. The unique index
-- above already covers this, but an explicit index documents intent
-- and lets EXPLAIN make the query plan obvious.
CREATE INDEX IF NOT EXISTS idx_team_members_business
  ON business_team_members (business_id, is_active);

INSERT INTO migrations (name) VALUES ('009_team_directory')
ON CONFLICT (name) DO NOTHING;

COMMIT;
