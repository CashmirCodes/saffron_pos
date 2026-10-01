require('dotenv').config();
const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');

const { db, ready: dbReady } = require('./db'); // resolves once the DB is loaded + default admin user seeded

const { login, registerCompany, requireAuth, requireRole } = require('./auth');
const platform = require('./platform');
const asyncHandler = require('./asyncHandler');
const productsRoutes = require('./routes/products');
const customersRoutes = require('./routes/customers');
const salesRoutes = require('./routes/sales');
const reportsRoutes = require('./routes/reports');
const usersRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const heldSalesRoutes = require('./routes/heldSales');
const heldDocumentsRoutes = require('./routes/heldDocuments');
const vendorsRoutes = require('./routes/vendors');
const purchaseOrdersRoutes = require('./routes/purchaseOrders');
const receivingRoutes = require('./routes/receiving');
const timeClockRoutes = require('./routes/timeClock');
const rewardsRoutes = require('./routes/rewards');
const eodRoutes = require('./routes/eod');
const physicalInventoryRoutes = require('./routes/physicalInventory');
const platformRoutes = require('./routes/platform');

const app = express();
// Behind a host's proxy (Render, etc.) this makes req.ip the real client address,
// which the platform sign-in lockout relies on.
app.set('trust proxy', 1);
app.use(cors());
// Bumped from Express's 100kb default -- a bulk Item List import (see
// POST /api/products/import) can legitimately be a few thousand rows.
app.use(express.json({ limit: '15mb' }));

// ---- Public ----
// The platform admin's sign-in is checked first; every other company code falls through to the normal login.
app.post('/api/auth/login', platform.loginInterceptor, asyncHandler(login));
app.post('/api/auth/register-company', asyncHandler(registerCompany));

// ---- Platform admin console API (platform token only) ----
app.use('/api/platform', platform.requirePlatform, platformRoutes);

// ---- Everything below requires a logged-in company user ----
app.use('/api', requireAuth);
app.use('/api/products', productsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/settings', settingsRoutes);
// Lightweight team lookup (id + name only, active employees) for pickers
// like the Sale screen's Associate dropdown -- anyone logged in can see
// who their coworkers are without needing the full admin-only Employees CRUD.
app.get('/api/users/team', asyncHandler(async (req, res) => {
  const rows = await db
    .prepare('SELECT id, full_name FROM users WHERE company_id = ? AND active = 1 ORDER BY full_name')
    .all(req.user.company_id);
  res.json(rows);
}));
app.use('/api/users', requireRole('admin'), usersRoutes);
app.use('/api/held-sales', heldSalesRoutes);
app.use('/api/held-documents', heldDocumentsRoutes);
app.use('/api/vendors', vendorsRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/receiving', receivingRoutes);
app.use('/api/time-clock', timeClockRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/eod', eodRoutes);
app.use('/api/physical-inventory', physicalInventoryRoutes);

app.get('/api/me', (req, res) => res.json(req.user));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Error handler (catches anything asyncHandler forwards) ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3000;

dbReady.then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const addresses = [];
    for (const iface of Object.values(nets)) {
      for (const net of iface || []) {
        if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
      }
    }
    console.log('\nSaffron POS is running!');
    if (!platform.isEnabled()) console.log(`  (Platform admin is off: ${platform.disabledReason()}.)`);
    else console.log(`  Platform admin is on -- sign in with company code "${platform.PLATFORM_CODE}".`);
    console.log(`  On this computer:  http://localhost:${PORT}`);
    addresses.forEach((addr) => console.log(`  On your network:   http://${addr}:${PORT}  (use this on phones/tablets)`));
    console.log('');
  });
}).catch((err) => {
  console.error('Failed to start: could not initialize the database.', err);
  process.exit(1);
});
