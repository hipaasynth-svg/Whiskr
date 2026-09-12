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

-- One open-entry, real-public-vote contest per period (e.g. a month). A
-- contest gets exactly one groups row once it closes, holding the top
-- CONTEST_WINNERS_COUNT vote-getters — that reuses the existing calendar
-- checkout/Stripe/PDF/email pipeline unchanged for the shared calendar
-- product; only entry, voting, and per-entrant ranking are new. Declared
-- before submissions since submissions.contest_id references it.
CREATE TABLE IF NOT EXISTS contests (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | completed
  group_id INTEGER REFERENCES groups(id),
  created_at TEXT NOT NULL
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
-- Open, high-volume public-voting contest (replaces the old seal-at-12
-- flow): every entrant attaches to a contest_id, accumulates real votes,
-- and gets a final_rank when the contest closes — 1..N for every entrant,
-- not just the top 12, so a non-winner can be told "you placed #47."
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS contest_id INTEGER REFERENCES contests(id);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS vote_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS final_rank INTEGER;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS disqualified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS disqualified_reason TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS notified_rank INTEGER NOT NULL DEFAULT 0;
-- Live-rank drop alerts (see sendRankDropAlerts in server.js): the last
-- rank an entrant was actually emailed about, so the daily check only fires
-- again once their position has genuinely moved, not every single day.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS last_notified_rank INTEGER;
-- Print-quality visibility, not a hard block — a business would rather
-- sell a slightly soft print than lose the sale outright, but wants to
-- warn the customer (and itself) before checkout. See checkImageQuality
-- in server.js.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS photo_width INTEGER;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS photo_height INTEGER;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS low_resolution INTEGER NOT NULL DEFAULT 0;
-- A pre-composited "vote for me" image (photo + name + vote link, see
-- generateShareCard in server.js) generated once at entry time so sharing
-- is a real image an entrant can post, not just a bare link. Nullable —
-- generation failure never blocks an entry.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS share_image_path TEXT;
-- sha256(ip + salt), never the raw IP — same anti-fraud pattern as
-- votes.ip_hash below, used to rate-limit entries per connection per day
-- (see SUBMISSION_LIMIT_PER_IP_PER_DAY in server.js). Nullable so existing
-- rows from before this column existed don't need a backfill.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS ip_hash TEXT;

-- One row per (submission, voter) so a browser/cookie identity can't vote
-- for the same cat twice — the UNIQUE constraint is the real enforcement,
-- not just an application-level check. ip_hash is sha256(ip + salt), never
-- the raw IP, so this table isn't itself a store of visitors' real IPs.
CREATE TABLE IF NOT EXISTS votes (
  id SERIAL PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  voter_token TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(submission_id, voter_token)
);
CREATE INDEX IF NOT EXISTS votes_ip_hash_created_idx ON votes(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS votes_voter_token_created_idx ON votes(voter_token, created_at);

-- "Cat of the Year" award: a separate public vote among monthly
-- Cat-of-the-Month winners for the one physical grand prize (a one-of-a-kind
-- 11x16 acrylic painting of the winning cat, hand-painted by Cody Carlson —
-- table/column names below kept as "sculpture"/"year" for continuity with
-- existing routes and the sitemap; only the prize medium changed). Runs
-- roughly monthly now (previously annual) — still admin-opened and
-- admin-closed (see /api/admin/year-award/* in server.js), never
-- cron-automated, so the owner controls pacing and finalist-pool size
-- directly rather than a fixed interval forcing a near-empty vote. Kept
-- deliberately separate from the monthly contests/submissions/votes tables
-- rather than reusing them, since the voting rule is different (one ballot
-- per person for the whole award, not repeatable daily voting over 30 days).
CREATE TABLE IF NOT EXISTS year_awards (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | completed
  winner_submission_id INTEGER REFERENCES submissions(id),
  sculpture_deadline TEXT,               -- the delivery commitment for this cycle's winner
  created_at TEXT NOT NULL
);
-- One row per (year_award, that year's Cat-of-the-Month winner) — the
-- finalist ballot. Auto-populated from the groups table when an admin
-- opens an award (see the /api/admin/year-award/open handler).
CREATE TABLE IF NOT EXISTS year_award_finalists (
  id SERIAL PRIMARY KEY,
  year_award_id INTEGER NOT NULL REFERENCES year_awards(id),
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  vote_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(year_award_id, submission_id)
);
-- UNIQUE is on (year_award_id, voter_token), not (finalist_id,
-- voter_token) — this is a single ballot ("pick your one favorite of this
-- year's winners"), so a voter_token can only ever have one row per award,
-- never one per finalist the way monthly votes work.
CREATE TABLE IF NOT EXISTS year_award_votes (
  id SERIAL PRIMARY KEY,
  year_award_id INTEGER NOT NULL REFERENCES year_awards(id),
  finalist_id INTEGER NOT NULL REFERENCES year_award_finalists(id),
  voter_token TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(year_award_id, voter_token)
);
CREATE INDEX IF NOT EXISTS year_award_votes_ip_hash_idx ON year_award_votes(year_award_id, ip_hash);

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
ALTER TABLE orders ADD COLUMN IF NOT EXISTS utm_campaign TEXT;

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
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | submitted_to_printful | failed | refunded | disputed
  printful_order_id TEXT,
  photo_rights_consent_at TEXT,
  created_at TEXT NOT NULL,
  review_requested_at TEXT,
  shipping_address TEXT               -- JSON from Stripe's shipping_details; required before Printful can ship
);
ALTER TABLE custom_orders ADD COLUMN IF NOT EXISTS photo_width INTEGER;
ALTER TABLE custom_orders ADD COLUMN IF NOT EXISTS photo_height INTEGER;
ALTER TABLE custom_orders ADD COLUMN IF NOT EXISTS low_resolution INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_orders ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_orders ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
-- Same anti-fraud pattern as submissions.ip_hash/votes.ip_hash — rate-limits
-- custom orders per connection per day (see CUSTOM_ORDER_LIMIT_PER_IP_PER_DAY
-- in server.js). Nullable so pre-existing rows don't need a backfill.
ALTER TABLE custom_orders ADD COLUMN IF NOT EXISTS ip_hash TEXT;
-- Printful variant ID chosen at order time for products that don't have one
-- fixed variant in products.js (currently just phone-case, sized per exact
-- device — see phoneCases.js). NULL for every other product, which falls
-- back to its products.js printfulVariantId at fulfillment time.
ALTER TABLE custom_orders ADD COLUMN IF NOT EXISTS variant_id TEXT;

-- Which ad campaign/geo a contest entry's first visit came from (captured
-- client-side from a ?utm_campaign= link into a cookie, see script.js) —
-- lets the marketing ledger below attribute a later paid order back to
-- whatever brought that visitor in, even if the order itself doesn't carry
-- its own utm param (e.g. they entered from an ad, then bought a print
-- days later from the same browser).
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS utm_campaign TEXT;

-- Lightweight marketing/ad-spend ledger — the real, non-automated version
-- of the "Sentinel" ad-spend/ROAS engine the owner referenced: no live ad
-- platform API integration (nothing here can pause a real campaign), just
-- honest tracking so a human can compute ROAS per named campaign/geo and
-- decide manually. Supports multiple concurrent named campaigns/geos —
-- name is whatever value you put in your ad URLs' ?utm_campaign= param
-- and is matched case-insensitively against orders/custom_orders/
-- submissions' utm_campaign column when computing revenue (see
-- /api/admin/marketing/campaigns in server.js).
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  platform TEXT,                     -- free text: meta, google, tiktok, organic, etc.
  status TEXT NOT NULL DEFAULT 'active',  -- active | paused (a note to yourself, not a live toggle)
  notes TEXT,
  created_at TEXT NOT NULL
);
-- Set once a campaign's name is matched against a real Meta campaign (see
-- syncMetaAdSpend in server.js) so later syncs look it up by id instead of
-- re-matching by name — a rename in Meta's own UI afterward doesn't break
-- the link. NULL means never matched (no META_ACCESS_TOKEN configured
-- yet, or no Meta campaign has this name).
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS meta_campaign_id TEXT;
-- Throttles the ROAS-below-threshold alert email (see checkRoasAlerts in
-- server.js) so a campaign that stays bad doesn't re-email every single
-- day — see ROAS_ALERT_COOLDOWN_DAYS.
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS last_roas_alert_at TEXT;

-- One row per day/amount of spend logged against a campaign. source
-- distinguishes a human's manual entry (from the admin form, reading
-- their ad platform's own dashboard) from an automatic pull via the Meta
-- Marketing API (syncMetaAdSpend) — kept in the same table since both are
-- just "spend, on this campaign, on this day," but never mixed silently:
-- the partial unique index below lets an automatic sync safely upsert
-- (re-running it for a day it already synced updates that day's number
-- instead of double-counting) without ever touching a manual entry.
CREATE TABLE IF NOT EXISTS ad_spend_entries (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id),
  spend_date TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE ad_spend_entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
CREATE UNIQUE INDEX IF NOT EXISTS ad_spend_entries_auto_unique
  ON ad_spend_entries(campaign_id, spend_date) WHERE source = 'meta_api';

-- Admin-managed hero background photos. Empty table = no slideshow, just
-- the plain dark hero background — never a placeholder/stock-photo
-- slideshow. Add photos in admin.html to turn it on.
CREATE TABLE IF NOT EXISTS background_slides (
  id SERIAL PRIMARY KEY,
  image_path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Admin-managed showcase of a couple of Cody Carlson's completed grand-
-- prize originals — "a couple to choose from," not a shop: there's no
-- checkout here, just photos plus a CTA linking out to codycarlson.art
-- for real commissions/pricing (that stays entirely on his own site — see
-- the "Skip the wait" section in index.html). Empty table = an honest
-- "first one's still drying" state, same never-fake-a-placeholder rule
-- background_slides and reviews already follow.
CREATE TABLE IF NOT EXISTS featured_originals (
  id SERIAL PRIMARY KEY,
  image_path TEXT NOT NULL,
  cat_name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Admin-managed catalog photo + copy for a product in products.js, keyed by
-- that product's fixed id (not a SERIAL — the row set is bounded by the
-- real catalog, not freely created). A product with no row here yet, or one
-- with image_path still NULL, just renders text-only on the site — same
-- honest-empty-state rule as everywhere else, never a placeholder image.
-- image_alt/seo_title/seo_description/description_override are each NULL
-- until the owner sets them, and every read falls back to the products.js
-- default (name/description) rather than showing an empty string.
CREATE TABLE IF NOT EXISTS product_media (
  product_id TEXT PRIMARY KEY,
  image_path TEXT,
  image_alt TEXT,
  seo_title TEXT,
  seo_description TEXT,
  description_override TEXT,
  updated_at TEXT NOT NULL
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

-- Every alertAdmin() call (a paid order that failed to reach Printful, a
-- refund/dispute needing attention, etc.) also lands a row here, regardless
-- of whether ADMIN_EMAIL is even configured — so a real failure is always
-- visible in one place in admin.html, not just a maybe-sent email. Plain
-- append-only log; "resolved" lets the owner clear an item from the panel
-- once it's actually been dealt with, without deleting the history.
CREATE TABLE IF NOT EXISTS admin_alerts (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

-- Small admin-editable promo slots on the homepage — a starburst badge
-- over the hero, and two image+text blocks in the middle of the page.
-- One fixed row per slot ('starburst' | 'feature_1' | 'feature_2'),
-- upserted rather than freely created — same fixed-slot pattern as
-- product_media. Hidden on the public page whenever a slot's text and
-- image are both empty, same honest-empty-state rule as everywhere else.
CREATE TABLE IF NOT EXISTS site_blocks (
  slot TEXT PRIMARY KEY,
  text TEXT,
  image_path TEXT,
  color TEXT,
  updated_at TEXT NOT NULL
);

-- Admin-managed footer photo wall — a static (non-slideshow) grid of
-- photos spanning the full page width, two rows tall. Empty table = no
-- strip at all, same honest-empty-state rule as background_slides.
CREATE TABLE IF NOT EXISTS footer_strip_images (
  id SERIAL PRIMARY KEY,
  image_path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
