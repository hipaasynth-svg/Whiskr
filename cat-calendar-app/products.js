// Custom cat/dog print-on-demand catalog. Fulfilled through Printful
// (see printful.js) — no inventory, no local printing.
//
// TODO before going live: every `printfulVariantId` below is a placeholder.
// Create these products in your Printful dashboard (Store > Products), and
// replace the placeholders with the real variant IDs Printful gives you —
// find them in the product's "Variants" tab or via GET /store/products on
// their API. Until you do, orders will still take payment (once Stripe is
// configured) but printful.js will log a warning and skip submission rather
// than send Printful a variant ID that doesn't exist.
//
// priceUsd is what you charge the customer — set it above Printful's base
// cost + shipping (check current pricing in your Printful dashboard; it
// varies by product and destination) or every sale loses money.
const PRODUCTS = [
  {
    id: 'mug-11oz',
    name: 'Custom Pet Mug',
    species: 'both',
    description: "Your pet's photo on an 11oz ceramic mug. Dishwasher and microwave safe.",
    priceUsd: 19.99,
    printfulVariantId: null,
  },
  {
    id: 'poster-12x16',
    name: 'Custom Pet Poster',
    species: 'both',
    description: 'A 12x16" matte poster print of your pet, ready to frame.',
    priceUsd: 22.0,
    printfulVariantId: null,
  },
  {
    id: 'canvas-12x12',
    name: 'Custom Pet Canvas',
    species: 'both',
    description: '12x12" gallery-wrapped canvas print, ready to hang.',
    priceUsd: 39.0,
    printfulVariantId: null,
  },
  {
    id: 'phone-case',
    name: 'Custom Pet Phone Case',
    species: 'both',
    description: "Your pet on a durable phone case. Tell us your phone model at checkout.",
    priceUsd: 24.99,
    printfulVariantId: null,
  },
  {
    id: 'tote-bag',
    name: 'Custom Pet Tote Bag',
    species: 'both',
    description: 'A sturdy canvas tote printed with your pet\'s photo.',
    priceUsd: 21.0,
    printfulVariantId: null,
  },
  {
    id: 'throw-pillow',
    name: 'Custom Pet Throw Pillow',
    species: 'both',
    description: '16x16" throw pillow, insert included.',
    priceUsd: 29.0,
    printfulVariantId: null,
  },
];

function listProducts(species) {
  if (!species || species === 'all') return PRODUCTS;
  return PRODUCTS.filter((p) => p.species === 'both' || p.species === species);
}

function getProduct(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

module.exports = { PRODUCTS, listProducts, getProduct };
