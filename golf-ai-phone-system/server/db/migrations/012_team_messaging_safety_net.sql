-- ============================================
-- Migration 012 — team-messaging columns safety net
-- ============================================
-- Production hit a "column is_default_recipient does not exist" error
-- when listing /api/team after the Business-template deploy. Migration
-- 011 was supposed to add three columns to business_team_members, but
-- something about that migration didn't take on the live database (the
-- migration may have been tracked as applied without the ALTERs going
-- through, or one of the DO blocks errored and skipped the ADD COLUMNs).
--
-- Rather than debug the prior migration's transaction, this one is a
-- pure idempotent forward-fix: each ADD COLUMN runs in its own
-- statement (so one failure can't suppress the others), and every
-- predicate uses IF NOT EXISTS / DO NOT EXISTS so re-running on a
-- fully-migrated DB is a no-op.
--
-- This migration handles all three failure modes:
--   1. Migration 011 ran fully  →  every IF NOT EXISTS short-circuits
--   2. Migration 011 partially ran  →  fills in missing columns
--   3. Migration 011 was tracked but didn't actually run  →  applies now
--
-- Also adds the at-most-one-default partial unique index in case 011's
-- DO block didn't take. The CHECK constraint and sms_phone NULL drop
-- are repeated for the same reason.
--
-- Valleymede impact: ZERO. business_team_members is empty for the golf
-- tenant, and these are pure ALTERs to a table Valleymede doesn't read
-- on the call path.
-- ============================================

BEGIN;

-- ----------------------------------------------------------------
-- Per-channel toggles. Default TRUE so existing rows keep behaving
-- exactly as they did before (SMS was the only enabled channel and
-- that's still on by default).
-- ----------------------------------------------------------------
ALTER TABLE business_team_members
    ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE business_team_members
    ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Inbox-fallback marker. Default FALSE — only an explicit toggle from
-- Settings (or the wizard) ever flips this on.
ALTER TABLE business_team_members
    ADD COLUMN IF NOT EXISTS is_default_recipient BOOLEAN NOT NULL DEFAULT FALSE;

-- ----------------------------------------------------------------
-- Drop the legacy NOT NULL on sms_phone so an email-only contact
-- (e.g. accounting) can exist. Existing rows keep their phone values.
-- ----------------------------------------------------------------
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

-- ----------------------------------------------------------------
-- Channel-presence integrity. Every member must have phone OR email.
-- ----------------------------------------------------------------
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

-- ----------------------------------------------------------------
-- At-most-one default recipient per tenant (active rows only).
-- ----------------------------------------------------------------
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
-- team_messages table — same body as 011's CREATE TABLE IF NOT EXISTS
-- so a partial 011 run that managed to add the table doesn't bounce.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_messages (
    id                 SERIAL PRIMARY KEY,
    business_id        INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    recipient_id       INTEGER REFERENCES business_team_members(id) ON DELETE SET NULL,
    recipient_name     VARCHAR(120) NOT NULL,
    caller_name        VARCHAR(120),
    caller_phone       VARCHAR(20),
    body               TEXT NOT NULL,
    channel            VARCHAR(20)  NOT NULL DEFAULT 'sms',
    status             VARCHAR(20)  NOT NULL DEFAULT 'pending',
    delivery_detail    JSONB        NOT NULL DEFAULT '{}'::jsonb,
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
CREATE INDEX IF NOT EXISTS idx_team_messages_attention
    ON team_messages (business_id, status)
    WHERE status IN ('pending', 'failed', 'partial');

INSERT INTO migrations (name) VALUES ('012_team_messaging_safety_net')
ON CONFLICT (name) DO NOTHING;

COMMIT;
