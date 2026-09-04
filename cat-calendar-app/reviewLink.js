const crypto = require('crypto');
const { secret } = require('./unsubscribe');

// Signs {orderType, orderId, email} so a review submission link can only be
// used by the actual purchaser of that specific order — this is what makes
// every review a verified purchase instead of an open form anyone could
// spam. Never build a review flow that skips this: fabricated or
// unverifiable reviews are illegal under the FTC's rule on fake reviews and
// testimonials (16 CFR Part 465), not just a trust problem.
function payloadString(orderType, orderId, email) {
  return `${orderType}:${orderId}:${String(email).toLowerCase()}`;
}

function tokenFor(orderType, orderId, email) {
  return crypto.createHmac('sha256', secret()).update(payloadString(orderType, orderId, email)).digest('hex');
}

function verify(orderType, orderId, email, token) {
  if (!orderType || !orderId || !email || !token) return false;
  const expected = Buffer.from(tokenFor(orderType, orderId, email));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { tokenFor, verify };
