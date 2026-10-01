const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// System-assigned Item Number: a plain zero-padded sequence per company
// (e.g. "000001"), never user-editable. This is what a self-printed barcode
// tag will encode later, so it needs to exist and be unique before that
// feature is built. Picks the SMALLEST unused number rather than always
// growing the max, so deleting an item frees its number for reuse by the
// next item added (deleting a product clears its item_number -- see the
// DELETE route below -- which is what makes that number "unused" here).
async function nextItemNumber(queryDb, companyId) {
  const row = await queryDb
    .prepare(
      `SELECT MIN(t.n) AS next_num
       FROM generate_series(1, (
         SELECT COALESCE(MAX(item_number::int), 0) + 1 FROM products WHERE company_id = ? AND item_number ~ '^[0-9]+$'
       )) AS t(n)
       WHERE NOT EXISTS (
         SELECT 1 FROM products WHERE company_id = ? AND item_number = LPAD(t.n::text, 6, '0')
       )`
    )
    .get(companyId, companyId);
  return String(row.next_num).padStart(6, '0');
}

// ---- Categories ----
router.get('/categories', asyncHandler(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM categories WHERE company_id = ? ORDER BY name').all(req.user.company_id));
}));

router.post('/categories', asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  try {
    const info = await db.prepare('INSERT INTO categories (company_id, name) VALUES (?, ?)').run(req.user.company_id, name);
    res.status(201).json({ id: info.lastInsertRowid, name });
  } catch (err) {
    res.status(400).json({ error: 'That category already exists.' });
  }
}));

router.put('/categories/:id', asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  const existing = await db.prepare('SELECT * FROM categories WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!existing) return res.status(404).json({ error: 'Department not found.' });
  try {
    await db.prepare('UPDATE categories SET name = ? WHERE id = ? AND company_id = ?').run(name, req.params.id, req.user.company_id);
    res.json({ ok: true, id: Number(req.params.id), name });
  } catch (err) {
    res.status(400).json({ error: 'That department name already exists.' });
  }
}));

router.delete('/categories/:id', asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM categories WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!existing) return res.status(404).json({ error: 'Department not found.' });
  const inUse = await db.prepare('SELECT COUNT(*) AS count FROM products WHERE category_id = ? AND company_id = ? AND active = 1').get(req.params.id, req.user.company_id);
  if (Number(inUse.count) > 0) {
    return res.status(400).json({ error: `Can't delete -- ${inUse.count} item${Number(inUse.count) === 1 ? ' is' : 's are'} still assigned to this department. Move or delete those items first.` });
  }
  await db.prepare('DELETE FROM categories WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

// ---- Products ----
router.get('/', asyncHandler(async (req, res) => {
  const { q, lowStock } = req.query;
  const companyId = req.user.company_id;

  // Self-heal: an active row can end up with a blank Item Number (legacy
  // data, manual DB edits, etc.) even though it's meant to always be
  // system-assigned and present. Backfill any gaps, oldest first, reusing
  // any numbers freed by deleted items first (see nextItemNumber above).
  // Deleted (inactive) items are left alone -- their number stays free.
  const missing = await db
    .prepare(`SELECT id FROM products WHERE company_id = ? AND active = 1 AND (item_number IS NULL OR item_number = '') ORDER BY id`)
    .all(companyId);
  for (const row of missing) {
    const item_number = await nextItemNumber(db, companyId);
    await db.prepare('UPDATE products SET item_number = ? WHERE id = ? AND company_id = ?').run(item_number, row.id, companyId);
  }

  let sql = `SELECT p.*, c.name AS category_name FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.active = 1 AND p.company_id = ?`;
  const params = [companyId];
  if (q) {
    sql += ' AND (p.name ILIKE ? OR p.sku ILIKE ? OR p.barcode ILIKE ? OR p.item_number ILIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (lowStock === '1') {
    sql += ' AND p.qty_on_hand <= p.reorder_level';
  }
  sql += ' ORDER BY p.name';
  res.json(await db.prepare(sql).all(...params));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  let product = await db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  if (!product.item_number) {
    const item_number = await nextItemNumber(db, req.user.company_id);
    await db.prepare('UPDATE products SET item_number = ? WHERE id = ? AND company_id = ?').run(item_number, product.id, req.user.company_id);
    product = { ...product, item_number };
  }
  res.json(product);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { sku, barcode, name, category_id, price, cost, order_cost, qty_on_hand, reorder_level } = req.body || {};
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'Name and price are required.' });
  }
  const item_number = await nextItemNumber(db, req.user.company_id);
  const info = await db
    .prepare(
      `INSERT INTO products (company_id, sku, barcode, name, category_id, price, cost, order_cost, qty_on_hand, reorder_level, item_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.company_id, sku || null, barcode || null, name, category_id || null, price, cost || 0, order_cost || 0, qty_on_hand || 0, reorder_level || 0, item_number);
  res.status(201).json({ id: info.lastInsertRowid, item_number });
}));

// Bulk import (create-or-update by SKU) -- backs the Item List's "Import
// Items" button. Accepts { items: [{ name, sku, barcode, category, price,
// cost, order_cost, qty_on_hand, reorder_level }, ...] } already parsed
// client-side from a CSV/Excel file. Rows are processed independently
// rather than as one all-or-nothing transaction, so a typo in row 1,500 of
// a few-thousand-row file doesn't sink the whole import -- each row's
// outcome is tracked and a summary (with up to 50 example errors) comes
// back so the person can see what needs fixing.
router.post('/import', asyncHandler(async (req, res) => {
  const companyId = req.user.company_id;
  const rows = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rows.length === 0) return res.status(400).json({ error: 'No rows to import.' });
  if (rows.length > 20000) return res.status(400).json({ error: 'That file has too many rows (max 20,000 per import).' });

  // Cache department name -> id lookups so a file with 3,000 rows in 8
  // departments only does 8 lookups (plus any first-time creates), not 3,000.
  const categoryCache = new Map();
  async function resolveCategoryId(nameRaw) {
    const name = String(nameRaw || '').trim();
    if (!name) return null;
    const key = name.toLowerCase();
    if (categoryCache.has(key)) return categoryCache.get(key);
    let cat = await db.prepare('SELECT * FROM categories WHERE company_id = ? AND LOWER(name) = LOWER(?)').get(companyId, name);
    if (!cat) {
      try {
        const info = await db.prepare('INSERT INTO categories (company_id, name) VALUES (?, ?)').run(companyId, name);
        cat = { id: info.lastInsertRowid };
      } catch (err) {
        // An earlier row created it with different casing in between our
        // SELECT and INSERT -- just look it up again rather than fail the row.
        cat = await db.prepare('SELECT * FROM categories WHERE company_id = ? AND LOWER(name) = LOWER(?)').get(companyId, name);
      }
    }
    categoryCache.set(key, cat.id);
    return cat.id;
  }

  const num = (v) => (v !== undefined && v !== null && v !== '' ? Number(v) || 0 : 0);
  let created = 0;
  let updated = 0;
  const errors = [];

  // Item Number assignment for new rows, computed once up front and then
  // tracked in memory -- calling nextItemNumber() per row would mean a
  // query for every single line of a multi-thousand-row import. Numbers
  // freed by deleted items are reused first (smallest gap up), same as a
  // single Add Item would get.
  const usedItemNumbers = new Set(
    (await db.prepare(`SELECT item_number FROM products WHERE company_id = ? AND item_number ~ '^[0-9]+$'`).all(companyId)).map((r) => Number(r.item_number))
  );
  let itemNumCursor = 1;
  function nextFreeItemNumber() {
    while (usedItemNumbers.has(itemNumCursor)) itemNumCursor += 1;
    usedItemNumbers.add(itemNumCursor);
    return String(itemNumCursor).padStart(6, '0');
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const rowNum = i + 1;
    const name = String(row.name || '').trim();
    const priceRaw = row.price;
    const price = priceRaw !== undefined && priceRaw !== null && priceRaw !== '' ? Number(priceRaw) : NaN;

    if (!name) { errors.push({ row: rowNum, error: 'Missing item name.' }); continue; }
    if (Number.isNaN(price)) { errors.push({ row: rowNum, name, error: 'Missing or invalid price.' }); continue; }

    try {
      const category_id = await resolveCategoryId(row.category);
      const sku = row.sku ? String(row.sku).trim() : null;
      const barcode = row.barcode ? String(row.barcode).trim() : null;
      const cost = num(row.cost);
      const order_cost = num(row.order_cost);
      const qty_on_hand = num(row.qty_on_hand);
      const reorder_level = num(row.reorder_level);

      const existing = sku ? await db.prepare('SELECT id FROM products WHERE company_id = ? AND sku = ?').get(companyId, sku) : null;

      if (existing) {
        await db.prepare(
          `UPDATE products SET name=?, barcode=?, category_id=?, price=?, cost=?, order_cost=?, qty_on_hand=?, reorder_level=?, active=1, updated_at=now()
           WHERE id=? AND company_id=?`
        ).run(name, barcode, category_id, price, cost, order_cost, qty_on_hand, reorder_level, existing.id, companyId);
        updated++;
      } else {
        const item_number = nextFreeItemNumber();
        await db.prepare(
          `INSERT INTO products (company_id, sku, barcode, name, category_id, price, cost, order_cost, qty_on_hand, reorder_level, item_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(companyId, sku, barcode, name, category_id, price, cost, order_cost, qty_on_hand, reorder_level, item_number);
        created++;
      }
    } catch (err) {
      errors.push({ row: rowNum, name, error: err.message });
    }
  }

  res.status(200).json({ ok: true, created, updated, skipped: errors.length, errors: errors.slice(0, 50) });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!existing) return res.status(404).json({ error: 'Product not found.' });
  const merged = { ...existing, ...req.body };
  await db.prepare(
    `UPDATE products SET sku=?, barcode=?, name=?, category_id=?, price=?, cost=?, order_cost=?, qty_on_hand=?, reorder_level=?,
     updated_at=now() WHERE id=? AND company_id=?`
  ).run(
    merged.sku,
    merged.barcode,
    merged.name,
    merged.category_id,
    merged.price,
    merged.cost,
    merged.order_cost,
    merged.qty_on_hand,
    merged.reorder_level,
    req.params.id,
    req.user.company_id
  );
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  // Clear item_number on delete so it's freed up for reuse -- the unique
  // index only enforces uniqueness among non-null values, so nulling it
  // here is what lets nextItemNumber() hand this number to the next new item.
  await db.prepare(`UPDATE products SET active=0, item_number=NULL, updated_at=now() WHERE id=? AND company_id=?`).run(req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

module.exports = router;
