require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');
const { authenticate, issueToken, verifyPassword, hashPassword, createActivationCode, hashActivationCode, verifyActivationCode, activationExpiry } = require('./auth');

const app = express();
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

app.set('trust proxy', true);
app.use(cors());
app.use('/uploads', express.static(uploadsDir));
app.use(express.json({ limit: '25mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function runSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  await pool.query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS sent_to_assembly_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS started_by_worker_id INTEGER");
  await pool.query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS assigned_shift_type TEXT DEFAULT 'day'");
  await pool.query("ALTER TABLE workers ADD COLUMN IF NOT EXISTS login VARCHAR(255) UNIQUE");
  await pool.query("ALTER TABLE workers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS login VARCHAR(255)");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(255)");
  await pool.query("ALTER TABLE inspection_defects ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) DEFAULT 'На рассмотрении'");
  const authMigration = fs.readFileSync(path.join(__dirname, 'auth-migration.sql'), 'utf8');
  await pool.query(authMigration);
}

function isAdmin(req) { return ['Администратор', 'admin'].includes(req.auth?.role); }
function isControlRole(req) { return ['Контролер', 'Контрольный мастер', 'controller', 'control_master', 'quality_master', 'admin', 'Администратор'].includes(req.auth?.role); }
function isProductionRole(req) { return ['Производственный мастер', 'production_master', 'admin', 'Администратор'].includes(req.auth?.role); }
function isUserIdentity(req) { return req.auth?.kind === 'user'; }
function isWorkerIdentity(req) { return req.auth?.kind === 'worker'; }

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDateValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const str = String(value).trim();
  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const ruMatch = str.match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  if (ruMatch) {
    const year = ruMatch[3].length === 2 ? `20${ruMatch[3]}` : ruMatch[3];
    return `${year}-${ruMatch[2]}-${ruMatch[1]}`;
  }
  const monthMap = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const engMatch = str.match(/^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{4}))?$/i);
  if (engMatch) {
    const month = monthMap[engMatch[1].slice(0, 3).toLowerCase()];
    if (month) {
      const day = String(engMatch[2]).padStart(2, '0');
      const year = engMatch[3] || '2026';
      return `${year}-${month}-${day}`;
    }
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return str;
}

function mapInspectionRow(row) {
  return {
    id: String(row.id),
    batch_id: String(row.batch_id),
    inspector_id: String(row.inspector_id),
    inspector_name: row.inspector_name,
    inspection_date: normalizeDateValue(row.inspection_date),
    visual_conclusion: row.visual_conclusion || '',
    geometry_conclusion: row.geometry_conclusion || '',
    accepted_count: Number(row.accepted_count || 0),
    rejected_count: Number(row.rejected_count || 0),
    comment: row.comment || '',
    defects: Array.isArray(row.defects) ? row.defects : [],
  };
}

async function getInspectionByBatch(batchId) {
  const result = await pool.query(
    `SELECT
      i.*,
      u.full_name AS inspector_name,
      COALESCE(
        json_agg(
          json_build_object(
            'id', d.id,
            'defect_class', d.defect_class,
            'confidence', d.confidence,
            'affected_count', d.affected_count,
            'comment', d.comment,
            'image_uri', d.image_uri,
            'review_status', COALESCE(d.review_status, 'На рассмотрении')
          )
        ) FILTER (WHERE d.id IS NOT NULL),
        '[]'::json
      ) AS defects
    FROM inspections i
    JOIN users u ON u.id = i.inspector_id
    LEFT JOIN inspection_defects d ON d.inspection_id = i.id
    WHERE i.batch_id = $1
    GROUP BY i.id, u.full_name`,
    [batchId]
  );
  return result.rows[0] ? mapInspectionRow(result.rows[0]) : null;
}

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Server + DB OK' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'DB connection error', error: error.message });
  }
});

async function authIsLocked(login, ip) {
  const result = await pool.query(
    'SELECT locked_until FROM auth_attempts WHERE login_key = $1 AND ip_key = $2',
    [String(login).trim().toLowerCase(), String(ip || 'unknown')]
  );
  return !!result.rows[0]?.locked_until && new Date(result.rows[0].locked_until) > new Date();
}

async function recordAuthFailure(login, ip) {
  await pool.query(
    `INSERT INTO auth_attempts (login_key, ip_key, failed_count, locked_until, updated_at)
     VALUES ($1, $2, 1, NULL, NOW())
     ON CONFLICT (login_key, ip_key) DO UPDATE SET
       failed_count = CASE WHEN auth_attempts.locked_until IS NOT NULL AND auth_attempts.locked_until <= NOW() THEN 1 ELSE auth_attempts.failed_count + 1 END,
       locked_until = CASE WHEN auth_attempts.locked_until IS NOT NULL AND auth_attempts.locked_until <= NOW() THEN NULL WHEN auth_attempts.failed_count >= 4 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
       updated_at = NOW()`,
    [String(login).trim().toLowerCase(), String(ip || 'unknown')]
  );
}

async function clearAuthFailures(login, ip) {
  await pool.query('DELETE FROM auth_attempts WHERE login_key = $1 AND ip_key = $2',
    [String(login).trim().toLowerCase(), String(ip || 'unknown')]);
}

app.post('/auth/activate', async (req, res) => {
  const { login, activation_code, password, password_confirm } = req.body || {};
  if (!login || !activation_code || !password || password !== password_confirm) {
    return res.status(400).json({ ok: false, message: 'Проверьте логин, код и совпадение паролей' });
  }
  if (String(password).length < 12) {
    return res.status(400).json({ ok: false, message: 'Пароль должен содержать не менее 12 символов' });
  }
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (await authIsLocked(login, ip)) return res.status(429).json({ ok: false, message: 'Слишком много попыток. Повторите через 15 минут.' });
    const userResult = await pool.query(
      'SELECT id, login, full_name, role, activation_code_hash, activation_expires_at FROM users WHERE login = $1 LIMIT 1',
      [String(login).trim()]
    );
    let identity = userResult.rows[0] ? { ...userResult.rows[0], kind: 'user' } : null;
    if (!identity) {
      const workerResult = await pool.query(
        'SELECT id, login, full_name, activation_code_hash, activation_expires_at FROM workers WHERE login = $1 LIMIT 1',
        [String(login).trim()]
      );
      if (workerResult.rows[0]) identity = { ...workerResult.rows[0], role: 'Рабочий', kind: 'worker' };
    }
    if (!identity || !identity.activation_code_hash ||
        !identity.activation_expires_at || new Date(identity.activation_expires_at) < new Date() ||
        !(await verifyActivationCode(String(activation_code), identity.activation_code_hash))) {
      await recordAuthFailure(login, ip);
      return res.status(400).json({ ok: false, message: 'Код недействителен или срок его действия истёк' });
    }
    await clearAuthFailures(login, ip);
    const passwordHash = await hashPassword(String(password));
    const table = identity.kind === 'user' ? 'users' : 'workers';
    await pool.query(
      `UPDATE ${table} SET password_hash = $1, activation_code_hash = NULL, activation_expires_at = NULL WHERE id = $2`,
      [passwordHash, identity.id]
    );
    const token = issueToken({ id: identity.id, kind: identity.kind, role: identity.role });
    return res.json({ ok: true, token, user: { id: identity.id, login: identity.login, full_name: identity.full_name, role: identity.role } });
  } catch (error) {
    console.error('ACTIVATION ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось активировать учётную запись' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ ok: false, message: 'Введите логин и пароль' });
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (await authIsLocked(login, ip)) return res.status(429).json({ ok: false, message: 'Слишком много попыток. Повторите через 15 минут.' });

    const userResult = await pool.query(
      'SELECT id, login, full_name, role, password_hash FROM users WHERE login = $1 LIMIT 1',
      [String(login).trim()]
    );
    let identity = userResult.rows[0] ? { ...userResult.rows[0], kind: 'user' } : null;

    if (!identity) {
      const workerResult = await pool.query(
        'SELECT id, login, full_name, password_hash FROM workers WHERE login = $1 LIMIT 1',
        [String(login).trim()]
      );
      if (workerResult.rows[0]) identity = { ...workerResult.rows[0], role: 'Рабочий', kind: 'worker' };
    }

    if (!identity || !(await verifyPassword(password, identity.password_hash))) {
      await recordAuthFailure(login, ip);
      return res.status(401).json({ ok: false, message: 'Неверный логин или пароль' });
    }
    await clearAuthFailures(login, ip);

    const token = issueToken({ id: identity.id, kind: identity.kind, role: identity.role });
    return res.json({
      ok: true,
      token,
      user: {
        id: identity.id,
        login: identity.login,
        full_name: identity.full_name,
        role: identity.role,
      },
    });
  } catch (error) {
    console.error('LOGIN ERROR:', error);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// All business API endpoints require a signed-in identity.
// Health and login routes are intentionally declared before this middleware.
app.use('/api', authenticate);

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, full_name, login, role FROM users ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error('GET USERS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить пользователей' });
  }
});



app.post('/api/users', async (req, res) => {
  try {
    const { full_name, login, role } = req.body;
    if (req.auth.role !== 'Администратор' && req.auth.role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'Только администратор может создавать пользователей' });
    }
    if (!full_name || !login || !role) {
      return res.status(400).json({ ok: false, message: 'Заполните имя, логин, пароль и роль' });
    }
    const allowedRoles = ['Администратор', 'Производственный мастер', 'Контрольный мастер', 'Контролер', 'admin', 'production_master', 'control_master', 'quality_master', 'controller'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ ok: false, message: 'Некорректная роль пользователя' });
    }
    const duplicate = await pool.query('SELECT id FROM users WHERE login = $1 UNION ALL SELECT id FROM workers WHERE login = $1 LIMIT 1', [String(login).trim()]);
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'Пользователь с таким логином уже существует' });
    }
    const activationCode = createActivationCode();
    const result = await pool.query(
      'INSERT INTO users (full_name, login, password_hash, role, activation_code_hash, activation_expires_at) VALUES ($1, $2, NULL, $3, $4, $5) RETURNING id, full_name, login, role',
      [String(full_name).trim(), String(login).trim(), role, await hashActivationCode(activationCode), activationExpiry()]
    );
    res.json({ ...result.rows[0], activation_code: activationCode });
  } catch (error) {
    console.error('CREATE USER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать пользователя' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const userId = toInt(req.params.id);
    const { full_name, login, password, role } = req.body;
    if (req.auth.role !== 'Администратор' && req.auth.role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'Только администратор может редактировать пользователей' });
    }
    if (!full_name || !login || !role) {
      return res.status(400).json({ ok: false, message: 'Заполните имя, логин и роль' });
    }
    const fields = [full_name.trim(), login.trim(), role, userId];
    let query = `UPDATE users SET full_name = $1, login = $2, role = $3`;
    if (password && String(password).trim()) {
      query += `, password_hash = $5`;
      fields.push(await hashPassword(String(password).trim()));
      query += ` WHERE id = $4 RETURNING id, full_name, login, role`;
      const reordered = [fields[0], fields[1], fields[2], fields[3], fields[4]];
      const result = await pool.query(query, reordered);
      return res.json(result.rows[0]);
    }
    query += ` WHERE id = $4 RETURNING id, full_name, login, role`;
    const result = await pool.query(query, fields);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE USER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить пользователя' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const userId = toInt(req.params.id);
    if (req.auth.role !== 'Администратор' && req.auth.role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'Только администратор может удалять пользователей' });
    }
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ ok: false, message: 'Пользователь не найден' });
    if (user.role === 'admin' || user.role === 'Администратор') {
      return res.status(400).json({ ok: false, message: 'Нельзя удалить учетную запись администратора' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE USER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить пользователя' });
  }
});

app.get('/api/workers', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, full_name, login FROM workers ORDER BY full_name');
    res.json(result.rows);
  } catch (error) {
    console.error('GET WORKERS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить рабочих' });
  }
});

app.post('/api/workers', async (req, res) => {
  try {
    const { full_name, login } = req.body;
    if (req.auth.role !== 'Администратор' && req.auth.role !== 'admin') return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    if (!full_name || !login) {
      return res.status(400).json({ ok: false, message: 'full_name обязателен' });
    }
    const duplicate = await pool.query('SELECT id FROM users WHERE login = $1 UNION ALL SELECT id FROM workers WHERE login = $1 LIMIT 1', [String(login).trim()]);
    if (duplicate.rows.length) return res.status(400).json({ ok: false, message: 'Сотрудник с таким логином уже существует' });
    const activationCode = createActivationCode();
    const result = await pool.query(
      'INSERT INTO workers (full_name, login, password_hash, activation_code_hash, activation_expires_at) VALUES ($1, $2, NULL, $3, $4) RETURNING id, full_name, login',
      [full_name.trim(), String(login).trim(), await hashActivationCode(activationCode), activationExpiry()]
    );
    res.json({ ...result.rows[0], activation_code: activationCode });
  } catch (error) {
    console.error('CREATE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось добавить рабочего' });
  }
});


app.put('/api/workers/:id', async (req, res) => {
  try {
    const workerId = toInt(req.params.id);
    const { full_name, login, password } = req.body;
    if (req.auth.role !== 'Администратор' && req.auth.role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'Только администратор может редактировать рабочих' });
    }
    if (!full_name) {
      return res.status(400).json({ ok: false, message: 'full_name обязателен' });
    }
    let result;
    if (password && String(password).trim()) {
      result = await pool.query('UPDATE workers SET full_name = $1, login = $2, password_hash = $3 WHERE id = $4 RETURNING id, full_name, login', [full_name.trim(), login ? String(login).trim() : null, await hashPassword(String(password).trim()), workerId]);
    } else {
      result = await pool.query('UPDATE workers SET full_name = $1, login = $2 WHERE id = $3 RETURNING id, full_name, login', [full_name.trim(), login ? String(login).trim() : null, workerId]);
    }
    if (!result.rows[0]) return res.status(404).json({ ok: false, message: 'Рабочий не найден' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить рабочего' });
  }
});

app.delete('/api/workers/:id', async (req, res) => {
  try {
    const workerId = toInt(req.params.id);
    if (req.auth.role !== 'Администратор' && req.auth.role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'Только администратор может удалять рабочих' });
    }
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE WORKER ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить рабочего' });
  }
});

app.get('/api/batches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        b.*,
        w.full_name,
        creator.full_name AS creator_name,
        i.id AS inspection_id,
        i.inspector_id,
        inspector.full_name AS inspector_name,
        i.inspection_date,
        i.accepted_count,
        i.rejected_count,
        i.comment AS inspection_comment,
        b.accepted_by_user_id,
        b.started_by_worker_id,
        b.assigned_shift_type AS worker_shift_type,
        b.sent_to_assembly_at
      FROM batches b
      LEFT JOIN workers w ON b.assigned_worker_id = w.id
      LEFT JOIN users creator ON b.created_by = creator.id
      LEFT JOIN shifts shift ON shift.worker_id = b.assigned_worker_id AND shift.shift_date = DATE(b.created_at)
      LEFT JOIN inspections i ON i.batch_id = b.id
      LEFT JOIN users inspector ON i.inspector_id = inspector.id
      ORDER BY b.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET BATCHES ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить партии' });
  }
});

app.post('/api/batches', async (req, res) => {
  try {
    const { batch_number, product_name, quantity, assigned_worker_id, assigned_shift_type, manufacture_date } = req.body;
    if (!isUserIdentity(req) || !isProductionRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    if (!batch_number || !product_name || !assigned_worker_id) {
      return res.status(400).json({ ok: false, message: 'Не все обязательные поля заполнены' });
    }
    const result = await pool.query(
      `INSERT INTO batches (batch_number, product_name, quantity, created_by, assigned_worker_id, assigned_shift_type, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Создана', COALESCE($7::timestamptz, NOW()))
       RETURNING *`,
      [batch_number, product_name.trim(), quantity || 0, req.auth.sub, assigned_worker_id, assigned_shift_type || 'day', manufacture_date || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать партию' });
  }
});

app.put('/api/batches/:id', async (req, res) => {
  try {
    if (!isUserIdentity(req) || !isProductionRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const batchId = toInt(req.params.id);
    const editorId = toInt(req.auth.sub);
    const { product_name, quantity, assigned_worker_id, manufacture_date, assigned_shift_type } = req.body;
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (!isAdmin(req) && String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Можно редактировать только свои партии' });
    }
    if (batch.status !== 'Создана') {
      return res.status(400).json({ ok: false, message: 'Редактировать можно только созданную партию' });
    }
    const updated = await pool.query(
      `UPDATE batches
       SET product_name = $1,
           quantity = $2,
           assigned_worker_id = $3,
           assigned_shift_type = COALESCE($4, assigned_shift_type),
           created_at = COALESCE($5::timestamptz, created_at)
       WHERE id = $6
       RETURNING *`,
      [product_name.trim(), quantity || 0, assigned_worker_id, assigned_shift_type || null, manufacture_date || null, batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('UPDATE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить партию' });
  }
});

app.delete('/api/batches/:id', async (req, res) => {
  try {
    if (!isUserIdentity(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const batchId = toInt(req.params.id);
    const editorId = toInt(req.auth.sub);
    const editorRole = req.auth.role;
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    const admin = isAdmin(req);
    if (!admin && String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Можно удалять только свои партии' });
    }
    await pool.query('DELETE FROM batches WHERE id = $1', [batchId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить партию' });
  }
});

app.post('/api/batches/:id/worker-accept', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    if (!isWorkerIdentity(req)) return res.status(403).json({ ok: false, message: 'Только рабочий может выполнить эту операцию' });
    const workerId = toInt(req.auth.sub);
    if (!batchId || !workerId) {
      return res.status(400).json({ ok: false, message: 'batch_id и worker_id обязательны' });
    }
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (String(batch.assigned_worker_id || '') !== String(workerId)) {
      return res.status(403).json({ ok: false, message: 'Рабочий может принимать только назначенные ему партии' });
    }
    if (batch.status !== 'Создана') {
      return res.status(400).json({ ok: false, message: 'Принять в работу можно только созданную партию' });
    }
    const shiftResult = await pool.query("SELECT * FROM shifts WHERE worker_id = $1 AND shift_date = DATE($2::timestamptz) AND shift_type = COALESCE($3, shift_type) LIMIT 1", [workerId, batch.created_at, batch.assigned_shift_type || 'day']);
    if (!shiftResult.rows[0]) {
      return res.status(400).json({ ok: false, message: 'Рабочий не назначен на указанную смену для этой партии' });
    }
    const updated = await pool.query(
      'UPDATE batches SET status = $1, started_by_worker_id = $2 WHERE id = $3 RETURNING *',
      ['В процессе', workerId, batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('WORKER ACCEPT BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось принять партию в работу' });
  }
});

app.post('/api/batches/:id/worker-complete', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    if (!isWorkerIdentity(req)) return res.status(403).json({ ok: false, message: 'Только рабочий может выполнить эту операцию' });
    const workerId = toInt(req.auth.sub);
    if (!batchId || !workerId) {
      return res.status(400).json({ ok: false, message: 'batch_id и worker_id обязательны' });
    }
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (String(batch.assigned_worker_id || '') !== String(workerId) || String(batch.started_by_worker_id || '') !== String(workerId)) {
      return res.status(403).json({ ok: false, message: 'Завершить может только назначенный рабочий, принявший партию' });
    }
    if (batch.status !== 'В процессе') {
      return res.status(400).json({ ok: false, message: 'Завершить можно только партию в процессе' });
    }
    const shiftResult = await pool.query("SELECT * FROM shifts WHERE worker_id = $1 AND shift_date = DATE($2::timestamptz) AND shift_type = COALESCE($3, shift_type) LIMIT 1", [workerId, batch.created_at, batch.assigned_shift_type || 'day']);
    if (!shiftResult.rows[0]) {
      return res.status(400).json({ ok: false, message: 'Рабочий не назначен на указанную смену для этой партии' });
    }
    const updated = await pool.query(
      "UPDATE batches SET status = 'Готова к проверке', created_at = NOW() WHERE id = $1 RETURNING *",
      [batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('WORKER COMPLETE BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось передать партию на контроль' });
  }
});

app.post('/api/batches/:id/accept', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    if (!isUserIdentity(req) || !isControlRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const userId = toInt(req.auth.sub);
    if (!batchId || !userId) {
      return res.status(400).json({ ok: false, message: 'batch_id и user_id обязательны' });
    }

    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (batch.status !== 'Готова к проверке') {
      return res.status(400).json({ ok: false, message: 'Принять можно только партию со статусом «Готова к проверке»' });
    }
    if (batch.accepted_by_user_id && String(batch.accepted_by_user_id) !== String(userId)) {
      return res.status(400).json({ ok: false, message: 'Партия уже принята другим сотрудником' });
    }

    const updated = await pool.query(
      'UPDATE batches SET accepted_by_user_id = $1 WHERE id = $2 RETURNING *',
      [userId, batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('ACCEPT BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось принять партию' });
  }
});


app.post('/api/batches/:id/cancel-accept', async (req, res) => {
  try {
    const batchId = toInt(req.params.id);
    if (!isUserIdentity(req) || !isControlRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const userId = toInt(req.auth.sub);
    if (!batchId || !userId) {
      return res.status(400).json({ ok: false, message: 'batch_id и user_id обязательны' });
    }

    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (String(batch.accepted_by_user_id || '') !== String(userId)) {
      return res.status(403).json({ ok: false, message: 'Отменить контроль может только принявший сотрудник' });
    }

    const inspectionResult = await pool.query('SELECT id FROM inspections WHERE batch_id = $1 LIMIT 1', [batchId]);
    if (inspectionResult.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'Нельзя отменить контроль после сохранения проверки' });
    }

    const updated = await pool.query(
      'UPDATE batches SET accepted_by_user_id = NULL WHERE id = $1 RETURNING *',
      [batchId]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('CANCEL ACCEPT BATCH ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось отменить контроль' });
  }
});

app.post('/api/batches/:id/mark-ready-to-send', async (req, res) => {
  try {
    if (!isUserIdentity(req) || !isProductionRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const batchId = toInt(req.params.id);
    const editorId = toInt(req.auth.sub);
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (!isAdmin(req) && String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Подготовить к отправке может только создатель партии' });
    }
    if (batch.status !== 'Проверена') {
      return res.status(400).json({ ok: false, message: 'Подготовить к отправке можно только проверенную партию' });
    }
    const result = await pool.query(
      `UPDATE batches SET status = 'Готова к отправке' WHERE id = $1 RETURNING *`,
      [batchId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('MARK READY TO SEND ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось подготовить партию к отправке' });
  }
});

app.post('/api/batches/:id/send-to-assembly', async (req, res) => {
  try {
    if (!isUserIdentity(req) || !isProductionRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const batchId = toInt(req.params.id);
    if (!isUserIdentity(req) || !isProductionRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const editorId = toInt(req.auth.sub);
    const batchResult = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (!isAdmin(req) && String(batch.created_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Отправить на сборку может только создатель партии' });
    }
    if (batch.status !== 'Готова к отправке') {
      return res.status(400).json({ ok: false, message: 'На сборку можно отправить только партию со статусом «Готова к отправке»' });
    }
    const result = await pool.query(
      `UPDATE batches SET status = 'Отправлено на сборку', sent_to_assembly_at = NOW() WHERE id = $1 RETURNING *`,
      [batchId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('SEND TO ASSEMBLY ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось отправить партию на сборку' });
  }
});

app.get('/api/shifts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.*,
        COALESCE(w.full_name, u.full_name, s.employee_name) AS full_name,
        COALESCE(s.employee_type, CASE WHEN s.user_id IS NOT NULL THEN 'controller' ELSE 'worker' END) AS employee_type,
        CASE
          WHEN s.user_id IS NOT NULL AND u.role IN ('Контрольный мастер', 'quality_master', 'control_master') THEN 'Контрольный мастер'
          WHEN s.user_id IS NOT NULL THEN 'Контролер'
          ELSE 'Рабочий'
        END AS role_label
      FROM shifts s
      LEFT JOIN workers w ON s.worker_id = w.id
      LEFT JOIN users u ON s.user_id = u.id
      ORDER BY s.shift_date DESC, s.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET SHIFTS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить смены' });
  }
});

app.post('/api/shifts', async (req, res) => {
  try {
    const { worker_id, user_id, shift_date, shift_type, employee_type } = req.body;
    if (!isUserIdentity(req) || (employee_type === 'worker' && !isProductionRole(req)) || (employee_type === 'controller' && !isControlRole(req))) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    if (!shift_date || !shift_type || !employee_type) {
      return res.status(400).json({ ok: false, message: 'Не все обязательные поля заполнены' });
    }
    if (employee_type === 'worker' && !worker_id) {
      return res.status(400).json({ ok: false, message: 'Не выбран рабочий' });
    }
    if (employee_type === 'controller' && !user_id) {
      return res.status(400).json({ ok: false, message: 'Не выбран контролер' });
    }

    const duplicate = employee_type === 'worker'
      ? await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND worker_id = $2 AND shift_date = $3', [employee_type, worker_id, shift_date])
      : await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND user_id = $2 AND shift_date = $3', [employee_type, user_id, shift_date]);

    if (duplicate.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'Сотрудник уже назначен на эту дату' });
    }

    const employeeLookup = employee_type === 'worker'
      ? await pool.query('SELECT full_name FROM workers WHERE id = $1', [worker_id])
      : await pool.query('SELECT full_name FROM users WHERE id = $1', [user_id]);
    const employeeName = employeeLookup.rows[0]?.full_name || null;

    const result = await pool.query(
      `INSERT INTO shifts (worker_id, user_id, shift_date, shift_type, assigned_by, employee_type, employee_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [worker_id || null, user_id || null, shift_date, shift_type, req.auth.sub, employee_type, employeeName]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('CREATE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось создать смену' });
  }
});

app.put('/api/shifts/:id', async (req, res) => {
  try {
    if (!isUserIdentity(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const shiftId = toInt(req.params.id);
    const editorId = toInt(req.auth.sub);
    const editorRole = req.auth.role;
    const { shift_date, shift_type, employee_type, worker_id, user_id } = req.body;
    if (!isUserIdentity(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const shiftResult = await pool.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
    const shift = shiftResult.rows[0];
    if (!shift) return res.status(404).json({ ok: false, message: 'Смена не найдена' });

    const nextEmployeeType = employee_type || shift.employee_type || (shift.user_id ? 'controller' : 'worker');
    const nextWorkerId = nextEmployeeType === 'worker' ? toInt(worker_id) || shift.worker_id : null;
    const nextUserId = nextEmployeeType === 'controller' ? toInt(user_id) || shift.user_id : null;
    const nextShiftDate = shift_date || shift.shift_date;
    const nextShiftType = shift_type || shift.shift_type || 'day';

    const admin = isAdmin(req);
    const isProductionMasterEditingWorker = isProductionRole(req) && nextEmployeeType === 'worker';
    const isControlMasterEditingController = isControlRole(req) && nextEmployeeType === 'controller';
    const isOwner = String(shift.assigned_by || '') === String(editorId || '');
    if (!admin && !isProductionMasterEditingWorker && !isControlMasterEditingController && !isOwner) {
      return res.status(403).json({ ok: false, message: 'Нет прав на редактирование этой смены' });
    }
    if (!nextShiftDate || !nextEmployeeType || (nextEmployeeType === 'worker' && !nextWorkerId) || (nextEmployeeType === 'controller' && !nextUserId)) {
      return res.status(400).json({ ok: false, message: 'Заполните дату и сотрудника' });
    }

    const duplicate = nextEmployeeType === 'worker'
      ? await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND worker_id = $2 AND shift_date = $3 AND id <> $4', [nextEmployeeType, nextWorkerId, nextShiftDate, shiftId])
      : await pool.query('SELECT id FROM shifts WHERE employee_type = $1 AND user_id = $2 AND shift_date = $3 AND id <> $4', [nextEmployeeType, nextUserId, nextShiftDate, shiftId]);
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ ok: false, message: 'На эту дату уже есть смена для выбранного сотрудника' });
    }

    const employeeLookup = nextEmployeeType === 'worker'
      ? await pool.query('SELECT full_name FROM workers WHERE id = $1', [nextWorkerId])
      : await pool.query('SELECT full_name FROM users WHERE id = $1', [nextUserId]);
    const employeeName = employeeLookup.rows[0]?.full_name || shift.employee_name || null;

    const result = await pool.query(
      `UPDATE shifts
       SET worker_id = $1,
           user_id = $2,
           shift_date = $3,
           shift_type = $4,
           employee_type = $5,
           employee_name = $6
       WHERE id = $7
       RETURNING *`,
      [nextEmployeeType === 'worker' ? nextWorkerId : null, nextEmployeeType === 'controller' ? nextUserId : null, nextShiftDate, nextShiftType, nextEmployeeType, employeeName, shiftId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить смену' });
  }
});

app.delete('/api/shifts/:id', async (req, res) => {
  try {
    if (!isUserIdentity(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const shiftId = toInt(req.params.id);
    const editorId = toInt(req.auth.sub);
    const editorRole = req.auth.role;
    const shiftResult = await pool.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
    const shift = shiftResult.rows[0];
    if (!shift) return res.status(404).json({ ok: false, message: 'Смена не найдена' });
    const admin = isAdmin(req);
    const shiftEmployeeType = shift.employee_type || (shift.user_id ? 'controller' : 'worker');
    const isProductionMasterDeletingWorker = isProductionRole(req) && shiftEmployeeType === 'worker';
    const isControlMasterDeletingController = isControlRole(req) && shiftEmployeeType === 'controller';
    if (!admin && !isProductionMasterDeletingWorker && !isControlMasterDeletingController && String(shift.assigned_by || '') !== String(editorId || '')) {
      return res.status(403).json({ ok: false, message: 'Нет прав на удаление этой смены' });
    }
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE SHIFT ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось удалить смену' });
  }
});

app.get('/api/inspections', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        i.*,
        u.full_name AS inspector_name,
        COALESCE(
          json_agg(
            json_build_object(
              'id', d.id,
              'defect_class', d.defect_class,
              'confidence', d.confidence,
              'affected_count', d.affected_count,
              'comment', d.comment,
              'image_uri', d.image_uri,
              'review_status', COALESCE(d.review_status, 'На рассмотрении')
            )
          ) FILTER (WHERE d.id IS NOT NULL),
          '[]'::json
        ) AS defects
      FROM inspections i
      JOIN users u ON u.id = i.inspector_id
      LEFT JOIN inspection_defects d ON d.inspection_id = i.id
      GROUP BY i.id, u.full_name
      ORDER BY i.id DESC
    `);
    res.json(result.rows.map(mapInspectionRow));
  } catch (error) {
    console.error('GET INSPECTIONS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось получить результаты контроля' });
  }
});

app.post('/api/inspections', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      batch_id,
      inspector_id,
      inspector_name,
      visual_conclusion,
      geometry_conclusion,
      accepted_count,
      rejected_count,
      comment,
      defects,
    } = req.body;

    if (!isUserIdentity(req) || !isControlRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    let resolvedInspectorId = toInt(req.auth.sub);
    if (!batch_id || !resolvedInspectorId) {
      return res.status(400).json({ ok: false, message: 'batch_id и inspector_id обязательны' });
    }

    const batchResult = await client.query('SELECT * FROM batches WHERE id = $1', [batch_id]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (batch.status === 'Готова к отправке' || batch.status === 'Отправлено на сборку') {
      return res.status(400).json({ ok: false, message: 'Партия уже недоступна для редактирования контроля' });
    }
    if (batch.accepted_by_user_id && String(batch.accepted_by_user_id) !== String(resolvedInspectorId)) {
      return res.status(403).json({ ok: false, message: 'Сохранять контроль может только сотрудник, принявший партию' });
    }

    const existing = await client.query('SELECT * FROM inspections WHERE batch_id = $1', [batch_id]);
    if (existing.rows[0]) {
      return res.status(400).json({ ok: false, message: 'Для партии уже есть контроль. Используйте обновление.' });
    }

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO inspections (
        batch_id, inspector_id, inspection_date, visual_conclusion, geometry_conclusion,
        accepted_count, rejected_count, comment
      ) VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7)
      RETURNING *`,
      [batch_id, resolvedInspectorId, visual_conclusion || '', geometry_conclusion || '', accepted_count || 0, rejected_count || 0, comment || '']
    );
    const inspection = inserted.rows[0];

    for (const defect of Array.isArray(defects) ? defects : []) {
      await client.query(
        `INSERT INTO inspection_defects (inspection_id, defect_class, confidence, affected_count, comment, image_uri, review_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [inspection.id, defect.defect_class, defect.confidence || 0, defect.affected_count || 0, defect.comment || '', defect.image_uri || null, defect.review_status || 'На рассмотрении']
      );
    }

    await client.query(`UPDATE batches SET status = 'Проверена', accepted_by_user_id = $2 WHERE id = $1`, [batch_id, resolvedInspectorId]);
    await client.query('COMMIT');

    res.json(await getInspectionByBatch(batch_id));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('CREATE INSPECTION ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось сохранить контроль' });
  } finally {
    client.release();
  }
});

app.put('/api/inspections/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isUserIdentity(req) || !isControlRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const inspectionId = toInt(req.params.id);
    const editorId = toInt(req.auth.sub);
    const {
      visual_conclusion,
      geometry_conclusion,
      accepted_count,
      rejected_count,
      comment,
      defects,
    } = req.body;

    const existingResult = await client.query('SELECT * FROM inspections WHERE id = $1', [inspectionId]);
    const inspection = existingResult.rows[0];
    if (!inspection) return res.status(404).json({ ok: false, message: 'Контроль не найден' });

    const batchResult = await client.query('SELECT * FROM batches WHERE id = $1', [inspection.batch_id]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ ok: false, message: 'Партия не найдена' });
    if (batch.status === 'Готова к отправке' || batch.status === 'Отправлено на сборку') {
      return res.status(400).json({ ok: false, message: 'После подготовки к отправке контроль менять нельзя' });
    }
    if (batch.accepted_by_user_id && String(batch.accepted_by_user_id) !== String(editorId)) {
      return res.status(403).json({ ok: false, message: 'Изменять контроль может только сотрудник, принявший партию' });
    }
    if (String(inspection.inspector_id) !== String(editorId)) {
      return res.status(403).json({ ok: false, message: 'Изменять проверенную партию может только тот, кто ее проверял' });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE inspections SET
        visual_conclusion = $1,
        geometry_conclusion = $2,
        accepted_count = $3,
        rejected_count = $4,
        comment = $5,
        updated_at = NOW()
      WHERE id = $6`,
      [visual_conclusion || '', geometry_conclusion || '', accepted_count || 0, rejected_count || 0, comment || '', inspectionId]
    );
    await client.query('DELETE FROM inspection_defects WHERE inspection_id = $1', [inspectionId]);
    for (const defect of Array.isArray(defects) ? defects : []) {
      await client.query(
        `INSERT INTO inspection_defects (inspection_id, defect_class, confidence, affected_count, comment, image_uri, review_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [inspectionId, defect.defect_class, defect.confidence || 0, defect.affected_count || 0, defect.comment || '', defect.image_uri || null, defect.review_status || 'На рассмотрении']
      );
    }
    await client.query('COMMIT');
    res.json(await getInspectionByBatch(inspection.batch_id));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('UPDATE INSPECTION ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить контроль' });
  } finally {
    client.release();
  }
});


app.put('/api/inspection-defects/:id/status', async (req, res) => {
  try {
    if (!isUserIdentity(req) || !isControlRole(req)) return res.status(403).json({ ok: false, message: 'Недостаточно прав' });
    const defectId = toInt(req.params.id);
    const { review_status } = req.body;
    if (!defectId || !review_status) {
      return res.status(400).json({ ok: false, message: 'Нужны id дефекта и статус' });
    }
    if (!['Забраковано', 'На рассмотрении', 'Допущено до сборки'].includes(review_status)) {
      return res.status(400).json({ ok: false, message: 'Некорректный статус' });
    }
    const result = await pool.query(
      'UPDATE inspection_defects SET review_status = $1 WHERE id = $2 RETURNING *',
      [review_status, defectId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: 'Дефект не найден' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('UPDATE DEFECT STATUS ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось обновить статус брака' });
  }
});

app.post('/api/upload-image', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Файл не загружен' });
    }
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('host');
    const imageUri = `${proto}://${host}/uploads/${req.file.filename}`;
    res.json({ ok: true, image_uri: imageUri });
  } catch (error) {
    console.error('UPLOAD IMAGE ERROR:', error);
    res.status(500).json({ ok: false, message: 'Не удалось загрузить изображение' });
  }
});

app.post('/analyze-defect', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Файл не загружен' });
    }

    const image = fs.readFileSync(req.file.path, { encoding: 'base64' });
    const response = await axios({
      method: 'POST',
      url: process.env.ROBOFLOW_MODEL_URL,
      params: { api_key: process.env.ROBOFLOW_API_KEY },
      data: image,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.json(response.data);
  } catch (error) {
    console.error('AI ERROR:', error?.response?.data || error.message);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ ok: false, message: 'Ошибка анализа изображения' });
  }
});

const PORT = process.env.PORT || 8000;

runSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server started on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('SCHEMA INIT ERROR:', error);
    process.exit(1);
  });
