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
// Overridable only so the shipment-sync path can be exercised end to end
// against a stub in tests, and honoured ONLY when NODE_ENV is 'test'.
// Every request carries the account's bearer token, so an override that
// applied in production would let anything able to set an environment
// variable -- a preview deployment, a CI job, a mis-scoped dashboard entry
// -- redirect that token to a host of its choosing. A test-only escape
// hatch is worth having; one that reaches production is not.
const PRINTFUL_BASE =
  process.env.NODE_ENV === 'test' && process.env.PRINTFUL_API_BASE
    ? process.env.PRINTFUL_API_BASE
    : 'https://api.printful.com';

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
    // Printful creates orders as unconfirmed drafts by default (a manual
    // review step before it charges your Printful balance and starts
    // production). Stripe has already confirmed payment by the time this
    // function is called, so there's nothing left to review — submit
    // straight to production instead of leaving it stuck as a draft.
    confirm: true,
  };

  const response = await printfulRequest('/orders', { method: 'POST', body: JSON.stringify(body) });
  return response.result;
}

// Fetches the shipments Printful holds for one order.
//
// This exists because the shipment webhook does NOT carry everything the
// business needs. Its payload is only:
//   id, status, store_id, tracking_number, tracking_url,
//   created_at, ship_date, shipped_at, reshipment
// There is no carrier and no estimated delivery in it, and Printful's
// lost-in-transit claim window runs from estimated delivery -- so the
// webhook alone cannot tell us when a claim expires. The Shipment resource
// does carry carrier, service, estimated_delivery, delivery_status and
// delivered_at, so every webhook is followed by this call.
//
// It is also what authenticates the webhook. Printful is not known to sign
// webhook deliveries, so an inbound payload is treated as an untrusted hint
// that something changed; the state we store is whatever this endpoint
// returns. A forged webhook can therefore cost us one API call and nothing
// else.
//
// Uses the v2 API. The order-submission call above is v1 (different path
// prefix, same host and same bearer token) -- v2 is where shipment
// delivery state actually lives, so the two coexist deliberately.
async function getOrderShipments(printfulOrderId) {
  if (!configured()) {
    console.log(`[printful] DRY RUN -- would fetch shipments for order ${printfulOrderId}`);
    return { dryRun: true, shipments: [] };
  }
  if (!printfulOrderId) throw new Error('No Printful order id on this order.');

  const data = await printfulRequest(`/v2/orders/${encodeURIComponent(printfulOrderId)}/shipments`);
  // v1 responses wrap payloads in `result`; v2 uses `data`. Accept either so
  // this keeps working if the endpoint is served by the older shape.
  const list = (data && (data.data || data.result)) || [];
  return { shipments: Array.isArray(list) ? list : [] };
}

// Normalizes one v2 Shipment into the columns custom_order_shipments holds.
// Kept here, beside the field notes above, so the mapping and the evidence
// for it live together.
function normalizeShipment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id != null ? String(raw.id) : null;
  if (!id) return null;

  // estimated_delivery is a nullable object in v2, not a bare date.
  let estimated = null;
  if (raw.estimated_delivery && typeof raw.estimated_delivery === 'object') {
    estimated = raw.estimated_delivery.to || raw.estimated_delivery.from || null;
  } else if (typeof raw.estimated_delivery === 'string') {
    estimated = raw.estimated_delivery;
  }

  return {
    printfulShipmentId: id,
    trackingNumber: raw.tracking_number || null,
    trackingUrl: raw.tracking_url || null,
    carrier: raw.carrier || null,
    service: raw.service || null,
    shippedAt: raw.shipped_at || null,
    shipDate: raw.ship_date || null,
    deliveryStatus: raw.delivery_status || null,
    deliveredAt: raw.delivered_at || null,
    estimatedDelivery: estimated,
    isReshipment: raw.is_reshipment || raw.reshipment ? 1 : 0,
  };
}

module.exports = { configured, submitOrder, recipientFromStripeShipping, getOrderShipments, normalizeShipment };
