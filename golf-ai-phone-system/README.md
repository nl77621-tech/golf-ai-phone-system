# Golf AI Phone System

A multi-tenant SaaS platform for AI-powered phone answering. Small businesses onboard in under five minutes and get a fully configured AI receptionist that answers on their existing phone number, books appointments, and escalates to human staff only as a last resort.

The first production tenant is Valleymede Columbus Golf Course. Golf is the opening vertical; the platform is built generically enough for driving ranges, restaurants, and other appointment-driven small businesses.

---

## What's in the box

- **Inbound voice AI** — Twilio inbound calls streamed into xAI's Grok Real-time Voice API. Natural, low-latency conversation, caller recognition by phone number, bilingual (English + French on request), and random human-like openers.
- **Multi-tenant onboarding** — A six-step Super Admin wizard spins up a new tenant: name + slug, Twilio DID(s), vertical template (golf / driving range / restaurant / other), first admin invite. One `POST /api/super/businesses` call seeds settings, greetings, and phone routing.
- **Per-tenant Command Center** — Each tenant's staff logs in and sees only their own dashboard: bookings, call logs, customers, greetings, and settings. Zero cross-tenant visibility is enforced in the data layer, not just the UI.
- **Super Admin dashboard** — Fleet-wide view across every tenant: platform analytics (tenants by status, calls today, active calls now, minutes in the last 30 days, open invites, pending bookings) and a collapsible live audit feed.
- **Audit log** — Every meaningful mutation is recorded: business creation, phone add/update/delete, setting updates, greeting changes, invites, logins, and super-admin impersonation. Polymorphic `user_id` + `user_type` discriminator so one table covers both super admins and tenant users.
- **Phone number management** — Each tenant can own multiple DIDs. The `business_phone_numbers` table is the authoritative routing source (primary + secondary lines, active/inactive status); the `businesses.twilio_phone_number` column is kept as a legacy denorm so pre-Phase-5 tenants keep routing during cutover.
- **Templates** — Settings + greetings packages per vertical. New tenants get a baseline seed first, then the vertical template overlays on top.
- **Magic-link invites** — Super admins and business admins mint single-use tokens; the recipient signs up at `/accept-invite?token=…` and is dropped into their tenant.

---

## Audiences

- **Super Admin** — The platform operator. Onboards new tenants, impersonates any tenant for support, watches platform-wide analytics and the audit feed. Routes under `/api/super/*` + `requireSuperAdmin`.
- **Business user** (`business_admin` or `staff`) — A tenant's staff. Logs in, sees only their own tenant's data. Routes under `/api/*` + `attachTenantFromAuth`.

Roles: `super_admin`, `business_admin`, `staff`. The legacy `owner` role is normalized to `business_admin` by the auth middleware.

---

## Tenant isolation — the rules

1. **`business_id` is the tenant boundary.** Every row in every tenant table carries `business_id`; every query that reads or writes tenant data is scoped by it.
2. **`business_id` comes from the JWT**, never from the URL or the body. Clients cannot choose which tenant they're operating on.
3. **Super admin cross-tenant writes go through `/api/super/*` only.** A regular `requireAuth` handler cannot reach another tenant's data, even accidentally.
4. **Inbound calls are routed by `To`** — the called number maps to a tenant via `business_phone_numbers`, with a documented legacy fallback to `businesses.twilio_phone_number` and a single-tenant bootstrap to Valleymede only for the cutover window.

See `CLAUDE.md` for the full contract.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Telephony | Twilio Voice + SMS |
| Voice AI | xAI Grok Real-time Voice API |
| Backend | Node.js + Express (no ORM; `pg` directly via a shared `query()` helper) |
| Database | PostgreSQL |
| Frontend | React SPA (`command-center/`), Vite-built, served from the backend |
| Email | Nodemailer (Gmail SMTP for Valleymede; configurable per-tenant) |
| Weather | OpenWeatherMap (optional, for course-facing AI responses) |
| Hosting | Railway.app |

---

## Repository layout

```
server/
  index.js                    Express bootstrap
  config/database.js          Shared `query` + tenant-scoped helpers (getSetting, updateSetting, listBusinessPhoneNumbers, …)
  middleware/
    auth.js                   JWT + requireAuth + requireSuperAdmin + invite helpers
    tenant.js                 Resolves tenant from JWT (web) or Twilio `To` (voice)
  context/tenant-context.js   Canonical role constants
  routes/
    auth.js                   /auth/login, /auth/invite, /auth/accept-invite, /auth/register-super-admin
    super-admin.js            /api/super/* — cross-tenant operations (onboarding, phones, audit, analytics)
    api.js                    /api/* — per-tenant operations (bookings, settings, greetings, phones)
    twilio.js                 /twilio/voice, /twilio/sms, debug routes
  services/
    audit-log.js              Append-only audit service (Phase 6)
    caller-lookup.js          Phone normalisation + caller identification
    templates.js              Per-vertical seed packages
    booking-manager.js        Booking lifecycle (pending / confirmed / rejected / cancelled)
    notification.js           Email + SMS to staff
    grok-voice.js             xAI bridge
    teeon-automation.js       Tee sheet automation (golf-specific, per-tenant)
    weather.js                OpenWeatherMap, per-tenant coords with legacy fallback
    system-prompt.js          AI system prompt builder
  db/
    schema.sql                Canonical current schema
    migrations/
      001_multi_tenant.sql    Add `businesses`, `business_users`, `super_admins`; backfill Valleymede as business_id = 1
      002_auth_and_invites.sql  Invites table, role rename (`owner` → `business_admin`)
      003_phone_routing.sql   `business_phone_numbers` + backfill from legacy denorm
      004_audit_log.sql       Audit log table + indexes (Phase 6)
    init.js                   Idempotent migration runner
command-center/
  src/App.jsx                 React SPA: LoginPage, TopBar + BusinessSwitcher, Sidebar, tenant pages, SuperAdminDashboard, OnboardingWizard, PhoneNumbersManager
```

---

## Key environment variables

Platform-wide (not per-tenant):

- `DATABASE_URL` — Postgres connection string.
- `JWT_SECRET` — session signing key.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — Twilio credentials.
- `XAI_API_KEY` — xAI Grok credentials.
- `SUPER_ADMIN_BOOTSTRAP_TOKEN` (optional) — gates the one-shot first-super-admin bootstrap.
- `DEBUG_PHONE_RESOLVE` (optional, set to `1`) — enables `GET /twilio/_debug/phone-resolve?To=+1…` for routing diagnosis.

Per-tenant config lives in the `businesses` row + the `settings` table, not the environment. Anything that used to be a Valleymede env var (open hours, pricing, etc.) is now a setting keyed by `(business_id, key)`.

---

## Running locally

```bash
# 1. Install
npm install
cd command-center && npm install && cd ..

# 2. Set env (see list above)
cp .env.example .env   # edit JWT_SECRET, DATABASE_URL, Twilio creds, xAI key

# 3. Apply migrations (idempotent — safe to run twice)
npm run db:init

# 4. Seed the first tenant + first super admin (Valleymede, business_id=1)
npm run db:seed

# 5. Build the SPA + start the server
npm run build:ui
npm start
```

The Super Admin dashboard lives at `/` once you sign in as a super admin. Tenant users sign in and land on their Command Center dashboard directly.

---

## Onboarding a new tenant

1. Sign in as super admin.
2. Click **New Business** on the platform dashboard.
3. Fill in the six-step wizard (basics → phones → template → admin invite → review).
4. Hand the generated magic-link invite URL to the tenant's admin.
5. Point the tenant's Twilio DID at `POST /twilio/voice` (and `/twilio/sms` for SMS).
6. Verify in the logs: a test call should produce `PHONE_ROUTE source=business_phone_numbers To=+1… slug=<new-slug>`.

Anything tagged `source=single_tenant_bootstrap` or `source=legacy_denorm` means the DID still needs an explicit `business_phone_numbers` row.

---

## Documentation

- `CLAUDE.md` — Authoritative project rules (tenant isolation, migration safety, code conventions).
- `PLAN.md` — Migration phase log (what shipped, what's locked, what's deferred).
- `ARCHITECTURE.md` — System architecture (tenancy model, routing, audit log, original single-tenant overview preserved).
- `DEPLOY-STEP-BY-STEP.md` — End-to-end deployment, including Part 7 (multi-tenant platform operations).
- `SETUP-GUIDE.md` — Original single-tenant setup notes (still accurate for a given tenant).
- `QUICK-REFERENCE.md` — Cheat sheet.

---

## Status

Phase 6 complete — audit log, platform analytics, single-tenant cleanup. Phase 7 (Stripe billing, plan gating, usage metering) is deferred.
