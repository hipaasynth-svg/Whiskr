# Whisker & Ribbon — cat contest + calendar shop

A real, runnable Node/Express site: entry form with photo upload, groups of
12 submissions, a multi-week voting window, simulated voting, Zoho Mail
result emails, and a Stripe-backed calendar shop with a multi-buy discount.

## What's actually here

- `server.js` — Express app: submission API, group-sealing logic, the daily
  cron job that closes voting and emails everyone, Stripe Checkout, admin
  endpoints for testing.
- `db.js` — SQLite (file-based, `data/contest.db`). No external database to
  stand up.
- `mailer.js` — sends through **Zoho Mail's SMTP**, not a third-party ESP.
- `public/` — the landing page, the per-batch calendar/checkout page, CSS, JS.

This is a stateful, always-on server (in-process cron + local SQLite + local
file uploads). It is **not** a fit for stateless serverless hosting
(Vercel/Netlify functions) as-is — see Deployment below.

## 1. Install

```bash
cd cat-calendar-app
npm install
cp .env.example .env
```

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

## 4. Run it

```bash
npm start
```
Visit `http://localhost:3000`. Submit 12 entries (any test email/photo) to
watch a group seal itself, then trigger voting without waiting three weeks:

```bash
curl -X POST http://localhost:3000/api/admin/run-voting -H "x-admin-key: <ADMIN_KEY from .env>"
```

That fires the same code path the daily cron job runs — it picks a winner
and sends the winner + "featured" emails for real (if Zoho is configured).

## 5. Deployment

This app needs a machine that stays running (for `node-cron`) and a
writable disk (for SQLite and uploaded photos). Good options, cheapest to
more involved:

- **Railway or Render** — attach a persistent volume for `/data` and
  `/public/uploads`, set the same env vars, `npm start`. Simplest path to
  a real, always-on deployment.
- **A small VPS** (Hetzner, DigitalOcean) — run behind `pm2` or a systemd
  service, put nginx or Caddy in front for TLS.
- **Vercel/Netlify functions** — would require rearchitecting: swap SQLite
  for a hosted database (Postgres/Turso), swap local file uploads for S3 or
  Cloudflare R2, and swap in-process cron for their scheduled-functions
  feature. Doable later once traffic justifies it; not worth the rewrite
  for a launch.

Point your real domain at whichever host you pick, and set
`PUBLIC_BASE_URL` in `.env` to that domain — it's used to build the links
inside result emails.

## 6. Before you actually launch — a few things worth fixing first

**[UPDATED] — CAN-SPAM basics: mechanism is wired, content isn't.** Every
commercial email you send in the US legally needs a working unsubscribe
mechanism and your business's physical mailing address in the footer. Both
now exist in `mailer.js` — a signed one-click unsubscribe link and a
`BUSINESS_MAILING_ADDRESS` footer line — but you still need to **put your
real mailing address in `.env`** before sending real result/offer emails.
I'm not a lawyer; confirm this against current FTC guidance or with counsel
before you go live, especially if you'll also be emailing EU entrants
(GDPR marketing-consent rules are stricter and separate from CAN-SPAM, and
this unsubscribe mechanism alone doesn't satisfy them).

**[UPDATED] — photo rights: now enforced.** The entry form now has a
required "I own this photo and grant Whisker & Ribbon a license to print
and sell it" checkbox, and the server rejects submissions without it and
stores a `photo_rights_consent_at` timestamp per submission. Still worth
having counsel confirm the checkbox language covers what you actually need
(e.g. minors in photos, background people/property) before scaling up.

**Business-model notes, not legal ones:**
- *"Simulated voting" is currently `Math.random()`.* That's fine as a
  placeholder, but if you ever market this as "the internet votes," make
  sure the copy on the site matches what's actually happening — false
  "X people voted" claims are an FTC/deceptive-advertising problem, not
  just a copy nitpick.
- *Every one of the 11 non-winners still gets a purchase offer.* That's the
  actual monetization engine here — 12 warm leads per batch instead of 1 —
  keep that flow intact even as you redesign anything else.
- *Print costs.* Nothing here handles fulfillment. Decide early whether
  you're print-on-demand (Printful/Gelato API, thinner margin, zero
  inventory risk) or bulk-printing calendars yourself (better margin,
  upfront cash and unsold-inventory risk) — that choice changes your unit
  economics more than anything on this page does.
- *Photo storage will outgrow local disk fast.* At even a few hundred
  entries a month, move `public/uploads` to S3/R2 before it becomes a
  migration under pressure.

## 7. Replacing the placeholder content

- Hero photos are pulled live from `cataas.com` (a free public cat-photo
  API) in `public/script.js` — swap in your own photography whenever
  you're ready.
- Affiliate links in `index.html` under `#picks` are placeholders — swap in
  your real affiliate URLs (Chewy, Amazon Associates, etc.) before launch.
- Calendar pricing lives in `.env` (`CALENDAR_PRICE_USD`,
  `CALENDAR_2PLUS_PRICE_USD`) and is read by both the shop section and the
  Stripe checkout — change it in one place.
