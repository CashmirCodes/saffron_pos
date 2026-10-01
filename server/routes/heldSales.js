const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// List held sales. ?withCustomer=1 filters to ones tied to a customer (Customer Orders view).
router.get('/', asyncHandler(async (req, res) => {
  let sql = `SELECT h.*, c.name AS customer_name, u.full_name AS held_by, a.full_name AS associate_name
             FROM held_sales h
             LEFT JOIN customers c ON c.id = h.customer_id
             LEFT JOIN users u ON u.id = h.user_id
             LEFT JOIN users a ON a.id = h.associate_id
             WHERE h.company_id = ?`;
  const params = [req.user.company_id];
  if (req.query.withCustomer === '1') sql += ' AND h.customer_id IS NOT NULL';
  sql += ' ORDER BY h.created_at DESC';
  const rows = await db.prepare(sql).all(...params);
  res.json(rows.map((r) => ({ ...r, cart: JSON.parse(r.cart_json) })));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { customer_id, associate_id, label, cart } = req.body || {};
  if (!Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'Nothing to hold -- the cart is empty.' });
  }
  const info = await db
    .prepare('INSERT INTO held_sales (company_id, customer_id, associate_id, user_id, label, cart_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.company_id, customer_id || null, associate_id || null, req.user.id, label || null, JSON.stringify(cart));
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM held_sales WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

module.exports = router;
