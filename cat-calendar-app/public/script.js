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
      if (blurbEl) blurbEl.textContent = 'Chosen as Cat of the Month by real public vote. Their calendar is in the shop below.';
    } else if (data.contestId) {
      loadCurrentTeaser();
    }
  } catch (err) {
    console.error('status load failed', err);
  }
}
loadStatus();

// Cat of the Year only runs once annually and stays closed the rest of the
// time — this banner stays hidden/empty whenever no award is open, never a
// fake "coming soon" placeholder.
async function loadYearAwardBanner() {
  const banner = document.getElementById('yearAwardBanner');
  if (!banner) return;
  try {
    const res = await fetch('/api/year-award/current');
    const data = await res.json();
    if (!data.award) { banner.hidden = true; banner.innerHTML = ''; return; }
    const closes = new Date(data.award.closesAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    banner.innerHTML = `
      <div>
        <h2>🏆 ${data.award.label} is open for voting</h2>
        <p>Pick your favorite from this year's Cat of the Month winners — voting closes ${closes}.</p>
      </div>
      <a href="year-award.html" class="btn btn-primary">Vote for Cat of the Year</a>`;
    banner.hidden = false;
  } catch (err) {
    console.error('year award banner load failed', err);
  }
}
loadYearAwardBanner();

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

  let currentSpecies = 'cat';
  let products = [];

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
        body: JSON.stringify({ groupId, quantity, email }),
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
