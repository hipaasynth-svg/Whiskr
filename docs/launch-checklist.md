# Launch checklist

This file works through an outside audit, item by item. The audit was run
against an old branch (`claude/repo-audit-after-assembly-9pdeb9`, commit
`8faf2b5`, September), not `main`, so many of its findings were already fixed.
Each item below has been checked against `main` as of 2026-10-02.

Status key:

- **Done**: true on `main` today.
- **This PR**: fixed in the PR that adds this file.
- **Next**: agreed, and scheduled as its own follow-up PR.
- **Owner**: needs a decision or a setting from the owner.
- **Stale**: describes code that no longer exists.
- **Declined**: considered, with the reason given.

## Launch blockers

1. **Don't take money for prints that can't be made.** *(This PR)*
   - Stale part: the audit said every Printful variant id was `null`. They're all real now, including per-device phone cases and per-size sweatshirts.
   - Real part: with `PRINTFUL_API_KEY` unset, a paid order was "dry-run" submitted. It stayed `paid` forever, was never printed, and no alert fired. The same went for checkout without `STRIPE_WEBHOOK_SECRET`, where no order is ever marked paid.
   - Fix: print checkout now refuses (with a polite "opening soon") unless both are configured. Commission checkout requires the webhook secret. Local development can opt out with `ALLOW_UNFULFILLED_CHECKOUT=true`.
2. **Placeholder/ops copy on the homepage.** *(Stale)* The affiliate "picks" section with "Replace these href values…" was removed weeks ago. Affiliate links now live only in blog posts, which tag them and show the disclosure automatically.
3. **Legal and trust pages.** *(Done)* Terms, Privacy, Shipping & returns (production and delivery times, delay notice, damage and reprint policy, lost parcels, commissions), Official rules (eligibility, photo rights, 30-day claim) and the blog affiliate disclosure are all live and linked from every footer.
4. **Rate-limit public POSTs.** *(Done; one Owner item)*
   - Every limit is per connection:
     - Entries: 5 a day.
     - Print orders: 10 a day.
     - Commissions: 4 a day.
     - Newsletter signups: 10 a day.
     - Prize-claim lookups: 10 an hour.
     - Votes: per voter, per connection, and per cat for the round.
   - Uploads are capped at 8 MB.
   - Bot checks (Cloudflare Turnstile) work on voting once `TURNSTILE_*` keys are set. *(Owner: set them before running ads.)*
5. **Fail closed on compliance settings.** *(This PR; plus Owner)*
   - Promotional email now refuses to send unless `BUSINESS_MAILING_ADDRESS` is set. The placeholder text is gone.
   - `UNSUB_SECRET` still falls back to `ADMIN_KEY` instead of crashing the site. **Set it before launch.** Every signed link (status pages, prize claims, payment links, unsubscribes) is signed with whichever secret is active, so links already sent stop working when it changes.

## Code

- **Dependencies.** *(This PR)* `npm audit` showed 2 high-severity issues (nodemailer; sharp, which processes every uploaded photo) and 3 moderate (qs via Express, uuid). All upgraded.
- **Upload hardening.** *(This PR)*
  - Every uploaded photo is decoded and re-encoded. Anything that isn't really an image is rejected, orientation is corrected, and **all metadata is stripped**. Phone photos often carry the GPS location where they were taken, and contest entries are public.
  - Private storage for print photos: *Declined*. Printful has to fetch the file by URL to print it.
- **Admin exposure.** *(Done; partly Declined)* The admin API only accepts the key in a header (never in the URL), compares it in constant time, and locks out repeated failures. `admin.html` holds no secrets, so serving it publicly is harmless.
- **Email off the request path.** *(Stale; partly Declined)*
  - `maybeSealGroup`/`completeGroup` no longer exist. Result emails go out from the daily cron, not from a visitor's request.
  - The one inline send left is the entry confirmation, kept deliberately: on Vercel, work started after the response can be frozen and lost.
- **Stripe webhook coverage.** *(Done)*
  - Handled events: completed, async success, async failure, refund (full refunds only; partial refunds alert the admin) and dispute.
  - Idempotency comes from status-guarded updates.
  - `payment_intent.payment_failed` doesn't apply to Checkout.
  - Manual capture: *Declined* for now. The new checkout gate covers the real risk.
- **Data model** (timestamps, cents, foreign keys). *Declined for now.* A migration on a live database for no customer-visible gain. Revisit if reporting needs it.
- **Observability.** *(Next: daily admin digest)* Failure alerts already exist (failed Printful submissions, refunds, disputes, stalled parcels, prize passes) in admin and by email. The next PR adds a short daily summary email.

## Wording and trust

- **Contest terms.** *(Done; one Owner item)*
  - The audit's "judged, not voted" is stale: the contest is real public voting, and the rules, copy and emails all say so.
  - *Owner:* the rules say entry is open to residents of "the countries this site ships to", which is the US by default. Make that explicitly "the United States"? Recommended.
- **Placeholder cat photos (cataas.com).** *(Stale)* Removed. The site uses honest empty states, a real social preview image and favicon, and Product JSON-LD built from the real catalog.
- **Operational clarity near the buy button.** *(This PR)* A short line under the order form: printed to order by our print partner, ships in 2–5 business days plus delivery, tax and shipping shown at checkout, reprint guarantee. Each product page already says this.
- **Phone-model field.** *(Done)* Device picker with 52 real Printful variants.
- **No review schema until real reviews exist.** *(Done)* No AggregateRating markup is emitted.

## Features

6. **Printful sync.** *(Done in part; Next)*
   - Done: tracking, delivery polling, the shipment webhook, and a retry button for failed submissions.
   - Next: an admin "check costs" button. The server can reach Printful, so it can compare live costs and shipping to `orderEconomics.js` and flag anything under the margin floor.
7. **Mockups of the customer's photo on the product.** *Later.* Needs Printful's mockup API and real product photos first.
8. **Post-purchase.** *(Done in part; Next)*
   - Done: success banner, receipts (forced via `receipt_email`), shipping email with tracking, and the review request after delivery.
   - Next: an "order help" page to look up an order by email and report a problem with a photo.
9. **Contest growth loop.** *(Done)* Share link, share card image, referral attribution, rank-drop nudges, marketing opt-in, placement emails. (The "share my cat's calendar" idea is stale.)
10. **Calendar batch discovery.** *(Stale)* The calendar product has been removed.
11. **Merchandising.**
    - Discount codes: *Declined*. Prices sit at the 40% floor, so any discount sells below it.
    - Cart, gift note: *Later*, once there's order volume to justify a cart.
12. **Quality guardrails.**
    - Resolution warning and phone selector: *Done*.
    - Crop preview: *Later*.
    - Cat/dog detection: *Declined*. Admin can disqualify off-topic entries.
13. **SEO/AI.**
    - Done: `llms.txt` (with the live product list), Product JSON-LD, product pages, sitemap, noindex on private pages.
    - *This PR:* `security.txt`.
    - *Next:* FAQ structured data.

## What the owner needs to do

| What | Where | Why |
| --- | --- | --- |
| Set `PRINTFUL_API_KEY` and `STRIPE_WEBHOOK_SECRET` | Vercel → Settings → Environment Variables | Print checkout stays closed without them. |
| Set `UNSUB_SECRET` (a long random string) **before launch** | Vercel | Separates link signing from the admin password. Changing it later breaks links already sent. |
| Set `BUSINESS_MAILING_ADDRESS` | Vercel | Promotional emails won't send without it (CAN-SPAM). |
| Set `CRON_SECRET`, `IP_HASH_SALT`, `ADMIN_EMAIL` | Vercel | Locks the daily job, salts stored IP hashes, and gives alerts somewhere to go. |
| Set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Vercel (keys from Cloudflare) | Bot check on voting before ads run. |
| Decide: contest open to US residents only? | Reply in chat | Changes the rules page wording. |
| Switch the tote bag off in admin | /admin.html → Shop products | Printful won't quote shipping for it. |
| Upload product photos; submit the sitemap in Google Search Console | Admin; search.google.com/search-console | Google Shopping needs images. |
