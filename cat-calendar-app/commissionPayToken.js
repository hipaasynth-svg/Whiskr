const crypto = require('crypto');
const { secret } = require('./unsubscribe');

// Signs {commissionId, email} for the permanent "pay the balance" link in the
// painting-finished email. Stripe Checkout URLs expire after 24 hours, so the
// email can't carry one directly: this link mints a fresh Checkout session
// each time it's opened (GET /api/commissions/:id/pay in server.js).
function payloadString(commissionId, email) {
  return `commission-balance:${commissionId}:${String(email).toLowerCase()}`;
}

function tokenFor(commissionId, email) {
  return crypto.createHmac('sha256', secret()).update(payloadString(commissionId, email)).digest('hex');
}

function verify(commissionId, email, token) {
  if (!commissionId || !email || !token) return false;
  const expected = Buffer.from(tokenFor(commissionId, email));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { tokenFor, verify };
