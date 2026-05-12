#!/usr/bin/env node
/**
 * scripts/seed-test-bookings.js
 *
 * Inserts a handful of "pending" booking_requests rows into the DB so
 * you can test the Command Center "Confirm" → Tee-On flow without
 * burning real phone calls.
 *
 * Run against PROD (via Railway's env so DATABASE_URL points at
 * production Postgres):
 *
 *   railway run --service golf-ai-phone-system node scripts/seed-test-bookings.js
 *
 * Optional args (override the defaults below):
 *
 *   --date=YYYY-MM-DD    booking date (default: today in America/Toronto)
 *   --times=HH:MM,HH:MM  comma-separated times in 24h local (default: a
 *                        small spread later in the afternoon)
 *   --business=N         business_id (default: 1 = Valleymede)
 *   --name="First Last"  customer name (default: "Test Caller")
 *   --phone=+1416...     customer phone (default: a test number)
 *   --party=N            party size (default: 2 — small parties fit in
 *                        a partially-booked slot, easier to test)
 *   --holes=18|9         holes (default: 18)
 *   --carts=N            num_carts (default: 1)
 *
 * Output: prints the inserted IDs and where to find them in the UI.
 */

const path = require('path');

// Make sure we're running from the project root so server/config/database
// resolves correctly. The script supports being invoked from anywhere.
process.chdir(path.join(__dirname, '..'));

const { query, getBusinessById } = require('../server/config/database');

// ─── arg parsing ──────────────────────────────────────────────────────
function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
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

// Default: a few spread-out afternoon times that are usually open at
// Valleymede. Override with --times=HH:MM,HH:MM,...
const DEFAULT_TIMES = ['14:30', '15:30', '16:30'];
const TIMES = (args.times || DEFAULT_TIMES.join(',')).split(',').map(s => s.trim()).filter(Boolean);

// ─── date default = today in business's timezone ──────────────────────
async function resolveDate() {
  if (args.date) return args.date;
  const business = await getBusinessById(BUSINESS_ID).catch(() => null);
  const tz = business?.timezone || 'America/Toronto';
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  const date = await resolveDate();

  console.log('Seeding test booking_requests:');
  console.log('  business_id:    ', BUSINESS_ID);
  console.log('  customer:       ', CUSTOMER_NAME, '/', CUSTOMER_PHONE);
  console.log('  date:           ', date);
  console.log('  times:          ', TIMES.join(', '));
  console.log('  party / holes:  ', `${PARTY_SIZE}p / ${HOLES}h`);
  console.log('  carts:          ', NUM_CARTS);
  console.log('');

  const inserted = [];
  for (const time of TIMES) {
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
