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
    // Result emails are sent synchronously inside the request that seals a
    // group (see maybeSealGroup/runDueJudging in server.js) — without these,
    // a slow or unreachable SMTP host hangs that visitor's HTTP response
    // until Node's default OS-level socket timeout, which is effectively
    // "forever" from a user's perspective. Bound it instead.
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
  const from = `"${fromName}" <${process.env.ZOHO_EMAIL}>`;

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

async function sendEntryConfirmation({ email, catName, groupId, groupSize }) {
  const safeName = escapeHtml(catName);
  const html = wrapLayout(`
    <p>Hi there,</p>
    <p><strong>${safeName}</strong> is officially entered in this round's group (up to ${groupSize} cats). Our judging table reviews the full batch — sealing either once it fills or after 3 weeks, whichever comes first, so you're never left waiting indefinitely — before picking a cover cat.</p>
    <p>We'll email you the moment results are in — win or place, your cat's photo may still make the calendar. Every batch's cover cat is also automatically in the running for our bi-monthly grand prize: an original 11x16 acrylic painting of their photo, hand-painted by our artist.</p>
    <p>— The Whiskr judging table</p>
  `);
  return sendMail({
    to: email,
    subject: `${catName} is entered! 🐾 (Group #${groupId})`,
    html,
    text: `${catName} is entered in group #${groupId}. Our judging table reviews the batch (sealing once it fills or after 3 weeks, whichever comes first) — we'll email you when the cover cat is picked.`,
  });
}

async function sendWinnerEmail({ email, catName, groupId, buyUrl, priceOne, priceMulti, batchSize }) {
  const safeName = escapeHtml(catName);
  const others = Math.max(0, (batchSize || 1) - 1);
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p><strong>${safeName} is so cute — and has been selected as this round's Cat of the Month! 🏆</strong></p>
    <p>${safeName} is the cover star of this batch's calendar, sharing the pages with ${others} other very good cats. ${safeName} is also now automatically entered for our bi-monthly grand prize — an original 11x16 acrylic painting, hand-painted from your cat's photo.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${buyUrl}" style="background:#E8A33D;color:#1B2430;padding:12px 22px;border-radius:3px;text-decoration:none;font-weight:bold;">
        Get ${safeName}'s calendar — $${priceOne}
      </a>
    </p>
    <p style="font-size:13px;color:#555;">Order 2 or more and each one drops to $${priceMulti} — great for gifts.</p>
    <p>— The Whiskr judging table</p>
  `,
    { showUnsubscribe: true, email }
  );
  return sendMail({
    to: email,
    subject: `${catName} is Cat of the Month! 🏆`,
    html,
    text: `${catName} is so cute — and has been selected as Cat of the Month! ${safeName} is also now entered for our bi-monthly original-painting grand prize. Get the calendar: ${buyUrl}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

async function sendFeaturedEmail({ email, catName, groupId, buyUrl, priceOne, priceMulti, batchSize }) {
  const safeName = escapeHtml(catName);
  const count = batchSize || 1;
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p>Judging's closed for this group, and while another cat took the cover this round, <strong>${safeName} made the calendar</strong> as one of the ${count} featured cats.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${buyUrl}" style="background:#E8A33D;color:#1B2430;padding:12px 22px;border-radius:3px;text-decoration:none;font-weight:bold;">
        Get the calendar featuring ${safeName} — $${priceOne}
      </a>
    </p>
    <p style="font-size:13px;color:#555;">Order 2 or more and each one drops to $${priceMulti}.</p>
    <p>Thanks for entering ${safeName} — we'd love to see them in a future round too.</p>
    <p>— The Whiskr judging table</p>
  `,
    { showUnsubscribe: true, email }
  );
  return sendMail({
    to: email,
    subject: `${catName} made the calendar! 📅`,
    html,
    text: `${catName} made this round's calendar as one of ${count} featured cats. Get it here: ${buyUrl}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

// Sent when the owner personally picks a batch's cover cat for the
// bi-monthly grand prize (POST /api/admin/grand-prize/choose in
// server.js) — a real, one-of-a-kind original painting, hand-painted by
// the owner, not anything Printful/automated. claimUrl carries a signed,
// order-specific token (see prizeLink.js) so only the actual winner can
// submit a reference photo and shipping address.
async function sendGrandPrizeWinEmail({ email, catName, claimUrl }) {
  const safeName = escapeHtml(catName);
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p><strong>Huge news — ${safeName} has been chosen for our bi-monthly grand prize! 🎨</strong></p>
    <p>Out of every cover cat from the last couple months, we picked ${safeName} to be the subject of an original 11x16 acrylic-on-canvas painting, hand-painted (not printed) by our artist — and it's yours, free.</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${claimUrl}" style="background:#E8A33D;color:#1B2430;padding:12px 22px;border-radius:3px;text-decoration:none;font-weight:bold;">
        Send a reference photo &amp; shipping address
      </a>
    </p>
    <p style="font-size:13px;color:#555;">A closer, well-lit photo of ${safeName} helps the painting come out great — your original contest photo works too if that's easier. This link is just for you.</p>
    <p>We'll mail your painting within 2 weeks — you'll get an email the moment it ships.</p>
    <p>— The Whiskr judging table</p>
  `,
    { showUnsubscribe: true, email }
  );
  return sendMail({
    to: email,
    subject: `${catName} won the original painting! 🎨`,
    html,
    text: `${catName} has been chosen for our bi-monthly grand prize — an original 11x16 acrylic painting, hand-painted just for you. Send a reference photo and shipping address here: ${claimUrl}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

// Sent once the owner marks a grand-prize painting shipped in admin.html.
async function sendGrandPrizeShippedEmail({ email, catName, trackingNumber }) {
  const safeName = escapeHtml(catName);
  const trackingLine = trackingNumber
    ? `<p>Tracking number: <strong>${escapeHtml(trackingNumber)}</strong></p>`
    : '';
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p><strong>${safeName}'s original painting is on its way! 🎉</strong></p>
    ${trackingLine}
    <p>Thanks for being part of Whiskr — we hope you love it.</p>
    <p>— The Whiskr judging table</p>
  `,
    { showUnsubscribe: true, email }
  );
  return sendMail({
    to: email,
    subject: `${catName}'s painting has shipped! 🎉`,
    html,
    text: `${safeName}'s original painting is on its way!${trackingNumber ? ` Tracking number: ${trackingNumber}` : ''}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
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
  sendFeaturedEmail,
  sendReviewRequest,
  sendGrandPrizeWinEmail,
  sendGrandPrizeShippedEmail,
  sendMail,
  isSuppressed,
  unsubscribeUrl,
};
