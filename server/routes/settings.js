const express = require('express');
const { db } = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT key, value FROM settings WHERE company_id = ?').all(req.user.company_id);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
}));

router.put('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const companyId = req.user.company_id;
  const tx = db.transaction(async (txdb) => {
    for (const [key, value] of Object.entries(body)) {
      await txdb.prepare(
        'INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT (company_id, key) DO UPDATE SET value = excluded.value'
      ).run(companyId, key, String(value));
    }
  });
  await tx();
  res.json({ ok: true });
}));

module.exports = router;
