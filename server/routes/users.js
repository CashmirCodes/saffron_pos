const express = require('express');
const { db } = require('../db');
const { hashPassword } = require('../auth');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// List employees (no password hashes returned) -- scoped to the caller's company
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db
    .prepare('SELECT id, username, full_name, role, active, updated_at FROM users WHERE company_id = ? ORDER BY full_name')
    .all(req.user.company_id);
  res.json(rows);
}));

// Create employee (admin only, enforced in index.js route mount)
router.post('/', asyncHandler(async (req, res) => {
  const { username, password, full_name, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const info = await db
      .prepare('INSERT INTO users (company_id, username, password, full_name, role) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.company_id, username, hashPassword(password), full_name || username, role || 'cashier');
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: 'That username is already taken in this company.' });
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { full_name, role, active, password } = req.body || {};
  const existing = await db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!existing) return res.status(404).json({ error: 'Employee not found.' });

  const updated = {
    full_name: full_name ?? existing.full_name,
    role: role ?? existing.role,
    active: active ?? existing.active,
    password: password ? hashPassword(password) : existing.password
  };

  await db.prepare(
    `UPDATE users SET full_name = ?, role = ?, active = ?, password = ?, updated_at = now() WHERE id = ? AND company_id = ?`
  ).run(updated.full_name, updated.role, updated.active, updated.password, req.params.id, req.user.company_id);

  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!existing) return res.status(404).json({ error: 'Employee not found.' });

  if (existing.role === 'admin' && existing.active) {
    const otherAdmins = await db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE company_id = ? AND role = 'admin' AND active = 1 AND id != ?")
      .get(req.user.company_id, req.params.id);
    if (Number(otherAdmins.count) === 0) {
      return res.status(400).json({ error: "Can't remove the last admin for this company. Make another employee an admin first." });
    }
  }

  await db.prepare('UPDATE users SET active = 0, updated_at = now() WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
  res.json({ ok: true });
}));

module.exports = router;
