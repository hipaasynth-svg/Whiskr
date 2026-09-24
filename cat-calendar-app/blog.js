// Markdown-backed blog. Posts are plain files in content/blog/*.md with a
// small YAML-ish front-matter block; everything below turns them into
// server-rendered HTML pages, an index, and an RSS feed.
//
// Deliberately database-free: a post is a file on disk, so the router is
// mounted ahead of server.js's DB-init middleware and /blog keeps serving
// (and keeps being crawlable) even when Postgres is unreachable. That also
// means no admin UI and no migrations to maintain — publishing is a commit.
//
// On Vercel the content/ directory is only present in the deployed bundle
// because vercel.json's build config asks for it (includeFiles) — the
// bundler traces `require`s, and a directory read at runtime isn't a
// require, so without that entry these files silently wouldn't ship.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Marked } = require('marked');

const seo = require('./seo');

const CONTENT_DIR = path.join(__dirname, 'content', 'blog');

// Amazon Associates tracking tag (e.g. "whiskr-20"). Unset is a supported
// state, not a broken one: links still render, just untagged, so local dev
// and anyone running this without an Associates account isn't sending
// half-formed `tag=` params to Amazon.
const AMAZON_ASSOCIATE_TAG = (process.env.AMAZON_ASSOCIATE_TAG || '').trim();

// Slugs come from the URL, so they're untrusted: a post is only ever looked
// up by a name that matches this exactly, which keeps `..` and absolute
// paths out of the path.join below.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// amazon.com, amazon.co.uk, smile.amazon.com, amzn.to, ... but not
// "amazon.evil.com" or "notamazon.com" — the leading (^|\.) anchors the
// match to a whole label boundary.
const AMAZON_HOST_RE = /(?:^|\.)(?:amazon\.[a-z.]{2,}|amzn\.to|amzn\.com)$/i;

// ---------- front matter ----------

// A deliberately tiny subset of YAML: one `key: value` per line, optional
// single/double quotes around the value (needed whenever the value itself
// contains a colon, as most titles do). No nesting, no lists, no multi-line
// values — enough for the six fields a post actually has, and no new
// dependency to audit.
function parseFrontMatter(raw) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return { data: {}, body: raw };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (value.length >= 2 && (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body: raw.slice(match[0].length) };
}

function isTruthy(value) {
  return value === true || /^(true|yes|1)$/i.test(String(value || ''));
}

// ---------- Amazon links ----------

function isAmazonLink(href) {
  try {
    return AMAZON_HOST_RE.test(new URL(href).hostname);
  } catch {
    return false; // relative/mailto/malformed — not an Amazon link
  }
}

// Adds ?tag=<associate tag> without clobbering a tag already written into
// the Markdown by hand, and without disturbing the rest of the query
// string (Amazon search URLs carry `k=da+bird`, which URLSearchParams
// round-trips unchanged).
function withAssociateTag(href) {
  if (!AMAZON_ASSOCIATE_TAG) return href;
  try {
    const url = new URL(href);
    if (!url.searchParams.has('tag')) url.searchParams.set('tag', AMAZON_ASSOCIATE_TAG);
    return url.toString();
  } catch {
    return href;
  }
}

// One parser per post render, because it records whether the post turned out
// to contain an Amazon link — that's what decides whether the Associates/FTC
// disclosure gets rendered, so it can never drift out of sync with the
// actual link list the way a hand-maintained front-matter flag would.
function renderMarkdown(body) {
  let sawAmazonLink = false;

  const marked = new Marked({
    renderer: {
      link(href, title, text) {
        const titleAttr = title ? ` title="${seo.escapeHtml(title)}"` : '';

        if (isAmazonLink(href)) {
          sawAmazonLink = true;
          // rel="sponsored nofollow" is what Amazon's operating agreement
          // and Google's link-spam guidance both want on a monetized link;
          // noopener is the usual safety pairing with target="_blank".
          return `<a href="${seo.escapeHtml(withAssociateTag(href))}"${titleAttr}`
            + ` target="_blank" rel="sponsored nofollow noopener">${text}</a>`;
        }

        const isExternal = /^https?:\/\//i.test(href);
        const extraAttrs = isExternal ? ' target="_blank" rel="noopener"' : '';
        return `<a href="${seo.escapeHtml(href)}"${titleAttr}${extraAttrs}>${text}</a>`;
      },
    },
  });

  const html = marked.parse(body);
  return { html, hasAmazonLinks: sawAmazonLink };
}

// ---------- loading posts ----------

// Parsed posts are cached per file mtime: on Vercel the content never
// changes for the life of a deployment (so this is a straight win), and
// locally touching a .md file invalidates its entry, so editing a draft
// still just needs a refresh rather than a restart.
const postCache = new Map();

function formatDate(date) {
  // Front-matter dates are bare `YYYY-MM-DD`, which Date parses as UTC
  // midnight — formatting in UTC too keeps a post from displaying as the
  // previous day for anyone west of Greenwich.
  return date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function buildPost(slug, raw) {
  const { data, body } = parseFrontMatter(raw);
  const { html, hasAmazonLinks } = renderMarkdown(body);

  const date = new Date(data.date || 0);
  const validDate = !Number.isNaN(date.getTime()) && data.date;

  return {
    slug,
    title: data.title || slug,
    description: data.description || '',
    date: validDate ? date : null,
    dateIso: validDate ? date.toISOString() : null,
    dateDisplay: validDate ? formatDate(date) : '',
    image: data.image || '',
    imageAlt: data.imageAlt || '',
    draft: isTruthy(data.draft),
    html,
    hasAmazonLinks,
  };
}

function loadPost(slug) {
  if (!SLUG_RE.test(slug)) return null;

  const file = path.join(CONTENT_DIR, `${slug}.md`);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const cached = postCache.get(slug);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.post;

  const post = buildPost(slug, fs.readFileSync(file, 'utf8'));
  postCache.set(slug, { mtimeMs: stat.mtimeMs, post });
  return post;
}

// Every publishable post, newest first. Drafts are excluded here, which is
// what keeps them out of the index, the feed, and the sitemap in one place
// rather than three.
function listPosts() {
  let files;
  try {
    files = fs.readdirSync(CONTENT_DIR);
  } catch {
    return []; // no content directory yet — an empty blog, not an error
  }

  return files
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .map((f) => loadPost(f.replace(/\.md$/i, '')))
    .filter((p) => p && !p.draft)
    .sort((a, b) => {
      const at = a.date ? a.date.getTime() : 0;
      const bt = b.date ? b.date.getTime() : 0;
      return bt - at;
    });
}

// ---------- page chrome ----------

function absolute(baseUrl, maybePath) {
  if (!maybePath) return '';
  if (/^https?:\/\//i.test(maybePath)) return maybePath;
  return `${baseUrl}${maybePath.startsWith('/') ? '' : '/'}${maybePath}`;
}

// Inlined into a <script type="application/ld+json">, so the one character
// sequence that matters is `</` — escaping `<` stops a title or description
// from being able to close the script element early.
function jsonLdScript(payload) {
  return `<script type="application/ld+json">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`;
}

// Matches the markup of the hand-written pages in public/ (rules.html et
// al.) so the blog inherits the site's header, footer, backdrop and nav
// behaviour from the existing style.css/script.js rather than duplicating
// any of it. Links are absolute because these pages live one path segment
// deep (/blog/:slug) and relative hrefs would resolve inside /blog/.
function layout({ title, description, canonical, ogType, ogImage, ogImageAlt, jsonLd, robots, main }) {
  const desc = seo.escapeHtml(description);
  const ogTags = [
    '<meta property="og:type" content="' + seo.escapeHtml(ogType) + '" />',
    '<meta property="og:site_name" content="Whiskr" />',
    `<meta property="og:title" content="${seo.escapeHtml(title)}" />`,
    `<meta property="og:description" content="${desc}" />`,
    `<meta property="og:url" content="${seo.escapeHtml(canonical)}" />`,
    ogImage ? `<meta property="og:image" content="${seo.escapeHtml(ogImage)}" />` : '',
    ogImage && ogImageAlt ? `<meta property="og:image:alt" content="${seo.escapeHtml(ogImageAlt)}" />` : '',
  ].filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${seo.escapeHtml(title)}</title>
<meta name="robots" content="${seo.escapeHtml(robots || 'index, follow')}" />
<meta name="description" content="${desc}" />
<link rel="canonical" href="${seo.escapeHtml(canonical)}" />
<link rel="alternate" type="application/rss+xml" title="Whiskr blog" href="/blog/feed.xml" />

<!-- Open Graph / link previews (iMessage, Slack, Facebook, etc.) -->
${ogTags}

<!-- Twitter/X card -->
<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}" />
<meta name="twitter:title" content="${seo.escapeHtml(title)}" />
<meta name="twitter:description" content="${desc}" />
${ogImage ? `<meta name="twitter:image" content="${seo.escapeHtml(ogImage)}" />\n` : ''}${jsonLd ? jsonLdScript(jsonLd) + '\n' : ''}<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;1,500&family=Work+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css" />
<!-- Vercel Web Analytics -->
<script>window.va = window.va || function() { (window.vaq = window.vaq || []).push(arguments); };</script>
<script defer src="/_vercel/insights/script.js"></script>
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
    <a href="/vote.html">Vote</a>
    <a href="/blog">Blog</a>
    <a href="/#enter" class="nav-cta">Enter free</a>
  </nav>
</header>

${main}

<footer class="site-footer">
  <div>Whiskr — a free, real-public-vote cat photo contest, plus custom cat &amp; dog prints.<span class="business-address-line" hidden> · <span class="business-address"></span></span></div>
  <div class="footer-links"><a href="/">Home</a> · <a href="/blog">Blog</a> · <a href="/rules.html">Official rules</a> · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/shipping.html">Shipping</a></div>
</footer>

<script src="/script.js"></script>
</body>
</html>`;
}

// The one call to action every post carries, in the same place every time.
// Both halves are things that are true on every post regardless of subject:
// the contest is free and always open, and the shop doesn't depend on it.
const POST_CTA = `
  <aside class="blog-cta">
    <p class="ribbon-tag">Free to enter · no purchase necessary</p>
    <h2>Enter your cat free</h2>
    <p>Whiskr runs a free cat photo contest decided by real public vote — no purchase, no entry fee. Each round's top vote-getter wins a one-of-a-kind original portrait of their cat, hand-painted by artist Cody Carlson.</p>
    <p class="blog-cta-actions">
      <a class="btn btn-primary" href="/#enter">Enter your cat free</a>
      <a class="btn btn-ghost" href="/#shop-custom">or put them on a mug</a>
    </p>
    <p class="blog-cta-fine">No purchase necessary to enter or win. See the <a href="/rules.html">official rules</a>.</p>
  </aside>`;

// Rendered on any post that turned out to contain an Amazon link (see
// renderMarkdown). It sits above the post body, before the first link, so
// it's disclosed before a reader can click one — the FTC's endorsement
// guides ask for "clear and conspicuous," and the Amazon Associates
// operating agreement requires the association be stated outright.
const AFFILIATE_DISCLOSURE = `
    <p class="blog-disclosure"><strong>Disclosure:</strong> Whiskr is a participant in the Amazon Services LLC Associates Program. As an Amazon Associate we earn from qualifying purchases — if you buy something through an Amazon link on this page, we may earn a small commission at no extra cost to you. It doesn't change your price, and it doesn't change what we recommend.</p>`;

// ---------- pages ----------

function postUrl(baseUrl, slug) {
  return `${baseUrl}/blog/${slug}`;
}

function renderIndexPage(baseUrl, posts) {
  const canonical = `${baseUrl}/blog`;
  const description = 'Practical, source-backed writing about living with cats — enrichment, play, catios, and the gear that actually earns its shelf space.';

  const cards = posts.length
    ? posts.map((p) => `
      <a class="blog-card" href="/blog/${seo.escapeHtml(p.slug)}">
        ${p.image ? `<img class="blog-card-photo" src="${seo.escapeHtml(p.image)}" alt="${seo.escapeHtml(p.imageAlt || p.title)}" loading="lazy" />` : ''}
        <div class="blog-card-body">
          ${p.dateDisplay ? `<time class="blog-card-date" datetime="${seo.escapeHtml(p.dateIso)}">${seo.escapeHtml(p.dateDisplay)}</time>` : ''}
          <h2>${seo.escapeHtml(p.title)}</h2>
          <p>${seo.escapeHtml(p.description)}</p>
          <span class="blog-card-more">Read it →</span>
        </div>
      </a>`).join('')
    // An empty blog says so plainly rather than rendering a bare heading
    // over nothing — same honest-empty-state rule the rest of the site
    // follows for featured originals and reviews.
    : '<p class="blog-empty">No posts yet — the first one is on its way.</p>';

  const main = `
<div class="blog-wrap">
  <p class="ribbon-tag">The Whiskr blog</p>
  <h1>Notes on living with cats</h1>
  <p class="section-sub">${seo.escapeHtml(description)} New posts land here and in the <a href="/blog/feed.xml">RSS feed</a>.</p>

  <div class="blog-list">${cards}
  </div>
</div>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'The Whiskr blog',
    url: canonical,
    description,
    publisher: { '@type': 'Organization', name: 'Whiskr', url: `${baseUrl}/` },
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      description: p.description,
      url: postUrl(baseUrl, p.slug),
      ...(p.dateIso ? { datePublished: p.dateIso } : {}),
    })),
  };

  return layout({
    title: 'The Whiskr blog — notes on living with cats',
    description,
    canonical,
    ogType: 'website',
    jsonLd,
    main,
  });
}

function renderPostPage(baseUrl, post) {
  const canonical = postUrl(baseUrl, post.slug);
  const ogImage = absolute(baseUrl, post.image);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    url: canonical,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    ...(post.dateIso ? { datePublished: post.dateIso, dateModified: post.dateIso } : {}),
    ...(ogImage ? { image: ogImage } : {}),
    author: { '@type': 'Organization', name: 'Whiskr', url: `${baseUrl}/` },
    publisher: { '@type': 'Organization', name: 'Whiskr', url: `${baseUrl}/` },
  };

  const main = `
<article class="blog-wrap blog-post">
  <p class="ribbon-tag"><a href="/blog">The Whiskr blog</a></p>
  <h1>${seo.escapeHtml(post.title)}</h1>
  ${post.dateDisplay ? `<p class="blog-post-meta"><time datetime="${seo.escapeHtml(post.dateIso)}">${seo.escapeHtml(post.dateDisplay)}</time></p>` : ''}
  ${post.draft ? '<p class="blog-draft-flag">Draft — not listed, not indexed, not in the feed.</p>' : ''}
  ${post.image ? `<img class="blog-post-photo" src="${seo.escapeHtml(post.image)}" alt="${seo.escapeHtml(post.imageAlt || post.title)}" />` : ''}
  ${post.hasAmazonLinks ? AFFILIATE_DISCLOSURE : ''}

  <div class="blog-body">
${post.html}
  </div>
${POST_CTA}
</article>`;

  return layout({
    title: `${post.title} — Whiskr`,
    description: post.description,
    canonical,
    ogType: 'article',
    ogImage,
    ogImageAlt: post.imageAlt || post.title,
    // A draft is reachable by URL on purpose (that's how you preview one),
    // but must never be indexed while it's unfinished.
    robots: post.draft ? 'noindex, nofollow' : 'index, follow',
    jsonLd,
    main,
  });
}

// `]]>` inside post HTML would otherwise end the CDATA section early and
// break the whole feed document.
function cdata(text) {
  return `<![CDATA[${String(text).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function renderFeed(baseUrl, posts) {
  const latest = posts.find((p) => p.date);
  const items = posts.map((p) => `    <item>
      <title>${seo.escapeHtml(p.title)}</title>
      <link>${seo.escapeHtml(postUrl(baseUrl, p.slug))}</link>
      <guid isPermaLink="true">${seo.escapeHtml(postUrl(baseUrl, p.slug))}</guid>
${p.date ? `      <pubDate>${p.date.toUTCString()}</pubDate>\n` : ''}      <description>${seo.escapeHtml(p.description)}</description>
      <content:encoded>${cdata(p.html)}</content:encoded>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Whiskr blog</title>
    <link>${seo.escapeHtml(`${baseUrl}/blog`)}</link>
    <description>Practical, source-backed writing about living with cats — enrichment, play, catios, and the gear that actually earns its shelf space.</description>
    <language>en-us</language>
    <atom:link href="${seo.escapeHtml(`${baseUrl}/blog/feed.xml`)}" rel="self" type="application/rss+xml" />
${latest ? `    <lastBuildDate>${latest.date.toUTCString()}</lastBuildDate>\n` : ''}${items}
  </channel>
</rss>`;
}

function renderNotFoundPage(baseUrl) {
  return layout({
    title: 'Post not found — Whiskr',
    description: 'That post doesn\'t exist. Everything Whiskr has published is on the blog index.',
    canonical: `${baseUrl}/blog`,
    ogType: 'website',
    robots: 'noindex, follow',
    main: `
<div class="blog-wrap">
  <p class="ribbon-tag"><a href="/blog">The Whiskr blog</a></p>
  <h1>That post isn't here</h1>
  <p class="section-sub">The link may be mistyped, or the post may have been retired. Everything currently published is on the <a href="/blog">blog index</a>.</p>
</div>`,
  });
}

// ---------- router ----------

// baseUrl is passed in rather than re-derived here so canonical URLs, the
// feed, and the sitemap can't drift from the PUBLIC_BASE_URL server.js
// already resolved.
function createRouter({ baseUrl }) {
  const router = express.Router();

  router.get('/blog', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderIndexPage(baseUrl, listPosts()));
  });

  // Registered before /blog/:slug so the feed isn't swallowed by the slug
  // route (Express matches in definition order).
  router.get('/blog/feed.xml', (req, res) => {
    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(renderFeed(baseUrl, listPosts()));
  });

  router.get('/blog/:slug', (req, res, next) => {
    const post = loadPost(req.params.slug);
    if (post) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderPostPage(baseUrl, post));
    }

    // Anything with an extension is left alone — a real file under
    // public/blog/ (an image dropped next to a post, say) should still be
    // reachable through express.static rather than swallowed by this route.
    if (req.params.slug.includes('.')) return next();

    // Everything else is a mistyped or retired post slug, and gets a real
    // 404 from here rather than next(). Falling through would hand it to
    // the DB-init middleware, which answers a typo with "Database is not
    // reachable" whenever Postgres is down — a wrong and alarming reply to
    // a request that was only ever going to be a 404.
    res.status(404).set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderNotFoundPage(baseUrl));
  });

  return router;
}

// Sitemap rows for the blog index plus every published post, in the shape
// server.js's /sitemap.xml builder expects. Drafts are absent because
// listPosts() already drops them.
function sitemapEntries(baseUrl) {
  const posts = listPosts();
  return [
    { loc: `${baseUrl}/blog`, changefreq: 'weekly', priority: '0.7' },
    ...posts.map((p) => ({
      loc: postUrl(baseUrl, p.slug),
      changefreq: 'monthly',
      priority: '0.6',
      ...(p.dateIso ? { lastmod: p.dateIso.slice(0, 10) } : {}),
    })),
  ];
}

module.exports = { createRouter, sitemapEntries, listPosts, loadPost };
