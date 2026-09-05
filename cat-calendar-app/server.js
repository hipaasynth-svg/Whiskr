require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { put: putBlob } = require('@vercel/blob');
const { v4: uuid } = require('uuid');

const db = require('./db');
const mailer = require('./mailer');
const unsubscribe = require('./unsubscribe');
const reviewLink = require('./reviewLink');
const productCatalog = require('./products');
const printful = require('./printful');

const app = express();
const PORT = process.env.PORT || 3000;
const GROUP_SIZE = Number(process.env.GROUP_SIZE || 12);
const VOTING_PERIOD_DAYS = Number(process.env.VOTING_PERIOD_DAYS || 21);
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const PRICE_ONE = Number(process.env.CALENDAR_PRICE_USD || 24.99);
const PRICE_MULTI = Number(process.env.CALENDAR_2PLUS_PRICE_USD || 19.99);
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
      variantId: product ? product.printfulVariantId : null,
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
    if (process.env.ADMIN_EMAIL) {
      await mailer
        .sendMail({
          to: process.env.ADMIN_EMAIL,
          subject: `Custom order #${order.id} failed to submit to Printful`,
          text: `Custom order #${order.id} (${order.email}) was paid but failed to submit to Printful: ${err.message}. It needs manual attention.`,
          html: `<p>Custom order #${order.id} (${order.email}) was paid but failed to submit to Printful: ${err.message}</p><p>It needs manual attention.</p>`,
        })
        .catch(() => {});
    }
    console.error(`[printful] failed to submit custom order #${order.id}:`, err.message);
  }
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
    const shippingJson = session.shipping_details ? JSON.stringify(session.shipping_details) : null;

    if (orderType === 'calendar' && orderId) {
      const info = await db.run(`UPDATE orders SET status = 'paid', shipping_address = ? WHERE id = ?`, [
        shippingJson,
        orderId,
      ]);
      console.log(
        info.changes > 0
          ? `[stripe webhook] calendar order #${orderId} marked paid.`
          : `[stripe webhook] checkout.session.completed for unknown calendar order #${orderId}`
      );
    } else if (orderType === 'custom' && orderId) {
      await db.run(`UPDATE custom_orders SET status = 'paid', shipping_address = ? WHERE id = ?`, [
        shippingJson,
        orderId,
      ]);
      console.log(`[stripe webhook] custom order #${orderId} marked paid.`);
      await submitCustomOrderToPrintful(orderId);
    } else {
      console.warn(`[stripe webhook] checkout.session.completed with unrecognized metadata for session ${session.id}`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function calendarBuyUrl(groupId) {
  return `${BASE_URL}/calendar.html?group=${groupId}`;
}

// Seal a group once GROUP_SIZE ungrouped submissions exist, and email entrants.
async function maybeSealGroup() {
  const pending = await db.all(
    `SELECT id, email, cat_name FROM submissions WHERE group_id IS NULL ORDER BY id ASC LIMIT ?`,
    [GROUP_SIZE]
  );

  if (pending.length < GROUP_SIZE) return null;

  const now = new Date();
  const votingEnds = new Date(now.getTime() + VOTING_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const groupId = await db.transaction(async (tx) => {
    const info = await tx.run(
      `INSERT INTO groups (status, sealed_at, voting_ends_at) VALUES ('voting', ?, ?) RETURNING id`,
      [now.toISOString(), votingEnds.toISOString()]
    );
    const gid = info.rows[0].id;
    for (const row of pending) {
      await tx.run(`UPDATE submissions SET group_id = ? WHERE id = ?`, [gid, row.id]);
    }
    return gid;
  });

  for (const row of pending) {
    try {
      await mailer.sendEntryConfirmation({ email: row.email, catName: row.cat_name, groupId });
      await db.run(`UPDATE submissions SET notified_entry = 1 WHERE id = ?`, [row.id]);
    } catch (err) {
      console.error(`[mailer] entry confirmation failed for submission ${row.id}:`, err.message);
    }
  }

  console.log(`[groups] Sealed group #${groupId} with ${pending.length} cats. Judging deadline ${votingEnds.toISOString()}`);
  return groupId;
}

// Finalize a group with a specific cover cat: mark it completed, email every
// entrant (the cover cat gets the "you won" email, the other 11 get the
// "you're still in the calendar" email). Shared by the manual admin pick
// (POST /api/admin/groups/:groupId/pick) and the random-fallback safety net
// below — a group only ever gets finalized through one of these two paths.
async function completeGroup(groupId, winnerId) {
  const submissions = await db.all(`SELECT * FROM submissions WHERE group_id = ?`, [groupId]);
  const winner = submissions.find((s) => s.id === winnerId);
  if (!winner) throw new Error(`Submission ${winnerId} is not in group ${groupId}`);

  await db.run(`UPDATE groups SET status = 'completed', winner_submission_id = ? WHERE id = ?`, [
    winnerId,
    groupId,
  ]);

  const buyUrl = calendarBuyUrl(groupId);
  for (const s of submissions) {
    try {
      if (s.id === winner.id) {
        await mailer.sendWinnerEmail({
          email: s.email,
          catName: s.cat_name,
          groupId,
          buyUrl,
          priceOne: PRICE_ONE.toFixed(2),
          priceMulti: PRICE_MULTI.toFixed(2),
        });
      } else {
        await mailer.sendFeaturedEmail({
          email: s.email,
          catName: s.cat_name,
          groupId,
          buyUrl,
          priceOne: PRICE_ONE.toFixed(2),
          priceMulti: PRICE_MULTI.toFixed(2),
        });
      }
      await db.run(`UPDATE submissions SET notified_result = 1 WHERE id = ?`, [s.id]);
    } catch (err) {
      console.error(`[mailer] result email failed for submission ${s.id}:`, err.message);
    }
  }

  console.log(`[judging] Group #${groupId} complete. Cover cat: ${winner.cat_name} (submission ${winner.id})`);
  return winner;
}

// Safety net, not the normal path: any group whose judging window closed
// without a human picking a cover cat (see POST /api/admin/groups/:groupId/pick)
// gets one picked at random so entrants aren't left waiting forever. If this
// fires often, it means batches aren't getting judged fast enough.
async function runDueJudging() {
  const nowIso = new Date().toISOString();
  const dueGroups = await db.all(`SELECT id FROM groups WHERE status = 'voting' AND voting_ends_at <= ?`, [
    nowIso,
  ]);

  for (const g of dueGroups) {
    const submissions = await db.all(`SELECT id, cat_name FROM submissions WHERE group_id = ?`, [g.id]);
    if (submissions.length === 0) continue;

    const winner = submissions[Math.floor(Math.random() * submissions.length)];
    console.warn(
      `[judging] Group #${g.id} hit its deadline with no manual pick — auto-selecting "${winner.cat_name}" at random.`
    );
    await completeGroup(g.id, winner.id);

    if (process.env.ADMIN_EMAIL) {
      try {
        await mailer.sendMail({
          to: process.env.ADMIN_EMAIL,
          subject: `Group #${g.id} auto-picked — you didn't judge it in time`,
          text: `Group #${g.id} hit its judging deadline before you picked a cover cat, so "${winner.cat_name}" was chosen at random. Judge the next batch sooner: ${BASE_URL}/admin.html`,
          html: `<p>Group #${g.id} hit its judging deadline before you picked a cover cat, so <strong>${winner.cat_name}</strong> was chosen at random.</p><p>Judge the next batch sooner: <a href="${BASE_URL}/admin.html">${BASE_URL}/admin.html</a></p>`,
        });
      } catch (err) {
        console.error('[mailer] admin fallback-notify failed:', err.message);
      }
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

// Submit a cat photo + email into the current open group
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
    // Strip newlines so a crafted cat name can't inject extra lines into
    // the plaintext/subject of outgoing emails.
    const name = (catName || 'Anonymous Cat').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    const photoPath = await storePhoto(req.file);
    const now = new Date().toISOString();

    const info = await db.run(
      `INSERT INTO submissions (email, cat_name, photo_path, created_at, photo_rights_consent_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [email, name, photoPath, now, now]
    );

    const sealedGroupId = await maybeSealGroup();

    res.json({
      ok: true,
      submissionId: info.rows[0].id,
      groupSealed: Boolean(sealedGroupId),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// Public catalog of custom cat/dog print products (see products.js).
app.get('/api/products', (req, res) => {
  const species = typeof req.query.species === 'string' ? req.query.species : null;
  const list = productCatalog.listProducts(species).map((p) => ({
    id: p.id,
    name: p.name,
    species: p.species,
    description: p.description,
    priceUsd: p.priceUsd,
  }));
  res.json({ products: list });
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

    const qty = Math.max(1, Math.min(10, Number(quantity) || 1));
    const petNameClean = (petName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    const photoPath = await storePhoto(req.file);
    const now = new Date().toISOString();
    const amount = product.priceUsd * qty;

    const info = await db.run(
      `INSERT INTO custom_orders (email, product_id, species, pet_name, photo_path, quantity, amount_usd, status, photo_rights_consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING id`,
      [email, product.id, species, petNameClean, photoPath, qty, amount, now, now]
    );
    const orderId = info.rows[0].id;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `Whiskr — ${product.name}` },
            unit_amount: Math.round(product.priceUsd * 100),
          },
          quantity: qty,
        },
      ],
      metadata: { orderType: 'custom', orderId: String(orderId) },
      success_url: `${BASE_URL}/?order=success`,
      cancel_url: `${BASE_URL}/#shop-custom`,
    });

    await db.run(`UPDATE custom_orders SET stripe_session_id = ? WHERE id = ?`, [session.id, orderId]);

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// Public status: how full is the current open batch
app.get('/api/status', async (req, res) => {
  const openRow = await db.get(`SELECT COUNT(*) AS c FROM submissions WHERE group_id IS NULL`);
  const openCount = Number(openRow.c);
  const lastCompleted = await db.get(
    `SELECT id, winner_submission_id FROM groups WHERE status = 'completed' ORDER BY id DESC LIMIT 1`
  );
  let winnerCat = null;
  if (lastCompleted) {
    winnerCat = await db.get(`SELECT cat_name, photo_path FROM submissions WHERE id = ?`, [
      lastCompleted.winner_submission_id,
    ]);
  }
  res.json({
    openCount,
    groupSize: GROUP_SIZE,
    spotsLeft: Math.max(0, GROUP_SIZE - openCount),
    lastWinner: winnerCat,
  });
});

// Calendar landing/checkout page for a specific completed group
app.get('/api/calendar/:groupId', async (req, res) => {
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

    const info = await db.run(
      `INSERT INTO orders (group_id, email, quantity, amount_usd, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id`,
      [groupId, email || '', qty, unitPrice * qty, new Date().toISOString()]
    );
    const orderId = info.rows[0].id;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: isValidEmail(email) ? email : undefined,
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `Whiskr Calendar — Group #${groupId}` },
            unit_amount: Math.round(unitPrice * 100),
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
function requireAdmin(req, res, next) {
  const provided = Buffer.from(String(req.headers['x-admin-key'] || req.query.key || ''));
  const expected = Buffer.from(String(process.env.ADMIN_KEY || ''));
  const valid =
    process.env.ADMIN_KEY &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// List sealed groups (12 cats) that are awaiting a manual pick — this is
// your judging queue. See public/admin.html for the screen that uses this.
app.get('/api/admin/groups/pending', requireAdmin, async (req, res) => {
  const groups = await db.all(`SELECT * FROM groups WHERE status = 'voting' ORDER BY sealed_at ASC`);
  const result = [];
  for (const g of groups) {
    const cats = await db.all(`SELECT id, cat_name, photo_path FROM submissions WHERE group_id = ? ORDER BY id ASC`, [
      g.id,
    ]);
    result.push({ groupId: g.id, sealedAt: g.sealed_at, judgingDeadline: g.voting_ends_at, cats });
  }
  res.json({ groups: result });
});

// Manually choose the cover cat for a sealed group — this is "I am the
// voter": the group is finalized the moment you call this, no need to wait
// for the judging deadline (that deadline is only a fallback, see
// runDueJudging above).
app.post('/api/admin/groups/:groupId/pick', requireAdmin, async (req, res) => {
  const groupId = Number(req.params.groupId);
  const submissionId = Number(req.body.submissionId);

  const group = await db.get(`SELECT * FROM groups WHERE id = ?`, [groupId]);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  if (group.status !== 'voting') {
    return res.status(400).json({ error: `Group #${groupId} was already decided.` });
  }
  const submission = await db.get(`SELECT id FROM submissions WHERE id = ? AND group_id = ?`, [
    submissionId,
    groupId,
  ]);
  if (!submission) {
    return res.status(400).json({ error: 'That cat is not in this group.' });
  }

  const winner = await completeGroup(groupId, submissionId);
  res.json({ ok: true, groupId, winner: { id: winner.id, catName: winner.cat_name } });
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

// Moderation queue — pending by default, since that's what needs a look.
app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  const approved = req.query.approved === '1' ? 1 : 0;
  const rows = await db.all(`SELECT * FROM reviews WHERE approved = ? ORDER BY created_at ASC`, [approved]);
  res.json({ reviews: rows });
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

// Manually trigger the two background jobs (handy for testing without waiting weeks)
app.post('/api/admin/seal-group', requireAdmin, async (req, res) => {
  const id = await maybeSealGroup();
  res.json({ sealed: id || null });
});
// Runs the random-fallback safety net immediately, for testing — in normal
// operation you judge manually via POST /api/admin/groups/:groupId/pick and
// this only ever fires for groups you didn't get to in time.
app.post('/api/admin/run-fallback-judging', requireAdmin, async (req, res) => {
  await runDueJudging();
  res.json({ ok: true });
});
// Sends any due review-request emails immediately, for testing — in normal
// operation the daily Vercel Cron hit below does this.
app.post('/api/admin/run-review-requests', requireAdmin, async (req, res) => {
  await sendDueReviewRequests();
  res.json({ ok: true });
});
// Force a specific group's judging deadline to right now (testing only —
// in production the daily cron is what enforces the deadline).
app.post('/api/admin/force-close/:groupId', requireAdmin, async (req, res) => {
  const groupId = Number(req.params.groupId);
  const group = await db.get(`SELECT * FROM groups WHERE id = ?`, [groupId]);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  await db.run(`UPDATE groups SET voting_ends_at = ? WHERE id = ?`, [new Date().toISOString(), groupId]);
  await runDueJudging();
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- background schedule ----------
// Hit once a day by Vercel Cron (see the "crons" entry in vercel.json) —
// replaces the in-process node-cron scheduler that ran on the old always-on
// host, since a serverless function has no long-lived process to keep a
// timer running in. Checks groups whose judging deadline passed without a
// manual pick, and paid orders old enough to ask for a review.
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
    await runDueJudging();
    await sendDueReviewRequests();
    res.json({ ok: true });
  } catch (err) {
    console.error('[cron] daily run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  // Only listens when run directly (`node server.js` / `npm start`) — on
  // Vercel this file is required as a module and the exported app is
  // invoked per-request instead, so app.listen() here would be both
  // pointless and never reached.
  app.listen(PORT, () => {
    console.log(`Whiskr server running on ${BASE_URL}`);
    console.log(`Judging deadline: ${VOTING_PERIOD_DAYS} days | Group size: ${GROUP_SIZE}`);
    if (!stripe) console.warn('[stripe] STRIPE_SECRET_KEY not set — checkout endpoint disabled.');
    if (stripe && !process.env.STRIPE_WEBHOOK_SECRET) {
      console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — paid orders will never be marked paid.');
    }
    if (!BLOB_CONFIGURED) {
      console.warn('[blob] BLOB_READ_WRITE_TOKEN not set — photos are being saved to local disk (fine for dev only).');
    }
  });
}

module.exports = app;
