# PLAN.md — Multi-Tenant SaaS Migration

> This is the living roadmap for turning the Valleymede-only phone system into a multi-tenant SaaS.
> Update this file at the end of every phase.

**Status:** Phase 1 locked (2026-04-23). Phase 2 locked (2026-04-23). Phase 3 locked (2026-04-23). Phase 4 locked (2026-04-23). Phase 5 locked (2026-04-23). Phase 6 locked (2026-04-23).
**Golden rule:** Valleymede keeps working at every checkpoint.

---

## Phase 0 — Groundwork (DONE)

- [x] Read the full codebase.
- [x] Write `CLAUDE.md` (project rules, tenant isolation model, migration safety).
- [x] Write this `PLAN.md`.

**Deliverable:** Shared understanding + rules committed.

---

## Phase 1 — Database multi-tenancy (DONE)

Add tenancy to the data layer without touching application code yet. Result: Valleymede is `business_id = 1` in a new multi-tenant schema, and absolutely nothing about its behaviour changes.

**Deliverables**

- [x] Updated `server/db/schema.sql` that contains the full multi-tenant schema (fresh installs produce a tenant-ready DB).
- [x] `server/db/migrations/001_multi_tenant.sql` — idempotent migration that converts an existing Valleymede-only DB to the new shape.
- [x] `server/db/seed.sql` updated so all settings + greetings seed into `business_id = 1`.
- [x] `server/db/init.js` updated to run schema → migrations → seed in order, with ledger-tracked migrations that auto-apply on startup.

**New tables**

- `businesses` — tenant record. Columns: `slug`, `domain_slug`, `name`, `twilio_phone_number`, `transfer_number`, `timezone`, `contact_email`, `contact_phone`, `status`, `is_active`, `plan`, `logo_url`, `primary_color`, `branding`, `created_by` → `super_admins(id)`, `internal_notes`, `created_at`, `updated_at`.
- `business_users` — staff users scoped to a business. Replaces the single env-var admin.
- `super_admins` — platform operators.
- `business_phone_numbers` — multi-DID support per tenant (`phone_number`, `label`, `is_primary`). A partial unique index enforces at most one primary number per business. Will become the canonical inbound-routing key in Phase 4; for now `businesses.twilio_phone_number` remains the denormalized source of truth.
- `migrations` — ledger of applied migrations.

**Tables gaining `business_id`**

`settings`, `customers`, `booking_requests`, `modification_requests`, `call_logs`, `greetings`.

**Uniqueness changes**

- `settings`: PK becomes `(business_id, key)`.
- `customers`: `UNIQUE(phone)` → `UNIQUE(business_id, phone)`.
- All others add composite indexes starting with `business_id`.

**Backfill strategy**

1. Add `business_id` as nullable.
2. `INSERT INTO businesses` the Valleymede row with `id = 1`.
3. `UPDATE <table> SET business_id = 1` for every existing row.
4. Add `NOT NULL` + FK constraint.
5. Swap unique constraints to their composite versions.

**Acceptance criteria**

- [x] Running `migrations/001_multi_tenant.sql` on a current production snapshot leaves every existing Valleymede row intact, scoped to `business_id = 1`.
- [x] Running the migration twice is a no-op.
- [x] A fresh `init.js` run on an empty DB produces schema + seed in one shot, with Valleymede present as `business_id = 1`.
- [x] All existing queries in the app **still run** (they just return the same rows because there's only one tenant). We have not wired the app layer yet; that's Phase 2.

**Ops follow-up before Phase 4** (documented as a commented example in `migrations/001_multi_tenant.sql`):

```sql
UPDATE businesses SET twilio_phone_number = '+1XXXXXXXXXX' WHERE id = 1;
INSERT INTO business_phone_numbers (business_id, phone_number, label, is_primary)
VALUES (1, '+1XXXXXXXXXX', 'Main Line', TRUE)
ON CONFLICT (phone_number) DO NOTHING;
```

**Phase 1 locked — proceed to Phase 2 on review.**

---

## Phase 2 — Data layer & query scoping (DONE)

Pushed `business_id` through the Node code so that every query is tenant-scoped. Valleymede now lives at `business_id = 1` behind the same plumbing every future tenant uses.

**Deliverables**

- [x] `server/context/tenant-context.js` — `VALLEYMEDE_BUSINESS_ID`, `SUPER_ADMIN_ROLE`, `runWithTenant` AsyncLocalStorage helpers, `requireBusinessId` / `requireBusinessIdOrSuperAdmin` guards, and `tlog/twarn/terror` tenant-prefixed loggers.
- [x] `server/middleware/tenant.js` — `attachTenantFromAuth` (hydrates `req.business` from the JWT), `attachTenantFromTwilioTo` (resolves business from the called DID; generic TwiML hangup on no match), `attachTenantFromCallSid` (lookup via `call_logs` for status/transfer callbacks). Includes single-tenant bootstrap fallback that only fires while exactly one business exists.
- [x] `server/middleware/auth.js` — JWT payload now carries `{ user_id, business_id, role, username }`. Login resolves against `business_users` → `super_admins` → legacy env-var admin (maps to Valleymede). `requireSuperAdmin` middleware added.
- [x] `server/config/database.js` — `getSetting` / `updateSetting` / `getAllSettings` take `businessId` first and enforce via `requireBusinessIdOrSuperAdmin`. New helpers: `getBusinessByTwilioNumber`, `getBusinessById`, `getBusinessBySlug`, `listActiveBusinesses`, `countBusinesses`.
- [x] `server/services/caller-lookup.js` — `lookupByPhone`, `lookupByName`, `registerCall`, `updateCustomer` all take `businessId` first. `registerCall` uses `INSERT ... ON CONFLICT (business_id, phone)` to survive concurrent inbound calls.
- [x] `server/services/booking-manager.js` — every function (create/get/update for bookings and modifications) takes `businessId` first and includes it in the WHERE clause. Uses per-tenant timezone (`getBusinessTimezone(businessId)`) for all date math. Modification auto-cancel is scoped so it can never touch another tenant's bookings.
- [x] `server/services/notification.js` — `sendEmail`, `sendSMS`, `sendBookingNotification`, and all customer-facing SMS helpers take `businessId` first. Uses `business.twilio_phone_number` as the SMS From with a fallback to the platform-wide env var. Customer-phone lookup scoped by `(business_id, phone)`.
- [x] `server/services/system-prompt.js` — `buildSystemPrompt(businessId, callerContext)` loads every prompt section (course_info, pricing, business_hours, policies, greetings, etc.) scoped by business. No Valleymede content is hardcoded anywhere in the file.
- [x] `server/services/weather.js` — reads tenant lat/lon/city from `businesses` row (falls back to Oshawa only if unset).
- [x] `server/services/phone-lookup.js` — Twilio Lookup cache scoped by `(business_id, customer_id)`.
- [x] `server/services/teeon-automation.js` — accepts per-tenant `{courseCode, courseGroupId}` config. Separate cookie jars, HTTP session pools, and result caches per course pair so two tenants on different sheets can't share state.
- [x] `server/services/grok-voice.js` — `handleMediaStream(ws, businessId, callerPhone, callSid, streamSid, appUrl)`. Every tool call (`create_booking`, `check_tee_times`, `check_weather`, `lookup_customer`, `transfer_call`, etc.) threads `businessId` through. `call_logs` INSERT includes `business_id`. Tee-On config resolved per tenant. Fallback system prompt is generic, not Valleymede-specific.
- [x] `server/services/scheduled-tasks.js` — day-before reminders iterate every active business via `listActiveBusinesses()`. One shared 15-minute interval; each tenant fires at its own local 6 PM based on `business.timezone`.
- [x] `server/routes/twilio.js` — `/voice` and `/sms` use `attachTenantFromTwilioTo`. `/transfer` and `/transfer-fallback` use `attachTenantFromCallSid`. TwiML stream carries `businessId` in `<Parameter>` tags so the WebSocket handler knows which tenant the call belongs to. Hardcoded Valleymede phone number / name replaced with `req.business.name` / `req.business.transfer_number`.
- [x] `server/routes/api.js` — entire router gated by `requireAuth` + `attachTenantFromAuth`. Super-admin tokens 403 out (they belong on `/api/admin/*`). Every SQL statement and every service call is scoped by `req.business.id`. Analytics and calls-today use the tenant's timezone.
- [x] `server/index.js` — WebSocket `start` frame requires a valid `businessId`; drops the connection if missing. `handleMediaStream(ws, businessId, ...)` signature. Startup now delegates to `db/init.js`'s `applySchema → applyMigrations → applySeed` so Phase 1's `001_multi_tenant.sql` auto-applies on rolling restarts.

**Acceptance criteria**

- [x] Every DB call in `server/` touches `business_id` (grep for tenant tables returns 0 unscoped statements; `DELETE`, `UPDATE`, `INSERT`, `SELECT` all include `business_id` predicates where applicable).
- [x] Valleymede's existing Twilio number still routes to `business_id = 1` via the single-tenant bootstrap resolver in `tenant.js` — no behaviour change until the ops step writes the DID into `businesses.twilio_phone_number`.
- [x] API router blocks cross-tenant reads at middleware level: `req.auth.business_id` is pulled from the JWT only and every handler filters by `req.business.id`.
- [x] Tenant-isolation guards throw rather than silently return every tenant's rows — `requireBusinessId` is called at the top of every tenant-scoped data-layer helper.

**Deferred to later phases** (intentional):

- Dedicated `/api/admin/*` router for cross-tenant dashboards → Phase 5.
- Removing the single-tenant Twilio bootstrap fallback → Phase 4 (once DID routing is formalized).
- `super_admins` / `business_users` CRUD UI → Phase 3.

**Post-review refinements (2026-04-23) — applied before locking:**

- `server/middleware/tenant.js` — added `validateTwilioSignature`, a thin wrapper around `twilio.webhook()` that verifies `X-Twilio-Signature` on every webhook and no-ops (with a one-time warning) when `TWILIO_AUTH_TOKEN` is unset or `TWILIO_SKIP_VALIDATION=1` (dev only). All three tenant-attach middlewares now stamp a `source` tag (`'jwt'` / `'twilio_to'` / `'twilio_callsid'`) into AsyncLocalStorage so downstream errors can name the entry point that failed.
- `server/routes/twilio.js` — `router.use(validateTwilioSignature)` applied at the top, so `/voice`, `/sms`, `/status`, `/transfer`, and `/transfer-fallback` all require a signed request in production. `/voice` continues to thread `businessId` into the Grok bridge via TwiML `<Parameter>` tags; `server/index.js` validates the parameter on the WebSocket `start` frame and drops the connection if missing/invalid.
- `server/context/tenant-context.js` — `requireBusinessId()` now reads the `source` tag from AsyncLocalStorage and embeds it in the thrown error (e.g. `source=twilio_to`), along with a one-liner naming the three resolution paths. New `getTenantSource()` helper exported.
- `server/config/database.js` — added `tenantQuery(businessId, sql, params)` safety guard. When `businessId` is a positive integer and the SQL touches a tenant table (`customers`, `booking_requests`, `modification_requests`, `call_logs`, `greetings`, `settings`, `business_phone_numbers`) with a `SELECT`/`UPDATE`/`DELETE`, the wrapper throws unless the SQL has a `business_id` predicate. When `businessId` is `null`, a super-admin context is required and the query is logged with `[tenant:admin] SUPER_ADMIN_BYPASS` so cross-tenant reads are auditable. `getSetting` now warns if called with `null` since `settings` is always per-tenant.

**Phase 2 locked (2026-04-23).**

---

## Phase 3 — Auth, users, and middleware (DONE)

Replaced the single-admin env var with real DB-backed users, added the Super Admin role, built a magic-link invite flow, and surfaced all of it in the Command Center.

**Role vocabulary (locked for Phase 3+):** `super_admin` | `business_admin` | `staff`. Legacy `'owner'` tokens/rows are normalized to `business_admin` everywhere (middleware + migration 002) so Valleymede's existing session survives.

**Deliverables**

- [x] `server/db/migrations/002_auth_and_invites.sql` — idempotent migration that renames `business_users.role = 'owner'` → `'business_admin'`, adds `businesses.setup_complete BOOLEAN`, creates `user_invites` (token, email, role, inviter, expiry, accepted_at) with a partial unique index on `(business_id, email) WHERE accepted_at IS NULL`, and back-fills `setup_complete = TRUE` for Valleymede + any business that already has an active business_admin.
- [x] `server/db/schema.sql` updated to match — new `user_invites` table, `setup_complete` column on `businesses`, default role on `business_users` is now `'business_admin'`.
- [x] `server/context/tenant-context.js` — exports `BUSINESS_ADMIN_ROLE`, `STAFF_ROLE`, `ALL_ROLES`, and `isBusinessAdminRole()` helper (accepts legacy `'owner'`).
- [x] `server/middleware/auth.js` — rewritten. `normalizeRole()` collapses legacy roles. `requireAuth` rejects tokens missing `business_id` unless role is `super_admin` (or the legacy env-var admin). New `requireRole(allowed)` middleware (super_admin always passes). JWT minters `signBusinessUser()` / `signSuperAdmin()`. Invite primitives: `createInvite({businessId,email,role,inviter})` (32-byte base64url token, 7-day TTL, deletes prior open invites for the same `(business_id,email)`); `findOpenInviteByToken(token)`; `acceptInvite(invite,{password,name})` — transactional, creates the user (super_admins or business_users UPSERT), stamps `accepted_at`, flips `setup_complete = TRUE` on business_admin invites, returns a signed session.
- [x] `server/routes/auth.js` — `POST /auth/login`, `GET /auth/verify` return a clean auth payload. `POST /auth/register-super-admin` — bootstrap route that only works when the `super_admins` table is empty (or when an optional `SUPER_ADMIN_BOOTSTRAP_TOKEN` env var is presented). `POST /auth/invite` — super_admin may invite into any tenant; business_admin may only invite into their own tenant; staff may not invite. `GET /auth/invite/:token` (public) returns `{email, role, business_name}` so the accept-invite page can render. `POST /auth/accept-invite` consumes the token and returns a JWT. `buildInviteUrl(req, token)` respects `x-forwarded-proto/host`.
- [x] `server/routes/super-admin.js` (new) — router guarded by `requireAuth` + `requireSuperAdmin`. `GET /businesses` returns every tenant with `active_user_count`, `calls_last_30d`, `bookings_last_30d` joined in. `GET /businesses/:id` returns the full record + users + phone numbers. `POST /businesses` is transactional: inserts the business row (`status='trial'`), registers `twilio_phone_number` in `business_phone_numbers` as the primary DID, seeds `DEFAULT_SETTINGS` (11 keys of safe defaults) + `DEFAULT_GREETINGS` (3 generic greetings), and optionally creates a `business_admin` invite in the same transaction. `PATCH /businesses/:id` updates an allowlisted field set. `POST /businesses/:id/invite-admin` is a shortcut for creating a business_admin invite.
- [x] `server/middleware/tenant.js` — `attachTenantFromAuth` now recognises super admins: with an `X-Business-Id` header they route into that tenant's context (logged as `SUPER_ADMIN_BUSINESS_SWITCH`); without the header `req.business` stays `null` and they can only reach `/api/super` + `/auth`. Tenant users who send a conflicting `X-Business-Id` get a 403 `"Tenant users cannot switch businesses"` rather than falling through to their own tenant silently.
- [x] `server/routes/api.js` — removed the blanket super_admin 403 from Phase 2. New gate: super_admin hitting `/api/*` without an `X-Business-Id` header gets a 400 with a hint to use `/api/super/*`; tenant users without `req.business` still get 403.
- [x] `server/index.js` — mounts `app.use('/api/super', superAdminRoutes)` **before** `app.use('/api', apiRoutes)` so super-admin paths don't fall through to the tenant router.
- [x] `command-center/src/App.jsx` — significant rework. Session helpers (`getSession`, `setSession`, `getSelectedBusinessId`, `setSelectedBusinessId`, `clearAuth`). The `api()` wrapper now auto-injects `X-Business-Id` when a super admin is acting as a tenant (skipped on `/api/super` + `/auth`). New routes: `AcceptInvitePage` (public, renders when `location.pathname === '/accept-invite'`), `SuperAdminDashboard` (table of tenants with metrics + "Act as →" button), `CreateBusinessModal` (provisions a business + invite URL in one submit). New `TopBar` shows the role badge, a Business Switcher for super admins, and an "Acting as X" indicator. Root `App()` rehydrates via `/auth/verify` on mount, renders `LoginPage` / `SuperAdminDashboard` / tenant Sidebar depending on role + selected tenant. Existing tenant UX is unchanged when a business_admin or staff user logs in.

**Acceptance criteria**

- [x] Valleymede's existing login keeps working. Legacy tokens signed with `role: 'owner'` are normalised to `business_admin` on every request; the env-var admin fallback still issues a session scoped to `business_id = 1`.
- [x] A Super Admin can register via the empty-table bootstrap route, log in at `/`, see `SuperAdminDashboard`, and pick any tenant via the Business Switcher to impersonate them through the Command Center.
- [x] A business user hitting any `/api/*` route is filtered to their own `business_id`; any `X-Business-Id` header they send that doesn't match their own tenant returns 403 before a handler ever runs.
- [x] Invite flow: super_admin (or business_admin within their own tenant) creates an invite → invite URL is emitted in the create-business response → invitee hits `/accept-invite?token=...` → sets a password → is signed in as the new user with the right role.
- [x] Static checks: `node --check` clean on all modified `server/**.js`. `@babel/parser` parses `command-center/src/App.jsx`. Grep for `'owner'` returns only intentional back-compat sites (migrations, `normalizeRole`, `isBusinessAdminRole`, comments).

**Out of scope for Phase 3 (deferred):**

- Super-admin-initiated password reset for existing users (invites cover provisioning, not recovery).
- Per-tenant "my users" CRUD UI on the business_admin side — only invites are exposed. Full CRUD lives in Phase 5/6.
- SMTP delivery of invite emails — the server returns the signed URL in the response body; ops paste it into whatever channel they use today. SMTP wiring is Phase 5.
- Removing the single-tenant Twilio bootstrap fallback — still Phase 4 work once the Valleymede DID is written into `businesses.twilio_phone_number`.

**Phase 3 locked (2026-04-23).**

---

## Phase 4 — Super Admin onboarding wizard + business management (DONE)

The headline Control Centre feature. A super admin can spin up a new tenant end-to-end from a single guided flow — business basics → phone numbers → vertical template → review → first-admin invite → success screen — in under 5 minutes. All existing tenant UX (Valleymede) is untouched.

**Deliverables**

- [x] `server/services/templates.js` — pure-data vertical template catalogue. Four templates shipped: `golf_course`, `driving_range`, `restaurant`, `other`. Each bundles a generic settings payload (12 keys — `business_hours`, `pricing`, `course_info`, `policies`, `memberships`, `tournaments`, `amenities`, `notifications`, `ai_personality`, `announcements`, `booking_settings`, `test_mode`) + 3 starter greetings + UI-facing meta (label, tagline, recommended plan, default timezone, feature bullets). `listTemplates()` / `getTemplate(key)` / `applyTemplate(client, businessId, key)` are the only exports. `applyTemplate` runs inside the caller's transaction and UPSERTs settings + appends greetings so reseeding is safe.
- [x] `server/routes/super-admin.js` — rewritten `POST /businesses` now accepts `{ name, slug, timezone, plan, contact_email, contact_phone, primary_color, logo_url, twilio_phone_number, transfer_number, phone_numbers: [{phone_number, label}], template_key, admin_email }` and returns `{ business, template, phone_numbers, invite }`. Flow inside one transaction: insert business row → baseline-seed → apply chosen template (UPSERT-style so template values win) → register primary Twilio number + any extra lines (deduped against the primary). Invite is minted outside the tx so delivery failures don't lose the tenant. New endpoints: `GET /templates` returns the wizard's picker payload (key + label + tagline + features + default_timezone + recommended_plan), `POST /invite` mints a standalone magic-link invite for an arbitrary `(business_id, email, role)` tuple (role must be `business_admin` or `staff`; the old `/businesses/:id/invite-admin` shortcut is kept).
- [x] `command-center/src/App.jsx` — Super Admin UX rebuild:
  - `OnboardingWizard` component: six-step modal (Basics → Phone numbers → Template → Review → Invite → Success) with progress bar, forward/back navigation, per-step validation (`canAdvance()`), live business-preview card on step 0, color picker + logo URL, add/remove rows for extra phone numbers, template grid with selected-state outlines, review-summary with computed template counts, success screen with copy-to-clipboard magic-link and the full list of registered phone numbers. Everything is in-memory until the final POST; a single `POST /api/super/businesses` call delivers the full payload.
  - `SuperAdminDashboard` upgraded from a table to a card grid: global totals strip (Tenants / Active / In Trial / Calls 30d / Bookings 30d), live search across name/slug/phone/email, empty-state with CTA, post-create ribbon that keeps the magic link visible until dismissed.
  - New components: `BusinessCard` (branded initials tile, status pill, metric chips, quick "Act as →"), `BusinessInitials`, `StatusPill`, `MetricChip` — all reused by the totals strip, cards, and wizard preview.
  - `BusinessSwitcher` now sorts alphabetically and annotates non-active tenants in the dropdown label.
- [x] Tenant isolation rules from Phase 2/3 preserved: every new endpoint is mounted under `/api/super/*` and still guarded by `requireAuth` + `requireSuperAdmin`. The wizard makes no unauthenticated calls; the created tenant's seeded settings live in `settings(business_id, key)` exactly like Valleymede's.

**Acceptance criteria**

- [x] A super admin can open the wizard, fill in basics + primary number + template + invite email, and POST exactly once to create a fully-seeded tenant — wizard shows the magic-link URL on the success screen, and the new tenant appears on the dashboard grid with its metrics (zero everywhere, as expected).
- [x] Every template applies 12 settings keys and 3 greetings (verified via `node -e "require('./server/services/templates').listTemplates()"`). No template hardcodes Valleymede-specific copy.
- [x] Static verification: `node --check` clean on `server/routes/super-admin.js`, `server/services/templates.js`, and every other server file touched across Phases 1–3. `@babel/parser` parses the updated `command-center/src/App.jsx` (163.7 kB) end-to-end. The expected top-level component names are all present: `OnboardingWizard`, `SuperAdminDashboard`, `BusinessCard`, `BusinessInitials`, `StatusPill`, `MetricChip`, `BusinessSwitcher`, `TopBar`, `AcceptInvitePage`, `App`.
- [x] Valleymede still resolves via the Phase 2 single-tenant bootstrap resolver; its row is not touched by any Phase 4 code path (new businesses get `id >= 2` with `setup_complete = FALSE`, which is the flag the business_admin invite flips to TRUE on acceptance — same as Phase 3).

**Polish pass (2026-04-23)**

A small follow-up tightened the rough edges before final lock:

- [x] `server/services/templates.js` — each template now ships `meta.description` (a paragraph-length explainer shown on the template card) and `meta.icon_emoji` (`⛳️`, `🎯`, `🍽️`, `✨`). `listTemplates()` surfaces both on the wizard payload.
- [x] `server/routes/super-admin.js` — new `GET /slug-check?slug=…` endpoint. Normalises the incoming slug the same way the POST path does, returns `{ available, normalized, existing_id?, existing_name? }`. Purely for operator UX — the `UNIQUE(slug)` constraint on `businesses` is still the authoritative gate on submit.
- [x] `command-center/src/App.jsx` — wizard hardened:
  - Module-level validators: `E164_RE`, `isValidE164`, `isValidEmail`, `slugifyClient`. The wizard's per-step `canAdvance()` now uses them against every phone field (primary, transfer, extras) and both email fields (contact, admin). Green UI never produces a 400 from the server.
  - Debounced (350 ms) slug-availability check hits `/api/super/slug-check` on every edit of the slug input and renders a live pill under the field (`Checking…` / `✓ available` / `Taken by Foo (#7)` / error).
  - Template cards now render the big emoji on the left, tagline in bold underneath, and the full paragraph `description` in muted text.
  - Step 4 (invite) has an explicit "Skip invite & create business" affordance: leaving `admin_email` blank is now a first-class path (with a hint line — "You can invite an admin later from the business card"), and the Create button label switches based on whether there's an email.
  - Step 5 (success) gained an "Act as {Business}" button that calls the new `onActAs` prop (wired from `SuperAdminDashboard` → `handleSelectBusiness`), so a super admin can jump straight into the freshly-created tenant without bouncing through the dashboard.
  - `SuperAdminDashboard` accepts an `onBusinessCreated` callback and fires it after the wizard closes; `App()` uses it to re-pull `/api/super/businesses` into the top-level state that backs the `TopBar` `BusinessSwitcher`, so the new tenant appears in the switcher immediately.
- [x] Static re-verify: `node --check server/routes/super-admin.js` ✅, `node --check server/services/templates.js` ✅, `@babel/parser` parses the updated `App.jsx` (172.3 kB) ✅. Templates catalogue smoke-checked: all four have description + icon_emoji + 12 settings + 3 greetings.

**Out of scope for Phase 4 (deferred):**

- Automated SMTP delivery of the magic link — the wizard still shows the URL in the UI and the super admin pastes it into whatever channel they use. Production SMTP is its own phase.
- Logo file uploads — `logo_url` is a URL field; object-storage upload comes later.
- Per-tenant drill-down routes (dashboard, bookings, calls, settings override) on the super-admin side — the `Act as →` flow covers the need for now via the X-Business-Id switcher.
- Stripe plan provisioning (still Phase 7).

**Phase 4 locked (2026-04-23).**

---

## Phase 5 — Twilio routing & per-business config (DONE)

`business_phone_numbers` is now the authoritative routing table for every inbound DID. `businesses.twilio_phone_number` stays wired as a denormalized legacy fallback so no existing tenant (Valleymede included) loses behaviour, but every code path that writes a DID now goes through the new table first. Operators can manage numbers per tenant from both the super-admin and the tenant side of the Command Center, and a new per-business Settings page surfaces Greetings / Prompt / Phones / General in one place.

**Deliverables**

- [x] `server/db/migrations/003_phone_routing.sql` — idempotent migration. Adds `business_phone_numbers.status TEXT NOT NULL DEFAULT 'active'` with a CHECK constraint (`'active'|'inactive'`), an `updated_at` column + trigger, and a partial unique index `UNIQUE(business_id) WHERE is_primary = TRUE AND status = 'active'` so only one active primary DID exists per tenant. Backfills every `businesses.twilio_phone_number` value that's missing from `business_phone_numbers` as a primary/active row so the new resolver sees parity with the legacy denorm on first boot. Ledgered via the `migrations` table (auto-applies on startup through `db/init.js`).
- [x] `server/db/schema.sql` — updated to match: `status` column + CHECK, `updated_at` + trigger, and the partial unique index are now part of the fresh-install schema.
- [x] `server/config/database.js` — resolver flip. `getBusinessByTwilioNumber(phone)` now does: (1) `business_phone_numbers WHERE phone_number = $1 AND status = 'active'` JOIN `businesses`, (2) legacy `businesses.twilio_phone_number = $1` fallback, (3) caller-side single-tenant bootstrap is still honored by `tenant.js`. New helpers: `listBusinessPhoneNumbers(businessId)`, `getPrimaryBusinessPhoneNumber(businessId)`, `addBusinessPhoneNumber(businessId, {phone_number, label, is_primary, status})`, `updateBusinessPhoneNumber(businessId, phoneId, patch)`, `deleteBusinessPhoneNumber(businessId, phoneId)`. Every mutator runs inside a transaction: promoting a phone to primary demotes the current primary in the same tx, and every write re-syncs `businesses.twilio_phone_number` to whatever row is currently `is_primary = TRUE AND status = 'active'` (keeping the legacy column truthful for anything that hasn't been cut over yet). `INVALID_STATE` is thrown (not 500) when a caller tries to create/retain an inactive primary.
- [x] `server/services/notification.js` — new `resolveFromNumber(businessId)` helper that prefers `getPrimaryBusinessPhoneNumber(businessId)` and falls back to `businesses.twilio_phone_number` → `process.env.TWILIO_PHONE_NUMBER`. `sendSMS` now calls it instead of reading `business.twilio_phone_number` directly, so outbound SMS follows the same routing table as inbound voice.
- [x] `server/middleware/tenant.js` — docstring on `resolveBusinessFromTwilioTo` rewritten to document the new resolution order (`business_phone_numbers` active → legacy denorm → single-tenant bootstrap). No behaviour change beyond the resolver flip; the single-tenant bootstrap is kept intact for Valleymede until its DID is wired into the new table via the ops step.
- [x] `server/routes/super-admin.js` — four new DID-management endpoints under the already-guarded `requireSuperAdmin` surface: `GET /businesses/:id/phone-numbers`, `POST /businesses/:id/phone-numbers` (E.164 validator `/^\+[1-9]\d{7,14}$/`, rejects primary+inactive combos), `PATCH /businesses/:id/phone-numbers/:phoneId`, `DELETE /businesses/:id/phone-numbers/:phoneId`. Maps `INVALID_STATE` → 400 and Postgres `23505` → 409 so the UI can render the real conflict instead of a generic 500. Existing `GET /businesses/:id` now returns `status` + `updated_at` on every phone row.
- [x] `server/routes/api.js` — tenant-scoped mirror. New `requireBusinessAdmin` middleware + `PHONE_E164_RE` / `isValidPhoneE164()` helpers. `GET /api/phone-numbers` is readable by any authenticated tenant user; `POST /api/phone-numbers`, `PATCH /api/phone-numbers/:id`, `DELETE /api/phone-numbers/:id` are gated to `business_admin` (staff is deliberately read-only). Every handler uses `req.business.id`, never a client-supplied tenant id, so the isolation rule from CLAUDE.md §3.2 still holds. Drive-by fix: `GET /api/settings` now returns the object produced by `getAllSettings(businessId)` directly instead of iterating it as if it were a row array (the old code silently produced `{}`).
- [x] `command-center/src/App.jsx` — reusable `PhoneNumbersManager({ endpointBase, canEdit, title })` component handles list / add / delete / make-primary / disable+enable with optimistic confirm dialogs and inline E.164 validation. The same component powers both the tenant's Settings → Phones tab (`endpointBase: '/api/phone-numbers'`) and the super-admin's new `PhoneNumbersModal` (`endpointBase: '/api/super/businesses/:id/phone-numbers'`). `BusinessCard` gained a `📞 Phones` button; `SuperAdminDashboard` wires it to `setPhoneModalBiz` and refreshes the business list on `onSaved` so primary-number edits propagate back into the card metrics. Tenant-side `SettingsPage` now renders tabs in the order General / Phones / Greetings / Prompt, with the Prompt tab wrapping `custom_prompt`, `ai_personality.name`, and `ai_personality.language` in per-setting save buttons that reuse the existing `/api/settings/:key` surface.

**Acceptance criteria**

- [x] Every write path that mutates a DID goes through `business_phone_numbers` first and keeps `businesses.twilio_phone_number` in lockstep with the current primary/active row — verified by grepping the codebase for `twilio_phone_number` writes: the only places that touch it are migration 003's backfill, the new transactional sync block in `database.js`, and the Phase 3/4 onboarding POST which already inserts into both tables in one transaction.
- [x] Migration 003 re-applies cleanly on both a fresh DB (exercised via `db/init.js` schema → migrations → seed) and an already-migrated DB (ledger check + `IF NOT EXISTS`/`DO $$` guards). Running it twice is a no-op.
- [x] Two tenants with distinct DIDs route independently: the resolver flip in `database.js` + the Phase 2 `attachTenantFromTwilioTo` middleware means `req.business.id` is set from the called DID before any handler runs, so the Grok bridge, TwiML generation, and all per-tenant settings (pricing, greetings, timezone, prompt) come from the tenant's own `settings` rows. Valleymede resolves via the Phase 2 single-tenant bootstrap exactly as before until its DID is wired into `business_phone_numbers` via the ops step.
- [x] Isolation: a tenant user hitting `/api/phone-numbers` only sees their own `business_id` rows; a staff user cannot POST/PATCH/DELETE (blocked by `requireBusinessAdmin`); a super admin hitting the same path without an `X-Business-Id` header still gets the Phase 3 400 ("use /api/super/*"). Super-admin phone CRUD is only reachable under `/api/super/businesses/:id/phone-numbers`.
- [x] Static verification: `node --check` clean on `server/config/database.js`, `server/services/notification.js`, `server/middleware/tenant.js`, `server/routes/super-admin.js`, `server/routes/api.js`, `server/db/init.js`. `@babel/parser` parses the updated `command-center/src/App.jsx` end-to-end and the expected new symbols (`PhoneNumbersManager`, `PhoneNumbersModal`, `isValidE164` call sites in the Phones tab) are all present. Templates smoke check from Phase 4 still passes.

**Out of scope for Phase 5 (deferred):**

- Removing the single-tenant bootstrap fallback in `tenant.js` — now that every new write updates `business_phone_numbers`, Valleymede is the only tenant still riding the bootstrap; the fallback will be dropped in Phase 6 once its DID is explicitly registered via the new endpoint.
- Twilio number purchase / release flow (creating a DID through the Twilio API from inside the wizard). The current UX expects an operator to bring the number and paste it in.
- Per-tenant inbound routing rules (IVR menus, time-of-day routing). The router is still "called-DID → tenant → single Grok bridge".
- SMS conversation threading per tenant (multi-line inbox UI). Outbound SMS uses the correct From; inbound SMS continues to hit the same handler.

**Polish pass (2026-04-23)**

A final review surfaced a few small refinements. All applied before final lock:

- [x] `server/db/migrations/003_phone_routing.sql` — re-confirmed: the backfill INSERT lists `is_primary, status` explicitly as `TRUE, 'active'` (line 59–69), and the follow-up UPDATE upgrades any pre-existing row whose `phone_number` matches the legacy denorm column to `is_primary = TRUE`. Running the migration against a database that already ran an earlier draft of 003 leaves the same invariant: every legacy `businesses.twilio_phone_number` has exactly one matching `business_phone_numbers` row flagged primary + active.
- [x] `server/config/database.js` + `server/middleware/tenant.js` — the `getBusinessByTwilioNumber` lookup order is now explicitly documented AND logged per branch as `PHONE_ROUTE source={business_phone_numbers | legacy_denorm | single_tenant_bootstrap}`. Each branch also stamps a non-enumerable `_phoneSource` property on the returned business row so route handlers can surface it without a second DB round-trip.
- [x] `server/routes/twilio.js` — the `/voice` and `/sms` entry logs now read `Incoming call from X to Y (SID: Z) — routed via business_phone_numbers` so ops can watch the Phase 5 cutover happen in production logs (`legacy_denorm` or `single_tenant_bootstrap` entries flag tenants that still need to be migrated).
- [x] `server/routes/twilio.js` — new `GET /twilio/_debug/phone-resolve?To=+1...` helper, gated on `DEBUG_PHONE_RESOLVE=1` so it never ships to production unless opted in. Returns `{ to, resolved, source, business }` as JSON so an operator can curl the server and verify which table a given DID resolves through without having to place a real call.
- [x] `command-center/src/App.jsx` — `PhoneNumbersManager` confirmation dialogs hardened. Every destructive / state-changing action now shows a multi-line confirm with the actual phone number + label: delete warns about losing audit trail (and flags "this is the PRIMARY" when applicable), disable explains the inbound routing implication, make-primary explains the demote + SMS From consequence, and re-enable is now also confirmed. Staff (read-only) still sees no buttons at all because of `canEdit`.
- [x] Static re-verify: `node --check` clean on every modified server file (`database.js`, `tenant.js`, `twilio.js`, `super-admin.js`, `api.js`, `notification.js`, `db/init.js`). `@babel/parser` parses the updated `command-center/src/App.jsx` (186.6 kB) end-to-end. Grep confirms the new `describePhone`, `_phoneSource`, `PHONE_ROUTE`, and `_debug/phone-resolve` identifiers landed where expected.

**Cutover note for ops:** with Phase 5 live, watch production logs for any line tagged `PHONE_ROUTE source=legacy_denorm` or `source=single_tenant_bootstrap`. Those are tenants whose DID still needs a row in `business_phone_numbers`. Once every inbound call reads `source=business_phone_numbers`, the single-tenant bootstrap fallback in `tenant.js` can be deleted in Phase 6.

**Phase 5 locked (2026-04-23).**

---

## Phase 6 — Tenant-scoped polish, audit logs & final cleanup

Audit trail + analytics layered on the multi-tenant backend, plus a final sweep to remove single-tenant assumptions the earlier phases intentionally left in place.

**Deliverables**

- `audit_log` table (migration 004) with polymorphic `user_id` + `user_type`, nullable `business_id` for platform events, denormalized `actor_email`, JSONB `meta`, and three indexes tuned for the super-admin reader (`(business_id, created_at DESC)`, `(action, created_at DESC)`, `(user_type, user_id, created_at DESC)`).
- `server/services/audit-log.js` — `logEvent`, `logEventFromReq`, `extractActor`, `listAuditEvents`, `truncateMeta`. Never throws into caller control flow; 16 KB meta payload cap; request-actor extraction (role, email, IP via `x-forwarded-for`, user-agent).
- Audit events wired into every meaningful mutation:
  - super-admin: `business.created`, `business.updated`, `invite.created` (three sources — onboarding_wizard, super_admin_invite, invite_admin_shortcut), `phone.added`, `phone.updated`, `phone.deleted`.
  - tenant-side: `setting.updated`, `greeting.created`, `greeting.deleted`, `phone.added`, `phone.updated`, `phone.deleted`.
  - auth: `user.login`, `invite.created` (via /auth/invite), `invite.accepted`.
- `GET /api/super/audit-log` with `business_id` / `action` / `limit` / `before` keyset pagination, returning `{ events, count, next_before_id }`.
- `GET /api/super/analytics` — one-shot CTE over `businesses`, `business_users`, `super_admins`, `business_phone_numbers`, `call_logs`, `booking_requests`, `user_invites`. Returns fleet totals (tenants by status, active/primary phones, calls today/30d/active-now/minutes-30d, bookings today/30d/pending, open invites).
- SuperAdminDashboard UI:
  - Platform metrics strip fed by `/api/super/analytics` (with graceful fallback to per-card sums if the endpoint fails).
  - Secondary metrics row (bookings today, pending bookings, business users, active phones).
  - Collapsible "Recent Activity" panel fed by `/api/super/audit-log?limit=10`.
- Final single-tenant sweep:
  - `package.json` name & description genericised (Valleymede noted as "first tenant" in description only).
  - `command-center/index.html` `<title>` no longer names Valleymede.
  - Login page header → "Command Center / AI Phone Platform".
  - Sidebar header now renders the active tenant's `name` (super-admin acting-as shows whose data they're in); falls back to generic.
  - Greeting placeholder copy is tenant-neutral.
  - Weather/teeon/notification Valleymede defaults retained **on purpose** (CLAUDE.md §1 — Valleymede never breaks) and documented in code comments as legacy fallbacks only.
- Docs refresh: `ARCHITECTURE.md` + `DEPLOY-STEP-BY-STEP.md` + `README.md` updated with multi-tenant notes and Phase 6 surface area.

**Acceptance criteria**

- Every audit-wired mutation lands a row in `audit_log` with the correct `business_id`, `user_type`, `actor_email`, and `action`. A super-admin impersonation through `X-Business-Id` shows `user_type='super_admin'` but tenant-scoped `business_id`.
- Audit failures never take down the originating request (verified by the `NEVER rethrow` try/catch in `logEvent`).
- `/api/super/audit-log` requires `requireSuperAdmin`; tenant tokens are 403'd by the router-level middleware (same gate as the rest of `/api/super/*`).
- `/api/super/analytics` returns numbers in under a second on the current fleet (single query, all aggregates in one round-trip).
- Valleymede still works — login, inbound call, booking, confirmation, command center all unchanged; the single-tenant bootstrap fallback in `tenant.js` is still in place (explicit DID registration still to happen at ops cutover).

**Out of scope for Phase 6** (intentionally deferred to Phase 7)

- Stripe billing, plan gating, usage-metered billing.
- Per-tenant rate limiting (happy path is audit visibility; rate limit lives at the reverse-proxy layer for now).
- Full "my users" CRUD for business_admins (invite flow is done; a listing/revoke UI is deferred).
- Custom domain / subdomain routing.

**Polish pass (post-wiring)**

- `user.login` does NOT emit audit rows for failed credentials (prevents a "does this email exist" oracle via the audit feed).
- `setting.updated` audit meta intentionally stores only the key — the value may contain SMS numbers / email / tokens that have no business being duplicated into an audit table.
- `greeting.created` stores a 120-char message preview rather than the full text.
- DELETE phone handlers snapshot the row before delete so the audit entry can record `phone_number` + `was_primary` even though the row is gone after the mutation.

**Phase 6 locked (2026-04-23).**

---

## Pre-Phase 7 — `personal_assistant` template (2026-04-23)

Interstitial vertical-expansion work completed before Phase 7 starts on
billing. Adds the first non-golf, non-hospitality template: a warm AI
receptionist for solo professionals and small-business owners who want
their calls screened and summarized without hiring staff.

**Deliverables shipped**

- `server/services/templates.js` — new `PERSONAL_ASSISTANT` template
  (👤). Seeds `owner_profile`, `schedule_preferences`,
  `important_contacts`, `call_handling_rules`, `post_call_sms`, and a
  friendly `ai_personality` with greetings tuned for a solo operator.
- `server/services/personal-assistant-prompt.js` — new sibling prompt
  builder that reads the settings above and produces a non-golf system
  prompt with sections for owner profile, schedule, VIPs, caller
  context, after-hours behavior, and tools. No hardcoded tenant
  content — fully settings-driven.
- `server/services/system-prompt.js` — dispatcher at the top of
  `buildSystemPrompt` that routes to the personal-assistant builder
  when `businesses.template_key = 'personal_assistant'`. Golf path
  unchanged.
- `server/services/notification.js` — new `sendPostCallSummary(businessId, details)`
  that formats and sends a concise SMS recap to the owner (gated on
  the `post_call_sms.enabled` setting). Falls back through
  `to_number` → `businesses.transfer_number` → `notifications.sms_to`.
- `server/services/grok-voice.js` — close-handler fires
  `sendPostCallSummary` (fire-and-forget) when the tenant's template
  is `personal_assistant`. Transcript, summary, duration, caller name,
  and start-time are all forwarded.
- `command-center/src/App.jsx` — sidebar and page router are now
  template-aware via `sidebarItemsFor()` + `tenantPagesFor()`. The
  personal-assistant nav is _Personal Assistant · Call History ·
  My Info · Settings_. New `PersonalAssistantPage` (landing) and
  `MyInfoPage` (owner-profile form) components. `/auth/verify` and
  `/auth/login` now persist `template_key` + `business_name` into the
  session so first render doesn't flicker.
- `server/routes/auth.js` — `/verify` and `/login` both echo
  `template_key` and `business_name` from the businesses row.

**Verification harness** (`/tmp/pa_harness.js`, 7/7 passing):

1. `templates.listTemplates()` exposes `personal_assistant` with the
   correct emoji and label.
2. `applyTemplate` seeds every expected settings key + ≥2 greetings.
3. `buildPersonalAssistantPrompt` contains the owner + assistant names
   and none of the golf terms (tee time / green fee / cart / etc.).
4. `buildSystemPrompt` routes to the PA builder when
   `template_key = 'personal_assistant'`.
5. `buildSystemPrompt` still serves the golf prompt for
   `template_key = 'golf_course'` (Valleymede safety net).
6. `sendPostCallSummary` produces the expected
   `[Acme Advisory] Alex called at 2:15pm — … Duration: 62s.` body
   and hits the configured owner number.
7. `sendPostCallSummary` short-circuits to `null` when the
   `post_call_sms.enabled` flag is false.

A separate Valleymede-shape sanity check confirms the golf prompt
still renders end-to-end after the dispatcher rewire (4/4 passing).

**Pre-Phase 7 locked (2026-04-23).**

### Polish pass (2026-04-23)

Four small refinements applied on top of the locked Pre-Phase 7 work, at
the user's request, before handing off to Phase 7:

1. **Prominent `assistant_name` plumbing in the prompt.**
   `buildPersonalAssistantPrompt` now reads the assistant's voice-facing
   name from `owner_profile.assistant_name` first, then legacy
   `ai_personality.name`, and finally defaults to `"Your Assistant"`.
   Comments in the prompt builder call this out as a customizable
   per-tenant field so future maintainers don't re-hardcode a name.

2. **Shorter, more natural post-call SMS.** `sendPostCallSummary` now
   emits a 2-line body at most: `"{Who} called at {time} — {summary}"`
   followed optionally by `"Left message: {preview}"`. No business tag,
   no duration suffix. The preview regex was also fixed so the `caller:`
   / `user:` speaker label is stripped before the text is included.

3. **Sidebar already clean.** Verified `sidebarItemsFor('personal_assistant')`
   returns exactly four items (👤 Personal Assistant, Call History,
   My Info, Settings) and that golf-specific pages are not registered in
   `tenantPagesFor('personal_assistant')`. No change needed.

4. **`assistant_name` pipeline end-to-end.**
   - Template default: `owner_profile` now seeds `assistant_name: ''` so
     the column exists on every new PA tenant.
   - Wizard UI: step 2 renders a labelled `Assistant name` text input
     (placeholder *"e.g. Sam, Alex, Robin…"*, 40-char cap) when
     `personal_assistant` is selected. Value is posted as `assistant_name`
     to `POST /api/super/businesses`.
   - Super-admin route: validates, trims, caps at 40 chars, and — only
     when the selected template is `personal_assistant` and the field is
     non-empty — merges it into `owner_profile` via
     `jsonb_set(..., '{assistant_name}', ...)` inside the creation
     transaction.
   - My Info page: renders a dedicated "Assistant name" callout at the
     top of the profile card so owners can edit it post-creation; the
     value round-trips through `PUT /api/settings/owner_profile`.

**Verification harness (`/tmp/pa_harness.js`) re-run: 11/11 passing.**
New assertions cover:

- Template seeds `owner_profile.assistant_name = ''` by default.
- Blank `assistant_name` falls back to `"Your Assistant"`.
- Custom `assistant_name` (`'Robin'`) overrides the default.
- SMS body has no `[Business]` tag, no `Duration:` suffix, at most 2
  lines, and the preview strips the `caller:` speaker label.
- Single-line SMS when the transcript / preview is empty.

Valleymede golf sanity check re-run: 1/1 passing. Golf prompt still
mentions tee times, course info, and pricing; no personal-assistant
copy leaks in.

**Polish pass locked (2026-04-23).**

---

## Phase 7 — Billing & plans (later)

Stripe integration, plans, usage metering (call minutes, bookings). Not in scope until Phase 6 is stable.

---

## Working agreement for each phase

1. Start of phase — re-read `CLAUDE.md` and this file.
2. Implement in small, reviewable steps.
3. End of phase — run the Valleymede smoke test + cross-tenant negative test.
4. Update this file's status line and tick the deliverables.
5. Stop and wait for review before starting the next phase.
