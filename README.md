# Whiskr

A cat photo contest + calendar business. Two pieces live here:

- **[`cat-calendar-app/`](cat-calendar-app/)** — the real product. A
  Node/Express backend: photo submissions, batches of 12, a voting window,
  Zoho Mail result emails, a Stripe-backed calendar shop. See its own
  [README](cat-calendar-app/README.md) for setup, deployment, and
  before-you-launch notes.
- **[`prototypes/whisker-cup-landing.html`](prototypes/whisker-cup-landing.html)** —
  a single-file, client-only design prototype (different visual direction,
  fully simulated in the browser, no backend). Useful as a design reference;
  not deployed and not wired to the real app.

## Start here

If you're setting this up for the first time: go to
[`cat-calendar-app/README.md`](cat-calendar-app/README.md).

If you want to know what was checked and fixed when these two pieces were
assembled into one repo — security fixes, and the business/legal items that
still need a decision before real launch — see
[`docs/audit-assembly.md`](docs/audit-assembly.md).
