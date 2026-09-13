// Meta Conversions API — the server-side half of ad conversion tracking.
// Sends the same events the client-side Pixel does (see the pixel bootstrap
// in public/script.js, driven by /api/config's metaPixelId), each carrying
// the SAME event_id as its client-side counterpart so Meta deduplicates
// them into one signal instead of double-counting. Purchase is server-only
// (fired from the Stripe webhook below) since that's the only point a
// payment is actually confirmed — a client-side "thank you page" Purchase
// event is not used here on purpose, since it fires on redirect whether or
// not payment truly succeeded and would overcount.
//
// Same pattern as printful.js/metaAds.js elsewhere in this app: if
// META_PIXEL_ID / META_CAPI_ACCESS_TOKEN aren't set, calls return a
// dry-run result instead of throwing — ad tracking is additive, never a
// requirement for checkout or contest entry to work.
//
// User matching is email-only for now (hashed per Meta's spec below) —
// deliberately NOT also sending raw client IP/user-agent/fbp/fbc for
// better match quality, since this app currently only ever stores a
// one-way hash of a visitor's IP (see hashIp in server.js), never the raw
// value. Wiring those in would mean this app starts persisting more raw
// visitor data than it does today, which changes what privacy.html can
// honestly claim — a call for the site owner, not a default to reach for
// silently.
const crypto = require('crypto');

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE; // only for verifying in Events Manager's Test Events tool
const META_API_BASE = 'https://graph.facebook.com/v21.0';

function configured() {
  return Boolean(META_PIXEL_ID && META_CAPI_ACCESS_TOKEN);
}

// Meta requires emails hashed exactly this way for matching: lowercased,
// trimmed, then SHA-256 as a hex string.
function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

// eventName: Meta's standard event names — 'Lead', 'InitiateCheckout', 'Purchase'.
// eventId: shared with the matching client-side fbq() call for dedup — see
// the eventID field there. value/currency are omitted for events with no
// dollar amount (e.g. Lead).
async function sendEvent({ eventName, eventId, email, value, currency, eventSourceUrl }) {
  if (!configured()) {
    console.log(`[meta capi] DRY RUN — would send ${eventName} (event_id ${eventId})`);
    return { dryRun: true };
  }

  const body = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: eventSourceUrl,
        user_data: { em: [hashEmail(email)] },
        ...(value != null ? { custom_data: { value, currency: currency || 'USD' } } : {}),
      },
    ],
    ...(META_TEST_EVENT_CODE ? { test_event_code: META_TEST_EVENT_CODE } : {}),
  };

  const res = await fetch(`${META_API_BASE}/${META_PIXEL_ID}/events?access_token=${META_CAPI_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error ? JSON.stringify(data.error) : res.statusText;
    throw new Error(`Meta Conversions API error ${res.status}: ${detail}`);
  }
  return { dryRun: false, result: data };
}

module.exports = { configured, sendEvent };
