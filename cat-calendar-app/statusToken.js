const crypto = require('crypto');
const { secret } = require('./unsubscribe');

// Signs {submissionId, email} for a permanent "check my contest status"
// link — sent in the entry-confirmation email so an entrant can look up
// their own current standing without anyone else being able to look up
// theirs. This is deliberately not the same thing as the public leaderboard
// (which stays hidden while a round is open, see server.js's
// getContestStatus/contest.current comments) — an entrant already learns
// their own vote count and rank through the emails this app sends anyway;
// this just lets them check between emails instead of guessing.
function payloadString(submissionId, email) {
  return `${submissionId}:${String(email).toLowerCase()}`;
}

function tokenFor(submissionId, email) {
  return crypto.createHmac('sha256', secret()).update(payloadString(submissionId, email)).digest('hex');
}

function verify(submissionId, email, token) {
  if (!submissionId || !email || !token) return false;
  const expected = Buffer.from(tokenFor(submissionId, email));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { tokenFor, verify };
