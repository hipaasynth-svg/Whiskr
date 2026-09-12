require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { put: putBlob } = require('@vercel/blob');
const { v4: uuid } = require('uuid');

const sharp = require('sharp');

const db = require('./db');
const mailer = require('./mailer');
const unsubscribe = require('./unsubscribe');
const reviewLink = require('./reviewLink');
const discountToken = require('./discountToken');
const statusToken = require('./statusToken');
const productCatalog = require('./products');
const printful = require('./printful');
const phoneCases = require('./phoneCases');
const metaAds = require('./metaAds');
const seo = require('./seo');

const app = express();
// Vercel (and most PaaS hosts) sit in front of this app as a reverse proxy —
// without trust proxy, req.ip is the proxy's own address for every request,
// which would make the vote rate-limiter below useless (every visitor looks
// like the same "IP").
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
// Real public-voting contest sizing. CONTEST_LENGTH_DAYS is how long entry +
// voting stays open before a contest closes and promotes its top vote-getters
// into a calendar; CONTEST_WINNERS_COUNT is how many of them do.
const CONTEST_LENGTH_DAYS = Number(process.env.CONTEST_LENGTH_DAYS || 30);
const CONTEST_WINNERS_COUNT = Number(process.env.CONTEST_WINNERS_COUNT || 12);
// Anti-fraud vote rate limits — generous enough for a real family sharing a
// link, tight enough to slow down a script or a bought-votes farm. Neither
// of these stops determined abuse alone; see requireCaptcha below and the
// admin fraud-review view for the rest of the defense.
const VOTE_LIMIT_PER_VOTER_PER_DAY = Number(process.env.VOTE_LIMIT_PER_VOTER_PER_DAY || 30);
const VOTE_LIMIT_PER_IP_PER_DAY = Number(process.env.VOTE_LIMIT_PER_IP_PER_DAY || 60);
// Same anti-fraud shape as voting above, applied to the two endpoints that
// previously had no limit at all: a real cat owner never submits or orders
// this many times a day, but a script flooding fake entries or fake print
// orders can hit either endpoint as fast as it likes without this.
const SUBMISSION_LIMIT_PER_IP_PER_DAY = Number(process.env.SUBMISSION_LIMIT_PER_IP_PER_DAY || 5);
const CUSTOM_ORDER_LIMIT_PER_IP_PER_DAY = Number(process.env.CUSTOM_ORDER_LIMIT_PER_IP_PER_DAY || 10);
// Salts the IP hash stored in the votes table so raw IPs are never persisted.
// Set a real random value in production — the default is fine for local dev
// only, since anyone who knows it could pre-compute hashes for known IPs.
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'dev-only-insecure-salt';
// Post-entry / non-winner upsell discount. A percentage off, applied
// server-side to the custom-print line item — no Stripe Coupon object
// needed since checkout sessions here already build price_data inline.
const CONTEST_DISCOUNT_PERCENT = Number(process.env.CONTEST_DISCOUNT_PERCENT || 20);
const ENTRY_DISCOUNT_HOURS = Number(process.env.ENTRY_DISCOUNT_HOURS || 48);
const FINAL_RANK_DISCOUNT_HOURS = Number(process.env.FINAL_RANK_DISCOUNT_HOURS || 72);
// Below this on either dimension, a photo is flagged (not blocked — see
// checkImageQuality) as likely to look soft on a large print.
const MIN_PRINT_DIMENSION_PX = Number(process.env.MIN_PRINT_DIMENSION_PX || 2000);
// How many places an entrant's live rank has to worsen (or crossing out of
// the winner zone) before sendRankDropAlerts emails them again.
const RANK_DROP_THRESHOLD = Number(process.env.RANK_DROP_THRESHOLD || 5);

// Cat of the Year: DORMANT as of the 2026-09-11 simplification (see
// awardPainting/tallyAndCloseYearAward above) — every contest's #1 now gets
// the painting directly from that month's real vote, so this second ballot
// among monthly winners is a manual-override path only. Off by default —
// set YEAR_AWARD_MANUAL_VOTE_ENABLED=true to re-enable the routes below,
// rather than leaving them silently reachable the moment an 'open' row
// exists (e.g. via the admin override further down this file).
const YEAR_AWARD_VOTE_LIMIT_PER_IP = Number(process.env.YEAR_AWARD_VOTE_LIMIT_PER_IP || 5);
const YEAR_AWARD_MANUAL_VOTE_ENABLED = process.env.YEAR_AWARD_MANUAL_VOTE_ENABLED === 'true';

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
const PRICE_ONE = Number(process.env.CALENDAR_PRICE_USD || 24.99);
const PRICE_MULTI = Number(process.env.CALENDAR_2PLUS_PRICE_USD || 19.99);
// The calendar product itself is retired — the site no longer mentions or
// links to it anywhere — but the checkout/fulfillment code is kept as a
// dormant, flaggable feature rather than deleted, same treatment as the
// Cat of the Year vote above. Off by default: a real, unauthenticated
// Stripe checkout for a product nothing on the site sells shouldn't be
// reachable just because nothing links to it. Set CALENDAR_CHECKOUT_ENABLED
// =true only if this product is deliberately brought back.
const CALENDAR_CHECKOUT_ENABLED = process.env.CALENDAR_CHECKOUT_ENABLED === 'true';
// Physical products (calendars, custom prints) need a real ship-to address.
// Keep this list short by default — every country you add is one you're
// committing to handle customs/duties questions for.
const SHIPPING_COUNTRIES = (process.env.SHIPPING_COUNTRIES || 'US').split(',').map((c) => c.trim());
const REVIEW_REQUEST_DELAY_DAYS = Number(process.env.REVIEW_REQUEST_DELAY_DAYS || 14);

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// Runs on every request (see ensureDbReady below) but only does real work
// once per warm instance — required on Vercel since there's no long-lived
// startup phase to create tables in ahead of time the way a normal server
// would.
app.use(async (req, res, next) => {
  try {
    await db.initDb();
    next();
  } catch (err) {
    console.error('[db] failed to initialize:', err.message);
    res.status(500).send('Database is not reachable. Check POSTGRES_URL.');
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
      return cb(new Error('Only jpg, png, webp, or gif photos are accepted.'));
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
async function storePhoto(file) {
  const ext = EXT_FOR_MIME[file.mimetype] || '.jpg';
  const filename = `${uuid()}${ext}`;

  if (BLOB_CONFIGURED) {
    const blob = await putBlob(`uploads/${filename}`, file.buffer, {
      access: 'public',
      contentType: file.mimetype,
    });
    return blob.url;
  }

  const uploadDir = path.join(__dirname, 'public', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
  return `/uploads/${filename}`;
}

// Stores a raw buffer (not a multer file) under uploads/ the same way
// storePhoto does — used for generated assets like the share card, which
// don't come from an incoming form upload.
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
      html: `<p>${message}</p>`,
    })
    .catch(() => {});
}

// Submits a paid custom order to Printful for printing + shipping. Only
// ever called from the webhook below, after Stripe confirms payment — never
// at checkout time, and never more than once (custom_orders.status guards
// against a duplicate webhook delivery re-submitting the same order).
async function submitCustomOrderToPrintful(orderId) {
  const order = await db.get(`SELECT * FROM custom_orders WHERE id = ?`, [orderId]);
  if (!order || order.status !== 'paid') return;

  const product = productCatalog.getProduct(order.product_id);
  const recipient = printful.recipientFromStripeShipping(
    order.shipping_address ? JSON.parse(order.shipping_address) : null,
    order.email
  );

  try {
    const result = await printful.submitOrder({
      externalId: `custom-${order.id}`,
      variantId: order.variant_id || (product ? product.printfulVariantId : null),
      quantity: order.quantity,
      photoUrl: order.photo_path.startsWith('http') ? order.photo_path : `${BASE_URL}${order.photo_path}`,
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
    await db.run(`UPDATE custom_orders SET status = 'failed' WHERE id = ?`, [order.id]);
    await alertAdmin(
      `Custom order #${order.id} failed to submit to Printful`,
      `Custom order #${order.id} (${order.email}) was paid but failed to submit to Printful: ${err.message}. It needs manual attention.`
    );
    console.error(`[printful] failed to submit custom order #${order.id}:`, err.message);
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

// Stripe webhook needs the raw request body for signature verification, so
// it's mounted before the global express.json() parser below — otherwise
// json() would consume/parse the body first and constructEvent would fail.
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

  // Without this, /api/checkout creates an order row as 'pending' and
  // nothing ever marks it paid — there'd be no reliable record of who
  // actually paid or what to fulfill.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderType = session.metadata && session.metadata.orderType;
    const orderId = session.metadata && Number(session.metadata.orderId);
    const shippingJson = extractShippingJson(session);

    if (orderType === 'calendar' && orderId) {
      // Scoped to status='pending' so a retried webhook delivery (Stripe
      // resends on any non-2xx or slow response) can't re-mark an
      // already-paid order and re-trigger anything downstream of it.
      const info = await db.run(
        `UPDATE orders SET status = 'paid', shipping_address = ? WHERE id = ? AND status = 'pending'`,
        [shippingJson, orderId]
      );
      console.log(
        info.changes > 0
          ? `[stripe webhook] calendar order #${orderId} marked paid.`
          : `[stripe webhook] checkout.session.completed for unknown or already-processed calendar order #${orderId}`
      );
    } else if (orderType === 'custom' && orderId) {
      // Same idempotency guard — without it, a retried delivery resets an
      // already-'submitted_to_printful' order back to 'paid', which defeats
      // submitCustomOrderToPrintful's own status check and re-submits the
      // same order to Printful a second time.
      const info = await db.run(
        `UPDATE custom_orders SET status = 'paid', shipping_address = ? WHERE id = ? AND status = 'pending'`,
        [shippingJson, orderId]
      );
      if (info.changes > 0) {
        console.log(`[stripe webhook] custom order #${orderId} marked paid.`);
        await submitCustomOrderToPrintful(orderId);
      } else {
        console.log(`[stripe webhook] custom order #${orderId} already processed (duplicate delivery) — skipping.`);
      }
    } else {
      console.warn(`[stripe webhook] checkout.session.completed with unrecognized metadata for session ${session.id}`);
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
    try {
      if (paymentIntent) {
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
        } else if (orderType === 'calendar' && orderId) {
          await db.run(`UPDATE orders SET status = ? WHERE id = ?`, [newStatus, orderId]);
          await alertAdmin(
            `Order #${orderId} was ${newStatus}`,
            `Order #${orderId} was marked ${newStatus} in Stripe. It needs manual attention.`
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
// so these routes intercept /, /index.html, /calendar.html, /sitemap.xml
// instead of the static files of the same name) ----------

// Same query the /api/status JSON endpoint answers, shared so the
// server-rendered homepage and the client's live re-check never disagree.
async function getContestStatus() {
  const contest = await db.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
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
const CALENDAR_PATH = path.join(__dirname, 'public', 'calendar.html');

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

  return html;
}

// Served for /calendar.html while CALENDAR_CHECKOUT_ENABLED is off — a 410
// (permanently gone) tells crawlers to drop any old indexed link rather
// than leave them re-crawling a stale page, and gives a human who followed
// an old bookmark somewhere useful instead of a bare error.
const CALENDAR_GONE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>No longer available — Whiskr</title><meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" href="/style.css" /></head>
<body><div style="max-width:520px;margin:80px auto;padding:0 24px;text-align:center;">
<h1>This page is no longer available.</h1>
<p>Whiskr's contest now gives an original hand-painted portrait straight to each round's winner — there's no separate calendar to order.</p>
<p><a href="/">Back to Whiskr</a></p>
</div></body></html>`;

async function renderCalendarHtml(groupIdRaw) {
  let html = fs.readFileSync(CALENDAR_PATH, 'utf8');
  const groupId = Number(groupIdRaw);
  if (!groupId) return html;

  const group = await db.get(`SELECT * FROM groups WHERE id = ?`, [groupId]);
  if (!group) return html;

  const title = `Round #${groupId} calendar — Whiskr`;
  const description = group.status === 'completed'
    ? `This round's top vote-getters from Whiskr's free cat photo contest, decided by real public vote. Order this calendar as a print.`
    : `Whiskr contest round #${groupId} — voting still open. Check back once it closes.`;
  html = html.replace(/<title>.*?<\/title>/, `<title>${seo.escapeHtml(title)}</title>`);
  html = seo.injectIntoHead(html, `<meta name="description" content="${seo.escapeHtml(description)}" />
<meta property="og:title" content="${seo.escapeHtml(title)}" />
<meta property="og:description" content="${seo.escapeHtml(description)}" />
<meta property="og:type" content="product.group" />
<link rel="canonical" href="${BASE_URL}/calendar.html?group=${groupId}" />`);

  if (group.status === 'completed') {
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: title,
      description,
      offers: {
        '@type': 'Offer',
        price: PRICE_ONE.toFixed(2),
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        url: `${BASE_URL}/calendar.html?group=${groupId}`,
      },
    });
    html = seo.injectIntoHead(html, `<script type="application/ld+json">${jsonLd}</script>`);
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

app.get('/calendar.html', async (req, res, next) => {
  if (!CALENDAR_CHECKOUT_ENABLED) {
    res.status(410).set('Content-Type', 'text/html; charset=utf-8').send(CALENDAR_GONE_HTML);
    return;
  }
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(await renderCalendarHtml(req.query.group));
  } catch (err) {
    console.error('[render] calendar prerender failed, falling back to static file:', err.message);
    next();
  }
});

// Dynamic sitemap. year-award.html and per-round calendar.html pages are
// deliberately left out — both are dormant (see the 2026-09-11
// simplification note in docs/audit-assembly.md), nothing to index.
app.get('/sitemap.xml', async (req, res) => {
  const urls = [
    { loc: `${BASE_URL}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${BASE_URL}/vote.html`, changefreq: 'hourly', priority: '0.9' },
    { loc: `${BASE_URL}/rules.html`, changefreq: 'monthly', priority: '0.3' },
    { loc: `${BASE_URL}/privacy.html`, changefreq: 'monthly', priority: '0.2' },
    { loc: `${BASE_URL}/terms.html`, changefreq: 'monthly', priority: '0.2' },
    { loc: `${BASE_URL}/shipping.html`, changefreq: 'monthly', priority: '0.2' },
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${seo.escapeHtml(u.loc)}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(body);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
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
async function getOrOpenCurrentContest() {
  const open = await db.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (open) return open;

  const now = new Date();
  const closes = new Date(now.getTime() + CONTEST_LENGTH_DAYS * 24 * 60 * 60 * 1000);
  const label = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const info = await db.run(
    `INSERT INTO contests (label, opens_at, closes_at, status, created_at) VALUES (?, ?, ?, 'open', ?) RETURNING id`,
    [label, now.toISOString(), closes.toISOString(), now.toISOString()]
  );
  console.log(`[contest] Opened "${label}" (#${info.rows[0].id}), closes ${closes.toISOString()}`);
  return db.get(`SELECT * FROM contests WHERE id = ?`, [info.rows[0].id]);
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
  // Not a calendar product anymore — nothing public promotes or sells
  // this grouping; it's just how a round's outcome is stored.
  const winnersCount = Math.min(CONTEST_WINNERS_COUNT, ranked.length);
  const winners = ranked.slice(0, winnersCount);

  const groupId = await db.transaction(async (tx) => {
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

  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    const rank = i + 1;
    try {
      if (rank === 1) {
        const { deadline } = await awardPainting(s, `${contest.label} winner`);
        await mailer.sendWinnerEmail({ email: s.email, catName: s.cat_name, sculptureDeadline: deadline });
      } else {
        const discountExpiresAt = new Date(Date.now() + FINAL_RANK_DISCOUNT_HOURS * 60 * 60 * 1000).toISOString();
        await mailer.sendFinalRankEmail({
          email: s.email, catName: s.cat_name, rank, totalEntries: ranked.length,
          shopUrl: `${BASE_URL}/#shop-custom`,
          discount: {
            percent: CONTEST_DISCOUNT_PERCENT,
            email: s.email,
            expiresAt: discountExpiresAt,
            token: discountToken.tokenFor(s.email, discountExpiresAt),
          },
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

// Records the grand-prize win the instant a contest's #1 is decided —
// reuses the existing year_awards/year_award_finalists schema unchanged
// (so admin history and any dormant tooling built against it still work)
// but creates the row already 'completed' rather than 'open': there is no
// second vote anymore, the monthly vote that just happened already
// decided it. See tallyAndCloseYearAward below, kept only as a manual
// override path (POST /api/admin/year-award/open + /force-close still
// exist but nothing links to them anymore) in case a past round ever
// needs a correction.
async function awardPainting(winnerSubmission, label) {
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const info = await db.run(
    `INSERT INTO year_awards (label, opens_at, closes_at, status, winner_submission_id, sculpture_deadline, created_at)
     VALUES (?, ?, ?, 'completed', ?, ?, ?) RETURNING id`,
    [label, now, now, winnerSubmission.id, deadline, now]
  );
  await db.run(
    `INSERT INTO year_award_finalists (year_award_id, submission_id, vote_count) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [info.rows[0].id, winnerSubmission.id, winnerSubmission.vote_count]
  );
  return { yearAwardId: info.rows[0].id, deadline };
}

// DORMANT as of the 2026-09-11 simplification: every contest's #1 now
// wins the painting automatically via awardPainting (see
// tallyAndCloseContest above) — there's no separate vote to tally
// anymore, so nothing calls this function or its /api/admin/year-award/
// open + force-close routes from any linked UI. Left in place, unchanged,
// only as a manual override an operator could still reach directly (e.g.
// curl) if a past round ever needed hand-correcting; never re-link the
// admin "open a vote" form to it without first confirming that's really
// wanted, since it would create a confusing second vote alongside the
// automatic one.
async function tallyAndCloseYearAward(yearAwardId) {
  const award = await db.get(`SELECT * FROM year_awards WHERE id = ?`, [yearAwardId]);
  if (!award || award.status !== 'open') return null;

  const finalists = await db.all(
    `SELECT * FROM year_award_finalists WHERE year_award_id = ? ORDER BY vote_count DESC, id ASC`,
    [yearAwardId]
  );
  if (finalists.length === 0) {
    await db.run(`UPDATE year_awards SET status = 'completed' WHERE id = ?`, [yearAwardId]);
    console.warn(`[year-award] #${yearAwardId} closed with zero finalists — nothing to crown.`);
    return null;
  }

  const winner = finalists[0];
  const winnerSubmission = await db.get(`SELECT * FROM submissions WHERE id = ?`, [winner.submission_id]);
  await db.run(`UPDATE year_awards SET status = 'completed', winner_submission_id = ? WHERE id = ?`, [
    winnerSubmission.id, yearAwardId,
  ]);

  try {
    await mailer.sendCatOfYearEmail({
      email: winnerSubmission.email,
      catName: winnerSubmission.cat_name,
      sculptureDeadline: award.sculpture_deadline,
    });
  } catch (err) {
    console.error(`[mailer] Cat of the Year email failed for submission ${winnerSubmission.id}:`, err.message);
  }

  console.log(`[year-award] #${yearAwardId} closed. Cat of the Year: ${winnerSubmission.cat_name} (submission ${winnerSubmission.id}).`);
  return winnerSubmission.id;
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

  const dueCalendar = await db.all(
    `SELECT * FROM orders WHERE status = 'paid' AND review_requested_at IS NULL AND created_at <= ?`,
    [cutoff]
  );
  for (const o of dueCalendar) {
    const token = reviewLink.tokenFor('calendar', o.id, o.email);
    const reviewUrl = `${BASE_URL}/review.html?type=calendar&id=${o.id}&email=${encodeURIComponent(o.email)}&token=${token}`;
    try {
      await mailer.sendReviewRequest({ email: o.email, itemLabel: `Whiskr calendar (Group #${o.group_id})`, reviewUrl });
      await db.run(`UPDATE orders SET review_requested_at = ? WHERE id = ?`, [new Date().toISOString(), o.id]);
    } catch (err) {
      console.error(`[mailer] review request failed for order ${o.id}:`, err.message);
    }
  }

  const dueCustom = await db.all(
    `SELECT * FROM custom_orders WHERE status IN ('paid','submitted_to_printful') AND review_requested_at IS NULL AND created_at <= ?`,
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
// open, no batch to wait for. Making the calendar now depends entirely on
// votes from the public, not a queue position.
app.post('/api/submissions', upload.single('photo'), async (req, res) => {
  try {
    const { email, catName, photoRights } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A photo is required.' });
    }
    // Photo rights: before printing and selling a stranger's photo, we need
    // affirmative confirmation the submitter owns/has rights to it.
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
      `INSERT INTO submissions (email, cat_name, photo_path, created_at, photo_rights_consent_at, contest_id, photo_width, photo_height, low_resolution, share_image_path, utm_campaign, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [email, name, photoPath, now, now, contest.id, width, height, lowResolution, shareImagePath, utmCampaign, ipHash]
    );
    const submissionId = info.rows[0].id;
    const voteUrl = `${BASE_URL}/vote.html?cat=${submissionId}`;
    const statusUrl = `${BASE_URL}/status.html?cat=${submissionId}&email=${encodeURIComponent(email)}&token=${statusToken.tokenFor(submissionId, email)}`;

    // A time-limited discount on the evergreen print shop — the honest
    // version of a "pre-order mockup": no fake 3D render, just a real
    // incentive to buy a print of the photo they just uploaded while the
    // moment (and the discount) is still fresh.
    const discountExpiresAt = new Date(Date.now() + ENTRY_DISCOUNT_HOURS * 60 * 60 * 1000).toISOString();
    const discount = {
      percent: CONTEST_DISCOUNT_PERCENT,
      email,
      expiresAt: discountExpiresAt,
      token: discountToken.tokenFor(email, discountExpiresAt),
    };

    try {
      await mailer.sendEntryConfirmation({
        email, catName: name, voteUrl, statusUrl, closesAt: contest.closes_at, discount, shareImageUrl: shareImagePath,
      });
      await db.run(`UPDATE submissions SET notified_entry = 1 WHERE id = ?`, [submissionId]);
    } catch (err) {
      console.error(`[mailer] entry confirmation failed for submission ${submissionId}:`, err.message);
    }

    res.json({ ok: true, submissionId, voteUrl, statusUrl, lowResolution, width, height, discount, shareImageUrl: shareImagePath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// Public: the currently open contest and its entrants (no vote counts —
// see the vote endpoint below for why tallies stay hidden until close).
// Random order per request so late entrants get equal shelf space instead
// of always scrolling to the bottom.
app.get('/api/contest/current', async (req, res) => {
  const contest = await db.get(`SELECT * FROM contests WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (!contest) return res.json({ contest: null, entries: [] });
  const entries = await db.all(
    `SELECT id, cat_name, photo_path, share_image_path FROM submissions WHERE contest_id = ? AND disqualified = 0 ORDER BY RANDOM()`,
    [contest.id]
  );
  res.json({
    contest: { id: contest.id, label: contest.label, opensAt: contest.opens_at, closesAt: contest.closes_at },
    entries,
  });
});

// An entrant's private lookup of their own standing — the safe alternative
// to a public real-time leaderboard (which stays hidden on purpose; see the
// comment on /api/vote). Token-gated per submission so nobody can look up
// anyone else's. While the contest is still open this computes a LIVE rank
// on the fly (final_rank isn't set until close); once closed it reports the
// permanent final_rank instead.
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
    return res.json({
      catName: submission.cat_name,
      contestStatus: 'open',
      voteCount: submission.vote_count,
      liveRank,
      totalEntries: ranked.length,
      closesAt: contest.closes_at,
    });
  }

  return res.json({
    catName: submission.cat_name,
    contestStatus: 'completed',
    voteCount: submission.vote_count,
    finalRank: submission.final_rank,
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
      `SELECT s.*, c.status AS contest_status FROM submissions s
       JOIN contests c ON c.id = s.contest_id WHERE s.id = ?`,
      [submissionId]
    );
    if (!submission) return res.status(404).json({ error: 'Cat not found.' });
    if (submission.disqualified) return res.status(400).json({ error: 'This entry is no longer eligible.' });
    if (submission.contest_status !== 'open') {
      return res.status(400).json({ error: 'Voting has closed for this contest.' });
    }

    if (process.env.TURNSTILE_SECRET_KEY) {
      const captchaOk = await verifyTurnstile(req.body.turnstileToken, req.ip);
      if (!captchaOk) return res.status(400).json({ error: 'Captcha verification failed — please try again.' });
    }

    const voterToken = getOrSetVoterToken(req, res);
    const ipHash = hashIp(req.ip);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

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

      await tx.run(`INSERT INTO votes (submission_id, voter_token, ip_hash, created_at) VALUES (?, ?, ?, ?)`, [
        submissionId, voterToken, ipHash, new Date().toISOString(),
      ]);
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

// Public: the currently open Cat of the Year award and its finalists (no
// vote counts — same hidden-tally rule as the monthly vote). Returns
// award: null most of the year, since this only opens once annually.
app.get('/api/year-award/current', async (req, res) => {
  if (!YEAR_AWARD_MANUAL_VOTE_ENABLED) return res.json({ award: null, finalists: [] });
  const award = await db.get(`SELECT * FROM year_awards WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (!award) return res.json({ award: null, finalists: [] });
  const finalists = await db.all(
    `SELECT yaf.id AS finalist_id, s.id AS submission_id, s.cat_name, s.photo_path, s.share_image_path
     FROM year_award_finalists yaf JOIN submissions s ON s.id = yaf.submission_id
     WHERE yaf.year_award_id = ? ORDER BY RANDOM()`,
    [award.id]
  );
  res.json({
    award: { id: award.id, label: award.label, closesAt: award.closes_at },
    finalists,
  });
});

// Cast one Cat of the Year ballot. Unlike monthly voting, this is a single
// pick per person for the whole award (UNIQUE on year_award_id+voter_token,
// not per finalist) — see year_award_votes in db.js.
app.post('/api/year-award/vote', async (req, res) => {
  if (!YEAR_AWARD_MANUAL_VOTE_ENABLED) {
    return res.status(501).json({ error: 'Not available.' });
  }
  try {
    const finalistId = Number(req.body.finalistId);
    if (!finalistId) return res.status(400).json({ error: 'Missing finalistId.' });

    const finalist = await db.get(
      `SELECT yaf.*, ya.status AS award_status FROM year_award_finalists yaf
       JOIN year_awards ya ON ya.id = yaf.year_award_id WHERE yaf.id = ?`,
      [finalistId]
    );
    if (!finalist) return res.status(404).json({ error: 'Finalist not found.' });
    if (finalist.award_status !== 'open') {
      return res.status(400).json({ error: 'Voting has closed for this award.' });
    }

    if (process.env.TURNSTILE_SECRET_KEY) {
      const captchaOk = await verifyTurnstile(req.body.turnstileToken, req.ip);
      if (!captchaOk) return res.status(400).json({ error: 'Captcha verification failed — please try again.' });
    }

    const voterToken = getOrSetVoterToken(req, res);
    const ipHash = hashIp(req.ip);

    const ipCount = await db.get(
      `SELECT COUNT(*) AS c FROM year_award_votes WHERE year_award_id = ? AND ip_hash = ?`,
      [finalist.year_award_id, ipHash]
    );
    if (Number(ipCount.c) >= YEAR_AWARD_VOTE_LIMIT_PER_IP) {
      return res.status(429).json({ error: 'Too many votes from this connection for this award.' });
    }

    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO year_award_votes (year_award_id, finalist_id, voter_token, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
        [finalist.year_award_id, finalistId, voterToken, ipHash, new Date().toISOString()]
      );
      await tx.run(`UPDATE year_award_finalists SET vote_count = vote_count + 1 WHERE id = ?`, [finalistId]);
    });

    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: "You've already voted in this Cat of the Year award." });
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

// Public catalog of custom cat/dog print products (see products.js).
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
  return productCatalog.listProducts(species).map((p) => {
    const m = byId[p.id];
    const description = (m && m.description_override) || p.description;
    return {
      id: p.id,
      name: p.name,
      species: p.species,
      description,
      priceUsd: p.priceUsd,
      mockupAspect: p.mockupAspect,
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

// Public, non-secret config the client needs — currently just whether
// Turnstile CAPTCHA is enabled and, if so, its public site key (the secret
// key never leaves the server; see verifyTurnstile).
app.get('/api/config', (req, res) => {
  res.json({ turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null });
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
    `SELECT id, image_path, cat_name FROM featured_originals ORDER BY position ASC, id ASC`
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
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured on this server yet.' });
    }
    const { email, productId, species, petName, photoRights, quantity } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A photo is required.' });
    }
    if (species !== 'cat' && species !== 'dog') {
      return res.status(400).json({ error: 'Please choose cat or dog.' });
    }
    // Photo rights: same requirement as contest entries — before printing
    // and selling a customer's own photo, we need their affirmative
    // confirmation they own/have rights to it (it's usually their own pet,
    // but the checkbox is the actual legal record either way).
    if (photoRights !== 'on' && photoRights !== 'true') {
      return res.status(400).json({ error: 'You must confirm you own the rights to this photo.' });
    }
    const product = productCatalog.getProduct(productId);
    if (!product) {
      return res.status(400).json({ error: 'Unknown product.' });
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
      automatic_tax: { enabled: true },
      payment_intent_data: { statement_descriptor_suffix: 'WHISKR' },
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

    res.json({ ok: true, url: session.url, lowResolution, width, height, discountPercent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// Public status: a coarse fill signal only — never the real count. A raw
// "X of 12 entered" is honest but reads as "nobody's here yet" for most of
// this business's life; it's also nobody's business how many strangers have
// entered right now.
app.get('/api/status', async (req, res) => {
  res.json(await getContestStatus());
});

// Calendar landing/checkout page for a specific completed group
app.get('/api/calendar/:groupId', async (req, res) => {
  if (!CALENDAR_CHECKOUT_ENABLED) return res.status(410).json({ error: 'No longer available.' });
  const groupId = Number(req.params.groupId);
  const group = await db.get(`SELECT * FROM groups WHERE id = ?`, [groupId]);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const submissions = await db.all(`SELECT id, cat_name, photo_path FROM submissions WHERE group_id = ?`, [
    groupId,
  ]);
  res.json({
    groupId,
    status: group.status,
    winnerSubmissionId: group.winner_submission_id,
    cats: submissions,
    priceOne: PRICE_ONE,
    priceMulti: PRICE_MULTI,
  });
});

// Create a Stripe Checkout session for a calendar order
app.post('/api/checkout', async (req, res) => {
  if (!CALENDAR_CHECKOUT_ENABLED) return res.status(410).json({ error: 'No longer available.' });
  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured on this server yet.' });
    }
    const groupId = Number(req.body.groupId);
    const { quantity, email } = req.body;

    // Don't take payment for a calendar that doesn't exist yet, or one whose
    // voting is still open (nothing to print until a winner is picked).
    const group = await db.get(`SELECT id, status FROM groups WHERE id = ?`, [groupId]);
    if (!group) {
      return res.status(404).json({ error: 'That batch does not exist.' });
    }
    if (group.status !== 'completed') {
      return res.status(400).json({ error: 'This batch hasn\'t been judged yet — check back once a cover cat is picked.' });
    }

    const qty = Math.max(1, Math.min(20, Number(quantity) || 1));
    const unitPrice = qty >= 2 ? PRICE_MULTI : PRICE_ONE;
    const utmCampaign = cleanUtmCampaign(req.body.utmCampaign);

    const info = await db.run(
      `INSERT INTO orders (group_id, email, quantity, amount_usd, status, created_at, utm_campaign) VALUES (?, ?, ?, ?, 'pending', ?, ?) RETURNING id`,
      [groupId, email || '', qty, unitPrice * qty, new Date().toISOString(), utmCampaign]
    );
    const orderId = info.rows[0].id;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: isValidEmail(email) ? email : undefined,
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      automatic_tax: { enabled: true },
      payment_intent_data: { statement_descriptor_suffix: 'WHISKR' },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `Whiskr Calendar — Group #${groupId}` },
            unit_amount: Math.round(unitPrice * 100),
            tax_behavior: 'exclusive',
          },
          quantity: qty,
        },
      ],
      metadata: { orderType: 'calendar', orderId: String(orderId) },
      success_url: `${BASE_URL}/?order=success`,
      cancel_url: `${BASE_URL}/calendar.html?group=${groupId}`,
    });

    await db.run(`UPDATE orders SET stripe_session_id = ? WHERE id = ?`, [session.id, orderId]);

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Checkout failed.' });
  }
});

// Unsubscribe link included in commercial result emails (CAN-SPAM requires
// a working one-click opt-out on any email carrying a purchase pitch).
app.get('/api/unsubscribe', async (req, res) => {
  const { email, token } = req.query;
  if (!unsubscribe.verify(email, token)) {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }
  await db.run(`INSERT INTO suppressions (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING`, [
    String(email).toLowerCase(),
    new Date().toISOString(),
  ]);
  res.send('You have been unsubscribed from Whiskr emails.');
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

    if (orderType !== 'calendar' && orderType !== 'custom') {
      return res.status(400).json({ error: 'Invalid review link.' });
    }
    if (!reviewLink.verify(orderType, id, email, token)) {
      return res.status(400).json({ error: 'Invalid or expired review link.' });
    }

    const order =
      orderType === 'calendar'
        ? await db.get(`SELECT email, status FROM orders WHERE id = ?`, [id])
        : await db.get(`SELECT email, status FROM custom_orders WHERE id = ?`, [id]);
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
            (SELECT COUNT(*) FROM votes v WHERE v.submission_id = s.id AND v.created_at >= ?) AS votes_last_hour
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
    `SELECT ya.*, s.cat_name, s.email, s.photo_path
     FROM year_awards ya
     LEFT JOIN submissions s ON s.id = ya.winner_submission_id
     ORDER BY ya.created_at DESC`
  );
  res.json({ awards });
});

// DORMANT as of the 2026-09-11 simplification (see tallyAndCloseYearAward
// above) — kept only as a manual override, not linked from any UI.
// Opens a new Cat of the Year award: auto-populates finalists from every
// completed monthly Cat-of-the-Month winner (groups.winner_submission_id)
// sealed within [sinceDate, untilDate] — default sinceDate is "the
// beginning of time" (covers the first cycle, before any award has ever
// run) and default untilDate is now.
app.post('/api/admin/year-award/open', requireAdmin, async (req, res) => {
  if (!YEAR_AWARD_MANUAL_VOTE_ENABLED) {
    return res.status(501).json({
      error: 'Set YEAR_AWARD_MANUAL_VOTE_ENABLED=true to use this manual-override path — it also re-enables the public vote/current routes.',
    });
  }
  const { label, closesAt, sculptureDeadline, sinceDate, untilDate } = req.body;
  if (!label || !closesAt) return res.status(400).json({ error: 'label and closesAt are required.' });

  const since = sinceDate || '2000-01-01T00:00:00.000Z';
  const until = untilDate || new Date().toISOString();
  const winners = await db.all(
    `SELECT DISTINCT g.winner_submission_id AS submission_id
     FROM groups g WHERE g.status = 'completed' AND g.winner_submission_id IS NOT NULL
       AND g.sealed_at >= ? AND g.sealed_at <= ?`,
    [since, until]
  );
  if (winners.length === 0) {
    return res.status(400).json({ error: 'No completed Cat-of-the-Month winners in that date range.' });
  }

  const now = new Date().toISOString();
  const info = await db.run(
    `INSERT INTO year_awards (label, opens_at, closes_at, status, sculpture_deadline, created_at)
     VALUES (?, ?, ?, 'open', ?, ?) RETURNING id`,
    [label, now, closesAt, sculptureDeadline || null, now]
  );
  const yearAwardId = info.rows[0].id;
  for (const w of winners) {
    await db.run(
      `INSERT INTO year_award_finalists (year_award_id, submission_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [yearAwardId, w.submission_id]
    );
  }
  res.json({ ok: true, yearAwardId, finalistCount: winners.length });
});

app.get('/api/admin/year-award/current', requireAdmin, async (req, res) => {
  const award = await db.get(`SELECT * FROM year_awards WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (!award) return res.json({ award: null, finalists: [] });
  const finalists = await db.all(
    `SELECT yaf.id AS finalist_id, yaf.vote_count, s.id AS submission_id, s.cat_name, s.photo_path
     FROM year_award_finalists yaf JOIN submissions s ON s.id = yaf.submission_id
     WHERE yaf.year_award_id = ? ORDER BY yaf.vote_count DESC`,
    [award.id]
  );
  res.json({ award, finalists });
});

app.post('/api/admin/year-award/force-close', requireAdmin, async (req, res) => {
  const award = await db.get(`SELECT * FROM year_awards WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
  if (!award) return res.status(404).json({ error: 'No open year award.' });
  const winnerSubmissionId = await tallyAndCloseYearAward(award.id);
  res.json({ ok: true, yearAwardId: award.id, winnerSubmissionId });
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

// Pulls yesterday's real spend for every active campaign that has a
// matching Meta campaign (by meta_campaign_id if already linked, else by
// matching name the first time) and upserts it into ad_spend_entries with
// source='meta_api' — safe to re-run any time, including manually via the
// admin endpoint below, since the partial unique index on
// (campaign_id, spend_date) WHERE source='meta_api' means a re-sync
// updates that day's number instead of double-counting it. No-ops
// entirely (returns dryRun: true) if Meta isn't configured — the manual
// ledger keeps working exactly as before either way.
async function syncMetaAdSpend() {
  if (!metaAds.configured()) return { dryRun: true, synced: 0 };

  const campaigns = await db.all(`SELECT * FROM ad_campaigns WHERE status = 'active'`);
  if (campaigns.length === 0) return { dryRun: false, synced: 0 };

  let metaCampaignsByName = null;
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let synced = 0;

  for (const campaign of campaigns) {
    let metaCampaignId = campaign.meta_campaign_id;

    if (!metaCampaignId) {
      if (!metaCampaignsByName) {
        const result = await metaAds.listCampaigns();
        metaCampaignsByName = new Map(result.campaigns.map((c) => [c.name.toLowerCase(), c.id]));
      }
      metaCampaignId = metaCampaignsByName.get(campaign.name.toLowerCase());
      if (!metaCampaignId) continue; // no matching Meta campaign — nothing to sync for this one
      await db.run(`UPDATE ad_campaigns SET meta_campaign_id = ? WHERE id = ?`, [metaCampaignId, campaign.id]);
    }

    try {
      const spend = await metaAds.getCampaignSpendForDate(metaCampaignId, yesterday);
      await db.run(
        `INSERT INTO ad_spend_entries (campaign_id, spend_date, amount_usd, source, created_at)
         VALUES (?, ?, ?, 'meta_api', ?)
         ON CONFLICT (campaign_id, spend_date) WHERE source = 'meta_api'
         DO UPDATE SET amount_usd = EXCLUDED.amount_usd`,
        [campaign.id, yesterday, spend.amountUsd, new Date().toISOString()]
      );
      synced++;
    } catch (err) {
      console.error(`[meta-ads] spend sync failed for campaign ${campaign.id} (${campaign.name}):`, err.message);
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

// Orders, for fulfillment. ?status=paid to see what actually needs printing;
// omit to see everything including still-pending checkout sessions.
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = status
    ? await db.all(`SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC`, [status])
    : await db.all(`SELECT * FROM orders ORDER BY created_at DESC`);
  res.json({ orders: rows });
});

// Custom (print-on-demand) orders, for fulfillment visibility alongside
// the calendar orders above.
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
  await db.run(`UPDATE custom_orders SET status = 'paid' WHERE id = ?`, [orderId]);
  await submitCustomOrderToPrintful(orderId);
  const updated = await db.get(`SELECT status, printful_order_id FROM custom_orders WHERE id = ?`, [orderId]);
  res.json({ ok: true, status: updated.status, printfulOrderId: updated.printful_order_id });
});

// Site-wide error/alert feed — every alertAdmin() call (failed Printful
// submission, refund, dispute, etc.) lands here so admin.html can show it
// in one place instead of relying on ADMIN_EMAIL being configured and
// delivered. Unresolved first, newest first, so the panel opens on what
// still needs attention.
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
    `SELECT id, image_path, cat_name, position FROM featured_originals ORDER BY position ASC, id ASC`
  );
  res.json({ originals });
});
app.post('/api/admin/originals', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A photo is required.' });
  const catName = (req.body.catName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60) || null;
  const imagePath = await storePhoto(req.file);
  const maxPos = await db.get(`SELECT COALESCE(MAX(position), -1) AS m FROM featured_originals`);
  const info = await db.run(
    `INSERT INTO featured_originals (image_path, cat_name, position, created_at) VALUES (?, ?, ?, ?) RETURNING id`,
    [imagePath, catName, Number(maxPos.m) + 1, new Date().toISOString()]
  );
  res.json({ id: info.rows[0].id, image_path: imagePath, cat_name: catName });
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
// votes and promoting the top CONTEST_WINNERS_COUNT into a calendar — see
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
    await sendRankDropAlerts();
    await sendDueReviewRequests();
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

// Module scope, not inside app.listen() below — on Vercel this file is
// required once per cold start and the exported app is invoked per-request,
// so a warning gated on app.listen() (which never runs there) would never
// print anywhere, local dev included. These print once per cold start on
// every environment instead.
if (!stripe) console.warn('[stripe] STRIPE_SECRET_KEY not set — checkout endpoint disabled.');
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
    console.log(`Contest length: ${CONTEST_LENGTH_DAYS} days | Winners per contest: ${CONTEST_WINNERS_COUNT}`);
  });
}

module.exports = app;
