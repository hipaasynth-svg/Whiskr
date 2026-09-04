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

function isSuppressed(email) {
  return Boolean(db.prepare(`SELECT 1 FROM suppressions WHERE email = ?`).get(String(email).toLowerCase()));
}

function unsubscribeUrl(email) {
  return `${BASE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${tokenFor(email)}`;
}

async function sendMail({ to, subject, html, text }) {
  const fromName = process.env.ZOHO_FROM_NAME || 'Whiskr';
  const from = `"${fromName}" <${process.env.ZOHO_EMAIL}>`;

  if (isSuppressed(to)) {
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
function wrapLayout(bodyHtml, { showUnsubscribe = false, email = '' } = {}) {
  const footerCompliance = showUnsubscribe
    ? `<p>${escapeHtml(MAILING_ADDRESS)}<br>
        Don't want these emails? <a href="${unsubscribeUrl(email)}">Unsubscribe</a>.</p>`
    : '';
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#EFE6D8;padding:32px 16px;">
    <div style="max-width:520px;margin:0 auto;background:#FFFDF8;border:1px solid #d8cdb5;border-radius:4px;overflow:hidden;">
      <div style="background:#1B2430;color:#EFE6D8;padding:20px 28px;font-family:Georgia,serif;">
        <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#E8A33D;">Whiskr</div>
        <div style="font-size:20px;margin-top:2px;">Cat of the Month Contest</div>
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

async function sendEntryConfirmation({ email, catName, groupId }) {
  const safeName = escapeHtml(catName);
  const html = wrapLayout(`
    <p>Hi there,</p>
    <p><strong>${safeName}</strong> is officially entered in this month's group of 12. Our judging table reviews the full batch over the next few weeks before picking a cover cat.</p>
    <p>We'll email you the moment results are in — win or place, your cat's photo may still make the calendar.</p>
    <p>— The Whiskr judging table</p>
  `);
  return sendMail({
    to: email,
    subject: `${catName} is entered! 🐾 (Group #${groupId})`,
    html,
    text: `${catName} is entered in group #${groupId}. Our judging table reviews the batch over the next few weeks — we'll email you when the cover cat is picked.`,
  });
}

async function sendWinnerEmail({ email, catName, groupId, buyUrl, priceOne, priceMulti }) {
  const safeName = escapeHtml(catName);
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p><strong>${safeName} is so cute — and has been selected as this month's Cat of the Month! 🏆</strong></p>
    <p>${safeName} is the cover star of this batch's 12-month calendar, sharing the pages with 11 other very good cats.</p>
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
    text: `${catName} is so cute — and has been selected as Cat of the Month! Get the calendar: ${buyUrl}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

async function sendFeaturedEmail({ email, catName, groupId, buyUrl, priceOne, priceMulti }) {
  const safeName = escapeHtml(catName);
  const html = wrapLayout(
    `
    <p>Hi there,</p>
    <p>Judging's closed for this group, and while another cat took the cover this round, <strong>${safeName} made the calendar</strong> as one of the 12 featured cats.</p>
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
    text: `${catName} made this round's calendar as one of 12 featured cats. Get it here: ${buyUrl}\n\nUnsubscribe: ${unsubscribeUrl(email)}`,
  });
}

module.exports = {
  sendEntryConfirmation,
  sendWinnerEmail,
  sendFeaturedEmail,
  sendMail,
  isSuppressed,
  unsubscribeUrl,
};
