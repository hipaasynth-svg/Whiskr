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
      if (blurbEl) blurbEl.textContent = `Voted Cat of the Month by the last batch. Their calendar — with the other 11 finalists — is in the shop below.`;
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
        ? "You're the 12th cat in — voting starts now. Check your email in a few weeks."
        : "You're entered! We'll email you once your batch of 12 fills up and voting closes.";
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
