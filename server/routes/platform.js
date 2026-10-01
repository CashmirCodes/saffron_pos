// Platform admin API -- mounted at /api/platform behind requirePlatform (see
// platform.js). Manages every company on this install.
const express = require('express');
const { db, hashPassword } = require('../db');
const { HttpError, createCompanyWithAdmin, forgetCompanyStatus } = require('../auth');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

const ROLES = ['admin', 'manager', 'cashier', 'salesman'];

async function findCompany(id) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

// Every company with a little activity so you can see who is actually using it.
router.get('/companies', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT c.id, c.code, c.name, c.active, c.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS user_count,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1 AND u.role = 'admin') AS admin_count,
      (SELECT COUNT(*) FROM sales s WHERE s.company_id = c.id) AS sale_count,
      (SELECT MAX(s.created_at) FROM sales s WHERE s.company_id = c.id) AS last_sale_at
    FROM companies c
    ORDER BY c.created_at DESC, c.id DESC
  `).all();
  res.json(rows.map((r) => ({
    ...r,
    active: Number(r.active) === 1,
    user_count: Number(r.user_count),
    admin_count: Number(r.admin_count),
    sale_count: Number(r.sale_count)
  })));
}));

// Add a company along with its first admin.
router.post('/companies', asyncHandler(async (req, res) => {
  try {
    const { company, user } = await createCompanyWithAdmin(req.body || {});
    res.status(201).json({
      company: { id: company.id, code: company.code, name: company.name, active: true },
      admin: { id: user.id, username: user.username, full_name: user.full_name }
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

// Rename and/or pause / resume. Pausing blocks sign-in and cuts off open
// sessions right away; nothing is deleted.
router.put('/companies/:id', asyncHandler(async (req, res) => {
  const company = await findCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found.' });

  const { name, active } = req.body || {};
  const newName = name !== undefined ? String(name).trim() : company.name;
  if (!newName) return res.status(400).json({ error: 'Company name can’t be empty.' });
  const newActive = active !== undefined ? (active ? 1 : 0) : Number(company.active);

  await db.prepare('UPDATE companies SET name = ?, active = ? WHERE id = ?').run(newName, newActive, company.id);
  forgetCompanyStatus(company.id);
  res.json({ ok: true });
}));

// Permanently remove a company and ALL of its data. The caller has to repeat
// the company code, so a stray click can't do it.
router.post('/companies/:id/delete', asyncHandler(async (req, res) => {
  const company = await findCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found.' });
  if (String((req.body || {}).confirm_code || '').toLowerCase().trim() !== company.code) {
    return res.status(400).json({ error: 'Type the company code exactly to confirm removal.' });
  }

  // Children before parents. Runs in one transaction: if any table was missed
  // the final DELETE fails on its foreign key and everything rolls back.
  const id = company.id;
  const wipe = db.transaction(async (tx) => {
    const run = (sql) => tx.prepare(sql).run(id);
    await run('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ?)');
    await run('DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = ?)');
    for (const table of [
      'stock_receipts', 'physical_inventory_adjustments', 'eod_closeouts', 'time_clock_entries',
      'held_sales', 'held_documents', 'sales', 'purchase_orders',
      'products', 'customers', 'vendors', 'categories', 'settings', 'users'
    ]) {
      await run(`DELETE FROM ${table} WHERE company_id = ?`);
    }
    await run('DELETE FROM companies WHERE id = ?');
  });
  await wipe();
  forgetCompanyStatus(id);
  res.json({ ok: true });
}));

// ---- People inside a company ----
router.get('/companies/:id/users', asyncHandler(async (req, res) => {
  const company = await findCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found.' });
  const rows = await db
    .prepare('SELECT id, username, full_name, role, active, updated_at FROM users WHERE company_id = ? ORDER BY (role = \'admin\') DESC, full_name')
    .all(company.id);
  res.json(rows.map((u) => ({ ...u, active: Number(u.active) === 1 })));
}));

// Add an admin (or any role) to a company.
router.post('/companies/:id/users', asyncHandler(async (req, res) => {
  const company = await findCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found.' });

  const { username, password, full_name } = req.body || {};
  const role = (req.body || {}).role || 'admin';
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });

  try {
    const info = await db
      .prepare('INSERT INTO users (company_id, username, password, full_name, role) VALUES (?, ?, ?, ?, ?)')
      .run(company.id, String(username).trim(), hashPassword(password), full_name || username, role);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: 'That username is already taken in this company.' });
  }
}));

// Reset a password, change a role, or switch someone off / on.
router.put('/companies/:id/users/:userId', asyncHandler(async (req, res) => {
  const existing = await db
    .prepare('SELECT * FROM users WHERE id = ? AND company_id = ?')
    .get(req.params.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Employee not found.' });

  const { full_name, role, active, password } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });

  await db.prepare(
    'UPDATE users SET full_name = ?, role = ?, active = ?, password = ?, updated_at = now() WHERE id = ? AND company_id = ?'
  ).run(
    full_name ?? existing.full_name,
    role ?? existing.role,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    password ? hashPassword(password) : existing.password,
    existing.id,
    existing.company_id
  );
  res.json({ ok: true });
}));

module.exports = router;
