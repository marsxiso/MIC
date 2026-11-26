require('dotenv').config();

const express = require('express');
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


function requireRoles(...roles) {
  return (req,res,next) => roles.includes(req.employee.role_code) ? next() : res.status(403).json({ok:false,message:'Недостаточно прав'});
}

app.get('/api/dashboard', authenticate, async (_req,res,next) => {
  try {
    const q = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM mic2.production_cycles WHERE cycle_status='active'"),
      pool.query("SELECT bin_status,COUNT(*)::int AS count FROM mic2.plastic_bins GROUP BY bin_status"),
      pool.query('SELECT COUNT(*)::int AS count FROM mic2.products WHERE is_active'),
      pool.query("SELECT COUNT(*)::int AS count FROM mic2.employees WHERE account_status='active' AND terminated_at IS NULL"),
      pool.query("SELECT COUNT(*)::int AS count FROM mic2.defects WHERE defect_status IN ('awaiting_decision','active')")
    ]);
    res.json({ok:true,metrics:{active_cycles:q[0].rows[0].count,bins:q[1].rows,active_products:q[2].rows[0].count,active_employees:q[3].rows[0].count,open_defects:q[4].rows[0].count}});
  } catch(e){next(e);}
});

app.get('/api/roles', authenticate, async (_req,res,next)=>{try{const r=await pool.query('SELECT code,title FROM mic2.roles ORDER BY title');res.json({ok:true,roles:r.rows});}catch(e){next(e);}});

app.get('/api/employees', authenticate, requireRoles('administrator','production_manager','qc_manager','technical_director'), async (_req,res,next)=>{
  try { const r=await pool.query('SELECT e.id,e.employee_no,e.full_name,e.department,e.job_title,e.role_code,r.title AS role_title,e.account_status,e.hired_at FROM mic2.employees e JOIN mic2.roles r ON r.code=e.role_code WHERE e.terminated_at IS NULL ORDER BY e.full_name');res.json({ok:true,employees:r.rows}); } catch(e){next(e);}
});

app.get('/api/products', authenticate, async (_req,res,next)=>{
  try { const r=await pool.query("SELECT p.id,p.product_code,p.product_name,p.description,p.box_quantity_norm,COALESCE(json_agg(json_build_object('id',s.id,'setup_code',s.setup_code,'setup_name',s.setup_name)) FILTER(WHERE s.id IS NOT NULL),'[]') AS setups FROM mic2.products p LEFT JOIN mic2.product_setups s ON s.product_id=p.id AND s.is_active WHERE p.is_active GROUP BY p.id ORDER BY p.product_name");res.json({ok:true,products:r.rows}); } catch(e){next(e);}
});

app.get('/api/bins', authenticate, async (_req,res,next)=>{
  try { const r=await pool.query("SELECT b.id,b.bin_status,c.id AS cycle_id,c.cycle_no,c.cycle_status,c.product_name_snapshot,c.setup_code_snapshot,e.full_name AS responsible_name,COALESCE(q.quantity,0)::int AS physical_quantity FROM mic2.plastic_bins b LEFT JOIN LATERAL(SELECT * FROM mic2.production_cycles pc WHERE pc.bin_id=b.id ORDER BY pc.cycle_no DESC LIMIT 1)c ON TRUE LEFT JOIN mic2.employees e ON e.id=c.responsible_employee_id LEFT JOIN LATERAL(SELECT SUM(quantity)::int AS quantity FROM mic2.v_cycle_quantity_balances WHERE cycle_id=c.id AND bucket NOT IN ('rework_external','isolator_external','packed','scrapped'))q ON TRUE ORDER BY b.id");res.json({ok:true,bins:r.rows}); } catch(e){next(e);}
});

app.get('/api/cycles', authenticate, async (_req,res,next)=>{
  try { const r=await pool.query("SELECT c.id,c.bin_id,c.cycle_no,c.cycle_status,c.started_at,c.ended_at,c.product_name_snapshot,c.product_code_snapshot,c.setup_code_snapshot,e.full_name AS responsible_name,COALESCE(SUM(CASE WHEN b.bucket NOT IN ('rework_external','isolator_external','packed','scrapped') THEN b.quantity ELSE 0 END),0)::int AS physical_quantity,COALESCE(SUM(CASE WHEN b.bucket='production_pending_qc' THEN b.quantity ELSE 0 END),0)::int AS pending_qc FROM mic2.production_cycles c JOIN mic2.employees e ON e.id=c.responsible_employee_id LEFT JOIN mic2.v_cycle_quantity_balances b ON b.cycle_id=c.id GROUP BY c.id,e.full_name ORDER BY c.started_at DESC LIMIT 300");res.json({ok:true,cycles:r.rows}); } catch(e){next(e);}
});

app.post('/api/bins', authenticate, requireRoles('administrator','production_manager'), async (req,res,next)=>{try{const r=await pool.query('INSERT INTO mic2.plastic_bins(created_by) VALUES($1) RETURNING id,bin_status,created_at',[req.employee.id]);res.status(201).json({ok:true,bin:r.rows[0]});}catch(e){next(e);}});

app.post('/api/cycles/:id/output', authenticate, requireRoles('cnc_operator','production_manager','administrator'), async (req,res,next)=>{
  const quantity=Number(req.body?.quantity); if(!Number.isSafeInteger(quantity)||quantity<1)return res.status(400).json({ok:false,message:'Количество должно быть целым числом больше нуля'});
  const c=await pool.connect(); try { await c.query('BEGIN'); const cycle=await c.query("SELECT id,responsible_employee_id FROM mic2.production_cycles WHERE id=$1 AND cycle_status='active' FOR UPDATE",[req.params.id]); if(!cycle.rowCount)throw Object.assign(new Error('Активный цикл не найден'),{status:404});
    if(String(cycle.rows[0].responsible_employee_id)!==req.employee.id && !['administrator','production_manager'].includes(req.employee.role_code))throw Object.assign(new Error('Вы не являетесь ответственным оператором'),{status:403});
    const entry=await c.query('INSERT INTO mic2.production_output_entries(cycle_id,operator_id,quantity,entered_by) VALUES($1,$2,$3,$4) RETURNING *',[req.params.id,cycle.rows[0].responsible_employee_id,quantity,req.employee.id]);
    await c.query("INSERT INTO mic2.cycle_quantity_movements(cycle_id,movement_type,to_bucket,quantity,entered_by,note) VALUES($1,'production_received','production_pending_qc',$2,$3,$4)",[req.params.id,quantity,req.employee.id,req.body?.note||null]); await c.query('COMMIT');res.status(201).json({ok:true,entry:entry.rows[0]});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}finally{c.release();}
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
