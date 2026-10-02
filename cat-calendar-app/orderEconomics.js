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
const MARGIN_FLOOR = 0.40;

// Stripe's card fee, which comes out of every order before we see a cent
// of it. Added 2026-09-30 on the owner's instruction: the floor used to be
// checked against gross revenue, so a product "at 40%" really cleared about
// 3-6 points less once Stripe took its cut, most on the cheapest items where
// the fixed 30 cents is a big share. Standard US online-card pricing; check
// the Stripe dashboard (Settings > Billing / pricing) if the account is on a
// different rate. The fee is charged on the whole amount collected,
// shipping included; sales tax is ignored here since it varies by address.
const CARD_FEE_PCT = 0.029;
const CARD_FEE_FIXED_USD = 0.3;
function cardFeeUsd(chargedUsd) {
  return chargedUsd * CARD_FEE_PCT + CARD_FEE_FIXED_USD;
}

// Used for any product with no row below. Deliberately the most expensive
// profile we carry, so an unlisted product over-collects shipping rather
// than shipping at a loss. A missing row is a bug, not a pricing decision.
const DEFAULT_RATE = { shipFirstUsd: 12.99, shipAdditionalUsd: 6.5 };

// itemUsd values were all read off Printful's live catalog API on
// 2026-09-28 (GET /products/variant/{id}). The seven that were already here
// came back byte-identical, so no supplier cost has drifted.
//
// shipFirstUsd / shipAdditionalUsd were quoted the same day from POST
// /shipping/rates to a California address. Eight of the ten products are
// fully real. The exceptions are called out on their own rows: the tote bag
// (Printful 400s on every rate request for it) and the additional-unit rate
// for the luster framed poster and the 18x24 canvas, where a single unit
// already clears the free-shipping threshold so only a one-unit quote was
// taken.
//
// The estimates these replaced were wrong in BOTH directions, which is why
// guessing them was never safe: the mug was overestimated by 16%, while the
// additional canvas rate was $4.50 against a real $9.99 and apparel's first
// rate was $5.39 against a real $8.79. Three prices had to rise again once
// the real numbers landed.
const ECONOMICS = {
  // Real shipping, quoted from POST /shipping/rates to a CA address on
  // 2026-09-28: $6.69 for one, $17.19 for four, so $3.50 per extra mug.
  // The estimate it replaces was $7.99/$4.00 - conservative in the safe
  // direction, which is the only direction a shipping guess may be wrong.
  'mug-11oz': { itemUsd: 6.07, shipFirstUsd: 6.69, shipAdditionalUsd: 3.5 },
  // Real: $4.99 first, $0.40 each additional. Posters ship rolled in one
  // tube, so extras are nearly free - the estimate had this at $2.00.
  'poster-12x16': { itemUsd: 11.11, shipFirstUsd: 4.99, shipAdditionalUsd: 0.4 },
  // Real: $10.39 first, $9.99 each additional - the estimate had $8.99/$4.50
  // and the additional rate was less than half the truth. A canvas is rigid
  // and boxed individually, so a second one costs almost a second parcel.
  // This is what pushed the 12x12 under the floor at the free-shipping line.
  'canvas-12x12': { itemUsd: 21.93, shipFirstUsd: 10.39, shipAdditionalUsd: 9.99 },
  // STILL AN ESTIMATE, and the only product whose rate could not be quoted:
  // POST /shipping/rates returns 400 for variant 16287 at every quantity,
  // while GET /products/variant/16287 returns its cost fine. A catalogue
  // entry Printful will price but not ship is worth checking before relying
  // on this product at all - if they cannot quote it, they may not fulfil
  // it. Rate below is the old estimate and is NOT confirmed.
  'tote-bag': { itemUsd: 17.95, shipFirstUsd: 4.69, shipAdditionalUsd: 1.85 },
  // Real: $10.89 first, $4.50 each additional. Estimate was $7.99/$4.00 -
  // low on both.
  'throw-pillow': { itemUsd: 14.59, shipFirstUsd: 10.89, shipAdditionalUsd: 4.5 },
  // Real: $4.69 first, $0.99 each additional.
  'fridge-magnet': { itemUsd: 3.91, shipFirstUsd: 4.69, shipAdditionalUsd: 0.99 },
  // Sized S-5XL at one flat price, so the only honest cost to check the
  // margin against is the most expensive size. $19.17 at S-XL, $27.17 at
  // 5XL; a margin computed off the cheap end would pass a product that
  // loses money every time someone orders a big one.
  // Real: $8.79 first, $2.50 each additional. Estimate was $5.39/$2.20, so
  // apparel shipping was badly underestimated.
  'crewneck-sweatshirt': { itemUsd: 27.17, shipFirstUsd: 8.79, shipAdditionalUsd: 2.5 },

  // Tough Case. One flat price over every device in phoneCases.js, so this
  // is the MOST EXPENSIVE device's cost, not the iPhone 11's $14.23: the
  // owner priced every device on 2026-10-01 and the highest is $14.77.
  // The flat price has to carry the worst of them.
  // Real shipping: $5.19 first, $1.00 each additional.
  'phone-case': { itemUsd: 14.77, shipFirstUsd: 5.19, shipAdditionalUsd: 1.0 },

  // The Gallery Series, confirmed 2026-09-28 against the catalog API and
  // far more expensive than the market rates their prices were guessed
  // from. Shipping is still an estimate; framed pieces go in oversized
  // boxes, hence the high figure.
  // Premium Luster Photo Paper Framed Poster (in), product 172, 12x18.
  // Real: $10.89 first; a two-unit quote on 2026-10-01 came back $15.39,
  // so $4.50 each additional (it had been inferred from the matte print and
  // was right). Frame colour confirmed Black for this variant.
  'framed-poster-luster-12x18': { itemUsd: 37.45, shipFirstUsd: 10.89, shipAdditionalUsd: 4.5 },
  // Enhanced Matte Paper Framed Poster (in), product 2, 12x18. Frame
  // colour confirmed Black for this variant (2026-10-01).
  // Real: $10.89 first, $4.50 each additional. The $15.99/$8.00 estimate
  // assumed framed art shipped like furniture; it does not.
  'framed-poster-matte-12x18': { itemUsd: 32.77, shipFirstUsd: 10.89, shipAdditionalUsd: 4.5 },
  // Canvas (in), product 3, 18x24 - the one Gallery item whose guessed
  // price was already high enough to carry its real cost.
  // Real: $10.39 first; a two-unit quote on 2026-10-01 came back $20.38,
  // so $9.99 each additional (it had been inferred from the 12x12 canvas
  // and was right).
  'canvas-18x24': { itemUsd: 33.66, shipFirstUsd: 10.39, shipAdditionalUsd: 9.99 },
};


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

    const { small: smallPct, free: freePct, freeQty, freeShipUsd } = marginsAt(p.id, p.priceUsd, row.itemUsd);

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
  // A lower bound to start the walk from (the fee only pushes it up).
  const floorPrice = ceilCents(itemUsd / (1 - MARGIN_FLOOR));
  // A ceiling: at some price one unit alone clears the threshold and carries
  // only its own first-item shipping, which is the easiest case there is.
  const cap = ceilCents((FREE_SHIPPING_THRESHOLD_USD + itemUsd + ratesFor(productId).shipFirstUsd) * 1.2);
  for (let cents = Math.round(floorPrice * 100); cents <= Math.round(cap * 100); cents++) {
    const price = cents / 100;
    if (worstMarginAt(productId, price, itemUsd) >= MARGIN_FLOOR) return price;
  }
  return null;
}

// Both cases' margins at a given price, after the card fee. Every margin
// in this file comes from here so the report, the required price and the
// discount check can't disagree.
//   SMALL: one unit, customer pays shipping — the shipping nets out, but
//          Stripe's fee is taken on price + shipping, so it doesn't.
//   FREE:  fewest units reaching the threshold, whole parcel on us.
function marginsAt(productId, priceUsd, itemUsd) {
  const smallShip = estimateShippingUsd(productId, 1);
  const small = (priceUsd - itemUsd - cardFeeUsd(priceUsd + smallShip)) / priceUsd;
  const freeQty = Math.max(1, Math.ceil(FREE_SHIPPING_THRESHOLD_USD / priceUsd));
  const revenue = priceUsd * freeQty;
  const freeShipUsd = estimateShippingUsd(productId, freeQty);
  const free = (revenue - itemUsd * freeQty - freeShipUsd - cardFeeUsd(revenue)) / revenue;
  return { small, free, freeQty, freeShipUsd };
}

// The worst margin this product shows at a given price, across both cases.
function worstMarginAt(productId, priceUsd, itemUsd) {
  const m = marginsAt(productId, priceUsd, itemUsd);
  return Math.min(m.small, m.free);
}

// The largest whole-percent discount the whole catalog survives.
//
// This exists because a discount is a price cut and the prices are set AT
// the floor, so any discount lands under it. A 20% contest discount was
// live against these prices and put every single product below: the mug at
// 32.0%, the sweatshirt at 25.5%. Discounting is the quiet way to undo a
// repricing, because nothing in a checkout session looks wrong while it
// happens.
//
// Products with no known supplier cost are skipped — they cannot vote on a
// number they have no cost for.
function maxSafeDiscountPct(products) {
  for (let d = 0; d <= 100; d++) {
    const breaks = products.some((p) => {
      const row = ECONOMICS[p.id];
      if (!row || row.itemUsd === null || row.itemUsd === undefined) return false;
      const discounted = Math.round(p.priceUsd * (1 - d / 100) * 100) / 100;
      if (discounted <= 0) return true;
      return worstMarginAt(p.id, discounted, row.itemUsd) < MARGIN_FLOOR;
    });
    if (breaks) return d - 1;
  }
  return 100;
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
    `\nMargin floor ${(MARGIN_FLOOR * 100).toFixed(0)}%, after Stripe's ${(CARD_FEE_PCT * 100).toFixed(1)}% + $${CARD_FEE_FIXED_USD.toFixed(2)} card fee.` +
      ` Free shipping at $${FREE_SHIPPING_THRESHOLD_USD}+. Shipping quoted from Printful except where the file says otherwise.`
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

  // A discount is a price cut against prices already set at the floor, so
  // it is checked here rather than left to be discovered on a real order.
  const products = listProducts('all');
  const safe = maxSafeDiscountPct(products);
  const live = Number(process.env.CONTEST_DISCOUNT_PERCENT || 0);
  console.log('');
  let discountBreaks = 0;
  if (safe < 0) {
    // Not "a negative discount". maxSafeDiscountPct walks up from 0 and
    // returns one less than the first percentage that breaks, so -1 means
    // even 0% breaks — i.e. a price is already under the floor before any
    // discount touches it. The per-product failures above are the real
    // report; saying "-1%" here would read as nonsense.
    console.log(`Discount headroom: none — prices are under the floor before any discount.`);
  } else {
    console.log(`Largest discount the catalog survives at ${(MARGIN_FLOOR * 100).toFixed(0)}%: ${safe}%.`);
  }
  if (live > safe && safe >= 0) {
    discountBreaks = 1;
    console.log(`! CONTEST_DISCOUNT_PERCENT is ${live}%, above that. At ${live}% these fall under the floor:`);
    for (const p of products) {
      const row = marginReport([p])[0];
      if (row.itemUsd === null) continue;
      const d = Math.round(p.priceUsd * (1 - live / 100) * 100) / 100;
      const w = worstMarginAt(p.id, d, row.itemUsd);
      if (w < MARGIN_FLOOR) {
        console.log(`    ${p.id.padEnd(24)} $${p.priceUsd.toFixed(2)} -> $${d.toFixed(2)}  ${(w * 100).toFixed(1)}%`);
      }
    }
  }
  console.log('');
  return below.length + discountBreaks;
}

if (require.main === module) {
  process.exitCode = printReport() > 0 ? 1 : 0;
}

module.exports = {
  FREE_SHIPPING_THRESHOLD_USD,
  MARGIN_FLOOR,
  estimateShippingUsd,
  shippingOptionsFor,
  marginReport,
  printReport,
};
