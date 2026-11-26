require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

async function main() {
  const login = (process.env.MIC2_ADMIN_LOGIN || '').trim();
  const password = process.env.MIC2_ADMIN_PASSWORD || '';
  const fullName = (process.env.MIC2_ADMIN_NAME || 'MIC 2.0 Administrator').trim();

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!login || password.length < 12) {
    throw new Error('Set MIC2_ADMIN_LOGIN and MIC2_ADMIN_PASSWORD (minimum 12 characters)');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\\.0\\.0\\.1/.test(process.env.DATABASE_URL) || process.env.PGSSLMODE === 'disable'
      ? false
      : { rejectUnauthorized: false },
  });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO mic2.employees (
         full_name, department, job_title, role_code, login, password_hash,
         must_change_password, account_status
       )
       VALUES ($1, 'administration', 'Administrator', 'administrator', $2, $3, TRUE, 'active')
       RETURNING id, login`,
      [fullName, login, passwordHash],
    );
    process.stdout.write(`Created MIC 2.0 administrator: ${result.rows[0].login} (id ${result.rows[0].id})\\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Administrator bootstrap failed: ${error.message}\\n`);
  process.exitCode = 1;
});
