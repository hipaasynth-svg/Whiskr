require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const { v4: uuid } = require('uuid');

const db = require('./db');
const mailer = require('./mailer');
const unsubscribe = require('./unsubscribe');

const app = express();
const PORT = process.env.PORT || 3000;
const GROUP_SIZE = Number(process.env.GROUP_SIZE || 12);
const VOTING_PERIOD_DAYS = Number(process.env.VOTING_PERIOD_DAYS || 21);
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const PRICE_ONE = Number(process.env.CALENDAR_PRICE_USD || 24.99);
const PRICE_MULTI = Number(process.env.CALENDAR_2PLUS_PRICE_USD || 19.99);

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ---------- uploads ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// Extension is derived from the validated MIME type, never from the
// attacker-controlled original filename — otherwise someone can upload an
// .svg/.html file with a spoofed "image/png" Content-Type and get it served
// back by express.static with a browser-executable extension (stored XSS).
const EXT_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = EXT_FOR_MIME[file.mimetype] || '.jpg';
    cb(null, `${uuid()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (!Object.prototype.hasOwnProperty.call(EXT_FOR_MIME, file.mimetype)) {
      return cb(new Error('Only jpg, png, webp, or gif photos are accepted.'));
    }
    cb(null, true);
  },
});

// Stripe webhook needs the raw request body for signature verification, so
// it's mounted before the global express.json() parser below — otherwise
// json() would consume/parse the body first and constructEvent would fail.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
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
    const info = db.prepare(`UPDATE orders SET status = 'paid' WHERE stripe_session_id = ?`).run(session.id);
    if (info.changes > 0) {
      console.log(`[stripe webhook] order for session ${session.id} marked paid.`);
    } else {
      console.warn(`[stripe webhook] checkout.session.completed for unrecognized session ${session.id}`);
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
  const pending = db
    .prepare(`SELECT id, email, cat_name FROM submissions WHERE group_id IS NULL ORDER BY id ASC LIMIT ?`)
    .all(GROUP_SIZE);

  if (pending.length < GROUP_SIZE) return null;

  const now = new Date();
  const votingEnds = new Date(now.getTime() + VOTING_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const insertGroup = db.prepare(
    `INSERT INTO groups (status, sealed_at, voting_ends_at) VALUES ('voting', ?, ?)`
  );
  const info = insertGroup.run(now.toISOString(), votingEnds.toISOString());
  const groupId = info.lastInsertRowid;

  const assign = db.prepare(`UPDATE submissions SET group_id = ? WHERE id = ?`);
  const txn = db.transaction((rows) => {
    for (const row of rows) assign.run(groupId, row.id);
  });
  txn(pending);

  for (const row of pending) {
    try {
      await mailer.sendEntryConfirmation({ email: row.email, catName: row.cat_name, groupId });
      db.prepare(`UPDATE submissions SET notified_entry = 1 WHERE id = ?`).run(row.id);
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
  const submissions = db.prepare(`SELECT * FROM submissions WHERE group_id = ?`).all(groupId);
  const winner = submissions.find((s) => s.id === winnerId);
  if (!winner) throw new Error(`Submission ${winnerId} is not in group ${groupId}`);

  db.prepare(`UPDATE groups SET status = 'completed', winner_submission_id = ? WHERE id = ?`).run(
    winnerId,
    groupId
  );

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
      db.prepare(`UPDATE submissions SET notified_result = 1 WHERE id = ?`).run(s.id);
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
  const dueGroups = db
    .prepare(`SELECT id FROM groups WHERE status = 'voting' AND voting_ends_at <= ?`)
    .all(nowIso);

  for (const g of dueGroups) {
    const submissions = db.prepare(`SELECT id, cat_name FROM submissions WHERE group_id = ?`).all(g.id);
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

// ---------- API ----------

// Submit a cat photo + email into the current open group
app.post('/api/submissions', upload.single('photo'), async (req, res) => {
  // A validation failure below can still leave an uploaded file on disk
  // (multer saves it before this handler runs) — always clean that up so
  // rejected submissions don't leak orphaned files.
  const rejectWithCleanup = (status, error) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(status).json({ error });
  };

  try {
    const { email, catName, photoRights } = req.body;
    if (!isValidEmail(email)) {
      return rejectWithCleanup(400, 'A valid email is required.');
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A photo is required.' });
    }
    // Photo rights: before printing and selling a stranger's photo, we need
    // affirmative confirmation the submitter owns/has rights to it.
    if (photoRights !== 'on' && photoRights !== 'true') {
      return rejectWithCleanup(400, 'You must confirm you own the rights to this photo.');
    }
    // Strip newlines so a crafted cat name can't inject extra lines into
    // the plaintext/subject of outgoing emails.
    const name = (catName || 'Anonymous Cat').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    const photoPath = `/uploads/${req.file.filename}`;
    const now = new Date().toISOString();

    const info = db
      .prepare(
        `INSERT INTO submissions (email, cat_name, photo_path, created_at, photo_rights_consent_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(email, name, photoPath, now, now);

    const sealedGroupId = await maybeSealGroup();

    res.json({
      ok: true,
      submissionId: info.lastInsertRowid,
      groupSealed: Boolean(sealedGroupId),
    });
  } catch (err) {
    console.error(err);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// Public status: how full is the current open batch
app.get('/api/status', (req, res) => {
  const openCount = db.prepare(`SELECT COUNT(*) AS c FROM submissions WHERE group_id IS NULL`).get().c;
  const lastCompleted = db
    .prepare(`SELECT id, winner_submission_id FROM groups WHERE status = 'completed' ORDER BY id DESC LIMIT 1`)
    .get();
  let winnerCat = null;
  if (lastCompleted) {
    winnerCat = db.prepare(`SELECT cat_name, photo_path FROM submissions WHERE id = ?`).get(
      lastCompleted.winner_submission_id
    );
  }
  res.json({
    openCount,
    groupSize: GROUP_SIZE,
    spotsLeft: Math.max(0, GROUP_SIZE - openCount),
    lastWinner: winnerCat,
  });
});

// Calendar landing/checkout page for a specific completed group
app.get('/api/calendar/:groupId', (req, res) => {
  const groupId = Number(req.params.groupId);
  const group = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(groupId);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const submissions = db.prepare(`SELECT id, cat_name, photo_path FROM submissions WHERE group_id = ?`).all(
    groupId
  );
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
    const group = db.prepare(`SELECT id, status FROM groups WHERE id = ?`).get(groupId);
    if (!group) {
      return res.status(404).json({ error: 'That batch does not exist.' });
    }
    if (group.status !== 'completed') {
      return res.status(400).json({ error: 'This batch hasn\'t been judged yet — check back once a cover cat is picked.' });
    }

    const qty = Math.max(1, Math.min(20, Number(quantity) || 1));
    const unitPrice = qty >= 2 ? PRICE_MULTI : PRICE_ONE;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: isValidEmail(email) ? email : undefined,
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
      success_url: `${BASE_URL}/?order=success`,
      cancel_url: `${BASE_URL}/calendar.html?group=${groupId}`,
    });

    db.prepare(
      `INSERT INTO orders (group_id, email, quantity, amount_usd, stripe_session_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(groupId, email || '', qty, unitPrice * qty, session.id, new Date().toISOString());

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Checkout failed.' });
  }
});

// Unsubscribe link included in commercial result emails (CAN-SPAM requires
// a working one-click opt-out on any email carrying a purchase pitch).
app.get('/api/unsubscribe', (req, res) => {
  const { email, token } = req.query;
  if (!unsubscribe.verify(email, token)) {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }
  db.prepare(`INSERT OR IGNORE INTO suppressions (email, created_at) VALUES (?, ?)`).run(
    String(email).toLowerCase(),
    new Date().toISOString()
  );
  res.send('You have been unsubscribed from Whiskr emails.');
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
app.get('/api/admin/groups/pending', requireAdmin, (req, res) => {
  const groups = db.prepare(`SELECT * FROM groups WHERE status = 'voting' ORDER BY sealed_at ASC`).all();
  const result = groups.map((g) => ({
    groupId: g.id,
    sealedAt: g.sealed_at,
    judgingDeadline: g.voting_ends_at,
    cats: db
      .prepare(`SELECT id, cat_name, photo_path FROM submissions WHERE group_id = ? ORDER BY id ASC`)
      .all(g.id),
  }));
  res.json({ groups: result });
});

// Manually choose the cover cat for a sealed group — this is "I am the
// voter": the group is finalized the moment you call this, no need to wait
// for the judging deadline (that deadline is only a fallback, see
// runDueJudging above).
app.post('/api/admin/groups/:groupId/pick', requireAdmin, async (req, res) => {
  const groupId = Number(req.params.groupId);
  const submissionId = Number(req.body.submissionId);

  const group = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  if (group.status !== 'voting') {
    return res.status(400).json({ error: `Group #${groupId} was already decided.` });
  }
  const submission = db
    .prepare(`SELECT id FROM submissions WHERE id = ? AND group_id = ?`)
    .get(submissionId, groupId);
  if (!submission) {
    return res.status(400).json({ error: 'That cat is not in this group.' });
  }

  const winner = await completeGroup(groupId, submissionId);
  res.json({ ok: true, groupId, winner: { id: winner.id, catName: winner.cat_name } });
});

// Orders, for fulfillment. ?status=paid to see what actually needs printing;
// omit to see everything including still-pending checkout sessions.
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = status
    ? db.prepare(`SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all();
  res.json({ orders: rows });
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
// Force a specific group's judging deadline to right now (testing only —
// in production the daily cron is what enforces the deadline).
app.post('/api/admin/force-close/:groupId', requireAdmin, async (req, res) => {
  const groupId = Number(req.params.groupId);
  const group = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  db.prepare(`UPDATE groups SET voting_ends_at = ? WHERE id = ?`).run(new Date().toISOString(), groupId);
  await runDueJudging();
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- background schedule ----------
// Daily check for groups whose judging deadline passed without a manual pick.
cron.schedule(process.env.CRON_SCHEDULE || '0 9 * * *', () => {
  runDueJudging().catch((e) => console.error('[cron] fallback judging run failed:', e));
});

app.listen(PORT, () => {
  console.log(`Whiskr server running on ${BASE_URL}`);
  console.log(`Judging deadline: ${VOTING_PERIOD_DAYS} days | Group size: ${GROUP_SIZE}`);
  if (!stripe) console.warn('[stripe] STRIPE_SECRET_KEY not set — checkout endpoint disabled.');
  if (stripe && !process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — paid orders will never be marked paid.');
  }
});
