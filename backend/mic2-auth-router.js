'use strict';

const express = require('express');
const crypto = require('crypto');

const {
  authenticate,
  issueToken,
  verifyPassword,
  hashPassword,
  createActivationCode,
  hashActivationCode,
  verifyActivationCode,
  activationExpiry,
} = require('./auth');

const ADMIN_ROLE = 'administrator';

const DEPARTMENTS = new Set([
  'production',
  'qc',
  'management',
  'administration',
]);

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
}

function createMic2AuthRouter({ pool }) {
  if (!pool) throw new Error('PostgreSQL pool required');

  const router = express.Router();

  // Первоначальное создание администратора.
  router.post('/bootstrap-admin', async (req, res) => {
    const client = await pool.connect();

    try {
      const secret = process.env.MIC2_BOOTSTRAP_SECRET;

      if (!secret || Buffer.byteLength(secret) < 32) {
        return res.status(503).json({
          ok: false,
          message: 'Настройка первого администратора отключена',
        });
      }

      if (!safeEqual(req.get('x-mic-bootstrap-secret'), secret)) {
        return res.status(401).json({
          ok: false,
          message: 'Неверный секрет настройки',
        });
      }

      const { full_name, login, job_title } = req.body || {};

      if (!full_name || !login || !job_title) {
        return res.status(400).json({
          ok: false,
          message: 'Укажите ФИО, логин и должность',
        });
      }

      await client.query('BEGIN');

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('mic2-bootstrap-admin'))"
      );

      const count = await client.query(
        'SELECT COUNT(*)::int AS count FROM mic2.employees'
      );

      if (count.rows[0].count !== 0) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          ok: false,
          message: 'Первоначальная настройка уже выполнена',
        });
      }

      const code = createActivationCode();

      const result = await client.query(
        `INSERT INTO mic2.employees
          (full_name, department, job_title, role_code,
           login, password_hash, must_change_password,
           account_status, activation_code_hash,
           activation_expires_at)
         VALUES ($1, 'administration', $2, $3, $4,
                 NULL, TRUE, 'active', $5, $6)
         RETURNING id, full_name, login, role_code`,
        [
          String(full_name).trim(),
          String(job_title).trim(),
          ADMIN_ROLE,
          String(login).trim(),
          await hashActivationCode(code),
          activationExpiry(),
        ]
      );

      await client.query('COMMIT');

      res.status(201).json({
        ok: true,
        employee: result.rows[0],
        activation_code: code,
        activation_expires_in_minutes: 15,
      });

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}

      console.error('MIC2 BOOTSTRAP ERROR:', error);

      res.status(500).json({
        ok: false,
        message: 'Не удалось создать администратора',
      });

    } finally {
      client.release();
    }
  });

  // Активация учётной записи.
  router.post('/activate', async (req, res) => {
    const client = await pool.connect();

    try {
      const {
        login,
        activation_code,
        password,
        password_confirm,
      } = req.body || {};

      if (
        !login ||
        !activation_code ||
        !password ||
        password !== password_confirm
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Проверьте логин, код и пароли',
        });
      }

      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, activation_code_hash,
                activation_expires_at, account_status
         FROM mic2.employees
         WHERE login = $1
         FOR UPDATE`,
        [String(login).trim()]
      );

      const employee = result.rows[0];

      if (
        !employee ||
        employee.account_status !== 'active' ||
        !employee.activation_code_hash ||
        !employee.activation_expires_at ||
        new Date(employee.activation_expires_at) < new Date() ||
        !(await verifyActivationCode(
          String(activation_code),
          employee.activation_code_hash
        ))
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          message: 'Код недействителен или истёк',
        });
      }

      const passwordHash = await hashPassword(password);

      await client.query(
        `UPDATE mic2.employees
         SET password_hash = $1,
             must_change_password = FALSE,
             activation_code_hash = NULL,
             activation_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, employee.id]
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        message: 'Учётная запись активирована',
      });

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}

      res.status(error.status || 500).json({
        ok: false,
        message: error.status ? error.message : 'Ошибка активации',
      });

    } finally {
      client.release();
    }
  });

  // Вход сотрудника MIC 2.0.
  router.post('/login', async (req, res) => {
    try {
      const { login, password } = req.body || {};

      if (!login || !password) {
        return res.status(400).json({
          ok: false,
          message: 'Введите логин и пароль',
        });
      }

      const result = await pool.query(
        `SELECT id, login, full_name, role_code,
                password_hash, must_change_password,
                account_status
         FROM mic2.employees
         WHERE login = $1`,
        [String(login).trim()]
      );

      const employee = result.rows[0];

      if (
        !employee ||
        employee.account_status !== 'active' ||
        !(await verifyPassword(password, employee.password_hash))
      ) {
        return res.status(401).json({
          ok: false,
          message: 'Неверный логин или пароль',
        });
      }

      const token = issueToken({
        id: employee.id,
        kind: 'mic2_employee',
        role: employee.role_code,
      });

      res.json({
        ok: true,
        token,
        user: {
          id: employee.id,
          login: employee.login,
          full_name: employee.full_name,
          role: employee.role_code,
          must_change_password: employee.must_change_password,
        },
      });

    } catch (error) {
      console.error('MIC2 LOGIN ERROR:', error);

      res.status(500).json({
        ok: false,
        message: 'Ошибка сервера',
      });
    }
  });

  // Создание сотрудника администратором.
  router.post('/employees', authenticate, async (req, res) => {
    const client = await pool.connect();

    try {
      if (req.auth.kind !== 'mic2_employee') {
        return res.status(403).json({
          ok: false,
          message: 'Недостаточно прав',
        });
      }

      const actor = await client.query(
        `SELECT role_code, account_status
         FROM mic2.employees WHERE id = $1`,
        [req.auth.sub]
      );

      if (
        !actor.rows[0] ||
        actor.rows[0].account_status !== 'active' ||
        actor.rows[0].role_code !== ADMIN_ROLE ||
        req.auth.role !== ADMIN_ROLE
      ) {
        return res.status(403).json({
          ok: false,
          message: 'Только администратор может создавать сотрудников',
        });
      }

      const {
        full_name,
        login,
        department,
        job_title,
        role_code,
        employee_no,
        hired_at,
      } = req.body || {};

      if (
        !full_name ||
        !login ||
        !department ||
        !job_title ||
        !role_code ||
        !DEPARTMENTS.has(department)
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Проверьте данные сотрудника',
        });
      }

      await client.query('BEGIN');

      const role = await client.query(
        'SELECT code FROM mic2.roles WHERE code = $1',
        [role_code]
      );

      if (!role.rows[0]) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          ok: false,
          message: 'Неизвестная роль',
        });
      }

      const code = createActivationCode();

      const result = await client.query(
        `INSERT INTO mic2.employees
          (employee_no, full_name, department, job_title,
           role_code, login, password_hash,
           must_change_password, account_status,
           hired_at, activation_code_hash,
           activation_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,TRUE,'active',$7,$8,$9)
         RETURNING id, full_name, login, role_code`,
        [
          employee_no || null,
          String(full_name).trim(),
          department,
          String(job_title).trim(),
          role_code,
          String(login).trim(),
          hired_at || null,
          await hashActivationCode(code),
          activationExpiry(),
        ]
      );

      await client.query('COMMIT');

      res.status(201).json({
        ok: true,
        employee: result.rows[0],
        activation_code: code,
        activation_expires_in_minutes: 15,
      });

    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}

      console.error('MIC2 CREATE EMPLOYEE ERROR:', error);

      res.status(error.code === '23505' ? 409 : 500).json({
        ok: false,
        message: error.code === '23505'
          ? 'Логин или табельный номер уже используется'
          : 'Не удалось создать сотрудника',
      });

    } finally {
      client.release();
    }
  });

  return router;
}

// Проверка токена и актуальной роли по базе данных.
function authenticateMic2Employee(pool) {
  return (req, res, next) => {
    authenticate(req, res, async () => {
      try {
        if (req.auth.kind !== 'mic2_employee') {
          return res.status(401).json({
            ok: false,
            message: 'Недействительный тип учётной записи',
          });
        }

        const result = await pool.query(
          `SELECT id, role_code, account_status
           FROM mic2.employees WHERE id = $1`,
          [req.auth.sub]
        );

        const employee = result.rows[0];

        if (
          !employee ||
          employee.account_status !== 'active' ||
          employee.role_code !== req.auth.role
        ) {
          return res.status(401).json({
            ok: false,
            message: 'Учётная запись заблокирована или изменена',
          });
        }

        req.employee = employee;
        next();

      } catch (error) {
        console.error('MIC2 AUTH ERROR:', error);

        res.status(500).json({
          ok: false,
          message: 'Ошибка проверки учётной записи',
        });
      }
    });
  };
}

module.exports = {
  createMic2AuthRouter,
  authenticateMic2Employee,
};
