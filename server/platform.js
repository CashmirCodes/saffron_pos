// Platform admin: a single operator account (not tied to any company) that
// manages every company on this Saffron install -- add, pause, remove, and
// add admins to them. See routes/platform.js for the API and
// public/platform.html for the console.
//
// It is configured entirely from the environment, never from source:
//   PLATFORM_ADMIN_PASSWORD   required -- if unset, the platform account is off
//   PLATFORM_ADMIN_COMPANY    the "company code" typed at sign-in (default: admin-saffron)
//   PLATFORM_ADMIN_USER       the username (default: admin)
// It also refuses to run on the built-in development JWT secret, since anyone
// could forge a platform token with it -- set JWT_SECRET to a long random string.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { SECRET, reserveCompanyCode } = require('./auth');

const CODE = String(process.env.PLATFORM_ADMIN_COMPANY || 'admin-saffron').toLowerCase().trim();
const USERNAME = String(process.env.PLATFORM_ADMIN_USER || 'admin').trim();
const PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || '';
const TOKEN_LIFETIME = '4h';

// Customers can never register this code as a company of their own.
reserveCompanyCode(CODE);

let problem = null;
if (!PASSWORD) problem = 'PLATFORM_ADMIN_PASSWORD is not set';
else if (!process.env.JWT_SECRET) problem = 'JWT_SECRET is not set (the built-in development secret is not safe for this)';

function isEnabled() {
  return !problem;
}
function disabledReason() {
  return problem;
}

// Compare as fixed-length digests so neither length nor content leaks via timing.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Brute-force guard: after MAX_FAILURES wrong attempts from one address, that
// address is locked out for LOCKOUT_MS. In memory only -- resets on restart.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, lockedUntil }

function lockedFor(ip) {
  const f = failures.get(ip);
  if (!f || !f.lockedUntil) return 0;
  if (f.lockedUntil <= Date.now()) { failures.delete(ip); return 0; }
  return f.lockedUntil - Date.now();
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) f.lockedUntil = Date.now() + LOCKOUT_MS;
  failures.set(ip, f);
}

// Sits in front of the normal login. If the company code typed is the platform
// code, it handles the whole request (success or failure) -- the code is
// reserved, so it can never also be a real company. Anything else falls
// through to the regular company login untouched.
function loginInterceptor(req, res, next) {
  const { company_code, username, password } = req.body || {};
  if (!company_code || String(company_code).toLowerCase().trim() !== CODE) return next();

  if (!isEnabled()) {
    // Same message as an unknown company: don't advertise that a platform account exists.
    return res.status(401).json({ error: 'We could not find a company with that code.' });
  }

  const wait = lockedFor(req.ip);
  if (wait) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).` });
  }

  const ok = username && password && safeEqual(username, USERNAME) && safeEqual(password, PASSWORD);
  if (!ok) {
    recordFailure(req.ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  failures.delete(req.ip);
  const user = { id: 0, username: USERNAME, role: 'platform', full_name: 'Saffron Platform Admin', company: { id: 0, code: CODE, name: 'Saffron Platform' } };
  const token = jwt.sign({ platform: true, role: 'platform', username: USERNAME, full_name: user.full_name }, SECRET, { expiresIn: TOKEN_LIFETIME });
  res.json({ token, user, redirect: 'platform.html' });
}

// Guards /api/platform/*: only a valid platform token gets through.
function requirePlatform(req, res, next) {
  if (!isEnabled()) return res.status(404).json({ error: 'Not found.' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (!payload.platform) return res.status(403).json({ error: 'You do not have permission to do that.' });
    req.platform = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please log in again.' });
  }
}

module.exports = { isEnabled, disabledReason, loginInterceptor, requirePlatform, PLATFORM_CODE: CODE };
