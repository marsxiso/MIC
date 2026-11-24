const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const PASSWORD_MIN_LENGTH = 12;
const ACTIVATION_TTL_MINUTES = 15;
const BCRYPT_ROUNDS = 12;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured and contain at least 32 bytes');
  }
  return secret;
}

function createActivationCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

async function hashActivationCode(code) {
  return bcrypt.hash(String(code), BCRYPT_ROUNDS);
}

async function verifyActivationCode(code, codeHash) {
  if (!code || !codeHash) return false;
  return bcrypt.compare(String(code), codeHash);
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    const error = new Error(`Пароль должен содержать не менее ${PASSWORD_MIN_LENGTH} символов`);
    error.status = 400;
    throw error;
  }
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, passwordHash) {
  if (!password || !passwordHash) return false;
  return bcrypt.compare(String(password), passwordHash);
}

function activationExpiry() {
  return new Date(Date.now() + ACTIVATION_TTL_MINUTES * 60 * 1000);
}

function issueToken(identity) {
  const payload = {
    sub: String(identity.id),
    kind: identity.kind,
    role: identity.role,
  };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '8h', issuer: 'mic-api', audience: 'mic-app' });
}

function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ ok: false, message: 'Требуется вход в систему' });
  try {
    req.auth = jwt.verify(match[1], getJwtSecret(), {
      issuer: 'mic-api',
      audience: 'mic-app',
    });
    next();
  } catch {
    return res.status(401).json({ ok: false, message: 'Сеанс истёк. Войдите снова' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    }
    next();
  };
}

module.exports = {
  getJwtSecret,
  PASSWORD_MIN_LENGTH,
  ACTIVATION_TTL_MINUTES,
  createActivationCode,
  hashActivationCode,
  verifyActivationCode,
  hashPassword,
  verifyPassword,
  activationExpiry,
  issueToken,
  authenticate,
  requireRole,
};
