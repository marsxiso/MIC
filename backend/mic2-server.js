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


const ROLE_ACCESS = Object.freeze({
  administrator: ['accounts:create', 'roles:read'],
  production_manager: ['dashboard:read', 'products:read', 'products:write', 'bins:read', 'bins:write', 'cycles:read', 'cycles:write', 'operators:assign', 'shift_schedule:read', 'shift_schedule:write'],
  cnc_operator: ['cycles:own:read', 'output:own:write'],
  qc_controller: ['qc:queue:read', 'qc:inspect:write', 'qc:own:read', 'qc:cards:read'],
  qc_manager: ['dashboard:read', 'qc:queue:read', 'qc:inspect:write', 'qc:all:read', 'qc:cards:read', 'qc:cards:write', 'shift_schedule:read', 'shift_schedule:write'],
  technical_director: ['dashboard:read', 'products:read', 'reports:read'],
});
function requireRoles(...roles) {
  return (req,res,next) => roles.includes(req.employee.role_code)
    ? next()
    : res.status(403).json({ok:false,message:'Недостаточно прав для этой операции'});
}
function hasAccess(role, permission) {
  return (ROLE_ACCESS[role] || []).includes(permission);
}
function requirePermission(...permissions) {
  return (req,res,next) => permissions.some(permission=>hasAccess(req.employee.role_code,permission))
    ? next()
    : res.status(403).json({ok:false,message:'Недостаточно прав для этой операции'});
}

app.get('/api/dashboard', authenticate, requirePermission('dashboard:read'), async (req,res,next) => {
  try {
    if(req.employee.role_code==='qc_manager'){
      const q=await Promise.all([
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.defects WHERE defect_status IN ('awaiting_decision','active')"),
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.qc_inspections WHERE completed_at::date=CURRENT_DATE"),
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.v_cycle_quantity_balances WHERE bucket='production_pending_qc' AND quantity>0")
      ]);
      return res.json({ok:true,metrics:{open_defects:q[0].rows[0].count,inspections_today:q[1].rows[0].count,pending_qc:q[2].rows[0].count}});
    }
    const q = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM mic2.production_cycles WHERE cycle_status='active'"),
      pool.query("SELECT bin_status,COUNT(*)::int AS count FROM mic2.plastic_bins GROUP BY bin_status"),
      pool.query('SELECT COUNT(*)::int AS count FROM mic2.products WHERE is_active'),
      pool.query("SELECT COUNT(*)::int AS count FROM mic2.defects WHERE defect_status IN ('awaiting_decision','active')")
    ]);
    res.json({ok:true,metrics:{active_cycles:q[0].rows[0].count,bins:q[1].rows,active_products:q[2].rows[0].count,open_defects:q[3].rows[0].count}});
  } catch(e){next(e);}
});

app.get('/api/roles', authenticate, requirePermission('roles:read'), async (_req,res,next)=>{try{const r=await pool.query('SELECT code,title FROM mic2.roles ORDER BY title');res.json({ok:true,roles:r.rows});}catch(e){next(e);}});

// Employee directory endpoint intentionally not exposed to any role.
app.get('/api/production/operators', authenticate, requirePermission('operators:assign'), async (_req,res,next)=>{
  try {
    const r=await pool.query("SELECT id,full_name,employee_no FROM mic2.employees WHERE role_code='cnc_operator' AND account_status='active' AND terminated_at IS NULL ORDER BY full_name");
    res.json({ok:true,operators:r.rows});
  } catch(e){next(e);}
});

app.get('/api/production/shift-candidates', authenticate, requirePermission('shift_schedule:read'), async (req,res,next)=>{
  try {
    const role=req.employee.role_code==='qc_manager'?'qc_controller':'cnc_operator';
    const r=await pool.query("SELECT id,full_name,job_title FROM mic2.employees WHERE role_code=$1 AND account_status='active' AND terminated_at IS NULL ORDER BY full_name",[role]);
    res.json({ok:true,candidates:r.rows});
  } catch(e){next(e);}
});

app.get('/api/production/shifts', authenticate, requirePermission('shift_schedule:read'), async (req,res,next)=>{
  try {
    const employeeRole=req.employee.role_code==='qc_manager'?'qc_controller':'cnc_operator';
    const r=await pool.query(`
      SELECT s.id,s.employee_id,e.full_name,e.job_title,s.shift_date,s.shift_code,
        s.starts_at,s.ends_at,s.attendance_status,s.notes
      FROM mic2.shift_assignments s
      JOIN mic2.employees e ON e.id=s.employee_id
      WHERE e.role_code=$1 AND s.shift_date >= CURRENT_DATE - INTERVAL '7 days'
        AND s.shift_date < CURRENT_DATE + INTERVAL '45 days'
      ORDER BY s.shift_date,s.shift_code,e.full_name
    `,[employeeRole]);
    res.json({ok:true,shifts:r.rows});
  } catch(e){next(e);}
});

app.post('/api/production/shifts', authenticate, requirePermission('shift_schedule:write'), async (req,res,next)=>{
  const b=req.body||{};
  const employeeId=Number(b.employee_id);
  const shiftDate=typeof b.shift_date==='string'?b.shift_date:'';
  const shiftCode=typeof b.shift_code==='string'?b.shift_code.trim():'';
  const allowedRole=req.employee.role_code==='qc_manager'?'qc_controller':'cnc_operator';
  if(!Number.isSafeInteger(employeeId)||employeeId<1||!/^\\d{4}-\\d{2}-\\d{2}$/.test(shiftDate)||!shiftCode){
    return res.status(400).json({ok:false,message:'Укажите сотрудника, дату и смену'});
  }
  try{
    const e=await pool.query("SELECT id FROM mic2.employees WHERE id=$1 AND role_code=$2 AND account_status='active' AND terminated_at IS NULL",[employeeId,allowedRole]);
    if(!e.rowCount)return res.status(400).json({ok:false,message:'Нельзя назначить сотрудника другой специализации'});
    const r=await pool.query(`
      INSERT INTO mic2.shift_assignments(employee_id,shift_date,shift_code,starts_at,ends_at,assigned_by,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id,employee_id,shift_date,shift_code,starts_at,ends_at,attendance_status,notes
    `,[employeeId,shiftDate,shiftCode,b.starts_at||null,b.ends_at||null,req.employee.id,b.notes||null]);
    res.status(201).json({ok:true,shift:r.rows[0]});
  }catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'Сотрудник уже назначен на эту смену'});next(e);}
});

app.get('/api/products', authenticate, requirePermission('products:read'), async (_req,res,next)=>{
  try { const r=await pool.query("SELECT p.id,p.product_code,p.product_name,p.description,p.box_quantity_norm,COALESCE(json_agg(json_build_object('id',s.id,'setup_code',s.setup_code,'setup_name',s.setup_name)) FILTER(WHERE s.id IS NOT NULL),'[]') AS setups FROM mic2.products p LEFT JOIN mic2.product_setups s ON s.product_id=p.id AND s.is_active WHERE p.is_active GROUP BY p.id ORDER BY p.product_name");res.json({ok:true,products:r.rows}); } catch(e){next(e);}
});

app.post('/api/admin/accounts', authenticate, requirePermission('accounts:create'), async (req,res,next)=>{
  try { const b=req.body||{}; if(!b.full_name?.trim()||!b.job_title?.trim()||!b.login?.trim()||!b.password||b.password.length<10)return res.status(400).json({ok:false,message:'Заполните ФИО, должность, логин и пароль от 10 символов'});
    if(!['production','qc','management','administration'].includes(b.department))return res.status(400).json({ok:false,message:'Некорректное подразделение'});
    const role=await pool.query('SELECT code FROM mic2.roles WHERE code=$1',[b.role_code]);if(!role.rowCount)return res.status(400).json({ok:false,message:'Неизвестная роль'});
    const hash=await bcrypt.hash(b.password,12);const r=await pool.query('INSERT INTO mic2.employees(full_name,department,job_title,role_code,login,password_hash,must_change_password) VALUES($1,$2,$3,$4,$5,$6,TRUE) RETURNING id,full_name,department,job_title,role_code,login',[b.full_name.trim(),b.department,b.job_title.trim(),b.role_code,b.login.trim(),hash]);res.status(201).json({ok:true,employee:r.rows[0]});
  }catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'Такой логин уже существует'});next(e);}
});

app.post('/api/products', authenticate, requirePermission('products:write'), async (req,res,next)=>{
  const b=req.body||{};const norm=Number(b.box_quantity_norm);if(!b.product_code?.trim()||!b.product_name?.trim()||!Number.isInteger(norm)||norm<1||!b.setup_code?.trim()||!b.setup_name?.trim())return res.status(400).json({ok:false,message:'Заполните код, название, норму коробки и наладку'});
  const c=await pool.connect();try{await c.query('BEGIN');const p=await c.query('INSERT INTO mic2.products(product_code,product_name,description,box_quantity_norm,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[b.product_code.trim(),b.product_name.trim(),b.description||null,norm,req.employee.id]);const s=await c.query('INSERT INTO mic2.product_setups(product_id,setup_code,setup_name) VALUES($1,$2,$3) RETURNING *',[p.rows[0].id,b.setup_code.trim(),b.setup_name.trim()]);await c.query('COMMIT');res.status(201).json({ok:true,product:p.rows[0],setup:s.rows[0]});}catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.code==='23505')return res.status(409).json({ok:false,message:'Такой код уже используется'});next(e);}finally{c.release();}
});

app.post('/api/cycles', authenticate, requirePermission('cycles:write'), async (req,res)=>{
  const b=req.body||{};const binId=Number(b.bin_id),productId=Number(b.product_id),setupId=Number(b.setup_id),operatorId=Number(b.operator_id);if(![binId,productId,setupId,operatorId].every(Number.isSafeInteger))return res.status(400).json({ok:false,message:'Выберите контейнер, изделие, наладку и оператора'});
  const c=await pool.connect();try{await c.query('BEGIN');const bin=await c.query("SELECT id FROM mic2.plastic_bins WHERE id=$1 AND bin_status='free' FOR UPDATE",[binId]);if(!bin.rowCount)throw Object.assign(Error('Контейнер не свободен'),{status:409});const p=await c.query('SELECT * FROM mic2.products WHERE id=$1 AND is_active',[productId]);if(!p.rowCount)throw Object.assign(Error('Изделие не найдено'),{status:404});const s=await c.query('SELECT * FROM mic2.product_setups WHERE id=$1 AND product_id=$2 AND is_active',[setupId,productId]);if(!s.rowCount)throw Object.assign(Error('Наладка не соответствует изделию'),{status:400});const op=await c.query("SELECT id FROM mic2.employees WHERE id=$1 AND role_code='cnc_operator' AND account_status='active' AND terminated_at IS NULL",[operatorId]);if(!op.rowCount)throw Object.assign(Error('Выбранный сотрудник не является активным оператором ЧПУ'),{status:400});const n=await c.query('SELECT COALESCE(MAX(cycle_no),0)+1 AS n FROM mic2.production_cycles WHERE bin_id=$1',[binId]);const activeCard=await c.query("SELECT id FROM mic2.measurement_cards WHERE setup_id=$1 AND review_status='active' ORDER BY version_no DESC LIMIT 1",[setupId]);const cy=await c.query('INSERT INTO mic2.production_cycles(bin_id,cycle_no,product_id,setup_id,card_id,started_by,responsible_employee_id,product_code_snapshot,product_name_snapshot,setup_code_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[binId,n.rows[0].n,productId,setupId,activeCard.rows[0]?.id||null,req.employee.id,operatorId,p.rows[0].product_code,p.rows[0].product_name,s.rows[0].setup_code]);await c.query("UPDATE mic2.plastic_bins SET bin_status='occupied' WHERE id=$1",[binId]);await c.query('INSERT INTO mic2.cycle_operator_periods(cycle_id,operator_id,approved_by) VALUES($1,$2,$3)',[cy.rows[0].id,operatorId,req.employee.id]);await c.query('COMMIT');res.status(201).json({ok:true,cycle:cy.rows[0]});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(e.status||500).json({ok:false,message:e.status?e.message:(e.code==='23505'?'У контейнера уже есть активный цикл':'Не удалось открыть цикл')});}finally{c.release();}
});

app.get('/api/bins', authenticate, requirePermission('bins:read'), async (_req,res,next)=>{
  try { const r=await pool.query("SELECT b.id,b.bin_status,c.id AS cycle_id,c.cycle_no,c.cycle_status,c.product_name_snapshot,c.setup_code_snapshot,e.full_name AS responsible_name,COALESCE(q.quantity,0)::int AS physical_quantity FROM mic2.plastic_bins b LEFT JOIN LATERAL(SELECT * FROM mic2.production_cycles pc WHERE pc.bin_id=b.id ORDER BY pc.cycle_no DESC LIMIT 1)c ON TRUE LEFT JOIN mic2.employees e ON e.id=c.responsible_employee_id LEFT JOIN LATERAL(SELECT SUM(quantity)::int AS quantity FROM mic2.v_cycle_quantity_balances WHERE cycle_id=c.id AND bucket NOT IN ('rework_external','isolator_external','packed','scrapped'))q ON TRUE ORDER BY b.id");res.json({ok:true,bins:r.rows}); } catch(e){next(e);}
});

app.get('/api/cycles', authenticate, requirePermission('cycles:read','cycles:own:read'), async (req,res,next)=>{
  try { const operatorFilter=req.employee.role_code==='cnc_operator'; const r=await pool.query("SELECT c.id,c.bin_id,c.cycle_no,c.cycle_status,c.started_at,c.ended_at,c.product_name_snapshot,c.product_code_snapshot,c.setup_code_snapshot,e.full_name AS responsible_name,COALESCE(SUM(CASE WHEN b.bucket NOT IN ('rework_external','isolator_external','packed','scrapped') THEN b.quantity ELSE 0 END),0)::int AS physical_quantity,COALESCE(SUM(CASE WHEN b.bucket='production_pending_qc' THEN b.quantity ELSE 0 END),0)::int AS pending_qc FROM mic2.production_cycles c JOIN mic2.employees e ON e.id=c.responsible_employee_id LEFT JOIN mic2.v_cycle_quantity_balances b ON b.cycle_id=c.id GROUP BY c.id,e.full_name HAVING (NOT $1 OR c.responsible_employee_id=$2) ORDER BY c.started_at DESC LIMIT 300",[operatorFilter,req.employee.id]);res.json({ok:true,cycles:r.rows}); } catch(e){next(e);}
});



app.get('/api/qc/cards', authenticate, requirePermission('qc:cards:read'), async (req,res,next)=>{
  try{
    const setupId=req.query.setup_id?Number(req.query.setup_id):null;
    if(setupId!==null&&!Number.isSafeInteger(setupId))return res.status(400).json({ok:false,message:'Некорректная наладка'});
    const cards=await pool.query(`
      SELECT mc.id,mc.setup_id,mc.version_no,mc.source_type,mc.source_file_uri,
        mc.review_status,mc.created_at,mc.checked_at,creator.full_name AS created_by_name,
        checker.full_name AS checked_by_name,
        COALESCE(json_agg(json_build_object(
          'id',mp.id,'sort_order',mp.sort_order,'parameter_name',mp.parameter_name,
          'nominal_value',mp.nominal_value,'tolerance_text',mp.tolerance_text,
          'unit',mp.unit,'instruction',mp.instruction
        ) ORDER BY mp.sort_order) FILTER(WHERE mp.id IS NOT NULL),'[]') AS parameters
      FROM mic2.measurement_cards mc
      LEFT JOIN mic2.measurement_parameters mp ON mp.card_id=mc.id
      LEFT JOIN mic2.employees creator ON creator.id=mc.created_by
      LEFT JOIN mic2.employees checker ON checker.id=mc.checked_by
      WHERE ($1::bigint IS NULL OR mc.setup_id=$1)
      GROUP BY mc.id,creator.full_name,checker.full_name
      ORDER BY mc.setup_id,mc.version_no DESC
    `,[setupId]);
    res.json({ok:true,cards:cards.rows});
  }catch(e){next(e);}
});

app.post('/api/qc/cards', authenticate, requirePermission('qc:cards:write'), async (req,res,next)=>{
  const b=req.body||{},setupId=Number(b.setup_id);
  const parameters=Array.isArray(b.parameters)?b.parameters:[];
  if(!Number.isSafeInteger(setupId)||setupId<1||!parameters.length||parameters.length>100||
    parameters.some(p=>!p||typeof p.parameter_name!=='string'||!p.parameter_name.trim())){
    return res.status(400).json({ok:false,message:'Выберите наладку и добавьте хотя бы один параметр измерения'});
  }
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const setup=await c.query('SELECT id FROM mic2.product_setups WHERE id=$1 AND is_active FOR UPDATE',[setupId]);
    if(!setup.rowCount)throw Object.assign(new Error('Активная наладка не найдена'),{status:404});
    const version=await c.query('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM mic2.measurement_cards WHERE setup_id=$1',[setupId]);
    const card=await c.query(`
      INSERT INTO mic2.measurement_cards(setup_id,version_no,source_type,review_status,created_by)
      VALUES($1,$2,'manual','draft',$3) RETURNING id,setup_id,version_no,review_status
    `,[setupId,version.rows[0].n,req.employee.id]);
    for(let i=0;i<parameters.length;i++){
      const p=parameters[i];
      await c.query(`
        INSERT INTO mic2.measurement_parameters(card_id,sort_order,parameter_name,nominal_value,tolerance_text,unit,instruction)
        VALUES($1,$2,$3,$4,$5,$6,$7)
      `,[card.rows[0].id,i+1,p.parameter_name.trim(),p.nominal_value||null,p.tolerance_text||null,p.unit||null,p.instruction||null]);
    }
    await c.query('COMMIT');
    res.status(201).json({ok:true,card:card.rows[0]});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}
  finally{c.release();}
});

app.post('/api/qc/cards/:id/activate', authenticate, requirePermission('qc:cards:write'), async (req,res,next)=>{
  const cardId=Number(req.params.id);
  if(!Number.isSafeInteger(cardId)||cardId<1)return res.status(400).json({ok:false,message:'Некорректная карта измерений'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const card=await c.query('SELECT id,setup_id,review_status FROM mic2.measurement_cards WHERE id=$1 FOR UPDATE',[cardId]);
    if(!card.rowCount)throw Object.assign(new Error('Карта измерений не найдена'),{status:404});
    if(!['draft','checked'].includes(card.rows[0].review_status))throw Object.assign(new Error('Эту карту нельзя активировать'),{status:409});
    const count=await c.query('SELECT COUNT(*)::int AS n FROM mic2.measurement_parameters WHERE card_id=$1',[cardId]);
    if(count.rows[0].n<1)throw Object.assign(new Error('В карте нет параметров измерения'),{status:409});
    await c.query("UPDATE mic2.measurement_cards SET review_status='archived' WHERE setup_id=$1 AND review_status='active'",[card.rows[0].setup_id]);
    await c.query("UPDATE mic2.measurement_cards SET review_status='active',checked_by=$2,checked_at=now() WHERE id=$1",[cardId,req.employee.id]);
    await c.query('COMMIT');
    res.json({ok:true,message:'Карта измерений активирована'});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}
  finally{c.release();}
});

app.get('/api/qc/history', authenticate, requirePermission('qc:own:read','qc:all:read'), async (req,res,next)=>{
  try{
    const ownOnly=req.employee.role_code==='qc_controller';
    const r=await pool.query(`
      SELECT i.id,i.cycle_id,i.inspection_type,i.started_at,i.completed_at,i.comment,
        e.full_name AS controller_name,c.bin_id,c.product_name_snapshot,c.setup_code_snapshot,
        mc.version_no AS card_version,COUNT(mr.id)::int AS measured_parameters
      FROM mic2.qc_inspections i
      JOIN mic2.employees e ON e.id=i.controller_id
      JOIN mic2.production_cycles c ON c.id=i.cycle_id
      LEFT JOIN mic2.measurement_cards mc ON mc.id=i.card_id
      LEFT JOIN mic2.qc_measurement_results mr ON mr.inspection_id=i.id
      WHERE (NOT $1 OR i.controller_id=$2)
      GROUP BY i.id,e.full_name,c.id,mc.version_no
      ORDER BY i.started_at DESC LIMIT 300
    `,[ownOnly,req.employee.id]);
    res.json({ok:true,inspections:r.rows});
  }catch(e){next(e);}
});

app.get('/api/qc/history/:id', authenticate, requirePermission('qc:own:read','qc:all:read'), async (req,res,next)=>{
  const id=Number(req.params.id);
  try{
    const ownOnly=req.employee.role_code==='qc_controller';
    const r=await pool.query(`
      SELECT i.id,i.cycle_id,i.inspection_type,i.started_at,i.completed_at,i.comment,
        e.full_name AS controller_name,c.bin_id,c.product_name_snapshot,c.setup_code_snapshot,
        mc.version_no AS card_version,
        COALESCE(json_agg(json_build_object(
          'parameter_name',mp.parameter_name,'nominal_value',mp.nominal_value,
          'tolerance_text',mp.tolerance_text,'unit',mp.unit,
          'measured_value',mr.measured_value,'comment',mr.comment
        ) ORDER BY mp.sort_order) FILTER(WHERE mr.id IS NOT NULL),'[]') AS measurements
      FROM mic2.qc_inspections i
      JOIN mic2.employees e ON e.id=i.controller_id
      JOIN mic2.production_cycles c ON c.id=i.cycle_id
      LEFT JOIN mic2.measurement_cards mc ON mc.id=i.card_id
      LEFT JOIN mic2.qc_measurement_results mr ON mr.inspection_id=i.id
      LEFT JOIN mic2.measurement_parameters mp ON mp.id=mr.parameter_id
      WHERE i.id=$1 AND (NOT $2 OR i.controller_id=$3)
      GROUP BY i.id,e.full_name,c.id,mc.version_no
    `,[id,ownOnly,req.employee.id]);
    if(!r.rowCount)return res.status(404).json({ok:false,message:'Проверка не найдена'});
    res.json({ok:true,inspection:r.rows[0]});
  }catch(e){next(e);}
});

app.get('/api/qc/pending', authenticate, requirePermission('qc:queue:read'), async (_req,res,next)=>{
  try {
    const r=await pool.query(`
      SELECT c.id AS cycle_id,c.bin_id,c.cycle_no,c.product_name_snapshot,c.product_code_snapshot,
        c.setup_code_snapshot,e.full_name AS responsible_name,
        COALESCE(q.quantity,0)::int AS pending_quantity,
        COALESCE(d.quantity,0)::int AS reserved_defect_quantity,
        GREATEST(COALESCE(q.quantity,0)-COALESCE(d.quantity,0),0)::int AS available_quantity
      FROM mic2.production_cycles c
      JOIN mic2.employees e ON e.id=c.responsible_employee_id
      LEFT JOIN mic2.v_cycle_quantity_balances q ON q.cycle_id=c.id AND q.bucket='production_pending_qc'
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(confirmed_quantity),0)::int AS quantity
        FROM mic2.defects
        WHERE cycle_id=c.id AND defect_status IN ('awaiting_decision','active')
      ) d ON TRUE
      WHERE c.cycle_status='active'
        AND COALESCE(q.quantity,0)-COALESCE(d.quantity,0)>0
      ORDER BY c.started_at,c.id
    `);
    res.json({ok:true,items:r.rows});
  } catch(e){next(e);}
});

app.post('/api/qc/inspect', authenticate, requirePermission('qc:inspect:write'), async (req,res,next)=>{
  const b=req.body||{};
  const cycleId=Number(b.cycle_id),good=Number(b.good_quantity),defective=Number(b.defect_quantity);
  const description=typeof b.defect_description==='string'?b.defect_description.trim():'';
  const comment=typeof b.comment==='string'?b.comment.trim():'';
  if(!Number.isSafeInteger(cycleId)||cycleId<1||!Number.isSafeInteger(good)||good<0||!Number.isSafeInteger(defective)||defective<0||good+defective<1){
    return res.status(400).json({ok:false,message:'Укажите цикл и корректное количество годных и дефектных деталей'});
  }
  if(defective>0&&!description){
    return res.status(400).json({ok:false,message:'Опишите обнаруженный дефект'});
  }
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const cycle=await c.query("SELECT id FROM mic2.production_cycles WHERE id=$1 AND cycle_status='active' FOR UPDATE",[cycleId]);
    if(!cycle.rowCount)throw Object.assign(new Error('Активный производственный цикл не найден'),{status:404});
    const balances=await c.query(`
      SELECT
        COALESCE((SELECT quantity FROM mic2.v_cycle_quantity_balances WHERE cycle_id=$1 AND bucket='production_pending_qc'),0)::int AS pending,
        COALESCE((SELECT SUM(confirmed_quantity) FROM mic2.defects WHERE cycle_id=$1 AND defect_status IN ('awaiting_decision','active')),0)::int AS reserved
    `,[cycleId]);
    const available=Math.max(0,balances.rows[0].pending-balances.rows[0].reserved);
    if(good+defective>available)throw Object.assign(new Error(`Для контроля доступно только ${available} деталей`),{status:409});
    const inspection=await c.query(`
      INSERT INTO mic2.qc_inspections(cycle_id,controller_id,inspection_type,completed_at,comment)
      VALUES($1,$2,'scheduled_round',now(),$3) RETURNING id
    `,[cycleId,req.employee.id,comment||null]);
    let defect=null;
    if(defective>0){
      const d=await c.query(`
        INSERT INTO mic2.defects(cycle_id,confirmed_by,confirmed_quantity,defect_description)
        VALUES($1,$2,$3,$4) RETURNING id,confirmed_quantity,defect_description,defect_status
      `,[cycleId,req.employee.id,defective,description]);
      defect=d.rows[0];
    }
    if(good>0){
      await c.query(`
        INSERT INTO mic2.cycle_quantity_movements(cycle_id,movement_type,from_bucket,to_bucket,quantity,entered_by,note)
        VALUES($1,'qc_good','production_pending_qc','good_unboxed',$2,$3,$4)
      `,[cycleId,good,req.employee.id,comment||'Принято ОТК']);
    }
    await c.query('COMMIT');
    res.status(201).json({ok:true,inspection_id:inspection.rows[0].id,good_quantity:good,defect_quantity:defective,defect});
  }catch(e){
    await c.query('ROLLBACK').catch(()=>{});
    if(e.status)return res.status(e.status).json({ok:false,message:e.message});
    next(e);
  }finally{c.release();}
});

app.post('/api/bins', authenticate, requirePermission('bins:write'), async (req,res,next)=>{try{const r=await pool.query('INSERT INTO mic2.plastic_bins(created_by) VALUES($1) RETURNING id,bin_status,created_at',[req.employee.id]);res.status(201).json({ok:true,bin:r.rows[0]});}catch(e){next(e);}});

app.post('/api/cycles/:id/output', authenticate, requirePermission('output:own:write'), async (req,res,next)=>{
  const quantity=Number(req.body?.quantity); if(!Number.isSafeInteger(quantity)||quantity<1)return res.status(400).json({ok:false,message:'Количество должно быть целым числом больше нуля'});
  const c=await pool.connect(); try { await c.query('BEGIN'); const cycle=await c.query("SELECT id,responsible_employee_id FROM mic2.production_cycles WHERE id=$1 AND cycle_status='active' FOR UPDATE",[req.params.id]); if(!cycle.rowCount)throw Object.assign(new Error('Активный цикл не найден'),{status:404});
    if(String(cycle.rows[0].responsible_employee_id)!==req.employee.id)throw Object.assign(new Error('Вы не являетесь ответственным оператором'),{status:403});
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
