// /winners — the archive. Its job is proof: this contest really does run
// every month, a real cat really does win, and a real painting really does
// get made. Everything on it is a row someone actually created; nothing is
// stubbed to make the page look fuller.
(function winnersPage() {
  const list = document.getElementById('winnersList');
  if (!list) return;

  const loading = document.getElementById('winnersLoading');
  const empty = document.getElementById('winnersEmpty');
  const errorBox = document.getElementById('winnersError');

  function show(el) {
    loading.hidden = true;
    empty.hidden = true;
    errorBox.hidden = true;
    if (el) el.hidden = false;
  }

  // Every string below is entrant- or owner-supplied and is assigned as
  // text, never interpolated into markup.
  function card(w) {
    const wrap = document.createElement('div');
    wrap.className = 'winner-round';

    const label = document.createElement('div');
    label.className = 'round-label';
    const name = document.createElement('span');
    name.textContent = w.label;
    label.appendChild(name);
    if (w.closedAt) {
      const closed = document.createElement('span');
      closed.className = 'closed';
      closed.textContent =
        'Voting closed ' +
        new Date(w.closedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      label.appendChild(closed);
    }
    wrap.appendChild(label);

    const cardEl = document.createElement('div');
    cardEl.className = 'winner-card';

    const pair = document.createElement('div');
    pair.className = 'winner-pair';

    // The entered photo — always present, it is how they won.
    const photoFig = document.createElement('figure');
    const photo = document.createElement('img');
    photo.src = w.photoPath;
    photo.alt = w.catName + ', the winning photo';
    photo.loading = 'lazy';
    const photoCap = document.createElement('figcaption');
    photoCap.textContent = 'The photo';
    photoFig.appendChild(photo);
    photoFig.appendChild(photoCap);
    pair.appendChild(photoFig);

    // The painting — or an honest note that it is still being painted. A
    // round closes on a date; the painting takes two to four weeks after.
    const paintFig = document.createElement('figure');
    if (w.paintingPath) {
      const painting = document.createElement('img');
      painting.src = w.paintingPath;
      painting.alt = 'The original acrylic painting of ' + w.catName;
      painting.loading = 'lazy';
      const paintCap = document.createElement('figcaption');
      paintCap.textContent = 'The painting';
      paintFig.appendChild(painting);
      paintFig.appendChild(paintCap);
    } else {
      const pending = document.createElement('div');
      pending.className = 'painting-pending';
      pending.textContent = w.catName + "'s painting is being painted now. It goes up here when it's finished.";
      paintFig.appendChild(pending);
    }
    pair.appendChild(paintFig);
    cardEl.appendChild(pair);

    const body = document.createElement('div');
    body.className = 'winner-body';

    const h = document.createElement('h2');
    h.className = 'winner-name';
    h.textContent = w.catName;
    body.appendChild(h);

    if (w.story) {
      const story = document.createElement('p');
      story.className = 'winner-story';
      story.textContent = w.story;
      body.appendChild(story);
    }

    const ctas = document.createElement('div');
    ctas.className = 'winner-ctas';

    const commission = document.createElement('a');
    commission.className = 'btn btn-primary';
    commission.href = '/commission';
    commission.textContent = 'Commission this style';
    ctas.appendChild(commission);

    const print = document.createElement('a');
    print.className = 'btn btn-ghost';
    print.style.color = 'var(--ink)';
    print.style.borderColor = 'var(--ink)';
    print.href = 'index.html#shop-custom';
    print.textContent = 'Put your cat on a print';
    ctas.appendChild(print);

    body.appendChild(ctas);
    cardEl.appendChild(body);
    wrap.appendChild(cardEl);
    return wrap;
  }

  async function load() {
    list.innerHTML = '';
    show(null);
    loading.hidden = false;

    // Bounded, like every other fetch on this site.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('/api/winners', { signal: controller.signal });
      if (!res.ok) return show(errorBox);
      const data = await res.json();
      const winners = data.winners || [];
      if (winners.length === 0) return show(empty);

      winners.forEach((w) => list.appendChild(card(w)));
      show(null);
    } catch (err) {
      show(errorBox);
    } finally {
      clearTimeout(timer);
    }
  }

  document.getElementById('winnersRetry').addEventListener('click', load);
  load();
})();
