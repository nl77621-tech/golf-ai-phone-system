/**
 * Super Admin routes (Phase 3).
 *
 * All endpoints mounted under `/api/super`. Every route here is gated by
 * `requireAuth` + `requireSuperAdmin`. Regular tenant users cannot reach
 * these URLs — a 403 is returned by the middleware.
 *
 *   GET    /api/super/businesses          — list every tenant
 *   POST   /api/super/businesses          — create a new tenant (+ phone
 *                                           number + admin invite) in one shot
 *   GET    /api/super/businesses/:id      — full tenant record
 *   PATCH  /api/super/businesses/:id      — flip status / plan / branding
 *   POST   /api/super/businesses/:id/invite-admin
 *                                         — shortcut: create a
 *                                           business_admin invite for this tenant
 *
 * Cross-tenant writes go through these routes ONLY. The regular `/api/*`
 * router is not reachable for super-admin tokens unless the UI opts into
 * the business-switcher flow (see `/api` router — `X-Business-Id` header).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendSMS } = require('../services/notification');
const { normalizeToE164 } = require('../services/caller-lookup');
const router = express.Router();

const { requireAuth, requireSuperAdmin, createInvite } = require('../middleware/auth');
const {
  SUPER_ADMIN_ROLE,
  BUSINESS_ADMIN_ROLE,
  STAFF_ROLE
} = require('../context/tenant-context');
const {
  pool,
  query,
  getBusinessById,
  listBusinessPhoneNumbers,
  addBusinessPhoneNumber,
  updateBusinessPhoneNumber,
  deleteBusinessPhoneNumber
} = require('../config/database');
const {
  listTemplates,
  getTemplate,
  applyTemplate,
  DEFAULT_TEMPLATE_KEY
} = require('../services/templates');
const {
  listTiers: listVoiceTiers,
  allowedTiersForPlan,
  isTierAllowedOnPlan,
  getTier: getVoiceTier,
  DEFAULT_TIER: DEFAULT_VOICE_TIER,
  PLAN_TIER_ACCESS,
  listKnownVoices,
  resolveVoiceConfigFromSettings
} = require('../services/voice-tiers');
const { logEventFromReq, listAuditEvents } = require('../services/audit-log');
const {
  grantTrial,
  adminAdjust,
  getBalance,
  listLedger,
  TRIAL_SECONDS,
  TRIAL_DAYS
} = require('../services/credits');

// All /api/super/* routes require a super-admin JWT.
router.use(requireAuth);
router.use(requireSuperAdmin);

// -------------- helpers --------------

// Minimal slug sanitizer — lowercase, hyphen-separated, a-z/0-9 only.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Build the /accept-invite URL the UI will hand to the admin we invite.
function buildInviteUrl(req, token) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/accept-invite?token=${encodeURIComponent(token)}`;
}

// Seed a new tenant with sensible defaults for every key the Command
// Center reads. Everything lives inside `settings(business_id, key)`.
// Values are tuned so an empty tenant doesn't show up with undefined
// fields on the dashboard; ops will override them via the UI.
const DEFAULT_SETTINGS = [
  ['business_hours', {
    monday: { open: '08:00', close: '18:00' },
    tuesday: { open: '08:00', close: '18:00' },
    wednesday: { open: '08:00', close: '18:00' },
    thursday: { open: '08:00', close: '18:00' },
    friday: { open: '08:00', close: '18:00' },
    saturday: { open: '08:00', close: '18:00' },
    sunday: { open: '08:00', close: '18:00' }
  }, 'Daily open/close times'],
  ['pricing', {}, 'Green fees and cart pricing'],
  ['course_info', {}, 'General course information'],
  ['policies', {}, 'Course policies and rules'],
  ['memberships', {}, 'Membership information'],
  ['tournaments', {}, 'Tournament and group outing info'],
  ['amenities', {}, 'Facilities and amenities'],
  ['notifications', {
    email_enabled: true,
    sms_enabled: true,
    email_to: null,
    sms_to: null
  }, 'How to notify staff of new bookings'],
  ['ai_personality', {
    name: 'AI Assistant',
    style: 'Friendly, warm, natural. Conversational, not robotic.',
    language: 'English primary. Switch if caller requests another language.',
    weather_behavior: 'Only provide weather if asked.',
    booking_limit: 8,
    after_hours_message: "Our staff isn't available right now, but I can help you with bookings or course info."
  }, 'AI voice agent personality and behavior settings'],
  ['announcements', [], 'Active announcements the AI should mention'],
  ['test_mode', { enabled: false, test_phone: '' }, 'Test phone number configuration'],
  ['booking_settings', { require_credit_card: false }, 'Booking behavior settings']
];

const DEFAULT_GREETINGS = [
  ['Hi there! Thanks for calling. How can I help you today?', false],
  ['Hello! Thanks for getting in touch. What can I do for you?', false],
  ['Hi {name}! Good to hear from you again. What can I help with?', true]
];

async function seedTenantDefaults(client, businessId) {
  for (const [key, value, description] of DEFAULT_SETTINGS) {
    await client.query(
      `INSERT INTO settings (business_id, key, value, description)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (business_id, key) DO NOTHING`,
      [businessId, key, JSON.stringify(value), description]
    );
  }
  for (const [msg, forKnown] of DEFAULT_GREETINGS) {
    await client.query(
      `INSERT INTO greetings (business_id, message, for_known_caller, active)
       VALUES ($1, $2, $3, TRUE)`,
      [businessId, msg, forKnown]
    );
  }
}

// -------------- GET /api/super/businesses --------------
// `?include_deleted=1` flips the filter so the UI can show soft-deleted
// tenants in a "Deleted" tab. Default hides them.
router.get('/businesses', async (req, res) => {
  try {
    const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
    const deletedClause = includeDeleted ? '' : 'WHERE b.deleted_at IS NULL';
    const { rows } = await query(
      `SELECT b.id, b.slug, b.name, b.twilio_phone_number, b.transfer_number,
              b.timezone, b.status, b.is_active, b.plan, b.setup_complete,
              b.template_key, b.primary_color,
              b.credit_seconds_remaining, b.trial_granted_at, b.trial_expires_at,
              b.deleted_at, b.deleted_by_user_id,
              b.created_at, b.updated_at, b.contact_email, b.contact_phone,
              (SELECT COUNT(*)::int FROM business_users bu
                 WHERE bu.business_id = b.id AND bu.active = TRUE) AS active_user_count,
              (SELECT COUNT(*)::int FROM call_logs cl
                 WHERE cl.business_id = b.id
                   AND cl.started_at > NOW() - INTERVAL '30 days') AS calls_last_30d,
              (SELECT COUNT(*)::int FROM booking_requests br
                 WHERE br.business_id = b.id
                   AND br.created_at > NOW() - INTERVAL '30 days') AS bookings_last_30d
         FROM businesses b
         ${deletedClause}
        ORDER BY b.id ASC`
    );
    res.json({ businesses: rows, count: rows.length, include_deleted: includeDeleted });
  } catch (err) {
    console.error('[super] list businesses error:', err.message);
    res.status(500).json({ error: 'Failed to list businesses' });
  }
});

// -------------- GET /api/super/businesses/:id --------------
//
// Returns everything the Edit Tenant screen needs to pre-fill the wizard:
// the business row, users, phone numbers, and the settings map keyed by
// setting key. `?include_deleted=1` allows looking up soft-deleted
// tenants so the UI can present them on the Restore flow.
router.get('/businesses/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
    const biz = await getBusinessById(id, { includeDeleted });
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const [usersRes, phonesRes, settingsRes] = await Promise.all([
      query(
        `SELECT id, email, name, role, active, created_at, last_login_at
           FROM business_users
          WHERE business_id = $1
          ORDER BY id ASC`,
        [id]
      ),
      query(
        `SELECT id, phone_number, label, is_primary, status, created_at, updated_at
           FROM business_phone_numbers
          WHERE business_id = $1
          ORDER BY is_primary DESC, status ASC, id ASC`,
        [id]
      ),
      query(
        `SELECT key, value, description, updated_at
           FROM settings
          WHERE business_id = $1
          ORDER BY key ASC`,
        [id]
      )
    ]);

    // Reshape settings rows into a map for easy UI prefill.
    const settings = {};
    for (const row of settingsRes.rows) {
      settings[row.key] = row.value;
    }

    res.json({
      business: biz,
      users: usersRes.rows,
      phone_numbers: phonesRes.rows,
      settings
    });
  } catch (err) {
    console.error('[super] get business error:', err.message);
    res.status(500).json({ error: 'Failed to load business' });
  }
});

// -------------- POST /api/super/businesses --------------
//
// Provisions a complete tenant in one shot. This is the endpoint the
// onboarding wizard calls on the final "create" step.
//
// Body:
//   {
//     name:                 'Acme Golf' *required,
//     slug:                 'acme-golf'                (optional),
//     timezone:             'America/Toronto'          (optional),
//     contact_email:        '…',
//     contact_phone:        '…',
//     plan:                 'starter'                  (default: 'free'),
//     primary_color:        '#2E7D32'                  (optional),
//     logo_url:             'https://…'                (optional),
//
//     // Phone numbers — at least `twilio_phone_number` is recommended so
//     // inbound calls resolve to this tenant. `phone_numbers` lets ops add
//     // additional DIDs in one shot (second line, SMS-only, etc.)
//     twilio_phone_number:  '+1…'                      (optional),
//     transfer_number:      '+1…'                      (optional),
//     phone_numbers:        [{ phone_number, label }]  (optional),
//
//     // Template — used to seed settings + greetings for the vertical.
//     // If omitted, we fall back to the baseline defaults.
//     template_key:         'golf_course' | 'driving_range' | 'restaurant' | 'other',
//
//     // First admin invite — optional. If provided, we create an invite row
//     // in the same request and return its URL so the wizard can show it.
//     admin_email:          'owner@acme.com'
//   }
//
// On success (201): { business, invite, phone_numbers, template }
router.post('/businesses', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const name = String(b.name).trim();
  const slug = slugify(b.slug || name);
  if (!slug) return res.status(400).json({ error: 'slug could not be derived from name' });

  const templateKey = (b.template_key || DEFAULT_TEMPLATE_KEY).toString();
  const template = getTemplate(templateKey);
  if (!template) {
    return res.status(400).json({ error: `Unknown template '${templateKey}'` });
  }

  const timezone = b.timezone || template.meta.default_timezone || 'America/Toronto';
  const plan = b.plan || template.meta.recommended_plan || 'free';
  const twilioNumber = b.twilio_phone_number?.trim() || null;
  const transferNumber = b.transfer_number?.trim() || null;
  const contactEmail = b.contact_email?.trim() || null;
  const contactPhone = b.contact_phone?.trim() || null;
  const primaryColor = b.primary_color?.trim() || null;
  const logoUrl = b.logo_url?.trim() || null;
  const adminEmail = b.admin_email?.trim().toLowerCase() || null;

  // Optional per-template one-off fields. For now only personal_assistant
  // exposes a wizard-customizable field (the assistant's voice-facing name);
  // add new entries here as other verticals grow their own onboarding
  // prompts. Trim + length-cap so a rogue wizard payload can't blow out the
  // JSONB column or the prompt.
  const assistantName = typeof b.assistant_name === 'string'
    ? b.assistant_name.trim().slice(0, 40)
    : '';

  // Voice tier — per-tenant (model, voice, speed) choice. This entire
  // router is behind `requireSuperAdmin`, so plan-vs-tier gating here would
  // only be checking the super-admin's choices against themselves — not a
  // real authorisation boundary. The operator deliberately picking a
  // premium voice for a starter-plan tenant is a legitimate provisioning
  // action, so we only enforce the catalog check (unknown tier = 400).
  // When self-serve ships, a customer-facing route will need its own
  // plan-vs-tier check via isTierAllowedOnPlan; that helper stays exported
  // from voice-tiers.js for exactly that purpose.
  const rawVoiceTier = typeof b.voice_tier === 'string' ? b.voice_tier.trim().toLowerCase() : '';
  const voiceTier = rawVoiceTier || DEFAULT_VOICE_TIER;
  if (!getVoiceTier(voiceTier)) {
    return res.status(400).json({ error: `Unknown voice tier '${voiceTier}'` });
  }

  // Normalise optional `phone_numbers` array. We always dedupe against the
  // primary Twilio number so the caller can't accidentally register the same
  // DID twice.
  const rawPhoneNumbers = Array.isArray(b.phone_numbers) ? b.phone_numbers : [];
  const extraPhoneNumbers = rawPhoneNumbers
    .map(p => ({
      phone_number: String(p?.phone_number || '').trim(),
      label: String(p?.label || 'Additional Line').trim().slice(0, 40) || 'Additional Line'
    }))
    .filter(p => p.phone_number && p.phone_number !== twilioNumber);

  // --- Pre-flight: reclaim identifiers from soft-deleted tenants ---
  //
  // The DELETE handler learned to rename/clear these on soft-delete, but
  // tenants deleted BEFORE that patch still hoard their slug + phone
  // numbers in the globally-unique indexes. Without this block, the
  // INSERT below 23505s and the operator would need to hit the
  // reclaim-orphaned endpoint manually. We do the same reclaim inline,
  // scoped only to the exact identifiers this request is trying to use —
  // we never touch a deleted tenant whose identifier isn't being reclaimed
  // by this request, so ops visibility of "deleted but not reclaimed" rows
  // is preserved.
  //
  // Each reclaim is its own audit event with `source: 'wizard-preflight'`
  // so it's distinguishable from the batch reclaim-orphaned endpoint.
  const preflightReclaim = async () => {
    // 1. Slug — if a soft-deleted tenant has this exact slug, rename theirs
    //    to `deleted-<id>` so the INSERT below can claim the original.
    const slugCollision = await query(
      `SELECT id, slug, name FROM businesses
        WHERE slug = $1 AND deleted_at IS NOT NULL
        LIMIT 1`,
      [slug]
    );
    if (slugCollision.rows.length > 0) {
      const r = slugCollision.rows[0];
      await query(
        `UPDATE businesses
            SET slug = $1, updated_at = NOW()
          WHERE id = $2 AND deleted_at IS NOT NULL`,
        [`deleted-${r.id}`, r.id]
      );
      await logEventFromReq(req, {
        businessId: r.id,
        action: 'phone_numbers.reclaimed_orphaned',
        targetType: 'business',
        targetId: r.id,
        meta: {
          slug: r.slug,
          name: r.name,
          released_slug: r.slug,
          source: 'wizard-preflight'
        }
      });
      console.log(`[super] Pre-flight: released slug "${r.slug}" from deleted tenant ${r.id} for new tenant creation`);
    }

    // 2. Phone numbers — same story for primary + extra numbers. Gather the
    //    set of DIDs this request wants, then release any attached to a
    //    soft-deleted tenant.
    const wantedNumbers = new Set();
    if (twilioNumber) wantedNumbers.add(twilioNumber);
    for (const p of extraPhoneNumbers) wantedNumbers.add(p.phone_number);
    if (wantedNumbers.size > 0) {
      const numberArr = Array.from(wantedNumbers);
      // 2a. business_phone_numbers rows pointing at deleted tenants.
      const rowCollisions = await query(
        `SELECT bpn.id            AS row_id,
                bpn.business_id   AS business_id,
                bpn.phone_number  AS phone_number,
                bpn.label         AS label,
                bpn.is_primary    AS is_primary,
                b.slug            AS slug,
                b.name            AS name
           FROM business_phone_numbers bpn
           JOIN businesses b ON b.id = bpn.business_id
          WHERE b.deleted_at IS NOT NULL
            AND bpn.phone_number = ANY($1::text[])`,
        [numberArr]
      );
      // 2b. Denormalized businesses.twilio_phone_number.
      const denormCollisions = await query(
        `SELECT id, slug, name, twilio_phone_number
           FROM businesses
          WHERE deleted_at IS NOT NULL
            AND twilio_phone_number = ANY($1::text[])`,
        [numberArr]
      );

      if (rowCollisions.rows.length > 0) {
        await query(
          `DELETE FROM business_phone_numbers
            WHERE id = ANY($1::int[])`,
          [rowCollisions.rows.map(r => r.row_id)]
        );
      }
      if (denormCollisions.rows.length > 0) {
        await query(
          `UPDATE businesses
              SET twilio_phone_number = NULL, updated_at = NOW()
            WHERE id = ANY($1::int[])
              AND deleted_at IS NOT NULL`,
          [denormCollisions.rows.map(r => r.id)]
        );
      }

      // Group reclaimed numbers per deleted tenant for the audit event.
      const byBiz = new Map();
      const ensure = (id, slug, name) => {
        if (!byBiz.has(id)) byBiz.set(id, { slug, name, numbers: [] });
        return byBiz.get(id);
      };
      for (const r of rowCollisions.rows) {
        ensure(r.business_id, r.slug, r.name).numbers.push({
          phone_number: r.phone_number, label: r.label, is_primary: r.is_primary
        });
      }
      for (const r of denormCollisions.rows) {
        const entry = ensure(r.id, r.slug, r.name);
        if (!entry.numbers.some(n => n.phone_number === r.twilio_phone_number)) {
          entry.numbers.push({
            phone_number: r.twilio_phone_number,
            label: 'Main Line (denormalized on businesses row)',
            is_primary: true
          });
        }
      }
      for (const [businessId, info] of byBiz.entries()) {
        await logEventFromReq(req, {
          businessId,
          action: 'phone_numbers.reclaimed_orphaned',
          targetType: 'business',
          targetId: businessId,
          meta: {
            slug: info.slug,
            name: info.name,
            reclaimed_numbers: info.numbers,
            source: 'wizard-preflight'
          }
        });
        console.log(
          `[super] Pre-flight: released ${info.numbers.length} phone number(s) from deleted tenant ${businessId} (${info.slug})`
        );
      }
    }
  };
  try {
    await preflightReclaim();
  } catch (preflightErr) {
    // Non-fatal — if the reclaim fails the INSERT below will 23505 and the
    // targeted-error-UX handler will still tell the operator what collided.
    // We'd rather attempt creation than block on a pre-flight hiccup.
    console.warn('[super] preflight reclaim failed, proceeding to INSERT anyway:', preflightErr.message);
  }

  const client = await pool.connect();
  let createdBusinessId = null;
  let inviteRow = null;
  let templateSummary = null;
  let phoneRows = [];
  let trialGrant = null;

  try {
    await client.query('BEGIN');

    // 1. Insert the tenant row. template_key is persisted so downstream
    //    code (sidebar/page-map branching, system-prompt dispatcher) can
    //    read it from the business row without replaying the wizard.
    const ins = await client.query(
      `INSERT INTO businesses
         (slug, name, twilio_phone_number, transfer_number, timezone,
          contact_email, contact_phone, status, is_active, plan,
          primary_color, logo_url, created_by, setup_complete, template_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'trial', TRUE, $8, $9, $10, $11, FALSE, $12)
       RETURNING *`,
      [slug, name, twilioNumber, transferNumber, timezone, contactEmail,
       contactPhone, plan, primaryColor, logoUrl, req.auth.user_id, template.key]
    );
    const business = ins.rows[0];
    createdBusinessId = business.id;

    // 2. Baseline seed FIRST (every key with safe defaults), then template
    //    overrides on top. This way even if a template omits a rarely-used
    //    key, it still exists on the new tenant.
    await seedTenantDefaults(client, business.id);
    templateSummary = await applyTemplate(client, business.id, template.key);

    // 2b. Per-template wizard overrides. The wizard surfaces a tiny number
    //     of fields (today: just assistant_name for personal_assistant) so
    //     the owner can customise them at creation time without jumping
    //     straight into the settings UI. We merge into the existing JSONB
    //     rather than overwriting so any other owner_profile defaults
    //     seeded by applyTemplate are preserved.
    if (template.key === 'personal_assistant' && assistantName) {
      await client.query(
        `UPDATE settings
            SET value = jsonb_set(
                   COALESCE(value, '{}'::jsonb),
                   '{assistant_name}',
                   to_jsonb($1::text),
                   true
                 ),
                updated_at = NOW()
          WHERE business_id = $2 AND key = 'owner_profile'`,
        [assistantName, business.id]
      );
    }

    // 2b2. Persist the wizard's voice-tier choice. applyTemplate seeded
    //      `voice_config = { tier: 'standard' }` already; we overwrite it
    //      with the caller-selected tier (already validated above). grok-voice.js
    //      reads this row on every new call via resolveVoiceConfigFromSettings.
    await client.query(
      `INSERT INTO settings (business_id, key, value, description)
       VALUES ($1, 'voice_config', $2::jsonb,
               'Voice tier — economy | standard | premium')
       ON CONFLICT (business_id, key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = NOW()`,
      [business.id, JSON.stringify({ tier: voiceTier })]
    );

    // 2c. Phase 7a — free trial grant. Every new tenant starts with
    //     TRIAL_SECONDS (1h) of credit + a TRIAL_DAYS (14d) wall-clock
    //     expiry, whichever runs out first. Legacy tenants aren't eligible
    //     (they should be created with plan='legacy' up front), but the
    //     guard is belt-and-braces because a mis-configured onboarding
    //     shouldn't spill a trial grant onto a legacy tenant either.
    //     grantTrial runs inside our transaction (we hand it the client)
    //     so a commit failure rolls the trial grant back along with the
    //     rest of the creation.
    if (business.plan !== 'legacy') {
      try {
        trialGrant = await grantTrial(business.id, { client });
      } catch (err) {
        // Non-fatal — if the trial grant fails we still want the tenant
        // record to land. Ops can run a manual adminAdjust afterwards.
        console.warn(`[super] business ${business.id} created but trial grant failed: ${err.message}`);
        trialGrant = { granted: false, error: err.message };
      }
    }

    // 3. Register phone numbers. Primary first (if supplied), then extras.
    if (twilioNumber) {
      await client.query(
        `INSERT INTO business_phone_numbers (business_id, phone_number, label, is_primary)
         VALUES ($1, $2, 'Main Line', TRUE)
         ON CONFLICT (phone_number) DO NOTHING`,
        [business.id, twilioNumber]
      );
    }
    for (const p of extraPhoneNumbers) {
      await client.query(
        `INSERT INTO business_phone_numbers (business_id, phone_number, label, is_primary)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT (phone_number) DO NOTHING`,
        [business.id, p.phone_number, p.label]
      );
    }
    const phoneLookup = await client.query(
      `SELECT id, phone_number, label, is_primary
         FROM business_phone_numbers
        WHERE business_id = $1
        ORDER BY is_primary DESC, id ASC`,
      [business.id]
    );
    phoneRows = phoneLookup.rows;

    await client.query('COMMIT');

    // 4. Optionally create the first admin invite (outside the tx so the
    //    invite row remains useful even if email delivery later fails).
    if (adminEmail) {
      try {
        inviteRow = await createInvite({
          businessId: business.id,
          email: adminEmail,
          role: BUSINESS_ADMIN_ROLE,
          inviter: { super_admin_id: req.auth.user_id }
        });
      } catch (err) {
        console.warn(`[super] business ${business.id} created but invite failed:`, err.message);
      }
    }

    const payload = {
      business,
      template: templateSummary,
      phone_numbers: phoneRows,
      invite: inviteRow
        ? {
            id: inviteRow.id,
            email: inviteRow.email,
            role: inviteRow.role,
            expires_at: inviteRow.expires_at,
            token: inviteRow.token,
            invite_url: buildInviteUrl(req, inviteRow.token)
          }
        : null,
      trial: trialGrant
        ? {
            granted: !!trialGrant.granted,
            seconds: trialGrant.granted ? (trialGrant.balanceAfter || TRIAL_SECONDS) : 0,
            expires_at: trialGrant.trialExpiresAt || null
          }
        : null,
      voice: { tier: voiceTier }
    };
    console.log(
      `[super] Created business ${business.id} (${slug}) name="${name}" ` +
      `template=${templateSummary?.template_key} phones=${phoneRows.length} voice_tier=${voiceTier}`
    );
    // Audit — one event per created resource so the feed is useful at a glance.
    await logEventFromReq(req, {
      businessId: business.id,
      action: 'business.created',
      targetType: 'business',
      targetId: business.id,
      meta: {
        slug,
        name,
        plan,
        status: business.status,
        template_key: templateSummary?.template_key,
        phones: phoneRows.length,
        invite_created: !!inviteRow,
        invite_email: inviteRow ? inviteRow.email : null,
        trial_granted: !!(trialGrant && trialGrant.granted),
        trial_expires_at: trialGrant && trialGrant.trialExpiresAt ? trialGrant.trialExpiresAt : null,
        voice_tier: voiceTier
      }
    });
    if (inviteRow) {
      await logEventFromReq(req, {
        businessId: business.id,
        action: 'invite.created',
        targetType: 'invite',
        targetId: inviteRow.id,
        meta: {
          email: inviteRow.email,
          role: inviteRow.role,
          expires_at: inviteRow.expires_at,
          source: 'onboarding_wizard'
        }
      });
    }
    res.status(201).json(payload);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[super] create business error:', err.message);
    if (err.code === '23505') {
      // Unique violation. Parse err.detail / err.constraint to tell the
      // operator exactly which field collided — the generic "slug or one of
      // the phone numbers is already in use" message leaves them with no
      // idea where to go back and fix. err.detail from pg looks like:
      //   "Key (slug)=(nelson-lopes-12) already exists."
      //   "Key (phone_number)=(+12893011452) already exists."
      const detail = typeof err.detail === 'string' ? err.detail : '';
      const match = detail.match(/Key \(([^)]+)\)=\(([^)]+)\)/);
      const col = match?.[1];
      const value = match?.[2];

      let friendly = 'Slug or one of the phone numbers is already in use.';
      let field = null;
      let step = null;
      if (col === 'slug') {
        friendly = `The slug "${value}" is already taken by another tenant. Go back to step 1 and pick a different one.`;
        field = 'slug';
        step = 0;
      } else if (col === 'phone_number' || err.constraint === 'business_phone_numbers_phone_number_key' ||
                 err.constraint === 'businesses_twilio_phone_number_key' || col === 'twilio_phone_number') {
        friendly = value
          ? `The phone number "${value}" is already assigned to another tenant. Go back to step 2 and remove it (or leave it blank and assign it later from the business card).`
          : 'One of the phone numbers is already assigned to another tenant. Go back to step 2 and change it.';
        field = 'phone_number';
        step = 1;
      } else if (col) {
        friendly = `The value "${value}" collides with an existing tenant on column "${col}".`;
      }

      return res.status(409).json({
        error: friendly,
        field,
        step,
        constraint: err.constraint || null,
        detail: detail || null
      });
    }
    res.status(500).json({ error: err.message || 'Failed to create business' });
  } finally {
    client.release();
  }
});

// -------------- PATCH /api/super/businesses/:id --------------
//
// Full tenant edit. Body shape:
//   {
//     // --- Business columns (optional, only supplied keys are updated)
//     name, slug, twilio_phone_number, transfer_number, timezone,
//     contact_email, contact_phone, status, is_active, plan,
//     primary_color, logo_url, internal_notes, setup_complete,
//     billing_notes,
//
//     // --- Per-tenant settings map (optional)
//     // { owner_profile: {...}, ai_personality: {...}, voice: {...}, ... }
//     // Each entry upserts into settings(business_id, key) with value
//     // replaced wholesale. Passing a NULL-ish value for a key is ignored
//     // (use POST /api/settings/:key with DELETE semantics if we ever
//     // add one; for now there's no way to remove a settings row from
//     // this endpoint — intentional, avoids wiping everything on a typo).
//     settings: { key1: {...}, key2: {...} }
//   }
//
// Safety rails:
//   * `template_key` is intentionally NOT editable. Switching vertical
//     post-creation would require re-running applyTemplate, which would
//     overwrite per-tenant customisation. If someone wants a different
//     vertical, delete the tenant and create a new one.
//   * Soft-deleted tenants cannot be edited — restore them first.
router.patch('/businesses/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }

  // Block edits on soft-deleted tenants. The UI should surface "Restore
  // to edit" instead; editing a deleted row would silently resurrect it
  // via the updated_at write, which is surprising behaviour.
  const existing = await getBusinessById(id, { includeDeleted: true });
  if (!existing) return res.status(404).json({ error: 'Business not found' });
  if (existing.deleted_at) {
    return res.status(409).json({ error: 'Business is soft-deleted — restore before editing' });
  }

  // Editable business columns. template_key is editable so a super-admin
  // can convert a tenant from one vertical to another (e.g. switch a
  // mis-onboarded golf_course tenant to personal_assistant) without
  // recreating the row. We DON'T re-apply the new template's settings
  // defaults here — that's intentionally a separate operation, since
  // applying a template wholesale could clobber settings the tenant has
  // already customised. The Edit modal makes that clear.
  const allowed = [
    'name', 'slug', 'twilio_phone_number', 'transfer_number', 'timezone',
    'contact_email', 'contact_phone', 'status', 'is_active', 'plan',
    'primary_color', 'logo_url', 'internal_notes', 'setup_complete',
    'billing_notes', 'template_key'
  ];
  const body = req.body || {};
  const patches = {};
  for (const k of allowed) {
    if (k in body) patches[k] = body[k];
  }

  // Validate template_key against the registry. Reject unknown keys so a
  // typo can't push a tenant into the null-fallback golf path silently.
  // Valleymede (id=1) is doubly-protected: we refuse to flip its template
  // away from golf_course because the legacy plan check would still force
  // golf, and the mismatch would just confuse forensics.
  if ('template_key' in patches) {
    const newKey = patches.template_key;
    if (typeof newKey !== 'string' || !getTemplate(newKey)) {
      return res.status(400).json({ error: `Unknown template_key '${newKey}'` });
    }
    if (id === 1 && newKey !== 'golf_course') {
      return res.status(403).json({
        error: 'Tenant id=1 (Valleymede) is locked to template_key=golf_course'
      });
    }
  }

  // ── plan='legacy' lock ─────────────────────────────────────────────────
  // The audit reviewer flagged this exact path: today's Valleymede outage
  // was caused by an old (pre-dirty-check) Edit modal silently re-saving
  // plan='pro' over plan='legacy'. The legacy plan is the safety lock for
  // the platform's grandfather tenant — once a row is set to legacy, the
  // credit gate, sidebar branching, and several other paths short-circuit
  // for it. Letting the PATCH handler change it away from legacy means
  // any future modal bug, stale client, or curl typo can re-trigger the
  // same outage. Belt-and-braces refusal at the API layer.
  //
  // Going INTO legacy via PATCH is also blocked — legacy is reserved for
  // id=1 and shouldn't be applied to other tenants by accident. Any
  // intentional grant of legacy on a new tenant should be a deliberate
  // SQL UPDATE by ops, not a routine PATCH.
  if ('plan' in patches) {
    const newPlan = patches.plan;
    if (existing.plan === 'legacy' && newPlan !== 'legacy') {
      return res.status(403).json({
        error: `Tenant ${id} is on the 'legacy' plan and cannot be moved off it via the API. The legacy plan is the platform's grandfather safety lock; if you need to change it, do so via direct SQL with full awareness of the consequences.`,
        field: 'plan'
      });
    }
    if (newPlan === 'legacy' && existing.plan !== 'legacy') {
      return res.status(403).json({
        error: `'legacy' plan cannot be applied via the API. It's reserved for the platform's grandfather tenant (id=1).`,
        field: 'plan'
      });
    }
  }

  // Settings map. Every entry upserts into settings(business_id, key).
  // The audit reviewer flagged that this used to filter only by string
  // length — meaning any super-admin error or stale modal could write
  // arbitrary garbage keys (or wrong shapes for known keys) into the
  // settings table. We now allow-list the known keys actually consumed
  // by services/system-prompt.js, services/grok-voice.js, and the
  // various tenant Settings UIs. New keys must be added here AND in the
  // consuming code, which is the right friction for a multi-tenant SaaS.
  const ALLOWED_SETTING_KEYS = new Set([
    // Voice + AI behavior
    'voice_config', 'ai_personality', 'custom_prompt',
    // Notifications + delivery
    'notifications', 'post_call_sms', 'transfer_number', 'test_mode',
    // Golf-specific (used by buildSystemPrompt)
    'course_info', 'pricing', 'business_hours', 'policies', 'memberships',
    'tournaments', 'amenities', 'announcements', 'daily_instructions',
    'general_knowledge', 'faq', 'seasonal_notes', 'booking_settings',
    'greetings', 'teeon',
    // Personal-assistant template specifics
    'owner_profile', 'schedule_preferences', 'important_contacts',
    'call_handling_rules',
    // Restaurant template specifics
    'restaurant_info', 'menu', 'reservation_policy',
    // Operator-defined intents — array of { name, trigger_hint,
    // ai_instructions, notify_sms, notify_email, enabled }. The AI
    // matches incoming questions against trigger_hint and routes
    // matching calls to a take_topic_message flow. Used for ad-hoc
    // scenarios the wizard templates don't cover (e.g. lost & found,
    // catering inquiries, league sign-ups).
    'custom_topics',
    // Tenant-saved quick-fill chips for the Daily Instructions panel.
    // Plain array of short strings the operator can click to populate
    // today's message. Storage-only — the AI doesn't read these
    // directly; they're a convenience for the human in the dashboard.
    'daily_instruction_quickfills',
    // Local Tee Sheet grid display config — { start_hour, start_min,
    // end_hour, end_min, interval_min }. Persists the operator's
    // chosen Start / End / Interval so the same grid layout shows
    // every day. Read-only with respect to Tee-On's actual slot data.
    'tee_sheet_config',
    // Free-form policy text the AI consults when callers ask about
    // 9-hole availability / twilight rates. Example:
    //   "9-hole back-nine runs during twilight only. May–Sept after
    //    4 PM, Oct 1+ after 3 PM. Mornings are 18-hole only."
    // Used to ANSWER "do you offer 9 holes?" naturally — the live
    // tee sheet from Tee-On still controls which slots can actually
    // be booked.
    'nine_hole_policy'
  ]);
  const settingsMap =
    body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
      ? body.settings
      : null;
  const requestedKeys = settingsMap
    ? Object.keys(settingsMap).filter(k => typeof k === 'string' && k.length > 0 && k.length <= 100)
    : [];
  const rejectedKeys = requestedKeys.filter(k => !ALLOWED_SETTING_KEYS.has(k));
  const settingKeys = requestedKeys.filter(k => ALLOWED_SETTING_KEYS.has(k));
  if (rejectedKeys.length > 0) {
    return res.status(400).json({
      error: `Unknown settings key(s): ${rejectedKeys.join(', ')}. Allowed keys are managed in routes/super-admin.js. Add the key there + in the consumer if you need a new one.`,
      rejected_keys: rejectedKeys
    });
  }

  if (Object.keys(patches).length === 0 && settingKeys.length === 0) {
    return res.status(400).json({ error: 'no recognised fields to update' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let updatedBusiness = existing;
    if (Object.keys(patches).length > 0) {
      const sets = [];
      const params = [];
      Object.entries(patches).forEach(([k, v], i) => {
        sets.push(`${k} = $${i + 1}`);
        params.push(v);
      });
      params.push(id);
      const sql = `UPDATE businesses SET ${sets.join(', ')}, updated_at = NOW()
                    WHERE id = $${params.length}
                      AND deleted_at IS NULL
                RETURNING *`;
      const { rows } = await client.query(sql, params);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Business not found or was deleted concurrently' });
      }
      updatedBusiness = rows[0];
    }

    // Settings upsert — per-key, wholesale value replace. We don't try
    // to deep-merge: the UI always sends the full object for a key, so
    // partial shape drift is impossible.
    for (const key of settingKeys) {
      const value = settingsMap[key];
      await client.query(
        `INSERT INTO settings (business_id, key, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (business_id, key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = NOW()`,
        [id, key, JSON.stringify(value)]
      );
    }

    await client.query('COMMIT');

    console.log(
      `[super] Updated business ${id}: cols=[${Object.keys(patches).join(',')}] ` +
      `settings=[${settingKeys.join(',')}]`
    );
    await logEventFromReq(req, {
      businessId: id,
      action: 'business.updated',
      targetType: 'business',
      targetId: id,
      meta: {
        fields: Object.keys(patches),
        setting_keys: settingKeys,
        patches
      }
    });
    res.json({
      business: updatedBusiness,
      settings_updated: settingKeys
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[super] patch business error:', err.message, err.detail || '');
    if (err.code === '23505') {
      // Mirror the targeted-error UX from POST /businesses — parse
      // err.detail to tell the operator EXACTLY which column collided
      // and what value caused it. Generic message was the lazy fallback
      // that left operators staring at a meaningless banner.
      const detail = typeof err.detail === 'string' ? err.detail : '';
      const match = detail.match(/Key \(([^)]+)\)=\(([^)]+)\)/);
      const col = match?.[1];
      const value = match?.[2];
      let friendly = 'Slug or twilio_phone_number already in use.';
      let field = null;
      if (col === 'slug') {
        friendly = `The slug "${value}" is already taken by another tenant (possibly a soft-deleted one). Pick a different slug, or run the reclaim-orphaned endpoint to free it up.`;
        field = 'slug';
      } else if (
        col === 'phone_number' || col === 'twilio_phone_number' ||
        err.constraint === 'business_phone_numbers_phone_number_key' ||
        err.constraint === 'businesses_twilio_phone_number_key'
      ) {
        friendly = value
          ? `The phone number "${value}" is already attached to another tenant (possibly a soft-deleted one). Clear it on this tenant, change it, or run the reclaim-orphaned endpoint.`
          : 'A phone number on this tenant collides with another tenant.';
        field = 'phone_number';
      } else if (col) {
        friendly = `The value "${value}" collides with an existing tenant on column "${col}".`;
      }
      return res.status(409).json({
        error: friendly,
        field,
        constraint: err.constraint || null,
        detail: detail || null
      });
    }
    res.status(500).json({ error: err.message || 'Failed to update business' });
  } finally {
    client.release();
  }
});

// -------------- DELETE /api/super/businesses/:id --------------
//
// Soft delete. Requires `?confirm=<slug>` in the query string so a
// mis-aimed click can't wipe a tenant — the operator must copy-paste
// the slug from the UI. plan='legacy' tenants (Valleymede) cannot be
// deleted; they return 409. Setting `deleted_at` cascades visibility
// but keeps every row (call_logs, credit_ledger, settings) intact for
// restore.
router.delete('/businesses/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }

  // Super admins often have a user_id on req.auth; fall back gracefully.
  const actorId = Number.isInteger(req.auth?.user_id) ? req.auth.user_id : null;

  try {
    const biz = await getBusinessById(id, { includeDeleted: true });
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    if (biz.deleted_at) {
      return res.status(409).json({ error: 'Business is already deleted', deleted_at: biz.deleted_at });
    }

    // Rail #1: the original pre-SaaS tenant (id=1) is never deletable.
    // This used to key on `plan === 'legacy'`, but 'legacy' was selectable
    // from the Edit-tenant plan dropdown, which meant any tenant saved
    // with plan='legacy' inherited the Valleymede safety lock and couldn't
    // be deleted. The real invariant is "this is the grandfather tenant",
    // which is always id=1.
    if (biz.id === 1) {
      return res.status(403).json({
        error: 'The original tenant (id=1) cannot be deleted — it is the platform\'s grandfather account.'
      });
    }

    // Rail #2: the operator must type the slug to confirm. Case-sensitive
    // — the UI copy-pastes it, so a near-miss here means the operator
    // typed the wrong tenant's slug.
    const confirm = String(req.query.confirm || '').trim();
    if (confirm !== biz.slug) {
      return res.status(400).json({
        error: 'Confirmation slug does not match',
        hint: `Pass ?confirm=${biz.slug} to confirm this delete.`
      });
    }

    // Snapshot the phone numbers BEFORE we release them — they go into
    // the audit-log meta so the `business.deleted` event is self-describing
    // and a future "restore + reattach numbers" flow has something to read.
    const phoneSnapshot = await query(
      `SELECT id, phone_number, label, is_primary, status
         FROM business_phone_numbers
        WHERE business_id = $1
        ORDER BY is_primary DESC, id`,
      [id]
    );
    const releasedNumbers = phoneSnapshot.rows.map(r => ({
      phone_number: r.phone_number,
      label: r.label,
      is_primary: r.is_primary,
      status: r.status
    }));
    if (biz.twilio_phone_number && !releasedNumbers.some(n => n.phone_number === biz.twilio_phone_number)) {
      releasedNumbers.push({
        phone_number: biz.twilio_phone_number,
        label: 'Main Line (denormalized on businesses row)',
        is_primary: true,
        status: 'active'
      });
    }

    // Rename the slug on soft-delete so the original frees up for a new
    // tenant. The `businesses.slug` column is globally UNIQUE (not partial
    // on deleted_at IS NULL), so a soft-deleted row still hoards its slug
    // otherwise. Format `deleted-<id>` is unambiguously unique (id is PK)
    // and the original slug is preserved in the audit meta below for
    // restore. Fits comfortably in the VARCHAR(80) column.
    const deletedSlug = `deleted-${id}`;

    // Audit FIRST so the event is attached to a live business_id
    // (audit_log FKs to businesses with ON DELETE CASCADE — not an issue
    // for soft delete, but this ordering matches the pattern we'd need
    // for a future hard-delete endpoint too).
    await logEventFromReq(req, {
      businessId: id,
      action: 'business.deleted',
      targetType: 'business',
      targetId: id,
      meta: {
        slug: biz.slug,
        name: biz.name,
        plan: biz.plan,
        template_key: biz.template_key,
        soft: true,
        actor_super_admin_id: actorId,
        // Original slug is captured here — the row's `slug` column is
        // renamed to `deleted-<id>` below so the original is free for
        // reuse on a new tenant. Restore reads this back.
        original_slug: biz.slug,
        renamed_slug: deletedSlug,
        // Phone numbers are released on soft-delete (see below) so the
        // operator can reuse the DIDs on a new tenant. Archiving them here
        // preserves the routing history for forensics / accidental-delete
        // recovery.
        released_phone_numbers: releasedNumbers
      }
    });

    const { rows } = await query(
      `UPDATE businesses
          SET deleted_at = NOW(),
              deleted_by_user_id = $1,
              is_active = FALSE,
              status = 'deleted',
              -- Rename the slug so the original frees up for reuse. The
              -- globally-unique index on businesses.slug would otherwise
              -- keep the deleted tenant's name permanently locked.
              slug = $3,
              -- Null out the denormalized primary number so the unique
              -- index on businesses.twilio_phone_number frees that DID up
              -- for the next tenant. The original value is captured in
              -- the audit meta above for restore.
              twilio_phone_number = NULL,
              updated_at = NOW()
        WHERE id = $2
          AND deleted_at IS NULL
      RETURNING id, slug, deleted_at, deleted_by_user_id`,
      [actorId, id, deletedSlug]
    );

    if (rows.length === 0) {
      // Race: someone else deleted it between the check and the UPDATE.
      return res.status(409).json({ error: 'Business was deleted concurrently' });
    }

    // Release the phone numbers. business_phone_numbers has the globally
    // unique constraint on phone_number that was blocking re-use; a hard
    // DELETE here frees it up. If the operator restores the tenant, the
    // phone numbers from the audit meta can be reattached via the existing
    // phone-numbers endpoints (or re-entered manually — the history lives
    // in the audit log either way).
    if (releasedNumbers.length > 0) {
      await query(
        `DELETE FROM business_phone_numbers WHERE business_id = $1`,
        [id]
      );
    }

    console.log(`[super] Soft-deleted business ${id} (${biz.slug}) by user=${actorId}; released slug=${biz.slug} and ${releasedNumbers.length} phone number(s)`);
    res.json({
      business: rows[0],
      deleted: true,
      released_slug: biz.slug,
      released_phone_numbers: releasedNumbers
    });
  } catch (err) {
    console.error('[super] delete business error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete business' });
  }
});

// -------------- POST /api/super/phone-numbers/reclaim-orphaned --------------
//
// One-time cleanup for tenants soft-deleted BEFORE the delete handler
// learned to release their phone numbers AND their slugs (see the
// DELETE /businesses/:id handler above). Finds every stranded identifier
// attached to a deleted_at tenant and releases it so the operator can
// reuse the slug + DIDs on a new tenant:
//
//   - business_phone_numbers rows     → deleted
//   - businesses.twilio_phone_number  → NULL
//   - businesses.slug (non-prefixed)  → renamed to `deleted-<id>`
//
// Idempotent — a second run sees nothing to reclaim and returns an empty
// list. Writes one audit event per tenant it touches so the history is
// reconstructable.
router.post('/phone-numbers/reclaim-orphaned', async (req, res) => {
  try {
    // Dry-run support: pass ?dry_run=1 to preview what would be reclaimed
    // without writing. Ops-only escape hatch; the UI can call it first to
    // show a "this will free up X numbers on Y tenants" confirmation.
    const dryRun = String(req.query.dry_run || '').trim() === '1';

    const orphans = await query(
      `SELECT bpn.id            AS row_id,
              bpn.business_id   AS business_id,
              bpn.phone_number  AS phone_number,
              bpn.label         AS label,
              bpn.is_primary    AS is_primary,
              b.slug            AS slug,
              b.name            AS name
         FROM business_phone_numbers bpn
         JOIN businesses b ON b.id = bpn.business_id
        WHERE b.deleted_at IS NOT NULL
        ORDER BY bpn.business_id, bpn.id`
    );
    const denormalized = await query(
      `SELECT id, slug, name, twilio_phone_number
         FROM businesses
        WHERE deleted_at IS NOT NULL
          AND twilio_phone_number IS NOT NULL`
    );
    // Slugs on deleted tenants that haven't been renamed to `deleted-<id>`
    // yet. The LIKE filter specifically excludes rows already migrated by
    // either the delete handler or a previous reclaim run so this is safe
    // to call repeatedly.
    const slugOrphans = await query(
      `SELECT id, slug, name
         FROM businesses
        WHERE deleted_at IS NOT NULL
          AND slug NOT LIKE 'deleted-%'`
    );

    if (dryRun) {
      return res.json({
        dry_run: true,
        orphan_phone_rows: orphans.rows,
        orphan_denormalized_twilio_numbers: denormalized.rows,
        orphan_slugs: slugOrphans.rows,
        total:
          orphans.rows.length +
          denormalized.rows.length +
          slugOrphans.rows.length
      });
    }

    // Group orphans by business so the audit log gets one event per tenant
    // (rather than one event per phone number).
    const byBiz = new Map();
    const ensureEntry = (bizId, slug, name) => {
      if (!byBiz.has(bizId)) byBiz.set(bizId, { slug, name, numbers: [], released_slug: null });
      return byBiz.get(bizId);
    };
    for (const r of orphans.rows) {
      ensureEntry(r.business_id, r.slug, r.name).numbers.push({
        phone_number: r.phone_number,
        label: r.label,
        is_primary: r.is_primary
      });
    }
    for (const r of denormalized.rows) {
      const entry = ensureEntry(r.id, r.slug, r.name);
      if (!entry.numbers.some(n => n.phone_number === r.twilio_phone_number)) {
        entry.numbers.push({
          phone_number: r.twilio_phone_number,
          label: 'Main Line (denormalized on businesses row)',
          is_primary: true
        });
      }
    }
    for (const r of slugOrphans.rows) {
      // Record the original slug before we rename; audit meta will carry it
      // so a later restore can put it back if still free.
      ensureEntry(r.id, r.slug, r.name).released_slug = r.slug;
    }

    if (orphans.rows.length > 0) {
      await query(
        `DELETE FROM business_phone_numbers
          WHERE business_id IN (
            SELECT id FROM businesses WHERE deleted_at IS NOT NULL
          )`
      );
    }
    if (denormalized.rows.length > 0) {
      await query(
        `UPDATE businesses
            SET twilio_phone_number = NULL, updated_at = NOW()
          WHERE deleted_at IS NOT NULL
            AND twilio_phone_number IS NOT NULL`
      );
    }
    // Rename orphaned slugs one at a time — the unique constraint forces
    // sequential updates, and the per-id target (`deleted-<id>`) means no
    // two updates can collide.
    for (const r of slugOrphans.rows) {
      await query(
        `UPDATE businesses
            SET slug = $1, updated_at = NOW()
          WHERE id = $2
            AND deleted_at IS NOT NULL`,
        [`deleted-${r.id}`, r.id]
      );
    }

    for (const [businessId, info] of byBiz.entries()) {
      await logEventFromReq(req, {
        businessId,
        action: 'phone_numbers.reclaimed_orphaned',
        targetType: 'business',
        targetId: businessId,
        meta: {
          slug: info.slug,
          name: info.name,
          reclaimed_numbers: info.numbers,
          // Surfacing the released slug (if any) so `business.restored`
          // can look it up the same way it reads `business.deleted` meta.
          released_slug: info.released_slug,
          source: 'reclaim-orphaned endpoint'
        }
      });
    }

    res.json({
      reclaimed: true,
      tenants_touched: byBiz.size,
      total_numbers: orphans.rows.length + denormalized.rows.length,
      total_slugs_released: slugOrphans.rows.length,
      by_tenant: Array.from(byBiz.entries()).map(([id, v]) => ({
        business_id: id,
        slug: v.slug,
        name: v.name,
        numbers: v.numbers,
        released_slug: v.released_slug
      }))
    });
  } catch (err) {
    console.error('[super] reclaim-orphaned error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to reclaim orphaned phone numbers' });
  }
});

// -------------- POST /api/super/businesses/:id/restore --------------
//
// Un-delete a soft-deleted tenant. Clears deleted_at + deleted_by_user_id
// and flips is_active back on. Status is set back to 'active' unless
// the operator passes an explicit `status` in the body (for the "restore
// but keep paused" case).
router.post('/businesses/:id/restore', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }

  try {
    const biz = await getBusinessById(id, { includeDeleted: true });
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    if (!biz.deleted_at) {
      return res.status(409).json({ error: 'Business is not deleted; nothing to restore' });
    }

    const statusOnRestore =
      typeof req.body?.status === 'string' && req.body.status.trim()
        ? req.body.status.trim().slice(0, 40)
        : 'active';

    // Look up the original slug from the most recent business.deleted audit
    // event for this tenant. If it's still free (nobody has claimed it on a
    // new tenant since), restore it; otherwise fall back to the current
    // `deleted-<id>` placeholder and surface a note so the operator knows
    // the name needs to be picked anew.
    let targetSlug = biz.slug;
    let originalSlugFree = null;
    try {
      const auditRows = await query(
        `SELECT meta
           FROM audit_log
          WHERE business_id = $1
            AND action = 'business.deleted'
          ORDER BY created_at DESC
          LIMIT 1`,
        [id]
      );
      const meta = auditRows.rows[0]?.meta || null;
      const original = meta?.original_slug || meta?.slug;
      if (original && typeof original === 'string' && original !== biz.slug) {
        const clash = await query(
          'SELECT id FROM businesses WHERE slug = $1 AND id <> $2 LIMIT 1',
          [original, id]
        );
        if (clash.rows.length === 0) {
          targetSlug = original;
          originalSlugFree = true;
        } else {
          originalSlugFree = false;
        }
      }
    } catch (auditErr) {
      // Audit lookup is best-effort — if it fails, restore without renaming.
      console.warn('[super] restore: audit lookup failed, keeping current slug:', auditErr.message);
    }

    const { rows } = await query(
      `UPDATE businesses
          SET deleted_at = NULL,
              deleted_by_user_id = NULL,
              is_active = TRUE,
              status = $1,
              slug = $3,
              updated_at = NOW()
        WHERE id = $2
      RETURNING *`,
      [statusOnRestore, id, targetSlug]
    );

    await logEventFromReq(req, {
      businessId: id,
      action: 'business.restored',
      targetType: 'business',
      targetId: id,
      meta: {
        slug: targetSlug,
        previous_slug: biz.slug,
        original_slug_restored: originalSlugFree === true,
        original_slug_taken: originalSlugFree === false,
        previous_deleted_at: biz.deleted_at,
        restored_status: statusOnRestore
      }
    });

    console.log(
      `[super] Restored business ${id} (was=${biz.slug}, now=${targetSlug}) — ` +
      `status=${statusOnRestore}, original_slug_restored=${originalSlugFree === true}`
    );
    res.json({
      business: rows[0],
      restored: true,
      slug_restored: targetSlug !== biz.slug,
      original_slug_taken: originalSlugFree === false
    });
  } catch (err) {
    console.error('[super] restore business error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to restore business' });
  }
});

// -------------- GET /api/super/slug-check?slug=... --------------
//
// Lightweight uniqueness check used by the onboarding wizard to give the
// operator live feedback before they submit. The POST /businesses handler
// is still the authoritative check (it sees a 23505 from Postgres and
// returns a 409), but this endpoint lets the UI avoid that round trip.
//
// Response shape:
//   200 { slug, normalized, available: true }
//   200 { slug, normalized, available: false, existing_id, existing_name }
//   400 { error } — when the slug can't be normalized (empty after strip)
router.get('/slug-check', async (req, res) => {
  try {
    const raw = String(req.query.slug || '');
    const normalized = slugify(raw);
    if (!normalized) {
      return res.status(400).json({ error: 'slug cannot be empty after normalisation' });
    }
    // Only live tenants block reuse. Soft-deleted tenants have their slug
    // renamed to `deleted-<id>` on delete (and pre-patch stragglers are
    // handled by the reclaim-orphaned endpoint), so a query against the
    // current slug should never find a deleted row — but the filter is
    // cheap belt-and-suspenders in case a delete path is added later that
    // skips the rename.
    const { rows } = await query(
      'SELECT id, name FROM businesses WHERE slug = $1 AND deleted_at IS NULL LIMIT 1',
      [normalized]
    );
    if (rows.length === 0) {
      return res.json({ slug: raw, normalized, available: true });
    }
    res.json({
      slug: raw,
      normalized,
      available: false,
      existing_id: rows[0].id,
      existing_name: rows[0].name
    });
  } catch (err) {
    console.error('[super] slug-check error:', err.message);
    res.status(500).json({ error: 'slug check failed' });
  }
});

// -------------- GET /api/super/templates --------------
// Lightweight catalog for the onboarding wizard's template picker. The
// wizard doesn't need the full settings blob — just enough to render the
// picker and decide which timezone / plan to preselect.
router.get('/templates', (req, res) => {
  try {
    res.json({
      default_template_key: DEFAULT_TEMPLATE_KEY,
      templates: listTemplates()
    });
  } catch (err) {
    console.error('[super] list templates error:', err.message);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

// -------------- GET /api/super/voice-tiers --------------
// Catalog of voice tiers (Economy / Standard / Premium) plus the plan→tier
// access map. The onboarding wizard uses this to render three cards — with
// tiers the selected plan doesn't unlock grayed-out ("Upgrade plan to use").
// `?include_hidden=1` lets the super-admin UI surface placeholder tiers
// (ones whose model/voice IDs haven't been verified yet) so ops can still
// pin them manually.
router.get('/voice-tiers', (req, res) => {
  try {
    const includeHidden =
      req.query.include_hidden === '1' || req.query.include_hidden === 'true';
    res.json({
      default_tier: DEFAULT_VOICE_TIER,
      tiers: listVoiceTiers({ includeHidden }),
      plan_access: PLAN_TIER_ACCESS
    });
  } catch (err) {
    console.error('[super] list voice-tiers error:', err.message);
    res.status(500).json({ error: 'Failed to list voice tiers' });
  }
});

// -------------- GET /api/super/businesses/:id/voice --------------
//
// Returns the tenant's resolved voice config (tier, model, voice, speed),
// the raw settings.voice_config row (so the UI can tell a tier-based
// selection apart from an explicit override), and the list of known xAI
// voice names the dropdown should suggest.
router.get('/businesses/:id/voice', async (req, res) => {
  const businessId = Number(req.params.id);
  if (!Number.isFinite(businessId) || businessId <= 0) {
    return res.status(400).json({ error: 'Invalid business id' });
  }
  try {
    const row = await query(
      `SELECT value FROM settings WHERE business_id = $1 AND key = 'voice_config' LIMIT 1`,
      [businessId]
    );
    const raw = row.rows[0]?.value || null;
    const resolved = resolveVoiceConfigFromSettings(raw);
    res.json({
      raw,
      resolved,
      known_voices: listKnownVoices()
    });
  } catch (err) {
    console.error(`[super] get voice for business ${businessId}:`, err.message);
    res.status(500).json({ error: 'Failed to load voice config' });
  }
});

// -------------- PATCH /api/super/businesses/:id/voice --------------
//
// Super-admin-only override for the xAI voice name. Merges into any existing
// voice_config (so a tier selected at onboarding is preserved — only the
// `voice` field is pinned). Pass `voice: null` to clear the override and
// fall back to the tier's default voice or the legacy value.
//
// Body: { voice: string | null }
//
// We deliberately accept a free-form string rather than validating against
// KNOWN_VOICES so that a new voice xAI ships tomorrow can be used today
// without a code deploy. The dropdown on the UI side still suggests the
// curated list.
router.patch('/businesses/:id/voice', async (req, res) => {
  const businessId = Number(req.params.id);
  if (!Number.isFinite(businessId) || businessId <= 0) {
    return res.status(400).json({ error: 'Invalid business id' });
  }

  const hasVoice = Object.prototype.hasOwnProperty.call(req.body || {}, 'voice');
  if (!hasVoice) {
    return res.status(400).json({ error: 'Missing `voice` field (pass a string or null)' });
  }
  const incoming = req.body.voice;
  let nextVoice = null;
  if (incoming !== null && incoming !== undefined && incoming !== '') {
    if (typeof incoming !== 'string') {
      return res.status(400).json({ error: '`voice` must be a string or null' });
    }
    const trimmed = incoming.trim();
    if (!trimmed) {
      return res.status(400).json({ error: '`voice` cannot be blank (pass null to clear)' });
    }
    if (trimmed.length > 64 || !/^[a-zA-Z0-9_\-. ]+$/.test(trimmed)) {
      return res.status(400).json({
        error: '`voice` must be <=64 chars and alphanumeric/underscore/hyphen/dot/space'
      });
    }
    nextVoice = trimmed;
  }

  try {
    // Read the existing voice_config so we can merge rather than overwrite.
    const existing = await query(
      `SELECT value FROM settings WHERE business_id = $1 AND key = 'voice_config' LIMIT 1`,
      [businessId]
    );
    const prev = existing.rows[0]?.value || {};
    const nextConfig = { ...(typeof prev === 'object' && prev ? prev : {}) };
    if (nextVoice === null) {
      delete nextConfig.voice;
    } else {
      nextConfig.voice = nextVoice;
    }

    await query(
      `INSERT INTO settings (business_id, key, value, description)
       VALUES ($1, 'voice_config', $2::jsonb,
               'Voice tier + optional explicit overrides — managed by Super Admin')
       ON CONFLICT (business_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
      [businessId, JSON.stringify(nextConfig)]
    );

    const resolved = resolveVoiceConfigFromSettings(nextConfig);

    logEventFromReq(req, 'voice.updated', {
      business_id: businessId,
      voice: nextVoice,
      cleared: nextVoice === null
    });

    res.json({ raw: nextConfig, resolved });
  } catch (err) {
    console.error(`[super] patch voice for business ${businessId}:`, err.message);
    res.status(500).json({ error: 'Failed to update voice' });
  }
});

// -------------- POST /api/super/invite --------------
//
// General-purpose invite minter, independent of the create-business flow.
// Use cases:
//   - Super admin wants to resend an invite for a tenant that was created
//     without an admin_email.
//   - Super admin wants to add an additional business_admin or staff user
//     to an existing tenant.
//
// Body:
//   {
//     business_id: 42 *required (which tenant the invite binds to),
//     email:       'user@example.com' *required,
//     role:        'business_admin' | 'staff'  (default: business_admin)
//   }
router.post('/invite', async (req, res) => {
  try {
    const businessId = parseInt(req.body?.business_id, 10);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || BUSINESS_ADMIN_ROLE);

    if (!Number.isInteger(businessId) || businessId <= 0) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    if (!email.includes('@')) return res.status(400).json({ error: 'valid email required' });
    if (role !== BUSINESS_ADMIN_ROLE && role !== STAFF_ROLE) {
      return res.status(400).json({ error: `role must be '${BUSINESS_ADMIN_ROLE}' or '${STAFF_ROLE}'` });
    }

    const biz = await getBusinessById(businessId);
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const invite = await createInvite({
      businessId: biz.id,
      email,
      role,
      inviter: { super_admin_id: req.auth.user_id }
    });
    console.log(`[super] Invited ${email} as ${role} to business ${biz.id} (${biz.slug})`);
    await logEventFromReq(req, {
      businessId: biz.id,
      action: 'invite.created',
      targetType: 'invite',
      targetId: invite.id,
      meta: {
        email: invite.email,
        role: invite.role,
        expires_at: invite.expires_at,
        source: 'super_admin_invite'
      }
    });
    res.json({
      business_id: biz.id,
      business_name: biz.name,
      email: invite.email,
      role: invite.role,
      expires_at: invite.expires_at,
      token: invite.token,
      invite_url: buildInviteUrl(req, invite.token)
    });
  } catch (err) {
    console.error('[super] invite error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create invite' });
  }
});

// -------------- POST /api/super/businesses/:id/invite-admin --------------
router.post('/businesses/:id/invite-admin', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'valid email required' });
    const biz = await getBusinessById(id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const invite = await createInvite({
      businessId: biz.id,
      email,
      role: BUSINESS_ADMIN_ROLE,
      inviter: { super_admin_id: req.auth.user_id }
    });
    await logEventFromReq(req, {
      businessId: biz.id,
      action: 'invite.created',
      targetType: 'invite',
      targetId: invite.id,
      meta: {
        email: invite.email,
        role: invite.role,
        expires_at: invite.expires_at,
        source: 'invite_admin_shortcut'
      }
    });
    res.json({
      email: invite.email,
      expires_at: invite.expires_at,
      token: invite.token,
      invite_url: buildInviteUrl(req, invite.token)
    });
  } catch (err) {
    console.error('[super] invite-admin error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to invite admin' });
  }
});

// ============================================================================
// Phone number management (Phase 5)
// ============================================================================
//
// Super admins manage DIDs for any tenant from here. All four routes share a
// simple contract:
//   - `:id` is the businessId in the URL.
//   - `:phoneId` is the business_phone_numbers.id.
//   - Business scoping is enforced in the data-layer helpers via
//     `business_id = $1`, so a wrong :id can't leak another tenant's row.
//
//   GET    /api/super/businesses/:id/phone-numbers
//   POST   /api/super/businesses/:id/phone-numbers
//   PATCH  /api/super/businesses/:id/phone-numbers/:phoneId
//   DELETE /api/super/businesses/:id/phone-numbers/:phoneId
// ----------------------------------------------------------------------------

// ============================================================================
// USER MANAGEMENT — list tenant users + reset their passwords
// ============================================================================
//
// Super-admin convenience tools for the "I need to get a tenant back into
// their account" case. Two principles:
//
//   1. We do NOT store, log, or display plaintext passwords. The
//      password_hash column is bcrypt-only; the original plaintext is
//      destroyed at signup. Anyone who tells you otherwise is selling
//      a vulnerability.
//
//   2. A super-admin CAN reset a user's password and is shown the new
//      plaintext exactly once in the response — to be delivered to the
//      tenant out-of-band. The audit log records who reset what, but
//      not the password itself.
//
// GET  /api/super/businesses/:id/users               — list users on the tenant
// POST /api/super/businesses/:id/users/:userId/reset-password
//                                                     — reset password,
//                                                       returns plaintext ONCE

// GET — list business_users for a tenant. The schema uses `active`
// (not `is_active`) and has no `updated_at` — alias to is_active in the
// JSON so the frontend can keep using a consistent key name.
router.get('/businesses/:id/users', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }
  try {
    const biz = await getBusinessById(id, { includeDeleted: true });
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const { rows } = await query(
      `SELECT id, email, name, role,
              active AS is_active,
              last_login_at, created_at
         FROM business_users
        WHERE business_id = $1
        ORDER BY active DESC, LOWER(email) ASC`,
      [id]
    );
    res.json({ business_id: id, business_slug: biz.slug, users: rows });
  } catch (err) {
    console.error(`[super] list users for ${id} error:`, err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// POST — create a new business_user directly (no invite flow). The
// super-admin is shown the new password ONCE in the response so they
// can deliver it out-of-band. Same one-time-reveal contract as
// reset-password. Body shape:
//   { email, name?, role?, password? | generate?: true }
//
// `email` is required. `role` defaults to 'business_admin'; supply
// 'staff' for non-admin tenant users. The (business_id, email) UNIQUE
// constraint guards against duplicates — we surface a 409 on collision.
router.post('/businesses/:id/users', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }
  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : null;
  const rawRole = typeof body.role === 'string' ? body.role.trim() : 'business_admin';
  const role = rawRole === 'staff' || rawRole === 'business_admin' ? rawRole : 'business_admin';

  const wantGenerate = body.generate === true;
  const supplied = typeof body.password === 'string' ? body.password : null;
  if (!wantGenerate && !supplied) {
    return res.status(400).json({
      error: 'Provide either { password: "..." } or { generate: true }'
    });
  }
  let plaintext;
  if (supplied) {
    const err = validateSuppliedPassword(supplied);
    if (err) return res.status(400).json({ error: err });
    plaintext = supplied;
  } else {
    plaintext = generateTempPassword();
  }

  try {
    const biz = await getBusinessById(id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const passwordHash = await bcrypt.hash(plaintext, 10);
    const { rows } = await query(
      `INSERT INTO business_users (business_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, active AS is_active, created_at`,
      [id, email, passwordHash, name, role]
    );
    const user = rows[0];

    await logEventFromReq(req, {
      businessId: id,
      action: 'user.created_by_super',
      targetType: 'business_user',
      targetId: user.id,
      meta: {
        target_email: user.email,
        target_role: user.role,
        method: supplied ? 'operator_supplied' : 'auto_generated',
        actor_super_admin_id: req.auth?.user_id || null
      }
    }).catch(() => {});

    console.log(
      `[super] Created business_user ${user.id} (${email}) on tenant ${id} ` +
      `by super_admin ${req.auth?.user_id || '?'}`
    );

    // Sign-in URL — base URL of THIS deployment + `?email=` so the
    // LoginPage can pre-fill the email field. Built from the request so
    // it works whether you're on golf-ai-phone-system-production.up.railway.app
    // or a custom domain. The operator pastes this link + the temp
    // password in their message to the new user; the user clicks the
    // link, sees their email already filled in, and types the password.
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.get('host');
    const signinUrl = host ? `${proto}://${host}/?email=${encodeURIComponent(email)}` : null;

    res.status(201).json({
      ok: true,
      user,
      password: plaintext,
      generated: !supplied,
      signin_url: signinUrl,
      note: 'This password is shown once. Save or share it now — we cannot retrieve it later.'
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: `A user with email "${email}" already exists on this tenant.`
      });
    }
    console.error(`[super] create user on ${id} error:`, err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Generate a 14-character URL-safe-ish password — readable enough to be
// shared verbally if needed. Uses crypto.randomBytes (NOT Math.random).
// Excludes ambiguous characters (0/O, 1/l/I) to reduce dictation errors.
function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Strict password policy for super-admin-supplied passwords. We don't
// enforce all the OWASP rules here because the operator IS the security
// boundary on this endpoint, but minimum length + no whitespace is a
// reasonable floor.
function validateSuppliedPassword(p) {
  if (typeof p !== 'string') return 'password must be a string';
  if (p.length < 8) return 'password must be at least 8 characters';
  if (p.length > 200) return 'password must be at most 200 characters';
  if (/\s/.test(p)) return 'password cannot contain whitespace';
  return null;
}

// POST — text the new credentials to the user via SMS, sent FROM the
// tenant's primary Twilio number so the recipient sees a recognizable
// caller-ID. Body shape:
//   { to: "+1...", password: "...", signin_url?: "https://..." }
//
// We accept the password as input on this one route specifically because
// the operator needs to forward it to the new user — and the alternative
// (sending the plaintext through some persistent server-side state)
// would be worse. The password is used only to compose the SMS body and
// is NOT logged. Audit records the dispatch metadata (who sent, who to,
// recipient phone) but never the password content.
router.post('/businesses/:id/users/:userId/send-credentials-sms', async (req, res) => {
  const businessId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(businessId) || businessId <= 0 ||
      !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid id(s)' });
  }

  const to = normalizeToE164(req.body?.to || '');
  if (!to) {
    return res.status(400).json({ error: 'to must be a valid phone number (E.164 — e.g. +14165551234)' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    return res.status(400).json({ error: 'password is required (the value to text to the user)' });
  }
  const signinUrl = typeof req.body?.signin_url === 'string' && req.body.signin_url.trim()
    ? req.body.signin_url.trim()
    : null;

  try {
    // Confirm the target user belongs to this tenant — the meta we put
    // in the SMS (business name, recipient name) reads from these rows
    // and we want a clean 404 if the operator id-swapped.
    const { rows: [user] } = await query(
      `SELECT id, email, name, role, business_id
         FROM business_users
        WHERE id = $1 AND business_id = $2
        LIMIT 1`,
      [userId, businessId]
    );
    if (!user) return res.status(404).json({ error: 'User not found in this tenant' });

    const business = await getBusinessById(businessId);
    const tenantName = business?.name || 'your account';
    const greeting = user.name ? `Hi ${user.name.split(' ')[0]}` : 'Hi';

    // Compose the SMS body. Keep it under ~480 chars so it fits 3
    // segments comfortably; longer bodies get chunked unpredictably by
    // some carriers.
    const lines = [`${greeting}, your ${tenantName} account is ready.`];
    if (signinUrl) lines.push(`Sign in: ${signinUrl}`);
    lines.push(`Email: ${user.email}`);
    lines.push(`Temporary password: ${password}`);
    lines.push('Please sign in and change your password.');
    const body = lines.join('\n');

    const result = await sendSMS(businessId, to, body);
    if (!result) {
      return res.status(502).json({
        error: 'SMS dispatch returned no result — check that Twilio is configured and the tenant has a primary phone number.'
      });
    }

    await logEventFromReq(req, {
      businessId,
      action: 'user.credentials_sms_sent',
      targetType: 'business_user',
      targetId: userId,
      meta: {
        target_email: user.email,
        target_phone: to,
        message_sid: result.sid || null,
        actor_super_admin_id: req.auth?.user_id || null
        // password content intentionally NOT logged
      }
    }).catch(() => {});

    console.log(
      `[super] Credentials SMS dispatched to ${to} for business_user ${userId} ` +
      `(${user.email}) on tenant ${businessId} — sid=${result.sid || '?'}`
    );

    res.json({
      ok: true,
      message_sid: result.sid || null,
      to,
      from: result.from || null
    });
  } catch (err) {
    console.error(`[super] credentials SMS for user ${userId} error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to send credentials SMS' });
  }
});

// POST — reset a user's password. Body shape:
//   { password?: string, generate?: true }
// One of `password` or `generate: true` is required. The hashed value is
// written; the plaintext is returned exactly once in the response and
// never logged or audited (only the metadata of the reset action is).
router.post('/businesses/:id/users/:userId/reset-password', async (req, res) => {
  const businessId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(businessId) || businessId <= 0 ||
      !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid id(s)' });
  }

  const wantGenerate = req.body?.generate === true;
  const supplied = typeof req.body?.password === 'string' ? req.body.password : null;
  if (!wantGenerate && !supplied) {
    return res.status(400).json({
      error: 'Provide either { password: "..." } or { generate: true }'
    });
  }

  let plaintext;
  if (supplied) {
    const err = validateSuppliedPassword(supplied);
    if (err) return res.status(400).json({ error: err });
    plaintext = supplied;
  } else {
    plaintext = generateTempPassword();
  }

  try {
    // Confirm user belongs to the named tenant before we touch them.
    // This both guards against id-swap mistakes and gives us nice
    // metadata for the audit event.
    const { rows: [user] } = await query(
      `SELECT id, email, name, role, business_id, active AS is_active
         FROM business_users
        WHERE id = $1 AND business_id = $2
        LIMIT 1`,
      [userId, businessId]
    );
    if (!user) return res.status(404).json({ error: 'User not found in this tenant' });

    const passwordHash = await bcrypt.hash(plaintext, 10);
    await query(
      `UPDATE business_users
          SET password_hash = $1
        WHERE id = $2 AND business_id = $3`,
      [passwordHash, userId, businessId]
    );

    // Audit — record actor + target, NEVER the plaintext or hash.
    await logEventFromReq(req, {
      businessId,
      action: 'user.password_reset_by_super',
      targetType: 'business_user',
      targetId: userId,
      meta: {
        target_email: user.email,
        target_role: user.role,
        method: supplied ? 'operator_supplied' : 'auto_generated',
        actor_super_admin_id: req.auth?.user_id || null
      }
    }).catch(() => {});

    console.log(
      `[super] Password reset for business_user ${userId} (${user.email}) ` +
      `on tenant ${businessId} by super_admin ${req.auth?.user_id || '?'}`
    );

    // Return the plaintext ONCE so the operator can deliver it to the
    // tenant out-of-band. The UI shows a copy-to-clipboard panel and
    // makes clear the value is not retrievable later.
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        is_active: user.is_active
      },
      password: plaintext,
      generated: !supplied,
      note: 'This password is shown once. Save or share it now — we cannot retrieve it later.'
    });
  } catch (err) {
    console.error(`[super] password reset for user ${userId} error:`, err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// DELETE — hard-remove a user from a tenant. Permanent: their
// business_users row is gone. Their email becomes available for re-add
// on the same tenant immediately. Audit metadata captures the deletion
// so the trail isn't lost.
//
// Safety rail: refuse to delete the LAST active business_admin on a
// tenant — that would lock the tenant out of their own dashboard. The
// super-admin can still recover by adding a new admin first, then
// deleting the old one. Inactive admins (active=false) don't count
// toward the floor since they can't sign in anyway.
router.delete('/businesses/:id/users/:userId', async (req, res) => {
  const businessId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(businessId) || businessId <= 0 ||
      !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid id(s)' });
  }
  try {
    const { rows: [user] } = await query(
      `SELECT id, email, name, role, active
         FROM business_users
        WHERE id = $1 AND business_id = $2
        LIMIT 1`,
      [userId, businessId]
    );
    if (!user) return res.status(404).json({ error: 'User not found in this tenant' });

    // Last-admin guard — only fires if the target IS an active admin.
    // Counting active admins ONLY ensures we don't false-positive on a
    // tenant that already has all-disabled admins (they're already
    // locked out, deleting one more doesn't change that).
    if (user.role === 'business_admin' && user.active) {
      const { rows: [count] } = await query(
        `SELECT COUNT(*)::int AS n
           FROM business_users
          WHERE business_id = $1 AND role = 'business_admin' AND active = TRUE`,
        [businessId]
      );
      if ((count?.n || 0) <= 1) {
        return res.status(409).json({
          error: 'Cannot delete the last active business admin — this would lock the tenant out. Add another admin first, then remove this one.',
          field: 'role'
        });
      }
    }

    await query(
      `DELETE FROM business_users WHERE id = $1 AND business_id = $2`,
      [userId, businessId]
    );

    await logEventFromReq(req, {
      businessId,
      action: 'user.deleted_by_super',
      targetType: 'business_user',
      targetId: userId,
      meta: {
        target_email: user.email,
        target_role: user.role,
        was_active: user.active,
        actor_super_admin_id: req.auth?.user_id || null
      }
    }).catch(() => {});

    console.log(
      `[super] Deleted business_user ${userId} (${user.email}, ${user.role}) ` +
      `from tenant ${businessId} by super_admin ${req.auth?.user_id || '?'}`
    );
    res.json({ ok: true, deleted: true, id: userId });
  } catch (err) {
    console.error(`[super] delete user ${userId} error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to delete user' });
  }
});

// PATCH — toggle a user's is_active flag. Useful for "lock the account
// until they confirm" workflows or for revoking access without losing
// audit history. Only is_active is editable here; for email/name changes
// the user signs in and updates their profile themselves.
router.patch('/businesses/:id/users/:userId', async (req, res) => {
  const businessId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(businessId) || businessId <= 0 ||
      !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'invalid id(s)' });
  }
  if (typeof req.body?.is_active !== 'boolean') {
    return res.status(400).json({ error: 'Body must include { is_active: boolean }' });
  }
  try {
    // Schema column is `active` (no `updated_at`); alias back to is_active
    // in the response so the frontend keeps a consistent key name.
    const { rows } = await query(
      `UPDATE business_users
          SET active = $1
        WHERE id = $2 AND business_id = $3
        RETURNING id, email, name, role, active AS is_active`,
      [req.body.is_active, userId, businessId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found in this tenant' });
    await logEventFromReq(req, {
      businessId,
      action: 'user.activation_changed',
      targetType: 'business_user',
      targetId: userId,
      meta: {
        target_email: rows[0].email,
        is_active: req.body.is_active
      }
    }).catch(() => {});
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(`[super] toggle user ${userId} error:`, err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Minimal E.164 validator to keep the DB honest. The UI validates too, but
// the backend must defend itself.
const E164_RE = /^\+[1-9]\d{7,14}$/;
function isValidE164(s) {
  return typeof s === 'string' && E164_RE.test(s.trim());
}

// -------------- GET /api/super/businesses/:id/phone-numbers --------------
router.get('/businesses/:id/phone-numbers', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }
  try {
    const biz = await getBusinessById(id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const phones = await listBusinessPhoneNumbers(id);
    res.json({ business_id: id, phone_numbers: phones });
  } catch (err) {
    console.error(`[super] list phones for business ${id} error:`, err.message);
    res.status(500).json({ error: 'Failed to list phone numbers' });
  }
});

// -------------- POST /api/super/businesses/:id/phone-numbers --------------
//
// Body: { phone_number: '+1…' *required, label?, is_primary?: boolean,
//         status?: 'active' | 'inactive' }
router.post('/businesses/:id/phone-numbers', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }
  const phone = String(req.body?.phone_number || '').trim();
  if (!isValidE164(phone)) {
    return res.status(400).json({ error: 'phone_number must be E.164 (e.g. +19053334444)' });
  }
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 50) : null;
  const isPrimary = req.body?.is_primary === true;
  const status = req.body?.status === 'inactive' ? 'inactive' : 'active';

  if (isPrimary && status !== 'active') {
    return res.status(400).json({ error: 'Primary numbers must be active' });
  }

  try {
    const biz = await getBusinessById(id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const row = await addBusinessPhoneNumber(id, {
      phone_number: phone,
      label,
      is_primary: isPrimary,
      status
    });
    console.log(
      `[super] Added phone ${phone} to business ${id} (primary=${isPrimary}, status=${status})`
    );
    await logEventFromReq(req, {
      businessId: id,
      action: 'phone.added',
      targetType: 'phone_number',
      targetId: row.id,
      meta: {
        phone_number: row.phone_number,
        label: row.label,
        is_primary: row.is_primary,
        status: row.status
      }
    });
    res.status(201).json({ phone_number: row });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That phone number is already registered' });
    }
    console.error(`[super] add phone to business ${id} error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to add phone number' });
  }
});

// -------------- PATCH /api/super/businesses/:id/phone-numbers/:phoneId -----
//
// Body (all optional): { phone_number?, label?, is_primary?, status? }
router.patch('/businesses/:id/phone-numbers/:phoneId', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const phoneId = parseInt(req.params.phoneId, 10);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(phoneId) || phoneId <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const patch = {};
  if (typeof req.body?.phone_number === 'string') {
    const p = req.body.phone_number.trim();
    if (!isValidE164(p)) {
      return res.status(400).json({ error: 'phone_number must be E.164' });
    }
    patch.phone_number = p;
  }
  if (typeof req.body?.label === 'string') patch.label = req.body.label;
  if (req.body?.status === 'active' || req.body?.status === 'inactive') {
    patch.status = req.body.status;
  }
  if (req.body?.is_primary === true || req.body?.is_primary === false) {
    patch.is_primary = req.body.is_primary;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no recognised fields to update' });
  }

  try {
    const biz = await getBusinessById(id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const row = await updateBusinessPhoneNumber(id, phoneId, patch);
    if (!row) return res.status(404).json({ error: 'Phone number not found for this business' });
    console.log(
      `[super] Patched phone ${phoneId} for business ${id}: ${Object.keys(patch).join(', ')}`
    );
    await logEventFromReq(req, {
      businessId: id,
      action: 'phone.updated',
      targetType: 'phone_number',
      targetId: row.id,
      meta: {
        fields: Object.keys(patch),
        patch,
        phone_number: row.phone_number,
        label: row.label,
        is_primary: row.is_primary,
        status: row.status
      }
    });
    res.json({ phone_number: row });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That phone number is already registered' });
    }
    if (err.code === 'INVALID_STATE') {
      return res.status(400).json({ error: err.message });
    }
    console.error(`[super] patch phone ${phoneId} error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to update phone number' });
  }
});

// -------------- DELETE /api/super/businesses/:id/phone-numbers/:phoneId ----
router.delete('/businesses/:id/phone-numbers/:phoneId', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const phoneId = parseInt(req.params.phoneId, 10);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(phoneId) || phoneId <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  try {
    const biz = await getBusinessById(id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    // Snapshot the phone row before deletion so the audit entry can say
    // what we just removed (number + primary flag). Scoped by business_id
    // so a rogue :phoneId belonging to a different tenant can't leak here.
    const snapRes = await query(
      `SELECT id, phone_number, label, is_primary, status
         FROM business_phone_numbers
        WHERE id = $1 AND business_id = $2`,
      [phoneId, id]
    );
    const snapshot = snapRes.rows[0] || null;
    const ok = await deleteBusinessPhoneNumber(id, phoneId);
    if (!ok) return res.status(404).json({ error: 'Phone number not found for this business' });
    console.log(`[super] Deleted phone ${phoneId} from business ${id}`);
    await logEventFromReq(req, {
      businessId: id,
      action: 'phone.deleted',
      targetType: 'phone_number',
      targetId: phoneId,
      meta: snapshot
        ? {
            phone_number: snapshot.phone_number,
            label: snapshot.label,
            was_primary: snapshot.is_primary,
            status_at_delete: snapshot.status
          }
        : { note: 'row already gone at read-before-delete; delete succeeded' }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[super] delete phone ${phoneId} error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to delete phone number' });
  }
});

// ============================================================================
// Audit log reader (Phase 6)
// ============================================================================
//
//   GET /api/super/audit-log
//     ?business_id=42   (optional — filter to one tenant)
//     ?action=phone.added (optional — exact-match filter)
//     ?limit=50         (1..500, default 50)
//     ?before=12345     (keyset cursor — return rows with id < before)
//
// Returns: { events: [...], count, next_before_id }
router.get('/audit-log', async (req, res) => {
  try {
    const rawBiz = req.query.business_id;
    const businessId = rawBiz === undefined || rawBiz === '' || rawBiz === 'all'
      ? null
      : parseInt(rawBiz, 10);
    if (rawBiz !== undefined && rawBiz !== '' && rawBiz !== 'all') {
      if (!Number.isInteger(businessId) || businessId <= 0) {
        return res.status(400).json({ error: 'business_id must be a positive integer' });
      }
    }
    const action = typeof req.query.action === 'string' && req.query.action.length > 0
      ? req.query.action
      : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const beforeId = req.query.before ? parseInt(req.query.before, 10) : undefined;

    const events = await listAuditEvents({
      businessId: businessId === null ? undefined : businessId,
      action,
      limit,
      beforeId
    });
    const nextBefore = events.length > 0 ? events[events.length - 1].id : null;
    res.json({
      events,
      count: events.length,
      next_before_id: events.length >= (limit || 50) ? nextBefore : null
    });
  } catch (err) {
    console.error('[super] audit-log read error:', err.message);
    res.status(500).json({ error: 'Failed to read audit log' });
  }
});

// ============================================================================
// Platform analytics (Phase 6)
// ============================================================================
//
// Thin aggregate over the fleet so the Super Admin dashboard can show "how
// is the platform doing right now?" at a glance. One HTTP call, one JSON
// response — every figure is recomputed fresh (no caching). The counts
// below are the ones the UI currently surfaces; add more as needed but
// keep each query single-shot + index-friendly.
//
//   GET /api/super/analytics
//   Returns: {
//     businesses: { total, active, trial, inactive, setup_complete, created_last_30d },
//     users:      { total, active, business_admins, staff, super_admins },
//     phones:     { total, active, primary },
//     calls:      { today, last_30d, total, active_now, minutes_last_30d },
//     bookings:   { today, last_30d, total, pending },
//     invites:    { open, accepted_last_30d },
//     generated_at: ISO-8601
//   }
router.get('/analytics', async (req, res) => {
  try {
    const sql = `
      WITH
        biz AS (
          SELECT
            COUNT(*)::int                                                   AS total,
            COUNT(*) FILTER (WHERE status = 'active')::int                  AS active,
            COUNT(*) FILTER (WHERE status = 'trial')::int                   AS trial,
            COUNT(*) FILTER (WHERE status = 'inactive' OR is_active = FALSE)::int AS inactive,
            COUNT(*) FILTER (WHERE setup_complete = TRUE)::int              AS setup_complete,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS created_last_30d
          FROM businesses
        ),
        bu AS (
          SELECT
            COUNT(*)::int                                                   AS total,
            COUNT(*) FILTER (WHERE active = TRUE)::int                      AS active,
            COUNT(*) FILTER (WHERE role = 'business_admin' AND active)::int AS business_admins,
            COUNT(*) FILTER (WHERE role = 'staff' AND active)::int          AS staff
          FROM business_users
        ),
        sa AS (
          SELECT COUNT(*)::int AS total FROM super_admins WHERE active = TRUE
        ),
        ph AS (
          SELECT
            COUNT(*)::int                                                   AS total,
            COUNT(*) FILTER (WHERE status = 'active')::int                  AS active,
            COUNT(*) FILTER (WHERE is_primary = TRUE AND status = 'active')::int AS "primary"
          FROM business_phone_numbers
        ),
        cl AS (
          SELECT
            COUNT(*)::int                                                     AS total,
            COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '30 days')::int AS last_30d,
            COUNT(*) FILTER (WHERE started_at::date = CURRENT_DATE)::int      AS today,
            COUNT(*) FILTER (WHERE ended_at IS NULL
                              AND started_at > NOW() - INTERVAL '2 hours')::int AS active_now,
            COALESCE(SUM(CASE WHEN started_at > NOW() - INTERVAL '30 days'
                              AND duration_seconds IS NOT NULL
                              THEN duration_seconds ELSE 0 END), 0)::int     AS seconds_last_30d
          FROM call_logs
        ),
        br AS (
          SELECT
            COUNT(*)::int                                                     AS total,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS last_30d,
            COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int      AS today,
            COUNT(*) FILTER (WHERE status = 'pending')::int                   AS pending
          FROM booking_requests
        ),
        inv AS (
          SELECT
            COUNT(*) FILTER (WHERE accepted_at IS NULL
                              AND expires_at > NOW())::int                    AS open,
            COUNT(*) FILTER (WHERE accepted_at > NOW() - INTERVAL '30 days')::int AS accepted_last_30d
          FROM user_invites
        )
      SELECT
        (SELECT row_to_json(biz.*) FROM biz) AS businesses,
        (SELECT row_to_json(bu.*)  FROM bu)  AS users,
        (SELECT total FROM sa)               AS super_admins,
        (SELECT row_to_json(ph.*)  FROM ph)  AS phones,
        (SELECT row_to_json(cl.*)  FROM cl)  AS calls_raw,
        (SELECT row_to_json(br.*)  FROM br)  AS bookings,
        (SELECT row_to_json(inv.*) FROM inv) AS invites
    `;
    const { rows } = await query(sql);
    const r = rows[0] || {};
    const callsRaw = r.calls_raw || {};
    const seconds30 = Number(callsRaw.seconds_last_30d || 0);
    const calls = {
      today: callsRaw.today || 0,
      last_30d: callsRaw.last_30d || 0,
      total: callsRaw.total || 0,
      active_now: callsRaw.active_now || 0,
      minutes_last_30d: Math.round(seconds30 / 60)
    };
    const users = r.users || { total: 0, active: 0, business_admins: 0, staff: 0 };
    users.super_admins = r.super_admins || 0;

    res.json({
      businesses: r.businesses || { total: 0, active: 0, trial: 0, inactive: 0, setup_complete: 0, created_last_30d: 0 },
      users,
      phones: r.phones || { total: 0, active: 0, primary: 0 },
      calls,
      bookings: r.bookings || { total: 0, last_30d: 0, today: 0, pending: 0 },
      invites: r.invites || { open: 0, accepted_last_30d: 0 },
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[super] analytics error:', err.message);
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// ============================================================================
// CREDITS — super-admin grant / view
// ============================================================================
//
// Why this exists: when the audit reviewer ran the production-readiness
// check before today's launch, they flagged that there was no API path
// to grant credits to a tenant whose trial expired. The `adminAdjust`
// helper in services/credits.js had been written but never wired to a
// route, so any non-legacy tenant who exhausted their 14-day / 1-hour
// trial was bricked with no recovery short of a direct SQL UPDATE.
// These two endpoints close that gap.
//
// Routes:
//   GET  /api/super/businesses/:id/credits   — current balance + plan + trial state
//   POST /api/super/businesses/:id/credits   — grant (or deduct) seconds
//
// The grant endpoint accepts BOTH minutes (operator-friendly) and
// seconds (precise) and converts to seconds for the service. We log
// every grant to audit_log via the existing logEventFromReq path.

// GET — read balance + plan + trial expiry. Used by the Edit Tenant
// modal to show the current state next to the grant control.
router.get('/businesses/:id/credits', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }
  try {
    const biz = await getBusinessById(id, { includeDeleted: true });
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const snap = await getBalance(id);
    res.json({
      business_id: id,
      slug: biz.slug,
      name: biz.name,
      plan: snap.plan,
      seconds_remaining: snap.seconds_remaining,
      minutes_remaining: Math.floor((snap.seconds_remaining || 0) / 60),
      trial_granted_at: snap.trial_granted_at,
      trial_expires_at: snap.trial_expires_at,
      trial_active: !!snap.trial_active
    });
  } catch (err) {
    console.error(`[super] credits GET for ${id} error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to read credits' });
  }
});

// POST — grant or deduct credits. Body shape (one form is required):
//   { minutes: 60, note: "comp for May tournament" }
//   { seconds: 3600, note: "..." }
// Negative values are deductions (use sparingly — for clawing back a
// mis-grant; the audit row makes both directions traceable). The
// `is_free` flag tags the grant in the ledger note so revenue-vs-comp
// reporting later can split them. Defaults to free=true since most
// super-admin grants are make-goods, comp, or onboarding boosts; ops
// can pass `is_free: false` for paid top-ups they're recording manually.
router.post('/businesses/:id/credits', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid business id' });
  }
  const body = req.body || {};
  let deltaSeconds = null;
  if (Number.isFinite(Number(body.seconds)) && Number(body.seconds) !== 0) {
    deltaSeconds = Math.trunc(Number(body.seconds));
  } else if (Number.isFinite(Number(body.minutes)) && Number(body.minutes) !== 0) {
    deltaSeconds = Math.trunc(Number(body.minutes) * 60);
  }
  if (deltaSeconds === null || deltaSeconds === 0) {
    return res.status(400).json({
      error: 'Provide a non-zero amount: { minutes: 60 } or { seconds: 3600 }. Negative values deduct.'
    });
  }
  // Sanity cap — refuse anything > 24 hours in a single call. Real
  // grants are never that big; this catches a typo (60000 instead of
  // 60) before it lands in the ledger.
  if (Math.abs(deltaSeconds) > 24 * 60 * 60) {
    return res.status(400).json({
      error: `Single-call grant capped at ${24 * 60} minutes. For larger grants, do it in multiple steps so the audit log stays granular.`
    });
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  const isFree = body.is_free === false ? false : true;

  try {
    const biz = await getBusinessById(id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    // Legacy tenants don't go through the credit gate at all (canAcceptCall
    // short-circuits on plan='legacy'), so granting them seconds is a no-op
    // for call routing. Refuse to keep the ledger sensible.
    if (biz.plan === 'legacy') {
      return res.status(409).json({
        error: 'Tenant is on the legacy plan and bypasses the credit gate. Grant has no effect — refusing to clutter the ledger.'
      });
    }

    const result = await adminAdjust(id, {
      deltaSeconds,
      note,
      createdByUserId: req.auth?.user_id || null,
      isFree
    });

    await logEventFromReq(req, {
      businessId: id,
      action: 'credits.granted_by_super',
      targetType: 'business',
      targetId: id,
      meta: {
        delta_seconds: deltaSeconds,
        delta_minutes: Math.round(deltaSeconds / 60),
        balance_after_seconds: result.balanceAfter,
        ledger_id: result.ledgerId,
        is_free: isFree,
        note
      }
    }).catch(() => {});

    console.log(
      `[super] Credit grant on tenant ${id} (${biz.slug}): ` +
      `${deltaSeconds > 0 ? '+' : ''}${deltaSeconds}s ` +
      `(now ${result.balanceAfter}s) by super_admin ${req.auth?.user_id || '?'}`
    );
    res.json({
      ok: true,
      business_id: id,
      delta_seconds: deltaSeconds,
      delta_minutes: Math.round(deltaSeconds / 60),
      balance_after_seconds: result.balanceAfter,
      balance_after_minutes: Math.floor(result.balanceAfter / 60),
      ledger_id: result.ledgerId,
      reason: result.reason
    });
  } catch (err) {
    console.error(`[super] credits POST for ${id} error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to grant credits' });
  }
});

module.exports = router;
