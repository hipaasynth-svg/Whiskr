# Whiskr

A pet business, live at **whiskr.lol**, with two things going on:

- **An evergreen custom print shop** — upload a photo of your cat or dog,
  pick a product (mug, poster, canvas, phone case, tote, pillow), and it's
  printed and shipped through Printful. Always open, no batches to wait for.
- **A monthly photo contest** — entries seal into batches of 12; a human
  picks the cover cat, everyone in the batch gets a calendar offer.

Two pieces live here:

- **[`cat-calendar-app/`](cat-calendar-app/)** — the real product. A
  Node/Express backend covering both the print shop and the contest:
  photo uploads, Printful fulfillment, Stripe checkout + webhook,
  verified-purchase reviews, an affiliate picks hub, Zoho Mail
  notifications, and `public/admin.html` for judging/fulfillment/review
  moderation. See its own [README](cat-calendar-app/README.md) for setup,
  deployment, and before-you-launch notes.
- **[`prototypes/whisker-cup-landing.html`](prototypes/whisker-cup-landing.html)** —
  a single-file, client-only design prototype (different visual direction,
  fully simulated in the browser, no backend). Useful as a design reference;
  not deployed and not wired to the real app.

Two things this app deliberately never fabricates:

- **Contest winners are judged by a human, not voted on by the public** —
  there's no real voting mechanism anywhere in this app, and the copy says so.
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
security fixes, the judging-vs-voting and reviews decisions, and the
business/legal items that still need attention before real launch — see
[`docs/audit-assembly.md`](docs/audit-assembly.md).
