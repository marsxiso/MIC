-- Additive MIC authentication migration.
-- Safe for existing accounts: no rows are deleted and current passwords are not rewritten.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE workers ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS activation_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS activation_expires_at TIMESTAMPTZ;

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS activation_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS activation_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_activation_expiry_idx
  ON users (activation_expires_at)
  WHERE activation_code_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS workers_activation_expiry_idx
  ON workers (activation_expires_at)
  WHERE activation_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_attempts (
  login_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (login_key, ip_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_login_unique_idx
  ON users (login)
  WHERE login IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workers_login_unique_idx
  ON workers (login)
  WHERE login IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  login_key TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
