const { Pool } = require('pg');
const bcrypt = require('bcrypt');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const password = process.env.MIC2_ADMIN_PASSWORD;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!password || password.length < 12) throw new Error('MIC2_ADMIN_PASSWORD must contain at least 12 characters');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    idleTimeoutMillis: 5000,
  });

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `UPDATE mic2.employees
       SET password_hash = $1,
           must_change_password = TRUE,
           updated_at = NOW()
       WHERE lower(login) = 'admin'
         AND role_code = 'administrator'
         AND account_status = 'active'
         AND terminated_at IS NULL
       RETURNING id, login, full_name, role_code`,
      [hash],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Expected exactly one active MIC2 admin account named admin; updated ${result.rowCount}`);
    }
    console.log('MIC2 administrator password updated successfully.');
    console.log('Existing account retained:', result.rows[0]);
    console.log('No account was created or deleted.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('MIC2 admin password reset failed:', error.message);
  process.exitCode = 1;
});
