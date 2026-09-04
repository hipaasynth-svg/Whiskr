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
