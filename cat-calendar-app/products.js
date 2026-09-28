// Custom cat/dog print-on-demand catalog. Fulfilled through Printful
// (see printful.js) — no inventory, no local printing.
//
// Every printfulVariantId below is a real Printful catalog variant_id
// (raw catalog variant, not a synced store product — see printful.js's
// use of `variant_id` in the Orders API body), confirmed directly against
// Printful's catalog API.
//
// EVERY priceUsd BELOW IS SET BY ONE RULE, on the owner's instruction
// (2026-09-28): a minimum 40% gross margin AFTER shipping, no discounting
// to reach it. Not a target to eyeball — a floor the code checks.
// orderEconomics.js owns the supplier costs and the shipping estimates;
// `node orderEconomics.js` recomputes every margin and exits non-zero if
// anything is under. Run it after touching a price or a cost, and never
// move a price without it.
//
// The floor is checked in BOTH directions an order can go: under the
// free-shipping threshold, where the customer pays shipping, and at or
// over it, where we pay the whole parcel out of the same margin. The
// second is the one that bites — see orderEconomics.js for why.
// The prices that end in .99 and look like retail rounding are the
// computed minimum rounded UP; rounding down would break the floor.
// mockupAspect is a CSS aspect-ratio value for this product's own catalog
// photo (admin-uploaded — see product_media in db.js), not the customer's
// uploaded pet photo. Derived from each product's real physical dimensions
// where it has them, so the shape shown on the site actually matches what
// ships.
const PRODUCTS = [
  // The Gallery Series — a premium tier above the everyday items below,
  // listed first so it leads the shop instead of getting lost in the grid
  // (see the `tier: 'premium'` badge these three get in seo.js/script.js).
  // UNLIKE every other printfulVariantId in this file, these three are
  // NOT yet confirmed against Printful's catalog API — printful.com
  // itself isn't reachable from this environment to look them up. Until a
  // real variant_id is pasted in here (Printful dashboard → Catalog →
  // Wall Art → the matching product/size), a real order for one of these
  // still charges the customer successfully but Printful submission fails
  // safely afterward (submitCustomOrderToPrintful catches it, marks the
  // order 'failed', and it shows up in admin.html's alerts panel) rather
  // than shipping the wrong thing.
  //
  // These three are also the ONLY prices in this file the 40% floor could
  // not be applied to, because a margin needs a cost and no cost for them
  // has ever been confirmed. Their prices are market rates, left as they
  // were. What the check CAN say is the most each price can carry and
  // still clear 40% after shipping:
  //
  //   Framed Gallery Print  $74  ->  Printful cost must be at or under $32.41
  //   Framed Matte Print    $62  ->  at or under $25.20
  //   Large Gallery Canvas  $89  ->  at or under $40.41
  //
  // Above those, the price is underwater and the item loses money on every
  // sale. Read the real costs off the Printful dashboard, put them in
  // orderEconomics.js, and run `node orderEconomics.js`.
  {
    id: 'framed-poster-luster-12x18',
    name: 'Framed Gallery Print',
    species: 'both',
    description: "Your pet's photo on luster photo paper, framed in solid wood — the finish Printful itself compares to a real photo-lab print, not a print-on-demand one. Ready to hang, no glass to crack in shipping.",
    priceUsd: 74.0,
    printfulVariantId: null, // Printful "Premium Luster Photo Paper Framed Poster", 12"x18" — confirm real variant_id
    mockupAspect: '2/3',
    tier: 'premium',
  },
  {
    id: 'framed-poster-matte-12x18',
    name: 'Framed Matte Print',
    species: 'both',
    description: 'Museum-quality matte paper in a real wood frame — quieter and more understated than the luster finish, straight out of the box and onto the wall.',
    priceUsd: 62.0,
    printfulVariantId: null, // Printful "Enhanced Matte Paper Framed Poster", 12"x18" — confirm real variant_id
    mockupAspect: '2/3',
    tier: 'premium',
  },
  {
    id: 'canvas-18x24',
    name: 'Large Gallery Canvas',
    species: 'both',
    description: "An 18x24\" gallery-wrapped canvas — the statement piece. Same real canvas texture as our smaller size, built for a wall that means it.",
    priceUsd: 89.0,
    printfulVariantId: null, // Printful large-format Canvas, 18"x24" — confirm real variant_id
    mockupAspect: '3/4',
    tier: 'premium',
  },
  {
    id: 'mug-11oz',
    name: 'Custom Pet Mug',
    species: 'both',
    description: "Your pet's photo on an 11oz ceramic mug. Dishwasher and microwave safe.",
    priceUsd: 19.99,
    printfulVariantId: 1320, // White Glossy Mug 11oz — cost $6.07
    mockupAspect: '1/1',
  },
  {
    id: 'poster-12x16',
    name: 'Custom Pet Poster',
    species: 'both',
    description: 'A 12x16" matte poster print of your pet, ready to frame.',
    // Was $22.00: fine on a single sale, 37.0% on a four-poster free-
    // shipping order.
    priceUsd: 23.99,
    printfulVariantId: 1349, // Enhanced Matte Paper Poster 12"x16" — cost $11.11
    mockupAspect: '3/4',
  },
  {
    id: 'canvas-12x12',
    name: 'Custom Pet Canvas',
    species: 'both',
    description: '12x12" gallery-wrapped canvas print, ready to hang.',
    // Was $39.00, the largest correction in this catalog. Canvases are heavy
    // and $39 put three of them over the free-shipping line at $117 of
    // revenue against $17.99 of shipping we paid — 28.4%.
    priceUsd: 47.99,
    printfulVariantId: 823, // Canvas 12"x12" — cost $21.93
    mockupAspect: '1/1',
  },
  {
    id: 'phone-case',
    name: 'Custom Pet Phone Case',
    species: 'both',
    description: "Your pet on a durable phone case. Tell us your phone model at checkout.",
    // Left as it was: Printful prices cases per device and no device's cost
    // has ever been confirmed, so there is no cost to compute a margin
    // against. At $24.99 the floor holds only if Printful's cost is at or
    // under $12.77 — check the dashboard and put the real number in
    // orderEconomics.js.
    priceUsd: 24.99,
    // Unlike every other product here, this one has no single fixed
    // variant — Printful sizes cases per exact device. The real variant ID
    // is chosen by the customer's phone-model selection at checkout (see
    // phoneCases.js) and stored per-order, never read from this field.
    printfulVariantId: null,
    mockupAspect: '9/19',
  },
  {
    id: 'tote-bag',
    name: 'Custom Pet Tote Bag',
    species: 'both',
    description: 'A sturdy canvas tote printed with your pet\'s photo.',
    // Was $21 against a $17.95 Printful cost — a loss once shipping was
    // added. Raised to restore real margin (owner's call, 2026-09-11), and
    // already clears 40% both ways, so the 2026-09-28 repricing left it.
    priceUsd: 39.99,
    printfulVariantId: 16287, // AS Colour 1001 Cotton Tote Bag, Black — cost $17.95
    mockupAspect: '4/5',
  },
  {
    id: 'throw-pillow',
    name: 'Custom Pet Throw Pillow',
    species: 'both',
    description: '16x16" throw pillow, insert included.',
    // Was $29.00: 49.7% on a single sale, 31.3% on a three-pillow free-
    // shipping order.
    priceUsd: 33.99,
    printfulVariantId: 49854, // All-Over Print Basic Pillow 16"x16" — cost $14.59
    mockupAspect: '1/1',
  },
  {
    id: 'fridge-magnet',
    name: 'Custom Pet Fridge Magnet',
    species: 'both',
    description: 'A durable 4x4" magnet of your pet — a low-cost way to keep them on your fridge.',
    priceUsd: 9.99,
    printfulVariantId: 16367, // Die-Cut Magnets 4"x4" — cost $3.91
    mockupAspect: '1/1',
  },
  {
    id: 'crewneck-sweatshirt',
    name: 'Custom Pet Crewneck Sweatshirt',
    species: 'both',
    description: "Your pet's photo on a soft, pre-shrunk Gildan 18000 crewneck sweatshirt. Black, sized S–5XL.",
    // Flat price regardless of size — standard for POD apparel, and
    // simpler than per-size pricing. Printful's cost runs $19.17 (S–XL) up
    // to $27.17 (5XL), confirmed against the catalog API.
    //
    // The floor is therefore checked against $27.17, the 5XL, not the $19.17
    // small: one flat price means a margin computed off the cheap end passes
    // a product that loses money every time someone orders a big one. That
    // is why this is $51.99 rather than the ~$40 the small size alone would
    // justify — the price carries the worst size in the range.
    // Was $44.99, which cleared 39.6% on a single sale and only 31.2% on a
    // two-shirt free-shipping order.
    priceUsd: 51.99,
    // Unlike every other product here, this one has no single fixed
    // variant — it's sized S–5XL. The real variant ID is chosen by the
    // customer's size selection at checkout (see sweatshirtSizes.js,
    // confirmed against Printful's catalog API for product_id 145, Black)
    // and stored per-order, never read from this field. Same pattern as
    // phone-case below.
    printfulVariantId: null,
    mockupAspect: '4/5',
  },
];

function listProducts(species) {
  if (!species || species === 'all') return PRODUCTS;
  return PRODUCTS.filter((p) => p.species === 'both' || p.species === species);
}

function getProduct(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

module.exports = { listProducts, getProduct };
