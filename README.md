# Whiskr

A cat photo contest + calendar business, live at **whiskr.lol**. Two pieces
live here:

- **[`cat-calendar-app/`](cat-calendar-app/)** — the real product. A
  Node/Express backend: photo submissions, batches of 12, a judging
  deadline, a human picking the cover cat (`public/admin.html`), Zoho Mail
  result emails, a Stripe-backed calendar shop with a working payment
  webhook. See its own [README](cat-calendar-app/README.md) for setup,
  deployment, and before-you-launch notes.
- **[`prototypes/whisker-cup-landing.html`](prototypes/whisker-cup-landing.html)** —
  a single-file, client-only design prototype (different visual direction,
  fully simulated in the browser, no backend). Useful as a design reference;
  not deployed and not wired to the real app.

Winners are **judged by a human, not voted on by the public** — there's no
real voting mechanism anywhere in this app, and the copy says so. See
`docs/audit-assembly.md` for why that decision was made.

## Start here

If you're setting this up for the first time: go to
[`cat-calendar-app/README.md`](cat-calendar-app/README.md). In particular,
don't skip the Stripe webhook setup in that README — without it, paid
orders never get marked paid.

If you want to know what was checked and fixed when these two pieces were
assembled into one repo — security fixes, the judging-vs-voting decision,
and the business/legal items that still need attention before real launch —
see [`docs/audit-assembly.md`](docs/audit-assembly.md).
