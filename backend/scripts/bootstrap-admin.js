require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const required = ['DATABASE_URL', 'MIC_ADMIN_LOGIN', 'MIC_ADMIN_NAME', 'MIC_ADMIN_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
if (process.env.MIC_ADMIN_PASSWORD.length < 12) {
  console.error('MIC_ADMIN_PASSWORD must contain at least 12 characters.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users LIMIT 1');
    if (existing.rowCount > 0) {
      throw new Error('Bootstrap refused: a user account already exists.');
    }
    const login = process.env.MIC_ADMIN_LOGIN.trim();
    const name = process.env.MIC_ADMIN_NAME.trim();
    if (!login || !name) throw new Error('Admin login and name cannot be empty.');

    const passwordHash = await bcrypt.hash(process.env.MIC_ADMIN_PASSWORD, 12);
    const inserted = await client.query(
      `INSERT INTO users (full_name, login, password_hash, role)
       VALUES ($1, $2, $3, 'Администратор')
       RETURNING id, login, full_name, role`,
      [name, login, passwordHash]
    );
    await client.query('COMMIT');
    console.log('Initial administrator created:', inserted.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message || 'Bootstrap failed.');
  process.exit(1);
});
