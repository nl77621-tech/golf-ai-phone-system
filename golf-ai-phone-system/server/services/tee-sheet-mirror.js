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
const { getBusinessById } = require('../config/database');
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

  // ─── Step 1: find every BOOKED tile ───────────────────────────────
  // Tee-On wraps each booked tile in a <div class="...player..."
  // onclick="submitExistingTime('06:24','F','COLU4130',true,2,0);">…</div>.
  // Captured groups:
  //   1: classes on the div (paid / no-show / etc.)
  //   2: time (HH:MM)
  //   3: nine (F or B)
  //   4: bookerId
  //   5: party count int
  //   6: slot index (0..3)
  //   7: inner content (player display name)
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

    const row = byTime.get(time) || { time, front: {}, back: {}, partyCount: 0, hasFront: false, hasBack: false };
    const side = nine === 'B' ? row.back : row.front;
    side[slotIndex] = { slotIndex, name, bookerId, holes, hasCart, paid, noShow };
    if (nine === 'B') row.hasBack = true; else row.hasFront = true;
    row.partyCount = Math.max(row.partyCount, partyCount);
    byTime.set(time, row);
  }

  // ─── Step 2: find every EMPTY slot handler ────────────────────────
  // Tee-On exposes empty slots via submitTime('HH:MM','F'|'B', ...) on
  // clickable tiles or row anchors. We don't need extra metadata for
  // these — just the (time, nine) pair so we register the row exists.
  // Without this step the live page only shows times that have at
  // least one booking, hiding genuinely open slots from staff.
  //
  // The regex is liberal — matches submitTime('HH:MM','F') or
  // submitTime('HH:MM','F', anything). Tee-On may also use related
  // helpers like submitNewTime / openTime; we keep the match narrow
  // to submitTime to avoid false positives.
  const emptyRe = /submitTime\('(\d{1,2}:\d{2})','([A-Z])'/gi;
  let e;
  while ((e = emptyRe.exec(html)) !== null) {
    const time = e[1];
    const nine = e[2];
    const row = byTime.get(time) || { time, front: {}, back: {}, partyCount: 0, hasFront: false, hasBack: false };
    // Just register the (time, nine) pair as "this slot is real on the
    // sheet". Front/back arrays stay empty so the UI renders "— empty —".
    if (nine === 'B') row.hasBack = true; else row.hasFront = true;
    byTime.set(time, row);
  }

  // ─── Step 3: assemble dense rows ──────────────────────────────────
  // Sort times ascending and turn front/back from {idx→obj} maps into
  // dense arrays [slot0, slot1, slot2, slot3] (null for empty seats).
  // `hasFront` / `hasBack` tell the UI whether the nine is offered at
  // this time at all (some early/late slots are F-only, etc.) so we
  // can render "(no Back 9 at this time)" vs an empty bookable column.
  const rows = Array.from(byTime.values())
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(r => ({
      time: r.time,
      partyCount: r.partyCount,
      front: [0, 1, 2, 3].map(i => r.front[i] || null),
      back:  [0, 1, 2, 3].map(i => r.back[i]  || null),
      hasFront: r.hasFront,
      hasBack: r.hasBack
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
  // single login. Each step logs so we can see WHERE failure happens
  // if "Admin session unavailable" fires again.
  let cookies = teeonAdmin.getWarmAdminCookies(businessId);
  console.log(`[tenant:${businessId}] [TeeSheet-Mirror] warm cookies cached: ${cookies ? 'YES' : 'no'}`);
  if (!cookies) {
    cookies = await teeonAdmin.ensureWarmAdminSession(businessId);
    console.log(`[tenant:${businessId}] [TeeSheet-Mirror] ensureWarmAdminSession returned: ${cookies ? 'cookies present' : 'NULL'}`);
  }
  if (!cookies) {
    throw new Error('Admin session unavailable. Configure Tee-On admin credentials in Settings.');
  }

  const courseCode = await getTenantTeeOnCourseCode(businessId);
  console.log(`[tenant:${businessId}] [TeeSheet-Mirror] resolved courseCode: ${courseCode || 'NULL'}`);
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

/**
 * Convert "06:30" (24h) → "6:30 AM" so the slot objects match the
 * shape that teeon-automation.js's parseTimesFromHTML produces.
 */
function hhmm24To12(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mins = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${mins} ${ampm}`;
}

/**
 * Returns flat slot objects (in the same shape teeon-automation's
 * public-sheet parser produces) so check_tee_times can consume them
 * as a drop-in replacement / merge source.
 *
 * The admin tee sheet is authoritative — it shows EVERY slot staff
 * can book, including same-day near-term slots that Tee-On's public
 * sheet silently filters out within ~1 hour of "now". The Live
 * Tee-On page already proves the parser is accurate; this function
 * is just a re-shape of the same data.
 *
 * Returns: Array<{ time, raw, course, holes, price?, minPlayers, maxPlayers }>
 *
 * Throws when the admin session is unavailable (caller should fall
 * back to the public-sheet path).
 */
async function getOpenSlotsForBooking(businessId, date) {
  const sheet = await getTeeSheet(businessId, date);

  // ─── Past-slot filter ───────────────────────────────────────────
  //
  // The admin tee sheet shows EVERY slot for the day — including
  // slots in the past. The public sheet used to drop them for us; now
  // that we're admin-only (PR #38), we have to drop them ourselves.
  // Real-call bug observed 2026-05-12 10:50 EDT: caller asked for
  // earliest available today, AI offered 7:02 AM. 7:02 AM was 3+
  // hours in the past — clearly unbookable.
  //
  // Logic: if the requested date is TODAY in the business's local
  // timezone, drop every slot whose HH:MM is earlier than the
  // current wall-clock time in that same timezone. For future dates,
  // pass through unchanged.
  let nowLocalHHMM = null;
  let isToday = false;
  try {
    const business = await getBusinessById(businessId).catch(() => null);
    const tz = business?.timezone || 'America/Toronto';
    const now = new Date();
    const localDateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    isToday = (localDateStr === date);
    if (isToday) {
      // "HH:MM" 24h in the tenant's local time, with leading zeros so
      // string compare against row.time ("HH:MM") works lexically.
      nowLocalHHMM = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
    }
  } catch {
    // If anything goes wrong resolving the timezone, fail open — don't
    // accidentally hide future slots. The "past slot offered" bug is
    // worse than not filtering, but only barely; we log so ops can
    // see it.
    console.warn(`[tenant:${businessId}] [TeeSheet-Mirror] past-slot filter skipped (timezone resolution failed)`);
  }

  const out = [];
  let droppedPast = 0;
  for (const row of sheet.rows) {
    // Drop past slots when the request is for today. row.time is
    // already in "HH:MM" 24h form, same as nowLocalHHMM.
    if (isToday && nowLocalHHMM && row.time < nowLocalHHMM) {
      droppedPast++;
      continue;
    }

    const time12 = hhmm24To12(row.time);
    if (!time12) continue;

    // Front 9 column — bookable as 18-hole (start hole 1). We emit
    // even when fully empty (maxPlayers=4); the downstream filter in
    // check_tee_times drops slots that don't fit the party size.
    if (row.hasFront) {
      const occupied = Array.isArray(row.front) ? row.front.filter(Boolean).length : 0;
      const maxPlayers = Math.max(0, 4 - occupied);
      out.push({
        time: time12,
        raw: time12.replace(' ', ''),
        course: '18 holes (starts hole 1)',
        holes: 18,
        price: null,           // not parsed yet; existing flow surfaces price elsewhere
        minPlayers: 1,
        maxPlayers
      });
    }

    // Back 9 column — bookable as 9-hole (start hole 10). Per the
    // per-tenant nine_hole_windows policy already applied downstream
    // in check_tee_times, slots outside the window get filtered out;
    // we just emit what the admin sheet shows.
    if (row.hasBack) {
      const occupied = Array.isArray(row.back) ? row.back.filter(Boolean).length : 0;
      const maxPlayers = Math.max(0, 4 - occupied);
      out.push({
        time: time12,
        raw: time12.replace(' ', ''),
        course: '9 holes only (starts hole 10)',
        holes: 9,
        price: null,
        minPlayers: 1,
        maxPlayers
      });
    }
  }

  if (droppedPast > 0) {
    console.log(`[tenant:${businessId}] [TeeSheet-Mirror] dropped ${droppedPast} past slot(s) for ${date} (now=${nowLocalHHMM})`);
  }
  return out;
}

module.exports = { getTeeSheet, parseAdminTeeSheetHTML, invalidate, getOpenSlotsForBooking };
