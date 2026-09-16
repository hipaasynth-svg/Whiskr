// Real Printful catalog variant IDs for the crewneck sweatshirt product
// (products.js id: crewneck-sweatshirt), Black only — chosen to keep the
// customer-facing picker to one choice (size) instead of size x color,
// same reasoning as phoneCases.js choosing one finish per device. Pulled
// directly from Printful's catalog API (GET /products/145) — never guess
// or renumber these, since fulfilling against a wrong variant_id ships the
// wrong size to a customer.
const SWEATSHIRT_SIZE_VARIANTS = [
  { variantId: 5434, label: 'S' },
  { variantId: 5435, label: 'M' },
  { variantId: 5436, label: 'L' },
  { variantId: 5437, label: 'XL' },
  { variantId: 5438, label: '2XL' },
  { variantId: 5439, label: '3XL' },
  { variantId: 5440, label: '4XL' },
  { variantId: 5441, label: '5XL' },
];

const VALID_IDS = new Set(SWEATSHIRT_SIZE_VARIANTS.map((v) => v.variantId));

function listSweatshirtSizes() {
  return SWEATSHIRT_SIZE_VARIANTS.map(({ variantId, label }) => ({ variantId, label }));
}

// Never trust a variantId straight off the request — it must be one of the
// real size variants above, or an order could get submitted to Printful
// with an arbitrary/nonexistent variant.
function isValidSweatshirtVariant(variantId) {
  return VALID_IDS.has(Number(variantId));
}

module.exports = { listSweatshirtSizes, isValidSweatshirtVariant };
