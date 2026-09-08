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
      name: p.name,
      description: p.description,
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
        <h4>${escapeHtml(p.name)}</h4>
        <p>${escapeHtml(p.description)}</p>
        <div class="price">$${p.priceUsd.toFixed(2)}</div>
        <button type="button" class="btn btn-primary">Choose this print</button>
      </div>`).join('');
}

function renderHeroSlides(imagePaths) {
  return imagePaths.map((src, i) => `<img src="${escapeHtml(src)}" alt="" loading="${i === 0 ? 'eager' : 'lazy'}" class="${i === 0 ? 'active' : ''}" />`).join('');
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

module.exports = {
  escapeHtml,
  productsJsonLd,
  renderProductCards,
  renderHeroSlides,
  fillEmpty,
  setAttr,
  injectIntoHead,
};
