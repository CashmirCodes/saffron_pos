const express = require('express');
const { db, getSetting } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

async function nextSaleNumber(queryDb, companyId) {
  const row = await queryDb.prepare('SELECT COUNT(*) AS c FROM sales WHERE company_id = ?').get(companyId);
  const n = (Number(row.c) + 1).toString().padStart(6, '0');
  return `SALE-${n}`;
}

router.get('/', asyncHandler(async (req, res) => {
  const { from, to, userId } = req.query;
  let sql = 'SELECT s.*, u.full_name AS cashier_name, c.name AS customer_name, a.full_name AS associate_name FROM sales s ' +
    'LEFT JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN users a ON a.id = s.associate_id WHERE s.company_id = ?';
  const params = [req.user.company_id];
  if (from) { sql += ' AND s.created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND s.created_at <= ?'; params.push(to); }
  if (userId) { sql += ' AND s.user_id = ?'; params.push(userId); }
  sql += ' ORDER BY s.created_at DESC LIMIT 200';
  res.json(await db.prepare(sql).all(...params));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const sale = await db.prepare('SELECT * FROM sales WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!sale) return res.status(404).json({ error: 'Sale not found.' });
  const items = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);
  res.json({ ...sale, items });
}));

// Create a sale (checkout). Body: { items: [{product_id, qty}], customer_id, associate_id, discount, payment_method }
router.post('/', asyncHandler(async (req, res) => {
  const { items, customer_id, associate_id, discount, payment_method } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'A sale needs at least one item.' });
  }

  const companyId = req.user.company_id;
  const taxRate = parseFloat(await getSetting(companyId, 'tax_rate', '0')) || 0;
  const loyaltyRate = parseFloat(await getSetting(companyId, 'loyalty_points_rate', '1')) || 0;

  const tx = db.transaction(async (txdb) => {
    let subtotal = 0;
    const lineItems = [];

    for (const item of items) {
      const product = await txdb.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(item.product_id, companyId);
      if (!product) throw new Error(`Product ${item.product_id} not found.`);
      const qty = Number(item.qty) || 1;
      if (product.qty_on_hand < qty) {
        throw new Error(`Not enough stock for "${product.name}" (have ${product.qty_on_hand}, need ${qty}).`);
      }
      const lineTotal = Math.round(product.price * qty * 100) / 100;
      subtotal += lineTotal;
      lineItems.push({ product, qty, lineTotal });
    }

    if (customer_id) {
      const customer = await txdb.prepare('SELECT id FROM customers WHERE id = ? AND company_id = ?').get(customer_id, companyId);
      if (!customer) throw new Error('Customer not found.');
    }
    if (associate_id) {
      const associate = await txdb.prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND active = 1').get(associate_id, companyId);
      if (!associate) throw new Error('Associate not found.');
    }

    const discountAmt = Number(discount) || 0;
    const taxableAmount = Math.max(subtotal - discountAmt, 0);
    const tax = Math.round(taxableAmount * taxRate * 100) / 100;
    const total = Math.round((taxableAmount + tax) * 100) / 100;

    const saleNumber = await nextSaleNumber(txdb, companyId);
    const saleInfo = await txdb
      .prepare(
        `INSERT INTO sales (company_id, sale_number, user_id, customer_id, associate_id, subtotal, tax, discount, total, payment_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(companyId, saleNumber, req.user.id, customer_id || null, associate_id || null, subtotal, tax, discountAmt, total, payment_method || 'cash');

    const saleId = saleInfo.lastInsertRowid;

    for (const li of lineItems) {
      await txdb.prepare(
        `INSERT INTO sale_items (sale_id, product_id, name, price, qty, line_total) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(saleId, li.product.id, li.product.name, li.product.price, li.qty, li.lineTotal);

      await txdb.prepare(
        `UPDATE products SET qty_on_hand = qty_on_hand - ?, updated_at = now() WHERE id = ? AND company_id = ?`
      ).run(li.qty, li.product.id, companyId);
    }

    if (customer_id) {
      const pointsEarned = Math.floor(total * loyaltyRate);
      await txdb.prepare(
        `UPDATE customers SET loyalty_points = loyalty_points + ?, updated_at = now() WHERE id = ? AND company_id = ?`
      ).run(pointsEarned, customer_id, companyId);
    }

    return txdb.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });

  try {
    const sale = await tx();
    const items2 = await db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
    // Cashier/Associate names -- so the receipt printed right after this
    // sale (which uses this response directly, not the GET /api/sales list
    // that already joins these) can show "Cashier: ..." / "Associate: ..."
    // via the Print Designer's Sales Receipt field options.
    const cashier = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(sale.user_id);
    const associate = sale.associate_id ? await db.prepare('SELECT full_name FROM users WHERE id = ?').get(sale.associate_id) : null;
    res.status(201).json({ ...sale, items: items2, cashier_name: cashier?.full_name || null, associate_name: associate?.full_name || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Void a sale and restock items
router.post('/:id/void', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const sale = await db.prepare('SELECT * FROM sales WHERE id = ? AND company_id = ?').get(req.params.id, companyId);
  if (!sale) return res.status(404).json({ error: 'Sale not found.' });
  if (sale.status === 'voided') return res.status(400).json({ error: 'Sale already voided.' });

  const tx = db.transaction(async (txdb) => {
    const items = await txdb.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);
    for (const item of items) {
      if (item.product_id) {
        await txdb.prepare(
          `UPDATE products SET qty_on_hand = qty_on_hand + ?, updated_at = now() WHERE id = ? AND company_id = ?`
        ).run(item.qty, item.product_id, companyId);
      }
    }
    await txdb.prepare(
      `UPDATE sales SET status = 'voided', updated_at = now() WHERE id = ? AND company_id = ?`
    ).run(req.params.id, companyId);
  });

  await tx();
  res.json({ ok: true });
}));

module.exports = router;
