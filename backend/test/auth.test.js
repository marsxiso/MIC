const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createActivationCode,
  hashActivationCode,
  verifyActivationCode,
  hashPassword,
  verifyPassword,
  activationExpiry,
  issueToken,
  authenticate,
  requireRole,
} = require('../auth');

test('activation codes are six digits', () => {
  const code = createActivationCode();
  assert.match(code, /^\d{6}$/);
});

test('activation code hashes verify only the original code', async () => {
  const hash = await hashActivationCode('123456');
  assert.equal(await verifyActivationCode('123456', hash), true);
  assert.equal(await verifyActivationCode('654321', hash), false);
});

test('passwords are hashed and enforce the minimum length', async () => {
  await assert.rejects(() => hashPassword('short'), /не менее 12/);
  const hash = await hashPassword('a-long-password-123');
  assert.notEqual(hash, 'a-long-password-123');
  assert.equal(await verifyPassword('a-long-password-123', hash), true);
  assert.equal(await verifyPassword('wrong-password-123', hash), false);
});

test('activation expiry is approximately 15 minutes ahead', () => {
  const before = Date.now();
  const expiry = activationExpiry().getTime();
  assert.ok(expiry >= before + 14 * 60 * 1000);
  assert.ok(expiry <= before + 16 * 60 * 1000);
});

test('JWT issuance requires a configured strong secret', () => {
  const previous = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  assert.throws(() => issueToken({ id: 1, kind: 'user', role: 'Администратор' }), /JWT_SECRET/);
  process.env.JWT_SECRET = 'x'.repeat(40);
  const token = issueToken({ id: 1, kind: 'user', role: 'Администратор' });
  assert.equal(typeof token, 'string');
  if (previous === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previous;
});

test('role middleware rejects missing and unauthorized identities', () => {
  const middleware = requireRole('Администратор');
  let statusCode;
  let body;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  middleware({ auth: { role: 'Рабочий' } }, res, () => assert.fail('must reject'));
  assert.equal(statusCode, 403);
  assert.equal(body.ok, false);
});
