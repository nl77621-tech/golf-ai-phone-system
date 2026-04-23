/**
 * Vertical templates for the Super Admin onboarding wizard.
 *
 * Each template is a prebuilt bundle of:
 *   - `settings`: rows that go into `settings(business_id, key, value)` when
 *     a tenant is provisioned. Keys here override the baseline defaults
 *     defined in `server/routes/super-admin.js` (DEFAULT_SETTINGS).
 *   - `greetings`: rows for `greetings(business_id, message, for_known_caller)`.
 *   - `meta`: UI-facing metadata the wizard uses to render the picker
 *     (label, tagline, icon, recommended plan, default timezone, etc.).
 *
 * Keeping templates as pure data (no SQL, no HTTP) lets the super-admin
 * router compose them easily inside its existing transaction: the caller
 * picks a template, we take `template.settings` + `template.greetings` and
 * insert them alongside the new business row. Fresh tenants land with
 * sensible, on-brand defaults instead of empty JSONB blobs.
 *
 * Design rules:
 *   - NEVER hardcode Valleymede specifics here. Templates are generic
 *     starting points; ops edits them per-tenant in the Command Center.
 *   - Keys used here must match the keys the rest of the app reads
 *     (see `services/system-prompt.js`). If you add a new key, the
 *     system prompt builder also needs to know about it.
 *   - Templates MUST be side-effect free — they're required at module
 *     load and should stay idempotent.
 */

'use strict';

/* ------------------------------------------------------------------
 * Shared helpers — a few common sub-bundles reused across templates.
 * ------------------------------------------------------------------ */

function weeklyHours({ open = '08:00', close = '18:00', sunday = null } = {}) {
  const base = { open, close };
  return {
    monday: base,
    tuesday: base,
    wednesday: base,
    thursday: base,
    friday: base,
    saturday: base,
    sunday: sunday || base
  };
}

function personality({
  name = 'AI Assistant',
  style = 'Friendly, warm, natural. Conversational, not robotic.',
  language = 'English primary. Switch if caller requests another language.',
  weather_behavior = 'Only provide weather if asked.',
  booking_limit = 8,
  after_hours_message = "Our staff isn't available right now, but I can help you with bookings or general questions."
} = {}) {
  return { name, style, language, weather_behavior, booking_limit, after_hours_message };
}

function standardNotifications() {
  return { email_enabled: true, sms_enabled: true, email_to: null, sms_to: null };
}

/* ------------------------------------------------------------------
 * Templates
 * ------------------------------------------------------------------ */

const GOLF_COURSE = {
  key: 'golf_course',
  meta: {
    label: 'Golf Course',
    tagline: 'Tee times, pricing, league play.',
    description: 'The full-course profile. Seeds greens-fee and cart pricing stubs, common course policies (cancellation, dress code, rain policy), tournament/outing fields, and an AI personality tuned for golfer-style questions. Ideal for 9- or 18-hole public or semi-private courses.',
    icon: 'flag',
    icon_emoji: '\u26f3\ufe0f',
    recommended_plan: 'starter',
    default_timezone: 'America/Toronto',
    features: ['Tee-time bookings', 'Green fee quoting', 'Weather-aware callbacks']
  },
  settings: [
    ['business_hours', weeklyHours({ open: '06:30', close: '20:00' }),
      'Daily open/close times'],
    ['pricing', {
      green_fees: {
        weekday: { nine: null, eighteen: null },
        weekend: { nine: null, eighteen: null }
      },
      cart_fees: { nine: null, eighteen: null },
      notes: 'Update pricing in Settings → Pricing before going live.'
    }, 'Green fees and cart pricing'],
    ['course_info', {
      holes: 18,
      type: 'Public',
      features: []
    }, 'General course information'],
    ['policies', {
      cancellation: '24 hours notice required to avoid a cancellation fee.',
      dress_code: 'Collared shirt and non-denim bottoms. Soft spikes only.',
      rain_policy: 'Rainchecks issued when play stops before hole 4 (or hole 13 for back-nine starts).'
    }, 'Course policies and rules'],
    ['memberships', {
      available: false,
      notes: 'Membership details — configure in Settings if offered.'
    }, 'Membership information'],
    ['tournaments', {
      accepts_outings: true,
      min_group_size: 12,
      notes: 'Tournaments and outings — update contact/rates in Settings.'
    }, 'Tournament and group outing info'],
    ['amenities', {
      driving_range: false,
      practice_green: true,
      pro_shop: true,
      restaurant: false,
      cart_rentals: true,
      club_rentals: false
    }, 'Facilities and amenities'],
    ['notifications', standardNotifications(), 'How to notify staff of new bookings'],
    ['ai_personality', personality({
      name: 'AI Assistant',
      style: 'Friendly, warm, knowledgeable about golf. Natural, not robotic.',
      after_hours_message: "Our staff isn't available right now, but I can help you book a tee time or answer course questions."
    }), 'AI voice agent personality and behavior settings'],
    ['announcements', [], 'Active announcements the AI should mention'],
    ['booking_settings', { require_credit_card: false }, 'Booking behavior settings'],
    ['test_mode', { enabled: false, test_phone: '' }, 'Test phone number configuration']
  ],
  greetings: [
    ['Thanks for calling! How can I help you today?', false],
    ['Hello! Looking to book a tee time or ask about the course?', false],
    ['Hi {name}! Good to hear from you again. Looking for another tee time?', true]
  ]
};

const DRIVING_RANGE = {
  key: 'driving_range',
  meta: {
    label: 'Driving Range',
    tagline: 'Bay reservations, bucket pricing, lessons.',
    description: 'Range-only operations without a full course. Seeds bay-rental and bucket pricing stubs, short-form policies (2-hour cancellation, covered vs. open bays in lightning), lesson booking fields, and an AI personality that prioritises quick quotes over long conversations.',
    icon: 'target',
    icon_emoji: '\ud83c\udfaf',
    recommended_plan: 'starter',
    default_timezone: 'America/Toronto',
    features: ['Bay reservations', 'Bucket pricing lookups', 'Lesson bookings']
  },
  settings: [
    ['business_hours', weeklyHours({ open: '09:00', close: '21:00' }),
      'Daily open/close times'],
    ['pricing', {
      buckets: {
        small: null,
        medium: null,
        large: null
      },
      bay_rental: { per_hour: null },
      lessons: { thirty_min: null, sixty_min: null },
      notes: 'Update bucket + lesson pricing before going live.'
    }, 'Range pricing'],
    ['course_info', {
      type: 'Driving range',
      bays: null,
      features: ['Heated bays', 'Club rentals'].slice(0, 0) // intentionally empty — ops fills in
    }, 'Facility information'],
    ['policies', {
      cancellation: 'Bay reservations cancellable up to 2 hours before start time.',
      dress_code: 'Casual — closed-toe footwear required.',
      rain_policy: 'Covered bays remain open; open bays close when lightning is in the area.'
    }, 'Facility policies'],
    ['memberships', {
      available: false,
      notes: 'Range memberships (unlimited buckets, bay priority) — configure if offered.'
    }, 'Membership information'],
    ['tournaments', {
      accepts_outings: true,
      min_group_size: 8,
      notes: 'Group events and corporate outings.'
    }, 'Group booking info'],
    ['amenities', {
      driving_range: true,
      practice_green: true,
      pro_shop: true,
      restaurant: false,
      bay_heating: false,
      club_rentals: true,
      lessons: true
    }, 'Facilities and amenities'],
    ['notifications', standardNotifications(), 'How to notify staff of new bookings'],
    ['ai_personality', personality({
      name: 'AI Assistant',
      style: 'Friendly, efficient, quick to quote bucket prices and bay availability.',
      after_hours_message: "We're closed right now, but I can help you reserve a bay for later or answer questions."
    }), 'AI voice agent personality and behavior settings'],
    ['announcements', [], 'Active announcements the AI should mention'],
    ['booking_settings', { require_credit_card: false }, 'Booking behavior settings'],
    ['test_mode', { enabled: false, test_phone: '' }, 'Test phone number configuration']
  ],
  greetings: [
    ['Thanks for calling! How can I help you today?', false],
    ['Hi there! Looking to reserve a bay or grab a bucket?', false],
    ['Hi {name}! Back for another session?', true]
  ]
};

const RESTAURANT = {
  key: 'restaurant',
  meta: {
    label: 'Restaurant',
    tagline: 'Reservations, hours, menu Q&A.',
    description: 'Clubhouse dining or a standalone restaurant. Seeds reservation-hold policies, dietary-accommodation tags, private-event minimums, and an AI personality polished for a well-run front of house. Good base for a 19th-hole operation that takes calls from both golfers and general diners.',
    icon: 'utensils',
    icon_emoji: '\ud83c\udf7d\ufe0f',
    recommended_plan: 'starter',
    default_timezone: 'America/Toronto',
    features: ['Table reservations', 'Hours & menu questions', 'Private event inquiries']
  },
  settings: [
    ['business_hours', weeklyHours({ open: '11:00', close: '22:00', sunday: { open: '10:00', close: '21:00' } }),
      'Daily open/close times'],
    ['pricing', {
      avg_check_per_guest: null,
      prix_fixe: null,
      notes: 'Callers may ask about price range — set an average per-guest figure here.'
    }, 'Pricing cues for the AI'],
    ['course_info', {
      type: 'Restaurant',
      cuisine: null,
      dining_room_capacity: null,
      patio: false
    }, 'Restaurant information'],
    ['policies', {
      cancellation: 'Reservations held 15 minutes past start time.',
      dress_code: 'Smart casual.',
      large_parties: 'Parties of 8+ require a 24-hour deposit hold.'
    }, 'Dining policies'],
    ['memberships', { available: false }, 'Loyalty / membership program'],
    ['tournaments', {
      accepts_outings: true,
      min_group_size: 10,
      notes: 'Private events and buyouts.'
    }, 'Private event info'],
    ['amenities', {
      patio: false,
      bar: true,
      private_room: false,
      parking: true,
      dietary_accommodations: ['vegetarian', 'gluten-free']
    }, 'Facility amenities'],
    ['notifications', standardNotifications(), 'How to notify staff of new reservations'],
    ['ai_personality', personality({
      name: 'AI Host',
      style: 'Warm, polished, attentive — the voice of a well-run front of house.',
      after_hours_message: "We're currently closed, but I'd love to help you book a table for another time."
    }), 'AI voice agent personality and behavior settings'],
    ['announcements', [], 'Active announcements the AI should mention'],
    ['booking_settings', { require_credit_card: false }, 'Reservation behavior settings'],
    ['test_mode', { enabled: false, test_phone: '' }, 'Test phone number configuration']
  ],
  greetings: [
    ['Thanks for calling! Would you like to make a reservation?', false],
    ['Hello! Happy to help with a reservation or any questions about the restaurant.', false],
    ['Hi {name}! Great to hear from you again — looking to book a table?', true]
  ]
};

const GENERIC = {
  key: 'other',
  meta: {
    label: 'Other / Generic',
    tagline: 'A safe, unopinionated starting point.',
    description: 'No vertical-specific copy. Seeds empty JSONB blobs for every required key plus a neutral AI personality and three generic greetings. Use when none of the other templates fit cleanly \u2014 you\u2019ll fill in pricing, policies, and amenities from scratch in Settings.',
    icon: 'sparkles',
    icon_emoji: '\u2728',
    recommended_plan: 'free',
    default_timezone: 'America/Toronto',
    features: ['Custom settings', 'Generic greetings', 'No vertical-specific copy']
  },
  settings: [
    ['business_hours', weeklyHours(), 'Daily open/close times'],
    ['pricing', {}, 'Pricing — add whatever fields fit your business'],
    ['course_info', {}, 'General business information'],
    ['policies', {}, 'Policies and rules'],
    ['memberships', {}, 'Membership / loyalty information'],
    ['tournaments', {}, 'Group bookings / events'],
    ['amenities', {}, 'Facilities and amenities'],
    ['notifications', standardNotifications(), 'How to notify staff of new bookings'],
    ['ai_personality', personality(), 'AI voice agent personality and behavior settings'],
    ['announcements', [], 'Active announcements the AI should mention'],
    ['booking_settings', { require_credit_card: false }, 'Booking behavior settings'],
    ['test_mode', { enabled: false, test_phone: '' }, 'Test phone number configuration']
  ],
  greetings: [
    ['Hi there! Thanks for calling. How can I help you today?', false],
    ['Hello! Thanks for getting in touch. What can I do for you?', false],
    ['Hi {name}! Good to hear from you again. What can I help with?', true]
  ]
};

const TEMPLATES = {
  [GOLF_COURSE.key]: GOLF_COURSE,
  [DRIVING_RANGE.key]: DRIVING_RANGE,
  [RESTAURANT.key]: RESTAURANT,
  [GENERIC.key]: GENERIC
};

// Default when the wizard hasn't picked one yet.
const DEFAULT_TEMPLATE_KEY = GOLF_COURSE.key;

/**
 * List every template with just its meta + key — safe to serialize to the
 * wizard. We don't leak the full settings payload here so the picker stays
 * lightweight; the server applies settings itself when provisioning.
 */
function listTemplates() {
  return Object.values(TEMPLATES).map(t => ({
    key: t.key,
    ...t.meta,
    settings_keys: t.settings.map(([k]) => k),
    greeting_count: t.greetings.length
  }));
}

function getTemplate(key) {
  if (!key) return TEMPLATES[DEFAULT_TEMPLATE_KEY];
  return TEMPLATES[key] || null;
}

/**
 * Apply a template inside an existing transaction. Accepts a pg client that's
 * already inside `BEGIN`. Upserts each setting row and inserts greetings.
 * The caller is responsible for COMMIT/ROLLBACK.
 *
 * Returns a summary of what got applied so the route handler can echo it
 * back to the UI.
 */
async function applyTemplate(client, businessId, templateKey) {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error('applyTemplate: businessId must be a positive integer');
  }
  const tpl = getTemplate(templateKey);
  if (!tpl) {
    throw new Error(`applyTemplate: unknown template '${templateKey}'`);
  }

  for (const [key, value, description] of tpl.settings) {
    await client.query(
      `INSERT INTO settings (business_id, key, value, description)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (business_id, key) DO UPDATE
         SET value = EXCLUDED.value,
             description = COALESCE(settings.description, EXCLUDED.description),
             updated_at = NOW()`,
      [businessId, key, JSON.stringify(value), description]
    );
  }
  for (const [message, forKnown] of tpl.greetings) {
    await client.query(
      `INSERT INTO greetings (business_id, message, for_known_caller, active)
       VALUES ($1, $2, $3, TRUE)`,
      [businessId, message, forKnown]
    );
  }

  return {
    template_key: tpl.key,
    settings_applied: tpl.settings.length,
    greetings_applied: tpl.greetings.length
  };
}

module.exports = {
  listTemplates,
  getTemplate,
  applyTemplate,
  DEFAULT_TEMPLATE_KEY,
  TEMPLATE_KEYS: Object.keys(TEMPLATES)
};
