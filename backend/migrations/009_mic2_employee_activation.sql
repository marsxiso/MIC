BEGIN;

-- Allow an employee account to exist before the first password is set.
ALTER TABLE mic2.employees
  ALTER COLUMN password_hash DROP NOT NULL;

-- Store only a hash of the one-time activation code and its expiry.
ALTER TABLE mic2.employees
  ADD COLUMN activation_code_hash TEXT,
  ADD COLUMN activation_expires_at TIMESTAMPTZ;

-- Activation hash and expiry must always be present or absent together.
ALTER TABLE mic2.employees
  ADD CONSTRAINT employees_activation_pair_ck
  CHECK (
    (activation_code_hash IS NULL AND activation_expires_at IS NULL)
    OR
    (activation_code_hash IS NOT NULL AND activation_expires_at IS NOT NULL)
  ) NOT VALID;

-- An account must have either a password or a pending activation code.
-- NOT VALID preserves compatibility with any historical rows while enforcing
-- the rule for new inserts and subsequent updates.
ALTER TABLE mic2.employees
  ADD CONSTRAINT employees_password_or_activation_ck
  CHECK (password_hash IS NOT NULL OR activation_code_hash IS NOT NULL)
  NOT VALID;

COMMIT;
