# CLAUDE.md — Project Rules

> This file is the authoritative contract for anyone (human or AI) writing code in this repo.
> If a rule here ever conflicts with something else, **this file wins**. Update it deliberately.

---

## 1. What this project is

This repo started life as a **single-tenant** AI phone answering system for **Valleymede Columbus Golf Course**. We are in the middle of turning it into a **multi-tenant SaaS platform** where any small business (golf courses first, then other verticals) can onboard in under 5 minutes and get a fully configured AI receptionist.

Two audiences live in the product from now on:

- **Super Admin** — the platform operator (us). Onboards new businesses, manages billing, monitors all tenants, has god-mode access.
- **Business user** — a tenant's staff. Logs in, sees only *their* business's bookings, calls, customers, settings. Has no visibility into other tenants.

The current single Valleymede install must keep running with zero downtime and zero behavioural regressions throughout the migration. Everything we ship is gated on "Valleymede still works".

---

## 2. The Golden Rules (non-negotiable)

1. **Valleymede never breaks.** Every migration, every refactor, every PR must preserve Valleymede's current behaviour: same phone number, same greetings, same bookings, same Command Center experience. If you can't prove it still works, don't merge it.
2. **`business_id` is the tenant boundary.** Every row in every tenant table carries a `business_id`. Every query that reads or writes tenant data is scoped by it. **No exceptions.** Missing a `WHERE business_id = $1` is a security bug.
3. **No cross-tenant data leaks.** A business user querying anything must only ever see their own `business_id`. This is enforced in the data layer, verified in middleware, and asserted in tests. "We'll filter in the API" is not good enough.
4. **Super Admin isolation is explicit.** Cross-tenant queries (platform dashboards, onboarding, support) only happen via routes that are guarded by a `requireSuperAdmin` middleware. A regular `requireAuth` handler must never be able to reach another tenant's data, even accidentally.
5. **Work in small, testable steps.** One concern per change. Update `PLAN.md` after each major phase. Every phase ends with a "Valleymede still works" checkpoint before the next one starts.
6. **Match the existing style.** This codebase uses plain Node + Express, `pg` with a shared `query()` helper, JSONB settings, and a React SPA served from the backend. Keep it that way unless we explicitly agree to swap something.

---

## 3. Tenant isolation — how it must look in code

### 3.1 Database

Every tenant table has:

```sql
business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
```

Every tenant table has an index starting with `business_id`:

```sql
CREATE INDEX idx_<table>_business ON <table>(business_id, <secondary_col>);
```

Uniqueness constraints that used to be global become composite:

- `customers.phone` → `UNIQUE(business_id, phone)`
- `settings.key` → `PRIMARY KEY(business_id, key)`
- Anything else that was `UNIQUE(x)` becomes `UNIQUE(business_id, x)`.

**Business-level identity** (the fields that route an inbound call to the right tenant) lives on `businesses`:

- `twilio_phone_number` is globally unique — it's how we know which tenant a call belongs to.
- `slug` is globally unique — used in URLs and subdomains.

### 3.2 Application

Every request carries a tenant context. Concretely:

- `requireAuth` middleware decodes the JWT and puts `req.auth = { user_id, business_id, role }` on the request.
- All data-layer helpers take `business_id` as their first argument: `getSetting(businessId, key)`, `createBookingRequest({ businessId, ... })`, etc.
- Route handlers pull `business_id` from `req.auth` — **never** from the URL or request body. Clients cannot choose which tenant they're operating on.
- Super Admin routes (`/api/admin/*`) use `requireSuperAdmin`. They may accept a `businessId` parameter because that's the whole point of those routes.

### 3.3 Twilio / inbound calls

The call's tenant is looked up from the **called number** (`To` in Twilio's webhook), not from the caller. The lookup is:

```
businesses.twilio_phone_number = req.body.To  →  business_id
```

If no business matches, we reject the call with a generic message. Never fall back to Valleymede.

---

## 4. Migration safety rules

1. **All migrations are idempotent.** Use `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`. The migration must be safe to run twice.
2. **Wrap every migration in a single transaction** where possible. If part of it fails, the whole thing rolls back.
3. **Backfill before constraining.** When adding `business_id NOT NULL` to an existing table: (a) add nullable column, (b) backfill with Valleymede's id, (c) then set `NOT NULL` and the FK. Never in the opposite order.
4. **Preserve data.** No `DROP` without an explicit data-migration step that proves we didn't lose anything. No `TRUNCATE` outside local dev. Ever.
5. **Settings live per-business.** `settings` is keyed on `(business_id, key)`. The Valleymede seed data is assigned to `business_id = 1`. All new businesses get their own copy of the seed via the onboarding wizard.
6. **Valleymede is always `business_id = 1`**. We hardcode this id in the initial seed and the first migration. Later tenants get auto-incremented ids from 2 upward.

---

## 5. Code conventions

- **Language:** Node.js (CommonJS `require`), Express 4, `pg` directly (no ORM). React SPA in `command-center/`.
- **DB access:** Always go through `server/config/database.js` (`query`, `getSetting`, `updateSetting`). Never `new Pool()` somewhere else.
- **Settings access:** After Phase 2, always pass `businessId` as the first arg: `getSetting(businessId, 'pricing')`. Using the old signature is a bug.
- **Phone normalization:** Always via `normalizePhone()` in `server/services/caller-lookup.js`. Never roll your own.
- **Logging:** Include `business_id` in any log line that's about tenant data. You will thank yourself when debugging a cross-tenant issue.
- **Errors:** Return JSON `{ error: '...' }` with an appropriate status. Never echo stack traces to the client.
- **Secrets:** Never commit `.env`. `TWILIO_*` and `XAI_API_KEY` are platform-wide — not per-tenant. Per-tenant config lives in the `businesses` table.

---

## 6. Testing bar

Before any Phase is marked complete:

1. **Valleymede smoke test passes.** A scripted call flow (inbound → greeting → booking → confirmation) runs end-to-end on the Valleymede tenant.
2. **Cross-tenant negative test passes.** Business A's user cannot read or write Business B's data via any API route.
3. **Migration re-run test passes.** Running the migration twice on a clean DB leaves it in the same state as running it once.
4. **Super Admin dashboard sees all tenants.** A regular tenant user sees exactly one (their own).

---

## 7. Boundaries — what not to build yet

- **No full billing integration.** Stripe comes in Phase 6. Until then, `businesses.plan` is a free-form string and billing is manual.
- **No subdomain routing** in Phase 1–3. We use the Twilio number as the tenant key and `/admin/*` paths for the Super Admin. Custom domains come later.
- **No marketplace of verticals.** This is a golf-course product first. Verticals are a later expansion; write the code generically enough that it's not a rewrite, but don't abstract prematurely.

---

## 8. When you're stuck

- Check `PLAN.md` for the current phase and its acceptance criteria.
- If a decision isn't written down here or in `PLAN.md`, **stop and ask** rather than guessing. This repo is small enough that a 30-second clarification beats a 2-hour rework.
- When in doubt, optimize for Valleymede keeping working. Everything else is secondary.
