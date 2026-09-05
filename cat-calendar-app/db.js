const { Pool } = require('pg');

// Vercel injects this automatically once a Postgres database is created and
// linked to the project (Storage tab). DATABASE_URL is accepted too, since
// that's the name some Postgres integrations (including Neon, which now
// backs Vercel's own Postgres offering) use instead.
const connectionString =
  process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL;

if (!connectionString) {
  throw new Error(
    'No Postgres connection string found. Set POSTGRES_URL (or DATABASE_URL) in your environment — ' +
      'on Vercel this is set automatically once you create/link a Postgres database to this project ' +
      '(Storage tab -> Create Database). For local development, run a local Postgres and set it in .env.'
  );
}

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const pool = new Pool({
  connectionString,
  // Serverless Postgres providers (Neon, etc.) require TLS; rejectUnauthorized:false
  // is the standard pragmatic default for these since serverless functions don't
  // reliably ship every intermediate CA. Skip TLS entirely for local dev.
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// better-sqlite3 (the previous engine here) used `?` placeholders and exposed
// synchronous .get()/.all()/.run(); this shim keeps that call shape — just
// async now, as any real network database requires — so the rest of the app
// didn't need a full query-by-query rewrite. `?` placeholders are converted
// to Postgres's positional $1/$2/... form.
function toPositional(query) {
  let i = 0;
  return query.replace(/\?/g, () => `$${++i}`);
}

async function run(query, params = []) {
  const result = await pool.query(toPositional(query), params);
  return { changes: result.rowCount, rows: result.rows };
}

async function get(query, params = []) {
  const result = await pool.query(toPositional(query), params);
  return result.rows[0];
}

async function all(query, params = []) {
  const result = await pool.query(toPositional(query), params);
  return result.rows;
}

const DDL = `
CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'voting',        -- voting | completed
  sealed_at TEXT NOT NULL,
  voting_ends_at TEXT NOT NULL,
  winner_submission_id INTEGER
);

CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  cat_name TEXT NOT NULL,
  photo_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  group_id INTEGER,
  votes INTEGER NOT NULL DEFAULT 0,
  notified_entry INTEGER NOT NULL DEFAULT 0,
  notified_result INTEGER NOT NULL DEFAULT 0,
  photo_rights_consent_at TEXT,
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_usd REAL NOT NULL,
  stripe_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  review_requested_at TEXT,
  shipping_address TEXT               -- JSON from Stripe's shipping_details; nothing to print/ship without it
);

-- Emails that have opted out of Whiskr mail (CAN-SPAM unsubscribe requests).
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Custom cat/dog print-on-demand orders: a customer's own photo + a product
-- from products.js, fulfilled through Printful (see printful.js). Separate
-- from "orders" (which is always tied to a contest calendar group) because
-- these aren't tied to any group.
CREATE TABLE IF NOT EXISTS custom_orders (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  product_id TEXT NOT NULL,
  species TEXT NOT NULL,             -- cat | dog
  pet_name TEXT,
  photo_path TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount_usd REAL NOT NULL,
  stripe_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | submitted_to_printful | failed
  printful_order_id TEXT,
  photo_rights_consent_at TEXT,
  created_at TEXT NOT NULL,
  review_requested_at TEXT,
  shipping_address TEXT               -- JSON from Stripe's shipping_details; required before Printful can ship
);

-- Reviews are only ever created against a real, paid order (calendar or
-- custom-product) via a signed link emailed after fulfillment — see
-- reviewLink.js and mailer.sendReviewRequest. There is no seed/fake data:
-- an empty table is the correct starting state, and the homepage shows an
-- honest empty state until real ones land. "approved" gates public display
-- so the owner can moderate (spam, abuse) before anything goes live.
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  order_type TEXT NOT NULL,          -- calendar | custom
  order_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  rating INTEGER NOT NULL,           -- 1-5
  body TEXT NOT NULL,
  display_name TEXT,
  photo_path TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(order_type, order_id)
);
`;

// Runs once per warm serverless instance (or once at local startup) — see
// the ensureDbReady middleware in server.js, which awaits this before
// handling any request. IF NOT EXISTS makes repeat calls (e.g. a second
// cold start) safe and cheap.
let initialized = null;
function initDb() {
  if (!initialized) {
    initialized = pool.query(DDL).catch((err) => {
      initialized = null; // allow retry on next request if this failed
      throw err;
    });
  }
  return initialized;
}

// Runs fn with a dedicated client wrapped in BEGIN/COMMIT (ROLLBACK on
// throw). fn receives a {get,all,run} bound to that same client/transaction,
// same shape as the module-level exports.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txDb = {
      get: async (q, p = []) => (await client.query(toPositional(q), p)).rows[0],
      all: async (q, p = []) => (await client.query(toPositional(q), p)).rows,
      run: async (q, p = []) => {
        const r = await client.query(toPositional(q), p);
        return { changes: r.rowCount, rows: r.rows };
      },
    };
    const result = await fn(txDb);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { get, all, run, initDb, transaction, pool };
