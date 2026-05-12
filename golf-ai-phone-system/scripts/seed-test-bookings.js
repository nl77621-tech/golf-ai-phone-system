#!/usr/bin/env node
/**
 * scripts/seed-test-bookings.js
 *
 * Inserts "pending" booking_requests rows into the DB so you can test
 * the Command Center "Confirm" → Tee-On flow without burning real phone
 * calls.
 *
 * Run against PROD via Railway's public Postgres proxy:
 *
 *   DATABASE_URL="$(railway variables --service Postgres --kv \
 *     | grep '^DATABASE_PUBLIC_URL=' | sed 's/^DATABASE_PUBLIC_URL=//')" \
 *     node scripts/seed-test-bookings.js [--auto] [--times=...] [...]
 *
 * MODES:
 *
 *   --auto              Query the LIVE Tee-On admin sheet for the date and
 *                       pick N slots that have at least --party seats open
 *                       RIGHT NOW. This avoids the "slot full" failure mode
 *                       that hits when stale check_tee_times data is used.
 *                       Use --count=N to control how many (default 3) and
 *                       --spread=morning|afternoon|evening|all (default
 *                       afternoon).
 *
 *   --times=HH:MM,...   Explicit times. Skip auto-detect entirely.
 *
 *   (default)           Hard-coded afternoon times. Same as the original
 *                       script. Fastest but may hit full slots.
 *
 * OTHER FLAGS:
 *
 *   --date=YYYY-MM-DD    default: today in America/Toronto
 *   --business=N         default: 1 = Valleymede
 *   --name="First Last"  default: "Test Caller"
 *   --phone=+1416...     default: a test number
 *   --party=N            default: 2
 *   --holes=18|9         default: 18
 *   --carts=N            default: 1
 *
 * Output: prints the inserted IDs and where to find them in the UI.
 */

const path = require('path');

// Make sure we're running from the project root so server/* resolves.
process.chdir(path.join(__dirname, '..'));

const { query, getBusinessById } = require('../server/config/database');

// ─── arg parsing ──────────────────────────────────────────────────────
function parseArgs() {
  const out = { _flags: new Set() };
  for (const arg of process.argv.slice(2)) {
    const kv = arg.match(/^--([^=]+)=(.*)$/);
    if (kv) {
      out[kv[1]] = kv[2];
    } else {
      const flag = arg.match(/^--([^=]+)$/);
      if (flag) out._flags.add(flag[1]);
    }
  }
  return out;
}
const args = parseArgs();

const BUSINESS_ID    = Number(args.business || 1);
const CUSTOMER_NAME  = args.name  || 'Test Caller';
const CUSTOMER_PHONE = args.phone || '+14160001111';
const PARTY_SIZE     = Number(args.party  || 2);
const HOLES          = Number(args.holes  || 18);
const NUM_CARTS      = Number(args.carts  || 1);
const COUNT          = Number(args.count   || 3);
const SPREAD         = args.spread || 'afternoon';
const AUTO           = args._flags.has('auto');

// Default fallback times if neither --auto nor --times is passed
const DEFAULT_TIMES = ['14:30', '15:30', '16:30'];

// ─── date default = today in business's timezone ──────────────────────
async function resolveDate() {
  if (args.date) return args.date;
  const business = await getBusinessById(BUSINESS_ID).catch(() => null);
  const tz = business?.timezone || 'America/Toronto';
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

// ─── auto-detect: pick currently-open slots from the live tee sheet ──
//
// Uses tee-sheet-mirror.getTeeSheet which calls into Tee-On's admin
// sheet (same source the AI uses). Returns an array of "HH:MM" 24-hour
// strings — one per row that has ≥ partySize seats open on Front 9 and
// is within the requested spread window.
function timeInSpread(hhmm, spread) {
  if (spread === 'all') return true;
  const h = parseInt(hhmm.split(':')[0], 10);
  if (spread === 'morning')   return h < 12;
  if (spread === 'afternoon') return h >= 12 && h < 17;
  if (spread === 'evening')   return h >= 17;
  return true;
}

async function detectOpenTimes(date) {
  // Lazy require — only needed in --auto mode, and tee-sheet-mirror
  // pulls in teeon-admin which does its own session setup.
  const mirror = require('../server/services/tee-sheet-mirror');
  console.log(`  ↻ Fetching live Tee-On sheet for ${date} to find open slots...`);
  const { rows } = await mirror.getTeeSheet(BUSINESS_ID, date);

  // Filter: Front 9 column, in-spread, at least PARTY_SIZE seats open.
  // We pick Front because that's the default 18-hole bookable column
  // and matches what the seed-then-confirm flow tries to book.
  const candidates = [];
  for (const row of rows) {
    if (!row.hasFront) continue;
    if (!timeInSpread(row.time, SPREAD)) continue;
    const occupied = (row.front || []).filter(Boolean).length;
    const open = 4 - occupied;
    if (open >= PARTY_SIZE) {
      candidates.push({ time: row.time, open });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No Front-9 slots on ${date} in spread="${SPREAD}" have ${PARTY_SIZE}+ seats open. ` +
      `Try --spread=all, a smaller --party, or a different --date.`
    );
  }

  // Pick COUNT slots spread evenly across the candidate list (not just
  // the first N — those tend to cluster at the boundary of the spread).
  const step = Math.max(1, Math.floor(candidates.length / COUNT));
  const picked = [];
  for (let i = 0; i < candidates.length && picked.length < COUNT; i += step) {
    picked.push(candidates[i]);
  }

  console.log(`  ↻ Found ${candidates.length} candidate slot(s); picked ${picked.length}:`);
  for (const p of picked) {
    console.log(`     - ${p.time}  (${p.open}/4 open)`);
  }
  return picked.map(p => p.time);
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  const date = await resolveDate();

  // Resolve which times to seed
  let times;
  if (args.times) {
    times = args.times.split(',').map(s => s.trim()).filter(Boolean);
  } else if (AUTO) {
    times = await detectOpenTimes(date);
  } else {
    times = DEFAULT_TIMES;
  }

  console.log('');
  console.log('Seeding test booking_requests:');
  console.log('  business_id:    ', BUSINESS_ID);
  console.log('  customer:       ', CUSTOMER_NAME, '/', CUSTOMER_PHONE);
  console.log('  date:           ', date);
  console.log('  times:          ', times.join(', '));
  console.log('  party / holes:  ', `${PARTY_SIZE}p / ${HOLES}h`);
  console.log('  carts:          ', NUM_CARTS);
  console.log('  mode:           ', AUTO ? `auto-detect (${SPREAD})` : (args.times ? 'explicit --times' : 'default times'));
  console.log('');

  const inserted = [];
  for (const time of times) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      console.warn(`  SKIP "${time}" — not HH:MM`);
      continue;
    }

    // Insert as 'pending' so it shows up in the Command Center bookings
    // tab with the "Confirm" / "Reject" actions. teeon_booking_id stays
    // NULL until createBooking runs on confirm.
    const res = await query(
      `INSERT INTO booking_requests
         (business_id, customer_name, customer_phone, requested_date,
          requested_time, party_size, num_carts, holes,
          special_requests, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING id`,
      [
        BUSINESS_ID,
        CUSTOMER_NAME,
        CUSTOMER_PHONE,
        date,
        time,
        PARTY_SIZE,
        NUM_CARTS,
        HOLES,
        'SEEDED test booking — click Confirm to push to Tee-On'
      ]
    );
    const id = res.rows[0].id;
    inserted.push({ id, time });
    console.log(`  ✓ #${id}  ${date} ${time}  ${PARTY_SIZE}p ${HOLES}h ${NUM_CARTS} cart(s)`);
  }

  console.log('');
  console.log(`Inserted ${inserted.length} booking(s). Open Command Center → Bookings,`);
  console.log('find the rows tagged "SEEDED test booking" and click Confirm to test the Tee-On flow.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
