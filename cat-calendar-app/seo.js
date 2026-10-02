// Server-side rendering helpers so real content — the product catalog, the
// current contest status, product pages — is baked into the HTML
// response instead of arriving only after client JS runs. A crawler (Google,
// GPTBot, ClaudeBot, PerplexityBot — see robots.txt) that doesn't execute
// JavaScript sees the same content a real visitor sees; script.js re-fills
// the same containers on load, idempotently, so nothing changes for a real
// browser. Same pattern as codycarlson.art's api/home.js / api/sitemap.js,
// adapted to this app's single Express process instead of Vercel functions.

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// JSON for a <script type="application/ld+json"> block. Escaping "<" keeps
// admin-entered copy (SEO title/description) from closing the script tag.
function jsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function absoluteUrl(pathOrUrl, baseUrl) {
  return pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
}

// JSON-LD for the whole custom-print catalog, plus a visible (server-
// rendered) fallback grid matching public/script.js's renderGrid() markup
// closely enough that client JS replacing it is a no-op for a real visitor.
function productsJsonLd(products, baseUrl) {
  const itemListElement = products.map((p, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'Product',
      name: p.seoName || p.name,
      description: p.seoDescription || p.description,
      // Absolute URL required for a valid ImageObject/Product image — only
      // set once an admin-uploaded photo exists (see product_media in
      // db.js); omitted entirely otherwise rather than pointing at nothing.
      ...(p.imagePath ? { image: p.imagePath.startsWith('http') ? p.imagePath : `${baseUrl}${p.imagePath}` } : {}),
      url: `${baseUrl}/shop/${p.id}`,
      offers: {
        '@type': 'Offer',
        price: p.priceUsd.toFixed(2),
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        itemCondition: 'https://schema.org/NewCondition',
      },
    },
  }));
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Whiskr custom cat print catalog',
    itemListElement,
  });
}

function renderProductCards(products) {
  return products.map((p) => `
      <div class="custom-card${p.tier === 'premium' ? ' premium' : ''}" data-product-id="${escapeHtml(p.id)}" data-species="${escapeHtml(p.species)}">
        ${p.imagePath ? `<img class="custom-card-photo" src="${escapeHtml(p.imagePath)}" alt="${escapeHtml(p.imageAlt || p.name)}" style="aspect-ratio:${escapeHtml(p.mockupAspect || '1/1')}" loading="lazy" />` : ''}
        ${p.tier === 'premium' ? '<span class="tier-badge">Gallery Series</span>' : ''}
        <h4><a href="/shop/${escapeHtml(p.id)}">${escapeHtml(p.name)}</a></h4>
        <p>${escapeHtml(p.description)}</p>
        <div class="price">$${p.priceUsd.toFixed(2)}</div>
        <button type="button" class="btn btn-primary">Choose</button>
      </div>`).join('');
}

function renderHeroSlides(imagePaths) {
  return imagePaths.map((src, i) => `<img src="${escapeHtml(src)}" alt="" loading="${i === 0 ? 'eager' : 'lazy'}" class="${i === 0 ? 'active' : ''}" />`).join('');
}

// A few of the current round's entries as social-proof teaser cards on the
// homepage, for the (otherwise dead-end) window before any round has ever
// closed — deliberately no vote counts or vote-ordering here, only who's
// entered, matching the same hidden-tally principle the vote page states
// outright. Callers pass an already-randomized, already-limited list.
function renderEntryTeaser(entries) {
  return entries.map((e) => `
      <a class="teaser-card" href="vote.html?cat=${e.id}">
        <img src="${escapeHtml(e.photo_path)}" alt="${escapeHtml(e.cat_name)}" loading="lazy" />
        <span>${escapeHtml(e.cat_name)}</span>
      </a>`).join('');
}

// The featured-originals showcase — a couple of Cody's completed grand-
// prize portraits, or nothing at all (see the honest-empty-state rule on
// featured_originals in db.js). Callers pass whatever admin.html has
// uploaded so far, in position order.
function renderOriginals(originals) {
  return originals.map((o) => `
      <div class="teaser-card">
        <img src="${escapeHtml(o.image_path)}" alt="${escapeHtml(o.cat_name || 'An original portrait by Cody Carlson')}" loading="lazy" />
        <span>${escapeHtml(o.cat_name || 'Original portrait')}</span>
      </div>`).join('');
}

// The footer photo wall — a static two-row mosaic spanning the full page
// width. Photos are dealt alternately into the top and bottom row so both
// rows stay close to even length regardless of how many photos exist.
function renderFooterStrip(imagePaths) {
  const top = imagePaths.filter((_, i) => i % 2 === 0);
  const bottom = imagePaths.filter((_, i) => i % 2 === 1);
  const row = (paths) => paths.map((src) => `<img src="${escapeHtml(src)}" alt="" loading="lazy" />`).join('');
  return `<div class="footer-strip-row">${row(top)}</div><div class="footer-strip-row">${row(bottom)}</div>`;
}

// Past live painting sessions, listed next to the live screen. A session
// without a video_url yet (e.g. one that's scheduled but not recorded/
// uploaded) still shows as plain text rather than a dead link.
function renderPastSessions(sessions) {
  return sessions.map((s) => `
      <li>
        ${s.video_url
          ? `<a href="${escapeHtml(s.video_url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>`
          : `<span>${escapeHtml(s.title)}</span>`}
        <span class="session-date">${escapeHtml(new Date(s.session_date).toLocaleDateString())}</span>
      </li>`).join('');
}

// The live-painting screen's offline state — a visitor who shows up
// between sessions is still a real visitor, so this surfaces whatever
// keeps them around instead of a dead end: when the next session is (if
// scheduled), what the last one was (if any exist yet), and the two
// evergreen CTAs that are true whether or not anyone's painting right
// now — enter the open contest, or commission an original outright.
function renderLiveOffline({ nextSessionAt, lastSession }) {
  const nextLine = nextSessionAt
    ? `<p class="live-offline-next">Next session: ${escapeHtml(
        new Date(nextSessionAt).toLocaleString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })
      )}</p>`
    : '';
  const lastLine = lastSession
    ? `<p class="live-offline-last">Last time: ${
        lastSession.video_url
          ? `<a href="${escapeHtml(lastSession.video_url)}" target="_blank" rel="noopener">${escapeHtml(lastSession.title)}</a>`
          : escapeHtml(lastSession.title)
      }</p>`
    : '';
  return `<div class="live-offline">
    <p>Not live right now — check back, or watch a past session.</p>
    ${nextLine}${lastLine}
    <p class="live-offline-ctas">
      <a href="#enter" class="btn btn-primary">Enter this month's contest</a>
      <a href="/commission" class="btn btn-ghost">Commission an original</a>
    </p>
  </div>`;
}

// Replace the content of the element carrying id="ID" with `inner` —
// matches from the id through the rest of the opening tag to its `>`, then
// everything up to the next closing tag. Works whether the element started
// out empty or (as with winnerName/winnerBlurb, which ship with fallback
// placeholder copy for the pre-judging state) already had text in it.
function fillEmpty(html, id, inner) {
  if (!inner) return html;
  const re = new RegExp(`(id="${id}"[^>]*>)[\\s\\S]*?(</)`);
  return html.replace(re, (m, open, close) => `${open}${inner}${close}`);
}

// Set an attribute on the element carrying id="ID", e.g. an <img>'s src.
function setAttr(html, id, attr, value) {
  if (!value) return html;
  const re = new RegExp(`(id="${id}"[^>]*?\\s${attr}=")[^"]*(")`);
  if (re.test(html)) return html.replace(re, (m, open, close) => `${open}${escapeHtml(value)}${close}`);
  // Attribute not present yet (e.g. src="") — add it right after the id.
  return html.replace(new RegExp(`(id="${id}")`), `$1 ${attr}="${escapeHtml(value)}"`);
}

// Insert a <script> tag right before </head> — used for per-page JSON-LD.
function injectIntoHead(html, scriptTag) {
  return html.replace('</head>', `${scriptTag}\n</head>`);
}

// Removes the bare `hidden` attribute from whichever tag carries id="ID",
// regardless of where that attribute falls among the tag's others (unlike
// a literal `id="ID" hidden` string replace, which breaks the moment
// another attribute is inserted between them, e.g. by setAttr above).
function revealHidden(html, id) {
  const re = new RegExp(`(<[^>]*id="${id}"[^>]*?)\\s+hidden(\\s*[^>]*>)`);
  return html.replace(re, '$1$2');
}

// ---------- /shop and /shop/:id ----------
// One crawlable page per product, so each item can be indexed and cited on
// its own (Google Shopping/merchant listings and AI shopping assistants
// both want a URL per product, not a card on a long homepage). Ordering
// still happens in the homepage shop: the button deep-links there with the
// product preselected (?product=<id>, handled in script.js).
//
// Copy here must match what actually happens (CLAUDE.md): production and
// delivery times are the same figures shipping.html states.

function pageShell({ title, description, canonical, ogImage, head = '', body }) {
  const img = ogImage || 'https://whiskr.lol/og-default.png';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>${escapeHtml(title)}</title>
<meta name="robots" content="index, follow" />
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Whiskr" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<meta property="og:image" content="${escapeHtml(img)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(img)}" />
${head}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;1,500&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css" />
<script>window.va = window.va || function() { (window.vaq = window.vaq || []).push(arguments); };</script>
<script defer src="/_vercel/insights/script.js"></script>
<style>
  .shop-wrap { max-width: 900px; margin: 0 auto; padding: 40px 24px 90px; }
  .shop-crumbs { font-size: 0.82rem; color: #6b6552; margin-bottom: 18px; }
  .shop-crumbs a { color: inherit; }
  .product-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 36px; align-items: start; }
  .product-detail.no-photo { grid-template-columns: minmax(0, 1fr); max-width: 620px; }
  .product-detail img { width: 100%; height: auto; border-radius: 6px; border: 1px solid rgba(0,0,0,.08); }
  .product-detail h1 { margin: 0 0 8px; font-size: 2rem; }
  .product-detail .price { font-size: 1.4rem; font-weight: 600; margin: 6px 0 16px; }
  .product-detail p, .product-detail li { color: #33301f; font-size: 0.96rem; }
  .product-detail ol { padding-left: 1.2em; }
  .product-detail .btn { display: inline-block; margin: 8px 0 18px; text-decoration: none; }
  .product-detail .fine { font-size: 0.85rem; color: #6b6552; }
  .shop-more { margin-top: 56px; }
  .shop-more ul, .shop-list { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .shop-more li a, .shop-list li a { display: block; padding: 14px 16px; border: 1px solid rgba(0,0,0,.12); border-radius: 6px; text-decoration: none; color: inherit; background: rgba(255,255,255,.6); height: 100%; box-sizing: border-box; }
  .shop-list li a strong, .shop-more li a strong { display: block; }
  .shop-list li a span, .shop-more li a span { font-size: 0.85rem; color: #6b6552; }
  .shop-list li a p { font-size: 0.88rem; margin: 6px 0 0; color: #33301f; }
  @media (max-width: 700px) { .product-detail { grid-template-columns: minmax(0, 1fr); gap: 20px; } }
</style>
</head>
<body>
<div id="siteBackdrop" aria-hidden="true"></div>
<header class="site-header">
  <a href="/" class="brand">Whiskr</a>
  <button class="nav-toggle" id="navToggle" aria-label="Menu" aria-expanded="false" aria-controls="siteNav">
    <span></span><span></span><span></span>
  </button>
  <nav class="site-nav" id="siteNav">
    <a href="/">Home</a>
    <a href="/shop">Shop</a>
    <a href="/vote.html">Vote</a>
    <a href="/shipping.html">Shipping</a>
  </nav>
</header>
${body}
<footer class="site-footer">
  <div>Whiskr — a free, real-public-vote cat photo contest, plus custom prints of your own cat.</div>
  <div class="footer-links"><a href="/">Home</a> · <a href="/shop">Shop</a> · <a href="/vote.html">Vote</a> · <a href="/rules.html">Rules</a> · <a href="/blog">Blog</a> · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/shipping.html">Shipping</a></div>
</footer>
<script src="/script.js"></script>
</body>
</html>`;
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function renderProductPage({ product: p, others, baseUrl, freeShippingUsd }) {
  const url = `${baseUrl}/shop/${p.id}`;
  const image = p.imagePath ? absoluteUrl(p.imagePath, baseUrl) : null;
  const title = `${p.seoName} — Custom Cat Gift | Whiskr`;
  const description = `${p.seoDescription} ${money(p.priceUsd)}, printed to order from your own cat photo.`.slice(0, 300);
  const orderHref = `/?product=${encodeURIComponent(p.id)}#shop-custom`;

  const productLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.seoName,
    description: p.seoDescription,
    sku: p.id,
    brand: { '@type': 'Brand', name: 'Whiskr' },
    url,
    ...(image ? { image } : {}),
    offers: {
      '@type': 'Offer',
      url,
      price: p.priceUsd.toFixed(2),
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'Whiskr', url: `${baseUrl}/` },
    },
  };
  const crumbsLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Shop', item: `${baseUrl}/shop` },
      { '@type': 'ListItem', position: 3, name: p.name, item: url },
    ],
  };

  const body = `
<main class="shop-wrap">
  <nav class="shop-crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/shop">Shop</a> › ${escapeHtml(p.name)}</nav>
  <div class="product-detail${image ? '' : ' no-photo'}">
    ${image ? `<img src="${escapeHtml(p.imagePath)}" alt="${escapeHtml(p.imageAlt)}" style="aspect-ratio:${escapeHtml(p.mockupAspect || '1/1')};object-fit:cover" />` : ''}
    <div>
      ${p.tier === 'premium' ? '<p class="ribbon-tag">Gallery Series</p>' : ''}
      <h1>${escapeHtml(p.name)}</h1>
      <div class="price">${money(p.priceUsd)}</div>
      <p>${escapeHtml(p.description)}</p>
      <a class="btn btn-primary" href="${escapeHtml(orderHref)}">Make yours</a>
      <h2>How it works</h2>
      <ol>
        <li>Upload a photo of your cat and confirm it's yours to print.</li>
        <li>Pay securely at checkout. Shipping and any tax are shown before you pay.</li>
        <li>We print it to order through our print partner, usually in 2–5 business days, then it ships with tracking.</li>
      </ol>
      <p class="fine">Free shipping on print orders of $${freeShippingUsd} or more. US delivery typically takes 1–8 business days after printing. Damaged, defective or wrong items are replaced or refunded — see <a href="/shipping.html">shipping &amp; returns</a>.</p>
    </div>
  </div>
  ${others.length ? `<section class="shop-more">
    <h2>More custom cat gifts</h2>
    <ul>${others.map((o) => `<li><a href="/shop/${escapeHtml(o.id)}"><strong>${escapeHtml(o.name)}</strong><span>${money(o.priceUsd)}</span></a></li>`).join('')}</ul>
  </section>` : ''}
</main>`;

  return pageShell({
    title,
    description,
    canonical: url,
    ogImage: image,
    head: `<script type="application/ld+json">${jsonLd(productLd)}</script>\n<script type="application/ld+json">${jsonLd(crumbsLd)}</script>`,
    body,
  });
}

function renderShopIndex({ products, baseUrl, freeShippingUsd }) {
  const body = `
<main class="shop-wrap">
  <nav class="shop-crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › Shop</nav>
  <h1>Custom cat gifts, printed from your photo</h1>
  <p>Upload a photo of your cat and we'll print it to order — nothing is pre-made or kept in stock. Free shipping on print orders of $${freeShippingUsd} or more.</p>
  ${products.length
    ? `<ul class="shop-list">${products.map((p) => `<li><a href="/shop/${escapeHtml(p.id)}"><strong>${escapeHtml(p.name)}</strong><span>${money(p.priceUsd)}</span><p>${escapeHtml(p.description)}</p></a></li>`).join('')}</ul>`
    : '<p>The shop is being restocked — check back soon.</p>'}
</main>`;
  return pageShell({
    title: 'Custom Cat Gifts & Prints From Your Photo | Whiskr',
    description: `Custom cat mugs, canvases, framed prints, posters, phone cases and more, printed to order from your own cat photo. Free shipping on orders of $${freeShippingUsd}+.`,
    canonical: `${baseUrl}/shop`,
    head: `<script type="application/ld+json">${productsJsonLd(products, baseUrl)}</script>`,
    body,
  });
}

// Shown for an unknown product or one switched off in admin — a real 404
// with noindex, so Google drops the URL instead of indexing a dead end.
function renderShopNotFound() {
  return pageShell({
    title: 'Product not available — Whiskr',
    description: 'This product is not currently available.',
    canonical: 'https://whiskr.lol/shop',
    head: '<meta name="robots" content="noindex, follow" />',
    body: `
<main class="shop-wrap">
  <h1>This product isn't available right now.</h1>
  <p><a href="/shop">See everything we currently make</a>.</p>
</main>`,
  }).replace('<meta name="robots" content="index, follow" />\n', '');
}

module.exports = {
  escapeHtml,
  jsonLd,
  renderProductPage,
  renderShopIndex,
  renderShopNotFound,
  productsJsonLd,
  renderProductCards,
  renderHeroSlides,
  renderEntryTeaser,
  renderOriginals,
  renderFooterStrip,
  renderPastSessions,
  renderLiveOffline,
  fillEmpty,
  setAttr,
  revealHidden,
  injectIntoHead,
};
