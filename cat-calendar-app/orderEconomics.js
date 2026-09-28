// What an order actually costs us, what we charge for shipping, and the
// margin floor both have to clear.
//
// This exists because the app used to collect a shipping ADDRESS but never
// a shipping CHARGE: every Stripe Checkout session set
// shipping_address_collection and none set shipping_options. Printful bills
// shipping separately, per order, on top of the item cost — so Whiskr was
// absorbing 100% of it on every single sale. On the cheaper items that was
// most of the margin.
//
// The owner's rule is a minimum 35% gross margin AFTER shipping, with no
// discounting to get there. That rule is only enforceable if the shipping
// number lives somewhere the code can read, so it lives here, and both the
// checkout sessions and the margin check below read this one table.
//
// ---------------------------------------------------------------------
// HOW SOLID THESE NUMBERS ARE
//
//   itemUsd       Printful's base cost. The ones marked verified were read
//                 off Printful's catalog API and match the cost comments in
//                 products.js. null means we do not know it, and the margin
//                 check reports 'unknown' for that product rather than
//                 quietly passing it.
//   shipFirstUsd  ESTIMATE. Printful's real shipping rates are quoted per
//                 order, per destination, from their API — and their
//                 domains are not reachable from the build environment, so
//                 NONE of the shipping figures here have been confirmed
//                 against a live quote. They are conservative
//                 order-of-magnitude figures for US domestic delivery.
//
// Before this goes anywhere near real money: pull the real rates (Printful
// dashboard, or POST /v2/shipping-rates with a sample address) and correct
// this table. Run `node orderEconomics.js` to print the margin report.
// ---------------------------------------------------------------------

// The brief's threshold: shipping is free once the order is big enough to
// carry it. Below that the customer pays it, which is what makes the 35%
// rule hold on the cheap items.
//
// Deliberately NOT an environment variable. The figure is also written into
// public/shipping.html as a promise to the customer, and an env var would
// let the mechanism drift away from the copy silently — which is the exact
// failure this repo has already had to fix twice. Change it here and change
// shipping.html in the same commit.
const FREE_SHIPPING_THRESHOLD_USD = 79;

// The owner's floor. Not a target — a floor.
const MARGIN_FLOOR = 0.35;

// Used for any product with no row below. Deliberately the most expensive
// profile we carry, so an unlisted product over-collects shipping rather
// than shipping at a loss. A missing row is a bug, not a pricing decision.
const DEFAULT_RATE = { shipFirstUsd: 12.99, shipAdditionalUsd: 6.5 };

const ECONOMICS = {
  // --- verified item cost, estimated shipping ---
  'mug-11oz': { itemUsd: 6.07, shipFirstUsd: 7.99, shipAdditionalUsd: 4.0 },
  'poster-12x16': { itemUsd: 11.11, shipFirstUsd: 4.99, shipAdditionalUsd: 2.0 },
  'canvas-12x12': { itemUsd: 21.93, shipFirstUsd: 8.99, shipAdditionalUsd: 4.5 },
  'tote-bag': { itemUsd: 17.95, shipFirstUsd: 4.69, shipAdditionalUsd: 1.85 },
  'throw-pillow': { itemUsd: 14.59, shipFirstUsd: 7.99, shipAdditionalUsd: 4.0 },
  'fridge-magnet': { itemUsd: 3.91, shipFirstUsd: 3.99, shipAdditionalUsd: 0.75 },
  // Sized S-5XL at one flat price, so the only honest cost to check the
  // margin against is the most expensive size. $19.17 at S-XL, $27.17 at
  // 5XL; a margin computed off the cheap end would pass a product that
  // loses money every time someone orders a big one.
  'crewneck-sweatshirt': { itemUsd: 27.17, shipFirstUsd: 5.39, shipAdditionalUsd: 2.2 },

  // --- item cost not known ---
  // Priced per device, and no device's cost has been read off the catalog
  // API. Shipping is the small-parcel rate.
  'phone-case': { itemUsd: null, shipFirstUsd: 4.39, shipAdditionalUsd: 1.5 },
  // The three Gallery Series items. products.js says plainly that their
  // printfulVariantIds were never confirmed and their prices came from
  // market rates rather than a real Printful cost, so there is no cost to
  // check a margin against. Framed pieces ship in oversized boxes, hence
  // the high estimate.
  'framed-poster-luster-12x18': { itemUsd: null, shipFirstUsd: 15.99, shipAdditionalUsd: 8.0 },
  'framed-poster-matte-12x18': { itemUsd: null, shipFirstUsd: 15.99, shipAdditionalUsd: 8.0 },
  'canvas-18x24': { itemUsd: null, shipFirstUsd: 12.99, shipAdditionalUsd: 6.5 },
};

// Calendars are not a Printful product and not in products.js — they are
// printed and mailed by the owner, so this is real postage plus packaging
// rather than a supplier quote. Same treatment: the customer pays it.
const CALENDAR_ECONOMICS = { shipFirstUsd: 5.95, shipAdditionalUsd: 2.5 };

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Rounded UP to the cent, never to nearest. A price derived from the margin
// floor and then rounded to nearest can land below the floor it was derived
// from: the mug needs $21.6307, which rounds to $21.63 and clears 34.997%.
// A "required price" that does not actually clear the requirement is worse
// than no number at all.
function ceilCents(n) {
  return Math.ceil(n * 100 - 1e-9) / 100;
}

function ratesFor(productId) {
  const row = ECONOMICS[productId];
  if (!row) return DEFAULT_RATE;
  return { shipFirstUsd: row.shipFirstUsd, shipAdditionalUsd: row.shipAdditionalUsd };
}

// What this order costs us to ship: one first-item rate plus a cheaper rate
// for each identical item after it, which is how Printful bills a parcel.
function estimateShippingUsd(productId, quantity, rates) {
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const r = rates || ratesFor(productId);
  return round2(r.shipFirstUsd + (qty - 1) * r.shipAdditionalUsd);
}

// The Stripe Checkout shipping_options for one order.
//
// Stripe shows these as fixed rates chosen before the address is known, so
// there is exactly one option: either the real estimated cost of this
// parcel, or free once the subtotal clears the threshold. tax_behavior is
// required on the rate because every session here runs automatic_tax.
//
// The delivery estimate is 3-13 business days because that is what
// shipping.html already tells customers: 2-5 business days to print plus
// 1-8 business days to deliver domestically. If one changes, change both.
function shippingOptionsFor({ productId, quantity = 1, subtotalUsd, rates }) {
  const free = Number(subtotalUsd) >= FREE_SHIPPING_THRESHOLD_USD;
  const amountUsd = free ? 0 : estimateShippingUsd(productId, quantity, rates);
  return [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: Math.round(amountUsd * 100), currency: 'usd' },
        // "$79+" and not "over $79": the threshold is inclusive, an order of
        // exactly $79 ships free, and shipping.html says "of $79 or more".
        // Stripe caps display_name at 50 characters.
        display_name: free
          ? `Free shipping (orders $${FREE_SHIPPING_THRESHOLD_USD}+)`
          : 'Standard shipping',
        tax_behavior: 'exclusive',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 3 },
          maximum: { unit: 'business_day', value: 13 },
        },
      },
    },
  ];
}

// Shipping options for a calendar order, which has no products.js entry.
function calendarShippingOptions({ quantity = 1, subtotalUsd }) {
  return shippingOptionsFor({ productId: null, quantity, subtotalUsd, rates: CALENDAR_ECONOMICS });
}

// ---------------------------------------------------------------------
// The margin check.
//
// There are exactly two ways an order can go, and a product has to clear
// the floor on BOTH. Checking one of them is how you end up confidently
// wrong:
//
//   SMALL   Order under the free-shipping threshold. The customer pays the
//           shipping, so it nets out and the margin is just the item's:
//           (price - supplier cost) / price.
//
//   FREE    Order at or over the threshold. We pay the whole parcel, and it
//           comes out of the same margin. Checked at the SMALLEST quantity
//           that reaches the threshold, which is the worst version of it —
//           the fewest items carrying the most shipping per dollar.
//
// FREE is the one that bites, and it bites hardest on heavy things. Three
// canvases is $117 of revenue and nearly $18 of shipping. A product can pass
// SMALL comfortably and still lose a third of its margin at FREE.
//
// This reports. It does not reprice. Prices are the owner's call and are
// locked by the brief — a cost check that silently moved a price would be
// changing revenue on its own authority.
// ---------------------------------------------------------------------
function marginReport(products) {
  return products.map((p) => {
    const row = ECONOMICS[p.id] || {};
    const rates = ratesFor(p.id);
    if (row.itemUsd === null || row.itemUsd === undefined) {
      return {
        id: p.id,
        name: p.name,
        priceUsd: p.priceUsd,
        itemUsd: null,
        shipFirstUsd: rates.shipFirstUsd,
        smallPct: null,
        freePct: null,
        freeQty: null,
        freeShipUsd: null,
        status: 'unknown',
        requiredPriceUsd: null,
      };
    }

    // SMALL: shipping is collected, so it cancels out of both sides.
    const smallPct = (p.priceUsd - row.itemUsd) / p.priceUsd;

    // FREE: fewest units that reach the threshold, whole parcel on us.
    const freeQty = Math.max(1, Math.ceil(FREE_SHIPPING_THRESHOLD_USD / p.priceUsd));
    const freeRevenue = p.priceUsd * freeQty;
    const freeShipUsd = estimateShippingUsd(p.id, freeQty);
    const freePct = (freeRevenue - row.itemUsd * freeQty - freeShipUsd) / freeRevenue;

    const worst = Math.min(smallPct, freePct);
    return {
      id: p.id,
      name: p.name,
      priceUsd: p.priceUsd,
      itemUsd: row.itemUsd,
      shipFirstUsd: rates.shipFirstUsd,
      smallPct,
      freePct,
      freeQty,
      freeShipUsd,
      status: worst >= MARGIN_FLOOR ? 'ok' : 'below_floor',
      // The price that clears the floor in BOTH cases. Reported so the owner
      // can decide, never applied.
      requiredPriceUsd: requiredPrice(p.id, row.itemUsd),
    };
  });
}

// The lowest price at which this product clears the floor on a small order
// AND on a free-shipping order.
//
// SMALL solves directly: price >= cost / (1 - floor).
//
// FREE does not, because raising the price changes how many units it takes
// to reach the threshold, which changes the shipping, which changes the
// margin — the quantity is a step function of the price. So it is walked a
// cent at a time from the SMALL answer upward. The catalog is small and this
// runs offline; a closed form here would be cleverness nobody can check.
function requiredPrice(productId, itemUsd) {
  const floorPrice = ceilCents(itemUsd / (1 - MARGIN_FLOOR));
  // A ceiling: at some price one unit alone clears the threshold and carries
  // only its own first-item shipping, which is the easiest case there is.
  const cap = ceilCents(FREE_SHIPPING_THRESHOLD_USD + itemUsd + ratesFor(productId).shipFirstUsd);
  for (let cents = Math.round(floorPrice * 100); cents <= Math.round(cap * 100); cents++) {
    const price = cents / 100;
    const qty = Math.max(1, Math.ceil(FREE_SHIPPING_THRESHOLD_USD / price));
    const revenue = price * qty;
    const freeMargin = (revenue - itemUsd * qty - estimateShippingUsd(productId, qty)) / revenue;
    if (freeMargin >= MARGIN_FLOOR) return price;
  }
  return null;
}

function pct(n) {
  return n === null ? '     ?' : `${(n * 100).toFixed(1).padStart(5)}%`;
}

function usd(n) {
  return n === null ? '     ?' : `$${n.toFixed(2).padStart(6)}`;
}

// `node orderEconomics.js` — the report the owner runs after changing a
// price or pasting in real Printful shipping rates.
function printReport() {
  const { listProducts } = require('./products');
  const rows = marginReport(listProducts('all'));
  console.log(
    `\nMargin floor ${(MARGIN_FLOOR * 100).toFixed(0)}%. Free shipping at $${FREE_SHIPPING_THRESHOLD_USD}+.` +
      ` Shipping figures are ESTIMATES (see the header).`
  );
  console.log('SMALL = under the threshold, customer pays shipping.');
  console.log('FREE  = smallest order that reaches the threshold, we pay the parcel.\n');
  console.log('  product                         price     cost    SMALL          FREE   needs');
  console.log('  ' + '-'.repeat(76));
  for (const r of rows) {
    const flag = r.status === 'ok' ? ' ' : r.status === 'unknown' ? '?' : '!';
    const freeCol =
      r.freePct === null ? '     ?' : `${pct(r.freePct)} (x${r.freeQty}, ${usd(r.freeShipUsd).trim()})`;
    console.log(
      `${flag} ${r.name.slice(0, 30).padEnd(30)} ${usd(r.priceUsd)} ${usd(r.itemUsd)} ${pct(r.smallPct)}  ${freeCol.padEnd(22)} ${usd(r.requiredPriceUsd)}`
    );
  }
  const below = rows.filter((r) => r.status === 'below_floor');
  const unknown = rows.filter((r) => r.status === 'unknown');
  console.log('');
  for (const r of below) {
    const which = r.smallPct < MARGIN_FLOOR ? (r.freePct < MARGIN_FLOOR ? 'both' : 'SMALL') : 'FREE';
    console.log(`! ${r.id}: below the floor on ${which}. Clears at ${usd(r.requiredPriceUsd).trim()} (now ${usd(r.priceUsd).trim()}).`);
  }
  if (unknown.length) {
    console.log(`? no known supplier cost, margin unchecked: ${unknown.map((r) => r.id).join(', ')}`);
  }
  if (!below.length && !unknown.length) console.log('All products clear the floor in both cases.');
  console.log('');
  return below.length;
}

if (require.main === module) {
  process.exitCode = printReport() > 0 ? 1 : 0;
}

module.exports = {
  FREE_SHIPPING_THRESHOLD_USD,
  MARGIN_FLOOR,
  estimateShippingUsd,
  shippingOptionsFor,
  calendarShippingOptions,
  marginReport,
  printReport,
};
