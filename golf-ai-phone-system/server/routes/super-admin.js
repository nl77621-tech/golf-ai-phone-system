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
              b.template_key,
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

  // Voice tier — per-tenant (model, voice, speed) choice. Plan-gated so a
  // `free` tenant can't select premium. If the caller doesn't supply one, we
  // fall back to the platform default (standard). Validation happens up-front
  // so an invalid tier returns 400 before we open a DB connection.
  const rawVoiceTier = typeof b.voice_tier === 'string' ? b.voice_tier.trim().toLowerCase() : '';
  const voiceTier = rawVoiceTier || DEFAULT_VOICE_TIER;
  if (!getVoiceTier(voiceTier)) {
    return res.status(400).json({ error: `Unknown voice tier '${voiceTier}'` });
  }
  if (!isTierAllowedOnPlan(plan, voiceTier)) {
    return res.status(400).json({
      error: `Voice tier '${voiceTier}' is not available on plan '${plan}'`,
      allowed_tiers: allowedTiersForPlan(plan)
    });
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
      // slug / phone number unique violation
      return res.status(409).json({ error: 'slug or one of the phone numbers is already in use' });
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

  // Editable business columns. template_key deliberately omitted (see above).
  const allowed = [
    'name', 'slug', 'twilio_phone_number', 'transfer_number', 'timezone',
    'contact_email', 'contact_phone', 'status', 'is_active', 'plan',
    'primary_color', 'logo_url', 'internal_notes', 'setup_complete',
    'billing_notes'
  ];
  const body = req.body || {};
  const patches = {};
  for (const k of allowed) {
    if (k in body) patches[k] = body[k];
  }

  // Settings map. Every entry upserts into settings(business_id, key).
  const settingsMap =
    body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
      ? body.settings
      : null;
  const settingKeys = settingsMap ? Object.keys(settingsMap).filter(k => typeof k === 'string' && k.length > 0 && k.length <= 100) : [];

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
    console.error('[super] patch business error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'slug or twilio_phone_number already in use' });
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

    // Rail #1: legacy tenants are never deletable. Valleymede safety.
    if (biz.plan === 'legacy') {
      return res.status(403).json({
        error: 'Legacy tenants cannot be deleted (plan=\'legacy\'). Change plan first if this is intentional.'
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
        actor_super_admin_id: actorId
      }
    });

    const { rows } = await query(
      `UPDATE businesses
          SET deleted_at = NOW(),
              deleted_by_user_id = $1,
              is_active = FALSE,
              status = 'deleted',
              updated_at = NOW()
        WHERE id = $2
          AND deleted_at IS NULL
      RETURNING id, slug, deleted_at, deleted_by_user_id`,
      [actorId, id]
    );

    if (rows.length === 0) {
      // Race: someone else deleted it between the check and the UPDATE.
      return res.status(409).json({ error: 'Business was deleted concurrently' });
    }

    console.log(`[super] Soft-deleted business ${id} (${biz.slug}) by user=${actorId}`);
    res.json({ business: rows[0], deleted: true });
  } catch (err) {
    console.error('[super] delete business error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete business' });
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

    const { rows } = await query(
      `UPDATE businesses
          SET deleted_at = NULL,
              deleted_by_user_id = NULL,
              is_active = TRUE,
              status = $1,
              updated_at = NOW()
        WHERE id = $2
      RETURNING *`,
      [statusOnRestore, id]
    );

    await logEventFromReq(req, {
      businessId: id,
      action: 'business.restored',
      targetType: 'business',
      targetId: id,
      meta: {
        slug: biz.slug,
        previous_deleted_at: biz.deleted_at,
        restored_status: statusOnRestore
      }
    });

    console.log(`[super] Restored business ${id} (${biz.slug}) — status=${statusOnRestore}`);
    res.json({ business: rows[0], restored: true });
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
    const { rows } = await query(
      'SELECT id, name FROM businesses WHERE slug = $1 LIMIT 1',
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

module.exports = router;
