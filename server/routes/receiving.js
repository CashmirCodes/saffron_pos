const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Receiving History: every stock receipt, whether from a PO or a quick
// manual receive. Optional from/to (YYYY-MM-DD) narrow it to a date range,
// same convention as the Reports endpoints, so a user can pull up any past
// window instead of just the most recent 300 rows.
router.get('/', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || '2000-01-01';
  const toDate = to || '9999-12-31';
  const sql = `SELECT r.*, p.name AS product_name, po.po_number, u.full_name AS received_by
               FROM stock_receipts r
               LEFT JOIN products p ON p.id = r.product_id
               LEFT JOIN purchase_orders po ON po.id = r.po_id
               LEFT JOIN users u ON u.id = r.user_id
               WHERE r.company_id = ? AND r.created_at::date BETWEEN ?::date AND ?::date
               ORDER BY r.created_at DESC
               LIMIT 300`;
  res.json(await db.prepare(sql).all(req.user.company_id, fromDate, toDate));
}));

// Quick "Receive Items" -- add stock for one or more products without a
// purchase order, all in a single voucher/transaction. Accepts either a
// single legacy { product_id, qty, cost } body or a batch { items: [...] }
// body so multiple items can be received at once from one screen.
//
// Optional voucher-level charges: discount_pct (0-100), freight, fee, and
// a `spread` flag. When spread is true, those charges are distributed
// across the lines proportionally to each line's share of the subtotal,
// and the resulting *landed* cost (voucher cost +/- its share) is this
// receipt's per-unit cost -- what gets logged in stock_receipts (matching
// QuickBooks POS's "Order Cost": the actual cost of this specific
// shipment). Each line may also carry a new `price` (selling price),
// which updates the product's live price the same way editing it in the
// Item List would.
//
// products.cost, however, is QuickBooks POS's "Average Cost": a running
// weighted average across everything ever received, not a straight
// overwrite -- e.g. 100 units @ $2.75 already on hand + 100 units @ $3.00
// just received = (100*2.75 + 100*3.00) / 200 = $2.875 average. This is
// what inventory valuation and COGS should be based on; a receiving
// voucher landing at a one-off higher/lower price shouldn't instantly
// revalue every unit already sitting on the shelf.
//
// products.order_cost is the OTHER QuickBooks concept: not an average at
// all, just this receipt's own landed cost, overwritten every time -- it's
// what gets suggested as the starting cost the next time this item shows
// up on a voucher (see the fallback below).
router.post('/', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const body = req.body || {};
  const rawItems = Array.isArray(body.items) && body.items.length
    ? body.items
    : (body.product_id ? [{ product_id: body.product_id, qty: body.qty, cost: body.cost, price: body.price }] : []);

  const items = rawItems
    .map((it) => ({
      product_id: it.product_id,
      qty: Number(it.qty),
      cost: it.cost !== undefined && it.cost !== null && it.cost !== '' ? Number(it.cost) : null,
      price: it.price !== undefined && it.price !== null && it.price !== '' ? Number(it.price) : null
    }))
    .filter((it) => it.product_id && it.qty > 0);

  if (items.length === 0) {
    return res.status(400).json({ error: 'Add at least one item with a quantity greater than zero.' });
  }

  const discountPct = Math.min(100, Math.max(0, Number(body.discount_pct) || 0));
  const freight = Math.max(0, Number(body.freight) || 0);
  const fee = Math.max(0, Number(body.fee) || 0);
  const spread = !!body.spread;

  let summary = null;

  const tx = db.transaction(async (txdb) => {
    // Resolve each line's input cost first (falling back to the product's
    // Order Cost -- what it cost last time it was received, same as real
    // QuickBooks POS suggesting Order Cost as the starting point for a new
    // voucher line -- or its Average Cost if it's never been received
    // before) so the subtotal/spread math has real numbers to work with.
    const resolved = [];
    for (const item of items) {
      const product = await txdb.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(item.product_id, companyId);
      if (!product) throw new Error('One of the items in this voucher could not be found.');
      const fallbackCost = Number(product.order_cost) > 0 ? Number(product.order_cost) : Number(product.cost) || 0;
      const inputCost = item.cost !== null ? item.cost : fallbackCost;
      resolved.push({ item, product, inputCost, extCost: inputCost * item.qty });
    }

    const subtotal = resolved.reduce((sum, r) => sum + r.extCost, 0);
    const discountAmount = subtotal * (discountPct / 100);
    const pool = freight + fee - discountAmount; // what gets spread across lines, if enabled
    summary = { subtotal, discount_amount: discountAmount, freight, fee, total: subtotal - discountAmount + freight + fee };

    for (const r of resolved) {
      const share = subtotal > 0 ? r.extCost / subtotal : 1 / resolved.length;
      const adjustment = spread ? pool * share : 0;
      const effectiveCost = Math.max(0, r.inputCost + (r.item.qty ? adjustment / r.item.qty : 0)); // this receipt's landed cost (Order Cost)

      const existingQty = Number(r.product.qty_on_hand) || 0;
      const existingCost = Number(r.product.cost) || 0;
      const totalQty = existingQty + r.item.qty;
      // Weighted average across whatever's already on hand plus this receipt --
      // if there's nothing on hand yet (or it was somehow negative), the average
      // is simply this receipt's own cost.
      const averageCost = existingQty > 0 && totalQty > 0
        ? (existingQty * existingCost + r.item.qty * effectiveCost) / totalQty
        : effectiveCost;

      await txdb
        .prepare('UPDATE products SET qty_on_hand = qty_on_hand + ?, cost = ?, order_cost = ?, price = COALESCE(?, price), updated_at = now() WHERE id = ? AND company_id = ?')
        .run(r.item.qty, averageCost, effectiveCost, r.item.price, r.item.product_id, companyId);
      await txdb
        .prepare('INSERT INTO stock_receipts (company_id, product_id, po_id, qty, cost, user_id) VALUES (?, ?, NULL, ?, ?, ?)')
        .run(companyId, r.item.product_id, r.item.qty, effectiveCost, req.user.id);
    }
  });

  try {
    await tx();
    res.status(201).json({ ok: true, count: items.length, ...summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
