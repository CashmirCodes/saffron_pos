const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

async function nextPoNumber(queryDb, companyId) {
  const row = await queryDb.prepare('SELECT COUNT(*) AS c FROM purchase_orders WHERE company_id = ?').get(companyId);
  const n = (Number(row.c) + 1).toString().padStart(5, '0');
  return `PO-${n}`;
}

router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT po.*, v.name AS vendor_name,
             (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) AS item_count
             FROM purchase_orders po
             LEFT JOIN vendors v ON v.id = po.vendor_id
             WHERE po.company_id = ?`;
  const params = [req.user.company_id];
  if (status) { sql += ' AND po.status = ?'; params.push(status); }
  sql += ' ORDER BY po.created_at DESC';
  res.json(await db.prepare(sql).all(...params));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const po = await db
    .prepare(`SELECT po.*, v.name AS vendor_name FROM purchase_orders po
              LEFT JOIN vendors v ON v.id = po.vendor_id WHERE po.id = ? AND po.company_id = ?`)
    .get(req.params.id, req.user.company_id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
  const items = await db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(req.params.id);
  res.json({ ...po, items });
}));

// Create a PO. Body: { vendor_id, notes, items: [{product_id, name, qty_ordered, cost}] }
router.post('/', asyncHandler(async (req, res) => {
  const { vendor_id, notes, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'A purchase order needs at least one item.' });
  }
  const companyId = req.user.company_id;

  const tx = db.transaction(async (txdb) => {
    const poNumber = await nextPoNumber(txdb, companyId);
    const info = await txdb
      .prepare('INSERT INTO purchase_orders (company_id, po_number, vendor_id, notes) VALUES (?, ?, ?, ?)')
      .run(companyId, poNumber, vendor_id || null, notes || null);
    const poId = info.lastInsertRowid;
    for (const it of items) {
      await txdb
        .prepare('INSERT INTO purchase_order_items (po_id, product_id, name, qty_ordered, cost) VALUES (?, ?, ?, ?, ?)')
        .run(poId, it.product_id || null, it.name, Number(it.qty_ordered) || 0, Number(it.cost) || 0);
    }
    return poId;
  });

  const poId = await tx();
  const po = await db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  const poItems = await db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
  res.status(201).json({ ...po, items: poItems });
}));

// Receive a PO -- adds stock to inventory, logs receiving history, marks PO received.
router.post('/:id/receive', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const po = await db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?').get(req.params.id, companyId);
  if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
  if (po.status === 'received') return res.status(400).json({ error: 'This purchase order was already received.' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'This purchase order was cancelled.' });

  const tx = db.transaction(async (txdb) => {
    const items = await txdb.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(req.params.id);
    for (const item of items) {
      if (item.product_id) {
        await txdb
          .prepare('UPDATE products SET qty_on_hand = qty_on_hand + ?, updated_at = now() WHERE id = ? AND company_id = ?')
          .run(item.qty_ordered, item.product_id, companyId);
      }
      await txdb
        .prepare('INSERT INTO stock_receipts (company_id, product_id, po_id, qty, cost, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(companyId, item.product_id || null, po.id, item.qty_ordered, item.cost, req.user.id);
    }
    await txdb
      .prepare(`UPDATE purchase_orders SET status = 'received', received_at = now() WHERE id = ? AND company_id = ?`)
      .run(po.id, companyId);
  });

  await tx();
  res.json({ ok: true });
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const po = await db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?').get(req.params.id, companyId);
  if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
  if (po.status !== 'ordered') return res.status(400).json({ error: 'Only open purchase orders can be cancelled.' });
  await db.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ? AND company_id = ?`).run(po.id, companyId);
  res.json({ ok: true });
}));

module.exports = router;
