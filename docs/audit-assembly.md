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
