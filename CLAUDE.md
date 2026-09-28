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
module, and both are locked by the owner's brief — don't adjust them to
"look right." Every `priceUsd` must clear Printful's real base cost with
room for shipping, which Printful bills separately per order. A locked price
under a risen cost is a loss on every single sale, so if a cost check says a
locked price is underwater, say so rather than silently repricing.

The contest prize is an original 11x16 acrylic. Its public value is
**$425** — the real published commission price for that size. Never state
$160; that number is wrong and appeared in the official rules for weeks.

### The margin floor

The owner's rule is a **minimum 35% gross margin after shipping, with no
discounting to reach it**. `orderEconomics.js` is the one place that knows
what an order costs us; run `node orderEconomics.js` after changing any
price or supplier cost. It exits non-zero when a product is below the floor
and prints the price that would clear it.

It reports. It does not reprice — see the paragraph above. A product with no
known supplier cost reports `unknown`, never a passing margin.

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
- The shipping figures in that file are **estimates**, not quotes.
  Printful's domains are blocked from this environment, so no shipping
  number in the repo has ever been confirmed against a live rate. Correct
  them from the Printful dashboard before trusting any margin.

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
