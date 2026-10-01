// Database layer built on Postgres (via node-postgres / "pg"). The app is
// multi-tenant: one shared database serves many companies. Every business
// table is scoped by company_id so each company only ever sees its own data.
const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error(
    '\nMissing DATABASE_URL.\n' +
    'Copy .env.example to .env and set DATABASE_URL to your Postgres connection string\n' +
    '(a free one from Supabase or Neon works great). See the README for details.\n'
  );
  process.exit(1);
}

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makeDb(queryable) {
  return {
    prepare(rawSql) {
      const text = convertPlaceholders(rawSql);
      const isInsert = /^\s*insert/i.test(rawSql) && !/returning/i.test(rawSql) && !/on conflict/i.test(rawSql);
      const finalText = isInsert ? `${text} RETURNING id` : text;
      return {
        async get(...params) {
          const res = await queryable.query(text, params);
          return res.rows[0];
        },
        async all(...params) {
          const res = await queryable.query(text, params);
          return res.rows;
        },
        async run(...params) {
          const res = await queryable.query(finalText, params);
          return { changes: res.rowCount, lastInsertRowid: res.rows[0] ? res.rows[0].id : undefined };
        }
      };
    },
    async exec(sql) {
      await queryable.query(sql);
    }
  };
}

const db = makeDb(pool);

db.transaction = function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    const txDb = makeDb(client);
    try {
      await client.query('BEGIN');
      const result = await fn(txDb, ...args);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
};

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

async function getSetting(companyId, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE company_id = ? AND key = ?').get(companyId, key);
  return row ? row.value : fallback;
}

async function setSetting(companyId, key, value) {
  await db.prepare(
    'INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?) ON CONFLICT (company_id, key) DO UPDATE SET value = excluded.value'
  ).run(companyId, key, String(value));
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'company';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Platform admins can pause a company (active = 0): its people can no longer
-- sign in and any open session is cut off, but nothing is deleted.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'cashier',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, username)
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  sku TEXT,
  barcode TEXT,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  order_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  qty_on_hand DOUBLE PRECISION NOT NULL DEFAULT 0,
  reorder_level DOUBLE PRECISION NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku)
);

-- CREATE TABLE IF NOT EXISTS is a no-op on a database that already has this
-- table, so the order_cost column above only takes effect for brand-new
-- installs -- this ADD COLUMN IF NOT EXISTS is what actually brings it to
-- existing databases (there's no migration framework, so this is the
-- pattern for growing a column onto a table that may already exist).
ALTER TABLE products ADD COLUMN IF NOT EXISTS order_cost DOUBLE PRECISION NOT NULL DEFAULT 0;

-- System-assigned identifier (e.g. "000001"), auto-generated per company
-- when an item is created and never editable afterward -- this is what a
-- self-printed barcode tag will encode, distinct from a vendor-provided
-- SKU/barcode which may not exist for every item. Nullable at the column
-- level only so this ADD COLUMN succeeds instantly on an existing table;
-- the backfill below (and every insert going forward) always fills it in.
ALTER TABLE products ADD COLUMN IF NOT EXISTS item_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS products_company_item_number_idx
  ON products (company_id, item_number) WHERE item_number IS NOT NULL;

-- One-time cleanup: a deleted (inactive) item's number is meant to be freed
-- up for reuse by the next new item (see products.js nextItemNumber), which
-- only works if inactive rows don't hold onto a number. Clears any that
-- still do from before this behavior existed. Safe on every startup -- once
-- clean, this matches zero rows.
UPDATE products SET item_number = NULL WHERE active = 0 AND item_number IS NOT NULL;

-- One-time backfill: assign a sequential item_number to any ACTIVE product
-- that doesn't have one yet (existing installs upgrading to this column).
-- Inactive rows are intentionally skipped -- their number should stay free,
-- not get reassigned to themselves. Safe to run on every startup -- once
-- every active product has a number, the WHERE clauses below match zero rows.
DO $$
DECLARE
  comp RECORD;
  prod RECORD;
  counter INTEGER;
BEGIN
  FOR comp IN SELECT DISTINCT company_id FROM products WHERE item_number IS NULL AND active = 1 LOOP
    SELECT COALESCE(MAX(item_number::int), 0) INTO counter
      FROM products WHERE company_id = comp.company_id AND item_number ~ '^[0-9]+$';
    FOR prod IN SELECT id FROM products WHERE company_id = comp.company_id AND item_number IS NULL AND active = 1 ORDER BY id LOOP
      counter := counter + 1;
      UPDATE products SET item_number = LPAD(counter::text, 6, '0') WHERE id = prod.id;
    END LOOP;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  notes TEXT,
  loyalty_points DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  sale_number TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  -- The employee who gets referral credit for this sale, separate from
  -- user_id (whoever was logged in and actually rang it up).
  associate_id INTEGER REFERENCES users(id),
  subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount DOUBLE PRECISION NOT NULL DEFAULT 0,
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, sale_number)
);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS associate_id INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  line_total DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (company_id, key)
);

-- Held sales: a cart put on hold mid-ring-up. If customer_id is set, it also
-- doubles as a "Customer Order" (an order placed for a specific customer to
-- come back to later).
CREATE TABLE IF NOT EXISTS held_sales (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  customer_id INTEGER REFERENCES customers(id),
  associate_id INTEGER REFERENCES users(id),
  user_id INTEGER REFERENCES users(id),
  label TEXT,
  cart_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE held_sales ADD COLUMN IF NOT EXISTS associate_id INTEGER REFERENCES users(id);

-- Generic "hold and resume later" store for Purchase Orders ("Hold PO") and
-- Receive Items ("Hold Voucher") -- see server/routes/heldDocuments.js.
CREATE TABLE IF NOT EXISTS held_documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  doc_type TEXT NOT NULL,
  label TEXT,
  payload_json TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  po_number TEXT NOT NULL,
  vendor_id INTEGER REFERENCES vendors(id),
  status TEXT NOT NULL DEFAULT 'ordered', -- 'ordered' | 'received' | 'cancelled'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ,
  UNIQUE (company_id, po_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  qty_ordered DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- Every time stock comes in -- whether from the quick "Receive Items" screen
-- or from receiving a purchase order -- we log it here for Receiving History.
CREATE TABLE IF NOT EXISTS stock_receipts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  product_id INTEGER REFERENCES products(id),
  po_id INTEGER REFERENCES purchase_orders(id),
  qty DOUBLE PRECISION NOT NULL,
  cost DOUBLE PRECISION,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_clock_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out TIMESTAMPTZ
);

-- One cash-drawer reconciliation record per business day: what the register
-- should have based on that day's completed sales (expected_cash/card_total),
-- vs. what was physically counted (counted_cash) and the resulting
-- over/short. Re-closing the same date updates the existing row instead of
-- creating a duplicate.
-- One row per item adjusted by a Physical Inventory count (Inventory >
-- Physical Inventory): what the system expected on hand, what was actually
-- counted, and the resulting difference -- an audit trail for shrinkage /
-- overage, mirroring how stock_receipts logs the receiving side.
CREATE TABLE IF NOT EXISTS physical_inventory_adjustments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  expected_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  counted_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  difference_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  price DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eod_closeouts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  business_date DATE NOT NULL,
  user_id INTEGER REFERENCES users(id),
  expected_cash DOUBLE PRECISION NOT NULL DEFAULT 0,
  counted_cash DOUBLE PRECISION NOT NULL DEFAULT 0,
  card_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  sale_count INTEGER NOT NULL DEFAULT 0,
  over_short DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, business_date)
);
`;

const ready = (async () => {
  await db.exec(SCHEMA);
  return db;
})();

module.exports = { db, ready, hashPassword, verifyPassword, getSetting, setSetting, slugify };
