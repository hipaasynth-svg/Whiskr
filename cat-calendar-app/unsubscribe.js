const crypto = require('crypto');

function secret() {
  return process.env.UNSUB_SECRET || process.env.ADMIN_KEY || 'insecure-dev-secret-change-me';
}

function tokenFor(email) {
  return crypto.createHmac('sha256', secret()).update(String(email).toLowerCase()).digest('hex');
}

function verify(email, token) {
  if (!email || !token) return false;
  const expected = Buffer.from(tokenFor(email));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { tokenFor, verify };
