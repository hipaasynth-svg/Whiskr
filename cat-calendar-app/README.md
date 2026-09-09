# Whiskr — custom cat/dog prints, verified reviews, and a real-public-vote contest

A real, runnable Node/Express site with two things going on:

- **Evergreen storefront**: upload a photo of your cat or dog, pick a
  product (mug, poster, canvas, phone case, tote, pillow), pay, and it's
  printed and shipped through **Printful** — no inventory, always open,
  doesn't depend on the contest running.
- **Free, real-public-vote photo contest**: entry is free and always open —
  no batch to wait for. Anyone can vote for any entered cat, once per cat,
  at `vote.html`. When a round closes, the top `CONTEST_WINNERS_COUNT`
  (default 12) vote-getters make that round's calendar; everyone else gets
  their final placement by email and a nudge toward a solo print. Full
  mechanics in `public/rules.html`.

Reviews are **real or absent, never fabricated**. There is no seed/fake
review anywhere in this codebase — a review can only be created by
following a signed, order-specific link emailed after a real purchase (see
`reviewLink.js`), and even then it sits unapproved until you moderate it in
`admin.html`. Fabricating reviews violates the FTC's rule on fake
reviews/testimonials (16 CFR Part 465) — don't add a path around this.

Votes are similarly **real, not simulated**. `POST /api/vote` writes a real
row to the `votes` table, gated by a one-vote-per-cat-per-browser-identity
`UNIQUE` constraint, two independent rate limits (per voter identity, per
IP — see `VOTE_LIMIT_*` in `.env.example`), and optional Cloudflare
Turnstile CAPTCHA (`TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`). Vote
tallies stay hidden from the public while a round is open — see
`docs/audit-assembly.md` for why. `public/admin.html`'s "fraud review"
section surfaces vote velocity per entry and lets you disqualify one
(excludes it from tallying and voting, keeps its vote history for review).

## What's actually here

- `server.js` — Express app: the custom-product + contest submission APIs,
  the vote endpoint and anti-fraud checks, the contest tally/close job
  (promotes the top vote-getters into a `groups` row, reusing the calendar/
  checkout/PDF/email pipeline unchanged), reviews endpoints, Stripe
  Checkout + webhook, the daily cron job (contest close + due
  review-request emails), admin endpoints.
- `seo.js` — server-side prerendering helpers so the homepage/calendar pages
  are indexable without running client JS — see its header comment.
- `db.js` — Postgres (via the `pg` package), through a thin get/all/run
  shim so the rest of the app didn't need a query-by-query rewrite. Needs
  `POSTGRES_URL` — see Deployment below.
- `products.js` — the custom-print catalog. **Every `printfulVariantId` in
  here is a placeholder** — see Printful setup below.
- `printful.js` — submits paid custom orders to Printful for printing +
  shipping. Dry-run/logs if `PRINTFUL_API_KEY` isn't set, same pattern as
  Stripe/Zoho elsewhere in this app.
- `mailer.js` — sends through **Zoho Mail's SMTP**, not a third-party ESP.
- `unsubscribe.js` / `reviewLink.js` / `discountToken.js` / `statusToken.js`
  — signed-link helpers (all the same HMAC pattern) for one-click
  unsubscribe, verified-purchase reviews, time-limited print-shop
  discounts, and an entrant's private "check my status" link, respectively.
- `public/` — the storefront + contest landing page (`index.html`), the
  public voting gallery (`vote.html`), official contest rules
  (`rules.html`), an entrant's private status lookup (`status.html`), the
  per-round calendar/checkout page (`calendar.html`), the review submission
  page (`review.html`), `admin.html` (fraud review + fulfillment + review
  moderation — not linked from the public site), CSS, JS.

This is built specifically to run on **Vercel** as a serverless deployment:
`vercel.json` routes every request to `server.js` (exported as a plain
Express app, not `app.listen()`-ed directly — see the bottom of that file),
Postgres replaces SQLite (no writable local disk to persist to), Vercel
Blob replaces local file uploads, and Vercel Cron replaces the in-process
`node-cron` scheduler that an always-on server would use instead. See
Deployment below.

## 1. Install

```bash
cd cat-calendar-app
npm install
cp .env.example .env
```

For local development you need a Postgres database to point `POSTGRES_URL`
at — the quickest option is a local Postgres:
```bash
# macOS: brew install postgresql && brew services start postgresql
# Debian/Ubuntu: sudo apt-get install postgresql && sudo service postgresql start
createdb whiskr_dev
```
Then in `.env`:
```
POSTGRES_URL=postgres://<your-local-user>:<password>@localhost:5432/whiskr_dev
```
Tables are created automatically on first request (see `initDb` in
`db.js`) — nothing to migrate by hand.

## 2. Zoho Mail setup (required for real emails)

1. Log into Zoho Mail with the address you want contest emails to come from.
2. Go to **Settings → Security → App Passwords**.
3. Generate a new app password, name it something like "Whisker Ribbon Site".
4. Put the sending address and that app password into `.env`:
   ```
   ZOHO_EMAIL=contests@yourdomain.com
   ZOHO_APP_PASSWORD=<the 16-character app password>
   ZOHO_SMTP_HOST=smtp.zoho.com   # smtp.zoho.eu or smtp.zoho.in if your account is regional
   ```
5. Do **not** put your normal Zoho login password in `.env` — Zoho requires
   an app-specific password for SMTP, and your real password won't work
   here anyway if 2FA is on.
6. If you haven't already, verify your sending domain in Zoho (SPF/DKIM) —
   without that, your result emails are much more likely to land in spam.
   Zoho's domain verification wizard is under **Mail Admin → Domains**.

If `.env` is left unset, the server doesn't crash — it logs what *would*
have been sent to the console instead, so you can develop without live
credentials.

## 3. Stripe setup (optional, needed for real checkout)

Add your keys to `.env`:
```
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
```
Without a key, the shop pages still load; `/api/checkout` returns a clear
error instead of a broken payment flow.

## 4. Printful setup (required for custom orders to actually get printed)

Without this, the custom-print shop still takes payment (once Stripe is
configured), but `printful.js` only logs what it would have submitted —
nothing gets printed or shipped.

1. Create a [Printful](https://www.printful.com/) account (it's free — you
   only pay per order, no upfront cost or inventory).
2. In your Printful store, add each product from `products.js` (11oz mug,
   12x16 poster, 12x12 canvas, phone case, tote bag, 16x16 pillow) — or
   substitute your own picks, just keep `products.js` in sync.
3. For each one, find its **variant ID** (Printful dashboard → your product
   → Variants tab, or `GET /store/products` on their API) and paste it into
   the matching `printfulVariantId` in `products.js`. Every one ships as
   `null` in this repo — orders for a product with no variant ID configured
   will fail at the Printful-submission step (visible in `/admin.html`
   under Custom print orders, status `failed`), not silently.
4. Get a **Private Token** from Printful → Settings → Stores → API, and put
   it in `.env` as `PRINTFUL_API_KEY`.
5. Set your real prices in `products.js` (`priceUsd`) — above Printful's
   base cost + shipping for that product/destination (check current
   pricing in your Printful dashboard; it varies), or every sale loses
   money.

Real on-product mockups (showing the customer's photo ON the mug/poster
before they buy) aren't built — that needs Printful's async Mockup
Generator API, which needs a live store to test against. The order form
instead just previews the customer's own uploaded photo. Worth adding once
you've verified the basic order flow works end to end.

## 5. Run it

```bash
npm start
```
Visit `http://localhost:3000`. Try the custom-print shop (upload any photo,
pick a product) and the contest entry form (submit a cat — you're
immediately entered, no batch to wait for), then vote for it at
`http://localhost:3000/vote.html`.

To see a round actually close and a calendar get created without waiting
for `CONTEST_LENGTH_DAYS`, force-close the current contest from
`http://localhost:3000/admin.html` (enter your `ADMIN_KEY`, "Force-close
now" in the Current contest section), or directly:

```bash
curl -X POST http://localhost:3000/api/admin/contest/force-close -H "x-admin-key: <ADMIN_KEY from .env>"
```

That tallies every entrant's votes, promotes the top `CONTEST_WINNERS_COUNT`
into a new calendar, sends the winner/featured/final-placement emails for
real (if Zoho is configured), and opens the next round automatically.

## 6. Stripe webhook (required for any order to ever show as paid)

Without this, both `/api/checkout` (calendars) and `/api/custom-orders`
(prints) create an order row as `pending` and nothing ever marks it paid —
you'd have no reliable record of who actually paid, and custom orders would
never get submitted to Printful (that only happens once the webhook marks
an order paid).

- **Local dev**: run `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
  (Stripe CLI). It prints a `whsec_...` value — put that in `.env` as
  `STRIPE_WEBHOOK_SECRET`.
- **Production**: in the Stripe Dashboard, add a webhook endpoint pointing
  at `https://whiskr.lol/api/webhooks/stripe`, subscribed to
  `checkout.session.completed`, and put its signing secret in
  `STRIPE_WEBHOOK_SECRET`.

Check what's actually been paid for (and needs fulfilling) at
`/admin.html`, or directly: `GET /api/admin/orders?status=paid` and
`GET /api/admin/custom-orders?status=paid` (with your `x-admin-key`
header).

## 7. Reviews

The only way a review gets created is through a signed link mailed
`REVIEW_REQUEST_DELAY_DAYS` after an order is marked paid (see
`sendDueReviewRequests` in `server.js` and `sendReviewRequest` in
`mailer.js`) — there's no admin "add a review" button and no seed data, on
purpose. New reviews land unapproved; moderate them (approve or reject) in
`/admin.html` under "Reviews awaiting approval." Only approved reviews show
on the homepage, and the homepage shows an honest empty state (plus a
defect/misprint guarantee) until the first one lands.

## 8. Deployment (Vercel)

1. **Import the repo.** In the Vercel dashboard: Add New -> Project ->
   import `hipaasynth-svg/Whiskr`. Set **Root Directory** to
   `cat-calendar-app` — this repo has another folder (`prototypes/`)
   alongside the real app, so Vercel needs to be told where to build from.
2. **Add a Postgres database.** Project -> Storage tab -> Create Database
   -> Postgres, then connect/link it to this project. Vercel sets
   `POSTGRES_URL` automatically — you don't type this in yourself.
3. **Add a Blob store.** Same Storage tab -> Create Database -> Blob, link
   it to this project. Vercel sets `BLOB_READ_WRITE_TOKEN` automatically.
   Without it, uploaded photos would try to write to local disk, which
   doesn't persist (or even work reliably) on Vercel — this one is not
   optional in production.
4. **Set the remaining environment variables** (Project -> Settings ->
   Environment Variables) — everything else in `.env.example` that isn't
   Postgres/Blob: `ADMIN_KEY`, `UNSUB_SECRET`, `CRON_SECRET`,
   `PUBLIC_BASE_URL` (your real domain, e.g. `https://whiskr.lol`),
   `BUSINESS_MAILING_ADDRESS`, and the Zoho/Stripe/Printful values once you
   set those up.
5. **Deploy.** Vercel picks up `vercel.json` automatically — it defines
   the build, routes every path to `server.js`, and registers the daily
   cron (`/api/cron/daily`) that replaces `node-cron`.
6. **Point your domain at it** — Project -> Settings -> Domains -> add
   `whiskr.lol`, then add the DNS record Vercel shows you at wherever you
   registered the domain.

No VPS, no Dockerfile, no persistent volume to configure by hand — that's
the point of routing storage through Postgres/Blob instead of local disk.

## 9. Before you actually launch — a few things worth fixing first

**[UPDATED] — CAN-SPAM basics: mechanism is wired, content isn't.** Every
commercial email you send in the US legally needs a working unsubscribe
mechanism and your business's physical mailing address in the footer. Both
now exist in `mailer.js` — a signed one-click unsubscribe link and a
`BUSINESS_MAILING_ADDRESS` footer line — but you still need to **put your
real mailing address in `.env`** before sending real result/offer/review
emails. I'm not a lawyer; confirm this against current FTC guidance or with
counsel before you go live, especially if you'll also be emailing EU
entrants (GDPR marketing-consent rules are stricter and separate from
CAN-SPAM, and this unsubscribe mechanism alone doesn't satisfy them).

**[UPDATED] — photo rights: now enforced for both flows.** The contest
entry form and the custom-print order form both require an "I own this
photo and grant Whiskr a license to print and sell it" checkbox, and the
server rejects submissions without it, storing a `photo_rights_consent_at`
timestamp either way. Still worth having counsel confirm the checkbox
language covers what you actually need (e.g. minors in photos, background
people/property) before scaling up.

**[RESOLVED, later superseded] — winners are judged, not simulated-voted.**
`Math.random()` used to silently pick every winner while the copy claimed
"the room votes" — a real FTC deceptive-advertising exposure. The fix at
the time was human judging: you picked the cover cat per batch at
`/admin.html`, with a random fallback only if you missed the judging
deadline. **This was later deliberately reversed** — the owner chose to
build real public voting on purpose, as a high-volume growth mechanic, this
time with actual anti-fraud infrastructure (rate limits, optional CAPTCHA,
hidden live tallies, disqualification) instead of the fake `Math.random()`
version rejected above. See `docs/audit-assembly.md`'s entry on the
public-voting rebuild for the full reasoning. The distinction that mattered
both times: fake voting dressed up as real is the FTC problem; real voting,
honestly described, never was.

**[RESOLVED] — reviews are real or absent, never fabricated.** See the
Reviews section above — every review requires a signed, order-specific
link and owner moderation. There is no code path that creates a review any
other way. Don't add one, even under pressure to "seed" the homepage —
fabricated reviews are illegal under the FTC's 2024 rule (16 CFR Part 465),
not just a trust problem.

**Business-model notes, not legal ones:**
- *Every one of the 11 non-winners still gets a purchase offer.* That's the
  contest's monetization engine — 12 warm leads per batch instead of 1 —
  keep that flow intact even as you redesign anything else.
- *Printful's cut plus your price needs to actually be profitable.* Check
  their current per-product base cost + shipping before finalizing
  `priceUsd` in `products.js` — it varies by product and destination.
- *No rate-limiting on `/api/submissions` or `/api/custom-orders`.* A
  script could flood either with fake entries — fine at low volume, worth
  addressing before you drive real traffic.

## 10. Replacing the placeholder content

- Hero photos are pulled live from `cataas.com` (a free public cat-photo
  API) in `public/script.js` — swap in your own photography whenever
  you're ready.
- Every `printfulVariantId` in `products.js` is a placeholder — see
  Printful setup above.
- Affiliate links in `index.html` under `#picks` are real URLs but not
  tagged with your affiliate IDs — swap in your real, tracked affiliate
  URLs (Chewy, Amazon Associates, etc.) before driving traffic to them.
- Calendar pricing lives in `.env` (`CALENDAR_PRICE_USD`,
  `CALENDAR_2PLUS_PRICE_USD`) and is read by both the shop section and the
  Stripe checkout — change it in one place.
