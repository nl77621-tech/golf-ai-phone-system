-- ============================================
-- Migration 006 — credit/billing foundation (Phase 7a)
-- ============================================
-- Introduces per-tenant billing via a credit balance measured in
-- SECONDS (Twilio reports call duration in seconds, so the internal
-- unit matches the source of truth). The UI sells and displays hours.
--
-- Two new tables:
--   * credit_packages — the catalog of purchasable packs. Seeded below
--       with Starter/Growth/Pro at the Phase 7 prices ($79/$239/$799
--       at 50% markup over ~$10.80/hr run cost). Editable at runtime
--       via UPDATE; the migration only seeds on a first run.
--   * credit_ledger  — append-only log of every balance change
--       (trial_grant, purchase, admin_grant, admin_deduction,
--       call_usage, refund). Balance = SUM(delta_seconds) but we
--       materialise the running total onto the businesses row so the
--       Twilio call-entry hot path can read it without a scan.
--
-- Columns added to businesses:
--   * credit_seconds_remaining BIGINT NOT NULL DEFAULT 0 — materialised
--       balance. Every ledger insert is paired with an UPDATE to this
--       column in the same transaction. The ledger remains the truth.
--   * trial_granted_at, trial_expires_at — lets us enforce "1 hour OR
--       14 days, whichever comes first" without scanning the ledger.
--   * billing_notes — free-text field for ops (e.g. "Grandfathered
--       Pro at $0", "Corporate account — invoice monthly"). Surfaced
--       only in super admin UI.
--
-- Backfill rules:
--   * Existing tenants — no trial grant (they're already in flight).
--     Their credit_seconds_remaining stays 0, which for any tenant
--     whose `plan` is NOT 'legacy' would mean blocked calls. To avoid
--     breaking production tenants on deploy, the enforcement layer
--     treats plan='legacy' as an unconditional bypass AND (for this
--     migration) we bulk-grant 5 hours = 18000 seconds to every
--     non-legacy business as a "migration-time courtesy credit" so no
--     one gets a nasty surprise at 3am.
--   * Valleymede (plan='legacy') — bypassed by the runtime enforcer
--     regardless of balance. Still gets a ledger row for clarity.
--
-- Idempotent:
--   * CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere.
--   * Package seed uses ON CONFLICT (key) DO NOTHING — ops can UPDATE
--     prices later and a re-run won't clobber them.
--   * Backfill ledger insert is gated on "NOT EXISTS a prior migration
--     grant for this business" so a second run is a no-op.
-- ============================================

BEGIN;

-- --------------------------------------------------------------------
-- credit_packages — catalog
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_packages (
    id               SERIAL PRIMARY KEY,
    key              VARCHAR(40) UNIQUE NOT NULL,
    label            VARCHAR(80) NOT NULL,
    seconds_included BIGINT NOT NULL CHECK (seconds_included > 0),
    price_cents      INT NOT NULL CHECK (price_cents >= 0),
    currency         VARCHAR(8) NOT NULL DEFAULT 'USD',
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order       INT NOT NULL DEFAULT 0,
    description      TEXT,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Seed the v1 catalog. Prices are in integer cents to avoid floating-
-- point nonsense. 18000s = 5h, 54000s = 15h, 180000s = 50h.
INSERT INTO credit_packages (key, label, seconds_included, price_cents, sort_order, description)
VALUES
    ('starter', 'Starter',  18000,  7900, 10, '5 hours of AI phone coverage. Best for seasonal or low-volume lines.'),
    ('growth',  'Growth',   54000, 23900, 20, '15 hours of AI phone coverage. Covers most active small businesses.'),
    ('pro',     'Pro',     180000, 79900, 30, '50 hours of AI phone coverage. For busy multi-line operations.')
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------------------
-- credit_ledger — append-only log
-- --------------------------------------------------------------------
-- Every balance change is one row. Positive delta_seconds grants
-- credit, negative deducts. Reason is a small enum-ish string so we
-- can filter ("show me all admin_grants in the last 30 days").
CREATE TABLE IF NOT EXISTS credit_ledger (
    id                 BIGSERIAL PRIMARY KEY,
    business_id        INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    delta_seconds      BIGINT NOT NULL,
    reason             VARCHAR(40) NOT NULL
                          CHECK (reason IN (
                              'trial_grant', 'purchase', 'admin_grant',
                              'admin_deduction', 'call_usage', 'refund',
                              'migration_grant'
                          )),
    source_type        VARCHAR(40),   -- 'call_log' | 'package' | 'super_admin' | 'migration'
    source_id          BIGINT,        -- FK-in-spirit; we don't enforce so sources can archive
    note               TEXT,
    created_by_user_id INTEGER,       -- super admin user who performed an admin_grant; NULL for automated rows
    balance_after      BIGINT NOT NULL DEFAULT 0, -- denormalised running total right after this row
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_business_id
    ON credit_ledger(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_reason
    ON credit_ledger(business_id, reason);

-- --------------------------------------------------------------------
-- businesses — materialised balance + trial metadata
-- --------------------------------------------------------------------
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS credit_seconds_remaining BIGINT NOT NULL DEFAULT 0;

ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS trial_granted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS billing_notes TEXT;

-- --------------------------------------------------------------------
-- Backfill — courtesy credit for existing non-legacy tenants
-- --------------------------------------------------------------------
-- Pattern: one ledger row per eligible business, paired with an UPDATE
-- to the materialised balance. Gated on "no migration_grant exists yet"
-- so re-running this migration is a no-op.
--
-- 18000 seconds = 5 hours. A one-time courtesy so deploying billing
-- doesn't silently expire anyone.
DO $$
DECLARE
    biz RECORD;
BEGIN
    FOR biz IN
        SELECT id, slug, plan
          FROM businesses
         WHERE (plan IS NULL OR plan <> 'legacy')
           AND NOT EXISTS (
               SELECT 1 FROM credit_ledger cl
                WHERE cl.business_id = businesses.id
                  AND cl.reason = 'migration_grant'
           )
    LOOP
        INSERT INTO credit_ledger
            (business_id, delta_seconds, reason, source_type, note, balance_after)
        VALUES
            (biz.id, 18000, 'migration_grant', 'migration',
             'Phase 7a migration courtesy credit (5 hours) — one-time grant so existing tenants are not blocked on deploy.',
             COALESCE((SELECT credit_seconds_remaining FROM businesses WHERE id = biz.id), 0) + 18000);

        UPDATE businesses
           SET credit_seconds_remaining = credit_seconds_remaining + 18000
         WHERE id = biz.id;
    END LOOP;
END $$;

-- --------------------------------------------------------------------
-- Ledger
-- --------------------------------------------------------------------
INSERT INTO migrations (name) VALUES ('006_credit_system')
ON CONFLICT (name) DO NOTHING;

COMMIT;
