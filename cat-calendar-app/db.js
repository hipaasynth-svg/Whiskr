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
  created_at TEXT NOT NULL
);

-- Emails that have opted out of Whisker & Ribbon mail (CAN-SPAM unsubscribe requests).
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`);

module.exports = db;
