const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// What the register should have for a given business day, computed fresh
// from that day's completed sales (never trust a client-sent expected
// figure -- same principle as the Receive Items voucher math).
async function computeExpected(companyId, businessDate) {
  const byPayment = await db
    .prepare(
      `SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sales
       WHERE company_id = ? AND status = 'completed' AND created_at::date = ?::date
       GROUP BY payment_method`
    )
    .all(companyId, businessDate);

  let cash = 0, card = 0, other = 0, saleCount = 0;
  for (const row of byPayment) {
    const total = Number(row.total) || 0;
    const count = Number(row.count) || 0;
    saleCount += count;
    if (row.payment_method === 'cash') cash += total;
    else if (row.payment_method === 'card') card += total;
    else other += total;
  }
  return { cash, card, other, total: cash + card + other, sale_count: saleCount };
}

// GET /api/eod?date=YYYY-MM-DD -- expected totals for that day, plus the
// existing close-out record if that day has already been closed.
router.get('/', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const businessDate = req.query.date || todayStr();
  const expected = await computeExpected(companyId, businessDate);
  const closeout = await db
    .prepare(
      `SELECT c.*, to_char(c.business_date, 'YYYY-MM-DD') AS business_date, u.full_name AS closed_by FROM eod_closeouts c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.company_id = ? AND c.business_date = ?::date`
    )
    .get(companyId, businessDate);
  res.json({ date: businessDate, expected, closeout: closeout || null });
}));

// GET /api/eod/history -- most recent close-outs, newest first.
router.get('/history', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const limit = Number(req.query.limit) || 30;
  const rows = await db
    .prepare(
      `SELECT c.*, to_char(c.business_date, 'YYYY-MM-DD') AS business_date, u.full_name AS closed_by FROM eod_closeouts c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.company_id = ?
       ORDER BY c.business_date DESC
       LIMIT ?`
    )
    .all(companyId, limit);
  res.json(rows);
}));

// POST /api/eod -- record (or update) the drawer count for a business day.
router.post('/', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const body = req.body || {};
  const businessDate = body.business_date || todayStr();
  const countedCash = Math.max(0, Number(body.counted_cash) || 0);
  const notes = body.notes || null;

  const expected = await computeExpected(companyId, businessDate);
  const overShort = countedCash - expected.cash;

  await db
    .prepare(
      `INSERT INTO eod_closeouts (company_id, business_date, user_id, expected_cash, counted_cash, card_total, sale_count, over_short, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
       ON CONFLICT (company_id, business_date) DO UPDATE SET
         user_id = excluded.user_id, expected_cash = excluded.expected_cash, counted_cash = excluded.counted_cash,
         card_total = excluded.card_total, sale_count = excluded.sale_count, over_short = excluded.over_short,
         notes = excluded.notes, updated_at = now()`
    )
    .run(companyId, businessDate, req.user.id, expected.cash, countedCash, expected.card, expected.sale_count, overShort, notes);

  const closeout = await db
    .prepare(
      `SELECT c.*, to_char(c.business_date, 'YYYY-MM-DD') AS business_date, u.full_name AS closed_by FROM eod_closeouts c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.company_id = ? AND c.business_date = ?::date`
    )
    .get(companyId, businessDate);

  res.status(201).json({ ok: true, expected, closeout });
}));

module.exports = router;
