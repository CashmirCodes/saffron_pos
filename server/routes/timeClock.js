const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Current clock status for the logged-in user.
router.get('/status', asyncHandler(async (req, res) => {
  const open = await db
    .prepare('SELECT * FROM time_clock_entries WHERE user_id = ? AND company_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1')
    .get(req.user.id, req.user.company_id);
  res.json({ clockedIn: !!open, entry: open || null });
}));

// History. Admins see everyone; cashiers see only their own.
router.get('/', asyncHandler(async (req, res) => {
  let sql = `SELECT t.*, u.full_name AS employee_name FROM time_clock_entries t
             JOIN users u ON u.id = t.user_id
             WHERE t.company_id = ?`;
  const params = [req.user.company_id];
  if (req.user.role !== 'admin') {
    sql += ' AND t.user_id = ?';
    params.push(req.user.id);
  }
  sql += ' ORDER BY t.clock_in DESC LIMIT 200';
  res.json(await db.prepare(sql).all(...params));
}));

router.post('/clock-in', asyncHandler(async (req, res) => {
  const open = await db
    .prepare('SELECT id FROM time_clock_entries WHERE user_id = ? AND company_id = ? AND clock_out IS NULL')
    .get(req.user.id, req.user.company_id);
  if (open) return res.status(400).json({ error: 'You are already clocked in.' });
  const info = await db
    .prepare('INSERT INTO time_clock_entries (company_id, user_id) VALUES (?, ?)')
    .run(req.user.company_id, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.post('/clock-out', asyncHandler(async (req, res) => {
  const open = await db
    .prepare('SELECT id FROM time_clock_entries WHERE user_id = ? AND company_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1')
    .get(req.user.id, req.user.company_id);
  if (!open) return res.status(400).json({ error: 'You are not currently clocked in.' });
  await db.prepare('UPDATE time_clock_entries SET clock_out = now() WHERE id = ?').run(open.id);
  res.json({ ok: true });
}));

module.exports = router;
