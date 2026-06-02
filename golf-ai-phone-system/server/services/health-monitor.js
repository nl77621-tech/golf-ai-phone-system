/**
 * In-app health monitor.
 *
 * Runs the deep health check (booking pipeline, pending queue, Tee-On
 * push errors, in-call duplicates, Tee-On reachability) and texts a
 * summary to the operator on a self-schedule. This lives INSIDE the
 * app — which already runs 24/7 on Railway with the DB + Tee-On +
 * Twilio credentials — so delivery is guaranteed and does not depend
 * on any external/remote agent making an HTTP call.
 *
 * Schedule: every day at 6,9,12,15,18,21 (local America/Toronto). The
 * local-time check means it AUTOMATICALLY tracks daylight saving — no
 * winter adjustment needed (unlike a fixed-UTC cron).
 *
 * The only failure mode this can't text on is the app itself being
 * dead (a dead process can't send SMS). The external routine + the
 * absence of the expected text cover that case.
 */

const { pool, query } = require('../config/database');

// ─── The deep check (shared with the /health/deep endpoint) ─────────
async function runDeepHealthCheck() {
  const issues = [];
  const out = {
    status: 'ok',
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    issues,
  };

  // 1. DB reachable + booking pipeline (last 24h, platform-wide)
  try {
    const pipe = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='confirmed') AS confirmed,
        COUNT(*) FILTER (WHERE status='confirmed' AND teeon_synced_at IS NOT NULL) AS synced,
        COUNT(*) FILTER (WHERE status='confirmed' AND teeon_synced_at IS NULL AND teeon_last_error IS NOT NULL) AS push_failed,
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='rejected') AS rejected
      FROM booking_requests
      WHERE created_at > NOW() - INTERVAL '24 hours'`);
    const p = pipe.rows[0];
    out.bookings24h = {
      confirmed: +p.confirmed, synced: +p.synced, pushFailed: +p.push_failed,
      pending: +p.pending, rejected: +p.rejected,
    };
    out.dbReachable = true;
    if (+p.push_failed > 0) issues.push(`${p.push_failed} confirmed booking(s) failed to push to Tee-On in the last 24h`);
  } catch (err) {
    out.dbReachable = false;
    out.status = 'alert';
    issues.push('Database unreachable: ' + err.message);
  }

  // 2. Pending staff queue (all-time)
  if (out.dbReachable) {
    try {
      const pend = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM booking_requests WHERE status='pending') AS bookings,
          (SELECT COUNT(*) FROM modification_requests WHERE status='pending') AS modifications`);
      out.pendingQueue = { bookings: +pend.rows[0].bookings, modifications: +pend.rows[0].modifications };
    } catch (err) {
      issues.push('Pending-queue check failed: ' + err.message);
    }

    // 3. In-call duplicate booking rows (last 24h) — idempotency signal
    try {
      const dup = await pool.query(`
        SELECT COUNT(*) AS groups FROM (
          SELECT 1 FROM booking_requests
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY call_id, customer_name, requested_date, requested_time, party_size
          HAVING COUNT(*) > 1
        ) d`);
      out.inCallDuplicates24h = +dup.rows[0].groups;
      if (+dup.rows[0].groups > 0) issues.push(`${dup.rows[0].groups} in-call duplicate booking group(s) in the last 24h`);
    } catch (err) {
      issues.push('Duplicate check failed: ' + err.message);
    }
  }

  // 4. Tee-On reachability (time-boxed; non-fatal)
  try {
    const teeonAdmin = require('./teeon-admin');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000));
    const cookies = await Promise.race([teeonAdmin.ensureWarmAdminSession(1).catch(() => null), timeout]);
    out.teeonReachable = !!cookies;
    if (!cookies) { out.status = 'alert'; issues.push('Tee-On admin session could not be established'); }
  } catch (err) {
    out.teeonReachable = false;
    issues.push('Tee-On check error: ' + err.message);
  }

  if (out.status !== 'alert' && issues.length > 0) out.status = 'warn';
  return out;
}

// ─── SMS formatting ─────────────────────────────────────────────────
function formatHealthSms(out) {
  const icon = out.status === 'ok' ? '✅' : out.status === 'warn' ? '⚠️' : '🚨';
  const head = out.status === 'ok' ? 'Golf phone system OK'
             : out.status === 'warn' ? 'Golf phone system WARNING'
             : 'Golf phone system ALERT';
  let body;
  if (out.status === 'ok') {
    const b = out.bookings24h || {};
    body = `${icon} ${head} — ${b.synced ?? 0}/${b.confirmed ?? 0} bookings on Tee-On (24h), Tee-On reachable. All clear.`;
  } else {
    body = `${icon} ${head}:\n- ${out.issues.join('\n- ')}`;
  }
  // Local timestamp so the text is human-friendly AND unique (avoids
  // carrier filtering of repeated-identical monitoring SMS).
  const localStamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  body += `\n(${localStamp})`;
  return body;
}

// ─── Recipient resolution ───────────────────────────────────────────
// HEALTH_SMS_TO env wins; otherwise the first business_admins phone
// for Valleymede (business 1).
async function resolveRecipient() {
  if (process.env.HEALTH_SMS_TO) return process.env.HEALTH_SMS_TO;
  try {
    const r = await query(`SELECT phone_number FROM business_admins WHERE business_id=1 AND phone_number IS NOT NULL ORDER BY id LIMIT 1`);
    return r.rows[0]?.phone_number || null;
  } catch {
    return null;
  }
}

// ─── Run one check + text it ────────────────────────────────────────
async function runAndNotify() {
  const out = await runDeepHealthCheck();
  const to = await resolveRecipient();
  if (!to) {
    console.warn('[HealthMonitor] no recipient (set HEALTH_SMS_TO or a business_admin phone) — skipping text');
    return out;
  }
  try {
    const { sendSMS } = require('./notification');
    await sendSMS(1, String(to), formatHealthSms(out));
    console.log(`[HealthMonitor] ${out.status} — texted ${to}`);
  } catch (err) {
    console.error('[HealthMonitor] SMS send failed:', err.message);
  }
  return out;
}

// ─── Scheduler ──────────────────────────────────────────────────────
// Fires every 5 minutes. Texts at local hours 6,9,12,15,18,21 (the
// first tick of that hour), tracked by a per-slot key so we send once
// per slot. Local-time based → DST-safe.
const SCHEDULE_HOURS = [6, 9, 12, 15, 18, 21];
const TZ = 'America/Toronto';
let healthInterval = null;
let lastSlotKey = null;

function currentSlotKey() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  if (!SCHEDULE_HOURS.includes(hour)) return null;
  if (minute >= 5) return null; // only the first tick of the hour
  return `${get('year')}-${get('month')}-${get('day')}-${String(hour).padStart(2, '0')}`;
}

function startHealthScheduler() {
  console.log(`[HealthMonitor] Scheduler started — texts at ${SCHEDULE_HOURS.map(h => (h % 12 || 12) + (h < 12 ? 'am' : 'pm')).join(', ')} ${TZ}`);
  healthInterval = setInterval(() => {
    const slot = currentSlotKey();
    if (slot && slot !== lastSlotKey) {
      lastSlotKey = slot;
      runAndNotify().catch(err => console.error('[HealthMonitor] run failed:', err.message));
    }
  }, 5 * 60 * 1000);
}

function stopHealthScheduler() {
  if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }
}

module.exports = {
  runDeepHealthCheck,
  formatHealthSms,
  resolveRecipient,
  runAndNotify,
  startHealthScheduler,
  stopHealthScheduler,
};
