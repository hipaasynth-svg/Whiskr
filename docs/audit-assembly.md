# Assembly + audit — cat contest/calendar product

Two uploaded pieces were assembled into this repo:

- `cat-calendar-app/` — a real, runnable Node/Express backend ("Whisker &
  Ribbon"): photo upload, SQLite storage, batches of 12, a multi-week voting
  window, Zoho SMTP result emails, Stripe checkout. This is the product to
  actually deploy.
- `prototypes/whisker-cup-landing.html` — a single-file, client-only demo
  ("The Whisker Cup") with a different visual design and a fully simulated
  (in-browser, non-persistent) version of the same mechanic. Kept as a design
  reference, not wired to the backend. It is not deployed anywhere and has
  no server of its own.

This document is the audit performed after assembling them: what was found,
what was fixed directly in code, and what's left as a product/legal decision
for whoever runs this business.

## Fixed in this pass

| # | Severity | Where | Issue | Fix |
|---|----------|-------|-------|-----|
| 1 | Critical | `public/calendar.html` | `cat.cat_name` and `cat.photo_path` (attacker-controlled at submission time) were interpolated into `innerHTML` unescaped — a stored XSS: submit a cat name like `<img src=x onerror=...>` and it executes for every visitor who opens that batch's calendar page. | Rebuilt the cell with `createElement`/`textContent`/`.src` instead of template-string `innerHTML`. Verified with a payload during manual testing — now renders as inert text. |
| 2 | Critical | `server.js` upload handling | The saved file's extension came from `file.originalname` (attacker-controlled), while the type check only looked at the client-supplied `Content-Type` header (also attacker-controlled). Send `Content-Type: image/png` with a file named `x.svg` containing `<script>`, and it lands in `/public/uploads/` served statically — a same-origin, browser-executable stored payload. | Extension is now derived from a fixed map of the four accepted MIME types, never from the filename, so the file `express.static` serves is always `.jpg/.png/.webp/.gif` regardless of what was uploaded. |
| 3 | High | `mailer.js` | `catName` was interpolated unescaped into HTML email bodies. Some webmail/desktop clients render HTML with enough fidelity (`onerror`, `onload` on inline images, etc.) that this is a plausible HTML-injection vector against your own entrants and yourself. | Escaped before interpolation into every HTML template; plaintext bodies were already safe. |
| 4 | High | `server.js` `/api/submissions` | No control-character stripping on `catName`. A name containing `\r\n` could inject extra header-like lines into outgoing plaintext email bodies/subjects. | Strip `\r\n` before storing. |
| 5 | High | `server.js` — legal/photo rights | The entry form let anyone submit a photo with no rights confirmation, yet the business's entire model is printing and selling that photo. The original README already flagged this as a launch blocker ("a real hidden pitfall if a submitted photo turns out to be scraped from someone else's Instagram"). | Added a required "I own this photo and grant a license to print and sell it" checkbox on the entry form; server now rejects submissions without it and stores a `photo_rights_consent_at` timestamp per submission (your evidence trail if a rights dispute ever comes up). |
| 6 | High | `mailer.js` — CAN-SPAM | Winner/featured emails contain a purchase pitch (making them "commercial email" under CAN-SPAM) but had no physical mailing address and no unsubscribe mechanism — both legally required in the US. | Added a `suppressions` table, a signed one-click `/api/unsubscribe` link included on every commercial email, and a `BUSINESS_MAILING_ADDRESS` env var surfaced in the footer. `sendMail` now checks the suppression list before every send. **You still need to put your real address in `.env` before sending real email — this only wires the mechanism.** |
| 7 | Medium | `server.js` `requireAdmin` | Plain `!==` string comparison of the admin key is a timing side-channel (small in practice for a low-traffic admin endpoint, but free to fix). | Switched to `crypto.timingSafeEqual` with a length check first. |
| 8 | Medium | `server.js` `/api/checkout` | Nothing checked that `groupId` referred to a real, *completed* group before creating a Stripe session — someone could pay for a calendar tied to a nonexistent or still-voting batch, which has no photos yet. | Checkout now 404s on an unknown group and rejects (400) a group that hasn't finished voting. |
| 9 | Medium | `mailer.js` reliability | Confirmed by reproduction: `nodemailer.createTransport` had no timeout configured, and result/confirmation emails are `await`-ed synchronously inside the request that seals a group or closes voting. With a slow or misconfigured SMTP host, that hangs the HTTP response to whichever real visitor happened to trigger the send — an email problem becomes a site-down problem. Reproduced locally: with placeholder Zoho credentials in `.env`, sealing a 2-cat group hung the request past 120 seconds before this fix. | Added a 10s `connectionTimeout`/`greetingTimeout`/`socketTimeout` to the transport, so a bad mail config now fails in ~10-20s instead of indefinitely. **Not fully solved** — see recommendations below. |
| 10 | Low | `server.js` `/api/submissions` | A validation failure (bad email, missing consent) after multer already saved the file left an orphaned file on disk. | Reject paths now unlink the uploaded file. |

All of the above were manually verified against a running instance (submission flow, consent rejection, XSS payload rendering as inert text, admin auth, checkout guard, unsubscribe round-trip) during this session, not just read for plausibility.

## Not fixed — needs a decision from you, not a code fix

These were flagged in the original build's own README, and remain true after assembly. Restating them here because they're launch blockers, not nice-to-haves:

- **"Simulated voting" is `Math.random()`.** There is no real public voting anywhere in the backend — `runDueVoting` scores every cat with `Math.random()` and picks the highest. The current landing copy ("the room votes," "Voted Cat of the Month by the last batch") describes a mechanism that does not exist. Shipping this copy as-is with random selection is a real FTC deceptive-advertising exposure, not a style nitpick — pick one:
  - Build actual public voting (a real, rate-limited/anti-bot vote endpoint + UI — the `prototypes/` demo shows the UI shape but its "voting" is also fake/client-only), or
  - Change the copy so it doesn't claim votes happen (e.g., "randomly featured," "selected by our monthly draw").
- **Print fulfillment is entirely unhandled.** Print-on-demand (thinner margin, zero inventory risk) vs. bulk printing (better margin, upfront cash + unsold-inventory risk) changes your unit economics more than anything else in this codebase. Decide before your first real batch closes.
- **Local disk storage for photos.** Fine at low volume; migrate `public/uploads` to S3/R2 before volume makes it a forced migration.
- **Affiliate links in `index.html` are real URLs but not tagged with your affiliate IDs** — you're sending free traffic to Chewy/Amazon/Litter-Robot right now with no revenue attribution. Swap in tracked links before driving any traffic.
- **GDPR** — if you'll ever have EU entrants, marketing-consent rules there are stricter and separate from CAN-SPAM; the unsubscribe mechanism added here is necessary but not sufficient for GDPR.
- Consult a lawyer on both of the above before real launch — none of this is legal advice.

## Recommended next (not done here — scope/architecture calls)

- Decouple email sending from the request path (background job/queue) so a slow SMTP provider can never again stall a user-facing response — the timeout in fix #9 bounds the damage but doesn't eliminate it.
- Consider magic-byte content sniffing on uploads (e.g. a `file-type`-style check) in addition to the MIME-type/extension fix in #2, for defense in depth against a spoofed `Content-Type`.
- `.env.example` ships syntactically-valid-looking placeholders (`sk_test_xxx`, `paste-the-16-char-app-password-here`, etc.) that read as "configured" to the app's own `if (process.env.X)` checks. Anyone who copies `.env.example` to `.env` without editing it will see the app *try* real Stripe/Zoho calls and fail with a confusing error instead of the intended "not configured yet" message. Not fixed here (would need placeholder-detection heuristics); worth a `README` callout at minimum.

## Update — 2026-09-04: judging, order tracking, and the Whiskr rebrand

The owner confirmed the public domain (**whiskr.lol**) and made the call on
the "fake voting" finding above: **a human judges each batch, not the
public.** Reasoning discussed and agreed: the core monetization (every one
of 12 cats gets a purchase offer regardless of who's on the cover) doesn't
depend on public voting; a judge avoids building anti-fraud/anti-bot
infrastructure a real voting feature would need; and it removes the FTC
deceptive-advertising exposure outright as long as the copy matches. The
trade-off accepted: losing "vote for my cat" as a free-traffic/virality
mechanic, which can be revisited later if growth needs it.

**Built this round:**
- Real judge-pick flow. `POST /api/admin/groups/:groupId/pick` lets the
  owner choose a batch's cover cat any time after it seals — no more
  waiting on a window. `GET /api/admin/groups/pending` lists what's waiting
  on a decision. `public/admin.html` is the actual screen for this (photo
  grid per batch, click to pick), gated by `ADMIN_KEY`, not linked from the
  public site.
- `Math.random()` demoted to a named safety net (`runDueJudging`, replacing
  `runDueVoting`): it only fires for a group whose judging deadline passed
  with no manual pick, so entrants are never left waiting forever. Optional
  `ADMIN_EMAIL` gets notified whenever that fallback fires — a signal to
  judge faster.
- All site copy and email copy changed from "voting"/"the room votes" to
  "judged"/"judging table" — the emails already said "judging table" before
  this pass, so this also fixes an inconsistency between what the emails
  implied and what the website copy claimed.
- **New finding, fixed**: there was no Stripe webhook. `/api/checkout`
  created an `orders` row as `'pending'` and nothing ever updated it —
  no reliable record of who actually paid or what to fulfill, which is a
  bigger operational gap than the voting-copy issue for actually running
  the business. Added `POST /api/webhooks/stripe` (raw-body route mounted
  before the global JSON parser, as Stripe's signature verification
  requires), listening for `checkout.session.completed` and marking the
  matching order `'paid'`. Added `GET /api/admin/orders?status=paid` (also
  surfaced in `admin.html`) so there's an actual fulfillment queue to look
  at. Requires `STRIPE_WEBHOOK_SECRET` to be set — the app logs a warning
  at startup if Stripe is configured but the webhook secret isn't.
- Rebrand from "Whisker & Ribbon" to **Whiskr** across the live app (page
  titles, header/footer, email templates, `package.json`, `.env.example`
  defaults) to match the domain. The `prototypes/` design reference was
  left as-is — it's not deployed, so it wasn't touched.

All of the above was exercised against a running instance: submitted
entries to seal two batches, manually picked a cover cat on one (confirming
the pick — not a random pick — became the winner), force-closed the second
to confirm the random-fallback path and the `ADMIN_EMAIL` notification both
fire correctly, confirmed a decided group can't be picked again, confirmed
`admin.html` serves and its endpoints reject a bad admin key, and confirmed
the webhook route responds correctly both unconfigured and with a request.
Full signature-verified Stripe webhook delivery (via `stripe listen`) was
not exercised in this sandbox — no live Stripe test keys available here.

**Still open** — the rest of the tiered punch list given to the owner in
chat, condensed here for the record:

*Blocking before charging anyone real money:* real `BUSINESS_MAILING_ADDRESS`
in `.env` (still a placeholder); Zoho domain verification (SPF/DKIM) on the
sending address; a print fulfillment vendor decision (print-on-demand vs.
bulk) — nothing here handles fulfillment yet.

*Should do before real traffic:* an actual Terms of Service, Privacy
Policy, and shipping/refund policy (none exist yet — the FTC Mail Order
Rule requires a stated ship time or delay notice); sales tax handling
(Stripe Tax is the easy path); affiliate links in `index.html` are live
URLs but not tagged with real affiliate IDs, so referred traffic currently
earns nothing; no rate-limiting on `/api/submissions`, so a script could
flood it with fake entries.

*Fine for now:* photos on local disk (migrate to S3/R2 as volume grows);
GDPR posture beyond CAN-SPAM if EU entrants show up; no CI on the repo yet.

## Update — 2026-09-04: evergreen print shop, verified reviews, refused fake reviews

The owner asked to turn this into an evergreen business: add print-on-demand
custom cat/dog products, expand affiliate links, and "make our reviews the
first thing people see." That last part needed a hard line drawn before any
building started.

**Refused, and will keep refusing: fabricated reviews.** There were zero
real orders at the time of this request, so "reviews first" as stated would
have meant inventing them. The FTC's 2024 rule on fake/deceptive reviews
(16 CFR Part 465) makes that illegal outright — not a gray area, not a
style nitpick, a specific federal rule with penalties. This is the same
category of problem as the fake-voting issue from the first audit, except
reviews are directly regulated where voting-copy was merely FTC-adjacent.
Put to the owner directly; they chose the honest path (see below) rather
than override it.

**Built instead — real reviews, verified purchase only:**
- A review can only be created by following a signed, HMAC-tokened link
  (`reviewLink.js`) tied to one specific paid order and email — emailed
  automatically `REVIEW_REQUEST_DELAY_DAYS` after the order is marked paid
  (`sendDueReviewRequests` in `server.js`, `sendReviewRequest` in
  `mailer.js`). There is no other code path that creates a review, no admin
  "add a review" button, no seed data.
- New reviews land unapproved (`reviews.approved = 0`); the owner moderates
  them in `admin.html` (approve/reject) before they're public.
- The homepage's reviews section is literally the first section after the
  hero (satisfying "reviews first" honestly) — with an explicit empty state
  ("we're brand new — no reviews yet") plus a defect/misprint reprint
  guarantee as the trust substitute until real reviews exist, rather than
  leaving the section looking broken or, worse, faking it.

**Built — evergreen custom print shop (Printful, dropship, no inventory):**
- `products.js` — a small catalog (mug, poster, canvas, phone case, tote,
  pillow), each mapped to a `printfulVariantId` that ships as a placeholder
  (`null`) — the owner has no live Printful account yet, so these can't be
  real until they create one and configure their actual catalog.
- `printful.js` — order submission only (no Mockup Generator integration;
  that's an async, task-based API needing a live account to verify against,
  so v1 just previews the customer's own uploaded photo instead of a real
  on-product mockup). Follows the same dry-run-if-unconfigured pattern as
  Stripe/Zoho elsewhere in this app.
- New `custom_orders` table, `POST /api/custom-orders` (upload + Stripe
  Checkout in one step), and Stripe-webhook wiring so a paid custom order
  automatically submits to Printful — with the order's status
  (`pending`/`paid`/`submitted_to_printful`/`failed`) visible in
  `admin.html` either way, so a Printful failure is loud, not silent.
- **New finding, fixed**: neither the pre-existing calendar checkout nor
  the new custom-order checkout ever collected a shipping address — you
  cannot ship a physical product without one. Added
  `shipping_address_collection` to both Stripe Checkout sessions and a
  `shipping_address` column to both `orders` and `custom_orders`, populated
  from Stripe's `shipping_details` in the webhook.
- Also while touching the webhook: switched both checkout flows to route by
  Stripe session `metadata` (`{orderType, orderId}`) instead of matching on
  `stripe_session_id` after the fact — cleaner now that the webhook has to
  route between two different order tables.

**Built — affiliate hub expansion:** added a parallel "For dogs" picks
section next to the existing cat picks (still real, untagged URLs — same
"add your affiliate ID before driving traffic" caveat as before).

**Site restructured storefront-first:** homepage order is now hero → reviews
→ custom-print shop → contest (how it works, current winner, calendar shop,
entry form) → affiliate picks → footer. The contest no longer gates the
site's usefulness — the print shop works every day, contest or not.

All of the above was exercised locally end to end: product catalog
endpoints (all/species-filtered), custom-order validation (missing
consent, invalid species, unknown product — each rejected with cleanup of
the uploaded file), a custom order reaching Stripe (failed only at the
external API call, using a fake key, confirming our own validation runs
first), manually marking that order paid and confirming a review token
verifies, a duplicate review submission being rejected by the DB's unique
constraint, an unapproved review being invisible on `GET /api/reviews` and
visible after admin approval, and the due-review-request cron path (tested
with `REVIEW_REQUEST_DELAY_DAYS=0`) sending the correct email and stamping
`review_requested_at`. Not exercised: an actual Printful order submission
or a real Printful mockup/variant lookup — no live Printful account exists
yet to test against.

**Still open**, in addition to the prior list: every `printfulVariantId`
in `products.js` needs the owner's real Printful catalog IDs before custom
orders can actually print; product pricing (`priceUsd`) needs checking
against Printful's real per-product base cost once that catalog exists; no
rate-limiting on `/api/custom-orders` either (same gap as `/api/submissions`).

## Update — 2026-09-05: swapped hosting target from Railway to Vercel

The go-live guide originally recommended Railway (this codebase's original
design — SQLite on local disk, an in-process `node-cron` scheduler, local
file uploads — runs on Railway completely unmodified, which was the whole
point of recommending it). The owner already runs seven other projects on
Vercel and didn't want an eighth project meaning an eighth dashboard to
learn. Reasonable trade: rearchitect the three subsystems that assumed an
always-on disk-backed server, so this deploys to the Vercel account they
already use instead.

**What changed:**
- **Database**: SQLite -> Postgres. `db.js` is now a thin `get`/`all`/`run`
  shim over the `pg` package (not the `@vercel/postgres` package, which
  Vercel has deprecated in favor of plain Postgres access against their
  Neon-backed offering) — this kept the rest of the app's call sites
  almost unchanged rather than a query-by-query rewrite. `?` placeholders
  are auto-converted to Postgres's `$1/$2` form. Every `INSERT` that
  needed the new row's id (better-sqlite3's `lastInsertRowid`) was changed
  to add `RETURNING id`. A `db.transaction()` helper (real
  `BEGIN`/`COMMIT`/`ROLLBACK` on a dedicated client) replaced
  better-sqlite3's synchronous transaction wrapper for the one place that
  needed atomicity (sealing a group: create it, assign N submissions to
  it). One genuine syntax difference required a manual fix, not just
  placeholder swapping: SQLite's `INSERT OR IGNORE` became Postgres's
  `INSERT ... ON CONFLICT (email) DO NOTHING` in the unsubscribe endpoint;
  and the reviews endpoint's duplicate-review check switched from matching
  on SQLite's error *message* to checking Postgres's error *code*
  (`23505`, unique_violation) — a message-string match would have silently
  never matched again and turned every duplicate review attempt into a
  bare 500.
- **File storage**: local disk -> Vercel Blob. `multer.diskStorage` became
  `multer.memoryStorage`, and a new `storePhoto()` helper in `server.js`
  uploads the buffer to Blob when `BLOB_READ_WRITE_TOKEN` is set. When it
  isn't (local development without a Blob store), it falls back to writing
  the buffer to `public/uploads` — real production deployments must set
  the token; the fallback exists purely so local dev doesn't require a
  Blob account just to hack on the app. This incidentally *simplified* the
  upload-validation code: buffered-in-memory uploads mean a validation
  failure has nothing on disk to clean up, so the old
  reject-with-file-cleanup pattern in both submission endpoints was
  removed rather than ported.
- **Background jobs**: `node-cron` (in-process timer) -> Vercel Cron.
  There is no long-lived process in a serverless deployment for a timer to
  run inside, so the daily judging-fallback + review-request check is now
  `GET /api/cron/daily`, invoked by the `crons` entry in the new
  `vercel.json`. Vercel signs its own cron requests with
  `Authorization: Bearer <CRON_SECRET>` when that env var is set, which is
  what the route checks to reject requests that aren't the real scheduled
  trigger.
- **Runtime shape**: `server.js` no longer calls `app.listen()`
  unconditionally — that's now wrapped in
  `if (require.main === module)` so `node server.js` / `npm start` still
  works locally, while `module.exports = app` is what Vercel actually
  invokes per-request in production. A new `app.use(async (req,res,next) => …)`
  middleware calls `db.initDb()` (idempotent — `CREATE TABLE IF NOT EXISTS`)
  before every request, since a serverless deployment has no equivalent of
  "run this once at startup before accepting traffic."
- `data/` (the old SQLite file's directory) was removed from the repo
  entirely — nothing writes there anymore.

**Verified against a real local Postgres instance** (not just read for
plausibility): full contest flow (seal a group inside a real transaction,
judge-pick a winner, reject a re-pick, random-fallback path via
force-close), custom-order validation and creation, the Stripe-failure
path still triggering only after our own validation passes, the review
flow end-to-end including the Postgres-specific duplicate-key error code
path, `/api/cron/daily` correctly rejecting no-auth and wrong-token
requests and succeeding with the right one, and `INSERT ... ON CONFLICT`
idempotency on repeated unsubscribe calls. Not verified: real Vercel Blob
uploads or a real Vercel Cron invocation — no live Vercel deployment exists
yet to test against; the local-disk fallback path was exercised instead,
which exercises the same `storePhoto()` call site.

**Pre-existing, unrelated to this migration, left alone**: `npm audit`
flags `nodemailer` (high) and `qs`/`express`'s transitive `qs` (moderate)
— both predate this session's work and are out of scope for a hosting
swap. `uuid`'s flagged advisory is about the `v3`/`v5`/`v6` functions when
called with a caller-supplied buffer; this app only calls `v4()` with no
buffer argument, so it doesn't apply to how `uuid` is actually used here.
Worth a real dependency-audit pass separately.

## Update — 2026-09-05: Stripe Tax turned on for both checkout flows

The owner asked to build out the Stripe side and named "Tax" as a needed
Stripe product. Both `checkout.sessions.create` calls (`/api/checkout` for
calendar orders, `/api/custom-orders` for the print shop) now pass
`automatic_tax: { enabled: true }`, and their `price_data` line items are
marked `tax_behavior: 'exclusive'` so Stripe Tax adds tax on top of the
listed price rather than trying to back it out of it. `shipping_address_collection`
was already present on both, which is what Stripe Tax needs to know where
to calculate tax for a physical good.

This only takes effect once Stripe Tax is turned on and a tax registration
exists for at least one jurisdiction (Settings -> Tax in the Stripe
dashboard) — until then Checkout runs exactly as before, at $0 tax. No
code path or database migration change was needed beyond the two edits
above; verified with `node --check server.js`.

**Also attempted and blocked, worth recording**: tried to connect this
session directly to Stripe's official MCP server (`mcp.stripe.com`) per
Stripe's own documented Claude Code setup flow, to generate an
implementation plan via `stripe_implementation_planner`. Two independent
blockers, both environmental rather than something in this repo:
this cloud session's outbound network policy returns a hard 403 for
`mcp.stripe.com` (confirmed via the agent proxy's own status endpoint),
and separately the OAuth login step requires an interactive browser popup
that a non-interactive remote session can't open even if the network
allowed it. Removed the resulting non-functional MCP config entry rather
than leave dead configuration behind. This should work fine from a local
Claude Code install (desktop or CLI on an actual computer, not this
hosted session) if the owner wants the planner tool later.

## Update — 2026-09-05: Statement descriptor for shared-account branding

While setting up Stripe locally, the owner confirmed Whiskr doesn't have
its own Stripe account — it, along with several other brands
(Codycarlson.art, DrinkMinot.com, EatMinot.com, Tessomancy), runs under
one umbrella entity (HipAAsynth LLC). Sharing one Stripe account across
unrelated brands is fine, but without any per-brand distinction, a Whiskr
customer's card statement would show the account's generic descriptor
with no indication the charge came from a pet-products purchase — a
real driver of "is this a scam?" chargebacks and disputes for a
brand-new storefront with no purchase history yet to reassure anyone.

Both `checkout.sessions.create` calls now pass
`payment_intent_data: { statement_descriptor_suffix: 'WHISKR' }`, so the
customer's statement reads `<account descriptor>* WHISKR` regardless of
which brand's default descriptor the shared account has configured.
This required no account changes and doesn't conflict with the
`automatic_tax`/`tax_behavior` fields added in the previous update.
Verified with `node --check server.js`.

## Update — 2026-09-07: affiliate picks swapped for real current bestsellers

The original affiliate hub (`index.html` "Gear we actually use") linked
generic category searches (e.g. "cat litter") with no real basis for
which product to actually name. Researched current Amazon best-seller
data (litter, treats, waste bags, harnesses, scratching posts) and
replaced the generic entries with named, currently-popular products:
Dr. Elsey's Unscented Clumping Litter, INABA Churu treats, a cat
scratching post, Earth Rated poop bags, and a no-pull dog harness —
kept as `/s?k=` search links (not single ASIN product pages) so a
specific listing going out of stock doesn't break the link or the
copy's honesty.

Also dropped the standalone Litter-Robot link (a third affiliate
program on top of Amazon Associates and Chewy) in favor of an
Amazon-native scratching-post pick — one fewer affiliate program to
sign up for and manage before launch, consistent with keeping the
owner's account/dashboard surface area small. **Still needs real
tagged affiliate URLs before launch** — these are plain, untagged
search links, same caveat as before.

## Update — 2026-09-08: stopped leaking the live entry count publicly

`GET /api/status` ran a raw `COUNT(*)` on real submissions and shipped it
straight to the public homepage as "X of 12 spots left." For a new,
low-traffic business, that's a permanent public sign reading "almost
nobody has entered" until 12 strangers actually show up — and it sat in
the raw JSON response even where the UI didn't render the number. Fixed:
`/api/status` now returns a coarse `fillStatus` enum
(`empty`/`filling`/`almost_full`/`sealed`) computed server-side; no exact
count leaves the server anymore. Shipped as
[PR #6](https://github.com/hipaasynth-svg/Whiskr/pull/6), merged.

## Update — 2026-09-08: contest-first redesign, real background slideshow, server-rendered indexing

The owner's read on the site as it stood: apologetic copy ("We're brand
new — no reviews yet"), decorative emoji in trust badges and transactional
email subjects, a print-shop-first homepage when the contest is the actual
funnel, a hero background pulling random placeholder cats from a third-party
service (cataas.com) with no way to swap in real photography, and a
product/contest catalog that only existed inside client-side JavaScript —
invisible to a crawler or AI assistant that doesn't execute it. All fixed
this pass, no code left half-done:

- **Copy**: removed every decorative emoji from the site (trust-row: 🔒 🖨️
  📬) and transactional emails (`mailer.js`: 🐾 🏆 📅 across entry
  confirmation, winner, and featured-cat emails). Rewrote the "brand new"
  reviews empty-state to state the reprint guarantee directly instead of
  apologizing for having no reviews yet. Rating stars (★/☆) and the
  verified-purchase checkmark (✓) were left alone — those are real UI
  glyphs, not decoration, confirmed by checking each match individually
  rather than blanket-stripping anything non-ASCII.
- **Homepage reordered contest-first**: hero → how it works → current
  winner → entry form → calendar shop → reviews → custom print shop →
  affiliate picks → footer (was: hero → reviews → print shop → how it
  works → current winner → calendar shop → entry form → picks). Nav and
  hero copy/CTAs reprioritized to match (primary CTA is now "Enter the
  free contest," not "Shop custom prints"). The print shop and its Stripe
  checkout are untouched — still evergreen, still works every day — just
  no longer first in the scroll.
- **Real, admin-controlled background slideshow**: new `background_slides`
  table (`db.js`), `GET /api/background` (public), `POST`/`DELETE
  /api/admin/background` (admin — reuses the existing `storePhoto()`/Blob
  pattern from contest/print-order uploads). Empty table = plain dark hero
  background, never a placeholder; the owner's own photos are what shows,
  and the slideshow only appears once at least one is uploaded. New
  "Background slideshow" section in `admin.html` (upload, thumbnail grid,
  remove). This follows the same shape as the background-slideshow feature
  in the owner's other site, `codycarlson.art` (`README.md`'s "Background
  slideshow" section, admin-managed photo slots, empty = fallback), cloned
  read-only into this session to confirm the pattern before building it here.
- **Server-side rendering for indexing** (`seo.js`, new): `/` and
  `/index.html` now run through a prerender step before `express.static`
  ever sees them — real contest status, the last winner's name/photo, the
  full product catalog (as both visible HTML cards and `Product`/`ItemList`
  JSON-LD), and any uploaded background photos are baked into the HTML
  response. `script.js` still runs and rebuilds the same containers from
  its own `fetch()` calls — same idempotent-rebuild pattern the reviews
  and product grids already used — so a real visitor sees no behavior
  change; a crawler that never runs JavaScript (or runs it badly) now sees
  the actual site instead of empty containers. `/calendar.html` gets the
  same treatment for per-batch `<title>`/OG/JSON-LD (`Product` schema,
  price, availability) keyed off `?group=N`. `/sitemap.xml` changed from a
  static one-URL file to a live route listing every *completed* contest
  batch, regenerated per request from the `groups` table — a new batch is
  discoverable the moment judging finishes, no redeploy needed. The static
  `public/sitemap.xml` file was deleted (the route now owns that path
  entirely; leaving the file would've been dead, confusing weight).
  `llms.txt` updated to match the contest-first framing and point AI
  agents at the JSON-LD instead of only the raw JSON endpoints. This
  mirrors `codycarlson.art`'s `api/home.js`/`api/sitemap.js` pattern
  (prerender the template, keep client JS as the same idempotent rebuild),
  adapted from that site's per-route Vercel functions to this app's single
  Express process.

**Bug caught and fixed during verification, not left for later**: the
first version of the prerender helper (`fillEmpty` in `seo.js`) only
injected content into elements that were already empty. `winnerName` and
`winnerBlurb` ship with non-empty placeholder text for the pre-judging
state ("Judging in progress" / "The current batch is still filling up...")
— so the regex silently no-opped on exactly the two fields most likely to
matter to a crawler. Caught by running a real end-to-end test, not by
inspection: fixed the regex to replace existing content generally, re-ran
the same test, confirmed the winner's real name/photo/blurb now appear in
the raw HTML response.

**Verified against a real local Postgres instance** (started locally in
this sandbox for the purpose, not left to "should work"): submitted 12
real entries via `POST /api/submissions` to seal a batch, confirmed
`fillStatus` transitions, judged the batch via
`POST /api/admin/groups/:id/pick`, confirmed the completed batch appeared
in `/sitemap.xml` and its `/calendar.html?group=N` carried the right
prerendered title/OG/JSON-LD, uploaded and deleted a real photo via the
new background-slide admin endpoints and confirmed the homepage hero
picked it up and dropped it, confirmed static assets (`style.css`,
`script.js`, `robots.txt`, `admin.html`) still serve correctly alongside
the new routes intercepting `/`, `/index.html`, `/calendar.html`, and
`/sitemap.xml`, and confirmed `node --check` passes on every changed file.

**Left open, not done here**: `calendar.html`'s photo grid itself is still
client-rendered only (the per-batch *meta tags* are server-rendered; the
visible 12-photo grid is not) — lower priority than the catalog/contest
content since individual contest photos are less likely to be a search or
shopping-agent target than the product catalog was. Background-slide
deletion removes the database row but doesn't delete the underlying Blob/
disk file — matches the precedent already set elsewhere in this codebase
(nothing else here does storage cleanup on delete either), but worth a
real cleanup job once slide churn is common enough to matter. No manual
reordering of background slides beyond upload order (oldest first) — fine
for a handful of photos, would want a drag-to-reorder control if the
owner uploads many.

## Update — 2026-09-08: reversed the judging decision — real public voting, built properly this time

The owner made a deliberate business call to reverse the "human judges, not
the public" decision from earlier in this document: open entry to hundreds
of cats per month, let the public actually vote, and use both the viral
reach of "share your link for votes" and a per-entrant final-placement
upsell ("you placed #47 — get a solo print") as the growth engine. This is
not the same mistake the app avoided last time: last time the problem was
`Math.random()` silently picking winners while the copy claimed "the room
votes" — a fabrication. **Real public voting, built with real anti-fraud
infrastructure and described honestly, was never the problem** — the two
things flagged then (FTC exposure from fake voting, and not wanting to
build anti-fraud/anti-bot infrastructure) are addressed here by building
the mechanism for real instead of avoiding it.

**Built:**
- **Open, continuous entry** replaces the seal-at-12 batch model.
  `contests` table: one open-entry period at a time (`CONTEST_LENGTH_DAYS`,
  default 30), auto-opens the next round the instant one closes so entry
  never hits a dead end. `submissions` gained `contest_id`, `vote_count`,
  `final_rank` (1..N for *every* entrant, not just winners — what makes
  "you placed #47" possible), `disqualified`/`disqualified_reason`.
- **Real voting** (`POST /api/vote`): a `votes` table with
  `UNIQUE(submission_id, voter_token)` is the actual enforcement of
  one-vote-per-cat, not just an application-level check. `voter_token` is a
  random value in a long-lived first-party cookie; IPs are never stored raw,
  only `sha256(salt + ip)`. Two independent rate limits (per voter identity,
  per IP hash, both configurable, default 30/day and 60/day) so clearing
  cookies alone doesn't bypass the IP limit and vice versa. Optional
  Cloudflare Turnstile CAPTCHA — skipped entirely (same
  dry-run-if-unconfigured pattern as Stripe/Printful/Zoho elsewhere in this
  app) until `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` are set, so voting
  works today without requiring the owner to set up a CAPTCHA account
  first. None of this makes vote-buying impossible — nothing free does —
  it's what keeps a casual bot or script from being trivial, same baseline
  real small contest operators run without full device fingerprinting.
- **Vote tallies are deliberately hidden from the public** while a round is
  open (`GET /api/contest/current` never includes vote counts) — this
  removes the "verify my paid votes worked" feedback loop vote-sellers rely
  on, and prevents early leaders from snowballing purely from visibility
  rather than real support. The share-driven virality mechanic the owner
  wants is fully intact: entrants get a personal share link
  (`vote.html?cat=ID`) the moment they enter, with Web Share API / clipboard
  fallback built in.
- **Contest close & tally** (`tallyAndCloseContest` in `server.js`): ranks
  every non-disqualified entrant by vote count (ties broken by earliest
  entry — deterministic, no coin flips to dispute), promotes the top
  `CONTEST_WINNERS_COUNT` (default 12) into a `groups` row so the *entire
  existing calendar/Stripe/checkout/PDF/email pipeline runs completely
  unchanged* for the shared-calendar product — only entry, voting, and
  per-entrant ranking are new subsystems. Every entrant gets emailed: #1
  gets the existing "Cat of the Month" email, #2-12 get the existing
  "featured" email, everyone else gets a new `sendFinalRankEmail` stating
  their real placement out of the real entry count, with a link to the
  existing custom print shop as the non-winner upsell (a bespoke
  rank-badge POD product template is future work, not built here — the
  upsell today is real and functional, just not custom-designed yet).
- **Admin fraud review** replaces the old manual judge-pick screen (there's
  nothing to manually pick anymore — the vote count decides): the current
  contest's entrants with vote-count and votes-in-the-last-hour side by
  side (a sudden spike is the signal a human should look at), and
  disqualify/requalify actions. This is explicitly *not* an ML fraud model
  — it's the number an operator needs to eyeball obvious abuse, same as any
  small real contest runs.
- **Official rules page** (`public/rules.html`, new): no-purchase-necessary
  language, eligibility, exactly how votes and winners are determined,
  disqualification policy, sponsor identification. This didn't exist before
  because there was no real contest requiring one; real public voting with
  an implied competitive outcome is a materially different legal shape than
  a business owner picking a favorite, and needed the paperwork to match.
- Retired the now-obsolete "spots left" homepage mechanic from the previous
  session (`fillStatus`: empty/filling/almost_full/sealed made sense for a
  batch that seals at exactly 12; it doesn't mean anything under continuous
  open entry) and replaced it with contest countdown copy. Applied the same
  principle as that session's original fix: at low entry counts, show
  "entries are open" with no number; only show the real entry count once it
  clears a threshold (25) where it reads as a real number, not a confession
  of low traffic — same reasoning, recalibrated to the new scale.
- Homepage, `llms.txt`, and both READMEs rewritten to describe the current
  mechanic accurately rather than left describing the retired one. The
  README's original "[RESOLVED] — winners are judged, not simulated-voted"
  note was kept, not deleted, with a note appended explaining the reversal
  — the historical record of why judging was chosen stays accurate for
  what it was at the time; deleting it would have made a real audit look
  like it never happened.

**Verified against a real local Postgres instance** (not just read for
plausibility): submitted multiple real entries into a fresh open contest,
cast real votes against them (including confirming the `UNIQUE` constraint
rejects a duplicate vote from the same voter-token, and that the per-voter
and per-IP daily rate limits correctly return 429 once exceeded), disabled
entries via the admin disqualify endpoint and confirmed a disqualified
entry can no longer be voted for or tallied, forced a contest close and
confirmed: every entrant received a `final_rank` (not just the winners), a
new `groups` row was created containing exactly the top
`CONTEST_WINNERS_COUNT` submissions with the #1 vote-getter as
`winner_submission_id`, the resulting calendar's existing
`/calendar.html?group=N` page rendered correctly unmodified, a new contest
auto-opened immediately after close, and the right email type (winner /
featured / final-rank) was dry-run-logged for the right entrants in the
right order. Confirmed `/api/contest/current` never includes a vote count
in its response at any point. Confirmed `node --check` passes on every
changed file.

**Left open, not done here**: no bespoke rank-badge POD product template
for the non-winner upsell yet — it points to the existing generic custom
print shop, which is real and functional but not custom-designed around a
cat's placement. `calendar.html`'s photo grid stays client-rendered (see
the previous entry — unchanged by this pass). Turnstile CAPTCHA needs the
owner's own Cloudflare account and site keys before it's actually active;
until then voting relies on the cookie + rate-limit layers alone.
Consult a lawyer on `rules.html` before relying on it at real scale — it's
a good-faith, standard-shape rules page, not legal advice, same caveat this
document has given on every other legal-adjacent item throughout.

## Update — 2026-09-08: monetization pass — refused paid votes, built the rest

The owner asked for a "gamified voting engine with automated POD
monetization" modeled on a spec that included paid vote bundles ($5-$30 for
extra votes toward the leaderboard), a Next.js/Supabase/Redis/S3 rewrite,
and a full Prodigi/Gelato PDF-compilation pipeline. Two decisions, put to
the owner directly before writing code:

**Refused: selling votes that affect the real contest outcome.** Charging
money for something that improves your odds of winning a prize is the
textbook definition of an illegal lottery in the states that regulate
"prize, chance, and consideration" (most of them) the moment a free
alternative method of entry doesn't fully neutralize the paid advantage —
and here it explicitly wouldn't, since the whole pitch was "buy votes to
climb the leaderboard faster." Separately, Stripe's own Prohibited and
Restricted Businesses policy covers gambling-adjacent mechanics, so this
also risked the account processing every other payment on this site. Put
to the owner as a choice (cosmetic-only paid boost, drop it entirely, or
build it anyway on record as a knowing decision); the owner chose to drop
paid votes entirely and keep voting 100% free, as already built.

**Declined the stack rewrite.** Next.js/Supabase/Redis/S3/Prodigi would
have thrown away the contest/voting/anti-fraud system built and verified
this same day, for infrastructure this app's actual scale (hundreds of
entries/month, not millions) doesn't need — Postgres handles the vote
concurrency fine, Vercel Blob already does what S3 would, and a second
stack is a second thing to operate. Extended the existing Express/Postgres
app instead, per the owner's choice.

**Built, from the legitimate parts of the spec:**
- **Image print-quality check** (`checkImageQuality` in `server.js`, via
  the new `sharp` dependency): reads real pixel dimensions on every contest
  entry and custom order, flags anything under `MIN_PRINT_DIMENSION_PX`
  (default 2000px either side) — but never blocks the submission. A
  business would rather sell a slightly soft print than lose the sale
  outright; the flag surfaces as a warning to the customer before checkout
  and as a column in `admin.html`'s order tables, not a hard rejection.
- **Post-entry discount, done honestly instead of the spec's "3D digital
  mockup."** This codebase already has a documented principle (see the
  main README's Printful setup section) against fabricating product
  mockups it can't actually render — a fake photoreal 3D calendar cover
  would have been worse than no mockup at all. Built instead: a real,
  honest preview (the entrant's own uploaded photo in a simple styled
  frame, CSS only, no fabricated rendering) plus a genuine time-limited
  discount (`CONTEST_DISCOUNT_PERCENT`, default 20%, `ENTRY_DISCOUNT_HOURS`
  window) on the existing evergreen print shop. The discount is a signed,
  expiring HMAC token (`discountToken.js`, same pattern as
  `reviewLink.js`/`unsubscribe.js`) verified server-side at checkout —
  never trusted from the link or the client's own math — and tied to the
  entrant's own email so it can't be redeemed by someone else who happens
  to see the link.
- **The same discount, reissued, in the final-placement email** for
  non-winners (`FINAL_RANK_DISCOUNT_HOURS`, a longer 72h window since it's
  the last-chance nudge) — this is the spec's "non-winner merch upsell,"
  now with a real incentive attached instead of just a bare link.
- **Fridge magnet** added to `products.js` — named explicitly in the spec's
  non-winner upsell list, wasn't in the catalog.
- **Rank-drop alerts, the free version** (`sendRankDropAlerts` in
  `server.js`, daily cron): the spec's "gamified urgency" mechanic (e.g.
  "Mittens just fell to #13") kept, but the call to action is "share your
  link" — never "buy votes to reclaim your spot," since that's exactly the
  mechanic refused above. Throttled by a new `last_notified_rank` column so
  an entrant isn't emailed every single day over normal rank noise — only
  when their live rank has worsened by `RANK_DROP_THRESHOLD` places (default
  5) or they've crossed out of the winner zone entirely, compared against
  their own last-alerted position.
- **Private "check my status" link** (`statusToken.js`, `/api/my-status`,
  `status.html`) — the safe version of the spec's "real-time leaderboard
  rendering." A public real-time leaderboard would undo last session's
  deliberate decision to hide vote tallies while a round is open (kills the
  "verify my bought votes worked" loop and stops early-leader snowballing);
  this instead lets each entrant privately check their own live rank or
  final result, token-gated so nobody can look up anyone else's. Sent in
  the entry-confirmation email alongside the vote/share link.

**Bugs caught during verification, not left for later** (three, all real,
none theoretical):
1. `low_resolution` was computed as a JS boolean and bound straight into an
   `INTEGER` column — SQLite would have coerced it silently; real Postgres
   rejected every submission with `invalid input syntax for type integer:
   "true"`. Fixed at the source (`checkImageQuality` now returns 0/1).
2. The custom-order discount was silently never applying: the HTML/email
   links and the client's hidden form field both use `discountExpires`,
   but the server destructured `discountExpiresAt` off `req.body` — always
   `undefined`, so `discountToken.verify()` always failed closed (safe
   failure mode, but a failure). Fixed the field name to match.
3. The discount links built in `mailer.js` put the query string *after*
   the `#shop-custom` hash fragment (`/#shop-custom?discountEmail=...`) —
   everything after `#` is the fragment, not the query string, so
   `location.search` on the landing page would never have seen these
   params at all. Fixed to `/?discountEmail=...#shop-custom` (query first,
   hash last).

**Verified against a real local Postgres instance**, same standard as
every other pass in this document: submitted a deliberately tiny (1×1px)
test image and confirmed `lowResolution: true` in the response before the
Postgres bug above was found and fixed, confirmed the entry-confirmation
email dry-run log carries the vote link, discount block, and status link
together, called `/api/my-status` with the issued token and got back a
correct live rank, submitted custom orders with no discount / a valid
discount / a wrong-email discount / an expired discount and confirmed via
direct DB query that only the valid case actually applied
`discount_percent = 20` and the reduced `amount_usd` (both other cases
correctly landed at `discount_percent = 0`, confirming verification fails
closed), force-closed a contest and confirmed the final-rank emails carry
a fresh 72-hour discount, and — for the rank-drop alerts — ran the check
once to establish a silent baseline (confirmed zero emails sent), cast
votes to deliberately push two entrants out of a 3-winner zone, ran the
check again, and confirmed exactly those two received "just fell to #N"
emails while an entrant who dropped only slightly (still inside the winner
zone) correctly received nothing. Confirmed `node --check` passes on every
changed file and a full repo-wide emoji grep stays clean.

**Left open, not done here**: no Prodigi/Gelato/automated-PDF-compilation
fulfillment pipeline for the shared 12-cat calendar — that's genuinely a
separate project (a calendar is a structurally different POD product, 12
image slots instead of one, and Printful's own calendar product would need
its own submission logic distinct from `printful.js`'s current
single-image path), scoped out rather than half-built, same as the
rank-badge merch template scoped out in the previous session. Real
Printful Mockup Generator integration (an actual photoreal product render,
not the honest CSS-framed preview built here) is still the README's
pre-existing "worth adding once verified" item, unchanged by this pass.
The discount is time-limited but not single-use — the same signed link
works for every order placed before it expires, a deliberate simplicity
choice, not an oversight.

## Update — 2026-09-09: real funnel audit against the live site, a new grand prize, and a deliberate reversal on decorative emoji

The owner sent live-site feedback (an external review of whiskr.lol) plus
two follow-up copy packages, and asked for the critical fixes and the
strongest funnel upgrades to actually be built — not just discussed. Every
claim was verified against the real code first, not taken at face value:

**Confirmed and fixed, real bugs:**
1. The "Gear we actually use" section had a literal dev note visible in
   production: "Replace these href values with your real, tagged affiliate
   URLs before launch — see README." Removed from the page; the
   instruction already lives in the README, so nothing was lost.
2. `loadProducts()` in `script.js` unconditionally blanked `#customGrid` to
   "Loading…" on every call, and to an error message on any fetch failure —
   overwriting the real product cards `renderProductCards` (see `seo.js`)
   already server-rendered into that exact container. A crawler was never
   actually affected (SSR already covers that), but every real visitor saw
   a flash, and a slow or failed fetch replaced good content with worse.
   Fixed to only touch the grid when it's still empty.
3. The homepage's "most recent winner" card showed a dead-end "Voting in
   progress… check back soon" for the entire length of the first-ever
   round (it only ever populates once a round has closed) — exactly the
   dead traffic the review flagged. Fixed without touching the hidden-vote-
   count principle from the previous session: added a small teaser of a
   few of the current round's real entries, random order, no vote counts
   and no ranking-by-vote (same rule the vote page already states), server-
   rendered (`renderEntryTeaser` in `seo.js`) and client-refreshed
   (`loadCurrentTeaser` in `script.js`) — social proof without reopening
   the exact fraud-verification/snowball loop that principle was built to
   close.

**Rejected as written, then built the honest version:** the review's own
draft leaderboard fix ("show the current top 3–5 vote-getters… with vote
counts") would have undone that same hidden-tally design outright. Built
the random, count-free teaser above instead.

**Rejected as written, not built at all:** the forwarded "full kit"
proposed daily/staged emails that state exact vote counts ("Fluffy has 0
votes," "leader has 87 votes"). This app already has a real urgency
mechanic for this — `sendRankDropAlerts`, which emails on a genuine rank
change or falling out of the winner zone, deliberately without a raw
count, for the same reason votes stay hidden publicly: a number lets
someone verify whether a fraud attempt "worked." Left that mechanic as-is
rather than adding a second, count-leaking one beside it. Also not built:
single-use discount codes, a calendar-buyer referral/friend-code system,
and non-entrant email capture — each is a real, reasonable roadmap item,
but a genuine new schema/infra piece, scoped out rather than half-built in
the same pass as everything else here.

**Built, real conversion loop:**
- Vote page: a persistent "have a cat? enter free" banner, and a one-time
  post-vote nudge to the entry form — the review's "biggest single bet."
- Entry form: a direct rules link next to the submit button (previously
  only reachable from the "how it works" section), and an anti-fraud line
  on the vote page ("votes are checked for abuse; suspicious activity is
  removed") next to the existing hidden-tally explanation.
- A real share-card image, not just a link: `generateShareCard` in
  `server.js` composites the entrant's own uploaded photo (via `sharp`,
  already a dependency) into a 1080×1080 image with their cat's name and
  the site's URL overlaid, generated once at entry time and stored the
  same way an uploaded photo is (Vercel Blob or local disk). Wired into
  the entry-confirmation email, the post-entry "Share for votes" button,
  and the vote page's existing Share button (Web Share Level 2's `files`
  API when the browser supports sharing an actual file, falling back to a
  link+text share, then clipboard) — the same asset reused in all three
  places. Caught and fixed one real defect before treating this as done:
  the first version put a 🗳️ emoji in the server-side SVG text, which
  rendered as a broken glyph box in a real generated image (verified by
  actually reading the output file, not just checking the response was
  200) — an emoji is only as good as whatever font happens to be installed
  wherever `sharp`/librsvg run, which server-side is not guaranteed the
  way a browser's emoji font is. Removed it; plain text renders correctly
  everywhere. **Still not proven**: this sandbox has a system sans-serif
  font installed, so SVG text rendering worked here — Vercel's serverless
  Node runtime does not ship fonts by default, and `sharp`'s SVG text
  support depends on librsvg/pango finding one. The very first real
  submission on the deployed site should be checked for whether the share
  card's text actually renders (vs. rendering blank) — if it doesn't,
  the fix is a bundled/embedded font, not a rewrite of this feature.

**New grand prize, and a deliberate reversal of the "no decorative emoji"
rule:** the owner asked for a real, physical prize — a one-of-a-kind cat
sculpture handmade by Cody Carlson (a fellow HipAAsynth LLC brand,
codycarlson.art) for the round's #1 vote-getter — plus a fun, bright,
big-font hero treatment to announce it. Because this changes what's
actually promised to a real winner, the prize was made accurate everywhere
it's legally load-bearing, not just on the homepage banner: `rules.html`'s
Prizes section now states it explicitly (no cash prize, no cash-equivalent
substitution, no purchase necessary still applies), and `sendWinnerEmail`
in `mailer.js` now tells the actual winner directly and asks them to reply
with a mailing address to claim it — otherwise this would have become
exactly the kind of gap between marketing copy and reality this codebase's
audits exist to catch. Flagging, not blocking: a physical prize of
non-trivial value can trip NY/FL/RI-style sweepstakes registration/bonding
thresholds depending on its actual value — a business decision for the
owner to make with real numbers, not a reason to withhold the copy change.
The fun/bright hero treatment (a new `Baloo 2` display font, bright
teal/pink/yellow accents, a 🏆 in the prize callout, a 🐾 placeholder
for the pre-first-round winner photo slot) is a deliberate, scoped
reversal of the earlier "removed every decorative emoji from the site"
decision (see the 2026-09-08 redesign entry above) for these two specific
new elements only — the rest of the site (nav, forms, reviews, footer)
keeps the calmer editorial palette and type unchanged. The repo-wide
emoji-grep check that gates every other pass in this log intentionally
does not stay clean after this one; that's the reversal, not a miss.

**Verified against a real local Postgres instance**: started the server
against `whiskr_dev`, confirmed `/api/status`'s existing-winner path still
renders `currentRibbon`/`winnerName`/`winnerBlurb` correctly (this repo's
dev DB already had a completed round from earlier sessions), confirmed the
teaser SQL query returns real random entries for an open contest,
submitted a real JPEG through `/api/submissions` end-to-end and confirmed
`shareImageUrl` came back non-null, confirmed the row's `share_image_path`
column was set, and — critically — read the actual generated JPEG back as
an image rather than just checking the file existed, which is what caught
the broken-emoji defect above. Confirmed `node --check` passes on every
changed JS file and the new/edited HTML files have balanced tags.

## Update — 2026-09-09: sculpture prize moved from monthly to annual, Cat of the Year added

Follow-up from the owner after the pass above: the wooden sculpture prize
(handmade by Cody Carlson, confirmed valued under $5,000 — so no NY/FL/RI
sweepstakes registration/bonding threshold is actually tripped, which the
previous pass had flagged as a real risk to check) should be the prize for
a new annual **Cat of the Year** award, not something promised every
single month. That's also the operationally sane call independent of the
legal question: commissioning a unique wooden sculpture every month for
every monthly winner isn't a sustainable prize to fulfill; once a year is.

**Built, a real second contest mechanic, not a copy-paste of the first:**
Cat of the Year is a separate, admin-opened public vote among that year's
monthly Cat of the Month winners (auto-populated from `groups` — no
nomination step, every eligible winner is automatically a finalist),
living in its own tables (`year_awards`, `year_award_finalists`,
`year_award_votes`) rather than reusing the monthly `contests`/`votes`
tables, because the actual voting rule is different: **one ballot per
person for the whole award**, not repeatable daily voting over a 30-day
window — enforced with `UNIQUE(year_award_id, voter_token)`, not
`UNIQUE(finalist_id, voter_token)`, so a voter can't pick a favorite, get
told "already voted," and just pick a second favorite instead. Verified
this distinction actually holds by testing both cases directly: voting
twice for the same finalist fails, and voting for a *different* finalist
with the same voter cookie also fails.

Deliberately admin-triggered on both ends (`/api/admin/year-award/open`
and `/force-close`), never cron-automated — crowning Cat of the Year is a
once-a-year, deliberate moment the operator should choose (and review the
auto-populated finalist list for) rather than something that fires
unattended on a schedule the way the monthly contest does.

**Reverted the previous pass's monthly winner email and Prizes-page
copy** — both had (correctly, at the time) promised the sculpture to every
Cat of the Month, which is exactly the promise this update replaces.
`sendWinnerEmail` no longer mentions a sculpture at all, only that the
winner is "now in the running for Cat of the Year"; a new
`sendCatOfYearEmail` carries the actual grand-prize notification and
fulfillment ask (reply with a mailing address) once an award closes.
`rules.html`'s Prizes section now states both tiers explicitly, including
the under-$5,000 value cap and a plain description of the one-ballot
voting rule, and a new "Cat of the Year" section explains it has no
separate entry/nomination step.

**New public surface**: `year-award.html` (mirrors `vote.html`'s look,
different voting rule as above) and a homepage banner
(`#yearAwardBanner`) that only renders anything while an award is
actually open — most of the year `/api/year-award/current` returns
`{award: null}` and the banner stays hidden/empty, same "never show a
fake/empty state" rule this app has followed everywhere else. Added to
`sitemap.xml` alongside the other static pages.

**Verified against a real local Postgres instance**, using this repo's
existing completed-round test data (three prior contest winners already
in the dev DB from earlier sessions — no fixtures needed): opened a year
award via the admin endpoint and confirmed it auto-populated exactly those
three as finalists; confirmed the public endpoint returns finalists with
no vote counts; cast a vote and confirmed both anti-double-vote cases
above; confirmed the admin view shows real per-finalist vote counts;
force-closed the award and confirmed it crowned the actual highest-vote
finalist, sent the Cat of the Year email with the correct sculpture
deadline text, and that `/api/year-award/current` correctly goes back to
`{award: null}` once completed; separately force-closed a live monthly
contest and confirmed its winner email no longer mentions a sculpture, to
catch a regression on the reverted copy rather than assume it. A stray
backtick inside a SQL comment inside `db.js`'s DDL template literal (fine
as a comment, but backticks close a JS template string wherever they
appear) broke `node --check db.js` immediately — caught and fixed before
any of the above testing, not after.

**Left open, not done here**: the marketing/ad-spend/ROAS tracking layer
from the original Sentinel plan the owner referenced — that's a distinct
follow-up pass, not folded into this one.

## Update — 2026-09-09: lightweight marketing/ROAS ledger, no live ad-platform automation

The follow-up promised above. The owner's original "Sentinel" plan (a
different, earlier project — a youth-sports nomination funnel, not
Whiskr) called for a Python engine that logged ad spend/revenue, computed
ROAS per city/batch, and could auto-pause a live Meta ad campaign below a
2.0x ROAS threshold. Asked the owner how much of that to build for
Whiskr; they chose the lightweight option: a real ledger inside this same
Node/Postgres app, no live ad-platform API integration — nothing here can
touch a real ad campaign. The other two options on the table (full live
Meta auto-pause automation, or a separate Python service per the original
spec) were both real, valid choices with a materially different risk
profile — live automation that can pause real ad spend is a financial-
automation surface that deserves its own dedicated build-and-test pass
before being trusted unattended, and a second service is a second
codebase/deploy to maintain — so this was worth asking rather than
guessing.

**What "multiple" meant, clarified before building**: the owner's
original ask ("we should have multiple") was ambiguous across three real
readings — multiple prize winners per round, multiple simultaneous
contests (e.g. cats and dogs each running their own), or multiple
concurrent geo/ad-targeting batches (Sentinel's original per-city model).
Confirmed it was the third. `ad_campaigns.name` is a free-text label (not
an enum), so any number of concurrently-tracked named campaigns/geos are
already supported without further schema changes.

**Built**: `ad_campaigns` (name/platform/status/notes) and
`ad_spend_entries` (manually logged date+amount per campaign) — genuinely
manual, matching a real ad platform's own dashboard rather than pretending
to pull live numbers this app has no connection to fetch. Revenue is real,
not estimated: a new `utm_campaign` column on `submissions`, `orders`, and
`custom_orders`, captured client-side from a `?utm_campaign=` link into a
first-touch-only cookie (never overwritten by a later organic visit, so
credit for the ad that actually brought someone in doesn't get erased) and
sent along with every entry/order request. The admin ROAS view
(`/api/admin/marketing/campaigns`) sums real paid-order revenue matched
case-insensitively against each campaign's name — verified this
specifically, not assumed: attributed a submission tagged `DALLAS-META`
and a simulated paid order tagged `Dallas-Meta` (deliberately mismatched
case) to a campaign named `dallas-meta`, confirmed both counted, and
confirmed a third paid order tagged with an unrelated campaign name
correctly did **not** count toward it. New admin.html section to add
campaigns, log spend, and pause/activate a campaign as a note-to-self (not
a live toggle — there is no live campaign on the other end of it).

**Verified against a real local Postgres instance**: created a campaign,
rejected a duplicate name cleanly, logged two spend entries and confirmed
their sum, submitted a real entry with a case-mismatched utm tag and
confirmed it stored correctly, simulated two paid orders (one matching the
campaign case-insensitively, one deliberately not) and confirmed the ROAS
math (`$200 revenue / $75 spend = 2.67x`) only counted the matching one,
confirmed the spend-history and status-toggle endpoints, and screenshotted
the admin panel with Playwright to confirm it actually renders the real
numbers, not just that the API returns them. Caught the same class of bug
as the previous update before any of this: a stray backtick inside a new
SQL comment in `db.js`'s DDL template literal broke `node --check`
immediately — checked for it explicitly this time (`grep` inside the
template-literal boundaries) given it had just bitten this exact file.
`node --check` passes on every changed file; new/edited HTML files have
balanced tags.

## Update — 2026-09-09: automatic (read-only) spend pulls from Meta, plus a real ROAS alert

The owner came back after the lightweight ledger above: they wanted the
"automatic self-funding version, just without auto-pause," not the manual
one. That phrase bundles two different asks with two different risk
profiles, so before writing code: (1) confirmed no Meta Marketing API
token/ad account exists yet — a hard prerequisite, since this can't be
tested or work at all without one, the same way Stripe/Printful/Zoho
don't work here without their own real keys; (2) asked which part should
actually be automatic, since "self-funding" is the half that moves real
money — automatically *reading* spend and computing ROAS is safe (nothing
but a GET request to Meta), automatically *writing* budget increases to
reinvest profit is a live financial-automation surface with its own risk
profile regardless of the auto-pause question. The owner chose read-only:
automatic spend pulls, automatic ROAS math, no automatic budget changes of
any kind; and for a below-threshold campaign, an alert email instead of
the auto-pause they'd already ruled out.

**Built**: `metaAds.js`, a new integration module following the exact
`printful.js`/Stripe dry-run pattern already established in this app — if
`META_ACCESS_TOKEN`/`META_AD_ACCOUNT_ID` aren't set, every call returns a
dry-run result and the manual ledger from the previous update keeps
working exactly as before. It can only ever read (`ads_read` is the only
permission the README setup instructions ask for) — there is no function
in this module that can create, pause, or resize a campaign, and there
won't be without a separate, explicit decision to add one.

A daily sync (`syncMetaAdSpend`, wired into the existing `/api/cron/daily`
alongside contest-closing and review requests, plus a manual "Sync from
Meta now" admin button) links each `ad_campaigns` row to a real Meta
campaign by matching name the first time, remembers it by Meta's own
campaign id afterward (a later rename in Meta's UI doesn't break the
link), and upserts yesterday's real spend — safe to re-run any time
without double-counting, via a partial unique index on
`(campaign_id, spend_date) WHERE source = 'meta_api'` that only
constrains automatically-synced rows, leaving manual entries untouched.
`checkRoasAlerts` emails `ADMIN_EMAIL` (the same address already used for
Printful submission failures) when an active campaign's all-time ROAS
drops under `ROAS_ALERT_THRESHOLD` — never pausing or changing anything —
throttled by `last_roas_alert_at` so a campaign that stays bad doesn't
re-email every single day, and floored by `ROAS_ALERT_MIN_SPEND` so a
campaign with a few dollars of spend and one lucky order doesn't trigger
on noise.

**Deliberately isolated in the cron handler**: `syncMetaAdSpend` got its
own try/catch inside `/api/cron/daily`, separate from the existing steps
(contest closing, rank-drop alerts, review requests). Those don't touch a
third party and have run reliably; a Meta API hiccup — rate limit, an
expired token, a transient outage — is a new and comparatively likely
failure mode this pass introduces, and it should never block the
unrelated, more reliable steps around it. Verified this isn't theoretical:
tested with a real (deliberately invalid) token against Meta's actual API,
got a genuine 403 back, confirmed the manual sync endpoint surfaces it as
a clean error rather than crashing, and confirmed `/api/cron/daily` still
returned `{ok: true}` and ran its other steps regardless.

**Verified**: unit-tested `metaAds.js` in isolation with a mocked `fetch`
(this sandbox has no real Meta credentials to test against) — correct
URL/query construction including the `time_range` JSON encoding, correct
`access_token` attachment, correct spend parsing, an empty insights
response correctly treated as zero spend rather than an error, and a 401
response correctly thrown with the status code in the message. Against
real local Postgres: confirmed the new columns/partial-unique-index
migrate cleanly, confirmed `metaConfigured` reports correctly in both
states, confirmed the existing manual-entry flow from the previous update
is unchanged (regression check), and confirmed the full ROAS-alert path
end to end — created a campaign with genuinely bad ROAS (real spend
logged, real revenue attributed via a simulated paid order, netting well
under threshold), ran the alert check, confirmed the email fired with
correct numbers, confirmed a second immediate run did **not** re-alert
(cooldown working), and confirmed `last_roas_alert_at` was actually
persisted on that exact campaign. `node --check` passes on every changed
and new file (checked for stray backticks inside `db.js`'s DDL template
literal a third time, on purpose, given the first two).

**Left open, not done here, on purpose**: any automatic write to a live ad
account — reinvestment, budget scaling, pausing — is out of scope until
the owner asks for it as its own explicit decision, not folded into "make
it automatic." Also not done: Google/TikTok/other ad platforms — this
integrates only Meta, per what was actually asked for; the same
`ad_campaigns.platform` free-text field and revenue-attribution logic
would support another platform's own read-only module later without
schema changes.

## Update — 2026-09-11: two sessions diverged on the same contest redesign; Cat of the Year prize swapped from sculpture to painting, cadence to monthly

A separate concurrent Claude Code session, working from a stale local
checkout that predated PRs #6–#16, spent this session building an entire
parallel, incompatible contest redesign (sealed batches of 40, a human
judge instead of public voting, a new bi-weekly hand-painted-original
prize) — none of which was aware that public voting, `CONTEST_WINNERS_COUNT`,
`RANK_DROP_THRESHOLD`, and the Cat of the Year sculpture award described
in that session's own task brief were already real, shipped features on
`main`. That work was closed unmerged (PR #17) once the divergence was
caught — worth recording here as a real process failure, not swept under
the rug: **always `git fetch origin` before concluding a described feature
doesn't exist**, especially when multiple sessions may be working the same
repo concurrently. Nothing under this update touches contest mechanics,
voting, or judging — those are exactly as the prior updates above left
them.

What the owner did want, confirmed directly: hide the homepage
calendar-purchase section for now (section kept intact, just `hidden` —
zero-cost to re-enable), and change the Cat of the Year grand prize from
a wooden sculpture to an **original 11x16 acrylic painting**, still
hand-painted by Cody Carlson, still free to the winner, still capped
well under the $5,000 sweepstakes-registration threshold (approximate
value used in `rules.html`: $160). The owner also wants this award to run
**roughly monthly instead of annually** going forward.

**Deliberately not restructured for the cadence change**: `/api/admin/year-award/open`
and `/force-close` were already fully admin-triggered with a free `label`
and a `[sinceDate, untilDate]` window — nothing in the code actually
enforced "once a year," that was purely how often the owner had been
opening one. So the cadence change is a copy/operational change, not a
schema or endpoint change: `year_awards`/`year_award_finalists`/
`year_award_votes`, the `sculpture_deadline` column, and the
`sculptureDeadline` variable/param names throughout `server.js`/`mailer.js`/
`admin.html` were all kept as-is for continuity with existing routes and
the sitemap — only user-facing copy changed (site pages, emails, rules,
`.env.example` comments) to say "painting"/"hand-painted" instead of
"sculpture"/"handmade," and "roughly monthly"/"recent winners" instead of
"once a year"/"that year's winners." Also fixed a pre-existing bug caught
in the process: `index.html`'s `<title>`/meta description wrongly credited
the grand prize to "Cat of the Month" instead of "Cat of the Year" —
corrected as part of this pass.

**Verified**: `node --check` on every changed file; ran the real app
locally against a fresh Postgres instance (confirmed schema/migrations
untouched and unaffected); confirmed via headless-browser screenshot that
the homepage renders correctly with the calendar section hidden, the nav
link removed, and no new console/page errors. Did not re-run the full
contest/voting/year-award test suite from the prior updates above, since
no code paths in those flows were touched — only string literals.

**Left open, not done here**: the `RANK_DROP_THRESHOLD`/final-placement
discount emails, the existing paid-but-unfulfilled-calendar-orders
question, and a heads-up email to entrants already in an open round about
any prize change are all pre-existing open items, unrelated to this pass,
not newly introduced by it.

## Update — 2026-09-11: collapsed monthly + Cat of the Year into one automatic win, calendar dropped from all copy

The owner asked for this made "super clear": every month the real public
vote picks a winner, and that winner directly gets an original acrylic
painting of their submitted photo — full stop, no calendar mentioned
anywhere (not ready to promote), no separate second vote first.

**What changed:** `tallyAndCloseContest` now calls a new `awardPainting`
the instant a round's #1 is decided — it inserts an already-`completed`
`year_awards` row (reusing that table/schema exactly as it was, just
skipping the `'open'` state) and sends one merged email
(`sendWinnerEmail`, rewritten) announcing both the win and the painting
together. There is no longer a second, separate "Cat of the Year" vote
among accumulated monthly winners — the round's own real vote already
decided it. Ranks 2+ all get the same `sendFinalRankEmail` now (no more
"featured" tier in between #1 and everyone else — `sendFeaturedEmail`
was deleted). Every "top 12 win the calendar" / "calendar cover" promise
was stripped from public copy (`index.html`, `vote.html`, `llms.txt`,
every mailer.js template) and from `rules.html`'s Prizes section, which
now states one prize, plainly.

**Deliberately not deleted:** `tallyAndCloseYearAward` and its
`/api/admin/year-award/open` + `/force-close` routes are dormant, not
removed — kept only as a manual-override path (e.g. to hand-correct a
past round) that nothing links to anymore. `year-award.html` is now
noindexed and unlinked (its own award will just never be open). The
homepage's `#yearAwardBanner` section and its `loadYearAwardBanner` JS
were removed outright rather than left dormant, since they did a live
fetch on every page load for a state (an open award) that can now never
occur — dead network traffic, not just dead markup. The homepage's
calendar-purchase section (already hidden in a prior pass) was deleted
outright for the same reason "no calendar to mention" applies to code as
much as prose; `calendar.html`, its Stripe checkout route, and
`/api/calendar/:groupId` are left completely alone as dormant
infrastructure — nothing currently links to them, but no reason to touch
working code that isn't part of what changed. Admin.html's "Cat of the
Year" section (open-a-vote form) was replaced with a read-only "Painting
winners" list backed by a new `GET /api/admin/year-award` endpoint, since
there's no longer anything to manually open.

**Verified against a real local Postgres instance**, not just read for
plausibility: submitted 3 entries, cast votes so a specific cat won 2-1,
force-closed the contest, and confirmed in the mailer log that the
winner got exactly one merged email ("Cat of the Month — you're getting
an original painting!") with no calendar language, the two non-winners
each got a real-placement + discount email with no calendar language,
`GET /api/admin/year-award` showed the win recorded automatically with
no manual step, `GET /api/year-award/current` correctly stayed
`{award: null}` (nothing ever opens), `/api/status`'s homepage "recent
winner" lookup still worked (unaffected — reads `groups`, not
`year_awards`), and `/sitemap.xml` no longer lists `year-award.html` or
per-round calendar pages. Screenshotted the homepage, rules.html, and
admin.html with Playwright to confirm the rendered copy, not just the
API responses. Caught and fixed one real bug in the process: a
duplicated `async function tallyAndCloseYearAward(yearAwardId) {` line
from an in-progress edit broke `node --check` before any of the above
testing — caught immediately, not after.

**Left open, not done here**: the small "Featured Originals" showcase +
commission-to-codycarlson.art CTA and the Cody Carlson partnership
copy upgrade are a separate, following pass — see the next update if one
exists above this line, or the current session if not.

## Update — 2026-09-11: featured-originals showcase + honest Cody Carlson partnership disclosure

Follow-up from the pass above. Owner's direction, confirmed directly:
no shop/checkout for original paintings on Whiskr — that stays on
codycarlson.art, where his own commission pricing and intake live.
Whiskr just shows "a couple to choose from" and drives commission
traffic out with a clear CTA, and the existing "hand-painted by Cody
Carlson" credit should read as an actual disclosed partnership rather
than an unexplained personal touch — which it in fact is, since Cody
Carlson is also the artist behind Whiskr itself (both HipAAsynth LLC
brands, same as the Sponsor disclosure this doc already carries).

**Built**: `featured_originals` (image_path, cat_name, position) mirrors
`background_slides` exactly — same admin upload/delete pattern, same
honest-empty-state rule (zero rows = "the first one's still drying,"
never a placeholder image), same server-rendered-then-client-idempotent
approach via a new `seo.renderOriginals` used both in `renderIndexHtml`
and `public/script.js`'s `originalsShowcase()`. New homepage section
(reusing the existing `.current-teaser`/`.teaser-card` grid styling
rather than inventing new CSS) sits right after "how it works," since
that's the moment someone's just learned about the prize and is the
strongest point to offer "don't want to wait — commission your own."
The CTA text states the HipAAsynth LLC affiliation plainly rather than
implying an arms-length partnership that doesn't exist — added the same
disclosure to `rules.html`'s Sponsor section (the formal document) and
to `llms.txt` for AI assistants summarizing the site. New public
`GET /api/originals` and admin `GET/POST/DELETE /api/admin/originals`
endpoints, all following the exact shape of the background-photo routes
they're modeled on. Admin.html's "Featured originals" section (upload +
grid + remove) mirrors "Background slideshow" line for line.

**Deliberately not built**: any purchase flow, pricing, or Printful
integration for the originals themselves — that was the owner's own
call to simplify, not a limitation worked around. Real photographed
mockups (the painting shown on a framed print, etc.) aren't possible yet
either, for the mundane reason that no painting has been made and
photographed — the empty state is honest about that rather than faking
a placeholder image, same principle this app has followed for reviews
and the background slideshow from day one.

**Verified against a real local Postgres instance**: confirmed
`GET /api/originals` returns `[]` on a fresh database and the homepage
renders the honest empty state with no console errors; uploaded a test
photo through the real `POST /api/admin/originals` endpoint and
confirmed it appears via both the public API and (server-rendered,
checked against raw HTML — not just what script.js draws) the homepage
itself, with the `hidden` attribute correctly removed from the grid and
added to the empty state; confirmed the admin.html upload form and
remove button work end to end; screenshotted both the empty and
populated homepage states and the new admin section with Playwright.
`node --check` passes on every changed JS file.

## Update — 2026-09-11: "HipAAsynth LLC" removed from all public-facing copy

The previous entry above added an explicit "Whiskr and Cody Carlson are
both HipAAsynth LLC brands" disclosure — on the homepage originals CTA,
in `rules.html`'s Sponsor section and Eligibility list, and in
`llms.txt` — reasoning it was the more cautious call on shared corporate
ownership between Whiskr and codycarlson.art. The owner overrode that:
they don't want HipAAsynth LLC named anywhere on the site, and consider
the common ownership between the two properties immaterial to disclose.
That's a legal/business call within the owner's judgment, not a case
this app's own reasoning treats as a hard violation if left unstated, so
it's implemented as asked rather than re-argued.

Removed every "HipAAsynth LLC" mention from public copy: the homepage
originals CTA, `rules.html` (Sponsor paragraph and the Eligibility
"employees of Whiskr/HipAAsynth LLC" line), and `llms.txt`. In each spot
the surrounding sentence was rewritten rather than just deleting the
clause, so the copy still reads as a deliberate, explicit partnership
("Whiskr has partnered with artist Cody Carlson...") instead of leaving
an awkward gap. Per this doc's own no-rewrite-history rule, the prior
entry above is left as-is — it accurately records what was built and why
at the time; this entry records the reversal rather than editing that
one.

Not touched: `cat-calendar-app/README.md`'s references to the
`hipaasynth-svg/Whiskr` GitHub repo path — that's the actual org/repo
name for deployment instructions, not a public-facing business-entity
disclosure, so it's out of scope here.
