'use strict';

/**
 * Voice-path health alarm (real-time).
 *
 * grok-voice.js records the outcome of every call's Grok connection here:
 *   - `success` once the realtime session is confirmed (caller is being served)
 *   - `failure` when the Grok WebSocket errors / closes before a session /
 *     times out (the caller got dead air + a hangup)
 *
 * A watcher evaluates a rolling 10-minute window every minute and TEXTS the
 * operator the moment failures spike — so a provider outage is caught in
 * minutes, not hours.
 *
 * Why this exists: on 2026-06-23 a low xAI balance caused ~20h of HTTP 429s
 * that hung up on callers (1-second calls, empty transcripts). The deep
 * health-check (bookings / Tee-On) stayed green the whole time because it
 * never looked at the voice path, and those dead calls are stored with
 * status='completed'. This module closes that blind spot.
 *
 * Everything here is in-memory and best-effort by design: record() never
 * throws (it runs on the live-call path), the watcher self-catches, and
 * nothing here can block or break a call.
 */

const RING_MAX = 500;                       // cap in-memory event history
const WINDOW_MS = 10 * 60 * 1000;           // evaluate the last 10 minutes
const TICK_MS = 60 * 1000;                  // re-check every minute
const FAIL_COUNT_ALARM = 3;                 // >=3 failures in window -> alarm
const FAIL_RATE_MIN_CALLS = 4;              // with >=4 calls in window...
const FAIL_RATE_ALARM = 0.5;                // ...>=50% failing -> alarm
const REALERT_MS = 30 * 60 * 1000;          // don't repeat an active alarm <30m
const RECOVERY_QUIET_MS = 15 * 60 * 1000;   // 15m clean after alarm -> recovered

// events: { t, businessId, outcome:'success'|'failure', reason, httpStatus }
const events = [];
let watcher = null;
let alarmActive = false;
let lastAlertAt = 0;
let lastFailureAt = 0;

/**
 * Record one call's Grok-connection outcome. Called from grok-voice.js.
 * Best-effort: must never throw — it runs inside live-call event handlers.
 */
function record(ev) {
  try {
    const outcome = ev && ev.outcome === 'success' ? 'success' : 'failure';
    events.push({
      t: Date.now(),
      businessId: (ev && ev.businessId) || null,
      outcome,
      reason: (ev && ev.reason) || null,
      httpStatus: (ev && ev.httpStatus) || null,
    });
    if (events.length > RING_MAX) events.splice(0, events.length - RING_MAX);
    if (outcome === 'failure') lastFailureAt = Date.now();
  } catch (_) { /* never throw on the call path */ }
}

/** Aggregate the in-memory events within the last `ms`. */
function statsWithin(ms) {
  const cutoff = Date.now() - ms;
  let success = 0, failure = 0, http429 = 0;
  const reasons = {};
  for (const e of events) {
    if (e.t < cutoff) continue;
    if (e.outcome === 'success') { success++; continue; }
    failure++;
    if (e.httpStatus === 429) http429++;
    const k = e.reason || 'unknown';
    reasons[k] = (reasons[k] || 0) + 1;
  }
  const total = success + failure;
  return { total, success, failure, http429, failureRate: total ? failure / total : 0, reasons };
}

/** Pure decision: does this window warrant an alarm? */
function shouldAlarm(s) {
  if (s.failure >= FAIL_COUNT_ALARM) return true;
  if (s.total >= FAIL_RATE_MIN_CALLS && s.failureRate >= FAIL_RATE_ALARM) return true;
  return false;
}

function localStamp() {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric',
    });
  } catch (_) { return new Date().toISOString(); }
}

function buildAlarmSms(s) {
  let msg = `🚨 Golf phone VOICE ALERT — ${s.failure} call(s) failed to connect in the last 10 min`;
  if (s.http429 > 0) {
    msg += ` (${s.http429} were xAI 429 — likely low xAI credit balance or a rate limit). `
        + `Check console.x.ai credits first.`;
  } else {
    msg += `. Voice provider may be down — check Railway logs.`;
  }
  msg += ` ${s.success}/${s.total} calls connected OK.`;
  msg += `\n(${localStamp()})`;
  return msg;
}

async function sendAlarmSms(message) {
  try {
    // Lazy-require to avoid load-order coupling. resolveRecipient() returns
    // HEALTH_SMS_TO or the first Valleymede business_admin phone.
    const { resolveRecipient } = require('./health-monitor');
    const { sendSMS } = require('./notification');
    const to = await resolveRecipient();
    if (!to) { console.warn('[VoiceAlarm] no SMS recipient configured — cannot alert'); return; }
    await sendSMS(1, String(to), message);
    console.log(`[VoiceAlarm] texted ${to}`);
  } catch (err) {
    console.error('[VoiceAlarm] SMS send failed:', err.message);
  }
}

async function evaluateAndAlert() {
  const s = statsWithin(WINDOW_MS);
  const now = Date.now();

  if (shouldAlarm(s)) {
    const dueForRealert = now - lastAlertAt >= REALERT_MS;
    if (!alarmActive || dueForRealert) {
      alarmActive = true;
      lastAlertAt = now;
      console.warn(`[VoiceAlarm] FIRING — failures=${s.failure} (429=${s.http429}) success=${s.success}/${s.total}`);
      await sendAlarmSms(buildAlarmSms(s));
    }
    return;
  }

  // Cleared: if an alarm was active and it's been quiet long enough, recover.
  if (alarmActive && (now - lastFailureAt) >= RECOVERY_QUIET_MS) {
    alarmActive = false;
    console.log('[VoiceAlarm] RECOVERED — voice connecting normally again');
    await sendAlarmSms(`✅ Golf phone VOICE RECOVERED — calls are connecting normally again.\n(${localStamp()})`);
  }
}

function startVoiceHealthWatcher() {
  if (watcher) return;
  console.log(`[VoiceAlarm] watcher started — texts on >=${FAIL_COUNT_ALARM} fails/10min or >=${FAIL_RATE_ALARM * 100}% of >=${FAIL_RATE_MIN_CALLS} calls`);
  watcher = setInterval(() => {
    evaluateAndAlert().catch(e => console.error('[VoiceAlarm] tick error:', e.message));
  }, TICK_MS);
  if (watcher.unref) watcher.unref(); // don't keep the process alive for this
}

function stopVoiceHealthWatcher() {
  if (watcher) { clearInterval(watcher); watcher = null; }
}

module.exports = {
  record,
  statsWithin,
  shouldAlarm,
  evaluateAndAlert,
  startVoiceHealthWatcher,
  stopVoiceHealthWatcher,
  WINDOW_MS,
};
