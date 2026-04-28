-- ============================================
-- Migration 011 — extend team directory + add team_messages history
-- ============================================
-- Migration 009 created `business_team_members` for the Personal Assistant
-- template (SMS-only, no fallback recipient, no persisted history). This
-- migration extends it to support the new "Business" switchboard template:
--
--   * Per-channel preferences. Today every member gets SMS; Business-template
--     tenants want some teammates email-only (e.g. accounting). Adding
--     `sms_enabled` + `email_enabled` (default TRUE) preserves current
--     behavior — existing personal_assistant rows stay SMS+email-as-needed.
--
--   * `is_default_recipient` — the "inbox" fallback. When the AI can't match
--     a caller-spoken name (or the caller doesn't say one), the message
--     routes here so nothing is dropped. Enforced as at-most-one-active per
--     tenant via a partial unique index.
--
--   * `sms_phone` becomes nullable. Email-only contacts (accounting, legal)
--     can't have a phone, but the existing schema declared it NOT NULL.
--     Relaxing to NULLABLE + a CHECK (phone OR email present) keeps integrity
--     without forcing a fake phone for email-only rows.
--
--   * New `team_messages` table — every message taken on behalf of a member
--     gets a row, regardless of dispatch outcome. Drives the new "Messages"
--     page in Command Center and gives ops an audit trail when a recipient's
--     phone is dead.
--
-- Idempotent throughout: DO blocks for ADD COLUMN / ADD CONSTRAINT, IF NOT
-- EXISTS for indexes, CREATE TABLE IF NOT EXISTS for team_messages. Safe
-- to re-run on every boot. Does NOT touch Valleymede behavior — Valleymede
-- runs the golf_course template and never reads these columns at call time.
-- ============================================

BEGIN;

-- ----------------------------------------------------------------
-- business_team_members extensions
-- ----------------------------------------------------------------

-- Per-channel preferences (default TRUE so existing personal_assistant rows
-- continue to receive SMS exactly as before — the AI has been calling
-- sendMessageToTeamMember which only fires SMS today, and that path stays
-- on as long as sms_enabled=TRUE which it now is by default).
ALTER TABLE business_team_members
    ADD COLUMN IF NOT EXISTS sms_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Inbox-fallback marker. Default FALSE — only an explicit toggle from
-- Settings (or the wizard) can mark a member as the default.
ALTER TABLE business_team_members
    ADD COLUMN IF NOT EXISTS is_default_recipient BOOLEAN NOT NULL DEFAULT FALSE;

-- Drop the legacy NOT NULL on sms_phone so email-only contacts can exist.
-- Existing rows are unaffected — they all already have sms_phone set.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'business_team_members'
           AND column_name = 'sms_phone'
           AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE business_team_members ALTER COLUMN sms_phone DROP NOT NULL;
    END IF;
END $$;

-- Integrity: every member must have at least one channel. Without this a
-- bad UPDATE could leave us with a "team member" we can't reach.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'business_team_members_at_least_one_channel'
    ) THEN
        ALTER TABLE business_team_members
            ADD CONSTRAINT business_team_members_at_least_one_channel
            CHECK (sms_phone IS NOT NULL OR email IS NOT NULL);
    END IF;
END $$;

-- At-most-one default recipient per tenant (only enforced on active rows;
-- a disabled "old default" row doesn't compete). Application code is
-- responsible for ensuring at-LEAST-one when the tenant uses the Business
-- template — the index just prevents accidental duplicates.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'uq_business_team_members_one_default'
    ) THEN
        CREATE UNIQUE INDEX uq_business_team_members_one_default
            ON business_team_members (business_id)
            WHERE is_default_recipient = TRUE AND is_active = TRUE;
    END IF;
END $$;

-- ----------------------------------------------------------------
-- team_messages — persisted history of messages taken
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_messages (
    id                 SERIAL PRIMARY KEY,
    business_id        INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- recipient_id is nullable so a message survives the recipient being
    -- deleted from the directory later; recipient_name is a snapshot.
    recipient_id       INTEGER REFERENCES business_team_members(id) ON DELETE SET NULL,
    recipient_name     VARCHAR(120) NOT NULL,
    caller_name        VARCHAR(120),
    caller_phone       VARCHAR(20),
    body               TEXT NOT NULL,
    -- 'sms' | 'email' | 'both' | 'dashboard_only' (when neither channel
    -- was available / enabled at dispatch time, the row still gets stored)
    channel            VARCHAR(20)  NOT NULL DEFAULT 'sms',
    -- 'pending' (queued) | 'sent' | 'partial' | 'failed' | 'read'
    status             VARCHAR(20)  NOT NULL DEFAULT 'pending',
    -- Per-channel result so ops can debug a partial failure.
    delivery_detail    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- TRUE when the AI couldn't match the spoken name and used the default.
    routed_to_default  BOOLEAN      NOT NULL DEFAULT FALSE,
    call_id            INTEGER REFERENCES call_logs(id) ON DELETE SET NULL,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT team_messages_channel_check
        CHECK (channel IN ('sms', 'email', 'both', 'dashboard_only')),
    CONSTRAINT team_messages_status_check
        CHECK (status IN ('pending', 'sent', 'partial', 'failed', 'read'))
);

CREATE INDEX IF NOT EXISTS idx_team_messages_business_created
    ON team_messages (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_messages_recipient
    ON team_messages (recipient_id)
    WHERE recipient_id IS NOT NULL;

-- "What's still pending or failed?" — the Messages page highlights these.
CREATE INDEX IF NOT EXISTS idx_team_messages_attention
    ON team_messages (business_id, status)
    WHERE status IN ('pending', 'failed', 'partial');

INSERT INTO migrations (name) VALUES ('011_team_messaging')
ON CONFLICT (name) DO NOTHING;

COMMIT;
