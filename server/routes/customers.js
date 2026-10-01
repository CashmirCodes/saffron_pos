const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT * FROM customers WHERE company_id = ?';
  const params = [req.user.company_id];
  if (q) {
    sql += ' AND (name ILIKE ? OR email ILIKE ? OR phone ILIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY name';
  res.json(await db.prepare(sql).all(...params));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  const purchases = await db
    .prepare('SELECT * FROM sales WHERE customer_id = ? AND company_id = ? ORDER BY created_at DESC')
    .all(req.params.id, req.user.company_id);
  res.json({ ...customer, purchases });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, email, phone, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Customer name is required.' });
  const info = await db
    .prepare('INSERT INTO customers (company_id, name, email, phone, notes) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.company_id, name, email || null, phone || null, notes || null);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM customers WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!existing) return res.status(404).json({ error: 'Customer not found.' });
  const merged = { ...existing, ...req.body };
  await db.prepare(
    `UPDATE customers SET name=?, email=?, phone=?, notes=?, loyalty_points=?,
     updated_at=now() WHERE id=? AND company_id=?`
  ).run(merged.name, merged.email, merged.phone, merged.notes, merged.loyalty_points, req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM customers WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

module.exports = router;
