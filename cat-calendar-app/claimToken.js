const crypto = require('crypto');
const { secret } = require('./unsubscribe');

// Signs {yearAwardId, email} for the winner's "send us your mailing
// address" link (see /claim and POST /api/claim in server.js). Only the
// person holding the winning entry's email gets this link, so it's what
// lets a winner submit or update their address without an account — and
// stops anyone else from redirecting a painting.
function payloadString(awardId, email) {
  return `claim:${awardId}:${String(email).toLowerCase()}`;
}

function tokenFor(awardId, email) {
  return crypto.createHmac('sha256', secret()).update(payloadString(awardId, email)).digest('hex');
}

function verify(awardId, email, token) {
  if (!awardId || !email || !token) return false;
  const expected = Buffer.from(tokenFor(awardId, email));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { tokenFor, verify };
