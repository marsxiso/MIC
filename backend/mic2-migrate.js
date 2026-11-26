require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required before applying MIC 2.0 migrations');
}

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal || process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10000,
});

function readMigrations() {
  const directory = path.join(__dirname, 'migrations');
  return fs.readdirSync(directory)
    .filter((name) => /^00[1-7]_.*\.sql$/.test(name))
    .sort()
    .map((name) => {
      const fullPath = path.join(directory, name);
      const originalSql = fs.readFileSync(fullPath, 'utf8');
      const sql = originalSql
        .replace(/^\s*BEGIN\s*;\s*/i, '')
        .replace(/\s*COMMIT\s*;\s*$/i, '')
        .trim();

      if (!sql) throw new Error(\`Migration \${name} is empty\`);
      return {
        name,
        sql,
        checksum: crypto.createHash('sha256').update(originalSql).digest('hex'),
      };
    });
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS mic2');
    await client.query(\`
      CREATE TABLE IF NOT EXISTS mic2.schema_migrations (
        migration_name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    \`);

    for (const migration of readMigrations()) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [20482026]);
        const existing = await client.query(
          'SELECT checksum FROM mic2.schema_migrations WHERE migration_name = $1',
          [migration.name],
        );

        if (existing.rows.length) {
          if (existing.rows[0].checksum !== migration.checksum) {
            throw new Error(\`Applied migration \${migration.name} has changed; refusing to continue\`);
          }
          await client.query('COMMIT');
          process.stdout.write(\`Already applied: \${migration.name}\n\`);
          continue;
        }

        await client.query(migration.sql);
        await client.query(
          'INSERT INTO mic2.schema_migrations (migration_name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        process.stdout.write(\`Applied: \${migration.name}\n\`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(\`Migration \${migration.name} failed: \${error.message}\`);
      }
    }

    process.stdout.write('MIC 2.0 database migrations are up to date.\n');
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    process.stderr.write(\`MIC 2.0 migration error: \${error.message}\n\`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
