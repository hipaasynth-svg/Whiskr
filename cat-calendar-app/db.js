const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data', 'contest.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'voting',        -- voting | completed
  sealed_at TEXT NOT NULL,
  voting_ends_at TEXT NOT NULL,
  winner_submission_id INTEGER
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- Emails that have opted out of Whisker & Ribbon mail (CAN-SPAM unsubscribe requests).
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Custom cat/dog print-on-demand orders: a customer's own photo + a product
-- from products.js, fulfilled through Printful (see printful.js). Separate
-- from "orders" (which is always tied to a contest calendar group) because
-- these aren't tied to any group.
CREATE TABLE IF NOT EXISTS custom_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
`);

module.exports = db;
