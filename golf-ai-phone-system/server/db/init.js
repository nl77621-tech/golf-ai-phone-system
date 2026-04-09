/**
 * Database initialization script
 * Run: node server/db/init.js
 * Creates tables and seeds initial data
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function init() {
  const client = await pool.connect();
  try {
    console.log('🔧 Creating database tables...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('✅ Tables created successfully');

    console.log('🌱 Seeding initial data...');
    const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    await client.query(seed);
    console.log('✅ Seed data inserted successfully');

    console.log('🎉 Database initialization complete!');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch(() => process.exit(1));
