/**
 * Live Tee Sheet Mirror — read-only Command Center view of Tee-On.
 *
 * Fetches the admin tee sheet HTML for a given date using the warm
 * authenticated session managed by teeon-admin.js, parses every row
 * (Front 9 + Back 9), and returns a structured array of slots that the
 * Command Center can render as a table.
 *
 * Design choices:
 *  - Read-only. No writes touch this module.
 *  - Reuses the existing authenticated session (no fresh login per
 *    request, no anonymous public-sheet hits — same path as
 *    check_tee_times after PR #28).
 *  - In-memory cache, 5-minute TTL per (businessId, date). A busy
 *    Command Center polling every 60 s costs at most one Tee-On fetch
 *    every 5 minutes per visible date.
 *  - Surface data only — names, party size, holes, cart count. We
 *    intentionally do NOT scrape phone numbers, emails, credit card
 *    info, or notes; those live behind the per-booking edit form
 *    which we don't load.
 *
 * Multi-tenant: every call takes businessId and routes through
 * getTeeOnConfigForBusiness + the per-tenant admin session. Two
 * tenants polling the same date never collide.
 */

const https = require('https');
const { requireBusinessId } = require('../context/tenant-context');
const teeonAdmin = require('./teeon-admin');

const TEEON_HOST = 'www.tee-on.com';
const TEE_SHEET_PATH = '/PubGolf/servlet/com.teeon.teesheet.servlets.proshop.course.booking.TeeSheetFullScreen';

// (businessId, date) → { fetchedAt, rows }
const sheetCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(businessId, date) {
  return `${businessId}:${date}`;
}

// ─── HTTPS helper (small, focused — no shared util to keep this file
//     standalone if we ever want to move it to a worker process) ──────
function httpsRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TEEON_HOST,
      method: opts.method || 'GET',
      path: opts.path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; aipickup-tee-sheet-mirror/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        ...(opts.headers || {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Tee-On request timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function getTenantTeeOnCourseCode(businessId) {
  // Reuse teeon-admin's tenant config lookup so we share its full
  // fallback chain (settings → businesses → DEFAULT_COURSE_CODE 'COLU').
  // Valleymede works without an explicit setting because of the default;
  // duplicating the lookup here was causing the "not configured" error
  // even though bookings worked fine via the same business_id.
  try {
    const cfg = await teeonAdmin.getTenantTeeOnConfig(businessId).catch(() => null);
    if (cfg?.courseCode) return cfg.courseCode;
  } catch {
    /* fall through */
  }
  return null;
}

// ─── HTML parser ────────────────────────────────────────────────────
//
// Tee-On's admin tee sheet renders each tile as a div whose onclick is
// either submitExistingTime(time, nine, bookerId, isBooked, partyCount,
// slotIndex) for occupied slots OR submitTime(time, nine, ...) for empty
// ones. The player name is the text content of the div for occupied
// tiles.
//
// We extract ALL `submitExistingTime(...)` matches with their immediate
// text context and group by (time, nine). For each group we keep the
// most descriptive label per slotIndex. Returns an array of unique
// times sorted ascending, each with front/back arrays.

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAdminTeeSheetHTML(html) {
  if (!html || typeof html !== 'string') return [];

  // Match every player tile. Capture:
  //   group 1: classes on the div (tells us "paid", "no-show", etc.)
  //   group 2: time (HH:MM)
  //   group 3: nine (F or B)
  //   group 4: bookerId
  //   group 5: party count int
  //   group 6: slot index (0..3)
  //   group 7: inner content up to closing </div>
  //
  // Tee-On wraps each tile in a <div class="...player..."
  // onclick="submitExistingTime('06:24','F','COLU4130',true,2,0);">...</div>.
  // The inner text is the golfer's display name. Tee-On sometimes wraps
  // the name in additional spans for icons; stripTags() flattens those.
  const tileRe = /<div\b([^>]*class="[^"]*\bplayer\b[^"]*"[^>]*onclick="submitExistingTime\('(\d{1,2}:\d{2})','([A-Z])','([A-Z0-9]+)',\s*(?:true|false)\s*,\s*(\d+)\s*,\s*(\d+)[^"]*"[^>]*)>([\s\S]*?)<\/div>/gi;

  // Group by time → { front: { slotIndex → {…} }, back: {…} }
  const byTime = new Map();
  let m;
  while ((m = tileRe.exec(html)) !== null) {
    const time = m[2];
    const nine = m[3];
    const bookerId = m[4];
    const partyCount = parseInt(m[5], 10);
    const slotIndex = parseInt(m[6], 10);
    const rawInner = m[7];
    const name = stripTags(rawInner).slice(0, 80) || 'Guest';

    // Holes guess from class names. The page sometimes appends a
    // "holes-9" / "holes-18" indicator. Default to 18 if absent.
    const classes = m[1] || '';
    const holes = /holes-9\b|nine-only\b|\b9-only\b/i.test(classes) ? 9 : 18;
    // Cart indicator — class "has-cart" or similar. Best effort.
    const hasCart = /\bcart\b/i.test(classes) && !/\bno-cart\b/i.test(classes);
    // Paid / no-show / etc. — useful flags for staff.
    const paid = /\bpaid\b/i.test(classes);
    const noShow = /\bno-?show\b/i.test(classes);

    const row = byTime.get(time) || { time, front: {}, back: {}, partyCount };
    const side = nine === 'B' ? row.back : row.front;
    side[slotIndex] = { slotIndex, name, bookerId, holes, hasCart, paid, noShow };
    row.partyCount = Math.max(row.partyCount, partyCount);
    byTime.set(time, row);
  }

  // Sort times ascending and turn front/back from {idx→obj} maps into
  // dense arrays [slot0, slot1, slot2, slot3] (null for missing slots).
  const rows = Array.from(byTime.values())
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(r => ({
      time: r.time,
      partyCount: r.partyCount,
      front: [0, 1, 2, 3].map(i => r.front[i] || null),
      back:  [0, 1, 2, 3].map(i => r.back[i]  || null)
    }));

  return rows;
}

// ─── Public API ────────────────────────────────────────────────────
//
// getTeeSheet(businessId, date) → { date, rows, fetchedAt, cached }
//
// `date` is YYYY-MM-DD. Returns the cached value when fresh (5 min);
// otherwise fetches, parses, caches, and returns. Throws when the
// admin session isn't available (rare — keep-alive should always keep
// it warm; fresh server boot with no prior call is the one window).

async function getTeeSheet(businessId, date) {
  requireBusinessId(businessId, 'getTeeSheet');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error('date must be YYYY-MM-DD');
  }

  // Cache hit?
  const key = cacheKey(businessId, date);
  const cached = sheetCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  // Need a warm admin session. Try to grab it without forcing a login;
  // if missing (post-deploy window), ensureWarmAdminSession does a
  // single login.
  let cookies = teeonAdmin.getWarmAdminCookies(businessId);
  if (!cookies) {
    cookies = await teeonAdmin.ensureWarmAdminSession(businessId);
  }
  if (!cookies) {
    throw new Error('Admin session unavailable. Configure Tee-On admin credentials in Settings.');
  }

  const courseCode = await getTenantTeeOnCourseCode(businessId);
  if (!courseCode) {
    throw new Error('Tee-On course code not configured for this business.');
  }

  const res = await httpsRequest({
    method: 'GET',
    path: `${TEE_SHEET_PATH}?Course=${courseCode}&Date=${encodeURIComponent(date)}&Default=true`,
    headers: { Cookie: cookies, Referer: `https://${TEEON_HOST}${TEE_SHEET_PATH}?Default=true` }
  });

  if (res.status >= 400 || !res.body) {
    throw new Error(`Tee-On returned ${res.status} (body=${res.body?.length || 0}b)`);
  }

  const rows = parseAdminTeeSheetHTML(res.body);
  const fetchedAt = Date.now();
  sheetCache.set(key, { date, rows, fetchedAt });
  console.log(
    `[tenant:${businessId}] [TeeSheet-Mirror] fetched ${date}: ${rows.length} rows ` +
    `(${rows.reduce((n, r) => n + r.front.filter(Boolean).length + r.back.filter(Boolean).length, 0)} player tiles)`
  );
  return { date, rows, fetchedAt, cached: false };
}

/**
 * Invalidate the cache for a (businessId, date) pair. Useful when we
 * know a booking just changed and want the Command Center to reflect
 * it without waiting 5 minutes. createBooking + cancelBooking could
 * call this in the future; for now it's exported for manual use.
 */
function invalidate(businessId, date) {
  sheetCache.delete(cacheKey(businessId, date));
}

module.exports = { getTeeSheet, parseAdminTeeSheetHTML, invalidate };
