const nodemailer = require('nodemailer');
const db = require('./db');
const { tokenFor } = require('./unsubscribe');

const BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
const MAILING_ADDRESS = process.env.BUSINESS_MAILING_ADDRESS || '[Add your business mailing address to .env — required by CAN-SPAM]';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function buildTransport() {
  if (!process.env.ZOHO_EMAIL || !process.env.ZOHO_APP_PASSWORD) {
    console.warn('[mailer] ZOHO_EMAIL / ZOHO_APP_PASSWORD not set — emails will be logged, not sent.');
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com',
    port: Number(process.env.ZOHO_SMTP_PORT || 465),
    secure: true, // true for port 465
    auth: {
      user: process.env.ZOHO_EMAIL,
      pass: process.env.ZOHO_APP_PASSWORD,
    },
    // Entry/result emails are sent synchronously inside the request that
    // triggers them (submission, contest close) — without these, a slow or
    // unreachable SMTP host hangs that request until Node's default
    // OS-level socket timeout, which is effectively "forever" from a
    // user's perspective. Bound it instead.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
}

const transporter = buildTransport();

async function isSuppressed(email) {
  return Boolean(await db.get(`SELECT 1 FROM suppressions WHERE email = ?`, [String(email).toLowerCase()]));
}

function unsubscribeUrl(email) {
  return `${BASE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${tokenFor(email)}`;
}

async function sendMail({ to, subject, html, text }) {
  const fromName = process.env.ZOHO_FROM_NAME || 'Whiskr';
  // Separate from ZOHO_EMAIL on purpose: if you're sending as a domain
  // alias on a Zoho account rather than a dedicated mailbox (e.g.
  // contest@whiskr.lol set up as an alias on a different login), SMTP
  // still authenticates as the real mailbox (ZOHO_EMAIL), but mail should
  // arrive From: the branded alias address. Defaults to ZOHO_EMAIL so a
  // dedicated-mailbox setup needs no extra config.
  const fromEmail = process.env.ZOHO_FROM_EMAIL || process.env.ZOHO_EMAIL;
  const from = `"${fromName}" <${fromEmail}>`;

  if (await isSuppressed(to)) {
    console.log(`[mailer] skipped send to ${to} — address has unsubscribed`);
    return { suppressed: true };
  }

  if (!transporter) {
    console.log(`\n[mailer] (DRY RUN — no Zoho credentials) would send to ${to}\nSubject: ${subject}\n${text}\n`);
    return { dryRun: true };
  }

  return transporter.sendMail({ from, to, subject, html, text });
}

// showUnsubscribe should be true for any email containing a purchase pitch
// (CAN-SPAM applies to commercial content even when mixed with transactional
// content) and can stay false for purely transactional notices.
function wrapLayout(bodyHtml, { showUnsubscribe = false, email = '', tagline = 'Cat of the Month Contest' } = {}) {
  const footerCompliance = showUnsubscribe
    ? `<p>${escapeHtml(MAILING_ADDRESS)}<br>
        Don't want these emails? <a href="${unsubscribeUrl(email)}">Unsubscribe</a>.</p>`
    : '';
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#EFE6D8;padding:32px 16px;">
    <div style="max-width:520px;margin:0 auto;background:#FFFDF8;border:1px solid #d8cdb5;border-radius:4px;overflow:hidden;">
      <div style="background:#1B2430;color:#EFE6D8;padding:20px 28px;font-family:Georgia,serif;">
        <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#E8A33D;">Whiskr</div>
        <div style="font-size:20px;margin-top:2px;">${escapeHtml(tagline)}</div>
      </div>
      <div style="padding:28px;color:#1B2430;font-size:15px;line-height:1.6;">
        ${bodyHtml}
      </div>
      <div style="padding:16px 28px;background:#f3ede0;color:#7a7160;font-size:12px;">
        You're getting this because a cat photo was submitted to Whiskr with this address.
        ${footerCompliance}
      </div>
    </div>
  </div>`;
}

// Renders the discount call-to-action shared by the entry-confirmation and
// final-placement emails — a real, time-limited percent off the evergreen
// print shop, verified server-side against discountToken.js (see server.js)
// at checkout, never trusted from the link alone.
function discountBlockHtml(discount, catName) {
  if (!discount) return '';
  const expires = new Date(discount.expiresAt).toLocaleString('en-US', {
    month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const shopUrl = `${BASE_URL}/?discountEmail=${encodeURIComponent(discount.email)}&discountExpires=${encodeURIComponent(discount.expiresAt)}&discountToken=${discount.token}#shop-custom`;
  return `
    <p style="text-align:center;margin:24px 0;padding:16px;border:1px dashed #d8cdb5;border-radius:6px;">
      <strong>${discount.percent}% off a print of ${escapeHtml(catName)}</strong><br/>
      <span style="font-size:13px;color:#555;">Expires ${expires}</span><br/>
      <a href="${shopUrl}" style="display:inline-block;margin-top:10px;background:#2F5D50;color:#fff;padding:10px 18px;border-radius:3px;text-decoration:none;font-weight:bold;">Shop a print of ${escapeHtml(catName)}</a>
    </p>`;
}
function discountBlockText(discount, catName) {
  if (!discount) return '';
  const shopUrl = `${BASE_URL}/?discountEmail=${encodeURIComponent(discount.email)}&discountExpires=${encodeURIComponent(discount.expiresAt)}&discountToken=${discount.token}#shop-custom`;
  return `\n${discount.percent}% off a print of ${catName}, expires ${discount.expiresAt}: ${shopUrl}`;
}

async function sendEntryConfirmation({ email, catName, voteUrl, statusUrl, closesAt, discount, shareImageUrl }) {
  const safeName = escapeHtml(catName);
  const closeDate = new Date(closesAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const shareImageBlock = shareImageUrl
    ? `<p style="text-align:center;margin:20px 0;"><img src="${shareImageUrl}" alt="Vote for ${safeName}" style="max-width:280px;border-radius:6px;" /></p>
       <p style="font-size:13px;color:#555;text-align:center;">Post that image straight to Stories, WhatsApp, or a group chat — it already has ${safeName}'s vote link on it.</p>`
    : '';
  const html = wrapLayout(`
    <p>Hi there,</p>
    <p><strong>${safeName}</strong> is entered — free, no purchase necessary. Whoever has the most votes when voting closes on <strong>${closeDate}</strong> wins an original hand-painted portrait.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${voteUrl}" style="background:#E8A33D;color:#1B2430;padding:12px 22px;border-radius:3px;text-decoration:none;font-weight:bold;">
        Vote for ${safeName} &amp; share to get more votes
      </a>
    </p>
    <p>Share that link with friends, family, and followers — votes from real people are what get a cat into the top spots.</p>
    ${shareImageBlock}
    ${discountBlockHtml(discount, catName)}
    <p style="font-size:13px;color:#555;">Curious where ${safeName} stands? <a href="${statusUrl}">Check your status any time</a>.</p>
    <p>— Whiskr</p>
  `);
  return sendMail({
    to: email,
    subject: `${catName} is entered! Get votes before ${closeDate}`,
    html,
    text: `${catName} is entered — free, no purchase necessary. Voting closes ${closeDate}. Vote and get your share link: ${voteUrl}${shareImageUrl ? `\nShare image: ${shareImageUrl}` : ''}${discountBlockText(discount, catName)}\nCheck your status any time: ${statusUrl}`,
  });
}

// Sent the instant a contest closes and its #1 vote-getter is decided —
// this now carries the actual grand-prize win directly (see awardPainting
// in server.js's tallyAndCloseContest): no separate second vote, the
// round's own real public vote already made the decision. sculptureDeadline
// is kept as the param name for continuity with the (now dormant)
// tallyAndCloseYearAward path that also calls this same shape of email
// content; it names when the painting ships, not a sculpture.
async function sendWinnerEmail({ email, catName, sculptureDeadline }) {
  const safeName = escapeHtml(catName);
  const deadlineText = sculptureDeadline
    ? new Date(sculptureDeadline).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : 'in the coming weeks';
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p><strong>${safeName} got the most votes and is this month's Cat of the Month! 🏆</strong></p>
    <p><strong>${safeName} wins a one-of-a-kind original 11x16 acrylic painting of ${safeName}, hand-painted by artist Cody Carlson</strong> (codycarlson.art) — no cost to you. We're aiming to have it delivered by ${deadlineText}.</p>
    <p>Reply to this email with a mailing address and we'll get started.</p>
    <p>Congratulations, and thank you for being part of Whiskr.</p>
    <p>— Whiskr</p>
  `,
    { showUnsubscribe: true, email, tagline: 'Cat of the Month' }
  );
  return sendMail({
    to: email,
    subject: `${catName} is Cat of the Month — you're getting an original painting! 🏆`,
    html,
    text: `${catName} got the most votes and is Cat of the Month! ${catName} wins a one-of-a-kind original 11x16 acrylic painting, hand-painted by Cody Carlson, aiming for delivery by ${deadlineText}. Reply to this email with a mailing address.\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

// Sent when the dormant tallyAndCloseYearAward manual-override path (see
// server.js) is used to hand-correct a past round — not part of the
// normal flow, which sends sendWinnerEmail above instead. Kept only so
// that override path still has a real email to send.
async function sendCatOfYearEmail({ email, catName, sculptureDeadline }) {
  const safeName = escapeHtml(catName);
  const deadlineText = sculptureDeadline
    ? new Date(sculptureDeadline).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
    : 'in the coming weeks';
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p><strong>${safeName} is Cat of the Year!</strong> Out of the recent Cat of the Month winners up for it, ${safeName} got the most votes.</p>
    <p><strong>${safeName} wins a one-of-a-kind original 11x16 acrylic painting of ${safeName}, hand-painted by artist Cody Carlson</strong> (codycarlson.art) — no cost to you. We're aiming to have it delivered by ${deadlineText}.</p>
    <p>Reply to this email with a mailing address and we'll get started.</p>
    <p>Congratulations, and thank you for being part of Whiskr.</p>
    <p>— Whiskr</p>
  `,
    { showUnsubscribe: true, email, tagline: 'Cat of the Year' }
  );
  return sendMail({
    to: email,
    subject: `${catName} is Cat of the Year!`,
    html,
    text: `${catName} is Cat of the Year! ${catName} wins a one-of-a-kind original 11x16 acrylic painting of ${catName}, hand-painted by Cody Carlson, aiming for delivery by ${deadlineText}. Reply to this email with a mailing address.\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

// Sent to every entrant who didn't place in the top vote-getters, once a
// contest closes — real placement, not a consolation lie. Points to the
// evergreen custom print shop so a non-winner can still get a solo print of
// their own cat instead of nothing.
async function sendFinalRankEmail({ email, catName, rank, totalEntries, shopUrl, discount }) {
  const safeName = escapeHtml(catName);
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p>Voting's closed — <strong>${safeName} placed #${rank} out of ${totalEntries} entries</strong> this round. Thanks for entering and for every vote you rounded up.</p>
    <p>This round's original portrait went to another cat, but you can still get a solo print of your own cat — mug, poster, canvas, magnet, and more.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${shopUrl}" style="background:#E8A33D;color:#1B2430;padding:12px 22px;border-radius:3px;text-decoration:none;font-weight:bold;">
        Get a print of ${safeName}
      </a>
    </p>
    ${discountBlockHtml(discount, catName)}
    <p>A new contest is already open — enter ${safeName} again any time.</p>
    <p>— Whiskr</p>
  `,
    { showUnsubscribe: true, email }
  );
  return sendMail({
    to: email,
    subject: `${catName} placed #${rank} — final results`,
    html,
    text: `${catName} placed #${rank} out of ${totalEntries} entries. Get a solo print: ${shopUrl}${discountBlockText(discount, catName)}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

// The free, share-driven version of "gamified" urgency — no paid votes, no
// "buy your way back up" path. See sendRankDropAlerts in server.js for the
// throttle that decides when this actually fires.
async function sendRankDropEmail({ email, catName, rank, voteUrl, closesAt }) {
  const safeName = escapeHtml(catName);
  const closeDate = new Date(closesAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p><strong>${safeName} is currently #${rank}</strong> — voting closes ${closeDate}.</p>
    <p>A fresh round of shares is the fastest way to pick up real votes before the deadline.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${voteUrl}" style="background:#E8A33D;color:#1B2430;padding:12px 22px;border-radius:3px;text-decoration:none;font-weight:bold;">
        Share ${safeName}'s link
      </a>
    </p>
    <p>— Whiskr</p>
  `,
    { showUnsubscribe: true, email }
  );
  return sendMail({
    to: email,
    subject: `${catName} just fell to #${rank}`,
    html,
    text: `${catName} is currently #${rank} — voting closes ${closeDate}. Share for more votes: ${voteUrl}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

// Sent once, a set delay after an order is marked paid (see
// sendDueReviewRequests in server.js). reviewUrl carries a signed,
// order-specific token — this is the only way a review ever gets created,
// so there is no seed/fake review data anywhere in this app.
async function sendReviewRequest({ email, itemLabel, reviewUrl }) {
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p>Hope you're loving your ${escapeHtml(itemLabel)}! If you have a minute, we'd really appreciate a quick honest review — good, bad, or in between.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${reviewUrl}" style="background:#E8A33D;color:#1B2430;padding:12px 22px;border-radius:3px;text-decoration:none;font-weight:bold;">
        Leave a review
      </a>
    </p>
    <p style="font-size:13px;color:#555;">This link only works for this order, so we know it's really you.</p>
    <p>Thanks for being one of our first customers,</p>
    <p>— The Whiskr team</p>
  `,
    { showUnsubscribe: true, email, tagline: 'Custom Pet Prints & Cat of the Month' }
  );
  return sendMail({
    to: email,
    subject: `How's your ${itemLabel}? Leave a quick review`,
    html,
    text: `Hope you're loving your ${itemLabel}! Leave a quick honest review here: ${reviewUrl}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

module.exports = {
  sendEntryConfirmation,
  sendWinnerEmail,
  sendCatOfYearEmail,
  sendFinalRankEmail,
  sendRankDropEmail,
  sendReviewRequest,
  sendMail,
  isSuppressed,
  unsubscribeUrl,
};
