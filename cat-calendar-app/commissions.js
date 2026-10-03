// Original acrylic commissions — studio time, not print-on-demand.
//
// This is the art tier and it must never be priced near the souvenir tier
// in products.js: a $23.99 poster and a $425 original are not the same kind of
// thing, and pricing them like they are devalues the painting rather than
// making it look affordable.
//
// Prices are locked by the owner's brief. Everything that can change a
// commission's price lives in this one file so that the table published on
// /commission and the amount Stripe actually charges cannot drift apart —
// the page renders from publicPricing(), the checkout charges from quote(),
// and both read the same constants below.
//
// Unlike products.js there is no per-unit vendor cost to clear here: the
// cost is Cody's own time, so these numbers are a rate card, not a margin
// calculation.

const SIZES = [
  { id: '11x16', label: '11x16"', priceUsd: 425 },
  { id: '16x20', label: '16x20"', priceUsd: 771 },
  { id: '18x24', label: '18x24"', priceUsd: 1041 },
];

const RUSH_USD = 125; // finished in under 10 days
const EXTRA_PET_USD = 150; // each additional pet in the same painting
const MAX_EXTRA_PETS = 3;
const DEPOSIT_RATE = 0.4; // 40% books the slot; balance is due before it ships

function getSize(id) {
  return SIZES.find((s) => s.id === id) || null;
}

// Whole cents. Every figure above is a whole dollar and the rate is 0.4, so
// nothing here currently rounds — this guards a future price ending in .99
// from turning a deposit into fractional cents Stripe would reject.
function money(n) {
  return Math.round(n * 100) / 100;
}

// The single source of truth for what a commission costs. Returns null for
// an unknown size rather than guessing, so a bad size id from a client
// fails the request instead of quietly pricing something else.
function quote({ sizeId, rush = false, extraPets = 0 }) {
  const size = getSize(sizeId);
  if (!size) return null;

  const pets = Math.max(0, Math.min(MAX_EXTRA_PETS, Number(extraPets) || 0));
  const lines = [{ label: `Original acrylic, ${size.label}`, amountUsd: size.priceUsd }];
  if (rush) lines.push({ label: 'Rush — finished in under 10 days', amountUsd: RUSH_USD });
  if (pets > 0) {
    lines.push({
      label: `${pets} extra cat${pets === 1 ? '' : 's'} in the same painting`,
      amountUsd: EXTRA_PET_USD * pets,
    });
  }

  const totalUsd = money(lines.reduce((sum, l) => sum + l.amountUsd, 0));
  const depositUsd = money(totalUsd * DEPOSIT_RATE);

  return {
    sizeId: size.id,
    sizeLabel: size.label,
    rush: Boolean(rush),
    extraPets: pets,
    lines,
    totalUsd,
    depositUsd,
    // Derived by subtraction, never rounded independently, so deposit +
    // balance always equals the total exactly.
    balanceUsd: money(totalUsd - depositUsd),
  };
}

// What /commission renders its price table from, served via /api/config so
// the published table is generated from the same constants the checkout
// charges against.
function publicPricing() {
  return {
    sizes: SIZES.map((s) => ({ id: s.id, label: s.label, priceUsd: s.priceUsd })),
    rushUsd: RUSH_USD,
    rushDays: 10,
    extraPetUsd: EXTRA_PET_USD,
    maxExtraPets: MAX_EXTRA_PETS,
    depositPercent: Math.round(DEPOSIT_RATE * 100),
    timeline: '2–4 weeks after deposit',
  };
}

module.exports = {
  SIZES,
  RUSH_USD,
  EXTRA_PET_USD,
  MAX_EXTRA_PETS,
  DEPOSIT_RATE,
  getSize,
  quote,
  publicPricing,
  money,
};
