/**
 * Voice tiers — per-tenant voice model/voice/speed configuration.
 *
 * Every tenant's real-time voice call goes through grok-voice.js and opens
 * a WebSocket to xAI with a (model, voice, speed) triple. Historically those
 * three values were hard-coded — "grok-4.20-latest" / "eve" / 1.15 — so
 * every tenant paid the same cost and got the same voice regardless of
 * whether they were a personal assistant or a high-volume golf course.
 *
 * This module introduces three named tiers (economy, standard, premium)
 * plus plan-based access control so the onboarding wizard can surface the
 * right choice per tenant and the runtime can resolve the correct (model,
 * voice, speed) triple at call time.
 *
 * IMPORTANT: any change here is a runtime change — new calls start using
 * the new mapping immediately. Valleymede is insulated by two layers:
 *   1. Its `plan='legacy'` grants access to every tier (so nothing we do
 *      here can lock it out).
 *   2. If its `settings.voice_config` row is missing, resolveVoiceConfig
 *      falls back to the historical hard-coded triple exactly.
 */

'use strict';

// ─── Tier catalog ────────────────────────────────────────────────────────────
//
// Each tier maps to a concrete (model, voice, speed) that grok-voice.js
// passes to xAI. `placeholder: true` hides a tier from the wizard — use it
// when you've scaffolded a tier but don't yet have verified model/voice IDs
// from xAI. The tier still works if someone sets it explicitly via the DB,
// but the wizard won't offer it.

const VOICE_TIERS = {
  economy: {
    key: 'economy',
    label: 'Economy',
    tagline: 'Cost-optimised. Good for personal use and low-volume lines.',
    description: 'Lowest cost per minute. Clear and natural, but less expressive than Standard or Premium.',
    // TODO(voice): xAI hasn't published a distinct cheap realtime model at
    // this writing. Until we have a verified Economy model/voice ID, this
    // tier is hidden from the wizard (`placeholder: true`). Ops can still
    // opt into it manually by writing settings.voice_config directly.
    model: 'grok-4.20-latest',
    voice: 'eve',
    speed: 1.15,
    cost_tier: 1,
    placeholder: true
  },
  standard: {
    key: 'standard',
    label: 'Standard',
    tagline: 'Balanced quality and cost. The default for most businesses.',
    description: 'Natural-sounding voice, fast responses, predictable cost. Today\u2019s default voice for every tenant.',
    model: 'grok-4.20-latest',
    voice: 'eve',
    speed: 1.15,
    cost_tier: 2,
    placeholder: false
  },
  premium: {
    key: 'premium',
    label: 'Premium',
    tagline: 'xAI\u2019s newest voice \u2014 richer, more expressive.',
    description: 'Grok Think Fast 1.0 with the new Rock voice. Higher cost per call; best for brands that want the most polished experience.',
    // TODO(voice): these strings come from the user and need a live-call
    // verification. If xAI's actual identifiers differ (e.g. grok-think-fast-1
    // without the .0, or a different voice ID), update here — grok-voice.js
    // reads from this file so one edit flows everywhere.
    model: 'grok-think-fast-1.0',
    voice: 'rock',
    speed: 1.15,
    cost_tier: 3,
    placeholder: false
  }
};

const DEFAULT_TIER = 'standard';

// Legacy fallback — what grok-voice.js used before this file existed.
// resolveVoiceConfigFromSettings returns these when a tenant has no
// voice_config row at all, so Valleymede is a no-op during rollout.
const LEGACY_FALLBACK = Object.freeze({
  model: 'grok-4.20-latest',
  voice: 'eve',
  speed: 1.15
});

// ─── Plan-based access control ───────────────────────────────────────────────
//
// Which tiers each plan is allowed to select. `legacy` (Valleymede) always
// gets everything. Unknown plans fall back to `free`'s entitlements so we
// never accidentally unlock a premium tier for a mis-configured tenant.

const PLAN_TIER_ACCESS = Object.freeze({
  legacy:  ['economy', 'standard', 'premium'],
  free:    ['economy', 'standard'],
  starter: ['economy', 'standard'],
  pro:     ['economy', 'standard', 'premium'],
  trial:   ['economy', 'standard', 'premium']
});

function allowedTiersForPlan(plan) {
  return PLAN_TIER_ACCESS[plan] || PLAN_TIER_ACCESS.free;
}

function isTierAllowedOnPlan(plan, tierKey) {
  return allowedTiersForPlan(plan).includes(tierKey);
}

// ─── Catalog helpers ─────────────────────────────────────────────────────────

function getTier(key) {
  if (!key) return null;
  return VOICE_TIERS[key] || null;
}

/**
 * Public tier list for the wizard. `includeHidden: true` returns placeholder
 * tiers too — useful for the super-admin UI where ops may want to pin a
 * tier manually even before it's production-ready.
 */
function listTiers({ includeHidden = false } = {}) {
  return Object.values(VOICE_TIERS)
    .filter(t => includeHidden || !t.placeholder)
    .map(t => ({
      key: t.key,
      label: t.label,
      tagline: t.tagline,
      description: t.description,
      cost_tier: t.cost_tier,
      placeholder: !!t.placeholder
    }));
}

// ─── Runtime resolution ──────────────────────────────────────────────────────
//
// Convert a raw settings.voice_config JSONB value (or null) into the
// concrete (model, voice, speed) triple grok-voice.js injects into the
// xAI session.update payload.
//
// Resolution order:
//   1. Explicit overrides on the settings row (model/voice/speed keys)
//   2. The named tier from settings.voice_config.tier
//   3. LEGACY_FALLBACK — today's hard-coded values (never breaks Valleymede)

function resolveVoiceConfigFromSettings(voiceConfigValue) {
  if (!voiceConfigValue || typeof voiceConfigValue !== 'object') {
    return { tier: null, ...LEGACY_FALLBACK };
  }
  const tierKey = typeof voiceConfigValue.tier === 'string' ? voiceConfigValue.tier : null;
  const tier = tierKey ? getTier(tierKey) : null;

  const model = typeof voiceConfigValue.model === 'string' && voiceConfigValue.model.trim()
    ? voiceConfigValue.model.trim()
    : (tier?.model || LEGACY_FALLBACK.model);
  const voice = typeof voiceConfigValue.voice === 'string' && voiceConfigValue.voice.trim()
    ? voiceConfigValue.voice.trim()
    : (tier?.voice || LEGACY_FALLBACK.voice);
  const speed = Number.isFinite(voiceConfigValue.speed)
    ? voiceConfigValue.speed
    : (tier?.speed || LEGACY_FALLBACK.speed);

  return { tier: tierKey, model, voice, speed };
}

module.exports = {
  VOICE_TIERS,
  DEFAULT_TIER,
  LEGACY_FALLBACK,
  PLAN_TIER_ACCESS,
  allowedTiersForPlan,
  isTierAllowedOnPlan,
  getTier,
  listTiers,
  resolveVoiceConfigFromSettings
};
