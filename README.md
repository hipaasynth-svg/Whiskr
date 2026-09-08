# Whiskr

A pet business, live at **whiskr.lol**, with two things going on:

- **An evergreen custom print shop** — upload a photo of your cat or dog,
  pick a product (mug, poster, canvas, phone case, tote, pillow), and it's
  printed and shipped through Printful. Always open, no batches to wait for.
- **A free, real-public-vote photo contest** — entry is free and always
  open; anyone can vote, once per cat, at `vote.html`; the top 12 vote-getters
  when a round closes make that round's calendar, and every entrant is told
  their final placement. No purchase necessary to enter or win. See
  `rules.html` for full mechanics.

Two pieces live here:

- **[`cat-calendar-app/`](cat-calendar-app/)** — the real product. A
  Node/Express backend covering both the print shop and the contest:
  photo uploads, Printful fulfillment, Stripe checkout + webhook,
  verified-purchase reviews, an affiliate picks hub, Zoho Mail
  notifications, anti-fraud vote rate-limiting, and `public/admin.html` for
  fraud review/fulfillment/review moderation. See its own
  [README](cat-calendar-app/README.md) for setup, deployment, and
  before-you-launch notes.
- **[`prototypes/whisker-cup-landing.html`](prototypes/whisker-cup-landing.html)** —
  a single-file, client-only design prototype (different visual direction,
  fully simulated in the browser, no backend). Useful as a design reference;
  not deployed and not wired to the real app.

Two things this app deliberately never fabricates:

- **Votes are real, not simulated** — `vote.html` casts a real, rate-limited,
  one-per-browser-identity vote against a real `votes` row; nothing here
  fakes a tally with `Math.random()` or a hidden human pick. An earlier
  version of this app used real human judging specifically to avoid having
  to build real voting infrastructure — see `docs/audit-assembly.md` for
  why that changed and what replaced it (rate limits, optional CAPTCHA,
  hidden live tallies, an admin fraud-review view, disqualification).
- **Reviews are real or absent, never seeded** — a review can only be
  created via a signed link tied to an actual paid order, and it stays
  unapproved until moderated. Fabricated reviews are illegal under the
  FTC's rule on fake reviews and testimonials (16 CFR Part 465).

See `docs/audit-assembly.md` for the full reasoning behind both.

## Start here

If you're setting this up for the first time: go to
[`cat-calendar-app/README.md`](cat-calendar-app/README.md). In particular,
don't skip the Stripe webhook setup (orders never get marked paid without
it) or the Printful setup (custom orders never get printed without it).

If you want to know what was checked and fixed as this app was built —
security fixes, the judging-vs-voting reversal, the reviews decision, and
the business/legal items that still need attention before real launch —
see [`docs/audit-assembly.md`](docs/audit-assembly.md).
