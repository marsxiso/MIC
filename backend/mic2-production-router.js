'use strict';

const express = require('express');
const { authenticateMic2Employee } = require('./mic2-auth-router');

function createMic2ProductionRouter({ pool }) {
  if (!pool) throw new Error('PostgreSQL pool required');
  const router = express.Router();
  const auth = authenticateMic2Employee(pool);

  router.get('/workspace', auth, async (req, res) => {
    try {
      if (!['cnc_operator', 'production_manager', 'administrator'].includes(req.employee.role_code)) {
        return res.status(403).json({ ok: false, message: 'Нет доступа к производственному рабочему месту' });
      }

      const [bins, products, cycles] = await Promise.all([
        pool.query(`
          SELECT b.id, b.bin_code, b.bin_status,
                 c.id AS active_cycle_id, c.cycle_no,
                 c.product_id, c.product_code_snapshot, c.product_name_snapshot,
                 c.setup_id, c.setup_code_snapshot, c.responsible_employee_id,
                 e.full_name AS responsible_employee_name, c.started_at
            FROM mic2.plastic_bins b
            LEFT JOIN mic2.production_cycles c
              ON c.bin_id = b.id AND c.cycle_status = 'active'
            LEFT JOIN mic2.employees e ON e.id = c.responsible_employee_id
           WHERE b.bin_status <> 'archived'
           ORDER BY b.bin_code::BIGINT, b.id
        `),
        pool.query(`
          SELECT p.id, p.product_code, p.product_name, p.box_quantity_norm,
                 s.id AS setup_id, s.setup_code, s.setup_name
            FROM mic2.products p
            JOIN mic2.product_setups s ON s.product_id = p.id AND s.is_active = TRUE
           WHERE p.is_active = TRUE
           ORDER BY p.product_name, s.setup_code
        `),
        pool.query(`
          SELECT c.id, c.bin_id, b.bin_code, c.cycle_no, c.product_code_snapshot,
                 c.product_name_snapshot, c.setup_code_snapshot, c.started_at,
                 c.responsible_employee_id, e.full_name AS responsible_employee_name,
                 COALESCE(SUM(v.quantity) FILTER (WHERE v.bucket = 'production_pending_qc'), 0)::BIGINT AS pending_qc,
                 COALESCE(SUM(v.quantity) FILTER (WHERE v.bucket = 'good_unboxed'), 0)::BIGINT AS good_unboxed,
                 COALESCE(SUM(v.quantity) FILTER (WHERE v.bucket = 'rework'), 0)::BIGINT AS rework,
                 COALESCE(SUM(v.quantity) FILTER (WHERE v.bucket = 'isolator'), 0)::BIGINT AS isolator,
                 COALESCE(SUM(v.quantity) FILTER (WHERE v.bucket = 'packed'), 0)::BIGINT AS packed,
                 COALESCE(SUM(v.quantity) FILTER (WHERE v.bucket = 'scrapped'), 0)::BIGINT AS scrapped
            FROM mic2.production_cycles c
            JOIN mic2.plastic_bins b ON b.id = c.bin_id
            JOIN mic2.employees e ON e.id = c.responsible_employee_id
            LEFT JOIN mic2.v_cycle_quantity_balances v ON v.cycle_id = c.id
           WHERE c.cycle_status = 'active'
             AND ($2::BOOLEAN OR c.responsible_employee_id = $1)
           GROUP BY c.id, b.bin_code, e.full_name
           ORDER BY c.started_at DESC
        `, [req.employee.id, ['production_manager', 'administrator'].includes(req.employee.role_code)])
      ]);

      res.json({ ok: true, employee: req.employee, bins: bins.rows, products: products.rows, cycles: cycles.rows });
    } catch (error) {
      console.error('MIC2 OPERATOR WORKSPACE ERROR:', error);
      res.status(500).json({ ok: false, message: 'Не удалось загрузить производственное рабочее место' });
    }
  });

  router.post('/cycles', auth, async (req, res) => {
    const client = await pool.connect();
    try {
      if (!['cnc_operator', 'production_manager', 'administrator'].includes(req.employee.role_code)) {
        return res.status(403).json({ ok: false, message: 'Нет прав для запуска производственного цикла' });
      }

      const binId = Number(req.body?.bin_id);
      const productId = Number(req.body?.product_id);
      const setupId = Number(req.body?.setup_id);
      if (![binId, productId, setupId].every((n) => Number.isSafeInteger(n) && n > 0)) {
        return res.status(400).json({ ok: false, message: 'Выберите контейнер, продукт и наладку' });
      }

      await client.query('BEGIN');
      const bin = await client.query(
        'SELECT id, bin_code, bin_status FROM mic2.plastic_bins WHERE id = $1 FOR UPDATE',
        [binId]
      );
      if (!bin.rows[0] || bin.rows[0].bin_status !== 'free') {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, message: 'Контейнер не найден или сейчас занят' });
      }

      const product = await client.query(
        `SELECT p.id, p.product_code, p.product_name, s.id AS setup_id, s.setup_code
           FROM mic2.products p
           JOIN mic2.product_setups s ON s.product_id = p.id
          WHERE p.id = $1 AND s.id = $2 AND p.is_active = TRUE AND s.is_active = TRUE
          FOR SHARE OF p, s`,
        [productId, setupId]
      );
      if (!product.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, message: 'Выбранный продукт или наладка недоступны' });
      }

      const lastCycle = await client.query(
        'SELECT COALESCE(MAX(cycle_no), 0)::int AS last_no FROM mic2.production_cycles WHERE bin_id = $1',
        [binId]
      );
      const cycleNo = lastCycle.rows[0].last_no + 1;
      const result = await client.query(
        `INSERT INTO mic2.production_cycles
          (bin_id, cycle_no, product_id, setup_id, started_by, responsible_employee_id,
           product_code_snapshot, product_name_snapshot, setup_code_snapshot)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)
         RETURNING id, bin_id, cycle_no, product_id, setup_id, started_at, cycle_status`,
        [binId, cycleNo, productId, setupId, req.employee.id,
         product.rows[0].product_code, product.rows[0].product_name, product.rows[0].setup_code]
      );

      await client.query(
        'INSERT INTO mic2.cycle_operator_periods (cycle_id, operator_id, started_at) VALUES ($1,$2,NOW())',
        [result.rows[0].id, req.employee.id]
      );
      await client.query(
        `INSERT INTO mic2.audit_log (actor_id, actor_role_code, action, entity_type, entity_id, after_data)
         VALUES ($1,$2,'production_cycle_started','production_cycle',$3,$4::jsonb)`,
        [req.employee.id, req.employee.role_code, result.rows[0].id,
         JSON.stringify({ bin_code: bin.rows[0].bin_code, product_code: product.rows[0].product_code, setup_code: product.rows[0].setup_code })]
      );

      await client.query('COMMIT');
      res.status(201).json({ ok: true, cycle: result.rows[0], bin_code: bin.rows[0].bin_code,
        product_code: product.rows[0].product_code, product_name: product.rows[0].product_name });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error('MIC2 START CYCLE ERROR:', error);
      res.status(error.code === '23505' ? 409 : 500).json({
        ok: false,
        message: error.code === '23505' ? 'В контейнере уже запущен другой цикл' : (error.message || 'Не удалось запустить цикл')
      });
    } finally {
      client.release();
    }
  });

  router.post('/cycles/:cycleId/output', auth, async (req, res) => {
    const client = await pool.connect();
    try {
      if (!['cnc_operator', 'administrator'].includes(req.employee.role_code)) {
        return res.status(403).json({ ok: false, message: 'Только оператор ЧПУ может фиксировать выпуск деталей' });
      }
      const cycleId = Number(req.params.cycleId);
      const quantity = Number(req.body?.quantity);
      if (!Number.isSafeInteger(cycleId) || cycleId <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100000) {
        return res.status(400).json({ ok: false, message: 'Укажите корректное положительное количество деталей' });
      }

      await client.query('BEGIN');
      const cycle = await client.query(
        `SELECT id, cycle_status, responsible_employee_id
           FROM mic2.production_cycles WHERE id = $1 FOR UPDATE`,
        [cycleId]
      );
      if (!cycle.rows[0] || cycle.rows[0].cycle_status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, message: 'Активный производственный цикл не найден' });
      }
      if (String(cycle.rows[0].responsible_employee_id) !== String(req.employee.id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, message: 'Этот контейнер закреплён за другим оператором' });
      }

      const period = await client.query(
        'SELECT id FROM mic2.cycle_operator_periods WHERE cycle_id = $1 AND operator_id = $2 AND ended_at IS NULL FOR UPDATE',
        [cycleId, req.employee.id]
      );
      if (!period.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, message: 'Для вас не открыт период работы с этим контейнером' });
      }

      const output = await client.query(
        `INSERT INTO mic2.production_output_entries (cycle_id, operator_id, quantity, entered_by)
         VALUES ($1,$2,$3,$2) RETURNING id, quantity, entered_at`,
        [cycleId, req.employee.id, quantity]
      );
      await client.query(
        `INSERT INTO mic2.cycle_quantity_movements
          (cycle_id, movement_type, from_bucket, to_bucket, quantity, entered_by, note)
         VALUES ($1,'production_received',NULL,'production_pending_qc',$2,$3,'Выпуск оператора ЧПУ')`,
        [cycleId, quantity, req.employee.id]
      );
      await client.query(
        `INSERT INTO mic2.audit_log (actor_id, actor_role_code, action, entity_type, entity_id, after_data)
         VALUES ($1,$2,'production_output_recorded','production_output_entry',$3,$4::jsonb)`,
        [req.employee.id, req.employee.role_code, output.rows[0].id, JSON.stringify({ cycle_id: cycleId, quantity })]
      );

      const balance = await client.query(
        `SELECT bucket, quantity FROM mic2.v_cycle_quantity_balances WHERE cycle_id = $1 ORDER BY bucket`,
        [cycleId]
      );
      await client.query('COMMIT');
      res.status(201).json({ ok: true, output: output.rows[0], balances: balance.rows });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error('MIC2 RECORD OUTPUT ERROR:', error);
      res.status(500).json({ ok: false, message: error.message || 'Не удалось сохранить выпуск' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { createMic2ProductionRouter };
