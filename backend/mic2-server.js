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
  throw new Error('DATABASE_URL is required for the MIC backend');
}

if (!jwtSecret || Buffer.byteLength(jwtSecret, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be set and contain at least 32 bytes');
}

const databaseIsLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // All production schedules and QC reminders use Novosibirsk local time (UTC+7).
  options: '-c timezone=Asia/Novosibirsk',
  ssl: databaseIsLocal || process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  console.error('MIC PostgreSQL pool error:', error.message);
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
  res.json({ ok: true, service: 'MIC API' });
});

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1 FROM mic2.employees LIMIT 1');
    res.json({ ok: true, service: 'MIC API', database: 'connected' });
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

    // Keep the employee signed in across browser restarts.
    // Role and account status are reloaded from the database on every authenticated request.
    const sessionLifetime = process.env.JWT_EXPIRES_IN || '30d';
    const token = jwt.sign(
      { sub: String(employee.id) },
      jwtSecret,
      { algorithm: 'HS256', expiresIn: sessionLifetime },
    );

    res.json({
      ok: true,
      token,
      token_type: 'Bearer',
      expires_in: sessionLifetime,
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
  production_manager: ['dashboard:read', 'products:read', 'products:write', 'bins:read', 'cycles:read', 'cycles:write', 'output:manage', 'operators:assign', 'shift_schedule:read', 'shift_schedule:write'],
  cnc_operator: ['dashboard:read', 'bins:read', 'products:read', 'cycles:own:read', 'cycles:own:start', 'output:own:write', 'shift_schedule:own:read'],
  qc_controller: ['dashboard:read', 'qc:queue:read', 'qc:inspect:write', 'qc:own:read', 'qc:cards:read', 'qc:defects:read', 'qc:own:shifts', 'qc:production:read', 'qc:fly:read', 'qc:fly:write'],
  qc_manager: ['dashboard:read', 'qc:queue:read', 'qc:inspect:write', 'qc:all:read', 'qc:cards:read', 'qc:cards:write', 'qc:defects:read', 'qc:defects:decide', 'qc:own:shifts', 'qc:production:read', 'qc:fly:read', 'qc:fly:write', 'shift_schedule:read', 'shift_schedule:write'],
  technical_director: ['dashboard:read', 'products:read', 'reports:read'],
});
function requireRoles(...roles) {
  return (req,res,next) => roles.includes(req.employee.role_code)
    ? next()
    : res.status(403).json({ok:false,message:'Недостаточно прав для этой операции'});
}
function hasAccess(role, permission) {
  return role === 'administrator' || (ROLE_ACCESS[role] || []).includes(permission);
}
function requirePermission(...permissions) {
  return (req,res,next) => permissions.some(permission=>hasAccess(req.employee.role_code,permission))
    ? next()
    : res.status(403).json({ok:false,message:'Недостаточно прав для этой операции'});
}

app.get('/api/dashboard', authenticate, requirePermission('dashboard:read'), async (req,res,next) => {
  try {
    if(req.employee.role_code==='cnc_operator'){
      const q=await Promise.all([
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.production_cycles WHERE responsible_employee_id=$1 AND cycle_status='active' AND production_finished_at IS NULL",[req.employee.id]),
        pool.query("SELECT COALESCE(SUM(quantity),0)::int AS quantity FROM mic2.production_output_entries WHERE operator_id=$1 AND entered_at::date=CURRENT_DATE",[req.employee.id]),
        pool.query("SELECT COALESCE(SUM(GREATEST(b.quantity-COALESCE(d.quantity,0),0)),0)::int AS quantity FROM mic2.production_cycles c JOIN mic2.v_cycle_quantity_balances b ON b.cycle_id=c.id AND b.bucket='production_pending_qc' LEFT JOIN LATERAL(SELECT COALESCE(SUM(confirmed_quantity),0)::int AS quantity FROM mic2.defects WHERE cycle_id=c.id AND defect_status IN ('awaiting_decision','active')) d ON TRUE WHERE c.responsible_employee_id=$1 AND c.cycle_status='active'",[req.employee.id]),
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.shift_assignments WHERE employee_id=$1 AND shift_date=CURRENT_DATE",[req.employee.id]),
        pool.query(`SELECT c.id,c.bin_id,c.cycle_no,c.product_code_snapshot,c.product_name_snapshot,c.started_at,c.production_finished_at,COALESCE(SUM(CASE WHEN b.bucket NOT IN ('rework_external','isolator_external','packed','scrapped') THEN b.quantity ELSE 0 END),0)::int AS physical_quantity,COALESCE(outp.output_quantity,0)::int AS output_quantity,COALESCE(s.first_piece_required,TRUE) AS first_piece_required,EXISTS(SELECT 1 FROM mic2.qc_inspections qi WHERE qi.cycle_id=c.id AND qi.inspection_type='first_piece') AS first_piece_done,(now()>=date_trunc('day',now())+interval '8 hours'+floor(GREATEST(0,extract(epoch FROM (now()-(date_trunc('day',now())+interval '8 hours')))/10800))*interval '3 hours' AND date_trunc('day',now())+interval '8 hours'+floor(GREATEST(0,extract(epoch FROM (now()-(date_trunc('day',now())+interval '8 hours')))/10800))*interval '3 hours'<COALESCE((SELECT sa.ends_at FROM mic2.shift_assignments sa WHERE sa.employee_id=c.responsible_employee_id AND sa.shift_date=CURRENT_DATE ORDER BY sa.ends_at DESC NULLS LAST LIMIT 1),date_trunc('day',now())+interval '20 hours') AND NOT EXISTS(SELECT 1 FROM mic2.qc_fly_control_events f JOIN mic2.qc_inspections qi ON qi.id=f.inspection_id WHERE qi.cycle_id=c.id AND f.scheduled_for=date_trunc('day',now())+interval '8 hours'+floor(GREATEST(0,extract(epoch FROM (now()-(date_trunc('day',now())+interval '8 hours')))/10800))*interval '3 hours')) AS fly_control_due FROM mic2.production_cycles c LEFT JOIN mic2.v_cycle_quantity_balances b ON b.cycle_id=c.id LEFT JOIN mic2.qc_control_schedules s ON s.product_id=c.product_id LEFT JOIN LATERAL(SELECT COALESCE(SUM(quantity),0)::int AS output_quantity FROM mic2.production_output_entries WHERE cycle_id=c.id) outp ON TRUE WHERE c.responsible_employee_id=$1 AND c.cycle_status='active' AND (c.production_finished_at IS NULL OR EXISTS (SELECT 1 FROM mic2.v_cycle_quantity_balances pending LEFT JOIN LATERAL(SELECT COALESCE(SUM(confirmed_quantity),0)::int AS quantity FROM mic2.defects WHERE cycle_id=c.id AND defect_status IN ('awaiting_decision','active')) reserved ON TRUE WHERE pending.cycle_id=c.id AND pending.bucket='production_pending_qc' AND pending.quantity>COALESCE(reserved.quantity,0))) GROUP BY c.id,s.first_piece_required,outp.output_quantity ORDER BY c.started_at DESC`,[req.employee.id])
      ]);
      return res.json({ok:true,active_work:q[4].rows,metrics:{active_cycles:q[0].rows[0].count,output_today:q[1].rows[0].quantity,pending_qc:q[2].rows[0].quantity,shifts_today:q[3].rows[0].count}});
    }
    if(req.employee.role_code==='qc_controller'){
      const q=await Promise.all([
        pool.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(GREATEST(q.quantity-COALESCE(d.quantity,0),0)),0)::int AS quantity FROM mic2.production_cycles c JOIN mic2.v_cycle_quantity_balances q ON q.cycle_id=c.id AND q.bucket='production_pending_qc' LEFT JOIN LATERAL(SELECT SUM(confirmed_quantity)::int AS quantity FROM mic2.defects WHERE cycle_id=c.id AND defect_status IN ('awaiting_decision','active')) d ON TRUE WHERE c.cycle_status='active' AND q.quantity>COALESCE(d.quantity,0)"),
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.qc_inspections WHERE controller_id=$1 AND completed_at::date=CURRENT_DATE",[req.employee.id]),
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.qc_fly_control_events f JOIN mic2.qc_inspections i ON i.id=f.inspection_id WHERE i.controller_id=$1 AND f.created_at::date=CURRENT_DATE",[req.employee.id]),
        pool.query("SELECT COUNT(*)::int AS count FROM mic2.shift_assignments WHERE employee_id=$1 AND shift_date=CURRENT_DATE",[req.employee.id])
      ]);
      return res.json({ok:true,metrics:{pending_cycles:q[0].rows[0].count,pending_quantity:q[0].rows[0].quantity,inspections_today:q[1].rows[0].count,fly_checks_today:q[2].rows[0].count,shifts_today:q[3].rows[0].count}});
    }
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
    const r=req.employee.role_code==='administrator'?await pool.query("SELECT id,full_name,job_title,role_code FROM mic2.employees WHERE role_code IN ('cnc_operator','qc_controller') AND account_status='active' AND terminated_at IS NULL ORDER BY role_code,full_name"):await pool.query("SELECT id,full_name,job_title,role_code FROM mic2.employees WHERE role_code=$1 AND account_status='active' AND terminated_at IS NULL ORDER BY full_name",[role]);
    res.json({ok:true,candidates:r.rows});
  } catch(e){next(e);}
});

app.get('/api/production/shifts', authenticate, requirePermission('shift_schedule:read'), async (req,res,next)=>{
  try {
    const employeeRole=req.employee.role_code==='qc_manager'?'qc_controller':'cnc_operator';
    const [r,patterns]=await Promise.all([
      pool.query(`
        SELECT s.id,s.employee_id,e.full_name,e.job_title,e.role_code,to_char(s.shift_date,'YYYY-MM-DD') AS shift_date,s.shift_code,
          s.starts_at,s.ends_at,s.attendance_status,s.actual_start_time,s.actual_end_time,s.attendance_note,s.notes,s.schedule_pattern_id
        FROM mic2.shift_assignments s
        JOIN mic2.employees e ON e.id=s.employee_id
        WHERE ($2::boolean OR e.role_code=$1)
          AND s.shift_date >= CURRENT_DATE - INTERVAL '365 days'
          AND s.shift_date < CURRENT_DATE + INTERVAL '731 days'
        ORDER BY s.shift_date,s.shift_code,e.full_name
      `,[employeeRole,req.employee.role_code==='administrator']),
      pool.query(`
        SELECT p.id,p.employee_id,e.full_name,p.pattern_code,to_char(p.start_date,'YYYY-MM-DD') AS start_date,to_char(p.end_date,'YYYY-MM-DD') AS end_date,p.created_at
        FROM mic2.shift_schedule_patterns p
        JOIN mic2.employees e ON e.id=p.employee_id
        WHERE p.is_active AND ($2::boolean OR e.role_code=$1)
        ORDER BY e.full_name
      `,[employeeRole,req.employee.role_code==='administrator'])
    ]);
    res.json({ok:true,shifts:r.rows,patterns:patterns.rows});
  } catch(e){next(e);}
});

app.post('/api/production/shifts', authenticate, requirePermission('shift_schedule:write'), async (req,res,next)=>{
  const b=req.body||{};
  const employeeId=Number(b.employee_id);
  const shiftDate=typeof b.shift_date==='string'?b.shift_date:'';
  const shiftCode=typeof b.shift_code==='string'?b.shift_code.trim():'';
  const allowedRole=req.employee.role_code==='qc_manager'?'qc_controller':'cnc_operator';
  if(!Number.isSafeInteger(employeeId)||employeeId<1||!/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)||!['day','night'].includes(shiftCode)){
    return res.status(400).json({ok:false,message:'Укажите сотрудника, дату и дневную или ночную смену'});
  }
  try{
    const e=await pool.query("SELECT id,role_code FROM mic2.employees WHERE id=$1 AND role_code IN ('cnc_operator','qc_controller') AND account_status='active' AND terminated_at IS NULL",[employeeId]);
    if(!e.rowCount)return res.status(400).json({ok:false,message:'Нельзя назначить неактивного сотрудника или сотрудника другой специализации'});
    const targetRole=e.rows[0].role_code;
    if(req.employee.role_code==='qc_manager'&&targetRole!=='qc_controller')return res.status(403).json({ok:false,message:'Начальник ОТК может назначать только контролёров ОТК'});
    if(req.employee.role_code==='production_manager'&&targetRole!=='cnc_operator')return res.status(403).json({ok:false,message:'Начальник производства может назначать только операторов ЧПУ'});
    if(targetRole==='qc_controller'&&shiftCode!=='day')return res.status(400).json({ok:false,message:'Для контролёров ОТК предусмотрены только дневные смены'});
    const r=await pool.query(`
      INSERT INTO mic2.shift_assignments(employee_id,shift_date,shift_code,starts_at,ends_at,assigned_by,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id,employee_id,shift_date,shift_code,starts_at,ends_at,attendance_status,notes
    `,[employeeId,shiftDate,shiftCode,b.starts_at||null,b.ends_at||null,req.employee.id,b.notes||null]);
    res.status(201).json({ok:true,shift:r.rows[0]});
  }catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'Сотрудник уже назначен на эту смену'});next(e);}
});


app.patch('/api/production/shifts/:id/attendance-times', authenticate, requireRoles('qc_manager'), async(req,res,next)=>{
 const id=Number(req.params.id),body=req.body||{};
 const start=body.actual_start_time==null?'':String(body.actual_start_time).trim();
 const end=body.actual_end_time==null?'':String(body.actual_end_time).trim();
 const validTime=v=>!v||/^([01]\\d|2[0-3]):[0-5]\\d$/.test(v);
 if(!Number.isSafeInteger(id)||id<1||!validTime(start)||!validTime(end))
  return res.status(400).json({ok:false,message:'Укажите корректное время прихода и ухода'});
 try{
  const r=await pool.query(`
   UPDATE mic2.shift_assignments s
   SET actual_start_time=$2::time,
       actual_end_time=$3::time,
       attendance_adjusted_by=$4,
       attendance_adjusted_at=now()
   FROM mic2.employees e
   WHERE s.id=$1 AND s.employee_id=e.id AND e.role_code='qc_controller'
   RETURNING s.id,s.actual_start_time,s.actual_end_time,s.attendance_status,s.attendance_adjusted_at
  `,[id,start||null,end||null,req.employee.id]);
  if(!r.rowCount)return res.status(404).json({ok:false,message:'Смена контролёра ОТК не найдена'});
  res.json({ok:true,shift:r.rows[0]});
 }catch(e){next(e);}
});


app.post('/api/production/shift-patterns', authenticate, requirePermission('shift_schedule:write'), async(req,res,next)=>{
  const b=req.body||{};
  const employeeId=Number(b.employee_id);
  const patternCode=typeof b.pattern_code==='string'?b.pattern_code:'';
  const startDate=typeof b.start_date==='string'?b.start_date:'';
  if(!Number.isSafeInteger(employeeId)||employeeId<1||!['3x3','5x2','2x2x4'].includes(patternCode)||!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||Number.isNaN(Date.parse(startDate+'T00:00:00Z'))||new Date(startDate+'T00:00:00Z').toISOString().slice(0,10)!==startDate){
    return res.status(400).json({ok:false,message:'Укажите сотрудника, допустимый график и корректную дату начала'});
  }
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const employeeResult=await client.query(
      "SELECT id,role_code FROM mic2.employees WHERE id=$1 AND role_code IN ('qc_controller','cnc_operator') AND account_status='active' AND terminated_at IS NULL FOR UPDATE",
      [employeeId]
    );
    if(!employeeResult.rowCount){
      await client.query('ROLLBACK');
      return res.status(400).json({ok:false,message:'Выбрать можно только действующего сотрудника'});
    }
    const targetRole=employeeResult.rows[0].role_code;
    const roleAllowed =
      (targetRole==='qc_controller' && ['qc_manager','administrator'].includes(req.employee.role_code) && ['3x3','5x2'].includes(patternCode)) ||
      (targetRole==='cnc_operator' && ['production_manager','administrator'].includes(req.employee.role_code) && patternCode==='2x2x4');
    if(!roleAllowed){
      await client.query('ROLLBACK');
      return res.status(403).json({ok:false,message:'Для контролёров ОТК доступны графики 3/3 и 5/2, для операторов ЧПУ — только 2/2/4'});
    }
    const bounds=await client.query(
      "SELECT CURRENT_DATE::text AS today, ($1::date + INTERVAL '12 months')::date::text AS end_date",
      [startDate]
    );
    const today=bounds.rows[0].today;
    const endDate=bounds.rows[0].end_date;
    await client.query(`
      DELETE FROM mic2.shift_assignments
      WHERE employee_id=$1
        AND shift_code IN ('day','night')
        AND shift_date >= GREATEST($2::date,CURRENT_DATE)
        AND attendance_status='pending'
    `,[employeeId,startDate]);
    await client.query(`
      UPDATE mic2.shift_schedule_patterns
      SET is_active=FALSE,replaced_at=now(),replaced_by=$2
      WHERE employee_id=$1 AND is_active
    `,[employeeId,req.employee.id]);
    const created=await client.query(`
      INSERT INTO mic2.shift_schedule_patterns
        (employee_id,pattern_code,start_date,end_date,created_by,notes)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING id,employee_id,pattern_code,start_date,end_date,is_active
    `,[employeeId,patternCode,startDate,endDate,req.employee.id,b.notes||null]);
    const pattern=created.rows[0];
    const start=new Date(startDate+'T00:00:00Z');
    const first=new Date((startDate>today?startDate:today)+'T00:00:00Z');
    const end=new Date(endDate+'T00:00:00Z');
    const scheduledDates=[],scheduledCodes=[];
    for(let day=new Date(first);day<end;day.setUTCDate(day.getUTCDate()+1)){
      const offset=Math.round((day.getTime()-start.getTime())/86400000);
      const weekday=day.getUTCDay();
      if(patternCode==='2x2x4'){
        const phase=offset%8;
        if(phase===0||phase===1){scheduledDates.push(day.toISOString().slice(0,10));scheduledCodes.push('day');}
        else if(phase===2||phase===3){scheduledDates.push(day.toISOString().slice(0,10));scheduledCodes.push('night');}
      } else {
        const working=patternCode==='3x3'?(offset%6)<3:(weekday>=1&&weekday<=5);
        if(working){scheduledDates.push(day.toISOString().slice(0,10));scheduledCodes.push('day');}
      }
    }
    const patternLabel=patternCode==='2x2x4'?'2 дневные / 2 ночные / 4 выходных':patternCode==='3x3'?'3/3':'5/2';
    const generated=await client.query(`
      INSERT INTO mic2.shift_assignments AS existing
        (employee_id,shift_date,shift_code,assigned_by,notes,schedule_pattern_id)
      SELECT $1,dates.shift_date,dates.shift_code,$2,$3,$4
      FROM unnest($5::date[],$6::text[]) AS dates(shift_date,shift_code)
      ON CONFLICT(employee_id,shift_date,shift_code) DO UPDATE
        SET schedule_pattern_id=EXCLUDED.schedule_pattern_id,notes=EXCLUDED.notes
        WHERE existing.attendance_status='pending'
      RETURNING id
    `,[employeeId,req.employee.id,'Автоматически по графику '+patternLabel,pattern.id,scheduledDates,scheduledCodes]);
    const inserted=generated.rowCount;
    await client.query('COMMIT');
    res.status(201).json({ok:true,pattern,generated_shifts:inserted,period_start:first.toISOString().slice(0,10),period_end:endDate});
  }catch(e){
    await client.query('ROLLBACK');
    if(e.code==='23505')return res.status(409).json({ok:false,message:'Для сотрудника уже существует активный график. Обновите страницу и повторите операцию.'});
    next(e);
  }finally{client.release();}
});

app.get('/api/qc/calendar', authenticate, requireRoles('qc_controller'), async(req,res,next)=>{
 try{
  const [shifts,patterns]=await Promise.all([
   pool.query(`
    SELECT s.id,s.employee_id,e.full_name,e.job_title,e.role_code,
     to_char(s.shift_date,'YYYY-MM-DD') AS shift_date,s.shift_code,
     s.starts_at,s.ends_at,s.attendance_status,s.actual_start_time,s.actual_end_time,s.notes,s.attendance_note,
     (s.employee_id=$1) AS is_own
    FROM mic2.shift_assignments s
    JOIN mic2.employees e ON e.id=s.employee_id
    WHERE e.role_code='qc_controller' AND e.account_status='active' AND e.terminated_at IS NULL
      AND s.shift_date>=CURRENT_DATE-INTERVAL '365 days'
      AND s.shift_date<CURRENT_DATE+INTERVAL '366 days'
    ORDER BY s.shift_date,e.full_name
   `,[req.employee.id]),
   pool.query(`
    SELECT p.id,p.employee_id,e.full_name,p.pattern_code,
     to_char(p.start_date,'YYYY-MM-DD') AS start_date,
     to_char(p.end_date,'YYYY-MM-DD') AS end_date
    FROM mic2.shift_schedule_patterns p
    JOIN mic2.employees e ON e.id=p.employee_id
    WHERE p.is_active AND e.role_code='qc_controller'
      AND e.account_status='active' AND e.terminated_at IS NULL
    ORDER BY e.full_name
   `)
  ]);
  res.json({ok:true,shifts:shifts.rows,patterns:patterns.rows});
 }catch(e){next(e);}
});

app.post('/api/qc/my-shifts/:id/attendance', authenticate, requireRoles('qc_controller'), async(req,res,next)=>{
 const id=Number(req.params.id),b=req.body||{};
 const status=typeof b.attendance_status==='string'?b.attendance_status:'';
 const note=typeof b.attendance_note==='string'?b.attendance_note.trim():'';
 const actualTime=typeof b.actual_time==='string'&&b.actual_time.trim()?b.actual_time.trim():(status==='present'?'08:00':'');
 if(!Number.isSafeInteger(id)||id<1||!['present','absent','left_early'].includes(status))
  return res.status(400).json({ok:false,message:'Выберите корректный статус явки'});
 if(note.length>500)return res.status(400).json({ok:false,message:'Комментарий не должен превышать 500 символов'});
 if(status==='left_early'&&!note)return res.status(400).json({ok:false,message:'Укажите причину раннего ухода'});
 const timeParts=actualTime.split(':');
 const validTime=actualTime.length===5&&timeParts.length===2&&timeParts.every(part=>part.length===2&&[...part].every(ch=>ch>='0'&&ch<='9'))&&Number(timeParts[0])<=23&&Number(timeParts[1])<=59;
 if(['present','left_early'].includes(status)&&!validTime)
  return res.status(400).json({ok:false,message:status==='present'?'Укажите фактическое время прихода':'Укажите фактическое время ухода'});
 try{
  const r=await pool.query(`
   UPDATE mic2.shift_assignments
   SET attendance_status=$3,attendance_note=$4,
    actual_start_time=CASE WHEN $3='present' THEN $5::time WHEN $3='absent' THEN NULL ELSE actual_start_time END,
    actual_end_time=CASE WHEN $3='left_early' THEN $5::time WHEN $3='present' THEN NULL WHEN $3='absent' THEN NULL ELSE actual_end_time END,
    attendance_confirmed_by=$2,attendance_confirmed_at=now()
   WHERE id=$1 AND employee_id=$2
    AND shift_date<=CURRENT_DATE
    AND shift_date>=CURRENT_DATE-INTERVAL '7 days'
   RETURNING id,attendance_status,attendance_note,actual_start_time,actual_end_time,attendance_confirmed_at
  `,[id,req.employee.id,status,note||null,actualTime||null]);
  if(!r.rowCount)return res.status(404).json({ok:false,message:'Смена не найдена, не принадлежит вам или дата смены ещё не наступила'});
  res.json({ok:true,shift:r.rows[0]});
 }catch(e){next(e);}
});

app.post('/api/cnc/my-shifts/:id/attendance', authenticate, requireRoles('cnc_operator'), async(req,res,next)=>{
 const id=Number(req.params.id),b=req.body||{};
 const status=typeof b.attendance_status==='string'?b.attendance_status:'';
 const note=typeof b.attendance_note==='string'?b.attendance_note.trim():'';
 const actualTime=typeof b.actual_time==='string'&&b.actual_time.trim()?b.actual_time.trim():(status==='present'?'08:00':'');
 if(!Number.isSafeInteger(id)||id<1||!['present','absent','left_early'].includes(status))
  return res.status(400).json({ok:false,message:'Выберите корректный статус явки'});
 if(note.length>500)return res.status(400).json({ok:false,message:'Комментарий не должен превышать 500 символов'});
 if(status==='left_early'&&!note)return res.status(400).json({ok:false,message:'Укажите причину раннего ухода'});
 const timeParts=actualTime.split(':');
 const validTime=timeParts.length===2&&timeParts[0].length===2&&timeParts[1].length===2&&timeParts.every(part=>Array.from(part).every(ch=>ch>='0'&&ch<='9'))&&Number(timeParts[0])>=0&&Number(timeParts[0])<=23&&Number(timeParts[1])>=0&&Number(timeParts[1])<=59;
 if(['present','left_early'].includes(status)&&!validTime)
  return res.status(400).json({ok:false,message:status==='present'?'Укажите фактическое время прихода':'Укажите фактическое время ухода'});
 try{
  const r=await pool.query(`
   UPDATE mic2.shift_assignments
   SET attendance_status=$3,attendance_note=$4,
    actual_start_time=CASE WHEN $3='present' THEN $5::time WHEN $3='absent' THEN NULL ELSE actual_start_time END,
    actual_end_time=CASE WHEN $3='left_early' THEN $5::time WHEN $3='present' THEN NULL WHEN $3='absent' THEN NULL ELSE actual_end_time END,
    attendance_confirmed_by=$2,attendance_confirmed_at=now()
   WHERE id=$1 AND employee_id=$2
    AND shift_date<=CURRENT_DATE
    AND shift_date>=CURRENT_DATE-INTERVAL '7 days'
   RETURNING id,attendance_status,attendance_note,actual_start_time,actual_end_time,attendance_confirmed_at
  `,[id,req.employee.id,status,note||null,actualTime||null]);
  if(!r.rowCount)return res.status(404).json({ok:false,message:'Смена не найдена, не принадлежит вам или дата смены ещё не наступила'});
  res.json({ok:true,shift:r.rows[0]});
 }catch(e){next(e);}
});

app.get('/api/cnc/my-shifts', authenticate, requirePermission('shift_schedule:own:read'), async(req,res,next)=>{
 try{
  const r=await pool.query(`
   SELECT id,shift_date,shift_code,starts_at,ends_at,attendance_status,notes
   FROM mic2.shift_assignments
   WHERE employee_id=$1 AND shift_date>=CURRENT_DATE-INTERVAL '30 days'
     AND shift_date<CURRENT_DATE+INTERVAL '366 days'
   ORDER BY shift_date,starts_at
  `,[req.employee.id]);
  res.json({ok:true,shifts:r.rows});
 }catch(e){next(e);}
});
app.get('/api/cnc/team-shifts', authenticate, requireRoles('cnc_operator'), async(req,res,next)=>{
 try{
  const r=await pool.query(`
   SELECT s.id,s.employee_id,e.full_name,s.shift_date,s.shift_code,s.starts_at,s.ends_at,
    s.attendance_status,s.attendance_note,s.actual_start_time,s.actual_end_time,s.notes
   FROM mic2.shift_assignments s
   JOIN mic2.employees e ON e.id=s.employee_id
   WHERE e.role_code='cnc_operator' AND e.account_status='active' AND e.terminated_at IS NULL
    AND s.shift_date>=CURRENT_DATE-INTERVAL '30 days'
    AND s.shift_date<CURRENT_DATE+INTERVAL '366 days'
   ORDER BY s.shift_date,s.starts_at,e.full_name
  `);
  res.json({ok:true,shifts:r.rows});
 }catch(e){next(e);}
});

app.get('/api/qc/my-shifts', authenticate, requirePermission('qc:own:shifts'), async(req,res,next)=>{
 try{
  const r=await pool.query(`
   SELECT id,shift_date,shift_code,starts_at,ends_at,attendance_status,notes
   FROM mic2.shift_assignments
   WHERE employee_id=$1 AND shift_date>=CURRENT_DATE-INTERVAL '30 days'
     AND shift_date<CURRENT_DATE+INTERVAL '366 days'
   ORDER BY shift_date,starts_at
  `,[req.employee.id]);
  res.json({ok:true,shifts:r.rows});
 }catch(e){next(e);}
});

app.get('/api/qc/production', authenticate, requirePermission('qc:production:read'), async(_req,res,next)=>{
 try{
  const r=await pool.query(`
   SELECT c.id AS cycle_id,c.bin_id,c.cycle_no,c.started_at,c.product_code_snapshot,
    c.product_name_snapshot,''::text AS setup_code_snapshot,e.full_name AS operator_name,
    COALESCE(outp.output_quantity,0)::int AS output_quantity,
    COALESCE(bal.pending_qc,0)::int AS pending_qc,
    COALESCE(bal.good_quantity,0)::int AS good_quantity,
    COALESCE(bal.rework_quantity,0)::int AS rework_quantity,
    COALESCE(bal.isolator_quantity,0)::int AS isolator_quantity,
    c.card_id,mc.version_no AS card_version,
    COALESCE(params.parameters,'[]'::json) AS measurement_parameters
   FROM mic2.production_cycles c
   JOIN mic2.employees e ON e.id=c.responsible_employee_id
   LEFT JOIN LATERAL(SELECT SUM(quantity)::int AS output_quantity FROM mic2.production_output_entries WHERE cycle_id=c.id) outp ON TRUE
   LEFT JOIN LATERAL(SELECT
    SUM(quantity) FILTER(WHERE bucket='production_pending_qc')::int AS pending_qc,
    SUM(quantity) FILTER(WHERE bucket='good_unboxed')::int AS good_quantity,
    SUM(quantity) FILTER(WHERE bucket='rework')::int AS rework_quantity,
    SUM(quantity) FILTER(WHERE bucket='isolator')::int AS isolator_quantity
    FROM mic2.v_cycle_quantity_balances WHERE cycle_id=c.id) bal ON TRUE
   LEFT JOIN mic2.measurement_cards mc ON mc.id=c.card_id
   LEFT JOIN LATERAL(SELECT json_agg(json_build_object('id',mp.id,'parameter_name',mp.parameter_name,'installation_no',mp.installation_no,'drawing_dimension',COALESCE(mp.drawing_dimension,mp.nominal_value),'dimension_prefix',mp.dimension_prefix,'upper_deviation',mp.upper_deviation,'lower_deviation',mp.lower_deviation,
    'nominal_value',mp.nominal_value,'tolerance_text',mp.tolerance_text,'unit',mp.unit,
    'instruction',mp.instruction) ORDER BY mp.sort_order) AS parameters
    FROM mic2.measurement_parameters mp WHERE mp.card_id=c.card_id) params ON TRUE
   WHERE c.cycle_status='active' AND c.production_finished_at IS NULL
   ORDER BY c.started_at,c.bin_id
  `);
  res.json({ok:true,cycles:r.rows});
 }catch(e){next(e);}
});

app.get('/api/qc/control-schedules', authenticate, requirePermission('accounts:create'), async(_req,res,next)=>{
 try{
  const r=await pool.query(`SELECT p.id AS product_id,p.product_code,p.product_name,
   COALESCE(s.first_piece_required,TRUE) AS first_piece_required,
   '08:00'::text AS fly_control_start_time,3::int AS fly_control_interval_hours
   FROM mic2.products p LEFT JOIN mic2.qc_control_schedules s ON s.product_id=p.id
   WHERE p.is_active ORDER BY p.product_name`);
  res.json({ok:true,schedules:r.rows});
 }catch(e){next(e);}
});
app.put('/api/qc/control-schedules/:productId', authenticate, requirePermission('accounts:create'), async(req,res,next)=>{
 const productId=Number(req.params.productId),b=req.body||{};
 if(!Number.isSafeInteger(productId)||productId<1||typeof b.first_piece_required!=='boolean')
  return res.status(400).json({ok:false,message:'Укажите корректные параметры контроля'});
 try{
  const p=await pool.query('SELECT id FROM mic2.products WHERE id=$1 AND is_active',[productId]);
  if(!p.rowCount)return res.status(404).json({ok:false,message:'Изделие не найдено'});
  const r=await pool.query(`INSERT INTO mic2.qc_control_schedules(product_id,first_piece_required,updated_by,updated_at)
   VALUES($1,$2,$3,now()) ON CONFLICT(product_id) DO UPDATE SET first_piece_required=EXCLUDED.first_piece_required,
   updated_by=EXCLUDED.updated_by,updated_at=now()`,[productId,b.first_piece_required,req.employee.id]);
  res.json({ok:true,schedule:r.rows[0]});
 }catch(e){next(e);}
});

app.get('/api/qc/fly-control', authenticate, requirePermission('qc:fly:read'), async(req,res,next)=>{
 try{
  const ownOnly=req.employee.role_code==='qc_controller';
  const created=await pool.query(`
   WITH active AS (
    SELECT c.id AS cycle_id,date_trunc('day',now())+interval '8 hours' AS shift_start,
     COALESCE((SELECT sa.ends_at FROM mic2.shift_assignments sa WHERE sa.employee_id=c.responsible_employee_id AND sa.shift_date=CURRENT_DATE ORDER BY sa.ends_at DESC NULLS LAST LIMIT 1),date_trunc('day',now())+interval '20 hours') AS shift_end
    FROM mic2.production_cycles c WHERE c.cycle_status='active' AND c.production_finished_at IS NULL
   ), slots AS (
    SELECT a.cycle_id,g.slot AS scheduled_for,LEAST(g.slot+interval '3 hours',a.shift_end) AS window_end
    FROM active a CROSS JOIN LATERAL generate_series(a.shift_start,a.shift_end-interval '1 microsecond',interval '3 hours') g(slot)
    WHERE a.shift_end>a.shift_start
   )
   INSERT INTO mic2.qc_fly_control_schedule_events(cycle_id,scheduled_for,window_end)
   SELECT cycle_id,scheduled_for,window_end FROM slots
   ON CONFLICT(cycle_id,scheduled_for) DO NOTHING RETURNING id
  `);
  if(created.rowCount)await pool.query(`INSERT INTO mic2.qc_fly_control_journal(schedule_event_id,action,details)
   SELECT unnest($1::bigint[]),'scheduled','{"source":"automatic_schedule"}'::jsonb`,[created.rows.map(x=>x.id)]);
  const missed=await pool.query(`UPDATE mic2.qc_fly_control_schedule_events SET status='missed',updated_at=now()
   WHERE status IN ('pending','scheduled') AND window_end<=now()
    AND NOT EXISTS(SELECT 1 FROM mic2.qc_fly_control_events f JOIN mic2.qc_inspections i ON i.id=f.inspection_id
      WHERE i.cycle_id=mic2.qc_fly_control_schedule_events.cycle_id AND f.scheduled_for=mic2.qc_fly_control_schedule_events.scheduled_for)
   RETURNING id`);
  if(missed.rowCount)await pool.query(`INSERT INTO mic2.qc_fly_control_journal(schedule_event_id,action,details)
   SELECT unnest($1::bigint[]),'missed','{"reason":"window_expired_without_inspection"}'::jsonb`,[missed.rows.map(x=>x.id)]);
  // Activate only the next due interval after every earlier interval is closed.
  await pool.query(`UPDATE mic2.qc_fly_control_schedule_events current_event
   SET status='pending',updated_at=now()
   WHERE current_event.status='scheduled'
    AND current_event.scheduled_for<=now() AND current_event.window_end>now()
    AND NOT EXISTS(
     SELECT 1 FROM mic2.qc_fly_control_schedule_events previous_event
     WHERE previous_event.cycle_id=current_event.cycle_id
      AND previous_event.scheduled_for<current_event.scheduled_for
      AND previous_event.status NOT IN ('completed','missed')
    )`);
  const completed=await pool.query(`UPDATE mic2.qc_fly_control_schedule_events se
   SET status='completed',completed_inspection_id=i.id,updated_at=now()
   FROM mic2.qc_fly_control_events f JOIN mic2.qc_inspections i ON i.id=f.inspection_id
   WHERE se.cycle_id=i.cycle_id AND se.scheduled_for=f.scheduled_for AND se.status<>'completed'
   RETURNING se.id`);
  if(completed.rowCount)await pool.query(`INSERT INTO mic2.qc_fly_control_journal(schedule_event_id,action,details)
   SELECT unnest($1::bigint[]),'completed','{"source":"inspection_reconciliation"}'::jsonb`,[completed.rows.map(x=>x.id)]);
  const [checks,schedule,journal]=await Promise.all([
   pool.query(`SELECT f.id,f.inspection_id,f.sample_quantity,f.inspection_result,f.defect_quantity,f.defect_description,f.action_required,f.created_at,i.cycle_id,i.comment,
    c.bin_id,c.cycle_no,c.product_code_snapshot,c.product_name_snapshot,''::text AS setup_code_snapshot,e.full_name AS controller_name,mc.version_no AS card_version,
    (SELECT COUNT(*)::int FROM mic2.qc_measurement_results mr WHERE mr.inspection_id=i.id) AS measured_parameters
    FROM mic2.qc_fly_control_events f JOIN mic2.qc_inspections i ON i.id=f.inspection_id JOIN mic2.production_cycles c ON c.id=i.cycle_id
    JOIN mic2.employees e ON e.id=i.controller_id LEFT JOIN mic2.measurement_cards mc ON mc.id=i.card_id
    WHERE (NOT $1 OR i.controller_id=$2) ORDER BY f.created_at DESC LIMIT 300`,[ownOnly,req.employee.id]),
   pool.query(`SELECT se.id,se.cycle_id,se.scheduled_for,se.window_end,se.status,se.completed_inspection_id,c.bin_id,c.cycle_no,
    c.product_code_snapshot,c.product_name_snapshot,op.full_name AS operator_name,
    EXTRACT(EPOCH FROM (se.window_end-now()))::int AS seconds_remaining,
    f.id AS fly_event_id,f.inspection_result,f.defect_quantity,qc.full_name AS controller_name
    FROM mic2.qc_fly_control_schedule_events se JOIN mic2.production_cycles c ON c.id=se.cycle_id
    JOIN mic2.employees op ON op.id=c.responsible_employee_id
    LEFT JOIN mic2.qc_inspections i ON i.id=se.completed_inspection_id LEFT JOIN mic2.employees qc ON qc.id=i.controller_id
    LEFT JOIN mic2.qc_fly_control_events f ON f.inspection_id=i.id
    WHERE se.scheduled_for::date=CURRENT_DATE AND (c.cycle_status='active' OR se.status IN ('missed','completed'))
    ORDER BY se.scheduled_for ASC,c.bin_id`),
   pool.query(`SELECT j.id,j.action,j.details,j.created_at,se.scheduled_for,se.cycle_id,c.bin_id,c.product_name_snapshot,e.full_name AS actor_name
    FROM mic2.qc_fly_control_journal j JOIN mic2.qc_fly_control_schedule_events se ON se.id=j.schedule_event_id
    JOIN mic2.production_cycles c ON c.id=se.cycle_id LEFT JOIN mic2.employees e ON e.id=j.actor_id
    WHERE se.scheduled_for::date=CURRENT_DATE ORDER BY j.created_at DESC LIMIT 500`)
  ]);
  const due=schedule.rows.filter(x=>x.status==='pending'&&new Date(x.scheduled_for)<=new Date()&&new Date(x.window_end)>new Date());
  res.json({ok:true,checks:checks.rows,schedule:schedule.rows,journal:journal.rows,active_due:due});
 }catch(e){next(e);}
});

app.get('/api/qc/fly-control/:id', authenticate, requirePermission('qc:fly:read'), async(req,res,next)=>{
 const id=Number(req.params.id);
 if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({ok:false,message:'Некорректная проверка'});
 try{
  const ownOnly=req.employee.role_code==='qc_controller';
  const r=await pool.query(`
   SELECT f.id,f.inspection_id,f.sample_quantity,f.inspection_result,f.defect_quantity,
    f.defect_description,f.action_required,f.created_at,i.cycle_id,i.comment,
    c.bin_id,c.cycle_no,c.product_code_snapshot,c.product_name_snapshot,''::text AS setup_code_snapshot,
    e.full_name AS controller_name,mc.version_no AS card_version,
    COALESCE(json_agg(json_build_object('parameter_name',mp.parameter_name,'installation_no',mp.installation_no,'drawing_dimension',COALESCE(mp.drawing_dimension,mp.nominal_value),'dimension_prefix',mp.dimension_prefix,'upper_deviation',mp.upper_deviation,'lower_deviation',mp.lower_deviation,
     'nominal_value',mp.nominal_value,'tolerance_text',mp.tolerance_text,'unit',mp.unit,
     'measured_value',mr.measured_value,'comment',mr.comment)
     ORDER BY mp.sort_order) FILTER(WHERE mr.id IS NOT NULL),'[]'::json) AS measurements
   FROM mic2.qc_fly_control_events f
   JOIN mic2.qc_inspections i ON i.id=f.inspection_id
   JOIN mic2.production_cycles c ON c.id=i.cycle_id
   JOIN mic2.employees e ON e.id=i.controller_id
   LEFT JOIN mic2.measurement_cards mc ON mc.id=i.card_id
   LEFT JOIN mic2.qc_measurement_results mr ON mr.inspection_id=i.id
   LEFT JOIN mic2.measurement_parameters mp ON mp.id=mr.parameter_id
   WHERE f.id=$1 AND (NOT $2 OR i.controller_id=$3)
   GROUP BY f.id,i.id,c.id,e.full_name,mc.version_no
  `,[id,ownOnly,req.employee.id]);
  if(!r.rowCount)return res.status(404).json({ok:false,message:'Летучая проверка не найдена'});
  res.json({ok:true,check:r.rows[0]});
 }catch(e){next(e);}
});

app.post('/api/qc/fly-control', authenticate, requirePermission('qc:fly:write'), async(req,res,next)=>{
 const b=req.body||{},cycleId=Number(b.cycle_id),sample=Number(b.sample_quantity),installationNo=Number(b.installation_no),
  defectQty=Number(b.defect_quantity||0),result=String(b.inspection_result||''),
  description=typeof b.defect_description==='string'?b.defect_description.trim():'',
  actionRequired=Boolean(b.action_required),comment=typeof b.comment==='string'?b.comment.trim():'';
 const measurements=Array.isArray(b.measurements)?b.measurements:[];
 if(!Number.isSafeInteger(cycleId)||cycleId<1||!Number.isSafeInteger(installationNo)||installationNo<1||!Number.isSafeInteger(sample)||sample<1||
  !Number.isSafeInteger(defectQty)||defectQty<0||defectQty>sample||
  !['pass','fail','observation'].includes(result)||
  (result==='fail'&&(defectQty<1||!description))||
  (result==='pass'&&defectQty!==0)||
  measurements.length>100||
  new Set(measurements.map(m=>String(m.parameter_id))).size!==measurements.length)
  return res.status(400).json({ok:false,message:'Проверьте размер выборки, результат и описание несоответствия'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const cycle=await c.query("SELECT pc.id,pc.card_id,(SELECT COALESCE(SUM(quantity),0)::int FROM mic2.production_output_entries WHERE cycle_id=pc.id) AS output_quantity,COALESCE((SELECT sa.ends_at FROM mic2.shift_assignments sa WHERE sa.employee_id=pc.responsible_employee_id AND sa.shift_date=CURRENT_DATE ORDER BY sa.ends_at DESC NULLS LAST LIMIT 1),date_trunc('day',now())+interval '20 hours') AS shift_ends_at,date_trunc('day',now())+interval '8 hours'+floor(GREATEST(0,extract(epoch FROM (now()-(date_trunc('day',now())+interval '8 hours')))/10800))*interval '3 hours' AS current_fly_slot FROM mic2.production_cycles pc WHERE pc.id=$1 AND pc.cycle_status='active' AND pc.production_finished_at IS NULL FOR UPDATE OF pc",[cycleId]);
  if(!cycle.rowCount)throw Object.assign(new Error('Активный производственный цикл не найден'),{status:404});
  // Fly-control sample size is independent of the quantity entered as production output.
  const slot=cycle.rows[0].current_fly_slot;
  const slotCheck=await c.query('SELECT now()>=$1::timestamptz AND $1::timestamptz<$2::timestamptz AS allowed',[slot,cycle.rows[0].shift_ends_at]);
  if(!slotCheck.rows[0].allowed)throw Object.assign(new Error('Летучий контроль проводится по расписанию: в 08:00 и далее каждые 3 часа до конца смены'),{status:409});
  // Ensure all expected slots exist even if the client calls this endpoint directly.
  await c.query(`INSERT INTO mic2.qc_fly_control_schedule_events(cycle_id,scheduled_for,window_end,status)
   SELECT $1,g.slot,LEAST(g.slot+interval '3 hours',$2::timestamptz),'scheduled'
   FROM generate_series(date_trunc('day',now())+interval '8 hours',$2::timestamptz-interval '1 microsecond',interval '3 hours') g(slot)
   WHERE $2::timestamptz>date_trunc('day',now())+interval '8 hours'
   ON CONFLICT(cycle_id,scheduled_for) DO NOTHING`,[cycleId,cycle.rows[0].shift_ends_at]);
  // Close expired earlier slots, then refuse to skip any interval still open.
  await c.query(`UPDATE mic2.qc_fly_control_schedule_events
   SET status='missed',updated_at=now()
   WHERE cycle_id=$1 AND scheduled_for<$2 AND status IN ('pending','scheduled')
    AND window_end<=now()
    AND NOT EXISTS(SELECT 1 FROM mic2.qc_fly_control_events f JOIN mic2.qc_inspections i ON i.id=f.inspection_id
     WHERE i.cycle_id=mic2.qc_fly_control_schedule_events.cycle_id
      AND f.scheduled_for=mic2.qc_fly_control_schedule_events.scheduled_for)`,[cycleId,slot]);
  const previousOpen=await c.query(`SELECT scheduled_for FROM mic2.qc_fly_control_schedule_events
   WHERE cycle_id=$1 AND scheduled_for<$2 AND status NOT IN ('completed','missed')
   ORDER BY scheduled_for LIMIT 1`,[cycleId,slot]);
  if(previousOpen.rowCount)throw Object.assign(new Error('Сначала закройте предыдущий интервал летучего контроля'),{status:409});
  const currentEvent=await c.query(`INSERT INTO mic2.qc_fly_control_schedule_events(cycle_id,scheduled_for,window_end,status)
   VALUES($1,$2,LEAST($2::timestamptz+interval '3 hours',$3::timestamptz),'pending')
   ON CONFLICT(cycle_id,scheduled_for) DO UPDATE
    SET status=CASE WHEN mic2.qc_fly_control_schedule_events.status='scheduled' THEN 'pending'
                    ELSE mic2.qc_fly_control_schedule_events.status END,
        updated_at=now()
   RETURNING status`,[cycleId,slot,cycle.rows[0].shift_ends_at]);
  if(currentEvent.rows[0].status!=='pending')throw Object.assign(new Error('Этот интервал уже закрыт или недоступен'),{status:409});
  const already=await c.query('SELECT 1 FROM mic2.qc_fly_control_events f JOIN mic2.qc_inspections qi ON qi.id=f.inspection_id WHERE qi.cycle_id=$1 AND f.scheduled_for=$2 LIMIT 1',[cycleId,slot]);
  if(already.rowCount)throw Object.assign(new Error('Летучий контроль за этот временной интервал уже проведён'),{status:409});
  if(defectQty>0&&!description)throw Object.assign(new Error('Опишите обнаруженное несоответствие'),{status:400});
  // Older production cycles may not have a card_id saved. Match the same active
  // product card that the QC screen offers as its fallback, so submitted parameter IDs
  // and server-side validation use one identical card.
  let cardId=cycle.rows[0].card_id;
  if(!cardId){
   const fallback=await c.query(`SELECT mc.id
    FROM mic2.measurement_cards mc
    JOIN mic2.products p ON p.id=mc.product_id
    WHERE p.product_code=(SELECT product_code_snapshot FROM mic2.production_cycles WHERE id=$1)
      AND mc.review_status='active'
    ORDER BY mc.version_no DESC LIMIT 1`,[cycleId]);
   cardId=fallback.rows[0]?.id||null;
  }
  const valid=cardId?await c.query('SELECT id FROM mic2.measurement_parameters WHERE card_id=$1 AND installation_no=$2',[cardId,installationNo]):{rows:[]};
  const validIds=valid.rows.map(x=>String(x.id));
  if(measurements.some(m=>!validIds.includes(String(m.parameter_id))||typeof m.measured_value!=='string'||!m.measured_value.trim()))
   throw Object.assign(new Error('В измерениях есть параметры не из выбранной установки карты этого ящика'),{status:400});
  if(measurements.length&&!cardId)throw Object.assign(new Error('Для этого цикла не назначена карта измерений'),{status:400});
  const inspection=await c.query(`
   INSERT INTO mic2.qc_inspections(cycle_id,controller_id,inspection_type,card_id,installation_no,completed_at,comment)
   VALUES($1,$2,'fly_control',$3,$4,now(),$5) RETURNING id
  `,[cycleId,req.employee.id,cardId,installationNo,comment||null]);
  for(const m of measurements)await c.query(`
   INSERT INTO mic2.qc_measurement_results(inspection_id,parameter_id,measured_value,comment)
   VALUES($1,$2,$3,$4)
  `,[inspection.rows[0].id,Number(m.parameter_id),m.measured_value.trim(),m.comment||null]);
  const event=await c.query(`
   INSERT INTO mic2.qc_fly_control_events(inspection_id,sample_quantity,inspection_result,defect_quantity,defect_description,action_required,scheduled_for)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id
  `,[inspection.rows[0].id,sample,result,defectQty,description||null,actionRequired||result==='fail',slot]);
  const scheduled=await c.query(`
   INSERT INTO mic2.qc_fly_control_schedule_events(cycle_id,scheduled_for,window_end,status,completed_inspection_id)
   VALUES($1,$2,LEAST($2::timestamptz+interval '3 hours',$3::timestamptz),'completed',$4)
   ON CONFLICT(cycle_id,scheduled_for) DO UPDATE SET status='completed',completed_inspection_id=EXCLUDED.completed_inspection_id,updated_at=now()
   RETURNING id
  `,[cycleId,slot,cycle.rows[0].shift_ends_at,inspection.rows[0].id]);
  await c.query(`
   INSERT INTO mic2.qc_fly_control_journal(schedule_event_id,actor_id,action,details)
   VALUES($1,$2,'completed',$3::jsonb)
  `,[scheduled.rows[0].id,req.employee.id,JSON.stringify({inspection_id:inspection.rows[0].id,event_id:event.rows[0].id,inspection_result:result,sample_quantity:sample,defect_quantity:defectQty})]);
  await c.query(`
   INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,after_data,reason)
   VALUES($1,$2,'qc_fly_control','qc_inspection',$3,$4::jsonb,$5)
  `,[req.employee.id,req.employee.role_code,inspection.rows[0].id,
   JSON.stringify({cycle_id:cycleId,installation_no:installationNo,sample_quantity:sample,inspection_result:result,defect_quantity:defectQty,action_required:actionRequired||result==='fail'}),comment||description||null]);
  await c.query('COMMIT');
  res.status(201).json({ok:true,inspection_id:inspection.rows[0].id,event_id:event.rows[0].id});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}
 finally{c.release();}
});

app.get('/api/products', authenticate, requirePermission('products:read'), async (req,res,next)=>{
  try { const r=await pool.query("SELECT p.id,p.product_code,p.product_name,p.description,p.box_quantity_norm,p.is_active,COALESCE((SELECT json_agg(json_build_object('id',d.id,'version_no',d.version_no,'original_filename',d.original_filename,'file_uri',d.file_uri,'is_current',d.is_current) ORDER BY d.version_no DESC) FROM mic2.product_drawings d WHERE d.product_id=p.id),'[]') AS drawings FROM mic2.products p WHERE p.is_active OR $1 ORDER BY p.is_active DESC,p.product_name",[req.employee.role_code==='administrator']);res.json({ok:true,products:r.rows}); } catch(e){next(e);}
});


app.get('/api/admin/accounts', authenticate, requirePermission('accounts:create'), async(_req,res,next)=>{
 try{const r=await pool.query(`SELECT e.id,e.employee_no,e.full_name,e.department,e.job_title,e.role_code,ro.title AS role_title,e.login,e.account_status,e.must_change_password,e.created_at,e.terminated_at FROM mic2.employees e JOIN mic2.roles ro ON ro.code=e.role_code ORDER BY e.account_status,e.full_name`);res.json({ok:true,employees:r.rows});}
 catch(e){next(e);}
});
app.post('/api/admin/accounts/:id/status', authenticate, requirePermission('accounts:create'), async(req,res,next)=>{
 const id=Number(req.params.id),status=String(req.body?.account_status||'');
 if(!Number.isSafeInteger(id)||id<1||!['active','blocked'].includes(status))return res.status(400).json({ok:false,message:'Укажите корректный статус учётной записи'});
 if(id===req.employee.id&&status!=='active')return res.status(409).json({ok:false,message:'Нельзя заблокировать собственную учётную запись'});
 try{const r=await pool.query('UPDATE mic2.employees SET account_status=$2 WHERE id=$1 RETURNING id,full_name,account_status',[id,status]);if(!r.rowCount)return res.status(404).json({ok:false,message:'Сотрудник не найден'});await pool.query(`INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,after_data) VALUES($1,$2,'account_status_changed','employee',$3,$4::jsonb)`,[req.employee.id,req.employee.role_code,id,JSON.stringify(r.rows[0])]);res.json({ok:true,employee:r.rows[0]});}
 catch(e){next(e);}
});
app.put('/api/admin/accounts/:id', authenticate, requirePermission('accounts:create'), async(req,res,next)=>{
  const id=Number(req.params.id),b=req.body||{};
  const positions={
    cnc_operator:{department:'production',job_title:'Оператор ЧПУ'},
    qc_controller:{department:'qc',job_title:'Контролёр ОТК'},
    production_manager:{department:'production',job_title:'Начальник производства'},
    qc_manager:{department:'qc',job_title:'Начальник ОТК'},
    technical_director:{department:'management',job_title:'Технический директор'},
    administrator:{department:'administration',job_title:'Администратор'}
  };
  const position=positions[b.role_code];
  if(!Number.isSafeInteger(id)||id<1||!b.full_name?.trim()||!position||!b.login?.trim())
    return res.status(400).json({ok:false,message:'Проверьте ФИО, должность и логин'});
  if(b.password!==undefined&&b.password!==''&&b.password.length<10)
    return res.status(400).json({ok:false,message:'Новый пароль должен содержать не менее 10 символов'});
  try{
    const before=await pool.query('SELECT id,full_name,department,job_title,role_code,login FROM mic2.employees WHERE id=$1',[id]);
    if(!before.rowCount)return res.status(404).json({ok:false,message:'Сотрудник не найден'});
    let q,values;
    if(b.password){
      const hash=await bcrypt.hash(b.password,12);
      q='UPDATE mic2.employees SET full_name=$2,department=$3,job_title=$4,role_code=$5,login=$6,password_hash=$7,must_change_password=TRUE WHERE id=$1 RETURNING id,full_name,department,job_title,role_code,login,account_status';
      values=[id,b.full_name.trim(),position.department,position.job_title,b.role_code,b.login.trim(),hash];
    }else{
      q='UPDATE mic2.employees SET full_name=$2,department=$3,job_title=$4,role_code=$5,login=$6 WHERE id=$1 RETURNING id,full_name,department,job_title,role_code,login,account_status';
      values=[id,b.full_name.trim(),position.department,position.job_title,b.role_code,b.login.trim()];
    }
    const updated=await pool.query(q,values);
    await pool.query(`INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'account_updated','employee',$3,$4::jsonb,$5::jsonb)`,[req.employee.id,req.employee.role_code,id,JSON.stringify(before.rows[0]),JSON.stringify(updated.rows[0])]);
    res.json({ok:true,employee:updated.rows[0]});
  }catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'Такой логин уже используется'});next(e);}
});
app.post('/api/admin/accounts', authenticate, requirePermission('accounts:create'), async (req,res,next)=>{
  try {
    const b=req.body||{};
    const positions={
      cnc_operator:{department:'production',job_title:'Оператор ЧПУ'},
      qc_controller:{department:'qc',job_title:'Контролёр ОТК'},
      production_manager:{department:'production',job_title:'Начальник производства'},
      qc_manager:{department:'qc',job_title:'Начальник ОТК'},
      technical_director:{department:'management',job_title:'Технический директор'},
      administrator:{department:'administration',job_title:'Администратор'}
    };
    const position=positions[b.role_code];
    if(!b.full_name?.trim()||!position||!b.login?.trim()||!b.password||b.password.length<10)
      return res.status(400).json({ok:false,message:'Укажите ФИО, должность, логин и пароль не короче 10 символов'});
    const hash=await bcrypt.hash(b.password,12);
    const r=await pool.query(
      'INSERT INTO mic2.employees(full_name,department,job_title,role_code,login,password_hash,must_change_password) VALUES($1,$2,$3,$4,$5,$6,TRUE) RETURNING id,full_name,department,job_title,role_code,login',
      [b.full_name.trim(),position.department,position.job_title,b.role_code,b.login.trim(),hash]
    );
    res.status(201).json({ok:true,employee:r.rows[0]});
  }catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'Такой логин уже существует'});next(e);}
});

app.put('/api/products/:id', authenticate, requirePermission('products:write'), async(req,res,next)=>{
 const id=Number(req.params.id),b=req.body||{},norm=Number(b.box_quantity_norm);
 if(!Number.isSafeInteger(id)||id<1||!b.product_code?.trim()||!b.product_name?.trim()||!Number.isInteger(norm)||norm<1)return res.status(400).json({ok:false,message:'Заполните код, наименование и норму деталей в коробке'});
 try{
  const before=await pool.query('SELECT id,product_code,product_name,description,box_quantity_norm,is_active FROM mic2.products WHERE id=$1',[id]);
  if(!before.rowCount)return res.status(404).json({ok:false,message:'Изделие не найдено'});
  const updated=await pool.query('UPDATE mic2.products SET product_code=$2,product_name=$3,description=$4,box_quantity_norm=$5 WHERE id=$1 RETURNING id,product_code,product_name,description,box_quantity_norm,is_active',[id,b.product_code.trim(),b.product_name.trim(),b.description?.trim()||null,norm]);
  await pool.query("INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'product_updated','product',$3,$4::jsonb,$5::jsonb)",[req.employee.id,req.employee.role_code,id,JSON.stringify(before.rows[0]),JSON.stringify(updated.rows[0])]);
  res.json({ok:true,product:updated.rows[0]});
 }catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'Такой код изделия уже используется'});next(e);}
});

app.post('/api/products', authenticate, requirePermission('products:write'), async (req,res,next)=>{
 const b=req.body||{},norm=Number(b.box_quantity_norm);
 if(!b.product_code?.trim()||!b.product_name?.trim()||!Number.isInteger(norm)||norm<1)return res.status(400).json({ok:false,message:'Заполните код, наименование и норму деталей в коробке'});
 try{const p=await pool.query('INSERT INTO mic2.products(product_code,product_name,description,box_quantity_norm,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[b.product_code.trim(),b.product_name.trim(),b.description||null,norm,req.employee.id]);res.status(201).json({ok:true,product:p.rows[0]});}
 catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'Такой код изделия уже используется'});next(e);}
});

app.post('/api/cycles', authenticate, requirePermission('cycles:write'), async (req,res)=>{
 const b=req.body||{},binId=Number(b.bin_id),productId=Number(b.product_id),operatorId=Number(b.operator_id);
 if(![binId,productId,operatorId].every(Number.isSafeInteger))return res.status(400).json({ok:false,message:'Выберите контейнер, изделие и оператора'});
 const c=await pool.connect();try{await c.query('BEGIN');
 const bin=await c.query("SELECT id FROM mic2.plastic_bins WHERE id=$1 AND bin_status='free' FOR UPDATE",[binId]);if(!bin.rowCount)throw Object.assign(Error('Контейнер не свободен'),{status:409});
 const p=await c.query('SELECT * FROM mic2.products WHERE id=$1 AND is_active',[productId]);if(!p.rowCount)throw Object.assign(Error('Изделие не найдено'),{status:404});
 const op=await c.query("SELECT id FROM mic2.employees WHERE id=$1 AND role_code='cnc_operator' AND account_status='active' AND terminated_at IS NULL",[operatorId]);if(!op.rowCount)throw Object.assign(Error('Выбранный сотрудник не является активным оператором ЧПУ'),{status:400});
 const n=await c.query('SELECT COALESCE(MAX(cycle_no),0)+1 AS n FROM mic2.production_cycles WHERE bin_id=$1',[binId]);
 const activeCard=await c.query("SELECT id FROM mic2.measurement_cards WHERE product_id=$1 AND review_status='active' ORDER BY version_no DESC LIMIT 1",[productId]);
 const cy=await c.query('INSERT INTO mic2.production_cycles(bin_id,cycle_no,product_id,card_id,started_by,responsible_employee_id,product_code_snapshot,product_name_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[binId,n.rows[0].n,productId,activeCard.rows[0]?.id||null,req.employee.id,operatorId,p.rows[0].product_code,p.rows[0].product_name]);
 await c.query("UPDATE mic2.plastic_bins SET bin_status='occupied' WHERE id=$1",[binId]);await c.query('INSERT INTO mic2.cycle_operator_periods(cycle_id,operator_id,approved_by) VALUES($1,$2,$3)',[cy.rows[0].id,operatorId,req.employee.id]);await c.query('COMMIT');res.status(201).json({ok:true,cycle:cy.rows[0]});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(e.status||500).json({ok:false,message:e.status?e.message:(e.code==='23505'?'У контейнера уже есть активный цикл':'Не удалось открыть цикл')});}finally{c.release();}
});

app.post('/api/cycles/start-own', authenticate, requirePermission('cycles:own:start'), async (req,res)=>{
 const b=req.body||{},binId=Number(b.bin_id),productId=Number(b.product_id),operatorId=Number(req.employee.id);
 if(!Number.isSafeInteger(binId)||!Number.isSafeInteger(productId))return res.status(400).json({ok:false,message:'Укажите номер контейнера и изделие'});
 const c=await pool.connect();try{await c.query('BEGIN');
 const bin=await c.query("SELECT id FROM mic2.plastic_bins WHERE id=$1 AND bin_status='free' FOR UPDATE",[binId]);if(!bin.rowCount)throw Object.assign(Error('Контейнер не найден или уже находится в работе'),{status:409});
 const p=await c.query('SELECT * FROM mic2.products WHERE id=$1 AND is_active',[productId]);if(!p.rowCount)throw Object.assign(Error('Изделие не найдено или неактивно'),{status:404});
 const active=await c.query("SELECT id FROM mic2.production_cycles WHERE bin_id=$1 AND cycle_status='active'",[binId]);if(active.rowCount)throw Object.assign(Error('Этот контейнер уже используется в активном цикле'),{status:409});
 const n=await c.query('SELECT COALESCE(MAX(cycle_no),0)+1 AS n FROM mic2.production_cycles WHERE bin_id=$1',[binId]);
 const card=await c.query("SELECT id FROM mic2.measurement_cards WHERE product_id=$1 AND review_status='active' ORDER BY version_no DESC LIMIT 1",[productId]);
 const cy=await c.query('INSERT INTO mic2.production_cycles(bin_id,cycle_no,product_id,card_id,started_by,responsible_employee_id,product_code_snapshot,product_name_snapshot) VALUES($1,$2,$3,$4,$5,$5,$6,$7) RETURNING *',[binId,n.rows[0].n,productId,card.rows[0]?.id||null,operatorId,p.rows[0].product_code,p.rows[0].product_name]);
 await c.query("UPDATE mic2.plastic_bins SET bin_status='occupied' WHERE id=$1",[binId]);
 await c.query('INSERT INTO mic2.cycle_operator_periods(cycle_id,operator_id,approved_by) VALUES($1,$2,$3)',[cy.rows[0].id,operatorId,operatorId]);
 await c.query('COMMIT');res.status(201).json({ok:true,cycle:cy.rows[0]});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(e.status||500).json({ok:false,message:e.status?e.message:(e.code==='23505'?'У контейнера уже есть активный цикл':'Не удалось взять контейнер в работу')});}finally{c.release();}
});

app.get('/api/bins', authenticate, requirePermission('bins:read'), async (_req,res,next)=>{
  try { const r=await pool.query("SELECT b.id,b.bin_status,c.id AS cycle_id,c.cycle_no,c.cycle_status,c.production_finished_at,c.product_name_snapshot,''::text AS setup_code_snapshot,e.full_name AS responsible_name,COALESCE(q.quantity,0)::int AS physical_quantity FROM mic2.plastic_bins b LEFT JOIN LATERAL(SELECT * FROM mic2.production_cycles pc WHERE pc.bin_id=b.id ORDER BY pc.cycle_no DESC LIMIT 1)c ON TRUE LEFT JOIN mic2.employees e ON e.id=c.responsible_employee_id LEFT JOIN LATERAL(SELECT SUM(quantity)::int AS quantity FROM mic2.v_cycle_quantity_balances WHERE cycle_id=c.id AND bucket NOT IN ('rework_external','isolator_external','packed','scrapped'))q ON TRUE ORDER BY b.id");res.json({ok:true,bins:r.rows}); } catch(e){next(e);}
});

app.get('/api/cycles', authenticate, requirePermission('cycles:read','cycles:own:read'), async (req,res,next)=>{
  try { const operatorFilter=req.employee.role_code==='cnc_operator'; const r=await pool.query("SELECT c.id,c.bin_id,c.cycle_no,c.cycle_status,c.started_at,c.ended_at,c.product_name_snapshot,c.product_code_snapshot,''::text AS setup_code_snapshot,e.full_name AS responsible_name,COALESCE(SUM(CASE WHEN b.bucket NOT IN ('rework_external','isolator_external','packed','scrapped') THEN b.quantity ELSE 0 END),0)::int AS physical_quantity,COALESCE(SUM(CASE WHEN b.bucket='production_pending_qc' THEN b.quantity ELSE 0 END),0)::int AS pending_qc FROM mic2.production_cycles c JOIN mic2.employees e ON e.id=c.responsible_employee_id LEFT JOIN mic2.v_cycle_quantity_balances b ON b.cycle_id=c.id GROUP BY c.id,e.full_name HAVING (NOT $1 OR c.responsible_employee_id=$2) ORDER BY c.started_at DESC LIMIT 300",[operatorFilter,req.employee.id]);res.json({ok:true,cycles:r.rows}); } catch(e){next(e);}
});



app.get('/api/qc/cards', authenticate, requirePermission('qc:cards:read'), async (_req,res,next)=>{
 try{const cards=await pool.query(`SELECT mc.id,mc.product_id,p.product_code,p.product_name,mc.version_no,mc.source_type,mc.source_file_uri,mc.review_status,mc.created_at,mc.checked_at,creator.full_name AS created_by_name,checker.full_name AS checked_by_name,COALESCE(json_agg(json_build_object('id',mp.id,'sort_order',mp.sort_order,'parameter_name',mp.parameter_name,'installation_no',mp.installation_no,'drawing_dimension',COALESCE(mp.drawing_dimension,mp.nominal_value),'dimension_prefix',mp.dimension_prefix,'upper_deviation',mp.upper_deviation,'lower_deviation',mp.lower_deviation,'nominal_value',mp.nominal_value,'tolerance_text',mp.tolerance_text,'unit',mp.unit,'instruction',mp.instruction) ORDER BY mp.sort_order) FILTER(WHERE mp.id IS NOT NULL),'[]') AS parameters FROM mic2.measurement_cards mc JOIN mic2.products p ON p.id=mc.product_id LEFT JOIN mic2.measurement_parameters mp ON mp.card_id=mc.id LEFT JOIN mic2.employees creator ON creator.id=mc.created_by LEFT JOIN mic2.employees checker ON checker.id=mc.checked_by GROUP BY mc.id,p.product_code,p.product_name,creator.full_name,checker.full_name ORDER BY p.product_name,mc.version_no DESC`);res.json({ok:true,cards:cards.rows});}catch(e){next(e);}
});
app.post('/api/qc/cards', authenticate, requirePermission('qc:cards:write'), async(req,res,next)=>{
 const b=req.body||{},productId=Number(b.product_id),parameters=Array.isArray(b.parameters)?b.parameters:[];
 if(!Number.isSafeInteger(productId)||productId<1||!parameters.length||parameters.length>200||parameters.some(p=>!p||typeof p.drawing_dimension!=='string'||!p.drawing_dimension.trim()||!Number.isSafeInteger(Number(p.installation_no))||Number(p.installation_no)<1))return res.status(400).json({ok:false,message:'Выберите изделие и заполните размеры по КД для всех строк'});
 const c=await pool.connect();try{await c.query('BEGIN');const p=await c.query('SELECT id FROM mic2.products WHERE id=$1 AND is_active FOR UPDATE',[productId]);if(!p.rowCount)throw Object.assign(new Error('Активное изделие не найдено'),{status:404});
 const v=await c.query('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM mic2.measurement_cards WHERE product_id=$1',[productId]);
 const card=await c.query("INSERT INTO mic2.measurement_cards(product_id,version_no,source_type,review_status,created_by) VALUES($1,$2,'manual','draft',$3) RETURNING id,product_id,version_no,review_status",[productId,v.rows[0].n,req.employee.id]);
 for(let i=0;i<parameters.length;i++){const x=parameters[i];const dimension=x.drawing_dimension.trim();await c.query('INSERT INTO mic2.measurement_parameters(card_id,sort_order,parameter_name,nominal_value,tolerance_text,unit,instruction,installation_no,drawing_dimension,dimension_prefix,upper_deviation,lower_deviation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[card.rows[0].id,i+1,dimension,null,null,x.unit||null,x.instruction||null,Number(x.installation_no),dimension,['','Ø','М'].includes(x.dimension_prefix)?x.dimension_prefix:'',x.upper_deviation?.trim()||null,x.lower_deviation?.trim()||null]);}
 await c.query('COMMIT');res.status(201).json({ok:true,card:card.rows[0]});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}finally{c.release();}
});

app.post('/api/qc/cards/:id/activate', authenticate, requirePermission('qc:cards:write'), async (req,res,next)=>{
  const cardId=Number(req.params.id);
  if(!Number.isSafeInteger(cardId)||cardId<1)return res.status(400).json({ok:false,message:'Некорректная карта измерений'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const card=await c.query('SELECT id,product_id,review_status FROM mic2.measurement_cards WHERE id=$1 FOR UPDATE',[cardId]);
    if(!card.rowCount)throw Object.assign(new Error('Карта измерений не найдена'),{status:404});
    if(!['draft','checked'].includes(card.rows[0].review_status))throw Object.assign(new Error('Эту карту нельзя активировать'),{status:409});
    const count=await c.query('SELECT COUNT(*)::int AS n FROM mic2.measurement_parameters WHERE card_id=$1',[cardId]);
    if(count.rows[0].n<1)throw Object.assign(new Error('В карте нет параметров измерения'),{status:409});
    await c.query("UPDATE mic2.measurement_cards SET review_status='archived' WHERE product_id=$1 AND review_status='active'",[card.rows[0].product_id]);
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
        e.full_name AS controller_name,c.bin_id,c.product_name_snapshot,''::text AS setup_code_snapshot,
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
        e.full_name AS controller_name,c.bin_id,c.product_name_snapshot,''::text AS setup_code_snapshot,
        mc.version_no AS card_version,
        COALESCE(json_agg(json_build_object(
          'parameter_name',mp.parameter_name,'installation_no',mp.installation_no,'drawing_dimension',COALESCE(mp.drawing_dimension,mp.nominal_value),'dimension_prefix',mp.dimension_prefix,'upper_deviation',mp.upper_deviation,'lower_deviation',mp.lower_deviation,'nominal_value',mp.nominal_value,
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


app.get('/api/qc/defects', authenticate, requirePermission('qc:defects:read'), async (_req,res,next)=>{
 try{
  const r=await pool.query(`SELECT d.id,d.cycle_id,d.confirmed_quantity,d.defect_description,d.defect_status,d.confirmed_at,
   c.bin_id,c.cycle_no,c.product_code_snapshot,c.product_name_snapshot,''::text AS setup_code_snapshot,e.full_name AS controller_name,
   COALESCE(x.decided_quantity,0)::int AS decided_quantity,
   GREATEST(d.confirmed_quantity-COALESCE(x.decided_quantity,0),0)::int AS undecided_quantity,
   COALESCE(x.decisions,'[]'::json) AS decisions
   FROM mic2.defects d JOIN mic2.production_cycles c ON c.id=d.cycle_id
   JOIN mic2.employees e ON e.id=d.confirmed_by
   LEFT JOIN LATERAL(SELECT SUM(dd.decided_quantity)::int AS decided_quantity,
    json_agg(json_build_object('id',dd.id,'decision_type',dd.decision_type,'quantity',dd.decided_quantity,'decided_at',dd.decided_at,'note',dd.note) ORDER BY dd.decided_at,dd.id) AS decisions
    FROM mic2.defect_decisions dd WHERE dd.defect_id=d.id) x ON TRUE
   WHERE d.defect_status IN ('awaiting_decision','active') ORDER BY d.confirmed_at,d.id`);
  res.json({ok:true,defects:r.rows});
 }catch(e){next(e);}
});
app.post('/api/qc/defects/:id/decisions', authenticate, requirePermission('qc:defects:decide'), async (req,res,next)=>{
 const defectId=Number(req.params.id),quantity=Number(req.body?.quantity),decisionType=String(req.body?.decision_type||'');
 const note=typeof req.body?.note==='string'?req.body.note.trim():'';
 const map={with_good_product:{movement:'qc_good',from:'production_pending_qc',to:'good_unboxed',disposition:'packed_with_good'},isolator:{movement:'qc_to_isolator',from:'production_pending_qc',to:'isolator',disposition:'isolator_in'},rework:{movement:'qc_to_rework',from:'production_pending_qc',to:'rework',disposition:'rework_sent'},scrap:{movement:'scrapped',from:'production_pending_qc',to:'scrapped',disposition:'scrapped'}};
 if(!Number.isSafeInteger(defectId)||defectId<1||!Number.isSafeInteger(quantity)||quantity<1||!map[decisionType])return res.status(400).json({ok:false,message:'Укажите корректное решение и количество деталей'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const d=await c.query("SELECT id,cycle_id,confirmed_quantity,defect_status FROM mic2.defects WHERE id=$1 FOR UPDATE",[defectId]);
  if(!d.rowCount||!['awaiting_decision','active'].includes(d.rows[0].defect_status))throw Object.assign(new Error('Дефект уже закрыт или не найден'),{status:404});
  const prior=await c.query('SELECT COALESCE(SUM(decided_quantity),0)::int AS quantity FROM mic2.defect_decisions WHERE defect_id=$1',[defectId]);
  const remaining=d.rows[0].confirmed_quantity-prior.rows[0].quantity;
  if(quantity>remaining)throw Object.assign(new Error(`Для решения осталось ${remaining} деталей`),{status:409});
  const m=map[decisionType];
  const decision=await c.query('INSERT INTO mic2.defect_decisions(defect_id,decision_type,decided_quantity,decision_by,note) VALUES($1,$2,$3,$4,$5) RETURNING id',[defectId,decisionType,quantity,req.employee.id,note||null]);
  await c.query('INSERT INTO mic2.cycle_quantity_movements(cycle_id,movement_type,from_bucket,to_bucket,quantity,defect_id,entered_by,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[d.rows[0].cycle_id,m.movement,m.from,m.to,quantity,defectId,req.employee.id,note||m.disposition]);
  await c.query('INSERT INTO mic2.defect_dispositions(defect_id,decision_id,disposition_type,quantity,performed_by,confirmed_by,note) VALUES($1,$2,$3,$4,$5,$5,$6)',[defectId,decision.rows[0].id,m.disposition,quantity,req.employee.id,note||null]);
  if(decisionType==='isolator')await c.query("INSERT INTO mic2.isolator_movements(defect_id,movement_type,quantity,confirmed_by,note) VALUES($1,'in',$2,$3,$4)",[defectId,quantity,req.employee.id,note||null]);
  if(decisionType==='rework')await c.query('INSERT INTO mic2.rework_records(defect_id,quantity_sent,note) VALUES($1,$2,$3)',[defectId,quantity,note||null]);
  const total=prior.rows[0].quantity+quantity,newStatus=total>=d.rows[0].confirmed_quantity?'resolved':'active';
  await c.query("UPDATE mic2.defects SET defect_status=$2,closed_at=CASE WHEN $2='resolved' THEN now() ELSE NULL END WHERE id=$1",[defectId,newStatus]);
  await c.query(`INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,before_data,after_data,reason)
   VALUES($1,$2,'qc_defect_decision','defect',$3,$4::jsonb,$5::jsonb,$6)`,
   [req.employee.id,req.employee.role_code,defectId,JSON.stringify({status:d.rows[0].defect_status,undecided_quantity:remaining}),JSON.stringify({status:newStatus,decision_type:decisionType,quantity,remaining_quantity:remaining-quantity}),note||null]);
  await c.query('COMMIT');res.status(201).json({ok:true,decision_id:decision.rows[0].id,remaining_quantity:remaining-quantity,defect_status:newStatus});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}
 finally{c.release();}
});

app.get('/api/qc/isolator', authenticate, requirePermission('qc:defects:read'), async (_req,res,next)=>{
 try{
  const r=await pool.query(`SELECT d.id AS defect_id,d.id,d.cycle_id,d.confirmed_quantity AS received_quantity,d.defect_description,d.confirmed_at,
   c.bin_id,c.cycle_no,c.product_code_snapshot,c.product_name_snapshot,e.full_name AS controller_name,
   x.quantity,x.movements
   FROM mic2.defects d
   JOIN mic2.production_cycles c ON c.id=d.cycle_id
   JOIN mic2.employees e ON e.id=d.confirmed_by
   JOIN LATERAL(
    SELECT GREATEST(COALESCE(SUM(CASE WHEN im.movement_type='in' THEN im.quantity WHEN im.movement_type IN ('out','return_to_production') THEN -im.quantity ELSE 0 END),0),0)::int AS quantity,
     COALESCE(json_agg(json_build_object('movement_type',im.movement_type,'quantity',im.quantity,'note',im.note,'occurred_at',im.occurred_at,'confirmed_by',emp.full_name) ORDER BY im.id),'[]'::json) AS movements
    FROM mic2.isolator_movements im
    LEFT JOIN mic2.employees emp ON emp.id=im.confirmed_by
    WHERE im.defect_id=d.id
   ) x ON TRUE
   WHERE x.quantity>0
   ORDER BY d.confirmed_at,d.id`);
  res.json({ok:true,items:r.rows});
 }catch(e){next(e);}
});
app.post('/api/qc/isolator/:id/movements', authenticate, requirePermission('qc:defects:decide'), async (req,res,next)=>{
 const defectId=Number(req.params.id),quantity=Number(req.body?.quantity),actionType=String(req.body?.action_type||''),note=typeof req.body?.note==='string'?req.body.note.trim():'';
 const map={good:{to:'good_unboxed',movement:'qc_good',isolatorMovement:'out',disposition:'isolator_out'},rework:{to:'rework',movement:'isolator_returned',isolatorMovement:'return_to_production',disposition:'rework_returned'},scrap:{to:'scrapped',movement:'scrapped',isolatorMovement:'out',disposition:'scrapped'}};
 if(!Number.isSafeInteger(defectId)||defectId<1||!Number.isSafeInteger(quantity)||quantity<1||!map[actionType])return res.status(400).json({ok:false,message:'Укажите корректное решение и количество'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const d=await c.query('SELECT id,cycle_id,confirmed_quantity FROM mic2.defects WHERE id=$1 FOR UPDATE',[defectId]);
  if(!d.rowCount)throw Object.assign(new Error('Запись дефекта не найдена'),{status:404});
  const stock=await c.query("SELECT COALESCE(SUM(CASE WHEN movement_type='in' THEN quantity WHEN movement_type IN ('out','return_to_production') THEN -quantity ELSE 0 END),0)::int AS quantity FROM mic2.isolator_movements WHERE defect_id=$1",[defectId]);
  const remaining=stock.rows[0].quantity;
  if(quantity>remaining)throw Object.assign(new Error('В изоляторе осталось '+remaining+' деталей'),{status:409});
  const m=map[actionType];
  await c.query("INSERT INTO mic2.isolator_movements(defect_id,movement_type,quantity,confirmed_by,note) VALUES($1,$2,$3,$4,$5)",[defectId,m.isolatorMovement,quantity,req.employee.id,note||actionType]);
  await c.query('INSERT INTO mic2.cycle_quantity_movements(cycle_id,movement_type,from_bucket,to_bucket,quantity,defect_id,entered_by,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[d.rows[0].cycle_id,m.movement,'isolator',m.to,quantity,defectId,req.employee.id,note||actionType]);
  await c.query('INSERT INTO mic2.defect_dispositions(defect_id,decision_id,disposition_type,quantity,performed_by,confirmed_by,note) VALUES($1,NULL,$2,$3,$4,$4,$5)',[defectId,m.disposition,quantity,req.employee.id,note||null]);
  await c.query(`INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,before_data,after_data,reason)
   VALUES($1,$2,'isolator_disposition','defect',$3,$4::jsonb,$5::jsonb,$6)`,
   [req.employee.id,req.employee.role_code,defectId,JSON.stringify({isolator_quantity:remaining}),JSON.stringify({action_type:actionType,quantity,remaining_quantity:remaining-quantity}),note||null]);
  await c.query('COMMIT');
  res.status(201).json({ok:true,remaining_quantity:remaining-quantity});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}
 finally{c.release();}
});
app.get('/api/qc/pending', authenticate, requirePermission('qc:queue:read'), async (_req,res,next)=>{
  try {
    const r=await pool.query(`
      SELECT c.id AS cycle_id,c.bin_id,c.cycle_no,c.product_name_snapshot,c.product_code_snapshot,
        ''::text AS setup_code_snapshot,e.full_name AS responsible_name,
        c.card_id AS card_id,
        (COALESCE((SELECT first_piece_required FROM mic2.qc_control_schedules WHERE product_id=c.product_id),TRUE) AND NOT EXISTS(SELECT 1 FROM mic2.qc_inspections qi WHERE qi.cycle_id=c.id AND qi.inspection_type='first_piece')) AS first_piece_pending,
        COALESCE(card_params.parameters,'[]'::json) AS measurement_parameters,
        COALESCE(q.quantity,0)::int AS pending_quantity,
        COALESCE(d.quantity,0)::int AS reserved_defect_quantity,
        GREATEST(COALESCE(q.quantity,0)-COALESCE(d.quantity,0),0)::int AS available_quantity
      FROM mic2.production_cycles c
      JOIN mic2.employees e ON e.id=c.responsible_employee_id
      LEFT JOIN mic2.v_cycle_quantity_balances q ON q.cycle_id=c.id AND q.bucket='production_pending_qc'
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id',mp.id,'parameter_name',mp.parameter_name,'installation_no',mp.installation_no,'drawing_dimension',COALESCE(mp.drawing_dimension,mp.nominal_value),'dimension_prefix',mp.dimension_prefix,'upper_deviation',mp.upper_deviation,'lower_deviation',mp.lower_deviation,
          'nominal_value',mp.nominal_value,'tolerance_text',mp.tolerance_text,'unit',mp.unit,
          'instruction',mp.instruction) ORDER BY mp.sort_order) AS parameters
        FROM mic2.measurement_parameters mp
        WHERE mp.card_id=c.card_id
      ) card_params ON TRUE
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
    const cycle=await c.query("SELECT id,card_id FROM mic2.production_cycles WHERE id=$1 AND cycle_status='active' FOR UPDATE",[cycleId]);
    if(!cycle.rowCount)throw Object.assign(new Error('Активный производственный цикл не найден'),{status:404});
    const measurementRows=Array.isArray(b.measurements)?b.measurements:[];
    let validParameters=[];
    if(measurementRows.length){
      if(!cycle.rows[0].card_id)throw Object.assign(new Error('Для этого цикла не назначена карта измерений'),{status:400});
      const cardParams=await c.query('SELECT id FROM mic2.measurement_parameters WHERE card_id=$1',[cycle.rows[0].card_id]);
      validParameters=cardParams.rows.map(x=>String(x.id));
      if(new Set(measurementRows.map(x=>String(x.parameter_id))).size!==measurementRows.length||measurementRows.some(x=>!validParameters.includes(String(x.parameter_id))||typeof x.measured_value!=='string'||!x.measured_value.trim())){
        throw Object.assign(new Error('Проверьте выбранные размеры: заполните фактические значения'),{status:400});
      }
    }
    const balances=await c.query(`
      SELECT
        COALESCE((SELECT quantity FROM mic2.v_cycle_quantity_balances WHERE cycle_id=$1 AND bucket='production_pending_qc'),0)::int AS pending,
        COALESCE((SELECT SUM(confirmed_quantity) FROM mic2.defects WHERE cycle_id=$1 AND defect_status IN ('awaiting_decision','active')),0)::int AS reserved
    `,[cycleId]);
    const available=Math.max(0,balances.rows[0].pending-balances.rows[0].reserved);
    if(good+defective>available)throw Object.assign(new Error(`Для контроля доступно только ${available} деталей`),{status:409});
    const inspection=await c.query(`
      INSERT INTO mic2.qc_inspections(cycle_id,controller_id,inspection_type,card_id,completed_at,comment)
      VALUES($1,$2,'scheduled_round',$3,now(),$4) RETURNING id
    `,[cycleId,req.employee.id,cycle.rows[0].card_id,comment||null]);
    for(const m of measurementRows){
      await c.query(`
        INSERT INTO mic2.qc_measurement_results(inspection_id,parameter_id,measured_value,comment)
        VALUES($1,$2,$3,$4)
      `,[inspection.rows[0].id,Number(m.parameter_id),m.measured_value.trim(),m.comment||null]);
    }
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

app.get('/api/qc/finished-boxes', authenticate, requirePermission('qc:queue:read','qc:all:read'), async (_req,res,next)=>{
 try{
  const r=await pool.query(`
   SELECT fb.id AS carton_no,fb.product_code_snapshot,fb.product_name_snapshot,fb.quantity,fb.box_norm_snapshot,
    fb.created_at,fb.closed_at,c.id AS cycle_id,c.bin_id AS source_bin_id,
    i.id AS inspection_id,e.full_name AS created_by_name
   FROM mic2.finished_boxes fb
   LEFT JOIN mic2.production_cycles c ON c.id=fb.cycle_id
   LEFT JOIN mic2.qc_inspections i ON i.id=fb.inspection_id
   JOIN mic2.employees e ON e.id=fb.created_by
   ORDER BY fb.id DESC LIMIT 500
  `);
  const pending=await pool.query(`
   SELECT c.id AS cycle_id,c.bin_id,c.product_name_snapshot,c.product_code_snapshot,
    c.production_finished_at,COALESCE(q.quantity,0)::int AS packable_quantity,p.box_quantity_norm,
    e.full_name AS responsible_name
   FROM mic2.production_cycles c JOIN mic2.products p ON p.id=c.product_id
   JOIN mic2.employees e ON e.id=c.responsible_employee_id
   JOIN mic2.v_cycle_quantity_balances q ON q.cycle_id=c.id AND q.bucket='good_unboxed' AND q.quantity>0
   WHERE c.cycle_status='active'
    AND EXISTS(SELECT 1 FROM mic2.qc_inspections qi WHERE qi.cycle_id=c.id AND qi.inspection_type='scheduled_round' AND qi.completed_at IS NOT NULL)
   ORDER BY c.started_at
  `);
  res.json({ok:true,boxes:r.rows,packable_cycles:pending.rows});
 }catch(e){next(e);}
});

app.get('/api/qc/finished-boxes/:boxId', authenticate, requirePermission('qc:queue:read','qc:all:read'), async(req,res,next)=>{
 const boxId=Number(req.params.boxId);
 if(!Number.isSafeInteger(boxId)||boxId<1)return res.status(400).json({ok:false,message:'Некорректный номер коробки'});
 try{
  const box=await pool.query(`
   SELECT fb.id AS carton_no,fb.product_code_snapshot,fb.product_name_snapshot,fb.quantity,fb.box_norm_snapshot,
    fb.created_at,fb.closed_at,fb.cycle_id,fb.source_bin_id,fb.inspection_id,
    creator.full_name AS created_by_name,closer.full_name AS closed_by_name,
    c.cycle_no,c.started_at AS cycle_started_at,c.production_finished_at,c.responsible_employee_id,
    operator.full_name AS operator_name,i.completed_at AS inspection_completed_at,i.inspection_type,
    controller.full_name AS inspection_controller
   FROM mic2.finished_boxes fb
   LEFT JOIN mic2.employees creator ON creator.id=fb.created_by
   LEFT JOIN mic2.employees closer ON closer.id=fb.closed_by
   LEFT JOIN mic2.production_cycles c ON c.id=fb.cycle_id
   LEFT JOIN mic2.employees operator ON operator.id=c.responsible_employee_id
   LEFT JOIN mic2.qc_inspections i ON i.id=fb.inspection_id
   LEFT JOIN mic2.employees controller ON controller.id=i.controller_id
   WHERE fb.id=$1
  `,[boxId]);
  if(!box.rowCount)return res.status(404).json({ok:false,message:'Коробка не найдена'});
  const additions=await pool.query(`
   SELECT a.id,a.quantity,a.added_at,a.note,e.full_name AS employee_name
   FROM mic2.finished_box_additions a JOIN mic2.employees e ON e.id=a.added_by
   WHERE a.box_id=$1 ORDER BY a.added_at,a.id
  `,[boxId]);
  const audit=await pool.query(`
   SELECT a.action,a.occurred_at,a.reason,a.before_data,a.after_data,e.full_name AS employee_name
   FROM mic2.audit_log a LEFT JOIN mic2.employees e ON e.id=a.actor_id
   WHERE a.entity_type='finished_box' AND a.entity_id=$1
    AND a.action IN ('qc_finished_carton_closed','qc_finished_carton_refilled')
   ORDER BY a.occurred_at,a.id
  `,[boxId]);
  res.json({ok:true,box:box.rows[0],additions:additions.rows,history:audit.rows});
 }catch(e){next(e);}
});

app.post('/api/qc/finished-boxes/pack/:cycleId', authenticate, requirePermission('qc:inspect:write'), async(req,res,next)=>{
 const cycleId=Number(req.params.cycleId);
 if(!Number.isSafeInteger(cycleId)||cycleId<1)return res.status(400).json({ok:false,message:'Некорректный производственный цикл'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const cycle=await c.query(`
   SELECT c.id,c.bin_id,c.product_id,c.product_code_snapshot,c.product_name_snapshot,c.production_finished_at,
    p.box_quantity_norm
   FROM mic2.production_cycles c JOIN mic2.products p ON p.id=c.product_id
   WHERE c.id=$1 AND c.cycle_status='active' FOR UPDATE OF c
  `,[cycleId]);
  if(!cycle.rowCount)throw Object.assign(new Error('Активный производственный цикл не найден'),{status:404});
  const latest=await c.query(`
   SELECT id FROM mic2.qc_inspections
   WHERE cycle_id=$1 AND inspection_type='scheduled_round' AND completed_at IS NOT NULL
   ORDER BY completed_at DESC,id DESC LIMIT 1
  `,[cycleId]);
  if(!latest.rowCount)throw Object.assign(new Error('Сначала должна быть проведена проверка ОТК'),{status:409});
  const balance=await c.query(`
   SELECT COALESCE(quantity,0)::int AS quantity
   FROM mic2.v_cycle_quantity_balances WHERE cycle_id=$1 AND bucket='good_unboxed'
  `,[cycleId]);
  const available=balance.rows[0]?.quantity||0;
  if(available<1)throw Object.assign(new Error('Нет принятой годной продукции для упаковки'),{status:409});
  const norm=cycle.rows[0].box_quantity_norm;
  let remaining=available;
  const cartons=[];
  while(remaining>0){
   const quantity=Math.min(norm,remaining);
   const carton=await c.query(`
    INSERT INTO mic2.finished_boxes(product_id,product_code_snapshot,product_name_snapshot,box_norm_snapshot,quantity,created_by,cycle_id,source_bin_id,inspection_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,quantity,box_norm_snapshot
   `,[cycle.rows[0].product_id,cycle.rows[0].product_code_snapshot,cycle.rows[0].product_name_snapshot,norm,quantity,req.employee.id,cycleId,cycle.rows[0].bin_id,latest.rows[0].id]);
   await c.query(`
    INSERT INTO mic2.cycle_quantity_movements(cycle_id,movement_type,from_bucket,to_bucket,quantity,entered_by,note)
    VALUES($1,'packed','good_unboxed','packed',$2,$3,$4)
   `,[cycleId,quantity,req.employee.id,'Упаковано в коробку ОТК №'+carton.rows[0].id]);
   cartons.push(carton.rows[0]);
   remaining-=quantity;
  }
  const residue=await c.query(`
   SELECT COALESCE(SUM(quantity),0)::int AS quantity
   FROM mic2.v_cycle_quantity_balances
   WHERE cycle_id=$1 AND bucket NOT IN ('packed','scrapped','rework_external','isolator_external')
  `,[cycleId]);
  let sourceBinReleased=false;
  if(cycle.rows[0].production_finished_at&&residue.rows[0].quantity===0){
   await c.query("UPDATE mic2.production_cycles SET cycle_status='completed',ended_at=COALESCE(ended_at,now()) WHERE id=$1 AND cycle_status='active'",[cycleId]);
   await c.query("UPDATE mic2.plastic_bins SET bin_status='free' WHERE id=$1 AND bin_status='occupied'",[cycle.rows[0].bin_id]);
   sourceBinReleased=true;
  }
  await c.query(`INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,before_data,after_data,reason)
   VALUES($1,$2,'qc_finished_cartons_created','production_cycle',$3,$4::jsonb,$5::jsonb,$6)`,
   [req.employee.id,req.employee.role_code,cycleId,JSON.stringify({good_unboxed:available}),JSON.stringify({cartons:cartons.map(x=>({id:x.id,quantity:x.quantity})),packed_quantity:available,source_bin_released:sourceBinReleased}),null]);
  await c.query('COMMIT');
  res.status(201).json({ok:true,cartons,packed_quantity:available,source_bin_released:sourceBinReleased});
 }catch(e){
  await c.query('ROLLBACK').catch(()=>{});
  if(e.status)return res.status(e.status).json({ok:false,message:e.message});
  next(e);
 }finally{c.release();}
});


app.post('/api/qc/finished-boxes/:boxId/close', authenticate, requirePermission('qc:inspect:write'), async(req,res,next)=>{
 const boxId=Number(req.params.boxId); if(!Number.isSafeInteger(boxId)||boxId<1)return res.status(400).json({ok:false,message:'Некорректный номер коробки'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const box=await c.query('SELECT id,quantity,box_norm_snapshot,closed_at FROM mic2.finished_boxes WHERE id=$1 FOR UPDATE',[boxId]);
  if(!box.rowCount)throw Object.assign(new Error('Коробка не найдена'),{status:404});
  if(box.rows[0].closed_at)throw Object.assign(new Error('Коробка уже закрыта'),{status:409});
  if(Number(box.rows[0].quantity)<1)throw Object.assign(new Error('Нельзя закрыть пустую коробку'),{status:409});
  await c.query('UPDATE mic2.finished_boxes SET closed_at=now(),closed_by=$2 WHERE id=$1',[boxId,req.employee.id]);
  await c.query(`INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,before_data,after_data,reason)
   VALUES($1,$2,'qc_finished_carton_closed','finished_box',$3,$4::jsonb,$5::jsonb,$6)`,
   [req.employee.id,req.employee.role_code,boxId,JSON.stringify({closed_at:null}),JSON.stringify({quantity:box.rows[0].quantity,closed:true}),req.body?.reason||'Коробка закрыта контролёром ОТК']);
  await c.query('COMMIT'); res.json({ok:true,box_id:boxId,closed:true});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}finally{c.release();}
});

app.post('/api/qc/finished-boxes/:boxId/refill', authenticate, requirePermission('qc:inspect:write'), async(req,res,next)=>{
 const boxId=Number(req.params.boxId); if(!Number.isSafeInteger(boxId)||boxId<1)return res.status(400).json({ok:false,message:'Некорректный номер коробки'});
 const requested=Number(req.body?.quantity);
 if(!Number.isSafeInteger(requested)||requested<1)return res.status(400).json({ok:false,message:'Укажите количество для дозаполнения'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const box=await c.query('SELECT id,cycle_id,quantity,box_norm_snapshot,closed_at FROM mic2.finished_boxes WHERE id=$1 FOR UPDATE',[boxId]);
  if(!box.rowCount)throw Object.assign(new Error('Коробка не найдена'),{status:404});
  const b=box.rows[0];
  if(b.closed_at)throw Object.assign(new Error('Закрытую коробку нельзя дозаполнять'),{status:409});
  if(Number(b.quantity)>=Number(b.box_norm_snapshot))throw Object.assign(new Error('Коробка уже полностью сформирована. Дозаполнение доступно только для неполных коробок.'),{status:409});
  if(!b.cycle_id)throw Object.assign(new Error('Для коробки не указан исходный производственный цикл'),{status:409});
  const free=Math.max(0,Number(b.box_norm_snapshot)-Number(b.quantity));
  if(requested>free)throw Object.assign(new Error('Количество превышает свободное место в коробке: '+free+' шт.'),{status:409});
  const cycle=await c.query("SELECT id,bin_id,production_finished_at FROM mic2.production_cycles WHERE id=$1 AND cycle_status='active' FOR UPDATE",[b.cycle_id]);
  if(!cycle.rowCount)throw Object.assign(new Error('Исходный производственный цикл уже закрыт'),{status:409});
  const balance=await c.query("SELECT COALESCE(quantity,0)::int AS quantity FROM mic2.v_cycle_quantity_balances WHERE cycle_id=$1 AND bucket='good_unboxed'",[b.cycle_id]);
  const available=Number(balance.rows[0]?.quantity||0);
  if(requested>available)throw Object.assign(new Error('Доступно только '+available+' годных деталей для дозаполнения'),{status:409});
  const inspection=await c.query("SELECT id FROM mic2.qc_inspections WHERE cycle_id=$1 AND inspection_type='scheduled_round' AND completed_at IS NOT NULL ORDER BY completed_at DESC,id DESC LIMIT 1",[b.cycle_id]);
  if(!inspection.rowCount)throw Object.assign(new Error('Нет завершённой проверки ОТК'),{status:409});
  await c.query(`INSERT INTO mic2.finished_box_additions(box_id,quantity,added_by,note)
    VALUES($1,$2,$3,$4)`,[boxId,requested,req.employee.id,'Дозаполнение коробки ОТК; проверка '+inspection.rows[0].id]);
  await c.query(`INSERT INTO mic2.cycle_quantity_movements(cycle_id,movement_type,from_bucket,to_bucket,quantity,entered_by,note)
    VALUES($1,'packed','good_unboxed','packed',$2,$3,$4)`,[b.cycle_id,requested,req.employee.id,'Дозаполнение коробки ОТК №'+boxId]);
  const residue=await c.query(`SELECT COALESCE(SUM(quantity),0)::int AS quantity FROM mic2.v_cycle_quantity_balances
   WHERE cycle_id=$1 AND bucket NOT IN ('packed','scrapped','rework_external','isolator_external')`,[b.cycle_id]);
  let sourceBinReleased=false;
  if(cycle.rows[0].production_finished_at&&Number(residue.rows[0].quantity)===0){
   await c.query("UPDATE mic2.production_cycles SET cycle_status='completed',ended_at=COALESCE(ended_at,now()) WHERE id=$1 AND cycle_status='active'",[b.cycle_id]);
   await c.query("UPDATE mic2.plastic_bins SET bin_status='free' WHERE id=$1 AND bin_status='occupied'",[cycle.rows[0].bin_id]);
   sourceBinReleased=true;
  }
  await c.query(`INSERT INTO mic2.audit_log(actor_id,actor_role_code,action,entity_type,entity_id,before_data,after_data,reason)
   VALUES($1,$2,'qc_finished_carton_refilled','finished_box',$3,$4::jsonb,$5::jsonb,$6)`,
   [req.employee.id,req.employee.role_code,boxId,JSON.stringify({quantity:b.quantity}),JSON.stringify({quantity:Number(b.quantity)+requested,added:requested,source_bin_released:sourceBinReleased}),req.body?.reason||'Дозаполнение коробки']);
  await c.query('COMMIT'); res.json({ok:true,box_id:boxId,added_quantity:requested,new_quantity:Number(b.quantity)+requested,remaining_capacity:free-requested,source_bin_released:sourceBinReleased});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}finally{c.release();}
});

app.post('/api/bins', authenticate, requirePermission('bins:write'), async (req,res,next)=>{try{const r=await pool.query('INSERT INTO mic2.plastic_bins(created_by) VALUES($1) RETURNING id,bin_status,created_at',[req.employee.id]);res.status(201).json({ok:true,bin:r.rows[0]});}catch(e){next(e);}});

app.post('/api/cycles/:id/output', authenticate, requirePermission('output:own:write','output:manage'), async (req,res,next)=>{
  const quantity=Number(req.body?.quantity),finish=req.body?.finish===true; if(!Number.isSafeInteger(quantity)||quantity<0||(!finish&&quantity<1))return res.status(400).json({ok:false,message:'Укажите количество больше нуля или завершите изготовление без дополнительного выпуска'});
  const c=await pool.connect(); try { await c.query('BEGIN'); const cycle=await c.query("SELECT id,responsible_employee_id,production_finished_at FROM mic2.production_cycles WHERE id=$1 AND cycle_status='active' FOR UPDATE",[req.params.id]); if(!cycle.rowCount)throw Object.assign(new Error('Активный цикл не найден'),{status:404});
    if(String(cycle.rows[0].responsible_employee_id)!==req.employee.id && req.employee.role_code!=='production_manager')throw Object.assign(new Error('Вы не являетесь ответственным оператором'),{status:403});
    if(cycle.rows[0].production_finished_at && req.employee.role_code!=='production_manager')throw Object.assign(new Error('Изготовление по этому ящику уже завершено'),{status:409});
    let entry={rows:[]}; if(quantity>0){entry=await c.query('INSERT INTO mic2.production_output_entries(cycle_id,operator_id,quantity,entered_by) VALUES($1,$2,$3,$4) RETURNING *',[req.params.id,cycle.rows[0].responsible_employee_id,quantity,req.employee.id]); await c.query("INSERT INTO mic2.cycle_quantity_movements(cycle_id,movement_type,to_bucket,quantity,entered_by,note) VALUES($1,'production_received','production_pending_qc',$2,$3,$4)",[req.params.id,quantity,req.employee.id,req.body?.note||null]);}
    if(finish&&!cycle.rows[0].production_finished_at)await c.query('UPDATE mic2.production_cycles SET production_finished_at=NOW() WHERE id=$1',[req.params.id]);
    await c.query('COMMIT');res.status(201).json({ok:true,entry:entry.rows[0],production_finished:finish});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.status)return res.status(e.status).json({ok:false,message:e.message});next(e);}finally{c.release();}
});

app.use((error, _req, res, _next) => {
  console.error('MIC API error:', error.message);
  res.status(500).json({ ok: false, message: 'Внутренняя ошибка сервера' });
});

async function ensureFinishedCartonSchema() {
  await pool.query(`
    ALTER TABLE mic2.finished_boxes
      ADD COLUMN IF NOT EXISTS cycle_id bigint REFERENCES mic2.production_cycles(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS source_bin_id bigint REFERENCES mic2.plastic_bins(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS inspection_id bigint REFERENCES mic2.qc_inspections(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS finished_boxes_cycle_idx ON mic2.finished_boxes(cycle_id);
    CREATE INDEX IF NOT EXISTS finished_boxes_source_bin_idx ON mic2.finished_boxes(source_bin_id);
  `);
}

let server;
ensureFinishedCartonSchema().then(() => {
  server = app.listen(port, () => console.log(`MIC API listening on port ${port}`));
}).catch((error) => {
  console.error('MIC database initialization failed:', error.message);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down MIC API`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
