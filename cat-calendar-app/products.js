// Custom cat print-on-demand catalog (cats only since 2026-09-30). Fulfilled through Printful
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
  //
  // These three carried printfulVariantId: null for months, which meant a
  // real order for one CHARGED THE CUSTOMER and then failed Printful
  // submission (submitCustomOrderToPrintful catches it, marks the order
  // 'failed', and it surfaces in admin.html's alerts panel). Real variant
  // ids were read off the catalog API on 2026-09-28 and are now in place,
  // so these can actually be fulfilled.
  //
  // Their prices had been guessed from market rates because no supplier
  // cost was known. The real costs came back far higher than the guess,
  // and two of the three were underwater:
  //
  //   Framed Gallery Print  cost $37.45, was $74 (33.2% at the free-
  //                         shipping threshold) -> $89.99
  //   Framed Matte Print    cost $32.77, was $62 (27.8%) -> $74.99
  //   Large Gallery Canvas  cost $33.66, was $89 and already cleared at
  //                         47.6% -> unchanged
  //
  // Frame colour: each framed product has several same-cost variants that
  // differ only by frame colour. Both ids below were confirmed on
  // 2026-10-01 to be the BLACK frame, so a catalog photo should show black.
  {
    id: 'framed-poster-luster-12x18',
    name: 'Framed Gallery Print',
    species: 'cat',
    description: "Your cat's photo on luster photo paper — the finish of a real photo-lab print — in a solid wood frame. Ready to hang, no glass to crack in shipping.",
    priceUsd: 89.99,
    printfulVariantId: 6887, // Premium Luster Photo Paper Framed Poster (in), product 172, 12"x18" — cost $37.45
    mockupAspect: '2/3',
    tier: 'premium',
  },
  {
    id: 'framed-poster-matte-12x18',
    name: 'Framed Matte Print',
    species: 'cat',
    description: 'Museum-quality matte paper in a real wood frame — quieter and more understated than the luster finish, straight out of the box and onto the wall.',
    priceUsd: 74.99,
    printfulVariantId: 4398, // Enhanced Matte Paper Framed Poster (in), product 2, 12"x18" — cost $32.77
    mockupAspect: '2/3',
    tier: 'premium',
  },
  {
    id: 'canvas-18x24',
    name: 'Large Gallery Canvas',
    species: 'cat',
    description: "An 18x24\" gallery-wrapped canvas — the statement piece. Same real canvas texture as our smaller size, built for a wall that means it.",
    priceUsd: 89.0,
    printfulVariantId: 7, // Canvas (in), product 3, 18"x24" — cost $33.66
    mockupAspect: '3/4',
    tier: 'premium',
  },
  {
    id: 'mug-11oz',
    name: 'Custom Cat Mug',
    species: 'cat',
    description: "Your cat's photo on an 11oz ceramic mug. Dishwasher and microwave safe.",
    priceUsd: 19.99,
    printfulVariantId: 1320, // White Glossy Mug 11oz — cost $6.07
    mockupAspect: '1/1',
  },
  {
    id: 'poster-12x16',
    name: 'Custom Cat Poster',
    species: 'cat',
    description: 'A 12x16" matte poster print of your cat, ready to frame.',
    // Was $22.00: fine on a single sale, 37.0% on a four-poster free-
    // shipping order.
    priceUsd: 23.99,
    printfulVariantId: 1349, // Enhanced Matte Paper Poster 12"x16" — cost $11.11
    mockupAspect: '3/4',
  },
  {
    id: 'canvas-12x12',
    name: 'Custom Cat Canvas',
    species: 'cat',
    description: '12x12" gallery-wrapped canvas print, ready to hang.',
    // The most-corrected price here, and a lesson in guessing shipping.
    // $39.00 was underwater; $47.99 was set against an ESTIMATED $4.50 per
    // additional canvas. The real quoted rate is $9.99 — a canvas is rigid
    // and boxed on its own, so a second one costs nearly a second parcel.
    // At $47.99 two canvases were $95.98 of revenue against $43.86 of goods
    // and $20.38 of shipping we absorb at the free-shipping line: 33.1%.
    // Was 53.99. 2026-09-30: the margin check now counts Stripe's card fee (2.9% + $0.30), which put a
    // two-canvas free-shipping order at 37.3%; clears at $56.52, rounded up (owner approved).
    priceUsd: 56.99,
    printfulVariantId: 823, // Canvas 12"x12" — cost $21.93
    mockupAspect: '1/1',
  },
  {
    id: 'phone-case',
    name: 'Custom Cat Phone Case',
    species: 'cat',
    description: "Your cat on a durable phone case. Pick your phone model when you order.",
    // Was $24.99, set before any device's cost was known. The iPhone 11
    // case came back at $14.23 on 2026-09-28, against a ceiling of $12.77,
    // so it was underwater: 43.1% on a single sale but 34.2% on a
    // four-case free-shipping order.
    //
    // One flat price covers every device, so it has to carry the most
    // expensive one — see the 2026-10-01 note below.
    // Was 27.99. 2026-09-30: the margin check now counts Stripe's card fee (2.9% + $0.30), which put a
    // three-case free-shipping order at 37.3%; clears at $29.30, rounded up (owner approved).
    // Was 29.99. 2026-10-01: every device was priced and the most expensive
    // is $14.77, not the iPhone 11's $14.23, which put a three-case
    // free-shipping order at 39.5%; clears at $30.24, rounded up.
    priceUsd: 30.99,
    // Unlike every other product here, this one has no single fixed
    // variant — Printful sizes cases per exact device. The real variant ID
    // is chosen by the customer's phone-model selection at checkout (see
    // phoneCases.js) and stored per-order, never read from this field.
    printfulVariantId: null,
    mockupAspect: '9/19',
  },
  {
    id: 'tote-bag',
    name: 'Custom Cat Tote Bag',
    species: 'cat',
    description: 'A sturdy canvas tote printed with your cat\'s photo.',
    // Was $21 against a $17.95 Printful cost — a loss once shipping was
    // added. Raised to restore real margin (owner's call, 2026-09-11), and
    // already clears 40% both ways, so the 2026-09-28 repricing left it.
    priceUsd: 39.99,
    printfulVariantId: 16287, // AS Colour 1001 Cotton Tote Bag, Black — cost $17.95
    mockupAspect: '4/5',
  },
  {
    id: 'throw-pillow',
    name: 'Custom Cat Throw Pillow',
    species: 'cat',
    description: '16x16" throw pillow, insert included.',
    // $29.00 was underwater; $33.99 was set against an estimated $7.99 first
    // / $4.00 additional. Real rates are $10.89 / $4.50, which put a
    // three-pillow free-shipping order at 37.6%.
    // Was 35.99. 2026-09-30: the margin check now counts Stripe's card fee (2.9% + $0.30), which put a
    // three-pillow free-shipping order at 37.9%; clears at $37.34, rounded up (owner approved).
    priceUsd: 37.99,
    printfulVariantId: 49854, // All-Over Print Basic Pillow 16"x16" — cost $14.59
    mockupAspect: '1/1',
  },
  {
    id: 'fridge-magnet',
    name: 'Custom Cat Fridge Magnet',
    species: 'cat',
    description: 'A durable 4x4" magnet of your cat — a low-cost way to keep them on your fridge.',
    priceUsd: 9.99,
    printfulVariantId: 16367, // Die-Cut Magnets 4"x4" — cost $3.91
    mockupAspect: '1/1',
  },
  {
    id: 'crewneck-sweatshirt',
    name: 'Custom Cat Crewneck Sweatshirt',
    species: 'cat',
    description: "Your cat's photo on a soft, pre-shrunk Gildan 18000 crewneck sweatshirt. Black, sized S–5XL.",
    // Flat price regardless of size — standard for POD apparel, and
    // simpler than per-size pricing. Printful's cost runs $19.17 (S–XL) up
    // to $27.17 (5XL), confirmed against the catalog API.
    //
    // The floor is therefore checked against $27.17, the 5XL, not the $19.17
    // small: one flat price means a margin computed off the cheap end passes
    // a product that loses money every time someone orders a big one. That
    // is why this is $51.99 rather than the ~$40 the small size alone would
    // justify — the price carries the worst size in the range.
    // $44.99 was underwater; $51.99 was set against an estimated $5.39 first
    // / $2.20 additional. Apparel shipping was the worst of the estimates —
    // real rates are $8.79 / $2.50 — leaving a two-shirt free-shipping order
    // at 36.9%.
    // Was 54.99. 2026-09-30: the margin check now counts Stripe's card fee (2.9% + $0.30), which put a
    // two-shirt free-shipping order at 37.2%; clears at $57.74, rounded up (owner approved).
    priceUsd: 57.99,
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
  return PRODUCTS.filter((p) => p.species === species);
}

function getProduct(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

module.exports = { listProducts, getProduct };
