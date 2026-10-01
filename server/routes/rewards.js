const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Reward Manager: view every customer's loyalty balance, and adjust points by hand.
router.get('/', asyncHandler(async (req, res) => {
  const sql = `SELECT id, name, email, phone, loyalty_points FROM customers
               WHERE company_id = ? ORDER BY loyalty_points DESC, name`;
  res.json(await db.prepare(sql).all(req.user.company_id));
}));

// Body: { delta: number, reason?: string } -- delta can be negative to redeem points.
router.post('/:customerId/adjust', asyncHandler(async (req, res) => {
  const { delta } = req.body || {};
  const amount = Number(delta);
  if (!amount) return res.status(400).json({ error: 'Enter a non-zero point amount.' });
  const companyId = req.user.company_id;
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND company_id = ?').get(req.params.customerId, companyId);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  const newBalance = Math.max(0, Number(customer.loyalty_points) + amount);
  await db
    .prepare('UPDATE customers SET loyalty_points = ?, updated_at = now() WHERE id = ? AND company_id = ?')
    .run(newBalance, req.params.customerId, companyId);
  res.json({ ok: true, loyalty_points: newBalance });
}));

module.exports = router;
