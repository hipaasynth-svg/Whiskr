# Whiskr — custom cat/dog prints, verified reviews, and a real-public-vote contest

A real, runnable Node/Express site with two things going on:

- **Evergreen storefront**: upload a photo of your cat or dog, pick a
  product (mug, poster, canvas, phone case, tote, pillow), pay, and it's
  printed and shipped through **Printful** — no inventory, always open,
  doesn't depend on the contest running.
- **Free, real-public-vote photo contest**: entry is free and always open —
  no batch to wait for. Anyone can vote for any entered cat, once per cat,
  at `vote.html`. When a round closes, the #1 vote-getter ("Cat of the
  Month") wins a one-of-a-kind original hand-painted portrait; everyone
  else gets their final placement by email and a nudge toward a solo
  print. Full mechanics in `public/rules.html`.

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
  (ranks every entrant and awards the #1 vote-getter an original painting
  directly — see `awardPainting`), reviews endpoints, Stripe
  Checkout + webhook, the daily cron job (contest close + due
  review-request emails), admin endpoints.
- `seo.js` — server-side prerendering helpers so the homepage/calendar pages
  are indexable without running client JS — see its header comment.
- `blog.js` — the `/blog` section: renders the Markdown files in
  `content/blog/` into server-rendered post pages, an index, and an RSS
  feed, and tags/discloses Amazon affiliate links automatically. Needs no
  database — see section 12 for the publishing workflow.
- `db.js` — Postgres (via the `pg` package), through a thin get/all/run
  shim so the rest of the app didn't need a query-by-query rewrite. Needs
  `POSTGRES_URL` — see Deployment below.
- `products.js` — the custom-print catalog, with real Printful catalog
  variant IDs already set. `phoneCases.js` holds the per-device variant
  list for the phone case product — see Printful setup below.
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
   only pay per order, no upfront cost or inventory), and add a payment
   method under Settings → Billing — without one, real orders fail even
   with a valid API key, since Printful charges you for cost + shipping
   per order.
2. Get a **Private Token**: Settings → Stores → your store → API → create
   a token (scope it to a single store, not the whole account, and check
   Orders + Products + Webhooks). Put it in `.env` / your host's
   environment variables as `PRINTFUL_API_KEY`.
3. That's it for the catalog — `products.js` already has real Printful
   catalog `variant_id`s for every product except the phone case (which
   has no single variant; see below), verified directly against
   Printful's catalog API. Nothing needs to be created in the Printful
   dashboard, since this app orders directly against Printful's public
   catalog rather than synced store products.
4. Phone cases are sized per exact device, so there's no single variant
   ID for "a phone case." The checkout form has a phone-model picker
   (`GET /api/phone-models`, backed by `phoneCases.js`) that resolves to
   a real Printful variant server-side — never trust a variant ID
   straight off a request. Currently covers the Tough Case line for
   iPhone 11–18 and Samsung Galaxy S20–S26; re-run the same catalog
   lookup against product IDs 601 (iPhone) / 686 (Samsung) to add newer
   models as Printful adds them.
5. Re-check pricing whenever you touch `products.js` — `priceUsd` needs
   to clear Printful's base cost *and* shipping (which is billed
   separately, varies by product/destination, and isn't included in the
   catalog's per-item price) for every sale to be profitable.
6. **Adding a new product** (e.g. the crewneck sweatshirt): find its real
   Printful catalog `product_id` from its storefront URL
   (`printful.com/custom/.../{product_id}/...`), then list every
   size/color variant under that product — each has its own `variant_id`
   and base cost — with `PRINTFUL_API_KEY` set:

   ```bash
   # macOS/Linux
   curl -s -H "Authorization: Bearer $PRINTFUL_API_KEY" \
     https://api.printful.com/products/145 | jq
   ```
   ```powershell
   # Windows PowerShell
   $headers = @{ Authorization = "Bearer $env:PRINTFUL_API_KEY" }
   (Invoke-RestMethod -Uri "https://api.printful.com/products/145" -Headers $headers).result.variants |
     Select-Object id, name, size, color, price | Format-Table
   ```
   Paste the `variant_id` for the size/color you're selling into that
   product's `printfulVariantId` in `products.js` (`145` above is the
   Gildan 18000 Unisex Crewneck Sweatshirt already stubbed in as
   `crewneck-sweatshirt` — currently `null` until you run this).

Real on-product mockups (showing the customer's own uploaded photo ON the
mug/poster before they buy) aren't built — that needs Printful's async
Mockup Generator API, which needs a live store to test against. The order
form instead just previews the customer's own uploaded photo.

That's different from the **static catalog photo** shown for each product
in the shop grid (`product_media` in `db.js`, uploaded via `admin.html`'s
product editor) — that part's already built and just needs a real image
per product. For a quick, code-free product photo: Printful's own
[free mockup generator](https://www.printful.com/mockup-generator) (any
Printful account, no paid plan needed) lets you upload art onto their real
product photography and download a PNG/JPEG — pick the same product/variant
you configured above, upload a sample pet photo, download the result, then
upload it as that product's photo in `admin.html`.

## 4a. AI photo upscaling (optional)

Not every customer takes a good photo. Printful's own Smart Image Tool
only nudges borderline-low-DPI files over its minimum — it doesn't fix a
genuinely blurry or small phone photo. `photoEnhance.js` adds a real fix:
any custom-order photo under `PHOTO_ENHANCE_MIN_PX` on its long edge gets
AI-upscaled via [Replicate](https://replicate.com/account/api-tokens)
(pay-per-use, no subscription) before it's submitted to Printful. Without
`REPLICATE_API_TOKEN` set, this is a complete no-op — orders print exactly
the photo the customer uploaded, same as before this existed.

It only runs once, after Stripe confirms payment (inside
`submitCustomOrderToPrintful`) — never during upload or checkout — so a
slow AI call can never stall a customer's checkout, and you're never
paying to enhance a cart that gets abandoned.

**Not exercised against a live Replicate account** — no account exists yet
to test against, same caveat as Printful's Mockup Generator above. Before
relying on this for real orders, verify against your own account: that
`nightmareai/real-esrgan` (or whatever you set `REPLICATE_MODEL` to) still
works via the plain `owner/name` API path without a pinned version hash,
and that a real low-res test photo actually comes back sharper. `GFPGAN`
face restoration (`PHOTO_ENHANCE_FACE=true`) is off by default — it's
trained on human faces and may distort a cat or dog's face in ways you
won't want; only turn it on after eyeballing real results yourself.

If you're on Vercel's **Hobby** plan (10s function timeout by default),
keep `PHOTO_ENHANCE_WAIT_SECONDS` low — this shares the webhook's time
budget with marking the order paid and submitting to Printful. If you see
webhook timeouts after turning this on, either lower that further or move
to a plan with a longer `maxDuration`.

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

That tallies every entrant's votes, awards the #1 vote-getter an original
painting directly, sends the winner/final-placement emails for real (if
Zoho is configured), and opens the next round automatically.

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

**[UPDATED] — photo rights: enforced for both flows, and scoped to what
each one actually does.** Both forms require a photo-rights checkbox, the
server rejects submissions without it, and a `photo_rights_consent_at`
timestamp is stored either way. The two grants are deliberately different
and deliberately narrow:

- **Contest entry** — the entrant keeps ownership and permits public
  display (vote page, results, share card), promotion of *this contest* on
  Whiskr's own social accounts and ads, and, if they win, painting the
  portrait from the photo and showing it afterwards. It does **not** permit
  selling products made from their photo.
- **Custom print order** — the customer keeps ownership and permits
  printing the item they ordered and sending the photo to Printful to make
  and ship it. Nothing else.

The authoritative text is the Photo rights section of `public/rules.html`;
the checkboxes in `index.html`/`landing.html` summarize it and link to it.
Keep all four in sync — if you ever revive the calendar flow
(`CALENDAR_CHECKOUT_ENABLED`) or anything else that sells a product made
from an *entry* photo, the current contest grant does not cover it and you
need fresh consent from entrants before shipping one. Still worth having
counsel confirm the language covers what you need (e.g. minors in photos,
background people/property) before scaling up.

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
- *Every non-winner still gets a purchase nudge.* Every entrant who isn't
  Cat of the Month gets a final-placement email with a time-limited
  discount toward the print shop — that's the contest's monetization
  engine now that entry is open-ended rather than fixed at 12.
- *Printful's cut plus your price needs to actually be profitable.* Check
  their current per-product base cost + shipping before finalizing
  `priceUsd` in `products.js` — it varies by product and destination.
- *Submissions, custom orders, and votes are all rate-limited per IP per
  day* (see `SUBMISSION_LIMIT_PER_IP_PER_DAY`, `CUSTOM_ORDER_LIMIT_PER_IP_PER_DAY`,
  `VOTE_LIMIT_PER_IP_PER_DAY` in `.env.example`) — tune these if real
  traffic needs different thresholds.

## 10. Replacing the placeholder content

- Hero photos are pulled live from `cataas.com` (a free public cat-photo
  API) in `public/script.js` — swap in your own photography whenever
  you're ready.
- `products.js`'s Printful variant IDs are real — see Printful setup above
  if you swap in different products.
- Affiliate links in `index.html` under `#picks` are real URLs but not
  tagged with your affiliate IDs — swap in your real, tracked affiliate
  URLs (Chewy, Amazon Associates, etc.) before driving traffic to them.
- Calendar pricing lives in `.env` (`CALENDAR_PRICE_USD`,
  `CALENDAR_2PLUS_PRICE_USD`) and is read by both the shop section and the
  Stripe checkout — change it in one place.

## 11. Marketing / ROAS ledger (optional)

The admin panel (`admin.html` → "Marketing / ad spend") tracks real ad
spend against real attributed revenue and computes ROAS per named
campaign. It works two ways, and you don't need this section at all to use
the manual one:

**Manual (no setup needed).** Add a campaign in the admin panel, tag your
ad links with `?utm_campaign=your-campaign-name` (must match the campaign
name you typed, case-insensitive), and log spend yourself from your ad
platform's own dashboard whenever you check in.

**Where to point the ad itself.** Send paid traffic to
`/landing.html?utm_campaign=your-campaign-name` rather than the homepage —
it's the same entry form and proof (how it works, past originals,
reviews) with the nav and every other on-site distraction stripped out,
so a click has exactly one place to go: enter. It's marked `noindex` and
canonical'd back to the homepage on purpose (it overlaps too much with
`index.html` to want both showing up in search), which has no effect on
paid traffic — only on organic crawling.

**Automatic spend pulls from Meta (optional).** If you're running Meta
(Facebook/Instagram) ads and don't want to log spend by hand every day:

1. Create an app at [developers.facebook.com](https://developers.facebook.com/)
   and add the Marketing API product to it.
2. In your Meta Business Settings, add a **System User**, and generate an
   access token for it scoped to **`ads_read`** only — this app never
   needs `ads_management` since it only ever reads spend, never changes a
   campaign.
3. Find your ad account ID in Meta Ads Manager's URL — it looks like
   `act_1234567890` (include the `act_` prefix).
4. Put both in `.env` as `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID`.
5. Name your campaign in the admin panel **exactly the same as** the real
   campaign's name in Meta Ads Manager (case doesn't matter, exact text
   does) — that's how a campaign gets linked the first time. After that,
   it's remembered by Meta's own campaign ID, so renaming it in Meta later
   won't break the link.

Once connected, spend is pulled once a day (see `/api/cron/daily`), or any
time via the "Sync from Meta now" button. **This is read-only, on
purpose** — nothing in `metaAds.js` can pause a campaign, change its
budget, or spend a dollar on your behalf, even with these keys set. If a
campaign's all-time ROAS drops under `ROAS_ALERT_THRESHOLD` (default
2.0x), you get a plain alert email at `ADMIN_EMAIL` — you decide what to
do about it in Meta's own dashboard.

## 12. Publishing a blog post

The blog at `/blog` exists to bring in organic search traffic that has
nothing to do with anyone already knowing this site exists, and to give
Amazon Associates links somewhere honest to live. It is deliberately the
simplest thing that could work: **a post is a Markdown file, and publishing
is a commit.** No database table, no admin screen, no CMS to keep patched.

### Add a post

1. Create `content/blog/your-post-slug.md`. **The filename is the URL** —
   `cat-enrichment.md` is served at `/blog/cat-enrichment`. Use lowercase
   letters, numbers and hyphens only; anything else won't be found (see
   `SLUG_RE` in `blog.js`).
2. Open it with a front-matter block, then write the body in Markdown:

   ```markdown
   ---
   title: "The Bored Cat Problem: Why Enrichment, Catios, and Play Matter"
   description: "One or two sentences. This is the <meta name=description>, the Open Graph description, the card blurb on /blog, and the RSS summary — write it for a human scanning search results."
   date: 2026-09-24
   image: /uploads/some-cat.jpg
   imageAlt: A tabby mid-pounce on a feather wand toy
   draft: false
   ---

   Body copy starts here.
   ```

   | Field | Required | Notes |
   | --- | --- | --- |
   | `title` | yes | Quote it — almost every good title contains a colon, and the front-matter parser splits on the first one. |
   | `description` | yes | Used in four places (above). Don't skip it. |
   | `date` | yes | `YYYY-MM-DD`. Drives sort order, the displayed date, `datePublished`, the RSS `pubDate`, and sitemap `lastmod`. Parsed and displayed as UTC so a post never shows yesterday's date. |
   | `image` | no | Absolute URL, or a site-relative path like `/uploads/x.jpg`. Becomes the card photo, the lead image, and the Open Graph / Twitter card image. |
   | `imageAlt` | no | Alt text for the above. Falls back to the title, but write a real one. |
   | `draft` | no | `true` keeps it out of `/blog`, the RSS feed and `sitemap.xml`, and marks the page `noindex, nofollow`. The URL still works, so that's how you preview — see below. |

   The parser handles a deliberately small subset of YAML: one `key: value`
   per line, optionally quoted. No lists, no nesting, no multi-line values.
   Use `'single quotes'` if the value itself contains a double quote.

3. Restart isn't needed locally — posts are cached per file mtime, so saving
   the `.md` and refreshing is enough.
4. Commit the file. That's the publish.

### Amazon links are handled for you

Write a plain Markdown link to Amazon and `blog.js` does the rest:

```markdown
[Da Bird](https://www.amazon.com/s?k=da+bird+cat+toy)
```

- `rel="sponsored nofollow noopener"` and `target="_blank"` are added —
  what the Associates operating agreement and Google's link-spam guidance
  both want on a monetized link.
- `?tag=` is appended from `AMAZON_ASSOCIATE_TAG` in `.env`, unless the URL
  already carries a `tag` param. Unset means untagged links (no commission)
  rather than broken ones — which is the correct state until your
  Associates application is actually approved.
- **Any post containing at least one Amazon link automatically renders the
  Associates/FTC disclosure** above the body, before the first link. That
  flag is derived from the rendered links themselves, not from a front-matter
  field, so it can't drift out of sync with reality — which is the entire
  point. The FTC's endorsement guides want disclosure "clear and
  conspicuous"; don't restyle `.blog-disclosure` into fine print, and don't
  add a way to turn it off.

Prefer Amazon **search** URLs (`/s?k=...`) over specific ASINs for anything
you haven't personally bought. A search link can't rot into a dead listing
or silently become a different product under the same ASIN, and it can't
make you look like you're recommending a listing you never saw.

### The call to action is fixed, on purpose

Every post ends with the same CTA — "Enter your cat free" → `/#enter`, and
"or put them on a mug" → `/#shop-custom` (`POST_CTA` in `blog.js`). One CTA,
same place every time, because both halves are true of every post regardless
of subject, and because a reader who has to choose between five calls to
action takes none of them. Change it in that one constant if you must; don't
start hand-rolling a different one per post.

### Previewing a draft

Set `draft: true` and open `/blog/your-post-slug` directly. It renders with a
draft banner and `noindex, nofollow`, and stays out of the index, the feed
and the sitemap. Flip to `draft: false` (or delete the line) to publish.

### What updates itself

- `/blog` — index, newest first.
- `/blog/feed.xml` — RSS 2.0, with full post HTML in `content:encoded`.
- `/sitemap.xml` — the blog index plus every published post, with `lastmod`
  (see `blog.sitemapEntries` in `server.js`).
- `BlogPosting` JSON-LD, canonical URL, and Open Graph / Twitter tags on
  every post page.

### Two things that will bite you

- **`vercel.json` must keep its `includeFiles` entry.** Vercel's bundler
  finds files by tracing `require` calls, and reading a directory at runtime
  isn't a `require` — without
  `"config": { "includeFiles": ["content/**"] }` on the `server.js` build,
  `content/blog/` silently doesn't ship and the deployed blog is empty while
  it works perfectly on your machine.
- **Don't move the blog router below the DB middleware in `server.js`.** It's
  mounted above it deliberately so the blog (and the sitemap) keep serving
  when Postgres is down. Moving it costs you your whole indexable surface
  during an outage.
