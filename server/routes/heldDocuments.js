const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Generic "park this and come back to it later" store used by Purchase
// Orders ("Hold PO") and Receive Items ("Hold Voucher") -- lets someone step
// out to Item List to add a new item (or just get pulled away) without
// losing whatever they'd already entered. `doc_type` keeps the two kinds
// separate ('po' | 'receiving'); `payload` is just whatever shape that
// screen needs to rebuild itself (lines, vendor_id, discount/freight/fee...).

router.get('/', asyncHandler(async (req, res) => {
  const { type } = req.query;
  let sql = `SELECT h.*, u.full_name AS held_by FROM held_documents h
             LEFT JOIN users u ON u.id = h.user_id
             WHERE h.company_id = ?`;
  const params = [req.user.company_id];
  if (type) { sql += ' AND h.doc_type = ?'; params.push(type); }
  sql += ' ORDER BY h.created_at DESC';
  const rows = await db.prepare(sql).all(...params);
  res.json(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload_json) })));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { doc_type, label, payload } = req.body || {};
  if (!doc_type) return res.status(400).json({ error: 'doc_type is required.' });
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Nothing to hold.' });
  const info = await db
    .prepare('INSERT INTO held_documents (company_id, doc_type, label, payload_json, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.company_id, doc_type, label || null, JSON.stringify(payload), req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM held_documents WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

module.exports = router;
