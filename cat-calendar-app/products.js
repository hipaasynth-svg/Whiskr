// Custom cat/dog print-on-demand catalog. Fulfilled through Printful
// (see printful.js) — no inventory, no local printing.
//
// Every printfulVariantId below is a real Printful catalog variant_id
// (raw catalog variant, not a synced store product — see printful.js's
// use of `variant_id` in the Orders API body), confirmed directly against
// Printful's catalog API. priceUsd is set above Printful's base cost —
// verified per-item, but not including shipping, which Printful bills
// separately per order and varies by destination/weight; leave real margin
// room rather than pricing right at cost.
// mockupAspect is a CSS aspect-ratio value for this product's own catalog
// photo (admin-uploaded — see product_media in db.js), not the customer's
// uploaded pet photo. Derived from each product's real physical dimensions
// where it has them, so the shape shown on the site actually matches what
// ships.
const PRODUCTS = [
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
    priceUsd: 22.0,
    printfulVariantId: 1349, // Enhanced Matte Paper Poster 12"x16" — cost $11.11
    mockupAspect: '3/4',
  },
  {
    id: 'canvas-12x12',
    name: 'Custom Pet Canvas',
    species: 'both',
    description: '12x12" gallery-wrapped canvas print, ready to hang.',
    priceUsd: 39.0,
    printfulVariantId: 823, // Canvas 12"x12" — cost $21.93
    mockupAspect: '1/1',
  },
  {
    id: 'phone-case',
    name: 'Custom Pet Phone Case',
    species: 'both',
    description: "Your pet on a durable phone case. Tell us your phone model at checkout.",
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
    // added. Raised to restore real margin (owner's call, 2026-09-11).
    priceUsd: 39.99,
    printfulVariantId: 16287, // AS Colour 1001 Cotton Tote Bag, Black — cost $17.95
    mockupAspect: '4/5',
  },
  {
    id: 'throw-pillow',
    name: 'Custom Pet Throw Pillow',
    species: 'both',
    description: '16x16" throw pillow, insert included.',
    priceUsd: 29.0,
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
];

function listProducts(species) {
  if (!species || species === 'all') return PRODUCTS;
  return PRODUCTS.filter((p) => p.species === 'both' || p.species === species);
}

function getProduct(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

module.exports = { PRODUCTS, listProducts, getProduct };
