require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { put: putBlob } = require('@vercel/blob');
// Random file names for uploads (Node's built-in; the uuid package isn't needed).
const uuid = () => crypto.randomUUID();

const sharp = require('sharp');

const db = require('./db');
const mailer = require('./mailer');
const unsubscribe = require('./unsubscribe');
const reviewLink = require('./reviewLink');
const discountToken = require('./discountToken');
const statusToken = require('./statusToken');
const claimToken = require('./claimToken');
const commissionPayToken = require('./commissionPayToken');
const productCatalog = require('./products');
const commissionPricing = require('./commissions');
const orderEconomics = require('./orderEconomics');
const printful = require('./printful');
const photoEnhance = require('./photoEnhance');
const phoneCases = require('./phoneCases');
const sweatshirtSizes = require('./sweatshirtSizes');
const metaAds = require('./metaAds');
const metaConversions = require('./metaConversions');
const seo = require('./seo');
const blog = require('./blog');

const app = express();

// Last line of defence for the whole process. Express 4 does not catch a
// rejection thrown out of an async route handler, so before this existed a
// single transient Postgres error inside a handler terminated the server —
// Node has aborted on unhandled rejections by default since v15. On a payment
// path that is the worst possible failure: every other request being served by
// that instance dies with it, and Stripe gets no reply to the webhook it was
// delivering. Log loudly and stay up; the route-level handlers decide the
// status code, and Stripe retries anything that did not get a 2xx.
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandled promise rejection — a handler is missing a catch:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
});
// Vercel (and most PaaS hosts) sit in front of this app as a reverse proxy —
// without trust proxy, req.ip is the proxy's own address for every request,
// which would make the vote rate-limiter below useless (every visitor looks
// like the same "IP").
app.set('trust proxy', true);
app.disable('x-powered-by');

const PORT = process.env.PORT || 3000;
// Rounds run by calendar month in Central time — see nextRoundWindow.
// (CONTEST_LENGTH_DAYS, a fixed 30-day length, was retired 2026-09-30.)
// CONTEST_WINNERS_COUNT is how many top vote-getters each round's internal
// results record groups together.
const CONTEST_WINNERS_COUNT = Number(process.env.CONTEST_WINNERS_COUNT || 12);
// Anti-fraud vote rate limits — generous enough for a real family sharing a
// link, tight enough to slow down a script or a bought-votes farm. Neither
// of these stops determined abuse alone; see requireCaptcha below and the
// admin fraud-review view for the rest of the defense.
const VOTE_LIMIT_PER_VOTER_PER_DAY = Number(process.env.VOTE_LIMIT_PER_VOTER_PER_DAY || 30);
const VOTE_LIMIT_PER_IP_PER_DAY = Number(process.env.VOTE_LIMIT_PER_IP_PER_DAY || 60);
// The two limits above are totals across every cat, so on their own they let
// one person clear cookies (or open a private window) and vote for the SAME
// cat ~60 times a day from one connection — about 1,800 votes over a round.
// This caps votes for any one cat from one connection for the whole round.
// Default 3, not 1, so a household sharing Wi-Fi can each vote once.
const VOTE_LIMIT_PER_IP_PER_CAT = Number(process.env.VOTE_LIMIT_PER_IP_PER_CAT || 3);
// Same anti-fraud shape as voting above, applied to the two endpoints that
// previously had no limit at all: a real cat owner never submits or orders
// this many times a day, but a script flooding fake entries or fake print
// orders can hit either endpoint as fast as it likes without this.
const SUBMISSION_LIMIT_PER_IP_PER_DAY = Number(process.env.SUBMISSION_LIMIT_PER_IP_PER_DAY || 5);
const CUSTOM_ORDER_LIMIT_PER_IP_PER_DAY = Number(process.env.CUSTOM_ORDER_LIMIT_PER_IP_PER_DAY || 10);
const SUBSCRIBE_LIMIT_PER_IP_PER_DAY = Number(process.env.SUBSCRIBE_LIMIT_PER_IP_PER_DAY || 10);
// Deliberately low: a commission is a four-figure booking that a human
// fulfils by hand, not a print. Someone opening five deposit sessions from
// one connection in a day is a mistake or an attack either way.
const COMMISSION_LIMIT_PER_IP_PER_DAY = Number(process.env.COMMISSION_LIMIT_PER_IP_PER_DAY || 4);

// ---- shipment tracking ----
// Days past a shipment's estimated delivery with no delivery scan before it
// is flagged for a Printful lost-in-transit claim. Printful's window is 30
// days from estimated delivery, so this leaves a wide margin to notice,
// confirm the address with the customer, and file.
const STALLED_DAYS_AFTER_ETA = Number(process.env.STALLED_DAYS_AFTER_ETA || 7);
// Orders refreshed per daily run. Bounded because this is a serverless
// function with a wall-clock limit and each order is one Printful API call.
const SHIPMENT_POLL_BATCH = Number(process.env.SHIPMENT_POLL_BATCH || 100);
// How far back the delivery poll looks for orders still awaiting delivery.
// Past this an unresolved parcel is beyond Printful's 30-day claim window, and
// keeping it in the rotation only crowds out orders that can still be saved.
const SHIPMENT_POLL_MAX_AGE_DAYS = Number(process.env.SHIPMENT_POLL_MAX_AGE_DAYS || 90);
// Days after DELIVERY before asking for a review. Previously the review
// clock ran from order creation, which is how a lost parcel still got a
// "how did we do?" email.
const REVIEW_DELAY_AFTER_DELIVERY_DAYS = Number(process.env.REVIEW_DELAY_AFTER_DELIVERY_DAYS || 3);
// Printful does not sign its webhooks (no signature is documented in their
// v2 API surface), so the endpoint is protected by an unguessable path
// segment instead, and every delivery is verified by re-fetching the order
// from Printful rather than trusting the posted body. Unset = endpoint off.
const PRINTFUL_WEBHOOK_TOKEN = process.env.PRINTFUL_WEBHOOK_TOKEN || '';
// Salts the IP hash stored in the votes table so raw IPs are never persisted.
// Set a real random value in production — the default is fine for local dev
// only, since anyone who knows it could pre-compute hashes for known IPs.
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'dev-only-insecure-salt';
// Post-entry / non-winner upsell discount. A percentage off, applied
// server-side to the custom-print line item — no Stripe Coupon object
// needed since checkout sessions here already build price_data inline.
//
// DEFAULT IS 0, on the owner's instruction (2026-09-28): no discounting.
// This used to default to 20%, and at 20% it broke the margin floor on
// every single product in the catalog — the mug fell to 32.0%, the
// sweatshirt to 25.5%. Prices are set to the floor, so any discount at all
// lands under it; `node orderEconomics.js` prints the largest discount the
// catalog can actually survive, and today that number is 0.
//
// Everything downstream already handles a zero percent: mailer.js renders
// no discount block for a falsy discount, and thanks.js only shows the
// badge when percent > 0. Raising this above what orderEconomics.js
// reports as safe means selling below cost-plus-floor on real orders.
const CONTEST_DISCOUNT_PERCENT = Number(process.env.CONTEST_DISCOUNT_PERCENT || 0);

// A signed, time-limited discount for `email`, or null while discounting is
// off. Returning null (rather than a 0% discount) matters: every consumer —
// the entry and final-placement emails, the thanks page, the shop's
// "a discount is applied" banner — treats a present discount as something
// to advertise, and a boxed "0% off" offer is worse than none.
function issueDiscount(email, hours) {
  if (!(CONTEST_DISCOUNT_PERCENT > 0)) return null;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  return { percent: CONTEST_DISCOUNT_PERCENT, email, expiresAt, token: discountToken.tokenFor(email, expiresAt) };
}
const ENTRY_DISCOUNT_HOURS = Number(process.env.ENTRY_DISCOUNT_HOURS || 48);
const FINAL_RANK_DISCOUNT_HOURS = Number(process.env.FINAL_RANK_DISCOUNT_HOURS || 72);
// Below this on either dimension, a photo is flagged (not blocked — see
// checkImageQuality) as likely to look soft on a large print.
const MIN_PRINT_DIMENSION_PX = Number(process.env.MIN_PRINT_DIMENSION_PX || 2000);
// How many places an entrant's live rank has to worsen (or crossing out of
// the winner zone) before sendRankDropAlerts emails them again.
const RANK_DROP_THRESHOLD = Number(process.env.RANK_DROP_THRESHOLD || 5);

// Marketing ledger: below this ROAS, an active campaign with real spend
// logged gets an alert email — never an automatic pause or budget change,
// by design (see metaAds.js and docs/audit-assembly.md). Cooldown keeps a
// campaign that stays bad from re-emailing every single day.
const ROAS_ALERT_THRESHOLD = Number(process.env.ROAS_ALERT_THRESHOLD || 2.0);
const ROAS_ALERT_COOLDOWN_DAYS = Number(process.env.ROAS_ALERT_COOLDOWN_DAYS || 3);
// Below this, a campaign's ROAS isn't alerted on at all — a campaign that
// has only spent a few dollars can show a wild/misleading ROAS just from
// noise (one $20 order looks like 20x ROAS on $1 of spend, but that isn't
// a signal of anything yet).
const ROAS_ALERT_MIN_SPEND = Number(process.env.ROAS_ALERT_MIN_SPEND || 25);
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
// Physical products (prints, commissioned paintings) need a real ship-to address.
// Keep this list short by default — every country you add is one you're
// committing to handle customs/duties questions for.
const SHIPPING_COUNTRIES = (process.env.SHIPPING_COUNTRIES || 'US').split(',').map((c) => c.trim());
const REVIEW_REQUEST_DELAY_DAYS = Number(process.env.REVIEW_REQUEST_DELAY_DAYS || 14);

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// Never take money for something that can't be fulfilled. Without the
// webhook secret no payment is ever marked paid; without Printful a paid
// print order is only "dry-run" submitted and sits at 'paid' forever, never
// printed and never alerted on. Local development can opt out.
const ALLOW_UNFULFILLED_CHECKOUT = process.env.ALLOW_UNFULFILLED_CHECKOUT === 'true';
function checkoutBlocker({ needsPrintful }) {
  if (ALLOW_UNFULFILLED_CHECKOUT) return null;
  const missing = [];
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (needsPrintful && !printful.configured()) missing.push('PRINTFUL_API_KEY');
  return missing.length ? missing : null;
}

// ---------- blog + sitemap (no database) ----------
// Both are mounted ahead of the DB-init middleware below on purpose. The
// blog renders straight from the Markdown files in content/blog, and the
// sitemap is a fixed URL list plus those same files, so neither needs
// Postgres for anything — and in front of that middleware, both still
// answer with their content and metadata intact through a database outage
// that 500s the contest and shop pages outright. (The shared stylesheet
// comes from express.static further down and so is still DB-gated; these
// pages degrade to unstyled rather than disappearing. express.static can't
// simply move up here — it would shadow the server-rendered / and
// /index.html routes with the raw file.) Being ahead of express.static is
// also what makes these routes win over any file of the same name in
// public/, same as the server-rendered pages below.
app.use(blog.createRouter({ baseUrl: BASE_URL }));

// Dynamic sitemap.
// The products a visitor can actually buy right now: the catalog minus
// anything switched off in admin. Used by the sitemap and llms.txt, which
// sit ahead of the /api DB middleware, so this initialises the DB itself.
async function liveProducts() {
  await db.initDb();
  return getProductsWithMedia('all');
}

app.get('/sitemap.xml', async (req, res) => {
  // Product pages are listed only while switched on. If the database can't
  // be reached, fall back to the full catalog rather than drop every
  // product URL from the sitemap over a blip.
  let products;
  try {
    products = await liveProducts();
  } catch (err) {
    console.error('[sitemap] product visibility unavailable:', err.message);
    products = productCatalog.listProducts('all');
  }
  const urls = [
    { loc: `${BASE_URL}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${BASE_URL}/vote.html`, changefreq: 'hourly', priority: '0.9' },
    ...blog.sitemapEntries(BASE_URL),
    { loc: `${BASE_URL}/shop`, changefreq: 'weekly', priority: '0.8' },
    ...products.map((p) => ({ loc: `${BASE_URL}/shop/${p.id}`, changefreq: 'weekly', priority: '0.7' })),
    { loc: `${BASE_URL}/commission`, changefreq: 'monthly', priority: '0.8' },
    { loc: `${BASE_URL}/winners`, changefreq: 'monthly', priority: '0.7' },
    { loc: `${BASE_URL}/rules.html`, changefreq: 'monthly', priority: '0.3' },
    { loc: `${BASE_URL}/privacy.html`, changefreq: 'monthly', priority: '0.2' },
    { loc: `${BASE_URL}/terms.html`, changefreq: 'monthly', priority: '0.2' },
    { loc: `${BASE_URL}/shipping.html`, changefreq: 'monthly', priority: '0.2' },
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${seo.escapeHtml(u.loc)}</loc>${u.lastmod ? `
    <lastmod>${seo.escapeHtml(u.lastmod)}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(body);
});

// llms.txt — the hand-written public/llms.txt plus a live product list, so
// AI assistants get each product's own URL and current price, and a product
// switched off in admin drops out here as soon as it's switched off.
app.get('/llms.txt', async (req, res) => {
  let text = fs.readFileSync(path.join(__dirname, 'public', 'llms.txt'), 'utf8');
  try {
    const products = await liveProducts();
    if (products.length) {
      text = text.trimEnd() + `\n\n## Products\n\nEach is printed to order from the buyer's own cat photo. Free shipping on print orders of $${orderEconomics.FREE_SHIPPING_THRESHOLD_USD}+. All products: ${BASE_URL}/shop\n\n` +
        products.map((p) => `- [${p.name}](${BASE_URL}/shop/${p.id}): $${p.priceUsd.toFixed(2)}. ${p.description}`).join('\n') + '\n';
    }
  } catch (err) {
    console.error('[llms.txt] product list unavailable:', err.message);
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(text);
});

// Static assets, served BEFORE the DB-init middleware below.
//
// Everything used to sit behind that middleware, which meant a Postgres
// outage returned a plain-text 500 for vote.html, style.css and script.js
// alike — the vote page couldn't render far enough to tell anyone what was
// wrong, it just hung or died. None of these files need a database to be
// sent, so they no longer wait on one.
//
// index:false plus the explicit skip below is what the earlier comment
// worried about: the server-rendered / and /index.html routes further down
// must keep winning over the raw file of the same name, so those paths
// alone fall through to their own handler (and to the late express.static
// as the prerender's fallback).
// Browsers still ask for /favicon.ico on some pages; the icon is an SVG.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
// Where to report a security problem (RFC 9116). express.static skips
// dot-folders, so it's served explicitly.
app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, 'public', '.well-known', 'security.txt'));
});

const SERVER_RENDERED_PATHS = new Set(['/', '/index.html']);
// A shared vote link (vote.html?cat=N) is how the contest spreads — it's the
// link every entrant posts and texts. Served as a plain file, every one of
// those previewed as a generic "Vote for a cat" with no picture. This gives
// the preview the cat's own name and share card (the 1080x1080 image made
// at entry, see generateShareCard). It runs before the DB-init middleware
// on purpose, like the static files above it: any failure — no such cat, no
// card, the database unreachable — just falls through to the plain page.
const VOTE_HTML_PATH = path.join(__dirname, 'public', 'vote.html');

// Every static page ships the default preview card (public/og-default.png);
// pages with a real photo to show swap it in here.
const DEFAULT_PREVIEW_IMAGE = 'https://whiskr.lol/og-default.png';
function swapPreviewImage(html, imageUrl, size) {
  const url = seo.escapeHtml(imageUrl);
  html = html.split(DEFAULT_PREVIEW_IMAGE).join(url);
  html = html.replace(/<meta property="og:image:width" content="\d+" \/>/, size ? `<meta property="og:image:width" content="${size.width}" />` : '');
  html = html.replace(/<meta property="og:image:height" content="\d+" \/>/, size ? `<meta property="og:image:height" content="${size.height}" />` : '');
  return html;
}
app.get('/vote.html', async (req, res, next) => {
  const catId = Number(req.query.cat);
  if (!Number.isInteger(catId) || catId <= 0) return next();
  try {
    const cat = await db.get(
      `SELECT id, cat_name, share_image_path, photo_path FROM submissions WHERE id = ? AND disqualified = 0`,
      [catId]
    );
    const imagePath = cat && (cat.share_image_path || cat.photo_path);
    if (!imagePath) return next();
    const imageUrl = imagePath.startsWith('http') ? imagePath : `${BASE_URL}${imagePath}`;
    const title = seo.escapeHtml(`Vote for ${cat.cat_name} on Whiskr`);
    const pageUrl = seo.escapeHtml(`${BASE_URL}/vote.html?cat=${cat.id}`);
    let html = await fs.promises.readFile(VOTE_HTML_PATH, 'utf8');
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${title}" />`)
      .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${title}" />`)
      .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${pageUrl}" />`);
    html = swapPreviewImage(html, imageUrl, { width: 1080, height: 1080 });
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (err) {
    console.error('[render] vote preview failed, serving the plain page:', err.message);
    next();
  }
});

const staticAssets = express.static(path.join(__dirname, 'public'), { index: false });
app.use((req, res, next) => {
  if (SERVER_RENDERED_PATHS.has(req.path)) return next();
  return staticAssets(req, res, next);
});

// Pages for two retired features — the calendar product and the separate
// Cat of the Year vote. A 410 tells crawlers to drop any old indexed link,
// and gives anyone following an old bookmark somewhere useful to go.
const RETIRED_PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>No longer available — Whiskr</title><meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" href="/style.css" /></head>
<body><main style="max-width:520px;margin:80px auto;padding:0 24px;text-align:center;">
<h1>This page is no longer available.</h1>
<p>Each month's contest winner now gets an original hand-painted portrait directly — there's no separate calendar or Cat of the Year vote.</p>
<p><a href="/">Back to Whiskr</a></p>
</main></body></html>`;
app.get(['/calendar.html', '/year-award.html'], (req, res) => {
  res.status(410).set('Content-Type', 'text/html; charset=utf-8').send(RETIRED_PAGE_HTML);
});

// The commission page is a clean URL over a plain file — no database, so it
// belongs on this side of the middleware too.
app.get('/commission', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'commission.html'));
});

// The brief's site map calls this /thanks, and it is the page an entrant is
// sent to the moment they enter — the one that turns an entry into votes.
// Where a winner claims their painting: either from the signed link in
// their winner email / status page, or by "checking back" and entering the
// email + phone they entered with (see POST /api/claim/lookup).
app.get('/claim', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'claim.html'));
});

app.get('/thanks', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'thanks.html'));
});

app.get('/winners', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'winners.html'));
});

// Creates tables once per warm instance — required on Vercel, which has no
// long-lived startup phase to create them in ahead of time.
//
// Scoped to /api on purpose. It used to run for every request and answer a
// failure with a 500 for the whole site; now a database outage costs the
// API its responses while every page, stylesheet and script still loads, so
// the front end can show a real error and a retry instead of a dead page.
// The server-rendered pages below reach the database directly and each
// already falls back to its static file if that throws, so they don't need
// gating here either.
app.use('/api', async (req, res, next) => {
  try {
    await db.initDb();
    next();
  } catch (err) {
    console.error('[db] failed to initialize:', err.message);
    // JSON, not the old plain text: every caller of these routes parses the
    // body as JSON, and handing them HTML/text is what turned an outage
    // into a confusing client-side parse error.
    res.status(503).json({ error: 'The database is temporarily unreachable. Please try again in a moment.' });
  }
});

// ---------- uploads ----------
// Extension is derived from the validated MIME type, never from the
// attacker-controlled original filename — otherwise someone can upload an
// .svg/.html file with a spoofed "image/png" Content-Type and get it served
// back with a browser-executable extension (stored XSS).
const EXT_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Buffered in memory, not written to disk — Vercel's filesystem is
// ephemeral/read-only in production, and buffering means a validation
// failure after upload never leaves an orphaned file to clean up (there's
// nothing on disk yet to clean up).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (!Object.prototype.hasOwnProperty.call(EXT_FOR_MIME, file.mimetype)) {
      return cb(Object.assign(new Error('Only jpg, png, webp, or gif photos are accepted.'), { uploadRejected: true }));
    }
    cb(null, true);
  },
});

const BLOB_CONFIGURED = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

// Stores a validated upload and returns the URL/path to save as photo_path.
// Uses Vercel Blob when configured (BLOB_READ_WRITE_TOKEN is set automatically
// once a Blob store is created and linked to the project); otherwise falls
// back to local disk under public/uploads, which keeps local development
// working without needing a Blob store just to hack on the app. On Vercel
// itself BLOB_READ_WRITE_TOKEN must be set — the local-disk fallback would
// silently fail there since that filesystem isn't writable/persistent.
// Every upload is decoded and re-encoded before it's stored. That proves it
// really is an image (not just a file claiming an image Content-Type), turns
// it the right way up, and drops ALL metadata: phone photos usually carry
// the GPS position they were taken at, and contest entries are public.
// Quality is kept high (JPEG q95, no chroma subsampling) because these are
// also what gets printed.
async function sanitizeImage(file) {
  try {
    const img = sharp(file.buffer, { failOn: 'error' }).rotate();
    if (file.mimetype === 'image/png' || file.mimetype === 'image/gif') {
      return { buffer: await img.png().toBuffer(), mimetype: 'image/png' };
    }
    if (file.mimetype === 'image/webp') {
      return { buffer: await img.webp({ quality: 95 }).toBuffer(), mimetype: 'image/webp' };
    }
    return { buffer: await img.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer(), mimetype: 'image/jpeg' };
  } catch (err) {
    console.warn('[upload] rejected a file that could not be decoded as an image:', err.message);
    throw Object.assign(new Error("That file couldn't be read as a photo — please try a different one."), { uploadRejected: true });
  }
}

async function storePhoto(file) {
  const clean = await sanitizeImage(file);
  const ext = EXT_FOR_MIME[clean.mimetype] || '.jpg';
  const filename = `${uuid()}${ext}`;

  if (BLOB_CONFIGURED) {
    const blob = await putBlob(`uploads/${filename}`, clean.buffer, {
      access: 'public',
      contentType: clean.mimetype,
    });
    return blob.url;
  }

  const uploadDir = path.join(__dirname, 'public', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, filename), clean.buffer);
  return `/uploads/${filename}`;
}

// Stores a raw buffer (not a multer file) under uploads/ the same way
// storePhoto does — used for generated assets like the share card and
// AI-enhanced photos, which don't come from an incoming form upload.
async function storeBuffer(buffer, mimetype, filename) {
  if (BLOB_CONFIGURED) {
    const blob = await putBlob(`uploads/${filename}`, buffer, { access: 'public', contentType: mimetype });
    return blob.url;
  }
  const uploadDir = path.join(__dirname, 'public', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, filename), buffer);
  return `/uploads/${filename}`;
}

// Downloads the stored photo and runs it through optional AI upscaling
// (photoEnhance.js — a no-op unless REPLICATE_API_TOKEN is set and the
// photo is actually low-res). If enhanced, re-stores the result via
// storeBuffer and returns its new URL/path; otherwise returns photoPath
// unchanged. Only ever called here, after payment — never at upload or
// checkout time — so a slow AI call can't block a customer the way a
// synchronous mailer.js send used to (see docs/audit-assembly.md #9).
//
// Complements, not replaces, checkImageQuality below: that flags a low-res
// photo to the customer before they pay (informed choice); this quietly
// tries to fix the ones that do get ordered. The two use independent
// thresholds (MIN_PRINT_DIMENSION_PX vs. photoEnhance's own) — no need to
// keep them in sync, they're answering different questions.
async function maybeEnhancePhoto(photoPath) {
  if (!photoEnhance.configured()) return photoPath;

  const url = photoPath.startsWith('http') ? photoPath : `${BASE_URL}${photoPath}`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return photoPath;
  const original = Buffer.from(await res.arrayBuffer());

  const enhanced = await photoEnhance.enhanceIfNeeded(original);
  if (enhanced === original) return photoPath; // not enhanced — nothing to re-store

  return storeBuffer(enhanced, 'image/png', `${uuid()}-enhanced.png`);
}

// Composites a real, ready-to-post "vote for me" image from the entrant's
// own photo — a square crop with the cat's name and the Whiskr wordmark
// overlaid, so sharing is an actual image (Stories/feed/WhatsApp all
// prefer an image over a bare link), not a fabricated render — same photo
// they uploaded, just framed for sharing. Failure here never blocks an
// entry; the caller treats a null return as "no share card this time."
async function generateShareCard(photoBuffer, catName) {
  const SIZE = 1080;
  const BAR_HEIGHT = 190;
  const safeName = seo.escapeHtml(catName);
  // Plain text only, no emoji — this renders server-side via whatever font
  // stack happens to be installed on the host, which reliably has a normal
  // sans-serif face but not necessarily an emoji font, so an emoji here can
  // silently come out as a broken tofu box on every single share card.
  const svg = `
    <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${SIZE - BAR_HEIGHT}" width="${SIZE}" height="${BAR_HEIGHT}" fill="rgba(27,36,48,0.85)" />
      <text x="40" y="${SIZE - BAR_HEIGHT + 70}" font-family="sans-serif" font-size="54" font-weight="700" fill="#ffffff">Vote for ${safeName}!</text>
      <text x="40" y="${SIZE - BAR_HEIGHT + 130}" font-family="sans-serif" font-size="32" fill="#E8A33D" font-weight="600">whiskr.lol</text>
    </svg>`;
  try {
    const buffer = await sharp(photoBuffer)
      .resize(SIZE, SIZE, { fit: 'cover' })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();
    return await storeBuffer(buffer, 'image/jpeg', `share-${uuid()}.jpg`);
  } catch (err) {
    console.warn('[share-card] generation failed:', err.message);
    return null;
  }
}

// Reads real pixel dimensions and flags (never blocks — a business would
// rather sell a slightly soft print than lose the sale) anything under
// MIN_PRINT_DIMENSION_PX on either side. Falls back to "unknown, not
// flagged" if Sharp can't read the file for any reason, so a metadata
// hiccup never breaks a submission that otherwise passed multer's own
// image-type validation.
async function checkImageQuality(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || null;
    const height = meta.height || null;
    // 0/1, not a JS boolean — this goes straight into an INTEGER column via
    // a couple of call sites, and Postgres won't implicitly cast true/false.
    const lowResolution =
      width && height && (width < MIN_PRINT_DIMENSION_PX || height < MIN_PRINT_DIMENSION_PX) ? 1 : 0;
    return { width, height, lowResolution };
  } catch (err) {
    console.warn('[image-quality] could not read dimensions:', err.message);
    return { width: null, height: null, lowResolution: 0 };
  }
}

// Shared owner-alert helper — used for anything that needs a human to look
// at an order (a failed Printful submission, a refund, a dispute). Always
// records the alert in admin_alerts first, so every real failure across the
// site shows up in admin.html's error panel in one place — regardless of
// whether ADMIN_EMAIL is even configured. Email itself still silently no-ops
// without ADMIN_EMAIL; startup already warns loudly if it's unset (see the
// top-level env checks) so that half is a deliberate, visible choice, not a
// silent failure.
async function alertAdmin(subject, message) {
  await db
    .run(`INSERT INTO admin_alerts (subject, message, created_at) VALUES (?, ?, ?)`, [
      subject,
      message,
      new Date().toISOString(),
    ])
    .catch((err) => console.error('[admin_alerts] failed to record alert:', err.message));

  if (!process.env.ADMIN_EMAIL) return;
  await mailer
    .sendMail({
      to: process.env.ADMIN_EMAIL,
      subject,
      text: message,
      html: `<p>${seo.escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
    })
    .catch(() => {});
}

// Submits a paid custom order to Printful for printing + shipping. Only
// ever called from the webhook below, after Stripe confirms payment — never
// at checkout time, and never more than once (custom_orders.status guards
// against a duplicate webhook delivery re-submitting the same order).
async function submitCustomOrderToPrintful(orderId) {
  // Inside the try with everything else: this lookup is a network call to
  // Postgres like any other, and when it threw it escaped the function
  // completely — past the catch below that exists precisely so a failure here
  // can never leave an order silently stuck at 'paid'.
  let order = null;
  try {
    order = await db.get(`SELECT * FROM custom_orders WHERE id = ?`, [orderId]);
  } catch (err) {
    console.error(`[printful] could not load custom order #${orderId}:`, err.message);
    throw err;
  }
  if (!order || order.status !== 'paid') return;

  // Everything below (including JSON.parse'ing a stored field and a DB
  // write) is inside this try on purpose — this function is the only place
  // that ever alerts admin or marks an order 'failed' for retry. Anything
  // between here and a real Printful submission that throws uncaught would
  // leave the order silently stuck at 'paid' forever: no Printful order, no
  // alert, and invisible in admin.html (whose "Retry Printful" button only
  // shows for status='failed').
  try {
    const product = productCatalog.getProduct(order.product_id);
    const recipient = printful.recipientFromStripeShipping(
      order.shipping_address ? JSON.parse(order.shipping_address) : null,
      order.email
    );

    const photoPath = await maybeEnhancePhoto(order.photo_path);
    if (photoPath !== order.photo_path) {
      await db.run(`UPDATE custom_orders SET photo_path = ? WHERE id = ?`, [photoPath, order.id]);
    }

    const result = await printful.submitOrder({
      externalId: `custom-${order.id}`,
      variantId: order.variant_id || (product ? product.printfulVariantId : null),
      quantity: order.quantity,
      photoUrl: photoPath.startsWith('http') ? photoPath : `${BASE_URL}${photoPath}`,
      recipient,
    });

    if (result && result.dryRun) {
      console.log(`[printful] custom order #${order.id} — dry run only (PRINTFUL_API_KEY not set).`);
    } else {
      await db.run(
        `UPDATE custom_orders SET status = 'submitted_to_printful', printful_order_id = ? WHERE id = ?`,
        [result && result.id ? String(result.id) : null, order.id]
      );
      console.log(`[printful] custom order #${order.id} submitted (Printful order ${result && result.id}).`);
    }
  } catch (err) {
    console.error(`[printful] failed to submit custom order #${order.id}:`, err.message);
    // Guarded because the DB is a plausible cause of the failure being
    // handled: an unguarded write here would throw *out of the catch block*
    // and defeat the whole point of it.
    try {
      await db.run(`UPDATE custom_orders SET status = 'failed' WHERE id = ?`, [order.id]);
      await alertAdmin(
        `Custom order #${order.id} failed to submit to Printful`,
        `Custom order #${order.id} (${order.email}) was paid but failed to submit to Printful: ${err.message}. It needs manual attention.`
      );
    } catch (inner) {
      console.error(`[printful] could not even flag custom order #${order.id} as failed:`, inner.message);
    }
  }
}

// Newer Stripe API versions moved this from the top-level `shipping_details`
// to `collected_information.shipping_details` — check both so a future API
// version change can't silently reintroduce a "no shipping address on file"
// failure. Shared by the webhook handler and the admin retry endpoint below
// (which re-fetches the session directly, for orders whose stored
// shipping_address was already saved as null by this same bug historically).
function extractShippingJson(session) {
  const shippingDetails =
    (session.collected_information && session.collected_information.shipping_details) ||
    session.shipping_details ||
    null;
  return shippingDetails ? JSON.stringify(shippingDetails) : null;
}

// ---------- shipment tracking ----------
// Printful tells us an order shipped, but the order lifecycle used to end
// at submitted_to_printful: no tracking, no delivery, no ship date. That
// blindness had three costs -- we asked customers to review parcels that
// never arrived, we could not answer "where is my order", and Printful's
// lost-in-transit claim window (30 days from estimated delivery) could
// expire before we knew a package was missing, turning a claim they would
// have paid into a reprint we eat.

// Writes one Printful shipment onto an order, then recomputes the order's
// summary. Upserts on Printful's own shipment id, so a duplicate webhook,
// an out-of-order delivery, or the daily poll re-reading the same shipment
// all converge on the same row instead of appending a second one.
async function upsertShipment(customOrderId, shipment) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO custom_order_shipments
       (custom_order_id, printful_shipment_id, tracking_number, tracking_url, carrier, service,
        shipped_at, ship_date, delivery_status, delivered_at, estimated_delivery, is_reshipment,
        delivery_checked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (printful_shipment_id) DO UPDATE SET
       tracking_number = COALESCE(EXCLUDED.tracking_number, custom_order_shipments.tracking_number),
       tracking_url = COALESCE(EXCLUDED.tracking_url, custom_order_shipments.tracking_url),
       carrier = COALESCE(EXCLUDED.carrier, custom_order_shipments.carrier),
       service = COALESCE(EXCLUDED.service, custom_order_shipments.service),
       shipped_at = COALESCE(EXCLUDED.shipped_at, custom_order_shipments.shipped_at),
       ship_date = COALESCE(EXCLUDED.ship_date, custom_order_shipments.ship_date),
       delivery_status = COALESCE(EXCLUDED.delivery_status, custom_order_shipments.delivery_status),
       delivered_at = COALESCE(EXCLUDED.delivered_at, custom_order_shipments.delivered_at),
       estimated_delivery = COALESCE(EXCLUDED.estimated_delivery, custom_order_shipments.estimated_delivery),
       is_reshipment = EXCLUDED.is_reshipment,
       delivery_checked_at = EXCLUDED.delivery_checked_at`,
    [
      customOrderId, shipment.printfulShipmentId, shipment.trackingNumber, shipment.trackingUrl,
      shipment.carrier, shipment.service, shipment.shippedAt, shipment.shipDate,
      shipment.deliveryStatus, shipment.deliveredAt, shipment.estimatedDelivery,
      shipment.isReshipment, now, now,
    ]
  );
}

// Rolls every shipment on an order up into the order row.
//
// delivered_at is set only when EVERY shipment is delivered: a two-box
// order with one box delivered has not arrived, and treating it as
// arrived is exactly what would send a review request for a parcel the
// customer is still waiting on.
async function recomputeOrderShipping(customOrderId) {
  const rows = await db.all(
    `SELECT delivery_status, delivered_at, shipped_at, estimated_delivery
       FROM custom_order_shipments WHERE custom_order_id = ?`,
    [customOrderId]
  );
  if (rows.length === 0) return;

  const shippedDates = rows.map((r) => r.shipped_at).filter(Boolean).sort();
  const etas = rows.map((r) => r.estimated_delivery).filter(Boolean).sort();
  const allDelivered = rows.every((r) => r.delivery_status === 'delivered');
  const deliveredDates = rows.map((r) => r.delivered_at).filter(Boolean).sort();

  await db.run(
    `UPDATE custom_orders
        SET first_shipped_at = ?, latest_estimated_delivery = ?, delivered_at = ?
      WHERE id = ?`,
    [
      shippedDates[0] || null,
      etas.length ? etas[etas.length - 1] : null,
      allDelivered && deliveredDates.length ? deliveredDates[deliveredDates.length - 1] : null,
      customOrderId,
    ]
  );
}

// Pulls an order's shipments from Printful and stores them. Every caller --
// the webhook, the daily delivery poll, the admin refresh -- goes through
// here, so there is one implementation of "what does Printful currently say
// about this order" and the webhook payload is never trusted on its own.
async function syncOrderShipments(customOrderId, { notify = true } = {}) {
  const order = await db.get(`SELECT * FROM custom_orders WHERE id = ?`, [customOrderId]);
  if (!order) return { ok: false, reason: 'order not found' };
  if (!order.printful_order_id) return { ok: false, reason: 'order has no Printful id yet' };

  const { shipments, dryRun } = await printful.getOrderShipments(order.printful_order_id);
  if (dryRun) return { ok: false, reason: 'Printful not configured' };

  let stored = 0;
  for (const raw of shipments) {
    const shipment = printful.normalizeShipment(raw);
    if (!shipment) continue;
    await upsertShipment(customOrderId, shipment);
    stored++;
  }
  if (stored === 0) return { ok: true, shipments: 0 };

  await recomputeOrderShipping(customOrderId);

  // Tracking email, sent once. Guarded on tracking_emailed_at inside the
  // UPDATE rather than around it, so two concurrent syncs (a webhook and
  // the daily poll landing together) can't both send it.
  if (notify) {
    const fresh = await db.get(`SELECT * FROM custom_orders WHERE id = ?`, [customOrderId]);
    if (fresh && fresh.first_shipped_at && !fresh.tracking_emailed_at) {
      const claimed = await db.run(
        `UPDATE custom_orders SET tracking_emailed_at = ? WHERE id = ? AND tracking_emailed_at IS NULL`,
        [new Date().toISOString(), customOrderId]
      );
      if (claimed.changes > 0) {
        const parcels = await db.all(
          `SELECT tracking_number, tracking_url, carrier, estimated_delivery
             FROM custom_order_shipments WHERE custom_order_id = ? ORDER BY id ASC`,
          [customOrderId]
        );
        const product = productCatalog.getProduct(order.product_id);
        try {
          await mailer.sendShippedEmail({
            email: order.email,
            itemLabel: product ? product.name : 'your Whiskr order',
            petName: order.pet_name,
            parcels,
          });
        } catch (err) {
          // The email is a courtesy; the tracking data is the asset. Don't
          // unwind the stamp on a send failure -- retrying forever would
          // mean a broken SMTP config mails the customer on every poll.
          console.error(`[mailer] shipped email failed for custom order ${customOrderId}:`, err.message);
        }
      }
    }
  }

  return { ok: true, shipments: stored };
}

// Daily: refresh shipments that haven't reached a terminal state, and flag
// the ones that are overdue so a Printful claim gets filed inside their
// window instead of after a customer complains.
//
// Delivery is polled, not pushed: shipment_sent is the only shipment event
// Printful publishes. There is no "delivered" webhook, so without this the
// delivered state would never arrive at all.
async function pollShipmentDeliveries() {
  if (!printful.configured()) return;

  // Driven from custom_orders, not custom_order_shipments. Selecting from the
  // shipments table could only ever *refresh* orders that already had a
  // shipment row, and the only things that create one are the Printful webhook
  // and the manual admin refresh. With PRINTFUL_WEBHOOK_TOKEN unset the webhook
  // 404s by design, so the shipments table stayed empty forever, this poll
  // iterated nothing, delivered_at was never set on any order -- and because
  // sendDueReviewRequests switches to a delivered_at-based query the moment a
  // Printful API key exists, every custom-order review request silently stopped.
  // Reading candidates from the orders themselves lets the poll *discover* a
  // first shipment rather than only refresh known ones, which is what makes the
  // webhook genuinely optional the way .env.example claims.
  //
  // Bounded by age as well as batch size: a parcel that never reaches a
  // terminal status (a lost one, or a carrier that stops scanning) would
  // otherwise hold a poll slot forever and eventually starve newer orders out
  // of the batch entirely. Printful's lost-in-transit claim window is 30 days
  // past estimated delivery, so anything older than this window is past
  // recovering anyway.
  const pollCutoff = new Date(
    Date.now() - SHIPMENT_POLL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const stale = await db.all(
    `SELECT o.id AS custom_order_id
       FROM custom_orders o
      WHERE o.printful_order_id IS NOT NULL
        AND o.delivered_at IS NULL
        AND o.status NOT IN ('refunded','disputed')
        AND o.created_at >= ?
      ORDER BY o.id DESC
      LIMIT ?`,
    [pollCutoff, SHIPMENT_POLL_BATCH]
  );

  for (const row of stale) {
    try {
      // notify:false -- the tracking email belongs to the ship event, not
      // to a routine delivery refresh.
      await syncOrderShipments(row.custom_order_id, { notify: false });
    } catch (err) {
      console.error(`[printful] delivery poll failed for order ${row.custom_order_id}:`, err.message);
    }
  }
}

async function flagStalledShipments() {
  const cutoff = new Date(Date.now() - STALLED_DAYS_AFTER_ETA * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const stalled = await db.all(
    `SELECT o.id, o.email, o.latest_estimated_delivery, o.first_shipped_at
       FROM custom_orders o
      WHERE o.stalled_flagged_at IS NULL
        AND o.delivered_at IS NULL
        AND o.latest_estimated_delivery IS NOT NULL
        AND o.latest_estimated_delivery <= ?
        AND o.status NOT IN ('refunded','disputed')`,
    [cutoff]
  );

  for (const o of stalled) {
    await db.run(`UPDATE custom_orders SET stalled_flagged_at = ? WHERE id = ? AND stalled_flagged_at IS NULL`, [
      new Date().toISOString(),
      o.id,
    ]);
    await alertAdmin(
      `Custom order #${o.id} is overdue - file the Printful claim`,
      `Custom order #${o.id} (${o.email}) shipped on ${o.first_shipped_at || 'an unknown date'} with an estimated delivery of ${o.latest_estimated_delivery}, and still has no delivery scan ${STALLED_DAYS_AFTER_ETA} days later.\n\n` +
        `Printful accepts a lost-in-transit claim up to 30 days after estimated delivery and covers the reprint and reshipping when the carrier lost it. File it now rather than waiting for the customer to ask.\n\n` +
        `Note: if tracking says delivered, Printful will not cover it - that reship is ours.`
    );
  }
}

// Stripe webhook needs the raw request body for signature verification, so
// it's mounted before the global express.json() parser below — otherwise
// json() would consume/parse the body first and constructEvent would fail.
// Without this, /api/checkout creates an order row as 'pending' and nothing
// ever marks it paid — there'd be no reliable record of who actually paid or
// what to fulfill.
//
// Fulfilment for a Checkout Session Stripe has confirmed is actually paid.
// Split out of the webhook route because two different events can deliver a
// paid session: checkout.session.completed for an immediate card payment, and
// checkout.session.async_payment_succeeded for a delayed-notification method,
// where the session completes days before the money arrives.
async function fulfillCheckoutSession(session) {
  const orderType = session.metadata && session.metadata.orderType;
  const orderId = session.metadata && Number(session.metadata.orderId);
  const shippingJson = extractShippingJson(session);

  if (orderType === 'custom' && orderId) {
    // Scoped to status='pending' so a retried webhook delivery (Stripe
    // resends on any non-2xx or slow response) can't re-mark it — without
    // that guard, a retried delivery resets an
    // already-'submitted_to_printful' order back to 'paid', which defeats
    // submitCustomOrderToPrintful's own status check and re-submits the
    // same order to Printful a second time.
    const info = await db.run(
      `UPDATE custom_orders SET status = 'paid', shipping_address = ? WHERE id = ? AND status = 'pending'`,
      [shippingJson, orderId]
    );
    if (info.changes > 0) {
      console.log(`[stripe webhook] custom order #${orderId} marked paid.`);
      // Purchase is fired here and only here — this webhook is the one
      // point a payment is actually confirmed, unlike a client-side
      // "thank you page" event that fires on redirect regardless of
      // whether payment truly succeeded. Scoped inside the same
      // status='pending' guard above, so a retried webhook delivery
      // can't double-fire it either.
      const paidOrder = await db.get(`SELECT email, amount_usd FROM custom_orders WHERE id = ?`, [orderId]);
      if (paidOrder) {
        metaConversions
          .sendEvent({
            eventName: 'Purchase',
            eventId: `purchase-custom-${orderId}`,
            email: paidOrder.email,
            value: Number(paidOrder.amount_usd),
            currency: 'USD',
            eventSourceUrl: BASE_URL,
          })
          .catch((err) => console.error('[meta capi] Purchase event failed:', err.message));
      }
      await submitCustomOrderToPrintful(orderId);
    } else {
      console.log(`[stripe webhook] custom order #${orderId} already processed (duplicate delivery) — skipping.`);
    }
  } else if (orderType === 'commission_deposit' && orderId) {
    // Same status-scoped idempotency guard as the order types above: a
    // retried delivery must not re-stamp deposit_paid_at or re-notify.
    const info = await db.run(
      `UPDATE commissions SET status = 'deposit_paid', deposit_paid_at = ?, shipping_address = ? WHERE id = ? AND status = 'deposit_pending'`,
      [new Date().toISOString(), shippingJson, orderId]
    );
    if (info.changes > 0) {
      console.log(`[stripe webhook] commission #${orderId} deposit paid.`);
      const booking = await db.get(`SELECT * FROM commissions WHERE id = ?`, [orderId]);
      if (booking) {
        metaConversions
          .sendEvent({
            eventName: 'Purchase',
            eventId: `purchase-commission-deposit-${orderId}`,
            email: booking.email,
            value: Number(booking.deposit_usd),
            currency: 'USD',
            eventSourceUrl: BASE_URL,
          })
          .catch((err) => console.error('[meta capi] Purchase event failed:', err.message));
        // A booked commission is a promise of hand-made work with a
        // clock on it, so it has to reach a human rather than only
        // appear in an admin list nobody is watching.
        await mailer
          .sendCommissionBooked({
            email: booking.email,
            petName: booking.pet_name,
            sizeLabel: (commissionPricing.getSize(booking.size_id) || {}).label || booking.size_id,
            depositUsd: Number(booking.deposit_usd).toFixed(2),
            balanceUsd: Number(booking.balance_usd).toFixed(2),
            totalUsd: Number(booking.total_usd).toFixed(2),
            rush: Boolean(Number(booking.rush)),
          })
          .catch((err) => console.error('[mailer] commission confirmation failed:', err.message));
        await alertAdmin(
          `Commission #${orderId} booked — deposit paid`,
          `${booking.email} booked a ${booking.size_id} original${Number(booking.rush) ? ' (RUSH, under 10 days)' : ''}. Deposit $${Number(booking.deposit_usd).toFixed(2)} paid, balance $${Number(booking.balance_usd).toFixed(2)} due before shipping. Reference photo: ${booking.photo_path && booking.photo_path.startsWith('http') ? booking.photo_path : BASE_URL + booking.photo_path}${booking.notes ? `\nNotes: ${booking.notes}` : ''}\nCustomer: ${booking.customer_name || 'no name given'}, cat: ${booking.pet_name || 'not given'}.`
        );
      }
    } else {
      console.log(`[stripe webhook] commission #${orderId} deposit already processed (duplicate delivery) — skipping.`);
    }
  } else if (orderType === 'commission_balance' && orderId) {
    const info = await db.run(
      `UPDATE commissions SET status = 'balance_paid', balance_paid_at = ?, shipping_address = COALESCE(?, shipping_address) WHERE id = ? AND status = 'balance_pending'`,
      [new Date().toISOString(), shippingJson, orderId]
    );
    if (info.changes > 0) {
      console.log(`[stripe webhook] commission #${orderId} balance paid — clear to ship.`);
      const booking = await db.get(`SELECT email, balance_usd FROM commissions WHERE id = ?`, [orderId]);
      if (booking) {
        metaConversions
          .sendEvent({
            eventName: 'Purchase',
            eventId: `purchase-commission-balance-${orderId}`,
            email: booking.email,
            value: Number(booking.balance_usd),
            currency: 'USD',
            eventSourceUrl: BASE_URL,
          })
          .catch((err) => console.error('[meta capi] Purchase event failed:', err.message));
      }
      await alertAdmin(
        `Commission #${orderId} balance paid — clear to ship`,
        `The balance on commission #${orderId} is paid. Nothing is blocking shipment.`
      );
    } else {
      console.log(`[stripe webhook] commission #${orderId} balance already processed (duplicate delivery) — skipping.`);
    }
  } else {
    console.warn(`[stripe webhook] checkout.session.completed with unrecognized metadata for session ${session.id}`);
  }
}

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe webhooks are not configured.');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // A completed session is not necessarily a paid one. Stripe fires
  // checkout.session.completed the moment the customer finishes checkout, but
  // for a delayed-notification payment method (ACH, bank transfer, Klarna —
  // each one dashboard toggle away, and Stripe actively promotes them) the
  // money has not moved yet and payment_status is 'unpaid'. Fulfilling on
  // that signal alone means painting and shipping goods for a payment that
  // may never land. Fulfil only once the money is confirmed: either
  // payment_status says so here, or async_payment_succeeded says so later.
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const session = event.data.object;
    const paid =
      session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    try {
      if (paid) {
        await fulfillCheckoutSession(session);
      } else {
        console.log(
          `[stripe webhook] session ${session.id} is '${session.payment_status}' — not fulfilling yet; waiting for checkout.session.async_payment_succeeded.`
        );
      }
    } catch (err) {
      // Reaching here used to take the whole process down: Express 4 does not
      // catch a rejected async handler and nothing installs an
      // unhandledRejection hook, so one transient Postgres error during a
      // webhook killed the server and Stripe got no reply at all. Answering
      // 500 makes Stripe retry instead, which the status-scoped guards inside
      // fulfillCheckoutSession are already safe against.
      console.error(`[stripe webhook] failed handling ${event.type} (${event.id}):`, err);
      return res.status(500).json({ error: 'Webhook handler failed — please retry.' });
    }
  } else if (event.type === 'checkout.session.async_payment_failed') {
    // The customer got as far as checkout but the bank debit bounced. The
    // order was never marked paid (see above), so nothing has to be undone —
    // but a human should know a sale silently evaporated.
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.orderId;
    console.warn(`[stripe webhook] async payment failed for session ${session.id} (order ${orderId}).`);
    try {
      await alertAdmin(
        `Payment failed for ${(session.metadata && session.metadata.orderType) || 'an order'} #${orderId}`,
        `Stripe reported async_payment_failed for checkout session ${session.id}. The order was never marked paid and nothing shipped, but the customer tried to buy and their payment bounced — worth following up.`
      );
    } catch (err) {
      console.error('[stripe webhook] async_payment_failed alert failed:', err.message);
    }
  } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    // Neither a Charge nor a Dispute carries our own order metadata directly
    // — only the Checkout Session does — so look the session up by the
    // payment intent they both share, then flag whichever order it maps to.
    // Without this, a refunded or disputed order just sits at 'paid'/
    // 'submitted_to_printful' forever and can still go out the door.
    const obj = event.data.object;
    const paymentIntent = obj.payment_intent;
    const newStatus = event.type === 'charge.refunded' ? 'refunded' : 'disputed';
    // charge.refunded also fires for a PARTIAL refund (a shipping refund, a
    // goodwill credit). Only a full refund ends an order; a partial one just
    // tells a human, and the order carries on.
    const partialRefund = event.type === 'charge.refunded' && obj.refunded === false;
    try {
      if (paymentIntent && partialRefund) {
        await alertAdmin(
          'Partial refund issued',
          `Stripe reports a partial refund on payment ${paymentIntent} ($${(Number(obj.amount_refunded || 0) / 100).toFixed(2)} of $${(Number(obj.amount || 0) / 100).toFixed(2)}). The order's status was left as it was.`
        );
      } else if (paymentIntent) {
        const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 });
        const session = sessions.data[0];
        const orderType = session && session.metadata && session.metadata.orderType;
        const orderId = session && session.metadata && Number(session.metadata.orderId);
        if (orderType === 'custom' && orderId) {
          await db.run(`UPDATE custom_orders SET status = ? WHERE id = ?`, [newStatus, orderId]);
          await alertAdmin(
            `Custom order #${orderId} was ${newStatus}`,
            `Custom order #${orderId} was marked ${newStatus} in Stripe. If it already shipped or was submitted to Printful, it needs manual attention.`
          );
        } else if ((orderType === 'commission_deposit' || orderType === 'commission_balance') && orderId) {
          // Not scoped to a prior status: a refund or dispute is terminal
          // regardless of where the booking had got to, and a painting in
          // progress for an unpaid commission is exactly what needs a human.
          await db.run(`UPDATE commissions SET status = ? WHERE id = ?`, [newStatus, orderId]);
          await alertAdmin(
            `Commission #${orderId} was ${newStatus}`,
            `Commission #${orderId} (${orderType.replace('commission_', '')} payment) was marked ${newStatus} in Stripe. If the painting is already underway or finished, it needs manual attention now.`
          );
        } else {
          console.warn(`[stripe webhook] ${event.type} for payment_intent ${paymentIntent} with no matching order`);
        }
      }
    } catch (err) {
      console.error(`[stripe webhook] failed to process ${event.type}:`, err.message);
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// ---------- server-rendered pages (must come before express.static below,
// so these routes intercept / and /index.html instead of the static file of
// the same name) ----------

// Same query the /api/status JSON endpoint answers, shared so the
// server-rendered homepage and the client's live re-check never disagree.
async function getContestStatus() {
  // Same round the entry form and vote page use, so the homepage never says
  // "a new contest opens soon" — entry is always open (see rules.html).
  const contest = await getOrOpenCurrentContest();
  const lastCompleted = await db.get(
    `SELECT id, winner_submission_id FROM groups WHERE status = 'completed' ORDER BY id DESC LIMIT 1`
  );
  let winnerCat = null;
  if (lastCompleted) {
    winnerCat = await db.get(`SELECT cat_name, photo_path FROM submissions WHERE id = ?`, [
      lastCompleted.winner_submission_id,
    ]);
  }

  let entryCount = 0;
  let daysLeft = null;
  if (contest) {
    const row = await db.get(
      `SELECT COUNT(*) AS c FROM submissions WHERE contest_id = ? AND disqualified = 0`,
      [contest.id]
    );
    entryCount = Number(row.c);
    daysLeft = Math.max(0, Math.ceil((new Date(contest.closes_at) - Date.now()) / (24 * 60 * 60 * 1000)));
  }

  // Same principle as the old fillStatus fix: never surface a raw, possibly
  // embarrassingly-low entry count. Only show the number once it's actually
  // an impressive social-proof signal; otherwise say entries are open
  // without a number attached.
  const ENTRY_COUNT_DISPLAY_THRESHOLD = 25;
  let statusText;
  if (!contest) {
    statusText = 'A new contest opens soon — check back shortly.';
  } else if (entryCount < ENTRY_COUNT_DISPLAY_THRESHOLD) {
    statusText = `Entries are open — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left to enter and get votes.`;
  } else {
    statusText = `${entryCount} cats entered this round — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left to vote.`;
  }

  return {
    statusText,
    contestId: contest ? contest.id : null,
    contestLabel: contest ? contest.label : null,
    // Only leaves the server once it's actually a flattering number — same
    // rule statusText follows, applied to the raw JSON too, not just the
    // rendered copy (a low real count is nobody's business either way).
    entryCount: entryCount >= ENTRY_COUNT_DISPLAY_THRESHOLD ? entryCount : null,
    daysLeft,
    lastWinner: winnerCat,
  };
}

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
// Bakes real contest status, the last winner, the full product catalog
// (with JSON-LD), and any admin-uploaded background photos into the HTML
// the server sends — so a crawler that never runs script.js still sees the
// site's actual content, not empty containers. script.js re-fills the same
// containers on load for real visitors; see seo.js's header comment.
async function renderIndexHtml() {
  let html = fs.readFileSync(INDEX_PATH, 'utf8');

  const { statusText, lastWinner, contestId } = await getContestStatus();
  html = seo.fillEmpty(html, 'contestStatus', seo.escapeHtml(statusText));
  if (lastWinner) {
    html = seo.fillEmpty(html, 'currentRibbon', seo.escapeHtml('Most recent Cat of the Month'));
    html = seo.fillEmpty(html, 'winnerName', seo.escapeHtml(lastWinner.cat_name));
    html = seo.setAttr(html, 'winnerPhoto', 'src', lastWinner.photo_path);
    html = seo.setAttr(html, 'winnerPhoto', 'alt', `${lastWinner.cat_name}, Cat of the Month`);
    html = seo.revealHidden(html, 'winnerPhoto');
    html = seo.fillEmpty(
      html,
      'winnerBlurb',
      seo.escapeHtml('Chosen as Cat of the Month by real public vote.')
    );
  } else if (contestId) {
    // No round has closed yet — instead of a dead-end "check back soon",
    // show a few of this round's real entries (random, no vote counts —
    // same hidden-tally rule as the vote page) so there's something to
    // click on the very first round, not just an empty promise.
    const teaserEntries = await db.all(
      `SELECT id, cat_name, photo_path FROM submissions WHERE contest_id = ? AND disqualified = 0 ORDER BY RANDOM() LIMIT 6`,
      [contestId]
    );
    if (teaserEntries.length > 0) {
      html = seo.fillEmpty(html, 'currentTeaser', seo.renderEntryTeaser(teaserEntries));
    }
  }

  const products = await getProductsWithMedia('all');
  html = seo.fillEmpty(html, 'customGrid', seo.renderProductCards(products));
  html = seo.injectIntoHead(
    html,
    `<script type="application/ld+json">${seo.productsJsonLd(products, BASE_URL)}</script>`
  );

  const slides = await db.all(`SELECT image_path FROM background_slides ORDER BY position ASC, id ASC`);
  if (slides.length > 0) {
    html = seo.fillEmpty(html, 'heroSlides', seo.renderHeroSlides(slides.map((s) => s.image_path)));
  }

  const originals = await db.all(
    `SELECT image_path, cat_name FROM featured_originals ORDER BY position ASC, id ASC`
  );
  if (originals.length > 0) {
    html = seo.fillEmpty(html, 'originalsGrid', seo.renderOriginals(originals));
    html = html.replace('id="originalsGrid" hidden', 'id="originalsGrid"');
    html = html.replace('id="originalsEmpty"', 'id="originalsEmpty" hidden');
  }

  // og:image/twitter:image — a real admin-uploaded photo (hero background,
  // falling back to an original portrait) or nothing at all, same
  // never-fake-a-placeholder rule as everywhere else. Without one, shared
  // links preview with just title/description text, which is the honest
  // current default until at least one photo is uploaded in admin.html.
  const previewImagePath = (slides[0] && slides[0].image_path) || (originals[0] && originals[0].image_path);
  if (previewImagePath) {
    const previewImageUrl = previewImagePath.startsWith('http') ? previewImagePath : `${BASE_URL}${previewImagePath}`;
    // Replaces the static page's default card (og-default.png) rather than
    // adding a second og:image, which crawlers resolve unpredictably. The
    // default's fixed 1200x630 size tags are dropped since a photo's differ.
    html = swapPreviewImage(html, previewImageUrl);
  }

  const blockRows = await db.all(`SELECT * FROM site_blocks`);
  const blocksBySlot = Object.fromEntries(blockRows.map((r) => [r.slot, r]));

  const starburst = blocksBySlot.starburst;
  if (starburst && starburst.text) {
    html = seo.fillEmpty(html, 'promoStarburstText', seo.escapeHtml(starburst.text));
    if (starburst.color) {
      html = seo.setAttr(html, 'promoStarburst', 'style', `background:${starburst.color}`);
    }
    html = seo.revealHidden(html, 'promoStarburst');
  }

  let anyFeatureBlockUsed = false;
  for (const [slot, elId] of [['feature_1', 'featureBlock1'], ['feature_2', 'featureBlock2']]) {
    const b = blocksBySlot[slot];
    if (!b || (!b.text && !b.image_path)) continue;
    anyFeatureBlockUsed = true;
    if (b.text) html = seo.fillEmpty(html, `${elId}Text`, seo.escapeHtml(b.text));
    if (b.image_path) {
      html = seo.setAttr(html, `${elId}Img`, 'src', b.image_path);
      html = seo.revealHidden(html, `${elId}Img`);
    }
    html = seo.revealHidden(html, elId);
  }
  if (anyFeatureBlockUsed) html = seo.revealHidden(html, 'featureBlocks');

  const footerImages = await db.all(
    `SELECT image_path FROM footer_strip_images ORDER BY position ASC, id ASC`
  );
  if (footerImages.length > 0) {
    html = seo.fillEmpty(html, 'footerStrip', seo.renderFooterStrip(footerImages.map((f) => f.image_path)));
    html = seo.revealHidden(html, 'footerStrip');
  }

  const liveSettings = await db.get(`SELECT * FROM live_stream_settings WHERE key = 'main'`);
  if (liveSettings && liveSettings.enabled) {
    const pastSessions = await db.all(
      `SELECT title, session_date, video_url FROM live_sessions ORDER BY position ASC, id DESC`
    );
    const screenInner = (liveSettings.is_live && liveSettings.embed_url)
      ? `<iframe src="${seo.escapeHtml(liveSettings.embed_url)}" title="Live painting session" allow="autoplay; encrypted-media" allowfullscreen loading="lazy"></iframe>`
      : seo.renderLiveOffline({ nextSessionAt: liveSettings.next_session_at, lastSession: pastSessions[0] || null });
    html = seo.fillEmpty(html, 'liveScreen', screenInner);

    if (pastSessions.length > 0) {
      html = seo.fillEmpty(html, 'pastSessionsList', seo.renderPastSessions(pastSessions));
      html = seo.revealHidden(html, 'pastSessionsList');
      html = html.replace('id="pastSessionsEmpty"', 'id="pastSessionsEmpty" hidden');
    }
    html = seo.revealHidden(html, 'liveSessions');
  }

  return html;
}

app.get(['/', '/index.html'], async (req, res, next) => {
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(await renderIndexHtml());
  } catch (err) {
    console.error('[render] index prerender failed, falling back to static file:', err.message);
    next(); // let express.static below serve the plain file
  }
});

// One indexable page per product, plus a /shop index — see the /shop
// section of seo.js. Unknown or switched-off products get a noindex 404.
app.get('/shop', async (req, res, next) => {
  try {
    const products = await liveProducts();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(seo.renderShopIndex({ products, baseUrl: BASE_URL, freeShippingUsd: orderEconomics.FREE_SHIPPING_THRESHOLD_USD }));
  } catch (err) {
    console.error('[render] /shop failed:', err.message);
    next(err);
  }
});

app.get('/shop/:id', async (req, res, next) => {
  try {
    const products = await liveProducts();
    const product = products.find((p) => p.id === req.params.id);
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!product) return res.status(404).send(seo.renderShopNotFound());
    res.send(seo.renderProductPage({
      product,
      others: products.filter((p) => p.id !== product.id),
      baseUrl: BASE_URL,
      freeShippingUsd: orderEconomics.FREE_SHIPPING_THRESHOLD_USD,
    }));
  } catch (err) {
    console.error('[render] /shop/:id failed:', err.message);
    next(err);
  }
});

// Late static: only reached for the three server-rendered paths skipped
// above, as the fallback when a prerender throws.
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
// Contest entries need a phone number so a winner can be reached (owner's
// call, 2026-09-30). Returns a normalized +<digits> string, or null if it
// doesn't look like a real number. A bare 10-digit number is taken as US.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (!s.startsWith('+') && digits.length === 10) return `+1${digits}`;
  if (!s.startsWith('+') && digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (s.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Add (or re-activate) an explicit marketing-list opt-in. A fresh opt-in
// always clears any prior unsubscribed_at — a new affirmative "yes" is a
// new consent event, not something an old unsubscribe should keep hidden.
// Doesn't check the suppressions table here: recording that someone
// opted in is harmless bookkeeping even if they're separately suppressed
// from all mail; mailer.js's isSuppressed check is what actually decides
// whether an address gets emailed, and stays the single source of truth
// for that.
async function subscribeToMarketingList(email, source, ipHash) {
  await db.run(
    `INSERT INTO marketing_subscribers (email, source, subscribed_at, unsubscribed_at, ip_hash) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT (email) DO UPDATE SET source = EXCLUDED.source, subscribed_at = EXCLUDED.subscribed_at, unsubscribed_at = NULL`,
    [String(email).toLowerCase(), source, new Date().toISOString(), ipHash || null]
  );
}

// Whatever a visitor's ?utm_campaign= link said, captured client-side into
// a cookie (see script.js) and sent along with entry/order requests — a
// free-text label matched case-insensitively against ad_campaigns.name at
// reporting time (see /api/admin/marketing/campaigns), not a foreign key,
// so an order never fails to save just because a campaign name doesn't
// exist yet or was typed slightly differently in the ad platform.
function cleanUtmCampaign(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  return cleaned || null;
}

// ---------- contest lifecycle (open entry, real public voting) ----------

// Anonymous voter identity: a random token in a long-lived first-party
// cookie. This is the primary key the UNIQUE(submission_id, voter_token)
// constraint on `votes` enforces one-vote-per-cat against — not bulletproof
// (clearing cookies gets a fresh identity), but combined with the per-IP
// rate limit below it's the same baseline real small contest operators use
// without standing up full device fingerprinting.
function getOrSetVoterToken(req, res) {
  const existing = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('whiskr_voter='));
  if (existing) return decodeURIComponent(existing.split('=')[1]);

  const token = crypto.randomBytes(24).toString('hex');
  res.append(
    'Set-Cookie',
    `whiskr_voter=${encodeURIComponent(token)}; Max-Age=${365 * 24 * 60 * 60}; Path=/; HttpOnly; SameSite=Lax`
  );
  return token;
}

// Never persist a raw IP — only a salted hash, just enough to rate-limit and
// detect a single source hammering the vote endpoint.
function hashIp(ip) {
  return crypto.createHash('sha256').update(`${IP_HASH_SALT}:${ip}`).digest('hex');
}

// The one contest entries/votes currently attach to. Lazily opens the next
// one the moment the previous closes (or on first-ever request) — entry
// should never hit a dead end, same "always open" spirit as the print shop.
//
// Rounds run by calendar month in Central time (owner's call, 2026-09-30):
// a round closes at midnight CT as its month ends, and is labelled with that
// month, so "October 2026" is always exactly one round. Before this, rounds
// ran a fixed 30 days from whenever they opened and took the opening
// month's name, so they drifted and two rounds could share a month name.
//
// A round that has passed its closes_at but not yet been tallied (the daily
// cron does that, a few hours after midnight) is treated as closed here: a
// new entry goes into the next round rather than one whose voting is over.
// Both rounds are briefly 'open' in that window; every reader takes the
// newest (ORDER BY id DESC), and the cron tallies the older one by id.
async function getOrOpenCurrentContest() {
  const open = await db.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (open && new Date(open.closes_at) > new Date()) return open;

  // Serialized so two simultaneous first entries of a month can't each open
  // a round. Re-checked inside the lock for the same reason.
  const id = await db.transaction(async (tx) => {
    await tx.run(`SELECT pg_advisory_xact_lock(hashtext('whiskr-open-contest'))`);
    const latest = await tx.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
    if (latest && new Date(latest.closes_at) > new Date()) return latest.id;

    const now = new Date();
    const { closesAt, label } = nextRoundWindow(now);
    const info = await tx.run(
      `INSERT INTO contests (label, opens_at, closes_at, status, created_at) VALUES (?, ?, ?, 'open', ?) RETURNING id`,
      [label, now.toISOString(), closesAt.toISOString(), now.toISOString()]
    );
    console.log(`[contest] Opened "${label}" (#${info.rows[0].id}), closes ${closesAt.toISOString()}`);
    return info.rows[0].id;
  });
  return db.get(`SELECT * FROM contests WHERE id = ?`, [id]);
}

const CONTEST_TIME_ZONE = 'America/Chicago';
// A round opened with fewer than this many days left in the month runs to
// the end of the NEXT month instead, rather than being a two-day round.
const MIN_ROUND_DAYS = 7;

// Year/month (month 0-11) of `date` as seen in Central time.
function monthInContestZone(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: CONTEST_TIME_ZONE, year: 'numeric', month: 'numeric' })
    .formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === 'year').value),
    month: Number(parts.find((p) => p.type === 'month').value) - 1,
  };
}

// The UTC instant of midnight Central time at the start of the given
// month (month may be 12, meaning January of the next year). CT is UTC-5
// or UTC-6; whichever of the two actually reads as midnight in CT is right.
function midnightInContestZone(year, month) {
  for (const offsetHours of [5, 6]) {
    const candidate = new Date(Date.UTC(year, month, 1, offsetHours));
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: CONTEST_TIME_ZONE, hour: 'numeric', hourCycle: 'h23' })
      .format(candidate);
    if (Number(hour) === 0) return candidate;
  }
  return new Date(Date.UTC(year, month, 1, 6));
}

function nextRoundWindow(now) {
  const { year, month } = monthInContestZone(now);
  let closesAt = midnightInContestZone(year, month + 1);
  let labelMonth = new Date(Date.UTC(year, month, 15));
  if (closesAt - now < MIN_ROUND_DAYS * 24 * 60 * 60 * 1000) {
    closesAt = midnightInContestZone(year, month + 2);
    labelMonth = new Date(Date.UTC(year, month + 1, 15));
  }
  const label = labelMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { closesAt, label };
}

// One way of stating a round's close, used by every page and email so they
// can't disagree ("October 31 at 11:59 p.m. CT"). A midnight close is shown
// as 11:59 p.m. the day before, which is how people read "end of the day".
function formatContestClose(closesAtIso) {
  let when = new Date(closesAtIso);
  const hm = new Intl.DateTimeFormat('en-US', { timeZone: CONTEST_TIME_ZONE, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .format(when);
  if (hm === '00:00') when = new Date(when.getTime() - 60 * 1000);
  const day = when.toLocaleDateString('en-US', { timeZone: CONTEST_TIME_ZONE, month: 'long', day: 'numeric' });
  const time = when
    .toLocaleTimeString('en-US', { timeZone: CONTEST_TIME_ZONE, hour: 'numeric', minute: '2-digit' })
    .replace('AM', 'a.m.')
    .replace('PM', 'p.m.');
  return `${day} at ${time} CT`;
}

// Every contest's own #1 vote-getter directly wins the grand prize — an
// original hand-painted portrait — the instant the contest closes. No
// separate vote: the real public vote that just decided the round IS the
// decision, full stop (see awardPainting below). Ties broken by earliest
// entry — deterministic, no coin flips to dispute. Everyone else gets
// their real final placement and a nudge toward a solo print of their own
// cat; there's no second "featured" tier anymore — see the 2026-09-11
// simplification note in docs/audit-assembly.md for why.
async function tallyAndCloseContest(contestId) {
  const contest = await db.get(`SELECT * FROM contests WHERE id = ?`, [contestId]);
  if (!contest || contest.status !== 'open') return null;

  const ranked = await db.all(
    `SELECT * FROM submissions WHERE contest_id = ? AND disqualified = 0 ORDER BY vote_count DESC, created_at ASC`,
    [contestId]
  );

  if (ranked.length === 0) {
    await db.run(`UPDATE contests SET status = 'completed' WHERE id = ?`, [contestId]);
    console.warn(`[contest] #${contestId} closed with zero eligible entries — nothing to rank.`);
    await getOrOpenCurrentContest();
    return null;
  }

  // Internal record of "this round's results" — kept exactly as before
  // (top CONTEST_WINNERS_COUNT grouped together, #1 as winner_submission_id)
  // since /api/status's homepage "recent winner" lookup still reads it.
  // Nothing public promotes or sells this grouping; it's just how a round's
  // outcome is stored.
  const winnersCount = Math.min(CONTEST_WINNERS_COUNT, ranked.length);
  const winners = ranked.slice(0, winnersCount);

  const groupId = await db.transaction(async (tx) => {
    // Claim the close first: a second concurrent run finds the round no
    // longer 'open' and stops here, so nobody is emailed or awarded twice.
    const claimed = await tx.run(`UPDATE contests SET status = 'closing' WHERE id = ? AND status = 'open'`, [contestId]);
    if (claimed.changes === 0) return null;
    for (let i = 0; i < ranked.length; i++) {
      await tx.run(`UPDATE submissions SET final_rank = ? WHERE id = ?`, [i + 1, ranked[i].id]);
    }
    const info = await tx.run(
      `INSERT INTO groups (status, sealed_at, voting_ends_at, winner_submission_id) VALUES ('completed', ?, ?, ?) RETURNING id`,
      [contest.opens_at, contest.closes_at, winners[0].id]
    );
    const gid = info.rows[0].id;
    for (const w of winners) {
      await tx.run(`UPDATE submissions SET group_id = ? WHERE id = ?`, [gid, w.id]);
    }
    await tx.run(`UPDATE contests SET status = 'completed', group_id = ? WHERE id = ?`, [gid, contestId]);
    return gid;
  });
  if (!groupId) return null;

  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    const rank = i + 1;
    try {
      if (rank === 1) {
        const { yearAwardId, claimDeadline } = await awardPainting(s, `${contest.label} winner`);
        await mailer.sendWinnerEmail({
          email: s.email, catName: s.cat_name,
          claimUrl: claimUrlFor(yearAwardId, s.email), claimDeadline,
        });
      } else {
        await mailer.sendFinalRankEmail({
          email: s.email, catName: s.cat_name, rank, totalEntries: ranked.length,
          shopUrl: `${BASE_URL}/#shop-custom`,
          discount: issueDiscount(s.email, FINAL_RANK_DISCOUNT_HOURS),
        });
      }
      await db.run(`UPDATE submissions SET notified_result = 1, notified_rank = 1 WHERE id = ?`, [s.id]);
    } catch (err) {
      console.error(`[mailer] result email failed for submission ${s.id}:`, err.message);
    }
  }

  console.log(`[contest] #${contestId} closed. ${ranked.length} entries, winner: ${winners[0].cat_name} (submission ${winners[0].id}).`);
  await getOrOpenCurrentContest();
  return groupId;
}

// Records the grand-prize win the instant a contest's #1 is decided, as a
// 'completed' year_awards row. (The table name is historical: it once held a
// separate Cat of the Year vote. It now holds each month's painting winner,
// their claim deadline and their shipping address.)
async function awardPainting(winnerSubmission, label) {
  const now = new Date().toISOString();
  // Owner's call (2026-09-30): winners are promised 6–8 weeks, counted from
  // when they send a mailing address. The stored deadline is the outer end
  // (8 weeks from the round closing) and is only an admin tracking date —
  // the winner email states the 6–8 week window, not this date.
  const deadline = new Date(Date.now() + 8 * 7 * 24 * 60 * 60 * 1000).toISOString();
  const claimDeadline = new Date(Date.now() + CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const info = await db.run(
    `INSERT INTO year_awards (label, opens_at, closes_at, status, winner_submission_id, sculpture_deadline, created_at, claim_deadline, offered_submission_ids)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?) RETURNING id`,
    [label, now, now, winnerSubmission.id, deadline, now, claimDeadline, JSON.stringify([winnerSubmission.id])]
  );
  await db.run(
    `INSERT INTO year_award_finalists (year_award_id, submission_id, vote_count) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [info.rows[0].id, winnerSubmission.id, winnerSubmission.vote_count]
  );
  return { yearAwardId: info.rows[0].id, deadline, claimDeadline };
}

// Daily: remind a winner a week before their claim deadline, and pass an
// unclaimed prize to the next-highest vote-getter in that round once the
// deadline is gone (rules.html, Prize). Each new holder gets a fresh 30
// days. If nobody is left to offer it to, the award is marked 'unclaimed'.
// ADMIN_EMAIL hears about every pass.
async function passUnclaimedPrizes() {
  const awards = await db.all(
    `SELECT ya.*, s.email, s.cat_name, s.contest_id
       FROM year_awards ya JOIN submissions s ON s.id = ya.winner_submission_id
      WHERE ya.status = 'completed' AND ya.address_submitted_at IS NULL AND ya.label LIKE '% winner'`
  );
  for (const a of awards) {
    try {
      const deadline = claimDeadlineOf(a);
      const msLeft = new Date(deadline) - Date.now();

      if (msLeft > 0) {
        if (!a.claim_reminder_sent_at && msLeft <= CLAIM_REMINDER_DAYS_BEFORE * 24 * 60 * 60 * 1000) {
          await mailer.sendClaimReminderEmail({
            email: a.email, catName: a.cat_name, claimUrl: claimUrlFor(a.id, a.email), claimDeadlineLabel: formatClaimDate(deadline),
          });
          await db.run(`UPDATE year_awards SET claim_reminder_sent_at = ? WHERE id = ?`, [new Date().toISOString(), a.id]);
        }
        continue;
      }

      let offered = [];
      try { offered = JSON.parse(a.offered_submission_ids || '[]'); } catch (_) {}
      if (!offered.includes(a.winner_submission_id)) offered.push(a.winner_submission_id);
      const ranked = await db.all(
        `SELECT * FROM submissions WHERE contest_id = ? AND disqualified = 0 ORDER BY vote_count DESC, created_at ASC`,
        [a.contest_id]
      );
      const next = ranked.find((r) => !offered.includes(r.id));
      const roundLabel = String(a.label || '').replace(/ winner$/, '');

      if (!next) {
        await db.run(`UPDATE year_awards SET status = 'unclaimed' WHERE id = ?`, [a.id]);
        if (process.env.ADMIN_EMAIL) {
          await mailer.sendMail({
            to: process.env.ADMIN_EMAIL,
            subject: `Prize unclaimed: ${roundLabel}`,
            text: `Nobody claimed the ${roundLabel} painting before their deadline, and there is no one left in that round to offer it to.`,
            html: `<p>Nobody claimed the ${seo.escapeHtml(roundLabel)} painting before their deadline, and there is no one left in that round to offer it to.</p>`,
          }).catch(() => {});
        }
        continue;
      }

      const newDeadline = new Date(Date.now() + CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      offered.push(next.id);
      await db.run(
        `UPDATE year_awards SET winner_submission_id = ?, claim_deadline = ?, claim_reminder_sent_at = NULL, offered_submission_ids = ? WHERE id = ?`,
        [next.id, newDeadline, JSON.stringify(offered), a.id]
      );
      await db.run(`INSERT INTO year_award_finalists (year_award_id, submission_id, vote_count) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [
        a.id, next.id, next.vote_count,
      ]);
      await mailer.sendPrizePassedEmail({
        email: next.email, catName: next.cat_name, rank: next.final_rank || ranked.indexOf(next) + 1, roundLabel,
        claimUrl: claimUrlFor(a.id, next.email), claimDeadlineLabel: formatClaimDate(newDeadline),
      });
      console.log(`[claim] ${roundLabel}: unclaimed by ${a.cat_name}, passed to ${next.cat_name} (submission ${next.id}).`);
      if (process.env.ADMIN_EMAIL) {
        await mailer.sendMail({
          to: process.env.ADMIN_EMAIL,
          subject: `Prize passed to runner-up: ${roundLabel}`,
          text: `${a.cat_name}'s owner didn't claim the ${roundLabel} painting by ${formatClaimDate(deadline)}, so it was offered to ${next.cat_name} (${next.email}${next.phone ? ', ' + next.phone : ''}), who now has until ${formatClaimDate(newDeadline)} to claim it.`,
          html: `<p>${seo.escapeHtml(a.cat_name)}'s owner didn't claim the ${seo.escapeHtml(roundLabel)} painting by ${formatClaimDate(deadline)}, so it was offered to <strong>${seo.escapeHtml(next.cat_name)}</strong> (${seo.escapeHtml(next.email)}${next.phone ? ', ' + seo.escapeHtml(next.phone) : ''}), who now has until ${formatClaimDate(newDeadline)} to claim it.</p>`,
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[claim] pass/reminder failed for award ${a.id}:`, err.message);
    }
  }
}

// Daily cron entry point — closes any contest whose closes_at has passed.
// Normally there's at most one (contests don't overlap), but this handles
// more than one due safely if the cron was down for a while.
async function runDueContestClose() {
  const nowIso = new Date().toISOString();
  const due = await db.all(`SELECT id FROM contests WHERE status = 'open' AND closes_at <= ?`, [nowIso]);
  for (const c of due) {
    await tallyAndCloseContest(c.id);
  }
}

// The "gamified" urgency loop, done without paid votes: once a day, for
// the currently open contest, compute everyone's live rank and email
// anyone whose position has genuinely worsened since their last alert —
// either by RANK_DROP_THRESHOLD+ places, or by crossing out of the winner
// zone entirely. The call to action is "share your link," which is free;
// there is deliberately no "buy votes to reclaim your spot" path here (see
// docs/audit-assembly.md for why real-money vote sales were dropped).
// last_notified_rank is what keeps this from re-emailing someone every
// single day just because their rank wiggled by one.
async function sendRankDropAlerts() {
  const contest = await db.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (!contest) return;

  const ranked = await db.all(
    `SELECT * FROM submissions WHERE contest_id = ? AND disqualified = 0 ORDER BY vote_count DESC, created_at ASC`,
    [contest.id]
  );

  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    const rank = i + 1;
    const baseline = s.last_notified_rank;

    // First time this entrant has ever been checked: record where they
    // started without emailing anything — there's nothing to compare a
    // drop against yet, and ranks are noisy in the first hours after entry
    // as other people join, not a real signal worth alerting on.
    if (baseline === null) {
      await db.run(`UPDATE submissions SET last_notified_rank = ? WHERE id = ?`, [rank, s.id]);
      continue;
    }

    const droppedEnoughPlaces = rank >= baseline + RANK_DROP_THRESHOLD;
    const droppedOutOfWinnerZone = baseline <= CONTEST_WINNERS_COUNT && rank > CONTEST_WINNERS_COUNT;
    if (!droppedEnoughPlaces && !droppedOutOfWinnerZone) continue;

    const voteUrl = `${BASE_URL}/vote.html?cat=${s.id}`;
    try {
      await mailer.sendRankDropEmail({ email: s.email, catName: s.cat_name, rank, voteUrl, closesAt: contest.closes_at });
      await db.run(`UPDATE submissions SET last_notified_rank = ? WHERE id = ?`, [rank, s.id]);
    } catch (err) {
      console.error(`[mailer] rank-drop alert failed for submission ${s.id}:`, err.message);
    }
  }
}

// Emails a signed review-request link to anyone whose order was paid (and,
// for custom orders, ideally already shipped) at least REVIEW_REQUEST_DELAY_DAYS
// ago and hasn't been asked yet. This is the only path reviews ever get
// solicited through — there is no bulk-import or seed-data path, on purpose.
async function sendDueReviewRequests() {
  const cutoff = new Date(Date.now() - REVIEW_REQUEST_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Review requests used to run on a timer from ORDER CREATION, which
  // meant a parcel still in transit -- or lost outright -- still got a
  // "how did we do?" email. Now the clock starts at delivery.
  //
  // The fallback matters as much as the fix: when Printful isn't
  // configured no shipment data will ever arrive, so requiring delivery
  // there would silently stop review requests altogether. In that case
  // only, the old created_at behaviour stands.
  const deliveredCutoff = new Date(
    Date.now() - REVIEW_DELAY_AFTER_DELIVERY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const dueCustom = printful.configured()
    ? await db.all(
        `SELECT * FROM custom_orders
          WHERE status IN ('paid','submitted_to_printful')
            AND review_requested_at IS NULL
            AND delivered_at IS NOT NULL
            AND delivered_at <= ?`,
        [deliveredCutoff]
      )
    : await db.all(
        `SELECT * FROM custom_orders
          WHERE status IN ('paid','submitted_to_printful')
            AND review_requested_at IS NULL
            AND created_at <= ?`,
        [cutoff]
      );
  for (const o of dueCustom) {
    const product = productCatalog.getProduct(o.product_id);
    const token = reviewLink.tokenFor('custom', o.id, o.email);
    const reviewUrl = `${BASE_URL}/review.html?type=custom&id=${o.id}&email=${encodeURIComponent(o.email)}&token=${token}`;
    try {
      await mailer.sendReviewRequest({
        email: o.email,
        itemLabel: product ? product.name : 'Whiskr order',
        reviewUrl,
      });
      await db.run(`UPDATE custom_orders SET review_requested_at = ? WHERE id = ?`, [new Date().toISOString(), o.id]);
    } catch (err) {
      console.error(`[mailer] review request failed for custom order ${o.id}:`, err.message);
    }
  }
}

// ---------- API ----------

// Submit a cat photo + email into the current open contest — free, always
// open, no batch to wait for. Winning depends entirely on votes from the
// public, not a queue position.
app.post('/api/submissions', upload.single('photo'), async (req, res) => {
  try {
    const { email, catName, photoRights } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'A valid phone number is required, so we can reach you if your cat wins.' });
    }
    const ownerName = String(req.body.ownerName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    if (!ownerName) {
      return res.status(400).json({ error: 'Please enter your name, so we know who to contact if your cat wins.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A photo is required.' });
    }
    // Photo rights: before showing a stranger's photo publicly — on the
    // vote page, in a share card, on Whiskr's social accounts — we need
    // affirmative confirmation the submitter owns/has rights to it. The
    // entrant keeps ownership and this grant is contest-only: it does NOT
    // cover selling products made from the photo (see the Photo rights
    // section of public/rules.html, which is the authoritative text this
    // checkbox summarizes). Don't widen either one without widening both.
    if (photoRights !== 'on' && photoRights !== 'true') {
      return res.status(400).json({ error: 'You must confirm you own the rights to this photo.' });
    }
    const ipHash = hashIp(req.ip);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ipCount = await db.get(`SELECT COUNT(*) AS c FROM submissions WHERE ip_hash = ? AND created_at >= ?`, [
      ipHash, dayAgo,
    ]);
    if (Number(ipCount.c) >= SUBMISSION_LIMIT_PER_IP_PER_DAY) {
      return res.status(429).json({ error: 'Too many entries from this connection today — try again tomorrow.' });
    }

    // Strip newlines so a crafted cat name can't inject extra lines into
    // the plaintext/subject of outgoing emails.
    const name = (catName || 'Anonymous Cat').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    const { width, height, lowResolution } = await checkImageQuality(req.file.buffer);
    const photoPath = await storePhoto(req.file);
    const shareImagePath = await generateShareCard(req.file.buffer, name);
    const utmCampaign = cleanUtmCampaign(req.body.utmCampaign);
    const now = new Date().toISOString();
    const contest = await getOrOpenCurrentContest();

    const info = await db.run(
      `INSERT INTO submissions (email, phone, owner_name, cat_name, photo_path, created_at, photo_rights_consent_at, contest_id, photo_width, photo_height, low_resolution, share_image_path, utm_campaign, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [email, phone, ownerName, name, photoPath, now, now, contest.id, width, height, lowResolution, shareImagePath, utmCampaign, ipHash]
    );
    const submissionId = info.rows[0].id;
    const voteUrl = `${BASE_URL}/vote.html?cat=${submissionId}`;
    const statusUrl = `${BASE_URL}/status.html?cat=${submissionId}&email=${encodeURIComponent(email)}&token=${statusToken.tokenFor(submissionId, email)}`;

    // A time-limited discount on the evergreen print shop — the honest
    // version of a "pre-order mockup": no fake 3D render, just a real
    // incentive to buy a print of the photo they just uploaded while the
    // moment (and the discount) is still fresh.
    const discount = issueDiscount(email, ENTRY_DISCOUNT_HOURS);

    try {
      await mailer.sendEntryConfirmation({
        email, catName: name, voteUrl, statusUrl, closesAt: contest.closes_at, discount, shareImageUrl: shareImagePath,
      });
      await db.run(`UPDATE submissions SET notified_entry = 1 WHERE id = ?`, [submissionId]);
    } catch (err) {
      console.error(`[mailer] entry confirmation failed for submission ${submissionId}:`, err.message);
    }

    // Explicit, unchecked-by-default opt-in (see the marketing_optIn
    // checkbox on the entry form) — separate from the confirmation email
    // above, which every entrant gets regardless since it's transactional,
    // not marketing.
    if (req.body.marketingOptIn === 'on' || req.body.marketingOptIn === 'true') {
      await subscribeToMarketingList(email, 'entry_form');
    }

    // Ad conversion tracking — never blocks or fails the entry itself.
    // eventId is shared with the matching client-side fbq('track','Lead')
    // call (see public/script.js) so Meta dedupes the two into one signal.
    const leadEventId = `lead-submission-${submissionId}`;
    metaConversions
      .sendEvent({ eventName: 'Lead', eventId: leadEventId, email, eventSourceUrl: BASE_URL })
      .catch((err) => console.error('[meta capi] Lead event failed:', err.message));

    // The signed thank-you page. Same token as statusUrl, so this link keeps
    // working when it arrives again in the confirmation email days later.
    const thanksUrl = `${BASE_URL}/thanks?cat=${submissionId}&email=${encodeURIComponent(email)}&token=${statusToken.tokenFor(submissionId, email)}`;

    res.json({
      ok: true, submissionId, voteUrl, statusUrl, thanksUrl, lowResolution, width, height, discount, shareImageUrl: shareImagePath,
      metaEventId: leadEventId,
    });
  } catch (err) {
    if (err.uploadRejected) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end — please try again, or email contest@whiskr.lol.' });
  }
});

// Public: the currently open contest and its entrants (no vote counts —
// see the vote endpoint below for why tallies stay hidden until close).
// Random order per request so late entrants get equal shelf space instead
// of always scrolling to the bottom.
app.get('/api/contest/current', async (req, res) => {
  // Opens the round if none is open, or rolls to the next one if the open
  // round is past its close but not yet tallied — so the vote page never
  // shows a round whose voting is already over. Entry is always open.
  const contest = await getOrOpenCurrentContest();
  if (!contest) return res.json({ contest: null, entries: [] });
  const entries = await db.all(
    `SELECT id, cat_name, photo_path, share_image_path FROM submissions WHERE contest_id = ? AND disqualified = 0 ORDER BY RANDOM()`,
    [contest.id]
  );
  res.json({
    contest: {
      id: contest.id, label: contest.label, opensAt: contest.opens_at, closesAt: contest.closes_at,
      closesLabel: formatContestClose(contest.closes_at),
    },
    entries,
  });
});

// An entrant's private lookup of their own standing — the safe alternative
// to a public real-time leaderboard (which stays hidden on purpose; see the
// comment on /api/vote). Token-gated per submission so nobody can look up
// anyone else's. While the contest is still open this computes a LIVE rank
// on the fly (final_rank isn't set until close); once closed it reports the
// permanent final_rank instead.
// ---------- prize claims ----------
// A winner claims their painting by giving a mailing address. Two ways in:
// the signed link (claimUrlFor) in their winner email and on their status
// page, or checking back at /claim and proving it's them with the email and
// phone number they entered with. Either way they get the same signed
// award+token pair, which is all POST /api/claim accepts.
function claimUrlFor(awardId, email) {
  return `${BASE_URL}/claim?award=${awardId}&token=${claimToken.tokenFor(awardId, email)}`;
}

const CLAIM_WINDOW_DAYS = 30;
const CLAIM_REMINDER_DAYS_BEFORE = 7;

// The deadline for the award's current holder. Rows from before the claim
// window existed have none stored; they get created_at + 30 days.
function claimDeadlineOf(row) {
  if (row.claim_deadline) return row.claim_deadline;
  return new Date(new Date(row.created_at).getTime() + CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
function claimExpired(row) {
  return !row.address_submitted_at && new Date(claimDeadlineOf(row)) <= new Date();
}
function formatClaimDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' });
}

async function loadClaim(awardId) {
  return db.get(
    `SELECT ya.id, ya.label, ya.shipping_name, ya.shipping_address, ya.address_submitted_at, ya.claim_deadline, ya.created_at,
            s.email, s.phone, s.owner_name, s.cat_name, s.photo_path
     FROM year_awards ya JOIN submissions s ON s.id = ya.winner_submission_id
     WHERE ya.id = ?`,
    [awardId]
  );
}

function claimPayload(row) {
  let address = null;
  try { address = row.shipping_address ? JSON.parse(row.shipping_address) : null; } catch (_) {}
  return {
    award: row.id,
    token: claimToken.tokenFor(row.id, row.email),
    catName: row.cat_name,
    photoPath: row.photo_path,
    roundLabel: String(row.label || '').replace(/ winner$/, ''),
    claimed: Boolean(row.address_submitted_at),
    claimDeadline: claimDeadlineOf(row),
    claimDeadlineLabel: formatClaimDate(claimDeadlineOf(row)),
    expired: claimExpired(row),
    shippingName: row.shipping_name || row.owner_name || '',
    address,
  };
}

// Checking back: email + phone must both match a winning entry. Rate-limited
// per connection (per warm instance — a best-effort brake on guessing, on
// top of needing both values right).
const claimLookupAttempts = new Map();
app.post('/api/claim/lookup', async (req, res) => {
  try {
    const ipHash = hashIp(req.ip);
    const now = Date.now();
    const recent = (claimLookupAttempts.get(ipHash) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= 10) {
      return res.status(429).json({ error: 'Too many tries — please wait an hour, or email us and we will sort it out.' });
    }
    recent.push(now);
    claimLookupAttempts.set(ipHash, recent);

    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);
    if (!isValidEmail(email) || !phone) {
      return res.status(400).json({ error: 'Enter the email and phone number you used when you entered your cat.' });
    }
    const row = await db.get(
      `SELECT ya.id FROM year_awards ya JOIN submissions s ON s.id = ya.winner_submission_id
       WHERE LOWER(s.email) = ? AND s.phone = ? ORDER BY ya.id DESC LIMIT 1`,
      [email, phone]
    );
    if (!row) {
      return res.status(404).json({
        error: "We couldn't find a winning entry with that email and phone number. Check they're the ones you entered with, or email us.",
      });
    }
    res.json(claimPayload(await loadClaim(row.id)));
  } catch (err) {
    console.error('[claim] lookup failed:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/claim', async (req, res) => {
  const awardId = Number(req.query.award);
  const row = Number.isInteger(awardId) && awardId > 0 ? await loadClaim(awardId) : null;
  if (row && !claimToken.verify(awardId, row.email, req.query.token)) {
    // A link sent to an earlier holder whose 30 days ran out: say so plainly
    // instead of calling their own email link "invalid".
    const award = await db.get(`SELECT offered_submission_ids, claim_deadline, created_at FROM year_awards WHERE id = ?`, [awardId]);
    let offered = [];
    try { offered = JSON.parse((award && award.offered_submission_ids) || '[]'); } catch (_) {}
    for (const sid of offered) {
      const prior = await db.get(`SELECT email FROM submissions WHERE id = ?`, [sid]);
      if (prior && prior.email !== row.email && claimToken.verify(awardId, prior.email, req.query.token)) {
        return res.status(410).json({
          error: "The 30-day claim period for this prize has ended, so under the contest rules it passed to the runner-up. Email contest@whiskr.lol if you think this is a mistake.",
        });
      }
    }
  }
  if (!row || !claimToken.verify(awardId, row.email, req.query.token)) {
    return res.status(403).json({ error: 'This claim link is invalid. Use the link from your winner email, or claim with your email and phone below.' });
  }
  res.json(claimPayload(row));
});

app.post('/api/claim', async (req, res) => {
  try {
    const awardId = Number(req.body.award);
    const row = Number.isInteger(awardId) && awardId > 0 ? await loadClaim(awardId) : null;
    if (!row || !claimToken.verify(awardId, row.email, req.body.token)) {
      return res.status(403).json({ error: 'This claim link is invalid.' });
    }
    // Past the 30-day window with no address on file: the prize has passed
    // (or is about to pass) to the runner-up, so a late claim can't take it
    // back. A winner who already claimed can still correct their address.
    if (claimExpired(row)) {
      return res.status(410).json({
        error: `The 30-day claim period for this prize ended on ${formatClaimDate(claimDeadlineOf(row))}. Email contest@whiskr.lol if you think this is a mistake.`,
      });
    }
    const clean = (v, max) => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
    const name = clean(req.body.name, 80);
    const address = {
      line1: clean(req.body.line1, 120),
      line2: clean(req.body.line2, 120),
      city: clean(req.body.city, 80),
      state: clean(req.body.state, 60),
      zip: clean(req.body.zip, 20),
      country: clean(req.body.country, 60) || 'United States',
    };
    if (!name || !address.line1 || !address.city || !address.state || !address.zip) {
      return res.status(400).json({ error: 'Please fill in your name, street address, city, state and ZIP code.' });
    }
    const now = new Date().toISOString();
    await db.run(
      `UPDATE year_awards SET shipping_name = ?, shipping_address = ?, address_submitted_at = ? WHERE id = ?`,
      [name, JSON.stringify(address), now, awardId]
    );

    const oneLine = [address.line1, address.line2, `${address.city}, ${address.state} ${address.zip}`, address.country].filter(Boolean).join(', ');
    if (process.env.ADMIN_EMAIL) {
      mailer
        .sendMail({
          to: process.env.ADMIN_EMAIL,
          subject: `Prize claimed: ${row.cat_name} (${String(row.label || '').replace(/ winner$/, '')})`,
          text: `${name} claimed the painting for ${row.cat_name}.\n\nShip to: ${name}, ${oneLine}\nEmail: ${row.email}\nPhone: ${row.phone || 'not given'}\n\nAlso in admin → Painting winners.`,
          html: `<p><strong>${seo.escapeHtml(name)}</strong> claimed the painting for <strong>${seo.escapeHtml(row.cat_name)}</strong>.</p><p>Ship to: ${seo.escapeHtml(name)}, ${seo.escapeHtml(oneLine)}<br>Email: ${seo.escapeHtml(row.email)}<br>Phone: ${seo.escapeHtml(row.phone || 'not given')}</p><p>Also in admin → Painting winners.</p>`,
        })
        .catch((err) => console.error('[claim] admin notify failed:', err.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[claim] save failed:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/my-status', async (req, res) => {
  const submissionId = Number(req.query.cat);
  const { email, token } = req.query;
  if (!statusToken.verify(submissionId, email, token)) {
    return res.status(403).json({ error: 'Invalid or missing status link.' });
  }
  const submission = await db.get(`SELECT * FROM submissions WHERE id = ?`, [submissionId]);
  if (!submission || String(submission.email).toLowerCase() !== String(email).toLowerCase()) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const contest = await db.get(`SELECT * FROM contests WHERE id = ?`, [submission.contest_id]);

  if (submission.disqualified) {
    return res.json({ catName: submission.cat_name, disqualified: true, reason: submission.disqualified_reason });
  }

  if (contest && contest.status === 'open') {
    const ranked = await db.all(
      `SELECT id FROM submissions WHERE contest_id = ? AND disqualified = 0 ORDER BY vote_count DESC, created_at ASC`,
      [contest.id]
    );
    const liveRank = ranked.findIndex((r) => r.id === submission.id) + 1;
    const referred = await db.get(`SELECT COUNT(*) AS c FROM votes WHERE referred_by_submission_id = ?`, [
      submission.id,
    ]);
    return res.json({
      catName: submission.cat_name,
      contestStatus: 'open',
      voteCount: submission.vote_count,
      liveRank,
      totalEntries: ranked.length,
      closesAt: contest.closes_at,
      closesLabel: formatContestClose(contest.closes_at),
      referredVotes: Number(referred.c),
    });
  }

  // Whoever currently holds the painting — the #1 vote-getter, or a
  // runner-up it passed to after an unclaimed 30 days — gets the link.
  let claimUrl = null;
  const award = await db.get(
    `SELECT id FROM year_awards WHERE winner_submission_id = ? AND status = 'completed' AND label LIKE '% winner' ORDER BY id DESC LIMIT 1`,
    [submission.id]
  );
  if (award) claimUrl = claimUrlFor(award.id, submission.email);
  return res.json({
    catName: submission.cat_name,
    contestStatus: 'completed',
    voteCount: submission.vote_count,
    finalRank: submission.final_rank,
    claimUrl,
  });
});

// Cast one vote for one cat. Anti-fraud layers, in order: contest must
// actually be open and the cat not disqualified; optional Turnstile CAPTCHA
// (only enforced once TURNSTILE_SECRET_KEY is configured — see README);
// a voter-cookie identity that can never vote for the same cat twice
// (UNIQUE constraint, not just an application check); and two independent
// rate limits (per voter identity, per IP) so neither alone is a single
// point of failure. None of this makes vote-buying impossible — nothing
// free does — it's what keeps a casual bot or script from being trivial.
app.post('/api/vote', async (req, res) => {
  try {
    const submissionId = Number(req.body.submissionId);
    if (!submissionId) return res.status(400).json({ error: 'Missing submissionId.' });

    const submission = await db.get(
      `SELECT s.*, c.status AS contest_status, c.closes_at AS contest_closes_at FROM submissions s
       JOIN contests c ON c.id = s.contest_id WHERE s.id = ?`,
      [submissionId]
    );
    if (!submission) return res.status(404).json({ error: 'Cat not found.' });
    if (submission.disqualified) return res.status(400).json({ error: 'This entry is no longer eligible.' });
    // Voting ends at the stated close, not whenever the daily cron gets
    // round to tallying (a few hours later) — see getOrOpenCurrentContest.
    if (submission.contest_status !== 'open' || new Date(submission.contest_closes_at) <= new Date()) {
      return res.status(400).json({ error: 'Voting has closed for this contest.' });
    }

    if (process.env.TURNSTILE_SECRET_KEY) {
      const captchaOk = await verifyTurnstile(req.body.turnstileToken, req.ip);
      if (!captchaOk) return res.status(400).json({ error: 'Captcha verification failed — please try again.' });
    }

    const voterToken = getOrSetVoterToken(req, res);
    const ipHash = hashIp(req.ip);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Soft, client-supplied referral signal — see referred_by_submission_id
    // in db.js. Not trusted for anything but attribution: a bogus id just
    // resolves to no match below and the vote proceeds exactly as if it
    // were absent.
    let referredBy = Number(req.body.referredBy);
    if (!Number.isInteger(referredBy) || referredBy <= 0) referredBy = null;

    // The rate-limit checks and the insert all happen inside one
    // transaction, serialized per voter/IP with a transaction-scoped
    // advisory lock — without that, two concurrent votes from the same
    // voter/connection can both pass the COUNT check before either one's
    // INSERT is visible to the other, squeezing past the daily limit.
    // pg_advisory_xact_lock auto-releases at COMMIT/ROLLBACK, so there's
    // nothing to clean up and no lock held outside this request.
    await db.transaction(async (tx) => {
      await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`vote:${voterToken}`]);
      await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`vote-ip:${ipHash}`]);

      const voterCount = await tx.get(`SELECT COUNT(*) AS c FROM votes WHERE voter_token = ? AND created_at >= ?`, [
        voterToken, dayAgo,
      ]);
      if (Number(voterCount.c) >= VOTE_LIMIT_PER_VOTER_PER_DAY) {
        throw Object.assign(new Error("You've hit today's voting limit — try again tomorrow."), { rateLimited: true });
      }
      const ipCount = await tx.get(`SELECT COUNT(*) AS c FROM votes WHERE ip_hash = ? AND created_at >= ?`, [
        ipHash, dayAgo,
      ]);
      if (Number(ipCount.c) >= VOTE_LIMIT_PER_IP_PER_DAY) {
        throw Object.assign(new Error('Too many votes from this connection today — try again tomorrow.'), { rateLimited: true });
      }
      const ipCatCount = await tx.get(`SELECT COUNT(*) AS c FROM votes WHERE ip_hash = ? AND submission_id = ?`, [
        ipHash, submissionId,
      ]);
      if (Number(ipCatCount.c) >= VOTE_LIMIT_PER_IP_PER_CAT) {
        throw Object.assign(
          new Error("This cat already has the most votes we accept from one connection this round. Thanks for the support!"),
          { rateLimited: true }
        );
      }

      let referredBySubmissionId = null;
      if (referredBy) {
        const refSubmission = await tx.get(`SELECT id FROM submissions WHERE id = ?`, [referredBy]);
        if (refSubmission) referredBySubmissionId = refSubmission.id;
      }

      await tx.run(
        `INSERT INTO votes (submission_id, voter_token, ip_hash, created_at, referred_by_submission_id) VALUES (?, ?, ?, ?, ?)`,
        [submissionId, voterToken, ipHash, new Date().toISOString(), referredBySubmissionId]
      );
      await tx.run(`UPDATE submissions SET vote_count = vote_count + 1 WHERE id = ?`, [submissionId]);
    });

    res.json({ ok: true });
  } catch (err) {
    if (err.rateLimited) {
      return res.status(429).json({ error: err.message });
    }
    if (err.code === '23505') {
      return res.status(400).json({ error: "You've already voted for this cat." });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

async function verifyTurnstile(token, remoteIp) {
  if (!token) return false;
  try {
    const params = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: remoteIp,
    });
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await resp.json();
    return Boolean(data.success);
  } catch (err) {
    console.error('[turnstile] verification request failed:', err.message);
    return false;
  }
}

// Printful shipment webhook.
//
// Authentication is by unguessable path, not by signature: Printful's
// documented v2 API surface exposes no signing secret and no signature
// header, so there is nothing to verify a body against. The security model
// is therefore "the payload is a hint, not a fact" -- we take the order id
// from it, then re-fetch that order's shipments from Printful and store
// whatever their API says. A forged request costs one API call.
//
// Register with: POST /v2/webhooks/shipment_sent  {"url": "<this path>"}
// The event is `shipment_sent`. There is no delivery event -- delivery is
// polled by the daily cron.
app.post('/api/webhooks/printful/:token', async (req, res) => {
  if (!PRINTFUL_WEBHOOK_TOKEN) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const provided = Buffer.from(String(req.params.token || ''));
  const expected = Buffer.from(PRINTFUL_WEBHOOK_TOKEN);
  const valid =
    provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!valid) {
    console.warn('[printful webhook] rejected a delivery with a bad token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const eventType = typeof body.type === 'string' ? body.type : null;
  const printfulOrderId =
    (body.data && body.data.order && body.data.order.id) ||
    (body.data && body.data.shipment && body.data.shipment.order_id) ||
    (body.order && body.order.id) ||
    null;

  // Acknowledge fast and unconditionally. Printful retries on a non-2xx
  // (the envelope carries a `retries` count), and a retry storm caused by
  // our own slow lookup is worse than a missed event the daily poll will
  // pick up anyway.
  res.json({ received: true });

  if (eventType && eventType !== 'shipment_sent') {
    console.log(`[printful webhook] ignoring event type '${eventType}'`);
    return;
  }
  if (!printfulOrderId) {
    console.warn('[printful webhook] delivery had no recognizable order id');
    return;
  }

  try {
    const order = await db.get(`SELECT id FROM custom_orders WHERE printful_order_id = ?`, [
      String(printfulOrderId),
    ]);
    if (!order) {
      console.warn(`[printful webhook] no custom order matches Printful order ${printfulOrderId}`);
      return;
    }
    const result = await syncOrderShipments(order.id);
    console.log(`[printful webhook] order #${order.id}: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error('[printful webhook] sync failed:', err.message);
  }
});

// Everything the /thanks page needs for one entrant, in one call.
//
// Authenticated with the same signed status token the entry-confirmation
// email already carries, so an entrant can reach their own thank-you page
// from that email days later — and nobody can read anyone else's by
// guessing a submission id.
app.get('/api/thanks', async (req, res) => {
  const submissionId = Number(req.query.cat);
  const { email, token } = req.query;
  if (!statusToken.verify(submissionId, email, token)) {
    return res.status(403).json({ error: 'Invalid or missing link.' });
  }
  const submission = await db.get(`SELECT * FROM submissions WHERE id = ?`, [submissionId]);
  if (!submission || String(submission.email).toLowerCase() !== String(email).toLowerCase()) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const contest = submission.contest_id
    ? await db.get(`SELECT * FROM contests WHERE id = ?`, [submission.contest_id])
    : null;

  // The three offers in the brief's merch block are framed / mug / bundle.
  // There is no bundle product, and the real catalogue prices sit below the
  // brief's figures ($74 framed, $19.99 mug) — repricing is the owner's
  // revenue decision, not this page's, so these are the real products at
  // the real prices, picked to cover the same three price points.
  const offerIds = ['framed-poster-luster-12x18', 'mug-11oz', 'canvas-18x24'];
  const media = await db.all(`SELECT product_id, hidden FROM product_media`);
  const hidden = new Set(media.filter((m) => Number(m.hidden)).map((m) => m.product_id));
  const offers = offerIds
    .map((id) => productCatalog.getProduct(id))
    .filter((p) => p && !hidden.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, priceUsd: p.priceUsd, mockupAspect: p.mockupAspect || '1/1' }));

  // Re-issued rather than stored, so the page works when reopened from the
  // email later: the same HMAC the shop already verifies (discountToken.js),
  // scoped to this entrant's email and given a fresh window.
  const discount = issueDiscount(submission.email, ENTRY_DISCOUNT_HOURS);

  res.json({
    catName: submission.cat_name,
    photoPath: submission.photo_path,
    // Advisory, not a block — the same warning the entry form used to show
    // inline, carried here so redirecting to this page doesn't lose it.
    lowResolution: Boolean(submission.low_resolution),
    photoWidth: submission.photo_width,
    photoHeight: submission.photo_height,
    shareImageUrl: submission.share_image_path || null,
    voteUrl: `${BASE_URL}/vote.html?cat=${submission.id}`,
    statusUrl: `${BASE_URL}/status.html?cat=${submission.id}&email=${encodeURIComponent(submission.email)}&token=${statusToken.tokenFor(submission.id, submission.email)}`,
    closesAt: contest && contest.status === 'open' ? contest.closes_at : null,
    closesLabel: contest && contest.status === 'open' ? formatContestClose(contest.closes_at) : null,
    disqualified: Boolean(submission.disqualified),
    offers,
    discount,
    commission: {
      fromUsd: commissionPricing.SIZES[0].priceUsd,
      depositPercent: commissionPricing.publicPricing().depositPercent,
    },
  });
});

// The winner archive behind /winners.
//
// A round appears here as soon as it closes, whether or not its painting
// exists yet: voting ends on a date, the painting takes two to four weeks
// after that. Showing the winning cat with "being painted now" is the
// honest state, and hiding the round until the painting lands would make
// the archive look emptier than the contest actually is.
app.get('/api/winners', async (req, res) => {
  const rows = await db.all(
    `SELECT c.id, c.label, c.closes_at, c.painting_photo_path, c.winner_story,
            s.cat_name, s.photo_path, s.vote_count
       FROM contests c
       JOIN groups g ON g.id = c.group_id
       JOIN submissions s ON s.id = g.winner_submission_id
      WHERE c.status = 'completed'
      ORDER BY c.closes_at DESC
      LIMIT 60`
  );

  res.json({
    winners: rows.map((r) => ({
      label: r.label,
      closedAt: r.closes_at,
      catName: r.cat_name,
      photoPath: r.photo_path,
      paintingPath: r.painting_photo_path || null,
      story: r.winner_story || null,
      // Deliberately not the vote count. Totals stay hidden while a round
      // runs so it is a fair count rather than a popularity snowball, and
      // publishing them afterwards would let anyone reconstruct the
      // running order of a future round from the same page.
    })),
  });
});

// Public catalog of custom cat print products (see products.js).
// Merges the fixed products.js catalog with whatever admin-uploaded photo/
// copy exists in product_media (see /api/admin/products), resolving each
// optional override down to the one effective value a consumer actually
// needs — callers here (the public API, and renderIndexHtml's SSR pass)
// shouldn't have to know an override even exists. A product nobody has
// photographed yet just comes back with imagePath: null — the honest
// empty state, same as everywhere else — never a placeholder image.
async function getProductsWithMedia(species) {
  const media = await db.all(`SELECT * FROM product_media`);
  const byId = Object.fromEntries(media.map((m) => [m.product_id, m]));
  return productCatalog.listProducts(species)
    .filter((p) => !(byId[p.id] && Number(byId[p.id].hidden)))
    .map((p) => {
      const m = byId[p.id];
      const description = (m && m.description_override) || p.description;
      return {
        id: p.id,
        name: p.name,
        species: p.species,
        description,
        priceUsd: p.priceUsd,
        mockupAspect: p.mockupAspect,
        tier: p.tier || null,
        imagePath: m ? m.image_path : null,
        imageAlt: (m && m.image_alt) || p.name,
        seoName: (m && m.seo_title) || p.name,
        seoDescription: (m && m.seo_description) || description,
      };
    });
}

app.get('/api/products', async (req, res) => {
  const species = typeof req.query.species === 'string' ? req.query.species : null;
  res.json({ products: await getProductsWithMedia(species) });
});

app.get('/api/phone-models', (req, res) => {
  res.json({ models: phoneCases.listPhoneCaseModels() });
});

app.get('/api/sweatshirt-sizes', (req, res) => {
  res.json({ sizes: sweatshirtSizes.listSweatshirtSizes() });
});

// Public, non-secret config the client needs — currently just whether
// Turnstile CAPTCHA is enabled and, if so, its public site key (the secret
// key never leaves the server; see verifyTurnstile).
app.get('/api/config', (req, res) => {
  res.json({
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
    // Public by design — a Pixel ID is meant to appear in page source (it's
    // how the base pixel snippet knows which pixel to report to). Only the
    // Conversions API access token (server-side, metaConversions.js) is a
    // real secret and never reaches the client.
    metaPixelId: process.env.META_PIXEL_ID || null,
    // Lets the shop drop a discount stored in the browser from an earlier
    // entry once discounting is off, instead of claiming one is applied.
    contestDiscountPercent: CONTEST_DISCOUNT_PERCENT > 0 ? CONTEST_DISCOUNT_PERCENT : 0,
  });
});

// Admin-managed hero background photos — empty means no slideshow at all
// (plain dark hero background), never a placeholder/stock-photo fallback.
app.get('/api/background', async (req, res) => {
  const slides = await db.all(`SELECT id, image_path FROM background_slides ORDER BY position ASC, id ASC`);
  res.json({ slides });
});

// Admin-managed showcase of a couple of Cody's completed originals — empty
// means no gallery at all (honest "still drying" empty state), never a
// placeholder image. See featured_originals in db.js.
app.get('/api/originals', async (req, res) => {
  const originals = await db.all(
    `SELECT id, image_path, cat_name, source_photo_path FROM featured_originals ORDER BY position ASC, id ASC`
  );
  res.json({ originals });
});

// Public read of the homepage promo slots (starburst + two feature
// blocks) — same site_blocks rows the admin endpoints above manage.
// script.js uses this to hydrate what seo.js already baked into the HTML;
// a slot with neither text nor an image just doesn't appear.
app.get('/api/site-blocks', async (req, res) => {
  const rows = await db.all(`SELECT slot, text, image_path, color FROM site_blocks`);
  const blocks = {};
  for (const r of rows) {
    if (!r.text && !r.image_path) continue;
    blocks[r.slot] = { text: r.text, imagePath: r.image_path, color: r.color };
  }
  res.json({ blocks });
});

// Public: the footer photo wall — empty means no strip at all, same
// honest-empty-state rule as /api/background above.
app.get('/api/footer-strip', async (req, res) => {
  const images = await db.all(
    `SELECT image_path FROM footer_strip_images ORDER BY position ASC, id ASC`
  );
  res.json({ images });
});

// Public: the "Live painting sessions" section — a manual on/off switch,
// not an empty-state one (see live_stream_settings in db.js), so this can
// read enabled:false for a long time before the owner ever turns it on.
app.get('/api/live-stream', async (req, res) => {
  const settings = await db.get(`SELECT * FROM live_stream_settings WHERE key = 'main'`);
  if (!settings || !settings.enabled) return res.json({ enabled: false });
  const sessions = await db.all(
    `SELECT title, session_date, video_url FROM live_sessions ORDER BY position ASC, id DESC`
  );
  res.json({
    enabled: true,
    isLive: !!settings.is_live,
    embedUrl: settings.embed_url,
    nextSessionAt: settings.next_session_at,
    sessions: sessions.map((s) => ({ title: s.title, sessionDate: s.session_date, videoUrl: s.video_url })),
  });
});

// Public: the site footer's real mailing address, sourced from the same
// BUSINESS_MAILING_ADDRESS env var mailer.js already puts in every
// commercial email's CAN-SPAM footer — one value, two places it has to
// appear. Returns null (never the internal placeholder string mailer.js
// falls back to) until the owner actually sets it — same honest-empty-state
// rule as reviews/background photos/originals: nothing shown beats a
// visibly broken placeholder in front of a real visitor.
app.get('/api/business-info', (req, res) => {
  res.json({ address: process.env.BUSINESS_MAILING_ADDRESS || null });
});

// Upload a pet photo, pick a product, pay — this is the evergreen storefront
// (as opposed to the contest, which only runs in batches of 12). Fulfilled
// through Printful once Stripe confirms payment via the webhook above.
app.post('/api/custom-orders', upload.single('photo'), async (req, res) => {
  try {
    const blocked = !stripe ? ['STRIPE_SECRET_KEY'] : checkoutBlocker({ needsPrintful: true });
    if (blocked) {
      console.error(`[checkout] print order refused — not configured: ${blocked.join(', ')}`);
      return res.status(503).json({ error: "Print orders open very soon — we're finishing setup. Please check back shortly." });
    }
    const { email, productId, petName, photoRights, quantity } = req.body;
    // Cats only since 2026-09-30 (owner's call). The column stays for older
    // orders; a client-sent species is ignored rather than trusted.
    const species = 'cat';

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A photo is required.' });
    }
    // Photo rights: same requirement as contest entries, narrower grant —
    // before printing a customer's photo and handing it to Printful, we
    // need their affirmative confirmation they own/have rights to it (it's
    // usually their own pet, but the checkbox is the actual legal record
    // either way). This covers printing the item ordered and nothing else;
    // it is deliberately separate from the contest grant, which covers
    // public display instead.
    if (photoRights !== 'on' && photoRights !== 'true') {
      return res.status(400).json({ error: 'You must confirm you own the rights to this photo.' });
    }
    const product = productCatalog.getProduct(productId);
    if (!product) {
      return res.status(400).json({ error: 'Unknown product.' });
    }
    // A hidden product stays fully valid for its own order history — this
    // only blocks placing a *new* order against it (e.g. straight against
    // the API, bypassing a shop grid that already hid the card).
    const media = await db.get(`SELECT hidden FROM product_media WHERE product_id = ?`, [product.id]);
    if (media && Number(media.hidden)) {
      return res.status(404).json({ error: 'This product is not currently available.' });
    }

    const ipHash = hashIp(req.ip);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ipCount = await db.get(`SELECT COUNT(*) AS c FROM custom_orders WHERE ip_hash = ? AND created_at >= ?`, [
      ipHash, dayAgo,
    ]);
    if (Number(ipCount.c) >= CUSTOM_ORDER_LIMIT_PER_IP_PER_DAY) {
      return res.status(429).json({ error: 'Too many orders from this connection today — try again tomorrow.' });
    }

    // Phone cases are sized per exact device — there's no single Printful
    // variant for "a phone case," so the customer's model choice must
    // resolve to a real catalog variant here, never trusted as a raw ID
    // from the client (see phoneCases.js for why).
    let variantId = null;
    if (product.id === 'phone-case') {
      if (!phoneCases.isValidPhoneCaseVariant(req.body.phoneVariantId)) {
        return res.status(400).json({ error: 'Please choose your phone model.' });
      }
      variantId = Number(req.body.phoneVariantId);
    } else if (product.id === 'crewneck-sweatshirt') {
      // Same reasoning as phone cases above — apparel needs a size, there's
      // no single Printful variant for "a sweatshirt," and the client's
      // choice must resolve to a real catalog variant, never trusted raw.
      if (!sweatshirtSizes.isValidSweatshirtVariant(req.body.sweatshirtVariantId)) {
        return res.status(400).json({ error: 'Please choose your size.' });
      }
      variantId = Number(req.body.sweatshirtVariantId);
    }

    const qty = Math.max(1, Math.min(10, Number(quantity) || 1));
    const petNameClean = (petName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    const { width, height, lowResolution } = await checkImageQuality(req.file.buffer);
    const photoPath = await storePhoto(req.file);
    const utmCampaign = cleanUtmCampaign(req.body.utmCampaign);
    const now = new Date().toISOString();

    // Optional time-limited discount from the contest entry-confirmation
    // or final-placement email — verified server-side (HMAC + expiry, see
    // discountToken.js), never trusted from the client's own math. Must
    // belong to the same email placing this order.
    const { discountEmail, discountExpires, discountToken: discountTok } = req.body;
    let discountPercent = 0;
    if (discountTok && discountEmail && String(discountEmail).toLowerCase() === String(email).toLowerCase()) {
      if (discountToken.verify(discountEmail, discountExpires, discountTok)) {
        discountPercent = CONTEST_DISCOUNT_PERCENT;
      }
    }
    const unitPrice = Math.round(product.priceUsd * (1 - discountPercent / 100) * 100) / 100;
    const amount = unitPrice * qty;

    const info = await db.run(
      `INSERT INTO custom_orders (email, product_id, species, pet_name, photo_path, quantity, amount_usd, status, photo_rights_consent_at, created_at, photo_width, photo_height, low_resolution, discount_percent, utm_campaign, variant_id, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [email, product.id, species, petNameClean, photoPath, qty, amount, now, now, width, height, lowResolution, discountPercent, utmCampaign, variantId, ipHash]
    );
    const orderId = info.rows[0].id;

    const productName = discountPercent > 0
      ? `Whiskr — ${product.name} (${discountPercent}% off)`
      : `Whiskr — ${product.name}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      // Printful bills us for shipping separately from the item, so a
      // session that collects an address but no shipping charge hands the
      // whole carrier cost to us on every order. Charged below the
      // threshold, free above it — see orderEconomics.js, which is also
      // what the margin check reads.
      shipping_options: orderEconomics.shippingOptionsFor({
        productId: product.id,
        quantity: qty,
        subtotalUsd: amount,
      }),
      automatic_tax: { enabled: true },
      // receipt_email makes Stripe send its receipt even if receipts are off in
      // the dashboard — the order-success banner and shipping.html promise one.
      payment_intent_data: { statement_descriptor_suffix: 'WHISKR', receipt_email: email },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: productName },
            unit_amount: Math.round(unitPrice * 100),
            tax_behavior: 'exclusive',
          },
          quantity: qty,
        },
      ],
      metadata: { orderType: 'custom', orderId: String(orderId) },
      success_url: `${BASE_URL}/?order=success`,
      cancel_url: `${BASE_URL}/#shop-custom`,
    });

    await db.run(`UPDATE custom_orders SET stripe_session_id = ? WHERE id = ?`, [session.id, orderId]);

    // Ad conversion tracking — never blocks or fails checkout. eventId is
    // shared with the matching client-side fbq('track','InitiateCheckout')
    // call (see public/script.js) so Meta dedupes the two into one signal.
    const checkoutEventId = `checkout-custom-${orderId}`;
    metaConversions
      .sendEvent({ eventName: 'InitiateCheckout', eventId: checkoutEventId, email, value: amount, currency: 'USD', eventSourceUrl: BASE_URL })
      .catch((err) => console.error('[meta capi] InitiateCheckout event failed:', err.message));

    res.json({ ok: true, url: session.url, lowResolution, width, height, discountPercent, amount, metaEventId: checkoutEventId });
  } catch (err) {
    if (err.uploadRejected) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end — please try again, or email contest@whiskr.lol.' });
  }
});

// ---------- original acrylic commissions ----------
// The art tier: studio time sold directly, two payments. Deliberately does
// not touch Printful — nothing here is printed, and a commission must never
// be fulfilled as if it were a poster.

// The published rate card. Served rather than hard-coded into
// commission.html so the table a visitor reads is generated from the same
// constants that price the deposit they're about to pay.
app.get('/api/commissions/pricing', (req, res) => {
  res.json(commissionPricing.publicPricing());
});

// Authoritative price for one configuration. The page calls this instead of
// doing its own arithmetic, so there is exactly one implementation of what a
// commission costs and the quote on screen cannot drift from the charge.
app.get('/api/commissions/quote', (req, res) => {
  const quote = commissionPricing.quote({
    sizeId: req.query.size,
    rush: req.query.rush === '1' || req.query.rush === 'true',
    extraPets: req.query.extraPets,
  });
  if (!quote) return res.status(400).json({ error: 'Pick a size.' });
  res.json(quote);
});

// Book a commission: upload the reference photo, then pay the 40% deposit
// through Stripe Checkout. The balance is charged separately later, once
// the painting is finished (see the admin request-balance route below) —
// never up front, because the customer is paying for work not yet done.
app.post('/api/commissions', upload.single('photo'), async (req, res) => {
  try {
    const blocked = !stripe ? ['STRIPE_SECRET_KEY'] : checkoutBlocker({ needsPrintful: false });
    if (blocked) {
      console.error(`[checkout] commission refused — not configured: ${blocked.join(', ')}`);
      return res.status(503).json({ error: "Commission booking opens very soon — we're finishing setup. Email contest@whiskr.lol to reserve a spot." });
    }
    const { email, customerName, petName, sizeId, notes, photoRights } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A reference photo is required.' });
    }
    // Same affirmative record as every other photo this site accepts. The
    // grant here is narrow on purpose: painting from the photo and showing
    // the finished painting. It does not license printing it on products.
    if (photoRights !== 'on' && photoRights !== 'true') {
      return res.status(400).json({ error: 'You must confirm you own the rights to this photo.' });
    }

    // Priced server-side from the client's *choices*, never from any amount
    // the client sends — a posted price is a suggestion from a stranger.
    const quote = commissionPricing.quote({
      sizeId,
      rush: req.body.rush === 'on' || req.body.rush === 'true',
      extraPets: req.body.extraPets,
    });
    if (!quote) {
      return res.status(400).json({ error: 'Pick a size for your painting.' });
    }

    const ipHash = hashIp(req.ip);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ipCount = await db.get(
      `SELECT COUNT(*) AS c FROM commissions WHERE ip_hash = ? AND created_at >= ?`,
      [ipHash, dayAgo]
    );
    if (Number(ipCount.c) >= COMMISSION_LIMIT_PER_IP_PER_DAY) {
      return res.status(429).json({ error: 'Too many booking attempts from this connection today — email us instead.' });
    }

    const nameClean = String(customerName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    const petNameClean = String(petName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    const notesClean = String(notes || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
    // Advisory only, exactly as it is for prints: a soft reference photo
    // still paints fine, it just means Cody may ask for a better one.
    const { width, height, lowResolution } = await checkImageQuality(req.file.buffer);
    const photoPath = await storePhoto(req.file);
    const now = new Date().toISOString();

    const info = await db.run(
      `INSERT INTO commissions (email, customer_name, pet_name, size_id, rush, extra_pets, total_usd, deposit_usd, balance_usd, notes, photo_path, status, photo_rights_consent_at, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deposit_pending', ?, ?, ?) RETURNING id`,
      [email, nameClean || null, petNameClean || null, quote.sizeId, quote.rush ? 1 : 0, quote.extraPets,
       quote.totalUsd, quote.depositUsd, quote.balanceUsd, notesClean || null, photoPath, now, ipHash, now]
    );
    const commissionId = info.rows[0].id;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      // A painting is a physical object that has to reach someone, and the
      // address is also what Stripe Tax needs to work out what to charge.
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      // No shipping_options here, unlike the print sessions.
      // Commission prices are locked by the owner's brief, and crating and
      // insuring an original acrylic is a real cost that nothing currently
      // collects — but adding a charge on top of a locked four-figure price
      // is a revenue decision, not a bug fix. Left for the owner to price
      // in deliberately rather than bolted on here.
      automatic_tax: { enabled: true },
      payment_intent_data: { statement_descriptor_suffix: 'WHISKR', receipt_email: email },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Deposit — original acrylic ${quote.sizeLabel}`,
              description: `${commissionPricing.publicPricing().depositPercent}% deposit of $${quote.totalUsd.toFixed(2)}. Balance of $${quote.balanceUsd.toFixed(2)} is due before the painting ships.`,
            },
            unit_amount: Math.round(quote.depositUsd * 100),
            tax_behavior: 'exclusive',
          },
          quantity: 1,
        },
      ],
      metadata: { orderType: 'commission_deposit', orderId: String(commissionId) },
      success_url: `${BASE_URL}/commission?booked=1`,
      cancel_url: `${BASE_URL}/commission`,
    });

    await db.run(`UPDATE commissions SET deposit_session_id = ? WHERE id = ?`, [session.id, commissionId]);

    res.json({ ok: true, url: session.url, quote, lowResolution, width, height });
  } catch (err) {
    if (err.uploadRejected) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end — please try again, or email contest@whiskr.lol.' });
  }
});

// Public status: a coarse fill signal only — never the real count. A raw
// "X of 12 entered" is honest but reads as "nobody's here yet" for most of
// this business's life; it's also nobody's business how many strangers have
// entered right now.
app.get('/api/status', async (req, res) => {
  res.json(await getContestStatus());
});

// Unsubscribe link included in commercial result emails (CAN-SPAM requires
// a working one-click opt-out on any email carrying a purchase pitch).
// A minimal branded page for one-line outcomes (unsubscribe, payment links).
function simplePage(heading, body) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>${seo.escapeHtml(heading)} — Whiskr</title><meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" href="/style.css" /></head>
<body><main style="max-width:520px;margin:80px auto;padding:0 24px;text-align:center;">
<h1>${seo.escapeHtml(heading)}</h1>
<p>${body}</p>
<p><a href="/">Back to Whiskr</a></p>
</main></body></html>`;
}

app.get('/api/unsubscribe', async (req, res) => {
  const { email, token } = req.query;
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!unsubscribe.verify(email, token)) {
    return res.status(400).send(simplePage(
      'This link isn\'t valid',
      'This unsubscribe link isn\'t valid. Use the link from your most recent Whiskr email, or email <a href="mailto:contest@whiskr.lol">contest@whiskr.lol</a> and we\'ll take you off the list.'
    ));
  }
  const lowerEmail = String(email).toLowerCase();
  await db.run(`INSERT INTO suppressions (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING`, [
    lowerEmail,
    new Date().toISOString(),
  ]);
  // A suppression is a strict superset of "opted out of marketing" — keep
  // marketing_subscribers from showing someone as still opted in once
  // they've unsubscribed from mail entirely.
  await db.run(`UPDATE marketing_subscribers SET unsubscribed_at = ? WHERE email = ? AND unsubscribed_at IS NULL`, [
    new Date().toISOString(),
    lowerEmail,
  ]);
  res.send(simplePage(
    "You're unsubscribed",
    "You won't get promotional emails from Whiskr any more. We'll still email you about things you started yourself — an order, a commission, or a prize your cat won."
  ));
});

// Standalone newsletter/marketing signup — for a visitor who wants updates
// without entering the contest or placing an order (today's only other two
// ways an email reaches this app, both transactional). Deliberately no
// email sent back on success: this endpoint just records consent, it
// isn't itself a mailer, so there's nothing to confirm yet.
app.post('/api/subscribe', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    const ipHash = hashIp(req.ip);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ipCount = await db.get(
      `SELECT COUNT(*) AS c FROM marketing_subscribers WHERE ip_hash = ? AND subscribed_at >= ?`,
      [ipHash, dayAgo]
    );
    if (Number(ipCount.c) >= SUBSCRIBE_LIMIT_PER_IP_PER_DAY) {
      return res.status(429).json({ error: 'Too many signups from this connection today — try again tomorrow.' });
    }
    await subscribeToMarketingList(email, 'footer_signup', ipHash);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Public reviews for the homepage. Only ever rows a human approved after
// verifying the submission came from a real, signed order-review link —
// see POST /api/reviews below. No seed data, ever: an empty result here
// means the honest thing is an empty state on the page, not a fake review.
app.get('/api/reviews', async (req, res) => {
  const rows = await db.all(
    `SELECT rating, body, display_name, photo_path, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 50`
  );
  res.json({ reviews: rows });
});

// Submit a review — only reachable via the signed link emailed after a real
// order was fulfilled (see sendDueReviewRequests above). The token proves
// this specific email actually placed this specific order; this is what
// makes every review a verified purchase rather than an open form anyone
// could spam or fabricate. Never relax this check.
app.post('/api/reviews', async (req, res) => {
  try {
    const { orderType, orderId, email, token, rating, body, displayName } = req.body;
    const id = Number(orderId);

    if (orderType !== 'custom') {
      return res.status(400).json({ error: 'Invalid review link.' });
    }
    if (!reviewLink.verify(orderType, id, email, token)) {
      return res.status(400).json({ error: 'Invalid or expired review link.' });
    }

    const order = await db.get(`SELECT email, status FROM custom_orders WHERE id = ?`, [id]);
    const paidStatuses = ['paid', 'submitted_to_printful'];
    if (!order || order.email.toLowerCase() !== String(email).toLowerCase() || !paidStatuses.includes(order.status)) {
      return res.status(400).json({ error: 'This order is not eligible for a review.' });
    }

    const ratingNum = Math.round(Number(rating));
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'Rating must be 1 to 5.' });
    }
    const bodyClean = String(body || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
    if (!bodyClean) {
      return res.status(400).json({ error: 'Please write a few words about your order.' });
    }
    const nameClean = String(displayName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60) || null;

    await db.run(
      `INSERT INTO reviews (order_type, order_id, email, rating, body, display_name, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [orderType, id, email, ratingNum, bodyClean, nameClean, new Date().toISOString()]
    );

    res.json({ ok: true, message: "Thanks! Your review is in — it'll show up once we've had a look." });
  } catch (err) {
    if (err.code === '23505') {
      // Postgres unique_violation — hits the UNIQUE(order_type, order_id) constraint.
      return res.status(400).json({ error: "You've already reviewed this order." });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- admin / ops ----------
// Header only — admin.html has only ever sent x-admin-key, never a ?key=
// query param, and a key in the URL just ends up in access logs, browser
// history, and any Referer header for no benefit.
//
// Failed attempts are throttled per-IP, in-memory: a bare-minimum
// defense-in-depth layer on top of key entropy, which is the real defense.
// It resets on every cold start (this runs on Vercel serverless), so treat
// it as raising the cost of a brute-force burst within one warm instance,
// not a durable lockout.
const ADMIN_AUTH_LIMIT = 20;
const ADMIN_AUTH_WINDOW_MS = 5 * 60 * 1000;
const adminAuthFailures = new Map(); // ip -> { count, windowStart }

function requireAdmin(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = adminAuthFailures.get(ip);
  if (entry && now - entry.windowStart < ADMIN_AUTH_WINDOW_MS && entry.count >= ADMIN_AUTH_LIMIT) {
    return res.status(429).json({ error: 'Too many failed attempts — try again later.' });
  }

  const provided = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const expected = Buffer.from(String(process.env.ADMIN_KEY || ''));
  const valid =
    process.env.ADMIN_KEY &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);

  if (!valid) {
    if (!entry || now - entry.windowStart >= ADMIN_AUTH_WINDOW_MS) {
      adminAuthFailures.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  adminAuthFailures.delete(ip);
  next();
}

// Current contest, its entry count, and its highest vote-velocity entries
// (most votes in the last hour) — the fraud-review view. There's no ML
// fraud model here, just the number a human operator needs to eyeball
// "did this cat really get 400 votes in an hour, or did someone buy them."
app.get('/api/admin/contest/current', requireAdmin, async (req, res) => {
  const contest = await db.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (!contest) return res.json({ contest: null, entries: [] });

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const entries = await db.all(
    `SELECT s.id, s.cat_name, s.photo_path, s.vote_count, s.disqualified, s.disqualified_reason,
            s.photo_width, s.photo_height, s.low_resolution,
            (SELECT COUNT(*) FROM votes v WHERE v.submission_id = s.id AND v.created_at >= ?) AS votes_last_hour,
            (SELECT COUNT(*) FROM votes v2 WHERE v2.referred_by_submission_id = s.id) AS referred_votes
     FROM submissions s WHERE s.contest_id = ? ORDER BY s.vote_count DESC`,
    [hourAgo, contest.id]
  );
  res.json({
    contest: { id: contest.id, label: contest.label, opensAt: contest.opens_at, closesAt: contest.closes_at },
    entries,
  });
});

// Pull a fraudulent/abusive entry out of contention. Its votes stay in the
// table (so an investigation can look at them) but it's excluded from
// tallying and no longer votable — see the eligibility checks in
// tallyAndCloseContest and POST /api/vote.
app.post('/api/admin/submissions/:id/disqualify', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body.reason || '').slice(0, 500) || 'No reason given';
  const info = await db.run(`UPDATE submissions SET disqualified = 1, disqualified_reason = ? WHERE id = ?`, [
    reason, id,
  ]);
  if (info.changes === 0) return res.status(404).json({ error: 'Submission not found.' });
  res.json({ ok: true });
});
app.post('/api/admin/submissions/:id/requalify', requireAdmin, async (req, res) => {
  const info = await db.run(`UPDATE submissions SET disqualified = 0, disqualified_reason = NULL WHERE id = ?`, [
    Number(req.params.id),
  ]);
  if (info.changes === 0) return res.status(404).json({ error: 'Submission not found.' });
  res.json({ ok: true });
});
// Testing/manual override — force the current contest to close and tally
// right now instead of waiting for its closes_at date. In normal operation
// the daily cron (runDueContestClose) is what closes a contest on time.
app.post('/api/admin/contest/force-close', requireAdmin, async (req, res) => {
  const contest = await db.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (!contest) return res.status(404).json({ error: 'No open contest.' });
  const groupId = await tallyAndCloseContest(contest.id);
  res.json({ ok: true, contestId: contest.id, groupId });
});

// Read-only history of every painting awarded so far (one row per contest
// round now — see awardPainting in tallyAndCloseContest) — this is what
// admin.html's "Painting winners" section actually shows; there's no
// "open a vote" step to manage anymore.
app.get('/api/admin/year-award', requireAdmin, async (req, res) => {
  const awards = await db.all(
    `SELECT ya.*, s.cat_name, s.email, s.phone, s.owner_name, s.photo_path, s.final_rank
     FROM year_awards ya
     LEFT JOIN submissions s ON s.id = ya.winner_submission_id
     ORDER BY ya.created_at DESC`
  );
  res.json({
    awards: awards.map((a) => ({
      ...a,
      // Monthly prize rows only (label "<Month> winner"); the dormant Cat of
      // the Year rows have no claim flow.
      claimDeadline: / winner$/.test(a.label || '') ? claimDeadlineOf(a) : null,
      claimExpired: / winner$/.test(a.label || '') ? claimExpired(a) : false,
      claimUrl: / winner$/.test(a.label || '') && a.email ? claimUrlFor(a.id, a.email) : null,
    })),
  });
});

// Marketing/ROAS ledger — spend can come in two ways: manually logged (see
// the POST endpoint below) or, once META_ACCESS_TOKEN/META_AD_ACCOUNT_ID
// are set, automatically pulled once a day from the Meta Marketing API by
// syncMetaAdSpend below. Either way this is READ-ONLY against the ad
// platform — nothing here can pause a real campaign or change its budget;
// see metaAds.js. Revenue is always computed the same way regardless of
// spend source: matched by name (case-insensitive) against whatever
// ?utm_campaign= value a visitor's link carried — see cleanUtmCampaign
// and script.js's capture on page load.

// Resolves campaign.meta_campaign_id — by the stored value if already
// linked, else by matching name (case-insensitive) against the connected
// ad account, persisting the link so a later rename in Meta's own UI
// doesn't break it. `cache` is a plain {} the caller reuses across
// campaigns in the same run, so the account's campaign list is only
// fetched once per sync/backfill call, not once per campaign. Returns
// null if there's no matching Meta campaign (nothing to sync for it yet).
async function resolveMetaCampaignId(campaign, cache) {
  if (campaign.meta_campaign_id) return campaign.meta_campaign_id;
  if (!cache.byName) {
    const result = await metaAds.listCampaigns();
    cache.byName = new Map(result.campaigns.map((c) => [c.name.toLowerCase(), c.id]));
  }
  const metaCampaignId = cache.byName.get(campaign.name.toLowerCase());
  if (!metaCampaignId) return null;
  await db.run(`UPDATE ad_campaigns SET meta_campaign_id = ? WHERE id = ?`, [metaCampaignId, campaign.id]);
  return metaCampaignId;
}

// Pulls one day's real spend (default: yesterday, or a specific YYYY-MM-DD
// for backfilling — see POST /api/admin/marketing/backfill-meta) for every
// active campaign that has a matching Meta campaign, and upserts it into
// ad_spend_entries with source='meta_api' — safe to re-run any time,
// including manually via the admin endpoint below, since the partial
// unique index on (campaign_id, spend_date) WHERE source='meta_api' means
// a re-sync updates that day's number instead of double-counting it.
// No-ops entirely (returns dryRun: true) if Meta isn't configured — the
// manual ledger keeps working exactly as before either way.
async function syncMetaAdSpend(dateYmd) {
  if (!metaAds.configured()) return { dryRun: true, synced: 0 };

  const campaigns = await db.all(`SELECT * FROM ad_campaigns WHERE status = 'active'`);
  if (campaigns.length === 0) return { dryRun: false, synced: 0 };

  const targetDate = dateYmd || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cache = {};
  let synced = 0;

  for (const campaign of campaigns) {
    const metaCampaignId = await resolveMetaCampaignId(campaign, cache);
    if (!metaCampaignId) continue; // no matching Meta campaign — nothing to sync for this one

    try {
      const spend = await metaAds.getCampaignSpendForDate(metaCampaignId, targetDate);
      await db.run(
        `INSERT INTO ad_spend_entries (campaign_id, spend_date, amount_usd, source, created_at)
         VALUES (?, ?, ?, 'meta_api', ?)
         ON CONFLICT (campaign_id, spend_date) WHERE source = 'meta_api'
         DO UPDATE SET amount_usd = EXCLUDED.amount_usd`,
        [campaign.id, targetDate, spend.amountUsd, new Date().toISOString()]
      );
      synced++;
    } catch (err) {
      console.error(`[meta-ads] spend sync failed for campaign ${campaign.id} (${campaign.name}) on ${targetDate}:`, err.message);
    }
  }
  return { dryRun: false, synced };
}

// Emails ADMIN_EMAIL (same address used for Printful submission failures
// elsewhere in this app) when an active campaign's all-time ROAS drops
// below ROAS_ALERT_THRESHOLD — never pauses or changes anything, per the
// owner's explicit choice. Throttled by last_roas_alert_at so a campaign
// that stays bad re-alerts at most once every ROAS_ALERT_COOLDOWN_DAYS,
// not every single day.
async function checkRoasAlerts() {
  if (!process.env.ADMIN_EMAIL) return;

  const rows = await db.all(`
    SELECT c.*,
      COALESCE(spend.total_spend, 0) AS total_spend,
      COALESCE(rev.total_revenue, 0) AS total_revenue
    FROM ad_campaigns c
    LEFT JOIN (
      SELECT campaign_id, SUM(amount_usd) AS total_spend FROM ad_spend_entries GROUP BY campaign_id
    ) spend ON spend.campaign_id = c.id
    LEFT JOIN (
      SELECT LOWER(utm_campaign) AS name, SUM(amount_usd) AS total_revenue FROM (
        SELECT utm_campaign, amount_usd FROM orders WHERE status = 'paid' AND utm_campaign IS NOT NULL
        UNION ALL
        SELECT utm_campaign, amount_usd FROM custom_orders WHERE status = 'paid' AND utm_campaign IS NOT NULL
      ) paid_orders GROUP BY LOWER(utm_campaign)
    ) rev ON rev.name = LOWER(c.name)
    WHERE c.status = 'active'
  `);

  const cooldownCutoff = new Date(Date.now() - ROAS_ALERT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (const c of rows) {
    const totalSpend = Number(c.total_spend);
    const totalRevenue = Number(c.total_revenue);
    if (totalSpend < ROAS_ALERT_MIN_SPEND) continue;
    const roas = totalRevenue / totalSpend;
    if (roas >= ROAS_ALERT_THRESHOLD) continue;
    if (c.last_roas_alert_at && c.last_roas_alert_at >= cooldownCutoff) continue;

    try {
      await mailer.sendMail({
        to: process.env.ADMIN_EMAIL,
        subject: `Campaign "${c.name}" is under ${ROAS_ALERT_THRESHOLD}x ROAS`,
        text: `"${c.name}" has spent $${totalSpend.toFixed(2)} and attributed $${totalRevenue.toFixed(2)} in revenue — ${roas.toFixed(2)}x ROAS, below your ${ROAS_ALERT_THRESHOLD}x threshold. Nothing has been paused or changed automatically; check it in Meta Ads Manager and the admin marketing panel and decide yourself.`,
        html: `<p><strong>"${seo.escapeHtml(c.name)}"</strong> has spent $${totalSpend.toFixed(2)} and attributed $${totalRevenue.toFixed(2)} in revenue — <strong>${roas.toFixed(2)}x ROAS</strong>, below your ${ROAS_ALERT_THRESHOLD}x threshold.</p><p>Nothing has been paused or changed automatically — check it in Meta Ads Manager and the admin marketing panel, then decide yourself.</p>`,
      }).catch(() => {});
      await db.run(`UPDATE ad_campaigns SET last_roas_alert_at = ? WHERE id = ?`, [new Date().toISOString(), c.id]);
    } catch (err) {
      console.error(`[meta-ads] ROAS alert email failed for campaign ${c.id} (${c.name}):`, err.message);
    }
  }
}

app.get('/api/admin/marketing/campaigns', requireAdmin, async (req, res) => {
  const rows = await db.all(`
    SELECT c.*,
      COALESCE(spend.total_spend, 0) AS total_spend,
      COALESCE(rev.total_revenue, 0) AS total_revenue
    FROM ad_campaigns c
    LEFT JOIN (
      SELECT campaign_id, SUM(amount_usd) AS total_spend FROM ad_spend_entries GROUP BY campaign_id
    ) spend ON spend.campaign_id = c.id
    LEFT JOIN (
      SELECT LOWER(utm_campaign) AS name, SUM(amount_usd) AS total_revenue FROM (
        SELECT utm_campaign, amount_usd FROM orders WHERE status = 'paid' AND utm_campaign IS NOT NULL
        UNION ALL
        SELECT utm_campaign, amount_usd FROM custom_orders WHERE status = 'paid' AND utm_campaign IS NOT NULL
      ) paid_orders GROUP BY LOWER(utm_campaign)
    ) rev ON rev.name = LOWER(c.name)
    ORDER BY c.created_at DESC
  `);
  const campaigns = rows.map((r) => ({
    ...r,
    total_spend: Number(r.total_spend),
    total_revenue: Number(r.total_revenue),
    roas: Number(r.total_spend) > 0 ? Number((Number(r.total_revenue) / Number(r.total_spend)).toFixed(2)) : null,
  }));
  res.json({ campaigns, metaConfigured: metaAds.configured() });
});

// Manual on-demand trigger for the same sync the daily cron runs — lets
// you link a freshly-added campaign to Meta and pull its spend right away
// instead of waiting for the next cron run.
app.post('/api/admin/marketing/sync-meta', requireAdmin, async (req, res) => {
  try {
    const result = await syncMetaAdSpend();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Sync failed.' });
  }
});

app.post('/api/admin/marketing/campaigns', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const platform = String(req.body.platform || '').trim().slice(0, 60) || null;
    const notes = String(req.body.notes || '').trim().slice(0, 500) || null;
    if (!name) return res.status(400).json({ error: 'A campaign name is required.' });
    const info = await db.run(
      `INSERT INTO ad_campaigns (name, platform, notes, status, created_at) VALUES (?, ?, ?, 'active', ?) RETURNING id`,
      [name, platform, notes, new Date().toISOString()]
    );
    res.json({ ok: true, id: info.rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'A campaign with this exact name already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/admin/marketing/campaigns/:id/status', requireAdmin, async (req, res) => {
  const status = req.body.status === 'paused' ? 'paused' : 'active';
  const info = await db.run(`UPDATE ad_campaigns SET status = ? WHERE id = ?`, [status, Number(req.params.id)]);
  if (info.changes === 0) return res.status(404).json({ error: 'Campaign not found.' });
  res.json({ ok: true });
});

app.get('/api/admin/marketing/campaigns/:id/spend', requireAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT * FROM ad_spend_entries WHERE campaign_id = ? ORDER BY spend_date DESC, id DESC`,
    [Number(req.params.id)]
  );
  res.json({ entries: rows });
});

app.post('/api/admin/marketing/campaigns/:id/spend', requireAdmin, async (req, res) => {
  const campaignId = Number(req.params.id);
  const amount = Number(req.body.amountUsd);
  const spendDate = String(req.body.spendDate || '').slice(0, 10);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amountUsd is required.' });
  if (!spendDate) return res.status(400).json({ error: 'spendDate is required.' });
  const info = await db.run(
    `INSERT INTO ad_spend_entries (campaign_id, spend_date, amount_usd, created_at) VALUES (?, ?, ?, ?) RETURNING id`,
    [campaignId, spendDate, amount, new Date().toISOString()]
  );
  res.json({ ok: true, id: info.rows[0].id });
});

// Surfaces the exact failure mode that makes this ledger fragile: revenue
// matching is a case-insensitive string match between a real order's
// utm_campaign and an ad_campaigns.name someone typed by hand (see the
// LEFT JOIN above) — a typo or naming mismatch doesn't error, it just
// silently excludes that campaign's real revenue from every report. This
// lists every utm_campaign value with real paid revenue that isn't
// currently claimed by any campaign, so that money is visible instead of
// invisible — pair with "Create campaign" in admin.html to fix one in a
// click, prefilled with the exact value so there's no retyping to get
// wrong a second time.
app.get('/api/admin/marketing/unmatched-utm', requireAdmin, async (req, res) => {
  const rows = await db.all(`
    SELECT utm_campaign, COUNT(*) AS order_count, SUM(amount_usd) AS total_revenue
    FROM (
      SELECT utm_campaign, amount_usd FROM orders WHERE status = 'paid' AND utm_campaign IS NOT NULL
      UNION ALL
      SELECT utm_campaign, amount_usd FROM custom_orders WHERE status = 'paid' AND utm_campaign IS NOT NULL
    ) paid_orders
    WHERE LOWER(utm_campaign) NOT IN (SELECT LOWER(name) FROM ad_campaigns)
    GROUP BY utm_campaign
    ORDER BY total_revenue DESC
  `);
  res.json({
    unmatched: rows.map((r) => ({
      utmCampaign: r.utm_campaign,
      orderCount: Number(r.order_count),
      totalRevenue: Number(r.total_revenue),
    })),
  });
});

// On-demand historical backfill for syncMetaAdSpend, which otherwise only
// ever pulls yesterday — useful right after adding a campaign that's
// already been running for a while, or after spend sync was broken/unset
// for a stretch of real days. Walks backwards day by day (not a single
// wide date_range call) so it reuses the exact same per-day upsert path
// the daily cron does, including the same duplicate-safe ON CONFLICT.
app.post('/api/admin/marketing/backfill-meta', requireAdmin, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body.days) || 30));
  try {
    let totalSynced = 0;
    let dryRun = false;
    for (let i = 1; i <= days; i++) {
      const dateYmd = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = await syncMetaAdSpend(dateYmd);
      dryRun = result.dryRun;
      totalSynced += result.synced || 0;
      if (result.dryRun) break; // Meta isn't configured at all — no point looping further
    }
    res.json({ ok: true, dryRun, days, totalSynced });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Backfill failed.' });
  }
});

// Spend alone can't tell "this campaign isn't getting clicked" apart from
// "it gets clicked but doesn't convert" — pulls impressions/clicks live
// from Meta for a lookback window (not persisted; see
// getCampaignInsightsForRange in metaAds.js) so a bad-ROAS campaign can
// actually be diagnosed instead of just flagged.
app.get('/api/admin/marketing/campaigns/:id/insights', requireAdmin, async (req, res) => {
  const campaign = await db.get(`SELECT * FROM ad_campaigns WHERE id = ?`, [Number(req.params.id)]);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
  if (!campaign.meta_campaign_id) {
    return res.status(400).json({ error: "This campaign isn't linked to a real Meta campaign yet — sync spend at least once first." });
  }
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const insights = await metaAds.getCampaignInsightsForRange(campaign.meta_campaign_id, since, until);
    res.json({ ok: true, ...insights, since, until });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not fetch insights.' });
  }
});

// The marketing list itself — see marketing_subscribers in db.js. "active"
// excludes anyone who has since hit the real unsubscribe link (which sets
// unsubscribed_at here too, see /api/unsubscribe above) OR who's in the
// suppressions table directly (e.g. a hard bounce or spam complaint might
// suppress an address without that address ever calling this table's own
// unsubscribe path) — so "active" here always matches who mailer.js would
// actually be willing to send to today, not just this table's own flag.
app.get('/api/admin/marketing-subscribers', requireAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT ms.email, ms.source, ms.subscribed_at, ms.unsubscribed_at,
            (ms.unsubscribed_at IS NULL AND s.email IS NULL) AS active
     FROM marketing_subscribers ms LEFT JOIN suppressions s ON s.email = ms.email
     ORDER BY ms.subscribed_at DESC`
  );
  const activeCount = rows.filter((r) => r.active).length;
  const bySource = {};
  for (const r of rows) {
    if (!r.active) continue;
    bySource[r.source] = (bySource[r.source] || 0) + 1;
  }
  res.json({ subscribers: rows, activeCount, totalCount: rows.length, bySource });
});

// CSV export of the active list — the practical way to actually use it
// today (paste into whatever ESP the owner picks later) without this app
// taking on sending bulk marketing mail itself, which is a real
// deliverability/compliance undertaking of its own (see docs/audit-
// assembly.md) and deliberately out of scope here.
app.get('/api/admin/marketing-subscribers/export.csv', requireAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT ms.email, ms.source, ms.subscribed_at
     FROM marketing_subscribers ms LEFT JOIN suppressions s ON s.email = ms.email
     WHERE ms.unsubscribed_at IS NULL AND s.email IS NULL
     ORDER BY ms.subscribed_at DESC`
  );
  const escapeCsv = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['email,source,subscribed_at', ...rows.map((r) => [r.email, r.source, r.subscribed_at].map(escapeCsv).join(','))];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="whiskr-marketing-list.csv"');
  res.send(lines.join('\n'));
});

// Custom (print-on-demand) orders, for fulfillment visibility.
app.get('/api/admin/custom-orders', requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = status
    ? await db.all(`SELECT * FROM custom_orders WHERE status = ? ORDER BY created_at DESC`, [status])
    : await db.all(`SELECT * FROM custom_orders ORDER BY created_at DESC`);
  res.json({ orders: rows });
});

// Manual recovery for a custom order that was paid but never made it to
// Printful (submitCustomOrderToPrintful failed and left status='failed') —
// e.g. a transient Printful outage, or a bug in how the shipping address
// was read from the Stripe webhook payload. Only ever moves a 'failed'
// order back to 'paid' before retrying, so this can't re-submit an order
// that already succeeded ('submitted_to_printful') or was never paid.
app.post('/api/admin/custom-orders/:id/retry-printful', requireAdmin, async (req, res) => {
  const orderId = Number(req.params.id);
  const order = await db.get(`SELECT * FROM custom_orders WHERE id = ?`, [orderId]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'failed') {
    return res.status(400).json({ error: `Order is '${order.status}', not 'failed' — nothing to retry.` });
  }
  // A 'failed' order may have been saved with shipping_address already null
  // (this exact historical bug: the webhook read the wrong Stripe field, so
  // the address was lost before it ever reached this row) — re-fetch the
  // checkout session from Stripe itself and backfill it before retrying,
  // rather than trusting whatever's already stored.
  if (!order.shipping_address && stripe && order.stripe_session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      const shippingJson = extractShippingJson(session);
      if (shippingJson) {
        await db.run(`UPDATE custom_orders SET shipping_address = ? WHERE id = ?`, [shippingJson, orderId]);
      }
    } catch (err) {
      console.error(`[printful retry] could not re-fetch Stripe session for order #${orderId}:`, err.message);
    }
  }
  // Guarded on status='failed' the same way the webhook guards its own
  // paid-marking on status='pending' — without this condition, two
  // concurrent retries (two admin tabs, a flaky double-click) could both
  // pass the status check above and both flip this row to 'paid', and both
  // then call submitCustomOrderToPrintful, producing two real Printful
  // orders for one paid order.
  const flipped = await db.run(`UPDATE custom_orders SET status = 'paid' WHERE id = ? AND status = 'failed'`, [orderId]);
  if (flipped.changes === 0) {
    return res.status(409).json({ error: 'This order is already being retried elsewhere — refresh and check its status.' });
  }
  await submitCustomOrderToPrintful(orderId);
  const updated = await db.get(`SELECT status, printful_order_id FROM custom_orders WHERE id = ?`, [orderId]);
  res.json({ ok: true, status: updated.status, printfulOrderId: updated.printful_order_id });
});

// Site-wide error/alert feed — every alertAdmin() call (failed Printful
// submission, refund, dispute, etc.) lands here so admin.html can show it
// in one place instead of relying on ADMIN_EMAIL being configured and
// delivered. Unresolved first, newest first, so the panel opens on what
// still needs attention.
// Commission queue: what is booked, what is being painted, what is waiting
// on a balance payment before it can ship.
app.get('/api/admin/commissions', requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = status
    ? await db.all(`SELECT * FROM commissions WHERE status = ? ORDER BY created_at DESC`, [status])
    : await db.all(`SELECT * FROM commissions ORDER BY created_at DESC`);
  res.json({
    commissions: rows.map((c) => ({
      ...c,
      sizeLabel: (commissionPricing.getSize(c.size_id) || {}).label || c.size_id,
      payUrl: c.status === 'balance_pending' ? commissionPayUrl(c) : null,
    })),
  });
});

// Painting's finished: create a Stripe session for the remaining balance
// and email it to the customer with a photo of the work. This is a manual
// step on purpose — the balance is never auto-charged, so the customer
// always sees the finished painting before paying the rest of it.
app.post('/api/admin/commissions/:id/request-balance', requireAdmin, upload.single('painting'), async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured on this server yet.' });
    }
    // parseRowId, not Number(): Number('abc') is NaN and Number('1e99') is a
    // finite number no int4 column can hold, and both reach Postgres as
    // errors rather than misses. A bad id is a 400 here, not a 500.
    const id = parseRowId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid commission id.' });
    const booking = await db.get(`SELECT * FROM commissions WHERE id = ?`, [id]);
    if (!booking) return res.status(404).json({ error: 'Commission not found.' });
    // Only a paid deposit can progress to a balance request (or, once it has,
    // be re-sent). Asking for the balance on an unpaid, refunded or already-
    // settled booking is always a mistake, and a wrong payment request to a
    // customer is a worse one than a rejected button click.
    if (booking.status !== 'deposit_paid' && booking.status !== 'balance_pending') {
      return res.status(400).json({
        error: `Commission #${id} is '${booking.status}' — a balance can only be requested once the deposit is paid and before the balance is settled.`,
      });
    }

    // The balance is billed through a permanent signed link rather than a
    // Checkout URL: Stripe Checkout sessions expire after 24 hours, and a
    // customer may open this email days later. The link makes a fresh
    // session each time (GET /api/commissions/:id/pay below).
    // The finished painting's photo goes in the email so the customer sees the
    // work before paying. Uploaded here, or reused from an earlier request.
    let paintingPath = booking.painting_photo_path || null;
    if (req.file) paintingPath = await storePhoto(req.file);
    await db.run(
      `UPDATE commissions SET status = 'balance_pending', painting_photo_path = ?, balance_requested_at = ? WHERE id = ?`,
      [paintingPath, new Date().toISOString(), id]
    );
    const payUrl = commissionPayUrl(booking);
    const paintingImageUrl = paintingPath
      ? (paintingPath.startsWith('http') ? paintingPath : `${BASE_URL}${paintingPath}`)
      : null;
    await mailer.sendCommissionBalanceDue({
      email: booking.email,
      petName: booking.pet_name,
      balanceUsd: Number(booking.balance_usd).toFixed(2),
      payUrl,
      paintingImageUrl,
    });

    res.json({ ok: true, url: payUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not request the balance.' });
  }
});

function commissionPayUrl(booking) {
  return `${BASE_URL}/api/commissions/${booking.id}/pay?token=${commissionPayToken.tokenFor(booking.id, booking.email)}`;
}

// A Checkout session for a commission's remaining balance.
async function createBalanceSession(booking) {
  return stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: booking.email,
    automatic_tax: { enabled: true },
    payment_intent_data: { statement_descriptor_suffix: 'WHISKR', receipt_email: booking.email },
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Balance — original acrylic${booking.pet_name ? ` of ${booking.pet_name}` : ''}`,
            description: `Remaining balance on commission #${booking.id}. Deposit of $${Number(booking.deposit_usd).toFixed(2)} already paid.`,
          },
          unit_amount: Math.round(Number(booking.balance_usd) * 100),
          tax_behavior: 'exclusive',
        },
        quantity: 1,
      },
    ],
    metadata: { orderType: 'commission_balance', orderId: String(booking.id) },
    success_url: `${BASE_URL}/commission?paid=1`,
    cancel_url: `${BASE_URL}/commission`,
  });
}

// The "Pay the balance" link from the painting-finished email. Signed, and
// good for as long as the balance is outstanding: each visit retires the
// previous Checkout session and opens a new one.
app.get('/api/commissions/:id/pay', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  try {
    const id = parseRowId(req.params.id);
    const booking = id === null ? null : await db.get(`SELECT * FROM commissions WHERE id = ?`, [id]);
    if (!booking || !commissionPayToken.verify(booking.id, booking.email, req.query.token)) {
      return res.status(403).send(simplePage('This link isn\'t valid', 'Use the payment link from your painting-finished email, or email <a href="mailto:contest@whiskr.lol">contest@whiskr.lol</a> and we\'ll send a new one.'));
    }
    if (booking.status === 'balance_paid') {
      return res.send(simplePage('Already paid — thank you', 'The balance on this painting is paid. It will be varnished, packed and shipped to you. Questions? Email <a href="mailto:contest@whiskr.lol">contest@whiskr.lol</a>.'));
    }
    if (booking.status !== 'balance_pending' || !stripe) {
      return res.status(409).send(simplePage('This payment isn\'t open right now', 'Email <a href="mailto:contest@whiskr.lol">contest@whiskr.lol</a> and we\'ll sort it out.'));
    }
    // If the last session was already paid and the webhook hasn't landed yet,
    // don't open a second one; otherwise retire it so only one can be paid.
    if (booking.balance_session_id) {
      const previous = await stripe.checkout.sessions.retrieve(booking.balance_session_id).catch(() => null);
      if (previous && previous.status === 'complete') {
        return res.send(simplePage('Payment received', 'Your payment went through and is being confirmed. You\'ll get a receipt by email.'));
      }
      if (previous && previous.status === 'open') {
        await stripe.checkout.sessions.expire(previous.id).catch(() => {});
      }
    }
    const session = await createBalanceSession(booking);
    await db.run(`UPDATE commissions SET balance_session_id = ? WHERE id = ?`, [session.id, booking.id]);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('[commission pay] failed:', err);
    res.status(500).send(simplePage('Something went wrong', 'Please try the link again in a minute, or email <a href="mailto:contest@whiskr.lol">contest@whiskr.lol</a>.'));
  }
});

// Validates a path id before it reaches the database. Number('abc') is NaN
// and Number('1e99') is a valid integer that no int4 column can hold --
// both reach Postgres as errors rather than misses, and an uncaught one
// takes the process down. Bounded to int4 so a bad id is a 400, not a 500.
const PG_MAX_INT = 2147483647;
function parseRowId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id >= 1 && id <= PG_MAX_INT ? id : null;
}

// Shipment detail for one order, for the admin table's expand view.
app.get('/api/admin/custom-orders/:id/shipments', requireAdmin, async (req, res) => {
  // Validated before it reaches the database: Number('abc') is NaN, Postgres
  // rejects NaN for an integer column, and the rejection escaped this async
  // handler as an unhandled rejection that took the whole process down.
  // Confirmed by request, not by reading -- a malformed admin URL crashed
  // the server rather than returning an error.
  const id = parseRowId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: 'Invalid order id.' });
  }
  try {
    const shipments = await db.all(
      `SELECT * FROM custom_order_shipments WHERE custom_order_id = ? ORDER BY id ASC`,
      [id]
    );
    res.json({ shipments });
  } catch (err) {
    console.error(`[admin] shipments lookup failed for order ${id}:`, err.message);
    res.status(500).json({ error: 'Could not load shipments.' });
  }
});

// Pull the latest shipment state from Printful for one order, on demand --
// for answering "where is my order?" without waiting for the daily poll.
app.post('/api/admin/custom-orders/:id/refresh-shipping', requireAdmin, async (req, res) => {
  try {
    const id = parseRowId(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: 'Invalid order id.' });
    }
    const order = await db.get(`SELECT id FROM custom_orders WHERE id = ?`, [id]);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const result = await syncOrderShipments(id, { notify: false });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not refresh shipping.' });
  }
});

// Runs the delivery poll and the stalled-shipment check immediately, for
// testing without waiting a day for the cron.
app.post('/api/admin/run-shipment-sync', requireAdmin, async (req, res) => {
  try {
    await pollShipmentDeliveries();
    await flagStalledShipments();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The winner archive's editable side: every completed round, with whatever
// painting and story it currently has.
app.get('/api/admin/winners', requireAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT c.id, c.label, c.closes_at, c.painting_photo_path, c.winner_story,
            s.id AS submission_id, s.cat_name, s.photo_path, s.email
       FROM contests c
       JOIN groups g ON g.id = c.group_id
       JOIN submissions s ON s.id = g.winner_submission_id
      WHERE c.status = 'completed'
      ORDER BY c.closes_at DESC`
  );
  res.json({ winners: rows });
});

// Upload the finished painting for a round, and/or set its one-line story.
// Both optional and independent: the story can be written the day a round
// closes, the painting arrives weeks later.
app.post('/api/admin/winners/:contestId', requireAdmin, upload.single('painting'), async (req, res) => {
  try {
    const contestId = parseRowId(req.params.contestId);
    if (contestId === null) return res.status(400).json({ error: 'Invalid contest id.' });

    const contest = await db.get(`SELECT id, status FROM contests WHERE id = ?`, [contestId]);
    if (!contest) return res.status(404).json({ error: 'Round not found.' });
    if (contest.status !== 'completed') {
      return res.status(400).json({ error: 'That round has not closed yet.' });
    }

    if (req.file) {
      const paintingPath = await storePhoto(req.file);
      await db.run(
        `UPDATE contests SET painting_photo_path = ?, painting_shown_at = ? WHERE id = ?`,
        [paintingPath, new Date().toISOString(), contestId]
      );
    }

    if (typeof req.body.story === 'string') {
      // Stripped of newlines and bounded, same as every other
      // owner-supplied string that ends up in a page and an email.
      const story = req.body.story.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
      await db.run(`UPDATE contests SET winner_story = ? WHERE id = ?`, [story || null, contestId]);
    }

    const updated = await db.get(
      `SELECT id, label, painting_photo_path, winner_story FROM contests WHERE id = ?`,
      [contestId]
    );
    res.json({ ok: true, round: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not update that round.' });
  }
});

app.get('/api/admin/alerts', requireAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT * FROM admin_alerts ORDER BY resolved ASC, created_at DESC LIMIT 100`
  );
  res.json({ alerts: rows });
});

app.post('/api/admin/alerts/:id/resolve', requireAdmin, async (req, res) => {
  const alertId = Number(req.params.id);
  const alert = await db.get(`SELECT id FROM admin_alerts WHERE id = ?`, [alertId]);
  if (!alert) return res.status(404).json({ error: 'Alert not found.' });
  await db.run(`UPDATE admin_alerts SET resolved = 1 WHERE id = ?`, [alertId]);
  res.json({ ok: true });
});

// Moderation queue — pending by default, since that's what needs a look.
app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  const approved = req.query.approved === '1' ? 1 : 0;
  const rows = await db.all(`SELECT * FROM reviews WHERE approved = ? ORDER BY created_at ASC`, [approved]);
  res.json({ reviews: rows });
});

// Background slideshow management — see admin.html's "Background slideshow"
// section. Uploading the first photo turns the slideshow on; deleting the
// last one turns it back off (plain hero background, no fallback photos).
app.get('/api/admin/background', requireAdmin, async (req, res) => {
  const slides = await db.all(`SELECT id, image_path, position FROM background_slides ORDER BY position ASC, id ASC`);
  res.json({ slides });
});
app.post('/api/admin/background', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A photo is required.' });
  const imagePath = await storePhoto(req.file);
  const maxPos = await db.get(`SELECT COALESCE(MAX(position), -1) AS m FROM background_slides`);
  const info = await db.run(
    `INSERT INTO background_slides (image_path, position, created_at) VALUES (?, ?, ?) RETURNING id`,
    [imagePath, Number(maxPos.m) + 1, new Date().toISOString()]
  );
  res.json({ id: info.rows[0].id, image_path: imagePath });
});
app.delete('/api/admin/background/:id', requireAdmin, async (req, res) => {
  const info = await db.run(`DELETE FROM background_slides WHERE id = ?`, [Number(req.params.id)]);
  if (info.changes === 0) return res.status(404).json({ error: 'Slide not found.' });
  res.json({ ok: true });
});

// Featured-originals showcase management — see admin.html's "Featured
// originals" section. Uploading the first photo turns the homepage
// showcase on; deleting the last one returns it to the honest "still
// drying" empty state.
app.get('/api/admin/originals', requireAdmin, async (req, res) => {
  const originals = await db.all(
    `SELECT id, image_path, cat_name, source_photo_path, position FROM featured_originals ORDER BY position ASC, id ASC`
  );
  res.json({ originals });
});
app.post(
  '/api/admin/originals',
  requireAdmin,
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'sourcePhoto', maxCount: 1 }]),
  async (req, res) => {
  const photo = req.files && req.files.photo && req.files.photo[0];
  const sourcePhoto = req.files && req.files.sourcePhoto && req.files.sourcePhoto[0];
  if (!photo) return res.status(400).json({ error: 'A photo of the painting is required.' });
  const catName = (req.body.catName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60) || null;
  const imagePath = await storePhoto(photo);
  // The photo it was painted from. Optional, but /commission only shows an
  // original in its before/after gallery once it has one.
  const sourcePhotoPath = sourcePhoto ? await storePhoto(sourcePhoto) : null;
  const maxPos = await db.get(`SELECT COALESCE(MAX(position), -1) AS m FROM featured_originals`);
  const info = await db.run(
    `INSERT INTO featured_originals (image_path, cat_name, source_photo_path, position, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [imagePath, catName, sourcePhotoPath, Number(maxPos.m) + 1, new Date().toISOString()]
  );
  res.json({ id: info.rows[0].id, image_path: imagePath, cat_name: catName, source_photo_path: sourcePhotoPath });
});
app.delete('/api/admin/originals/:id', requireAdmin, async (req, res) => {
  const info = await db.run(`DELETE FROM featured_originals WHERE id = ?`, [Number(req.params.id)]);
  if (info.changes === 0) return res.status(404).json({ error: 'Original not found.' });
  res.json({ ok: true });
});

// Admin-editable homepage promo slots — a starburst badge over the hero
// and two middle-of-page feature blocks (image + text each). Each slot is
// a fixed row (see site_blocks in db.js), upserted rather than freely
// created — same fixed-slot pattern as product_media below. Hidden on the
// public page whenever a slot's text and image are both empty.
const SITE_BLOCK_SLOTS = new Set(['starburst', 'feature_1', 'feature_2']);

app.get('/api/admin/site-blocks', requireAdmin, async (req, res) => {
  const rows = await db.all(`SELECT * FROM site_blocks`);
  const bySlot = Object.fromEntries(rows.map((r) => [r.slot, r]));
  const blocks = {};
  for (const slot of SITE_BLOCK_SLOTS) {
    const r = bySlot[slot];
    blocks[slot] = { text: r ? r.text : null, imagePath: r ? r.image_path : null, color: r ? r.color : null };
  }
  res.json({ blocks });
});

app.post('/api/admin/site-blocks/:slot', requireAdmin, upload.single('photo'), async (req, res) => {
  const slot = req.params.slot;
  if (!SITE_BLOCK_SLOTS.has(slot)) return res.status(404).json({ error: 'Unknown slot.' });
  const text = String(req.body.text || '').trim().slice(0, 200) || null;
  const color = slot === 'starburst' ? String(req.body.color || '').trim().slice(0, 20) || null : null;
  // A photo isn't required on every save — COALESCE keeps the existing
  // image_path when no new file comes in, same as product_media below.
  const imagePath = req.file ? await storePhoto(req.file) : null;
  await db.run(
    `INSERT INTO site_blocks (slot, text, image_path, color, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slot) DO UPDATE SET
       text = EXCLUDED.text,
       image_path = COALESCE(EXCLUDED.image_path, site_blocks.image_path),
       color = EXCLUDED.color,
       updated_at = EXCLUDED.updated_at`,
    [slot, text, imagePath, color, new Date().toISOString()]
  );
  res.json({ ok: true });
});

// Clears just a feature block's photo, keeping its text intact — mirrors
// /api/admin/products/:id/photo below.
app.delete('/api/admin/site-blocks/:slot/photo', requireAdmin, async (req, res) => {
  const slot = req.params.slot;
  if (!SITE_BLOCK_SLOTS.has(slot)) return res.status(404).json({ error: 'Unknown slot.' });
  await db.run(`UPDATE site_blocks SET image_path = NULL, updated_at = ? WHERE slot = ?`, [
    new Date().toISOString(), slot,
  ]);
  res.json({ ok: true });
});

// Footer photo wall — see admin.html's "Footer photo wall" section. A
// static two-row grid across the full page width; empty table = no strip
// at all, same pattern as background_slides above.
app.get('/api/admin/footer-strip', requireAdmin, async (req, res) => {
  const images = await db.all(
    `SELECT id, image_path, position FROM footer_strip_images ORDER BY position ASC, id ASC`
  );
  res.json({ images });
});
app.post('/api/admin/footer-strip', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A photo is required.' });
  const imagePath = await storePhoto(req.file);
  const maxPos = await db.get(`SELECT COALESCE(MAX(position), -1) AS m FROM footer_strip_images`);
  const info = await db.run(
    `INSERT INTO footer_strip_images (image_path, position, created_at) VALUES (?, ?, ?) RETURNING id`,
    [imagePath, Number(maxPos.m) + 1, new Date().toISOString()]
  );
  res.json({ id: info.rows[0].id, image_path: imagePath });
});
app.delete('/api/admin/footer-strip/:id', requireAdmin, async (req, res) => {
  const info = await db.run(`DELETE FROM footer_strip_images WHERE id = ?`, [Number(req.params.id)]);
  if (info.changes === 0) return res.status(404).json({ error: 'Photo not found.' });
  res.json({ ok: true });
});

// "Live painting sessions" homepage section — a manual on/off switch
// (unlike the empty-state-hides-itself sections above), plus the
// currently-live embed state and the list of past sessions. See
// live_stream_settings/live_sessions in db.js.
app.get('/api/admin/live-stream', requireAdmin, async (req, res) => {
  const settings = await db.get(`SELECT * FROM live_stream_settings WHERE key = 'main'`);
  const sessions = await db.all(
    `SELECT * FROM live_sessions ORDER BY position ASC, id DESC`
  );
  res.json({
    settings: settings
      ? { enabled: !!settings.enabled, isLive: !!settings.is_live, embedUrl: settings.embed_url, nextSessionAt: settings.next_session_at }
      : { enabled: false, isLive: false, embedUrl: null, nextSessionAt: null },
    sessions,
  });
});

app.post('/api/admin/live-stream/settings', requireAdmin, async (req, res) => {
  const enabled = req.body.enabled ? 1 : 0;
  const isLive = req.body.isLive ? 1 : 0;
  const embedUrl = String(req.body.embedUrl || '').trim().slice(0, 500) || null;
  const nextSessionAtRaw = String(req.body.nextSessionAt || '').trim();
  const nextSessionAt = nextSessionAtRaw && !isNaN(Date.parse(nextSessionAtRaw))
    ? new Date(nextSessionAtRaw).toISOString()
    : null;
  await db.run(
    `INSERT INTO live_stream_settings (key, enabled, is_live, embed_url, next_session_at, updated_at)
     VALUES ('main', ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       is_live = EXCLUDED.is_live,
       embed_url = EXCLUDED.embed_url,
       next_session_at = EXCLUDED.next_session_at,
       updated_at = EXCLUDED.updated_at`,
    [enabled, isLive, embedUrl, nextSessionAt, new Date().toISOString()]
  );
  res.json({ ok: true });
});

app.post('/api/admin/live-stream/sessions', requireAdmin, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const sessionDate = String(req.body.sessionDate || '').trim().slice(0, 40);
  const videoUrl = String(req.body.videoUrl || '').trim().slice(0, 500) || null;
  if (!title || !sessionDate) return res.status(400).json({ error: 'A title and date are required.' });
  const maxPos = await db.get(`SELECT COALESCE(MAX(position), -1) AS m FROM live_sessions`);
  const info = await db.run(
    `INSERT INTO live_sessions (title, session_date, video_url, position, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [title, sessionDate, videoUrl, Number(maxPos.m) + 1, new Date().toISOString()]
  );
  res.json({ id: info.rows[0].id });
});

app.delete('/api/admin/live-stream/sessions/:id', requireAdmin, async (req, res) => {
  const info = await db.run(`DELETE FROM live_sessions WHERE id = ?`, [Number(req.params.id)]);
  if (info.changes === 0) return res.status(404).json({ error: 'Session not found.' });
  res.json({ ok: true });
});

// Admin-managed catalog photo + copy for the fixed product set in
// products.js — see product_media in db.js. Not a free-add list: :id must
// be a real catalog id, and there's exactly one row per product, upserted
// rather than freshly created each time a photo or field changes.
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  const media = await db.all(`SELECT * FROM product_media`);
  const byId = Object.fromEntries(media.map((m) => [m.product_id, m]));
  const products = productCatalog.listProducts('all').map((p) => {
    const m = byId[p.id];
    return {
      id: p.id,
      name: p.name,
      species: p.species,
      priceUsd: p.priceUsd,
      description: p.description,
      mockupAspect: p.mockupAspect,
      imagePath: m ? m.image_path : null,
      imageAlt: m ? m.image_alt : null,
      seoTitle: m ? m.seo_title : null,
      seoDescription: m ? m.seo_description : null,
      descriptionOverride: m ? m.description_override : null,
      hidden: m ? Boolean(Number(m.hidden)) : false,
    };
  });
  res.json({ products });
});

app.post('/api/admin/products/:id', requireAdmin, upload.single('photo'), async (req, res) => {
  const product = productCatalog.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Unknown product.' });

  // A photo isn't required on every save — this same endpoint also saves
  // just-edited text fields. COALESCE below keeps the existing image_path
  // when no new file comes in, instead of wiping a photo on a text-only edit.
  const imagePath = req.file ? await storePhoto(req.file) : null;
  const imageAlt = String(req.body.imageAlt || '').trim().slice(0, 200) || null;
  const seoTitle = String(req.body.seoTitle || '').trim().slice(0, 200) || null;
  const seoDescription = String(req.body.seoDescription || '').trim().slice(0, 500) || null;
  const descriptionOverride = String(req.body.description || '').trim().slice(0, 500) || null;

  // On/off is NOT saved here — it has its own one-click switch (the
  // /visibility route below). A photo/copy save leaves it exactly as it was,
  // so saving a form that was loaded before a toggle can't flip it back.
  await db.run(
    `INSERT INTO product_media (product_id, image_path, image_alt, seo_title, seo_description, description_override, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (product_id) DO UPDATE SET
       image_path = COALESCE(EXCLUDED.image_path, product_media.image_path),
       image_alt = EXCLUDED.image_alt,
       seo_title = EXCLUDED.seo_title,
       seo_description = EXCLUDED.seo_description,
       description_override = EXCLUDED.description_override,
       updated_at = EXCLUDED.updated_at`,
    [product.id, imagePath, imageAlt, seoTitle, seoDescription, descriptionOverride, new Date().toISOString()]
  );
  res.json({ ok: true });
});

// The per-product on/off switch in admin.html. Off pulls the product from
// everywhere a customer or crawler can find it — shop grid, /shop pages
// (which then 404), sitemap, llms.txt, JSON-LD — and blocks new orders in
// POST /api/custom-orders. Past orders, photo and copy are untouched, so
// switching it back on restores it exactly.
app.post('/api/admin/products/:id/visibility', requireAdmin, async (req, res) => {
  const product = productCatalog.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Unknown product.' });
  const hidden = req.body.enabled ? 0 : 1;
  await db.run(
    `INSERT INTO product_media (product_id, hidden, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (product_id) DO UPDATE SET hidden = EXCLUDED.hidden, updated_at = EXCLUDED.updated_at`,
    [product.id, hidden, new Date().toISOString()]
  );
  res.json({ ok: true, enabled: !hidden });
});

// Clears just the photo, keeping alt/SEO/description text intact — reverts
// that product to the honest text-only card until a new photo is uploaded.
app.delete('/api/admin/products/:id/photo', requireAdmin, async (req, res) => {
  const product = productCatalog.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Unknown product.' });
  await db.run(`UPDATE product_media SET image_path = NULL, updated_at = ? WHERE product_id = ?`, [
    new Date().toISOString(), product.id,
  ]);
  res.json({ ok: true });
});

app.post('/api/admin/reviews/:id/approve', requireAdmin, async (req, res) => {
  const info = await db.run(`UPDATE reviews SET approved = 1 WHERE id = ?`, [Number(req.params.id)]);
  if (info.changes === 0) return res.status(404).json({ error: 'Review not found.' });
  res.json({ ok: true });
});
// "Reject" just removes it — there's no public-facing rejected state, and
// keeping spam/abuse around serves no purpose.
app.post('/api/admin/reviews/:id/reject', requireAdmin, async (req, res) => {
  const info = await db.run(`DELETE FROM reviews WHERE id = ?`, [Number(req.params.id)]);
  if (info.changes === 0) return res.status(404).json({ error: 'Review not found.' });
  res.json({ ok: true });
});

// Sends any due review-request emails immediately, for testing — in normal
// operation the daily Vercel Cron hit below does this.
app.post('/api/admin/run-review-requests', requireAdmin, async (req, res) => {
  await sendDueReviewRequests();
  res.json({ ok: true });
});
// Runs the rank-drop alert check immediately, for testing — in normal
// operation the daily cron does this.
app.post('/api/admin/run-rank-drop-alerts', requireAdmin, async (req, res) => {
  await sendRankDropAlerts();
  res.json({ ok: true });
});

app.post('/api/admin/run-roas-alerts', requireAdmin, async (req, res) => {
  await checkRoasAlerts();
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- background schedule ----------
// Hit once a day by Vercel Cron (see the "crons" entry in vercel.json) —
// replaces the in-process node-cron scheduler that ran on the old always-on
// host, since a serverless function has no long-lived process to keep a
// timer running in. Closes any contest whose closes_at has passed (tallying
// votes and awarding the #1 vote-getter the painting — see
// runDueContestClose/tallyAndCloseContest), and sends paid orders' review
// requests once they're old enough.
//
// Vercel signs cron requests with `Authorization: Bearer <CRON_SECRET>`
// when CRON_SECRET is set as an env var, which is how this route tells a
// real scheduled invocation apart from a random request to the same URL.
app.get('/api/cron/daily', async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).send('Unauthorized');
    }
  } else {
    console.warn('[cron] CRON_SECRET is not set — /api/cron/daily is unauthenticated.');
  }

  try {
    await runDueContestClose();
    await passUnclaimedPrizes();
    await sendRankDropAlerts();
    await sendDueReviewRequests();
    // Delivery is polled because Printful publishes no "delivered" event.
    // Isolated like the Meta sync below: a Printful outage must not stop
    // contest closing or review requests, which need no third party.
    try {
      await pollShipmentDeliveries();
      await flagStalledShipments();
    } catch (err) {
      console.error('[cron] shipment sync failed:', err.message);
    }
    // Isolated from the steps above: a Meta API hiccup (rate limit, an
    // expired token, a transient outage) should never block contest
    // closing or review requests, which don't depend on any third party.
    try {
      await syncMetaAdSpend();
    } catch (err) {
      console.error('[cron] Meta ad spend sync failed:', err.message);
    }
    await checkRoasAlerts();
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron] daily run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Anything no route above answered. API callers parse JSON; people get a
// real page instead of Express's bare "Cannot GET".
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>Page not found — Whiskr</title><meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" href="/style.css" /></head>
<body><main style="max-width:520px;margin:80px auto;padding:0 24px;text-align:center;">
<h1>We couldn't find that page.</h1>
<p>It may have moved, or the link may have been cut short.</p>
<p><a href="/">Home</a> · <a href="/vote.html">Vote</a> · <a href="/shop">Shop</a></p>
</main></body></html>`);
});

// Module scope, not inside app.listen() below — on Vercel this file is
// required once per cold start and the exported app is invoked per-request,
// so a warning gated on app.listen() (which never runs there) would never
// print anywhere, local dev included. These print once per cold start on
// every environment instead.
// Upload rejections (a wrong file type, a photo over the size limit) happen
// inside multer, before any route handler runs, so they used to fall through
// to Express's default handler — an HTML stack trace that leaked server file
// paths, which the entry/order forms then failed to parse and showed the
// customer as gibberish. Every form here expects JSON { error }.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That photo is too large — please choose one under 8MB.'
        : 'That upload could not be read — please try a different photo.';
    return res.status(400).json({ error: message });
  }
  if (err && err.uploadRejected) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (!stripe) console.warn('[stripe] STRIPE_SECRET_KEY not set — checkout endpoint disabled.');
if (checkoutBlocker({ needsPrintful: true })) {
  console.warn(`[checkout] print checkout is CLOSED — missing ${checkoutBlocker({ needsPrintful: true }).join(', ')}. (ALLOW_UNFULFILLED_CHECKOUT=true overrides, for local dev only.)`);
}
if (stripe && !process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — paid orders will never be marked paid.');
}
if (!BLOB_CONFIGURED) {
  console.warn('[blob] BLOB_READ_WRITE_TOKEN not set — photos are being saved to local disk (fine for dev only).');
}
if (!process.env.ADMIN_EMAIL) {
  console.warn('[mail] ADMIN_EMAIL not set — a failed order, refund, or dispute will have no one to alert. Set it before taking real payments.');
}
if (!process.env.UNSUB_SECRET) {
  console.warn(
    process.env.ADMIN_KEY
      ? "[security] UNSUB_SECRET not set — falling back to ADMIN_KEY to sign discount/status/review/unsubscribe tokens, so your admin key doubles as a token-signing secret. Set UNSUB_SECRET to its own independent value."
      : '[security] Neither UNSUB_SECRET nor ADMIN_KEY is set — tokens are being signed with a hardcoded, publicly-known fallback secret. Anyone could forge a discount/status/review/unsubscribe link. Set UNSUB_SECRET before taking real traffic.'
  );
}

if (require.main === module) {
  // Only listens when run directly (`node server.js` / `npm start`) — on
  // Vercel this file is required as a module and the exported app is
  // invoked per-request instead, so app.listen() here would be both
  // pointless and never reached.
  app.listen(PORT, () => {
    console.log(`Whiskr server running on ${BASE_URL}`);
    console.log(`Contest rounds: calendar months (Central time) | Winners per contest: ${CONTEST_WINNERS_COUNT}`);
  });
}

module.exports = app;
