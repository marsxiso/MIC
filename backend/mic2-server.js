require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3001);
const jwtSecret = process.env.JWT_SECRET;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the MIC 2.0 backend');
}

if (!jwtSecret || Buffer.byteLength(jwtSecret, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be set and contain at least 32 bytes');
}

const databaseIsLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseIsLocal || process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  console.error('MIC 2.0 PostgreSQL pool error:', error.message);
});

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '1mb' }));

function publicEmployee(row) {
  return {
    id: String(row.id),
    employee_no: row.employee_no,
    full_name: row.full_name,
    department: row.department,
    job_title: row.job_title,
    role_code: row.role_code,
    role_title: row.role_title,
    must_change_password: row.must_change_password,
  };
}

async function findActiveEmployeeById(id) {
  const result = await pool.query(
    `SELECT
       e.id, e.employee_no, e.full_name, e.department, e.job_title,
       e.role_code, r.title AS role_title, e.must_change_password
     FROM mic2.employees e
     JOIN mic2.roles r ON r.code = e.role_code
     WHERE e.id = $1
       AND e.account_status = 'active'
       AND e.terminated_at IS NULL`,
    [id],
  );
  return result.rows[0] || null;
}

async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ ok: false, message: 'Требуется авторизация' });
  }

  try {
    const payload = jwt.verify(match[1], jwtSecret, { algorithms: ['HS256'] });
    if (!payload.sub) {
      return res.status(401).json({ ok: false, message: 'Недействительный токен' });
    }

    const employee = await findActiveEmployeeById(payload.sub);
    if (!employee) {
      return res.status(401).json({ ok: false, message: 'Учётная запись неактивна' });
    }

    req.employee = publicEmployee(employee);
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, message: 'Сессия недействительна или истекла' });
    }
    next(error);
  }
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'MIC 2.0 API' });
});

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1 FROM mic2.employees LIMIT 1');
    res.json({ ok: true, service: 'MIC 2.0 API', database: 'connected' });
  } catch (error) {
    next(error);
  }
});


app.post('/api/setup/administrator', async (req, res, next) => {
  const bootstrapToken = process.env.MIC2_BOOTSTRAP_TOKEN || '';
  const suppliedToken = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  if (Buffer.byteLength(bootstrapToken, 'utf8') < 32) {
    return res.status(404).json({ ok: false, message: 'Маршрут недоступен' });
  }

  const expected = Buffer.from(bootstrapToken, 'utf8');
  const supplied = Buffer.from(suppliedToken, 'utf8');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return res.status(401).json({ ok: false, message: 'Недействительный ключ настройки' });
  }

  const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const fullName = typeof req.body?.full_name === 'string' && req.body.full_name.trim()
    ? req.body.full_name.trim()
    : 'MIC 2.0 Administrator';

  if (!login || login.length > 100 || password.length < 12 || password.length > 200) {
    return res.status(400).json({ ok: false, message: 'Укажите логин и пароль длиной от 12 символов' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mic2-first-administrator'))");

    const existing = await client.query(
      "SELECT id FROM mic2.employees WHERE role_code = 'administrator' LIMIT 1",
    );
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, message: 'Администратор уже создан' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await client.query(
      `INSERT INTO mic2.employees (
         full_name, department, job_title, role_code, login, password_hash,
         must_change_password, account_status
       )
       VALUES ($1, 'administration', 'Administrator', 'administrator', $2, $3, TRUE, 'active')
       RETURNING id, login`,
      [fullName, login, passwordHash],
    );

    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      message: 'Первый администратор MIC 2.0 создан',
      employee: { id: String(created.rows[0].id), login: created.rows[0].login },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      return res.status(409).json({ ok: false, message: 'Такой логин уже существует' });
    }
    return next(error);
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!login || !password) {
      return res.status(400).json({ ok: false, message: 'Введите логин и пароль' });
    }

    const result = await pool.query(
      `SELECT
         e.id, e.employee_no, e.full_name, e.department, e.job_title,
         e.role_code, r.title AS role_title, e.password_hash,
         e.must_change_password
       FROM mic2.employees e
       JOIN mic2.roles r ON r.code = e.role_code
       WHERE lower(e.login) = lower($1)
         AND e.account_status = 'active'
         AND e.terminated_at IS NULL
       LIMIT 1`,
      [login],
    );

    const employee = result.rows[0];
    const passwordIsValid = employee
      ? await bcrypt.compare(password, employee.password_hash)
      : false;

    if (!passwordIsValid) {
      return res.status(401).json({ ok: false, message: 'Неверный логин или пароль' });
    }

    const token = jwt.sign(
      { sub: String(employee.id), role: employee.role_code },
      jwtSecret,
      { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
    );

    res.json({
      ok: true,
      token,
      token_type: 'Bearer',
      expires_in: process.env.JWT_EXPIRES_IN || '8h',
      employee: publicEmployee(employee),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ ok: true, employee: req.employee });
});

app.use((error, _req, res, _next) => {
  console.error('MIC 2.0 API error:', error.message);
  res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера' });
});

const server = app.listen(port, () => {
  console.log(`MIC 2.0 API listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down MIC 2.0 API`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
