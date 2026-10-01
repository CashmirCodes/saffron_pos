const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT * FROM vendors WHERE company_id = ?';
  const params = [req.user.company_id];
  if (q) {
    sql += ' AND (name ILIKE ? OR contact_name ILIKE ? OR email ILIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY name';
  res.json(await db.prepare(sql).all(...params));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const vendor = await db.prepare('SELECT * FROM vendors WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
  const orders = await db
    .prepare('SELECT * FROM purchase_orders WHERE vendor_id = ? AND company_id = ? ORDER BY created_at DESC')
    .all(req.params.id, req.user.company_id);
  res.json({ ...vendor, orders });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, contact_name, email, phone, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Vendor name is required.' });
  const info = await db
    .prepare('INSERT INTO vendors (company_id, name, contact_name, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.company_id, name, contact_name || null, email || null, phone || null, notes || null);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM vendors WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!existing) return res.status(404).json({ error: 'Vendor not found.' });
  const merged = { ...existing, ...req.body };
  await db.prepare(
    `UPDATE vendors SET name=?, contact_name=?, email=?, phone=?, notes=?, updated_at=now() WHERE id=? AND company_id=?`
  ).run(merged.name, merged.contact_name, merged.email, merged.phone, merged.notes, req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM vendors WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

module.exports = router;
