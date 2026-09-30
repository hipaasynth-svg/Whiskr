// /commission — the rate card, the paired gallery, and the deposit booking
// form. Every price shown here comes from the server (see
// /api/commissions/pricing and /api/commissions/quote) rather than being
// computed in the browser, so the number a customer reads is by construction
// the number their card is charged.
(function commissionPage() {
  const form = document.getElementById('commissionForm');
  if (!form) return;

  const sizeSel = document.getElementById('cSize');
  const rushBox = document.getElementById('cRush');
  const rushLabel = document.getElementById('rushLabel');
  const petsSel = document.getElementById('cExtraPets');
  const photoInput = document.getElementById('cPhoto');
  const preview = document.getElementById('cPreview');
  const quoteBox = document.getElementById('quoteBox');
  const submitBtn = document.getElementById('cSubmit');
  const note = document.getElementById('cNote');

  let pricing = null;

  function money(n) {
    return '$' + Number(n).toFixed(2).replace(/\.00$/, '');
  }

  // Every fetch on this page is bounded. A page that sits forever on
  // "Loading…" is worse than one that says it failed and offers a retry —
  // the visitor at least knows to try again instead of assuming we're shut.
  async function getJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error('Request failed (' + res.status + ')');
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- rate card ----------
  function renderRateCard() {
    const rows = document.getElementById('rateRows');
    rows.innerHTML = '';
    pricing.sizes.forEach((s) => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = s.label;
      const td2 = document.createElement('td');
      td2.className = 'amount';
      td2.textContent = money(s.priceUsd);
      tr.appendChild(td1);
      tr.appendChild(td2);
      rows.appendChild(tr);
    });

    document.getElementById('rateExtras').textContent =
      'Rush (finished in under ' + pricing.rushDays + ' days) adds ' + money(pricing.rushUsd) +
      '. Each extra cat in the same painting adds ' + money(pricing.extraPetUsd) + '.';

    document.getElementById('rateTerms').textContent =
      pricing.depositPercent + '% deposit books your spot; the balance is due before it ships. Finished ' +
      pricing.timeline + '.';

    document.getElementById('depositExplainer').textContent =
      'You pay the ' + pricing.depositPercent + '% deposit now to hold a slot. The balance is not charged ' +
      'automatically — when the painting is finished you get a photo of it and a payment link, so you see ' +
      'the work before paying the rest.';

    rushLabel.textContent = 'Rush — finished in under ' + pricing.rushDays + ' days (+' + money(pricing.rushUsd) + ')';

    pricing.sizes.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label + ' — ' + money(s.priceUsd);
      sizeSel.appendChild(opt);
    });

    for (let i = 1; i <= pricing.maxExtraPets; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = (i + 1) + ' cats (+' + money(pricing.extraPetUsd * i) + ')';
      petsSel.appendChild(opt);
    }
  }

  async function loadPricing() {
    try {
      pricing = await getJson('/api/commissions/pricing');
      renderRateCard();
    } catch (err) {
      // The form is useless without a rate card, so fail loudly and let
      // them reach a human rather than leaving a dead form on screen.
      const rows = document.getElementById('rateRows');
      rows.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2;
      td.className = 'rate-note';
      td.textContent = "Couldn't load current prices. Refresh, or email contest@whiskr.lol and we'll quote you directly.";
      tr.appendChild(td);
      rows.appendChild(tr);
      submitBtn.textContent = 'Prices unavailable — email us';
      submitBtn.disabled = true;
    }
  }

  // ---------- live quote ----------
  let quoteSeq = 0;
  async function refreshQuote() {
    if (!sizeSel.value) {
      quoteBox.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Choose a size first';
      return;
    }
    const seq = ++quoteSeq;
    const params = new URLSearchParams({
      size: sizeSel.value,
      rush: rushBox.checked ? '1' : '0',
      extraPets: petsSel.value || '0',
    });
    try {
      const q = await getJson('/api/commissions/quote?' + params.toString());
      // A slower earlier request must never overwrite a newer quote.
      if (seq !== quoteSeq) return;

      quoteBox.innerHTML = '';
      q.lines.forEach((l) => {
        const row = document.createElement('div');
        row.className = 'line';
        const label = document.createElement('span');
        label.textContent = l.label;
        const amt = document.createElement('span');
        amt.textContent = money(l.amountUsd);
        row.appendChild(label);
        row.appendChild(amt);
        quoteBox.appendChild(row);
      });

      const totalRow = document.createElement('div');
      totalRow.className = 'line total';
      const tl = document.createElement('span');
      tl.textContent = 'Total';
      const ta = document.createElement('span');
      ta.textContent = money(q.totalUsd);
      totalRow.appendChild(tl);
      totalRow.appendChild(ta);
      quoteBox.appendChild(totalRow);

      const dueRow = document.createElement('div');
      dueRow.className = 'line due';
      const dl = document.createElement('span');
      dl.textContent = 'Due today (' + pricing.depositPercent + '% deposit)';
      const da = document.createElement('span');
      da.textContent = money(q.depositUsd);
      dueRow.appendChild(dl);
      dueRow.appendChild(da);
      quoteBox.appendChild(dueRow);

      const laterRow = document.createElement('div');
      laterRow.className = 'line';
      const ll = document.createElement('span');
      ll.textContent = 'Balance, before it ships';
      const la = document.createElement('span');
      la.textContent = money(q.balanceUsd);
      laterRow.appendChild(ll);
      laterRow.appendChild(la);
      quoteBox.appendChild(laterRow);

      quoteBox.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Reserve with ' + money(q.depositUsd) + ' deposit';
    } catch (err) {
      if (seq !== quoteSeq) return;
      quoteBox.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Couldn't price that — try again";
    }
  }

  [sizeSel, rushBox, petsSel].forEach((el) => el.addEventListener('change', refreshQuote));

  // ---------- paired gallery ----------
  // Shows only rows that have BOTH images: the pairing (this photo became
  // this painting) is the entire point, and a lone painting doesn't prove it.
  async function loadGallery() {
    const wrap = document.getElementById('pairGallery');
    const empty = document.getElementById('galleryEmpty');
    try {
      const data = await getJson('/api/originals');
      const pairs = (data.originals || []).filter((o) => o.image_path && o.source_photo_path).slice(0, 3);
      if (pairs.length === 0) {
        empty.hidden = false;
        return;
      }
      pairs.forEach((o) => {
        const card = document.createElement('div');
        card.className = 'pair';
        const imgs = document.createElement('div');
        imgs.className = 'pair-images';

        [['The photo', o.source_photo_path], ['The painting', o.image_path]].forEach(([capText, src]) => {
          const fig = document.createElement('figure');
          const img = document.createElement('img');
          img.src = src;
          img.loading = 'lazy';
          // cat_name is entrant-supplied: assigned as a property, never
          // interpolated into markup.
          img.alt = o.cat_name ? capText + ' of ' + o.cat_name : capText;
          const cap = document.createElement('figcaption');
          cap.textContent = capText;
          fig.appendChild(img);
          fig.appendChild(cap);
          imgs.appendChild(fig);
        });

        card.appendChild(imgs);
        if (o.cat_name) {
          const caption = document.createElement('div');
          caption.className = 'pair-caption';
          caption.textContent = o.cat_name;
          card.appendChild(caption);
        }
        wrap.appendChild(card);
      });
      wrap.hidden = false;
    } catch (err) {
      // A gallery that won't load must not hide the rate card or the form.
      empty.hidden = false;
    }
  }

  // ---------- photo preview ----------
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    preview.innerHTML = '';
    if (!file) return;
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = 'Your reference photo';
    img.onload = () => URL.revokeObjectURL(img.src);
    preview.appendChild(img);
  });

  // ---------- booking ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    note.classList.remove('error');
    note.textContent = 'Setting up your deposit…';
    submitBtn.disabled = true;

    try {
      const formData = new FormData(form);
      // Same Vercel 4.5MB body-limit guard every other upload form uses.
      const photoFile = photoInput.files[0];
      if (photoFile) formData.set('photo', await resizeImageForUpload(photoFile));

      const res = await fetch('/api/commissions', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      if (data.lowResolution) {
        note.textContent = "Booked — heads up, that photo is a little soft. Cody may email you for a sharper one. Redirecting…";
      }
      window.location.href = data.url;
    } catch (err) {
      note.textContent = err.message;
      note.classList.add('error');
      submitBtn.disabled = false;
    }
  });

  // ---------- post-checkout states ----------
  const params = new URLSearchParams(window.location.search);
  if (params.get('booked') === '1') {
    note.textContent = "Deposit received — check your email for the confirmation. Cody will be in touch if he needs a better reference photo.";
  } else if (params.get('paid') === '1') {
    note.textContent = 'Balance received. Your painting gets varnished, packed and shipped.';
  }

  loadPricing().then(refreshQuote);
  loadGallery();
})();
