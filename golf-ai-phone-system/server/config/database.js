const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

// Helper: run a query
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 80));
  }
  return res;
}

// Helper: get a single setting by key
async function getSetting(key) {
  const res = await query('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rows.length === 0) return null;
  return res.rows[0].value;
}

// Helper: update a setting
async function updateSetting(key, value, description) {
  const res = await query(
    `INSERT INTO settings (key, value, description, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, description = COALESCE($3, settings.description), updated_at = NOW()
     RETURNING *`,
    [key, JSON.stringify(value), description]
  );
  return res.rows[0];
}

module.exports = { pool, query, getSetting, updateSetting };
