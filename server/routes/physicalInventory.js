const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Apply a physical inventory count: for each item the person actually
// counted, set qty_on_hand to the counted amount and log the difference for
// the audit trail. Items not included in `counts` are left untouched --
// the frontend decides whether "not counted" means "skip" or "count as 0"
// (its "Set all items not counted to zero" checkbox) before ever POSTing.
router.post('/apply', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const rows = Array.isArray(req.body?.counts) ? req.body.counts : [];
  const items = rows
    .map((r) => ({ product_id: Number(r.product_id), counted_qty: Number(r.counted_qty) }))
    .filter((r) => r.product_id && Number.isFinite(r.counted_qty));

  if (items.length === 0) {
    return res.status(400).json({ error: 'Enter a counted quantity for at least one item.' });
  }

  const totals = { more_qty: 0, more_price: 0, more_cost: 0, less_qty: 0, less_price: 0, less_cost: 0 };
  let updated = 0;

  const tx = db.transaction(async (txdb) => {
    for (const item of items) {
      const product = await txdb.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(item.product_id, companyId);
      if (!product) continue;

      const expected = Number(product.qty_on_hand) || 0;
      const diff = item.counted_qty - expected;
      updated++;
      if (diff === 0) continue; // counted, matched expectations -- nothing to change or log

      await txdb
        .prepare('UPDATE products SET qty_on_hand = ?, updated_at = now() WHERE id = ? AND company_id = ?')
        .run(item.counted_qty, item.product_id, companyId);
      await txdb
        .prepare(
          `INSERT INTO physical_inventory_adjustments
             (company_id, product_id, name, expected_qty, counted_qty, difference_qty, price, cost, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(companyId, item.product_id, product.name, expected, item.counted_qty, diff, product.price, product.cost, req.user.id);

      const price = Number(product.price) || 0;
      const cost = Number(product.cost) || 0;
      if (diff > 0) {
        totals.more_qty += diff;
        totals.more_price += diff * price;
        totals.more_cost += diff * cost;
      } else {
        totals.less_qty += diff;
        totals.less_price += diff * price;
        totals.less_cost += diff * cost;
      }
    }
  });

  try {
    await tx();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({
    ok: true,
    updated,
    totals,
    net_qty: totals.more_qty + totals.less_qty,
    net_price: totals.more_price + totals.less_price,
    net_cost: totals.more_cost + totals.less_cost
  });
}));

// Physical Inventory History: every count that actually changed a
// quantity, most recent first. Optional from/to (YYYY-MM-DD) narrow it to a
// date range, same convention as the Reports endpoints.
router.get('/history', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || '2000-01-01';
  const toDate = to || '9999-12-31';
  const sql = `SELECT a.*, u.full_name AS counted_by
               FROM physical_inventory_adjustments a
               LEFT JOIN users u ON u.id = a.user_id
               WHERE a.company_id = ? AND a.created_at::date BETWEEN ?::date AND ?::date
               ORDER BY a.created_at DESC
               LIMIT 300`;
  res.json(await db.prepare(sql).all(req.user.company_id, fromDate, toDate));
}));

module.exports = router;
