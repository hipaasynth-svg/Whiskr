// ---------- marketing attribution ----------
// First-touch only: captures ?utm_campaign= from an ad link into a cookie
// the first time it's seen, and never overwrites it on a later visit (so
// browsing back to the homepage organically doesn't erase credit for the
// ad that actually brought this visitor in). Read by the entry/order forms
// below and sent along so the admin-only marketing ledger can attribute
// real revenue back to a real campaign — see cleanUtmCampaign in server.js.
function captureUtmCampaign() {
  try {
    const params = new URLSearchParams(window.location.search);
    const utm = params.get('utm_campaign');
    if (utm && !document.cookie.includes('whiskr_utm_campaign=')) {
      document.cookie = `whiskr_utm_campaign=${encodeURIComponent(utm.slice(0, 120))};path=/;max-age=${30 * 24 * 60 * 60}`;
    }
  } catch (_) {}
}
function getUtmCampaign() {
  try {
    const m = document.cookie.match(/(?:^|; )whiskr_utm_campaign=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (_) {
    return '';
  }
}
captureUtmCampaign();

// ---------- mobile nav ----------
// Every page shares the same header markup (#navToggle + #siteNav) — this
// runs once per page load and no-ops if either element is missing, same
// guard pattern as the other page-agnostic sections below.
(function mobileNav() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav');
  if (!toggle || !nav) return;
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  nav.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
})();

// ---------- business address ----------
// Same honest-empty-state rule as everything else on this site: /api/business-info
// returns null until BUSINESS_MAILING_ADDRESS is actually set, and the line
// stays hidden rather than showing a broken-looking placeholder to a real
// visitor. Used in the shared footer and the Contact section of the policy
// pages (privacy.html/terms.html/shipping.html) — every page carries its own
// #businessAddressLine/#businessAddress pair, so this fills whichever exist.
(function businessAddress() {
  const lines = document.querySelectorAll('#businessAddressLine, .business-address-line');
  if (lines.length === 0) return;
  fetch('/api/business-info')
    .then((res) => res.json())
    .then((data) => {
      if (!data.address) return;
      document.querySelectorAll('#businessAddress, .business-address').forEach((el) => {
        el.textContent = data.address;
      });
      lines.forEach((el) => { el.hidden = false; });
    })
    .catch(() => {});
})();

// ---------- rolodex nav arrows ----------
// Shared by the vote page's cat cards and the homepage's product cards —
// the track's own content is filled in later by whichever page-specific
// code owns it (loadContest(), customShop()); this only needs the wrap/
// track/buttons to exist, which they do at parse time either way.
(function rolodexNav() {
  document.querySelectorAll('.rolodex-wrap').forEach((wrap) => {
    const track = wrap.querySelector('.rolodex');
    const prev = wrap.querySelector('.rolodex-nav.prev');
    const next = wrap.querySelector('.rolodex-nav.next');
    if (!track || !prev || !next) return;
    const step = () => Math.min(track.clientWidth * 0.9, 600);
    prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
  });
})();

// ---------- site-wide background ----------
// Same /api/background data the homepage hero slideshow uses, cross-faded
// behind every page via #siteBackdrop (see style.css) — one shared photo
// backdrop for the whole site instead of a hero-only feature. Runs
// independently of heroSlideshow() below so a page can have either,
// neither, or (the homepage) both at once without one depending on the
// other's DOM.
(function siteBackdrop() {
  const el = document.getElementById('siteBackdrop');
  if (!el) return;
  (async () => {
    let slides = [];
    try {
      const res = await fetch('/api/background');
      const data = await res.json();
      slides = data.slides || [];
    } catch (err) {
      console.error('site backdrop load failed', err);
    }
    if (slides.length === 0) return;

    slides.forEach((s, i) => {
      const img = document.createElement('img');
      img.src = s.image_path;
      img.alt = '';
      img.loading = i === 0 ? 'eager' : 'lazy';
      if (i === 0) img.classList.add('active');
      el.appendChild(img);
    });
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    el.appendChild(scrim);

    if (slides.length < 2) return;
    const imgs = el.querySelectorAll('img');
    let index = 0;
    setInterval(() => {
      imgs[index].classList.remove('active');
      index = (index + 1) % imgs.length;
      imgs[index].classList.add('active');
    }, 7000);
  })();
})();

// ---------- hero slideshow ----------
// Admin-controlled, from /api/background (see admin.html's "Background
// slideshow" section). Zero photos uploaded there means no slideshow at
// all — the plain hero background stays, never a stock-photo placeholder.
// The server may have already prerendered these same slides into #heroSlides
// for crawlers/first paint (see seo.js); this rebuild is idempotent, same
// content either way, so a real visitor sees no meaningful change.
(function heroSlideshow() {
  const track = document.getElementById('heroSlides');
  const dotsWrap = document.getElementById('heroDots');
  const pauseBtn = document.getElementById('heroPause');
  if (!track) return;
  pauseBtn.hidden = true;

  async function init() {
    let slides = [];
    try {
      const res = await fetch('/api/background');
      const data = await res.json();
      slides = data.slides || [];
    } catch (err) {
      console.error('background slides load failed', err);
    }
    if (slides.length === 0) return;

    track.innerHTML = '';
    dotsWrap.innerHTML = '';
    slides.forEach((s, i) => {
      const img = document.createElement('img');
      img.src = s.image_path;
      img.alt = '';
      img.loading = i === 0 ? 'eager' : 'lazy';
      if (i === 0) img.classList.add('active');
      track.appendChild(img);

      const dot = document.createElement('span');
      if (i === 0) dot.classList.add('active');
      dotsWrap.appendChild(dot);
    });

    if (slides.length < 2) return;
    pauseBtn.hidden = false;

    const imgs = track.querySelectorAll('img');
    const dots = dotsWrap.querySelectorAll('span');
    let index = 0;
    let paused = false;

    function show(i) {
      imgs[index].classList.remove('active');
      dots[index].classList.remove('active');
      index = (i + imgs.length) % imgs.length;
      imgs[index].classList.add('active');
      dots[index].classList.add('active');
    }

    setInterval(() => {
      if (!paused) show(index + 1);
    }, 4500);

    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Play' : 'Pause';
    });

    dots.forEach((dot, i) => dot.addEventListener('click', () => show(i)));
  }

  init();
})();

// ---------- featured originals showcase ----------
// Admin-controlled, from /api/originals (see admin.html's "Featured
// originals" section). Zero uploaded there means the honest "still
// drying" empty state, never a placeholder image. The server may have
// already prerendered these into #originalsGrid for crawlers/first paint
// (see seo.js); this rebuild is idempotent, same content either way.
(function originalsShowcase() {
  const grid = document.getElementById('originalsGrid');
  const empty = document.getElementById('originalsEmpty');
  if (!grid || !empty) return;

  fetch('/api/originals')
    .then((res) => res.json())
    .then((data) => {
      const originals = data.originals || [];
      if (originals.length === 0) return;

      grid.innerHTML = '';
      originals.forEach((o) => {
        const card = document.createElement('div');
        card.className = 'teaser-card';
        const img = document.createElement('img');
        img.src = o.image_path;
        img.alt = o.cat_name || 'An original portrait by Cody Carlson';
        card.appendChild(img);
        const span = document.createElement('span');
        span.textContent = o.cat_name || 'Original portrait';
        card.appendChild(span);
        grid.appendChild(card);
      });
      grid.hidden = false;
      empty.hidden = true;
    })
    .catch((err) => console.error('originals showcase load failed', err));
})();

// ---------- homepage promo slots ----------
// Admin-controlled, from /api/site-blocks (see admin.html's "Homepage
// promo messages" section): a starburst badge over the hero, plus two
// image+text feature blocks in the middle of the page. Any slot with
// neither text nor an image stays hidden — never a placeholder. The
// server may have already prerendered these into the same elements for
// crawlers/first paint (see seo.js); this rebuild is idempotent.
(function homepagePromoSlots() {
  const starburst = document.getElementById('promoStarburst');
  const featureBlocksSection = document.getElementById('featureBlocks');
  if (!starburst && !featureBlocksSection) return;

  fetch('/api/site-blocks')
    .then((res) => res.json())
    .then((data) => {
      const blocks = data.blocks || {};

      if (starburst && blocks.starburst) {
        const text = document.getElementById('promoStarburstText');
        text.textContent = blocks.starburst.text || '';
        if (blocks.starburst.color) starburst.style.background = blocks.starburst.color;
        starburst.hidden = false;
      }

      if (!featureBlocksSection) return;
      let anyUsed = false;
      [['feature_1', 'featureBlock1'], ['feature_2', 'featureBlock2']].forEach(([slot, elId]) => {
        const b = blocks[slot];
        const block = document.getElementById(elId);
        if (!b || !block) return;
        anyUsed = true;
        if (b.text) document.getElementById(`${elId}Text`).textContent = b.text;
        if (b.imagePath) {
          const img = document.getElementById(`${elId}Img`);
          img.src = b.imagePath;
          img.hidden = false;
        }
        block.hidden = false;
      });
      if (anyUsed) featureBlocksSection.hidden = false;
    })
    .catch((err) => console.error('homepage promo slots load failed', err));
})();

// ---------- footer photo wall ----------
// Admin-controlled, from /api/footer-strip (see admin.html's "Footer
// photo wall" section). Zero photos uploaded means no strip at all.
(function footerPhotoWall() {
  const strip = document.getElementById('footerStrip');
  if (!strip) return;

  fetch('/api/footer-strip')
    .then((res) => res.json())
    .then((data) => {
      const images = (data.images || []).map((i) => i.image_path);
      if (images.length === 0) return;

      const rows = [images.filter((_, i) => i % 2 === 0), images.filter((_, i) => i % 2 === 1)];
      strip.innerHTML = '';
      rows.forEach((rowImages) => {
        const row = document.createElement('div');
        row.className = 'footer-strip-row';
        rowImages.forEach((src) => {
          const img = document.createElement('img');
          img.src = src;
          img.alt = '';
          img.loading = 'lazy';
          row.appendChild(img);
        });
        strip.appendChild(row);
      });
      strip.hidden = false;
    })
    .catch((err) => console.error('footer photo wall load failed', err));
})();

// ---------- live contest status ----------
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const statusEl = document.getElementById('contestStatus');
    if (statusEl) statusEl.textContent = data.statusText || '';

    const ribbonEl = document.getElementById('currentRibbon');
    const nameEl = document.getElementById('winnerName');
    const photoEl = document.getElementById('winnerPhoto');
    const blurbEl = document.getElementById('winnerBlurb');
    if (data.lastWinner && nameEl && photoEl) {
      if (ribbonEl) ribbonEl.textContent = 'Most recent Cat of the Month';
      nameEl.textContent = data.lastWinner.cat_name;
      photoEl.src = data.lastWinner.photo_path;
      photoEl.alt = `${data.lastWinner.cat_name}, Cat of the Month`;
      if (blurbEl) blurbEl.textContent = 'Chosen as Cat of the Month by real public vote.';
    } else if (data.contestId) {
      loadCurrentTeaser();
    }
  } catch (err) {
    console.error('status load failed', err);
  }
}
loadStatus();


// No round has closed yet — show a few of this round's real entries
// (random order, no vote counts) instead of a dead-end "check back soon".
// Same containers the server may have already prerendered (see seo.js's
// renderEntryTeaser) — this is a no-op for a real visitor if so.
async function loadCurrentTeaser() {
  const teaser = document.getElementById('currentTeaser');
  if (!teaser || teaser.children.length) return;
  try {
    const res = await fetch('/api/contest/current');
    const data = await res.json();
    const entries = (data.entries || []).slice(0, 6);
    teaser.innerHTML = '';
    entries.forEach((cat) => {
      const a = document.createElement('a');
      a.className = 'teaser-card';
      a.href = `vote.html?cat=${cat.id}`;
      const img = document.createElement('img');
      img.src = cat.photo_path;
      img.alt = cat.cat_name;
      img.loading = 'lazy';
      const span = document.createElement('span');
      span.textContent = cat.cat_name;
      a.appendChild(img);
      a.appendChild(span);
      teaser.appendChild(a);
    });
  } catch (err) {
    console.error('teaser load failed', err);
  }
}

// ---------- entry form ----------
// Stores an active print-shop discount (issued at entry or in the
// final-placement email) so the custom-order form below can pick it up and
// apply it automatically — see applyStoredDiscount().
function storeDiscount(discount) {
  if (!discount) return;
  try { localStorage.setItem('whiskr_discount', JSON.stringify(discount)); } catch (_) {}
}

// Shares the real share-card image (photo + name + vote link, composited
// server-side — see generateShareCard in server.js) via Web Share Level 2's
// `files`, when the browser supports sharing files, since an image posts
// far better than a bare link on Stories/WhatsApp/feed. Falls back to a
// plain link share, then clipboard, same ladder as vote.html's shareCat().
async function shareEntryCard(shareImageUrl, catName, voteUrl, noteEl) {
  const text = `Vote for ${catName} in Whiskr's free cat photo contest! I'd owe you one:`;
  try {
    if (shareImageUrl && window.navigator.canShare) {
      const resp = await fetch(shareImageUrl);
      const blob = await resp.blob();
      const file = new File([blob], 'vote-card.jpg', { type: blob.type || 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: text, text, url: voteUrl });
        return;
      }
    }
    if (navigator.share) {
      await navigator.share({ title: text, text, url: voteUrl });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the share sheet
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(`${text} ${voteUrl}`).then(() => {
      if (noteEl) noteEl.textContent = 'Link copied — go paste it!';
    });
  } else {
    window.prompt('Copy this link:', voteUrl);
  }
}

function renderCountdown(el, expiresAt) {
  function tick() {
    const msLeft = new Date(expiresAt) - Date.now();
    if (msLeft <= 0) {
      el.textContent = 'Expired';
      return;
    }
    const hours = Math.floor(msLeft / 3600000);
    const mins = Math.floor((msLeft % 3600000) / 60000);
    el.textContent = `Expires in ${hours}h ${mins}m`;
    setTimeout(tick, 60000);
  }
  tick();
}

const entryForm = document.getElementById('entryForm');
if (entryForm) {
  const photoInput = document.getElementById('entryPhoto');
  entryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = document.getElementById('entryNote');
    const mockup = document.getElementById('entryMockup');
    const submitBtn = entryForm.querySelector('button[type=submit]');
    note.classList.remove('error');
    note.textContent = 'Submitting…';
    submitBtn.disabled = true;
    mockup.hidden = true;

    const formData = new FormData(entryForm);
    formData.append('utmCampaign', getUtmCampaign());
    const photoFile = photoInput.files[0];

    const catNameValue = document.getElementById('catName').value;

    try {
      const res = await fetch('/api/submissions', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      note.innerHTML = `You're entered! Check your email for your vote link, or <a href="${data.voteUrl}">go vote for your own cat now</a> and start sharing.`;

      storeDiscount(data.discount);

      // Real preview of the photo they just uploaded, styled like a
      // finished print — not a fabricated 3D render (this app doesn't fake
      // product mockups; see README). The discount is real, redeemed and
      // verified server-side at checkout, not just a client-side display.
      let photoUrl = '';
      if (photoFile) photoUrl = URL.createObjectURL(photoFile);
      mockup.innerHTML = `
        <div class="entry-mockup">
          ${photoUrl ? `<div class="entry-mockup-frame"><img src="${photoUrl}" alt="" /><div class="caption">A print of your cat could look like this</div></div>` : ''}
          <div class="entry-share">
            <p>Your voting link: <a href="${data.voteUrl}">${data.voteUrl}</a></p>
            <button type="button" class="btn btn-primary" id="entryShareBtn">Share for votes</button>
          </div>
          ${data.discount ? `
            <div class="entry-discount">
              <div class="pct">${data.discount.percent}% off</div>
              <div class="countdown" id="entryDiscountCountdown"></div>
              <a href="#shop-custom" class="btn btn-primary">Get a print now</a>
            </div>` : ''}
          ${data.lowResolution ? `<div class="low-res-warning">Heads up: this photo is ${data.width}×${data.height}px. Prints larger than a mug (poster, canvas) may look a little soft — a higher-resolution photo will look sharper.</div>` : ''}
        </div>`;
      mockup.hidden = false;
      if (data.discount) renderCountdown(document.getElementById('entryDiscountCountdown'), data.discount.expiresAt);
      const shareBtn = document.getElementById('entryShareBtn');
      if (shareBtn) {
        shareBtn.addEventListener('click', () => shareEntryCard(data.shareImageUrl, catNameValue, data.voteUrl, note));
      }

      entryForm.reset();
      loadStatus();
    } catch (err) {
      note.textContent = err.message;
      note.classList.add('error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ---------- reviews ----------
// Renders only what GET /api/reviews returns — there is no seed/fake data
// anywhere in this app. An empty result is a real, honest state, not a bug.
async function loadReviews() {
  const grid = document.getElementById('reviewsGrid');
  const empty = document.getElementById('reviewsEmpty');
  if (!grid) return;
  try {
    const res = await fetch('/api/reviews');
    const data = await res.json();
    const reviews = data.reviews || [];

    if (reviews.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    grid.innerHTML = '';
    reviews.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'review-card';

      const stars = document.createElement('div');
      stars.className = 'stars';
      stars.textContent = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
      card.appendChild(stars);

      const body = document.createElement('p');
      body.className = 'body';
      body.textContent = r.body;
      card.appendChild(body);

      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = r.display_name || 'Whiskr customer';
      const verified = document.createElement('span');
      verified.className = 'verified';
      verified.textContent = '✓ Verified purchase';
      who.appendChild(verified);
      card.appendChild(who);

      grid.appendChild(card);
    });

    grid.style.display = 'grid';
    empty.style.display = 'none';
  } catch (err) {
    console.error('reviews load failed', err);
  }
}
loadReviews();

// ---------- custom pet product shop ----------
(function customShop() {
  const grid = document.getElementById('customGrid');
  const toggle = document.getElementById('speciesToggle');
  if (!grid || !toggle) return;

  const speciesField = document.getElementById('customSpecies');
  const productField = document.getElementById('customProductId');
  const selectedNote = document.getElementById('customSelectedNote');
  const submitBtn = document.getElementById('customSubmitBtn');
  const form = document.getElementById('customOrderForm');
  const photoInput = document.getElementById('customPhoto');
  const preview = document.getElementById('customPreview');
  const orderNote = document.getElementById('customOrderNote');
  const emailField = document.getElementById('customEmail');
  const discountBanner = document.getElementById('customDiscountBanner');
  const phoneModelLabel = document.getElementById('customPhoneModelLabel');
  const phoneModelSelect = document.getElementById('customPhoneModel');

  let currentSpecies = 'cat';
  let products = [];

  // Phone cases are sized per exact device (see phoneCases.js server-side)
  // — this list is only ever used to populate the picker; the choice is
  // re-validated against the real Printful catalog when the order posts.
  async function loadPhoneModels() {
    if (!phoneModelSelect) return;
    try {
      const res = await fetch('/api/phone-models');
      const data = await res.json();
      (data.models || []).forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.variantId;
        opt.textContent = m.label;
        phoneModelSelect.appendChild(opt);
      });
    } catch (err) {
      console.error('phone model list load failed', err);
    }
  }
  loadPhoneModels();

  // A discount can arrive two ways: a link from the entry-confirmation or
  // final-placement email (?discountEmail=&discountExpires=&discountToken=
  // in the URL, ahead of the #shop-custom hash), or already stored from
  // entering the contest earlier in this same browser session. Either way
  // it's only ever a client-side convenience — the real check is
  // discountToken.verify() server-side in POST /api/custom-orders.
  function loadActiveDiscount() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('discountToken')) {
      const fromUrl = {
        percent: null, // server tells us the real percent when the order posts; UI just shows "a discount is applied"
        email: params.get('discountEmail'),
        expiresAt: params.get('discountExpires'),
        token: params.get('discountToken'),
      };
      try { localStorage.setItem('whiskr_discount', JSON.stringify(fromUrl)); } catch (_) {}
    }
    try {
      const stored = JSON.parse(localStorage.getItem('whiskr_discount') || 'null');
      if (stored && stored.expiresAt && new Date(stored.expiresAt) > new Date()) return stored;
    } catch (_) {}
    return null;
  }

  function setHiddenField(name, value) {
    let input = form.querySelector(`input[name="${name}"]`);
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  const activeDiscount = loadActiveDiscount();
  if (activeDiscount && discountBanner) {
    setHiddenField('discountEmail', activeDiscount.email);
    setHiddenField('discountExpires', activeDiscount.expiresAt);
    setHiddenField('discountToken', activeDiscount.token);
    if (emailField && !emailField.value) emailField.value = activeDiscount.email;
    discountBanner.hidden = false;
    discountBanner.textContent = `A time-limited discount is applied — order with the email ${activeDiscount.email} to use it.`;
  }

  // The server already bakes real product cards into #customGrid on first
  // paint (see renderProductCards in seo.js) — never blank that away while
  // this fetch is in flight or if it fails; a visitor (or a crawler that
  // doesn't run this script at all) should never see less than what the
  // server already sent.
  async function loadProducts(species) {
    if (!grid.children.length) grid.innerHTML = '<p style="color:#6b6552;">Loading…</p>';
    try {
      const res = await fetch(`/api/products?species=${encodeURIComponent(species)}`);
      const data = await res.json();
      products = data.products || [];
      renderGrid();
    } catch (err) {
      if (!grid.children.length) grid.innerHTML = '<p style="color:#6b6552;">Could not load products right now.</p>';
    }
  }

  function renderGrid() {
    grid.innerHTML = '';
    products.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'custom-card';
      if (p.id === productField.value) card.classList.add('selected');

      if (p.imagePath) {
        const img = document.createElement('img');
        img.className = 'custom-card-photo';
        img.src = p.imagePath;
        img.alt = p.imageAlt || p.name;
        img.loading = 'lazy';
        img.style.aspectRatio = p.mockupAspect || '1/1';
        card.appendChild(img);
      }

      const h4 = document.createElement('h4');
      h4.textContent = p.name;
      card.appendChild(h4);

      const desc = document.createElement('p');
      desc.textContent = p.description;
      card.appendChild(desc);

      const price = document.createElement('div');
      price.className = 'price';
      price.textContent = `$${p.priceUsd.toFixed(2)}`;
      card.appendChild(price);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary';
      btn.textContent = p.id === productField.value ? 'Selected' : 'Choose this print';
      btn.addEventListener('click', () => selectProduct(p));
      card.appendChild(btn);

      grid.appendChild(card);
    });
  }

  function selectProduct(p) {
    productField.value = p.id;
    selectedNote.textContent = `You picked: ${p.name} — $${p.priceUsd.toFixed(2)} each`;
    submitBtn.disabled = false;
    submitBtn.textContent = `Continue to checkout`;
    if (phoneModelLabel && phoneModelSelect) {
      const isPhoneCase = p.id === 'phone-case';
      phoneModelLabel.hidden = !isPhoneCase;
      phoneModelSelect.required = isPhoneCase;
      if (!isPhoneCase) phoneModelSelect.value = '';
    }
    renderGrid();
  }

  toggle.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSpecies = btn.dataset.species;
      speciesField.value = currentSpecies;
      productField.value = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Choose a product first';
      selectedNote.textContent = 'Pick a product above to get started.';
      if (phoneModelLabel && phoneModelSelect) {
        phoneModelLabel.hidden = true;
        phoneModelSelect.required = false;
        phoneModelSelect.value = '';
      }
      loadProducts(currentSpecies);
    });
  });

  if (photoInput) {
    photoInput.addEventListener('change', () => {
      const file = photoInput.files[0];
      preview.innerHTML = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = document.createElement('img');
        img.src = e.target.result;
        img.alt = 'Your uploaded photo';
        preview.appendChild(img);
      };
      reader.readAsDataURL(file);
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!productField.value) return;
      orderNote.classList.remove('error');
      orderNote.textContent = 'Redirecting to checkout…';
      submitBtn.disabled = true;

      const formData = new FormData(form);
      formData.append('utmCampaign', getUtmCampaign());
      try {
        const res = await fetch('/api/custom-orders', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        if (data.lowResolution) {
          const proceed = window.confirm(
            `Heads up: this photo is ${data.width}×${data.height}px. It may look soft on a poster or canvas. Continue to checkout anyway?`
          );
          if (!proceed) {
            submitBtn.disabled = false;
            orderNote.textContent = '';
            return;
          }
        }
        try { localStorage.removeItem('whiskr_discount'); } catch (_) {}
        window.location.href = data.url;
      } catch (err) {
        orderNote.textContent = err.message;
        orderNote.classList.add('error');
        submitBtn.disabled = false;
      }
    });
  }

  loadProducts(currentSpecies);
})();

// ---------- checkout form ----------
const checkoutForm = document.getElementById('checkoutForm');
if (checkoutForm) {
  checkoutForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = document.getElementById('checkoutNote');
    const submitBtn = checkoutForm.querySelector('button[type=submit]');
    note.classList.remove('error');
    note.textContent = 'Redirecting to checkout…';
    submitBtn.disabled = true;

    const groupId = document.getElementById('checkoutGroup').value;
    const quantity = document.getElementById('checkoutQty').value;
    const email = document.getElementById('checkoutEmail').value;

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, quantity, email, utmCampaign: getUtmCampaign() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Checkout is not available yet.');
      window.location.href = data.url;
    } catch (err) {
      note.textContent = err.message;
      note.classList.add('error');
      submitBtn.disabled = false;
    }
  });
}
