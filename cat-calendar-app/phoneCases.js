// Real Printful catalog variant IDs for the Tough Case product line (product
// 601 = iPhone, product 686 = Samsung; Glossy finish only, chosen to keep the
// customer-facing picker to one option per device instead of finish x device).
// Pulled directly from Printful's catalog API — never guess or renumber
// these, since fulfilling against a wrong variant_id ships the wrong-size
// case for a customer's real phone.
const PHONE_CASE_VARIANTS = [
  { variantId: 15381, label: 'iPhone 11' },
  { variantId: 15382, label: 'iPhone 11 Pro' },
  { variantId: 15383, label: 'iPhone 11 Pro Max' },
  { variantId: 15384, label: 'iPhone 12' },
  { variantId: 15385, label: 'iPhone 12 mini' },
  { variantId: 15386, label: 'iPhone 12 Pro' },
  { variantId: 15387, label: 'iPhone 12 Pro Max' },
  { variantId: 15388, label: 'iPhone 13' },
  { variantId: 15389, label: 'iPhone 13 mini' },
  { variantId: 15390, label: 'iPhone 13 Pro' },
  { variantId: 15391, label: 'iPhone 13 Pro Max' },
  { variantId: 16124, label: 'iPhone 14' },
  { variantId: 16126, label: 'iPhone 14 Pro' },
  { variantId: 16128, label: 'iPhone 14 Plus' },
  { variantId: 16130, label: 'iPhone 14 Pro Max' },
  { variantId: 17714, label: 'iPhone 15' },
  { variantId: 17716, label: 'iPhone 15 Plus' },
  { variantId: 17718, label: 'iPhone 15 Pro' },
  { variantId: 17720, label: 'iPhone 15 Pro Max' },
  { variantId: 20302, label: 'iPhone 16' },
  { variantId: 20303, label: 'iPhone 16 Plus' },
  { variantId: 20304, label: 'iPhone 16 Pro' },
  { variantId: 20305, label: 'iPhone 16 Pro Max' },
  { variantId: 33985, label: 'iPhone 17' },
  { variantId: 33986, label: 'iPhone 17 Air' },
  { variantId: 33987, label: 'iPhone 17 Pro' },
  { variantId: 33988, label: 'iPhone 17 Pro Max' },
  { variantId: 52384, label: 'iPhone 18 Pro' },
  { variantId: 52386, label: 'iPhone 18 Pro Max' },
  { variantId: 16981, label: 'Samsung Galaxy S20' },
  { variantId: 16975, label: 'Samsung Galaxy S20 FE' },
  { variantId: 16977, label: 'Samsung Galaxy S20 Plus' },
  { variantId: 16979, label: 'Samsung Galaxy S20 Ultra' },
  { variantId: 16989, label: 'Samsung Galaxy S21' },
  { variantId: 16983, label: 'Samsung Galaxy S21 FE' },
  { variantId: 16985, label: 'Samsung Galaxy S21 Plus' },
  { variantId: 16987, label: 'Samsung Galaxy S21 Ultra' },
  { variantId: 16995, label: 'Samsung Galaxy S22' },
  { variantId: 16991, label: 'Samsung Galaxy S22 Plus' },
  { variantId: 16993, label: 'Samsung Galaxy S22 Ultra' },
  { variantId: 17001, label: 'Samsung Galaxy S23' },
  { variantId: 16997, label: 'Samsung Galaxy S23 Plus' },
  { variantId: 16999, label: 'Samsung Galaxy S23 Ultra' },
  { variantId: 18743, label: 'Samsung Galaxy S24' },
  { variantId: 18744, label: 'Samsung Galaxy S24 Plus' },
  { variantId: 18745, label: 'Samsung Galaxy S24 Ultra' },
  { variantId: 21469, label: 'Samsung Galaxy S25' },
  { variantId: 21471, label: 'Samsung Galaxy S25 Plus' },
  { variantId: 21473, label: 'Samsung Galaxy S25 Ultra' },
  { variantId: 49327, label: 'Samsung Galaxy S26' },
  { variantId: 49328, label: 'Samsung Galaxy S26 Plus' },
  { variantId: 49329, label: 'Samsung Galaxy S26 Ultra' },
];

const VALID_IDS = new Set(PHONE_CASE_VARIANTS.map((v) => v.variantId));

function listPhoneCaseModels() {
  return PHONE_CASE_VARIANTS.map(({ variantId, label }) => ({ variantId, label }));
}

// Never trust a variantId straight off the request — it must be one of the
// real case variants above, or an order could get submitted to Printful
// with an arbitrary/nonexistent variant.
function isValidPhoneCaseVariant(variantId) {
  return VALID_IDS.has(Number(variantId));
}

module.exports = { listPhoneCaseModels, isValidPhoneCaseVariant };
