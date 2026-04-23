/**
 * Database initialization script
 * Run: node server/db/init.js
 *
 * Applies (in order):
 *   1. schema.sql           — full multi-tenant schema (idempotent, safe no-op
 *                             on legacy DBs where tenant tables already exist)
 *   2. migrations/*.sql     — ordered migrations, tracked in the `migrations`
 *                             table. Must run before seed.sql so that any
 *                             columns seed.sql expects (e.g. business_id)
 *                             are guaranteed to exist on legacy DBs.
 *   3. seed.sql             — Valleymede defaults; idempotent via ON CONFLICT
 *                             and NOT EXISTS guards.
 *
 * Safe to run repeatedly. Every step is idempotent.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function applySchema(client) {
  console.log('🔧 Applying schema.sql...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(schema);
  console.log('✅ schema.sql applied');
}

async function applySeed(client) {
  console.log('🌱 Applying seed.sql...');
  const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
  await client.query(seed);
  console.log('✅ seed.sql applied');
}

async function applyMigrations(client) {
  // Ensure the ledger exists (schema.sql creates it, but guard anyway
  // in case a DB predates schema.sql adding it).
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('ℹ️  No migrations/ directory — skipping');
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const name = file.replace(/\.sql$/, '');
    const applied = await client.query(
      'SELECT 1 FROM migrations WHERE name = $1',
      [name]
    );
    if (applied.rows.length > 0) {
      console.log(`⏭️  Migration already applied: ${name}`);
      continue;
    }

    console.log(`🧱 Applying migration: ${name}`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration manages its own transaction; we don't wrap here.
    await client.query(sql);
    // The migration is expected to INSERT its own ledger row, but in
    // case it didn't we insert one here as a belt-and-braces.
    await client.query(
      'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [name]
    );
    console.log(`✅ Migration applied: ${name}`);
  }
}

/**
 * Acquire a pool client with retry/backoff.
 *
 * On Railway (and any container platform) the app process can boot
 * before Postgres is accepting connections. A single failed connect
 * would crash `npm prestart`, fail the deploy, and (thanks to Railway's
 * atomic deploys) keep the previous version active — safe, but noisy.
 * To avoid spurious failed deploys on cold starts we retry for ~30s.
 */
async function connectWithRetry(maxAttempts = 15, delayMs = 2000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await pool.connect();
      if (attempt > 1) {
        console.log(`✅ Postgres reachable on attempt ${attempt}`);
      }
      return client;
    } catch (err) {
      lastErr = err;
      console.warn(
        `⏳ Postgres not ready (attempt ${attempt}/${maxAttempts}): ${err.message}`
      );
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function init() {
  console.log('🚀 Running database initialization (prestart hook)...');
  const client = await connectWithRetry();
  try {
    await applySchema(client);
    await applyMigrations(client);
    await applySeed(client);
    console.log('🎉 Database initialization complete!');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  init().catch(() => process.exit(1));
}

module.exports = { init, applySchema, applySeed, applyMigrations };
