# Working on Whiskr

## Start every session from `main`

**`main` is the only truth.** It is what's deployed to whiskr.lol via Vercel.
Before reading any code or forming a plan, run:

```bash
git fetch origin main
git rev-list --count HEAD..origin/main   # must be 0
```

If that number is not 0, you are reading a stale snapshot. Reset onto main
before doing anything else:

```bash
git checkout -B <your-branch> origin/main
```

This is not hypothetical. On 2026-09-28 a session was handed a branch cut
from a September 7 feature branch — 92 commits and ~35 merged PRs behind
main — and spent its whole context reading and "fixing" an app that had
already been replaced. It concluded the site had no voting and no rules
page; both had existed for weeks. Stale branches are silent: the old code
reads as perfectly plausible current code.

Session branches (`hipaasynth-svg/<name>`, `claude/<name>`) are often cut
from whatever branch the previous session used, **not** from main. Always
check.

## What this repo is

`cat-calendar-app/` is the whole product — a Node/Express app on Vercel
(Postgres + Vercel Blob + Vercel Cron). Everything else is history:

- `prototypes/` — a dead client-only design mock. Not deployed. Don't wire
  anything to it, don't take its simulated voting as a reference.
- `docs/audit-assembly.md` — the running decision log. Read the *last*
  update section for current direction; earlier sections describe decisions
  that have since been reversed (e.g. it says winners are judged by a human
  and there is no public voting — both are long out of date).

## Two rules that are not style preferences

1. **No fabricated reviews.** A review can only be created through a signed,
   order-specific link (`reviewLink.js`) after a real paid order. There is no
   seed data and no admin "add review" path. Fabricated reviews are illegal
   under 16 CFR Part 465, not merely dishonest. An empty reviews section is
   the correct state until real ones exist.
2. **Site copy must match the mechanism that actually runs.** Contest copy
   claimed public voting while the backend picked winners with
   `Math.random()`; that was a real FTC exposure and had to be fixed twice.
   If you change how the contest works, change the copy, the rules page and
   the emails in the same commit.

The same rule governs imagery: an empty gallery renders an honest empty
state ("first one's still drying"), never stock photography standing in for
work that doesn't exist.

## Prices

Product prices live in `products.js`, commission prices in the pricing
module. Don't adjust either to "look right" — the only thing that moves a
product price is the margin floor below, and the only thing that moves a
commission price is the owner saying so. A price under a risen cost is a
loss on every single sale, so if a cost check says a price is underwater,
say so; don't reprice on a hunch, and don't leave it either.

**Commission prices are NOT set by the margin floor** and were not touched
by the 2026-09-28 repricing. A commission is the owner's own labour and
materials, and no cost basis for it exists anywhere in this repo — a margin
needs a cost. $425 is also load-bearing in `rules.html` as the prize's
public value, so moving it means moving the rules and the emails too.

The contest prize is an original 11x16 acrylic. Its public value is
**$425** — the real published commission price for that size. Never state
$160; that number is wrong and appeared in the official rules for weeks.

### The margin floor

The owner's rule is a **minimum 40% gross margin after shipping, with no
discounting to reach it** (raised from 35% on 2026-09-28, when the whole
catalog was repriced to it). `orderEconomics.js` is the one place that knows
what an order costs us; run `node orderEconomics.js` after changing any
price or supplier cost. It exits non-zero when a product is below the floor
or when a discount would push one under, and prints the price that clears.

A product with no known supplier cost reports `unknown`, never a passing
margin. **None do any more** — every cost in the catalog was read off
Printful's live API on 2026-09-28 and the last four were repriced from real
numbers. Two of those four were underwater against prices that had been
guessed from market rates: the luster framed print (cost $37.45 against a
$74 price) and the phone case (cost $14.23 against $24.99).

Two costs are a FLOOR rather than the cost, because one flat price covers
many variants and only one variant has been priced: the sweatshirt is
checked against 5XL ($27.17, not the $19.17 small) and the phone case
against the iPhone 11 ($14.23). A newer or larger phone may cost more, and
the flat price has to carry the most expensive one — price every device
before trusting that margin.

**No discounts.** Prices sit at the floor, so any discount at all lands
under it — the report prints the largest the catalog survives, and that
number is currently **0%**. `CONTEST_DISCOUNT_PERCENT` therefore defaults
to 0. It used to default to 20%, which put every single product below the
floor (the mug at 32.0%, the sweatshirt at 25.5%) with nothing in a
checkout session looking wrong while it happened. Discounting is the quiet
way to undo a repricing. If you raise it, the report will fail.

Two things that are easy to get wrong here:

- A product must clear the floor in **both** cases the report prints, and
  the second one is the trap. `SMALL` is an order under the free-shipping
  threshold: the customer pays shipping, so it nets out and the margin is
  just the item's. `FREE` is an order at or over the threshold, where we pay
  the whole parcel out of that same margin — checked at the fewest units
  that reach $79, the worst version of it. Heavy items pass `SMALL`
  comfortably and fail `FREE`: three canvases is $117 of revenue against
  nearly $18 of shipping. Checking only one number is how you end up
  confidently wrong.
- Shipping figures are now **real quotes** from `POST /shipping/rates`,
  taken 2026-09-28, except three the file flags on their own rows: the tote
  bag (Printful returns 400 for its rate request at every quantity, though
  it prices the variant fine — worth checking they will actually fulfil it)
  and the additional-unit rate for the luster framed poster and the 18x24
  canvas, where one unit already clears the threshold so only a single-unit
  quote exists. Printful is unreachable from this environment, so any new
  rate has to be quoted from a machine that can reach it and pasted in.

  **Never guess a shipping rate.** The estimates these replaced were wrong
  in both directions and three prices had to rise a second time when the
  truth arrived: the additional canvas rate was guessed at $4.50 against a
  real $9.99, and apparel's first rate at $5.39 against a real $8.79, while
  the mug was overestimated by 16%. A guess that happens to be high is not
  safe either — it inflates a price and costs sales. Two framed prints are
  still carrying prices set from a bad estimate and sit well above their
  floor as a result.

Shipping is free at **$79+** and charged below that. The threshold is a
constant, deliberately not an environment variable, because it is also
written into `public/shipping.html` as a promise to the customer — change
one and change the other in the same commit.

## Before you push

- `node --check` every `.js` file you touched.
- Verify against a real local Postgres where the change touches the DB.
  `db.js` DDL is re-run on every cold start, so every schema change must be
  `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Nothing that takes money (Stripe, Printful) can be verified in this
  sandbox. Say plainly what you exercised and what you didn't, rather than
  implying a payment path was tested.
