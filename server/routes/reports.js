const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Summary for a date range (defaults to today)
router.get('/summary', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const { from, to } = req.query;
  const fromDate = from || new Date().toISOString().slice(0, 10);
  const toDate = to || fromDate;

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS sale_count, COALESCE(SUM(total),0) AS revenue,
       COALESCE(SUM(tax),0) AS tax_collected, COALESCE(SUM(discount),0) AS discounts
       FROM sales WHERE company_id = ? AND status = 'completed' AND created_at::date BETWEEN ?::date AND ?::date`
    )
    .get(companyId, fromDate, toDate);

  const byPayment = await db
    .prepare(
      `SELECT payment_method, COUNT(*) AS count, SUM(total) AS total FROM sales
       WHERE company_id = ? AND status = 'completed' AND created_at::date BETWEEN ?::date AND ?::date
       GROUP BY payment_method`
    )
    .all(companyId, fromDate, toDate);

  res.json({ from: fromDate, to: toDate, ...totals, sale_count: Number(totals.sale_count), byPayment });
}));

// Item Summary. sale_items doesn't snapshot the item's cost at sale time
// (only price), so "cost" here is the product's CURRENT cost (avg cost) --
// close enough for a summary report, but note it isn't a historical cost.
// Left-joined to products (not inner) so a since-deleted item's past sales
// still show up, just with cost/category blank instead of dropping the row.
router.get('/top-products', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const { from, to, limit } = req.query;
  const fromDate = from || '2000-01-01';
  const toDate = to || '9999-12-31';
  const rows = await db
    .prepare(
      `SELECT si.name, MAX(p.item_number) AS item_number, MAX(p.sku) AS sku,
       SUM(si.qty) AS qty_sold, SUM(si.line_total) AS revenue,
       COALESCE(MAX(p.cost), 0) AS cost, COALESCE(MAX(p.category_id), NULL) AS category_id,
       MAX(c.name) AS category_name,
       COALESCE(MAX(p.cost), 0) * SUM(si.qty) AS total_cost,
       SUM(si.line_total) - COALESCE(MAX(p.cost), 0) * SUM(si.qty) AS gross_profit
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE s.company_id = ? AND s.status = 'completed' AND s.created_at::date BETWEEN ?::date AND ?::date
       GROUP BY si.product_id, si.name ORDER BY qty_sold DESC LIMIT ?`
    )
    .all(companyId, fromDate, toDate, Number(limit) || 10);
  res.json(rows);
}));

router.get('/by-employee', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const { from, to } = req.query;
  const fromDate = from || '2000-01-01';
  const toDate = to || '9999-12-31';
  const rows = await db
    .prepare(
      `SELECT u.full_name, COUNT(s.id) AS sale_count, SUM(s.total) AS revenue
       FROM sales s JOIN users u ON u.id = s.user_id
       WHERE s.company_id = ? AND s.status = 'completed' AND s.created_at::date BETWEEN ?::date AND ?::date
       GROUP BY u.id, u.full_name ORDER BY revenue DESC`
    )
    .all(companyId, fromDate, toDate);
  res.json(rows);
}));

router.get('/by-associate', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const { from, to } = req.query;
  const fromDate = from || '2000-01-01';
  const toDate = to || '9999-12-31';
  const rows = await db
    .prepare(
      `SELECT a.full_name, COUNT(s.id) AS sale_count, SUM(s.total) AS revenue
       FROM sales s JOIN users a ON a.id = s.associate_id
       WHERE s.company_id = ? AND s.status = 'completed' AND s.associate_id IS NOT NULL
       AND s.created_at::date BETWEEN ?::date AND ?::date
       GROUP BY a.id, a.full_name ORDER BY revenue DESC`
    )
    .all(companyId, fromDate, toDate);
  res.json(rows);
}));

router.get('/low-stock', asyncHandler(async (req, res) => {
  res.json(
    await db
      .prepare('SELECT * FROM products WHERE company_id = ? AND active = 1 AND qty_on_hand <= reorder_level ORDER BY qty_on_hand ASC')
      .all(req.user.company_id)
  );
}));

module.exports = router;
