# Whiskr audit and operating workflow, 2026-10-02

Audited against `main` at `1427393`. Scope:

- A full read of `server.js`, `mailer.js`, `db.js` and the token modules.
- A pass over `public/` for XSS.
- Automated checks.
- Read-only probes of the live site (whiskr.lol).
- A read-only look at the live Stripe account.

Vercel logs and env vars could not be read from here (403/404), so they're
covered under "check by hand" below.

## 1. What is healthy

- `node --check` passes on every `.js` file.
- `npm audit --omit=dev` reports 0 vulnerabilities.
- `node orderEconomics.js` passes: every product clears 40% in both the SMALL
  and FREE cases, and the safe discount is 0%.
- Live endpoints are all 200: `/`, `/shop`, `/vote.html`, `/rules.html`,
  `/healthz`, `/sitemap.xml` and `security.txt`. `/calendar.html` is 410,
  unknown paths are 404, and `/api/cron/daily` is 401, so `CRON_SECRET` is set.
- HSTS is on.
- These are set in production: Turnstile, `BUSINESS_MAILING_ADDRESS`, Blob
  storage and a Stripe webhook. The webhook subscribes exactly the five events
  the code handles.
- Stripe Tax is active, with a North Dakota registration.
- Money paths are sound:
  - Prices are computed server-side.
  - Every webhook state change is guarded by status.
  - Webhook signatures are verified.
  - Admin auth uses a constant-time compare.
  - Signed links are HMAC-signed with per-purpose prefixes.
  - Uploads are re-encoded and their EXIF/GPS data stripped.
- Customer text is escaped everywhere it reaches HTML: admin panels, emails,
  share cards and server-rendered pages. No XSS found.
- No fabricated reviews, no stock imagery, no discounting. The `reviews`
  table is empty, which is correct.

## 2. Findings, ranked

Severity: **P0** = fix before spending on traffic. **P1** = fix this month.
**P2** = fix when convenient or when scale makes it matter.

### P0: business and legal exposure

1. **Whiskr shares a Stripe account with codycarlson.art.**
   - The live checkout shows the brand name **"Codycarlson.art"**, not
     Whiskr.
   - A customer who bought a "Whiskr" mug and sees a different name on the
     payment page and on their card statement is the classic source of
     "I don't recognize this charge" disputes.
   - Disputes and Stripe risk reviews are counted per account. A dispute
     spike or a freeze on Whiskr would also take down the art site's
     payments, and the reverse is true too.
   - The codycarlson.art webhook ("Auto-mark paintings Sold") receives every
     **Whiskr** `checkout.session.completed` too. If that handler marks a
     painting sold by a metadata id without checking `orderType`, Whiskr
     order #1 could mark painting #1 sold. **Check that handler.**
   - Fix: open a second Stripe account for Whiskr (Dashboard → account
     switcher → New account, same login). Then move `STRIPE_SECRET_KEY`,
     `STRIPE_WEBHOOK_SECRET` and Stripe Tax over. Until then, at minimum set
     the public business name and statement descriptor to read as Whiskr.
2. **Klarna (and possibly other wallets) can sell below the 40% floor.**
   - The live payment-method configuration enables card, Klarna, Link,
     Cash App Pay and Amazon Pay.
   - `orderEconomics.js` assumes 2.9% + $0.30 for every order. Stripe's US
     Klarna fee is roughly double that (about 6% + $0.30; confirm on Stripe's
     pricing page).
   - That alone takes the sweatshirt (40.3%), canvas (40.5%) and pillow
     (41.0%) FREE cases under the floor on every Klarna order.
   - Fix: either turn Klarna off for Whiskr checkouts, or model the dearest
     enabled method in `orderEconomics.js` and reprice from the report.
     Turning it off is the cheaper option.
3. **The Stripe Tax fee is not in the margin model either.** Stripe Tax
   pay-as-you-go charges a per-transaction fee (0.5% where you are
   registered; confirm on your plan). The sweatshirt's FREE case is 40.3%, so
   0.5 points puts it under the floor. Fix: add the fee to `orderEconomics.js`
   and let the report say what clears.
4. **The live round contradicts the official rules.**
   - Round #1 is labelled "September 2026" and closes **October 9 at
     3:23 p.m. CT**. It was opened under the old 30-day logic.
   - `rules.html` says every round "runs for a calendar month and closes at
     11:59 p.m. Central Time on the last day of that month."
   - The site and emails show the true close date, but the official rules
     don't. That is the kind of copy/mechanism mismatch CLAUDE.md rule 2
     exists for.
   - Fix: add one transitional sentence to the rules naming round #1's real
     close. Don't move the close of a round that's already running. The next
     round will open October 9, be labelled "October 2026" and close
     October 31, so the mismatch ends there.
5. **No DMCA agent or takedown process.**
   - Contest photos are user uploads shown publicly. Without a registered
     DMCA agent (US Copyright Office, $6 online) and a takedown address in
     the Terms, Whiskr doesn't get safe-harbor protection when someone
     uploads a photo they don't own.
   - Fix: register the agent and add a "Copyright complaints" section to
     `terms.html`.

### P1: bugs that cost money or trust

6. **ROAS reporting counts almost no revenue.**
   - `checkRoasAlerts`, `/api/admin/marketing/campaigns` and the
     unmatched-UTM report sum `custom_orders WHERE status = 'paid'` (lines
     ~3325, 3368, 3459).
   - A successful order moves to `submitted_to_printful` within seconds, so
     real sales drop out of revenue.
   - Commission deposits and balances are never counted at all.
   - Result: the moment ads run, every campaign reads as close to 0x ROAS and
     the cron emails "under 2x ROAS" alerts that are false.
   - Fix: count every status that represents money taken (`paid`,
     `submitted_to_printful`, `failed`), excluding `pending`, `refunded` and
     `disputed`. Add commissions if they carry a UTM.
7. **A paid order can get stuck with no button to recover it.**
   - The Printful submit runs inside the Stripe webhook request.
   - If that function is killed after the order is marked `paid` but before
     the submit finishes (a timeout or cold-instance freeze), the order stays
     `paid`.
   - The retry endpoint only accepts `failed`. The daily digest does report
     "paid order(s) older than a day," but admin has no way to act on them.
   - Fix: let the retry button also take `paid` orders older than about
     30 minutes. Optionally, have the cron sweep them.
8. **One failure stops the whole daily cron.**
   - `runDueContestClose`, `passUnclaimedPrizes`, `sendRankDropAlerts` and
     `sendDueReviewRequests` run in sequence with no isolation.
   - A throw in the first one skips the rest, including the digest.
   - Contest close also sends every result email serially inside the one
     invocation, and `vercel.json` sets no `maxDuration`. A big round can hit
     the function's time limit partway through. The winner is handled first,
     so the remaining entrants just never get their placement email.
   - Fix: wrap each step on its own like the Meta and Printful steps already
     are, set `maxDuration`, and add a resend pass for `notified_result = 0`.
   - Meanwhile: **a missing daily digest email means the cron broke.**
     Treat it as an alarm.
9. **Most async routes have no error handling.** Roughly 50 `async`
   handlers, mostly GETs and admin routes, have no `try/catch`. Express 4
   doesn't forward a rejected promise to the error handler, so on a database
   blip those requests hang until the platform timeout instead of returning
   a clean 503. Fix: one `asyncHandler` wrapper, or upgrade to Express 5,
   which handles this natively.
10. **Email is sent through a personal Zoho Mail mailbox over SMTP.**
    - Zoho Mail has daily send caps and is meant for person-to-person mail.
      Round-close emails go to every entrant, plus rank-drop alerts, so one
      busy month can get the mailbox throttled or suspended. That mailbox is
      also the business inbox.
    - Promotional emails also lack `List-Unsubscribe` and
      `List-Unsubscribe-Post` headers, which Gmail and Yahoo require of bulk
      senders.
    - Fix: move automated mail to a transactional service (Zoho ZeptoMail,
      Postmark or Resend) on a subdomain with SPF, DKIM and DMARC, and add
      both headers to marketing sends.
11. **Vote limits can be dodged with IPv6.** `hashIp` hashes the full
    address. One IPv6 home connection controls a /64 and can rotate
    addresses freely, which resets the per-connection limits (60/day,
    3 per cat). Fix: hash the /64 prefix for IPv6.
12. **Unsubscribe happens on GET.** Corporate mail scanners (Outlook Safe
    Links and similar) follow links and can unsubscribe people silently.
    Fix: GET shows a confirm button, POST performs it. This pairs with the
    one-click header in #10.

### P2: hardening and scale

13. The response headers have no `Content-Security-Policy`,
    `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors` or
    `Referrer-Policy`. Add them in one middleware. `frame-ancestors 'none'`
    matters most for `/admin.html`.
14. The Postgres connection uses `ssl: { rejectUnauthorized: false }`, which
    accepts any certificate. If the provider's CA chain is available, verify
    it.
15. The signing secrets fall back to `ADMIN_KEY`, then to a hardcoded
    string. In production, refuse to start without `UNSUB_SECRET` instead of
    warning.
16. `/api/cron/daily` runs unauthenticated whenever `CRON_SECRET` is unset.
    It's set today, but the check should fail closed.
17. Missing indexes, which will matter at thousands of rows:
    - `submissions(contest_id)` and `submissions(ip_hash, created_at)`.
    - `custom_orders(ip_hash, created_at)`, `custom_orders(printful_order_id)`
      and `custom_orders(status)`.
    - `votes(referred_by_submission_id)`. The admin contest view runs a
      per-entry subquery on this one.
18. Every cold start re-runs all the DDL, including 46 `ALTER TABLE` lines.
    Each one takes a brief exclusive lock even when there's nothing to
    change. That's fine at today's traffic. Gate it behind a schema version
    row before traffic grows.
19. Uploads from abandoned checkouts stay in public Blob storage forever:
    `pending` orders, unpaid commission deposits and their photos. Add a
    monthly cleanup, and give `privacy.html` a concrete retention period
    instead of "kept as part of our normal records."
20. `robots.txt`: the named AI-bot groups each say `Allow: /` without the
    `Disallow: /admin.html` that `*` has. Bots that match a named group
    ignore the `*` rules. This is harmless (admin has no secrets) but
    inconsistent.
21. The Printful webhook does its sync after the response has been sent. On
    Vercel that work can be frozen, so the tracking email waits for the
    daily poll. Use `waitUntil` or sync before responding.

## 3. Live-site and business observations

- **Revenue to date is $0 from customers.** Stripe holds exactly one Whiskr
  checkout, the owner's own $24.99 test on Sept 12. The contest has 5
  entries.
- **Only 3 of 11 products are switched on:** mug $19.99, phone case $30.99,
  sweatshirt $57.99. The sweatshirt has no photo.
  - Every framed print and canvas, which are the high-ticket items, is off.
  - With this catalog, $79 free shipping is hard to reach, so nearly every
    order pays shipping. That's friction at checkout.
  - Switching back on the framed/canvas products that have real Printful
    quotes would raise average order value most.
- **The contest is a cost center until it converts.**
  - Each round gives away a $425-retail painting: Cody's time and materials
    plus crating and shipping.
  - Track one number per round: **revenue from that round's entrants and
    their referred voters ÷ cost of the prize**. A round with 5 entries
    can't pay for the painting.
  - Rules allow it, but consider a minimum-entries clause for future rounds,
    written into the rules *before* that round opens.
- **Prize tax:** a winner who gets $600+ in prizes in a calendar year needs
  a 1099-MISC, and you need their W-9 first. One $425 painting doesn't
  trigger it. The same cat winning twice in a year does.
- **Commissions have no shipping charge.** Crating and insuring an original
  is a real, unpriced cost on every booking. This is an owner pricing
  decision; it's flagged in the code comments too.
- **The business address published in every promotional email and the
  footer is a street address in Minot.** If it is a home, replace it with a
  PO box or a commercial mail receiving agency. CAN-SPAM accepts either.
- **Sales tax:** you are registered in ND only. Stripe Tax monitors other
  states' thresholds. Watch its alerts and register before you cross one.
- **The Meta pixel isn't configured** (`metaPixelId: null`). Ads would run
  blind. Set `META_PIXEL_ID` and `META_CAPI_ACCESS_TOKEN` before the first
  ad dollar, and fix #6 first so the ROAS numbers mean something.

## 4. Things to check by hand (not reachable from here)

- [ ] **Vercel → Logs:** filter level=error for the last 7 days. Anything
      from `/api/webhooks/stripe` or `[fatal]` is urgent.
- [ ] **Vercel → Settings → Environment Variables (Production):** confirm
      each of these is set:
      - `UNSUB_SECRET` (distinct from `ADMIN_KEY`), `IP_HASH_SALT`,
        `ADMIN_EMAIL`, `ADMIN_KEY` (long and random).
      - `PRINTFUL_API_KEY`, `PRINTFUL_WEBHOOK_TOKEN`.
      - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
      - `ZOHO_EMAIL`, `ZOHO_APP_PASSWORD`.
      - `PUBLIC_BASE_URL=https://whiskr.lol`.
- [ ] **Vercel → Settings → Functions:** note the max duration on your plan
      (it matters for #8).
- [ ] **codycarlson.art webhook handler:** confirm it ignores sessions
      whose `metadata.orderType` is a Whiskr type (#1).
- [ ] **Printful:** billing card on file and auto-confirm on. Confirm the
      tote is still switched off.
- [ ] **DNS:** SPF, DKIM and DMARC records for whiskr.lol. Run a test send
      through mail-tester.com.
- [ ] **Google Search Console:** sitemap submitted, no coverage errors.

## 5. Operating workflow

### A. Every day (5 minutes)

1. Read the **daily digest email** (cron, 09:00 UTC).
   - **No digest = the cron failed.** Check Vercel logs for `/api/cron/daily`
     before doing anything else.
2. Act on the digest's "Needs you" list, in this order:
   1. **Failed print orders:** open Admin → Custom orders and press Retry
      Printful. Check the alert text first, because a bad address will
      fail again.
   2. **Paid orders older than a day still not at Printful:** until #7 is
      fixed, there's no retry button for these. Check Printful for an order
      with external id `custom-<id>`. If none exists, submit it by hand in
      Printful.
   3. **Unresolved alerts:** read each one in Admin → Alerts, act, then
      resolve it. A refund, dispute or stalled parcel each has its own
      playbook in D below.
   4. **Reviews waiting:** approve every genuine review **whatever its
      star rating**. Reject only abuse, personal data or off-topic text.
      Hiding negative reviews is itself prohibited under 16 CFR 465.
   5. **Commissions waiting to be painted:** check each one against its
      promised date.
3. Answer contest@whiskr.lol within one business day.

### B. Every week (30 minutes)

4. **Admin → Contest:** sort by "Votes/hr." Anything at 20+/hr that isn't
   explained by a share you can see is a fraud review. Disqualify with a
   written reason, which the entrant sees on their status page.
5. **Stripe → Payments:** look for disputes and early fraud warnings.
   Respond to a dispute within 7 days, using the order's Printful tracking
   as evidence.
6. **Stripe → Balance:** check payouts arrived. Then reconcile them against
   Printful charges in a simple spreadsheet: revenue, Stripe fees, Printful
   cost, shipping and tax collected.
7. **Printful → Orders:** look for anything "on hold" (address problems,
   file problems) that never produced an alert.
8. **Vercel → Logs:** filter error-level logs for the week.
9. Post the vote link on your own socials. The contest only grows by being
   shared.

### C. Every month

10. **Round close (the 1st, via the 09:00 UTC cron):**
    - [ ] The digest shows the round closed and a winner.
    - [ ] The winner email went out. Admin → Painting winners shows a
          "Claim by" date.
    - [ ] Call or text the winner's phone the same day. The rules promise
          you'll try.
    - [ ] Every entrant got a placement email. Spot-check two.
    - [ ] A new round is open with the correct label.
11. **Claims:** when an address arrives, start the painting. The promise is
    6–8 weeks from the address. When it's done, upload the painting and a
    story in Admin → Winners page.
12. **Unclaimed prizes:** the cron passes them on automatically on day 30.
    Confirm the pass email reached you, then call the runner-up.
13. **Costs:** run a Printful price and shipping check from a machine that
    can reach Printful. Paste any changed number into `orderEconomics.js`,
    run `node orderEconomics.js`, and reprice anything it flags (CLAUDE.md
    → Prices). **Never guess a rate.**
14. **Dependencies:** run `npm audit --omit=dev` in `cat-calendar-app/`.
    Patch anything high or critical in its own PR.
15. **Round economics:** record entries, votes, entrant-to-buyer orders,
    revenue, and prize cost. Decide whether next month's prize, promotion
    and ad spend still make sense.
16. **Backups:** confirm your Postgres provider's point-in-time restore is
    on. Export `submissions`, `custom_orders`, `commissions` and
    `year_awards` to CSV and keep it off-platform.

### D. Event playbooks

17. **Refund.**
    - Issue it in Stripe. The webhook marks the order and alerts you.
    - If it already went to Printful, cancel it there too if it hasn't
      shipped.
    - A partial refund leaves the order status alone (by design).
18. **Dispute.**
    - Gather the Stripe receipt, the Printful tracking and delivery scan,
      and the customer's photo-rights consent timestamp.
    - Submit before Stripe's deadline. Never ignore one: losing costs the
      sale, the dispute fee and account standing.
19. **Stalled parcel alert.** File Printful's lost-in-transit claim the same
    day. Their window is 30 days past the estimated delivery. Then email the
    customer.
20. **Damaged or misprinted item.** Ask for a photo, then file it with
    Printful as a quality claim. They reprint at their cost when it's their
    defect. Reship promptly; the shipping page promises it.
21. **Copyright or photo complaint about a contest entry.** Disqualify and
    remove the entry, reply in writing, and keep the record. Once the DMCA
    agent is registered (#5), follow the takedown and counter-notice steps.
22. **Data deletion request.** Delete the person's rows and Blob photos
    within 30 days. Keep order records you need for tax: amount, date and
    state.
23. **Site down.** In order:
    1. Check `https://whiskr.lol/healthz`.
    2. Check Vercel status.
    3. Check the Postgres provider's status.
    4. If a deploy caused it, use Vercel → Deployments → previous →
       **Promote / Instant Rollback**. Fix forward afterwards.

### E. Before changing anything (code or settings)

24. Start from `main`. Run `git rev-list --count HEAD..origin/main`; it must
    print 0 (CLAUDE.md).
25. Price or cost change: run `node orderEconomics.js` and get exit 0.
26. Contest mechanics change: update the copy, `rules.html` and the emails
    in the same commit.
27. Schema change: use `IF NOT EXISTS` forms only, and test against a local
    Postgres.
28. Run `node --check` on every touched `.js` file. Open a PR and let Vercel
    build a preview. Click through the changed page on the preview URL
    before merging.
29. After merging, open the live page and run one end-to-end check of the
    touched flow:
    - Shop changes: a real $1-range test in Stripe test mode on the preview.
    - Contest changes: an entry and a vote.

### F. Before spending money on ads

30. Fix P0 #1–#3 and P1 #6. Set `META_PIXEL_ID` and
    `META_CAPI_ACCESS_TOKEN`.
31. Switch on, with photos, at least one product above $50 that has a real
    Printful shipping quote.
32. Start at a budget you'd be fine losing entirely ($10–20/day). Judge it
    on revenue per round against the prize's cost, not on entries alone.
33. Watch the per-cat vote velocity daily while ads run. Paid traffic
    attracts vote farms.

### G. Yearly, and at thresholds

34. **Taxes:**
    - Watch Stripe Tax's threshold alerts and register in a new state
      before crossing its threshold.
    - Collect a W-9 from any winner who reaches $600 in prizes in a year,
      and issue a 1099-MISC.
35. **Legal pages:** re-read the rules, terms, privacy and shipping pages
    against what the code actually does.
    - If you ever reach about 100,000 consumers' data or $25M in revenue,
      CCPA "sale/share" obligations apply to the Meta pixel. That means a
      "Do Not Sell or Share" link and honoring Global Privacy Control.
36. **Rotate secrets:** `ADMIN_KEY`, the Zoho app password, and the Stripe
    and Printful keys.
    - **Don't rotate `UNSUB_SECRET` casually.** It invalidates every claim,
      status, payment and unsubscribe link already in people's inboxes.
37. **Renewals:** keep a dated list of the domain renewal (whiskr.lol), the
    Vercel plan, the Postgres plan and the DMCA agent registration, which
    expires every 3 years.
