// Printful order submission. Deliberately minimal: v1 does NOT call
// Printful's Mockup Generator API (that's an async, task-based API — create
// a task, poll for the result — that needs a real account to test against,
// and this codebase has none). Instead the checkout page shows the
// customer's own uploaded photo as a plain preview client-side. Real
// on-product mockups (photo shown ON the mug/poster) are a reasonable v2
// once there's a live Printful store to verify the flow against.
//
// This module follows the same pattern as stripe/mailer elsewhere in this
// app: if PRINTFUL_API_KEY isn't set, calls log what they would have done
// and return a dry-run result instead of throwing.
const PRINTFUL_API_KEY = process.env.PRINTFUL_API_KEY;
const PRINTFUL_BASE = 'https://api.printful.com';

function configured() {
  return Boolean(PRINTFUL_API_KEY);
}

async function printfulRequest(path, options = {}) {
  const res = await fetch(`${PRINTFUL_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PRINTFUL_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error ? JSON.stringify(data.error) : res.statusText;
    throw new Error(`Printful API error ${res.status}: ${detail}`);
  }
  return data;
}

// Maps a Stripe Checkout Session's shipping_details onto the recipient
// shape Printful's Orders API expects. Returns null if Stripe didn't
// collect a shipping address (which server.js must not let happen for a
// physical-product checkout — see shipping_address_collection there).
function recipientFromStripeShipping(shippingDetails, email) {
  if (!shippingDetails || !shippingDetails.address) return null;
  const a = shippingDetails.address;
  return {
    name: shippingDetails.name || '',
    address1: a.line1 || '',
    address2: a.line2 || '',
    city: a.city || '',
    state_code: a.state || '',
    country_code: a.country || '',
    zip: a.postal_code || '',
    email,
  };
}

// Submits a real print + ship order to Printful. Call this only after
// Stripe confirms payment (the webhook handler in server.js), and only
// once per order — server.js guards against double-submission by checking
// custom_orders.status before calling this.
async function submitOrder({ externalId, variantId, quantity, photoUrl, recipient }) {
  if (!configured()) {
    console.log(
      `[printful] DRY RUN — PRINTFUL_API_KEY not set. Would submit order ${externalId}: variant ${variantId} x${quantity}, photo ${photoUrl}, ship to ${recipient ? recipient.name : '(no address)'}`
    );
    return { dryRun: true };
  }
  if (!variantId) {
    throw new Error('No Printful variant ID configured for this product yet — see products.js.');
  }
  if (!recipient) {
    throw new Error('No shipping address on file for this order — cannot submit to Printful.');
  }

  const body = {
    external_id: String(externalId),
    recipient,
    items: [
      {
        variant_id: variantId,
        quantity,
        files: [{ url: photoUrl }],
      },
    ],
  };

  const response = await printfulRequest('/orders', { method: 'POST', body: JSON.stringify(body) });
  return response.result;
}

module.exports = { configured, submitOrder, recipientFromStripeShipping };
