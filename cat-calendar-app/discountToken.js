const crypto = require('crypto');
const { secret } = require('./unsubscribe');

// Signs {email, expiresAt} so a time-limited discount (issued right after a
// contest entry, or in the final-placement email) can't be forged, altered
// to a later expiry, or redeemed by anyone other than the person it was
// issued to. Same HMAC pattern as reviewLink.js/unsubscribe.js — no new
// crypto approach introduced for this.
function payloadString(email, expiresAt) {
  return `${String(email).toLowerCase()}:${expiresAt}`;
}

function tokenFor(email, expiresAt) {
  return crypto.createHmac('sha256', secret()).update(payloadString(email, expiresAt)).digest('hex');
}

// Returns true only if the signature matches AND expiresAt hasn't passed.
function verify(email, expiresAt, token) {
  if (!email || !expiresAt || !token) return false;
  if (Date.parse(expiresAt) < Date.now()) return false;
  const expected = Buffer.from(tokenFor(email, expiresAt));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { tokenFor, verify };
