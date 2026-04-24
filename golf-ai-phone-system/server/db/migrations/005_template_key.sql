-- ============================================
-- Migration 005 — businesses.template_key (Pre-Phase 7)
-- ============================================
-- Adds the `template_key` column to `businesses` and backfills every
-- existing row so downstream code (Command Center sidebar branching,
-- system-prompt dispatcher) can trust the value is present.
--
-- Backfill rules:
--   - Valleymede (slug = 'valleymede') → 'golf_course'. The production
--     row was seeded before templates existed and is unambiguously a
--     golf course; we preserve that UX exactly.
--   - Every other existing row → 'other'. They were all onboarded via
--     the wizard, but the chosen template_key was never persisted on
--     the business row itself — it only ran through applyTemplate()
--     to seed settings. 'other' is the safe, neutral default. Ops can
--     correct any row post-hoc with a single UPDATE.
--
-- Idempotent:
--   - ADD COLUMN IF NOT EXISTS, and the UPDATE is gated on the column
--     being NULL so a second run is a no-op.
--   - `migrations` ledger row guarded with ON CONFLICT.
-- ============================================

BEGIN;

ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS template_key VARCHAR(40);

-- Valleymede — explicit. The canonical single-tenant bootstrap.
UPDATE businesses
   SET template_key = 'golf_course'
 WHERE template_key IS NULL
   AND slug = 'valleymede';

-- Anything else that already exists on the platform. We cannot know
-- which template their settings were seeded from (that info is not
-- persisted anywhere), so we default to 'other' — the neutral dashboard
-- that doesn't pretend to be a golf course.
UPDATE businesses
   SET template_key = 'other'
 WHERE template_key IS NULL;

-- Ledger
INSERT INTO migrations (name) VALUES ('005_template_key')
ON CONFLICT (name) DO NOTHING;

COMMIT;
