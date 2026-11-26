-- MIC 2.0: preserve the existing administrator account from the legacy MIC schema.
-- The old public.users record remains untouched; only its login and bcrypt hash
-- are copied into the isolated MIC 2.0 employee directory.

BEGIN;

INSERT INTO mic2.employees (
  full_name,
  department,
  job_title,
  role_code,
  login,
  password_hash,
  must_change_password,
  account_status
)
SELECT
  u.full_name,
  'administration',
  'Администратор',
  'administrator',
  u.login,
  u.password_hash,
  FALSE,
  'active'
FROM public.users u
WHERE u.role = 'Администратор'
  AND u.login = 'admin'
  AND u.password_hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM mic2.employees e
    WHERE lower(e.login) = lower(u.login)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM mic2.employees e
    WHERE e.role_code = 'administrator'
  );

COMMIT;
