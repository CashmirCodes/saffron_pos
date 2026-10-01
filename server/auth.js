const jwt = require('jsonwebtoken');
const { db, hashPassword, verifyPassword, slugify } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user, company) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      company_id: company.id,
      company_code: company.code,
      company_name: company.name
    },
    SECRET,
    { expiresIn: '12h' }
  );
}

function publicUser(user, company) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    full_name: user.full_name,
    company: { id: company.id, code: company.code, name: company.name }
  };
}

async function login(req, res) {
  const { company_code, username, password } = req.body || {};
  if (!company_code || !username || !password) {
    return res.status(400).json({ error: 'Company code, username, and password are required.' });
  }

  const company = await db.prepare('SELECT * FROM companies WHERE code = ?').get(company_code.toLowerCase().trim());
  if (!company) {
    return res.status(401).json({ error: 'We could not find a company with that code.' });
  }

  if (Number(company.active) !== 1) {
    return res.status(403).json({ error: "This company's account is paused. Please contact Saffron support.", code: 'company_paused' });
  }

  const user = await db
    .prepare('SELECT * FROM users WHERE company_id = ? AND username = ? AND active = 1')
    .get(company.id, username);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  res.json({ token: signToken(user, company), user: publicUser(user, company) });
}

// Company codes that can never be taken by a customer (the platform admin's
// own login code is added at runtime -- see platform.js).
const reservedCodes = new Set(['admin', 'platform', 'saffron']);
function reserveCompanyCode(code) {
  if (code) reservedCodes.add(String(code).toLowerCase());
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Creates a brand new company plus its first admin user. Shared by public
// sign-up (registerCompany below) and the platform admin console.
async function createCompanyWithAdmin({ company_name, company_code, admin_username, admin_password, admin_full_name }) {
  if (!company_name || !admin_username || !admin_password) {
    throw new HttpError(400, 'Company name, admin username, and admin password are required.');
  }

  const code = (company_code ? slugify(company_code) : slugify(company_name));
  if (reservedCodes.has(code)) {
    throw new HttpError(400, `Company code "${code}" is reserved -- try a different one.`);
  }

  const existing = await db.prepare('SELECT id FROM companies WHERE code = ?').get(code);
  if (existing) {
    throw new HttpError(400, `Company code "${code}" is already taken -- try a different one.`);
  }

  const tx = db.transaction(async (txdb) => {
    const companyInfo = await txdb.prepare('INSERT INTO companies (code, name) VALUES (?, ?)').run(code, company_name);
    const companyId = companyInfo.lastInsertRowid;

    const userInfo = await txdb
      .prepare('INSERT INTO users (company_id, username, password, full_name, role) VALUES (?, ?, ?, ?, ?)')
      .run(companyId, admin_username, hashPassword(admin_password), admin_full_name || admin_username, 'admin');

    await txdb
      .prepare('INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT (company_id, key) DO UPDATE SET value = excluded.value')
      .run(companyId, 'store_name', company_name);
    await txdb
      .prepare('INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT (company_id, key) DO UPDATE SET value = excluded.value')
      .run(companyId, 'tax_rate', '0.0');

    const company = await txdb.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    const user = await txdb.prepare('SELECT * FROM users WHERE id = ?').get(userInfo.lastInsertRowid);
    return { company, user };
  });

  try {
    return await tx();
  } catch (err) {
    throw new HttpError(400, 'Could not create that company -- the username or company code may already be taken.');
  }
}

// Public self sign-up. Set ALLOW_SELF_SIGNUP=false to close it and onboard
// companies only from the platform admin console.
async function registerCompany(req, res) {
  if (String(process.env.ALLOW_SELF_SIGNUP).toLowerCase() === 'false') {
    return res.status(403).json({ error: 'New companies are set up by Saffron -- please contact us to get started.' });
  }
  try {
    const { company, user } = await createCompanyWithAdmin(req.body || {});
    res.status(201).json({ token: signToken(user, company), user: publicUser(user, company) });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}

// Whether a company is allowed in right now. Cached briefly so this isn't an
// extra query on every request; pausing/resuming from the platform console
// clears the entry (forgetCompanyStatus) so it takes effect immediately.
const companyStatusCache = new Map(); // company id -> { active, at }
const COMPANY_STATUS_TTL_MS = 15000;
async function companyIsActive(companyId) {
  const hit = companyStatusCache.get(companyId);
  if (hit && Date.now() - hit.at < COMPANY_STATUS_TTL_MS) return hit.active;
  const row = await db.prepare('SELECT active FROM companies WHERE id = ?').get(companyId);
  const active = !!row && Number(row.active) === 1;
  companyStatusCache.set(companyId, { active, at: Date.now() });
  return active;
}
function forgetCompanyStatus(companyId) {
  companyStatusCache.delete(Number(companyId));
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please log in again.' });
  }
  if (payload.platform) {
    return res.status(403).json({ error: 'Platform accounts manage companies from the platform console.' });
  }
  req.user = payload;
  companyIsActive(payload.company_id).then((active) => {
    if (!active) {
      return res.status(403).json({ error: "This company's account is paused. Please contact Saffron support.", code: 'company_paused' });
    }
    next();
  }).catch(next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

module.exports = { SECRET, HttpError, login, registerCompany, createCompanyWithAdmin, reserveCompanyCode, forgetCompanyStatus, requireAuth, requireRole, hashPassword };
