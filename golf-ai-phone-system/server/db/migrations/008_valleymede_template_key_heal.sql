-- ============================================
-- Migration 008 — Valleymede template_key self-heal
-- ============================================
-- The Command Center sidebar branches on `businesses.template_key` to
-- pick the vertical-specific nav (Tee Sheet / Bookings for golf, etc.).
-- If a legacy tenant's template_key ever drifts away from 'golf_course'
-- — via a manual UPDATE, a botched ops edit, a partial run of
-- migration 005, or an application bug — the sidebar falls through to
-- the neutral "other" baseline and Tee Sheet + Bookings disappear.
--
-- This migration reasserts 'golf_course' for every plan='legacy' row.
-- It's narrowly scoped: onboarded SaaS tenants (free / starter / pro /
-- growth) are untouched.
--
-- schema.sql runs the same UPDATE on every boot (defense in depth); this
-- migration entry just makes the correction explicit in the ledger so
-- ops can see exactly when the self-heal was first applied.
--
-- Idempotent — subsequent runs are no-ops.
-- ============================================

BEGIN;

UPDATE businesses
   SET template_key = 'golf_course'
 WHERE plan = 'legacy'
   AND (template_key IS NULL OR template_key <> 'golf_course');

INSERT INTO migrations (name) VALUES ('008_valleymede_template_key_heal')
ON CONFLICT (name) DO NOTHING;

COMMIT;
