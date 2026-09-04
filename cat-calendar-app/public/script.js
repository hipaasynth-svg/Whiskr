// ---------- hero slideshow ----------
// Pulls a handful of random cat photos from the free cataas.com service as
// placeholder hero imagery. Swap SLIDE_COUNT/urls for your own photography
// whenever you're ready — see README.
(function heroSlideshow() {
  const SLIDE_COUNT = 6;
  const track = document.getElementById('heroSlides');
  const dotsWrap = document.getElementById('heroDots');
  const pauseBtn = document.getElementById('heroPause');
  if (!track) return;

  const urls = Array.from({ length: SLIDE_COUNT }, (_, i) =>
    `https://cataas.com/cat?width=1600&height=1000&t=${Date.now()}_${i}`
  );

  urls.forEach((src, i) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = i === 0 ? 'eager' : 'lazy';
    if (i === 0) img.classList.add('active');
    track.appendChild(img);

    const dot = document.createElement('span');
    if (i === 0) dot.classList.add('active');
    dotsWrap.appendChild(dot);
  });

  const slides = track.querySelectorAll('img');
  const dots = dotsWrap.querySelectorAll('span');
  let index = 0;
  let paused = false;

  function show(i) {
    slides[index].classList.remove('active');
    dots[index].classList.remove('active');
    index = (i + slides.length) % slides.length;
    slides[index].classList.add('active');
    dots[index].classList.add('active');
  }

  let timer = setInterval(() => {
    if (!paused) show(index + 1);
  }, 4500);

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Play' : 'Pause';
  });

  dots.forEach((dot, i) => dot.addEventListener('click', () => show(i)));
})();

// ---------- live batch status ----------
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const spotsLeftEl = document.getElementById('spotsLeft');
    if (spotsLeftEl) {
      spotsLeftEl.textContent =
        data.spotsLeft > 0
          ? `${data.spotsLeft} of ${data.groupSize} spots left in the batch that's currently filling.`
          : `This batch just sealed — the next one is now open.`;
    }

    const nameEl = document.getElementById('winnerName');
    const photoEl = document.getElementById('winnerPhoto');
    const blurbEl = document.getElementById('winnerBlurb');
    if (data.lastWinner && nameEl && photoEl) {
      nameEl.textContent = data.lastWinner.cat_name;
      photoEl.src = data.lastWinner.photo_path;
      photoEl.alt = `${data.lastWinner.cat_name}, Cat of the Month`;
      if (blurbEl) blurbEl.textContent = `Chosen as Cat of the Month by the last batch's judging. Their calendar — with the other 11 finalists — is in the shop below.`;
    }
  } catch (err) {
    console.error('status load failed', err);
  }
}
loadStatus();

// ---------- entry form ----------
const entryForm = document.getElementById('entryForm');
if (entryForm) {
  entryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = document.getElementById('entryNote');
    const submitBtn = entryForm.querySelector('button[type=submit]');
    note.classList.remove('error');
    note.textContent = 'Submitting…';
    submitBtn.disabled = true;

    const formData = new FormData(entryForm);

    try {
      const res = await fetch('/api/submissions', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      note.textContent = data.groupSealed
        ? "You're the 12th cat in — judging starts now. Check your email in a few weeks."
        : "You're entered! We'll email you once your batch of 12 fills up and judging closes.";
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

  let currentSpecies = 'cat';
  let products = [];

  async function loadProducts(species) {
    grid.innerHTML = '<p style="color:#6b6552;">Loading…</p>';
    try {
      const res = await fetch(`/api/products?species=${encodeURIComponent(species)}`);
      const data = await res.json();
      products = data.products || [];
      renderGrid();
    } catch (err) {
      grid.innerHTML = '<p style="color:#6b6552;">Could not load products right now.</p>';
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
