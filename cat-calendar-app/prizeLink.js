const crypto = require('crypto');
const { secret } = require('./unsubscribe');

// Signs {prizeId, email} so the grand-prize claim link (reference photo +
// shipping address upload) can only be used by the cat's actual owner —
// same pattern as reviewLink.js, for the same reason: an open form here
// would let anyone claim someone else's original painting.
function payloadString(prizeId, email) {
  return `grand-prize:${prizeId}:${String(email).toLowerCase()}`;
}

function tokenFor(prizeId, email) {
  return crypto.createHmac('sha256', secret()).update(payloadString(prizeId, email)).digest('hex');
}

function verify(prizeId, email, token) {
  if (!prizeId || !email || !token) return false;
  const expected = Buffer.from(tokenFor(prizeId, email));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { tokenFor, verify };
