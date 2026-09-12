// Server-side rendering helpers so real content — the product catalog, the
// current contest status, per-batch calendar info — is baked into the HTML
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
      url: `${baseUrl}/#shop-custom`,
      offers: {
        '@type': 'Offer',
        price: p.priceUsd.toFixed(2),
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        itemCondition: 'https://schema.org/NewCondition',
      },
    },
  }));
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Whiskr custom pet print catalog',
    itemListElement,
  });
}

function renderProductCards(products) {
  return products.map((p) => `
      <div class="custom-card" data-product-id="${escapeHtml(p.id)}" data-species="${escapeHtml(p.species)}">
        ${p.imagePath ? `<img class="custom-card-photo" src="${escapeHtml(p.imagePath)}" alt="${escapeHtml(p.imageAlt || p.name)}" style="aspect-ratio:${escapeHtml(p.mockupAspect || '1/1')}" loading="lazy" />` : ''}
        <h4>${escapeHtml(p.name)}</h4>
        <p>${escapeHtml(p.description)}</p>
        <div class="price">$${p.priceUsd.toFixed(2)}</div>
        <button type="button" class="btn btn-primary">Choose this print</button>
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

module.exports = {
  escapeHtml,
  productsJsonLd,
  renderProductCards,
  renderHeroSlides,
  renderEntryTeaser,
  renderOriginals,
  renderFooterStrip,
  fillEmpty,
  setAttr,
  revealHidden,
  injectIntoHead,
};
