# Whiskr app

The whole of whiskr.lol: a Node/Express app on Vercel with Postgres, Vercel
Blob for uploaded photos, and a daily Vercel Cron job.

What it runs:

- **The contest.** Free entry (photo, name, email, phone), public voting
  at `/vote.html`, monthly rounds that close at 11:59 p.m. Central on the
  last day of the month. The #1 vote-getter wins an original 11x16 acrylic.
  The winner has 30 days to claim it at `/claim`; after that it passes to
  the runner-up. Mechanics are in `public/rules.html`, which is the
  authoritative text.
- **The print shop.** One page per product at `/shop/<id>`. Ordering
  happens in the homepage shop, and Printful prints and ships every order.
- **Commissions.** `/commission` books an original painting with a 40%
  deposit. The balance is requested from admin once the painting is
  finished.
- **The blog.** Markdown files in `content/blog/`, served at `/blog` with
  an RSS feed.

Read [`../CLAUDE.md`](../CLAUDE.md) before changing anything. It covers the
pricing floor, the no-fake-reviews rule, and the rule that site copy must
match what the code does.

## Files

| File | What it does |
| --- | --- |
| `server.js` | Every route: pages, the contest, voting, claims, checkout, the Stripe and Printful webhooks, admin, and the daily cron. |
| `db.js` | Postgres schema (created on cold start, additive only) and a small query helper. |
| `products.js` | The product catalog and prices. Prices move only via the margin floor. |
| `orderEconomics.js` | Supplier costs and shipping rates. `node orderEconomics.js` checks every price against the floor. |
| `phoneCases.js`, `sweatshirtSizes.js` | Per-device and per-size Printful variants. |
| `printful.js` | Submits paid orders to Printful and reads shipments back. |
| `mailer.js` | Every email, sent through Zoho SMTP. With no credentials set it logs the email instead of sending it. |
| `seo.js` | Server-rendered product grid, product pages, and JSON-LD. |
| `blog.js` | The blog: Markdown in, pages, index, RSS and sitemap entries out. |
| `commissions.js` | Commission sizes and prices. These are set by the owner, not by the margin floor. |
| `statusToken.js`, `claimToken.js`, `reviewLink.js`, `discountToken.js`, `commissionPayToken.js`, `unsubscribe.js` | Signed links (HMAC) for status pages, prize claims, reviews, discounts, balance payments and unsubscribes. |
| `metaAds.js`, `metaConversions.js` | Optional Meta ad-spend sync (read-only) and conversion events. |
| `photoEnhance.js` | Optional AI upscaling of low-resolution print photos (Replicate). Off unless configured. |
| `public/` | Static pages, front-end scripts, and `admin.html`. |

## Run it locally

```bash
npm install
cp .env.example .env          # then set POSTGRES_URL and ADMIN_KEY at minimum
createdb whiskr_dev           # any local Postgres works
npm start                     # http://localhost:3000
```

Tables are created on the first request. Without Stripe, Zoho or Printful
credentials the site still runs: checkout returns a clear error, emails are
printed to the console, and Printful submissions are logged as dry runs.

Before pushing:

- Run `node --check` on every changed `.js` file.
- Run `node orderEconomics.js` after touching any price or cost.
- Test database changes against a real local Postgres.

## Deploy (Vercel)

The Vercel project's **Root Directory** is `cat-calendar-app`.
`vercel.json` routes every request to `server.js`, ships `content/**` with
the function (the blog needs it), and registers the daily cron at
`/api/cron/daily` (09:00 UTC).

Environment variables (see `.env.example` for all of them):

| Needed for | Variables |
| --- | --- |
| Running at all | `POSTGRES_URL` (set by Vercel Postgres), `BLOB_READ_WRITE_TOKEN` (set by Vercel Blob), `ADMIN_KEY`, `PUBLIC_BASE_URL=https://whiskr.lol` |
| Signed links and security | `UNSUB_SECRET`, `IP_HASH_SALT`, `CRON_SECRET` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Printing | `PRINTFUL_API_KEY`, optionally `PRINTFUL_WEBHOOK_TOKEN` |
| Email | `ZOHO_EMAIL`, `ZOHO_APP_PASSWORD`, `ZOHO_FROM_EMAIL`, `ADMIN_EMAIL`, `BUSINESS_MAILING_ADDRESS` |
| Bot protection | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (turn on before running ads) |
| Ads and affiliate | `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `AMAZON_ASSOCIATE_TAG` |

### Stripe

Add a webhook endpoint at `https://whiskr.lol/api/webhooks/stripe` for
these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.refunded`
- `charge.dispute.created`

Put its signing secret in `STRIPE_WEBHOOK_SECRET`. Without it, no order is
ever marked paid or sent to Printful. Stripe Tax must be enabled, because
every checkout uses automatic tax. Receipts are sent automatically: each
checkout sets `receipt_email`.

### Printful

Create a store-scoped private token with Orders, Products and Webhooks
access, and add a billing method in Printful. The catalog orders directly
against Printful's catalog variant ids; nothing needs to be set up in the
Printful dashboard. Optionally, register a `shipment_sent` webhook at
`https://whiskr.lol/api/webhooks/printful/<PRINTFUL_WEBHOOK_TOKEN>`. The
daily cron polls for shipments either way.

Printful's API is not reachable from the Claude Code sandbox, so any new
cost or shipping quote has to be fetched from your own machine and pasted
in. Never guess a shipping rate.

### Zoho Mail

Use an app password (Settings → Security → App Passwords), not your login
password. Verify SPF/DKIM for the sending domain so mail doesn't land in
spam. Set `BUSINESS_MAILING_ADDRESS`, because CAN-SPAM requires a physical
address in promotional email.

An unsubscribe stops **promotional** email only: the final-placement email,
rank-drop alerts and review requests. Entry confirmations, winner and claim
emails, shipping notices and commission emails always send.

## Running the business

Everything is in `/admin.html`. Enter `ADMIN_KEY` and press Load.

- **Contest.** The current round's entries with vote velocity, plus
  disqualify and requalify. Rounds close on their own via the cron.
  `POST /api/admin/contest/force-close` closes one early, for testing.
- **Painting winners.** Each round's winner, their contact details, the
  claim deadline and the shipping address once they've claimed. Unclaimed
  prizes pass to the runner-up automatically, and you're emailed when that
  happens.
- **Shop products.** A per-product on/off switch, plus photo, alt text and
  SEO copy for each product. Off hides the product everywhere and blocks
  new orders.
- **Custom print orders.** Status, a Printful retry for failed
  submissions, and shipment tracking.
- **Reviews.** New reviews wait here for approval. Reviews only ever come
  from signed links sent after delivery.
- **Site alerts.** Failed orders, refunds, disputes and stalled parcels.
  These are also emailed to `ADMIN_EMAIL`.
- **Homepage content.** Hero photos, featured originals, promo blocks, the
  footer photo wall, and live painting sessions.
- **Marketing.** Campaign spend and ROAS, and the opt-in email list.

**Not in the admin UI yet** (API only, with the `x-admin-key` header):

- `GET /api/admin/commissions` lists bookings.
- `POST /api/admin/commissions/:id/request-balance` emails the customer a
  permanent signed payment link. Optional JSON body:
  `{"paintingImageUrl": "https://..."}`.
- `POST /api/admin/winners/:contestId` uploads the finished painting photo
  (`painting` field) and an optional `story` for `/winners`.

## Publishing a blog post

A post is a Markdown file, and publishing it is a commit.

1. Create `content/blog/<slug>.md`. The filename is the URL. Use lowercase
   letters, numbers and hyphens only.
2. Start the file with front matter:

   ```markdown
   ---
   title: "Quote the title, since most contain a colon"
   description: "One or two sentences, used for search results, cards and RSS."
   date: 2026-10-02
   image: /uploads/optional-photo.jpg
   imageAlt: Describe the photo
   draft: false
   ---
   ```

3. Write the post in Markdown and commit it. `draft: true` keeps a post out
   of the index, the feed and the sitemap, but its URL still works, which is
   how you preview it.

Amazon links are tagged with `AMAZON_ASSOCIATE_TAG` and marked
`rel="sponsored"` automatically. Any post with an Amazon link shows the
affiliate disclosure at the top; don't remove or restyle it. Prefer Amazon
search URLs (`/s?k=...`) over specific listings. Cite sources for factual
claims, and don't imply reader mail, sales or experience the business
doesn't have.

## Known leftovers

The retired calendar product and the old Cat of the Year vote are still in
the code, switched off: `CALENDAR_CHECKOUT_ENABLED` and
`YEAR_AWARD_MANUAL_VOTE_ENABLED` default to off. Their old URLs return
410 Gone. The `year_awards` table is **not** a leftover: it holds the
monthly painting winners and their claims.
