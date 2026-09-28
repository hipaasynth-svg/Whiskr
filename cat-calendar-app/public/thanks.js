// /thanks — the page an entrant lands on the moment they enter, and the one
// their confirmation email links back to. Its whole job is turning one entry
// into shared votes, then offering a print and an original without getting
// in the way of that.
(function thanksPage() {
  const wrap = document.getElementById('thanksContent');
  if (!wrap) return;

  const loading = document.getElementById('thanksLoading');
  const errorBox = document.getElementById('thanksError');
  const params = new URLSearchParams(window.location.search);

  function money(n) {
    return '$' + Number(n).toFixed(2).replace(/\.00$/, '');
  }

  function fail(message) {
    loading.hidden = true;
    wrap.hidden = true;
    if (message) document.getElementById('thanksErrorMsg').textContent = message;
    errorBox.hidden = false;
  }

  async function load() {
    const cat = params.get('cat');
    const email = params.get('email');
    const token = params.get('token');
    if (!cat || !email || !token) {
      return fail('This link is missing part of its address — it may have been cut short when it was copied.');
    }

    // Bounded, like every other fetch on this site: a page that sits on a
    // skeleton forever tells the visitor nothing.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let data;
    try {
      const res = await fetch(
        '/api/thanks?cat=' + encodeURIComponent(cat) +
          '&email=' + encodeURIComponent(email) +
          '&token=' + encodeURIComponent(token),
        { signal: controller.signal }
      );
      if (res.status === 403 || res.status === 404) {
        return fail('This link is not valid for an entry we can find.');
      }
      if (!res.ok) return fail("We couldn't reach the server just now. Refresh in a moment.");
      data = await res.json();
    } catch (err) {
      return fail(
        err && err.name === 'AbortError'
          ? 'That took too long to load. Refresh to try again.'
          : "We couldn't reach the server just now. Refresh in a moment."
      );
    } finally {
      clearTimeout(timer);
    }

    render(data);
  }

  function render(data) {
    const name = data.catName || 'Your cat';

    // Every cat name below is assigned as text, never interpolated into
    // markup — it is entrant-supplied and this app has fixed a stored-XSS
    // bug from exactly that pattern before.
    document.getElementById('thanksTitle').textContent = "You're in.";
    document.getElementById('thanksSub').textContent = name + ' needs votes.';
    document.getElementById('catNameB').textContent = name;

    if (data.disqualified) {
      return fail('This entry is no longer active. Reply to your confirmation email if that looks wrong.');
    }

    if (data.closesAt) {
      const closes = new Date(data.closesAt);
      const line = document.getElementById('closesLine');
      // Central time, stated explicitly, because "11:59pm" with no zone is
      // the kind of detail that generates support email.
      line.textContent =
        'Voting closes ' +
        closes.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Chicago' }) +
        ' at 11:59 p.m. CT';
      line.hidden = false;
    }

    // ---------- Block A ----------
    const voteUrl = data.voteUrl;
    const field = document.getElementById('voteUrlField');
    field.value = voteUrl;

    const copyBtn = document.getElementById('copyBtn');
    const copyNote = document.getElementById('copyNote');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(voteUrl);
        copyNote.textContent = 'Copied. Now paste it to someone.';
      } catch (err) {
        // Clipboard access is refused in plenty of ordinary situations
        // (no HTTPS, an in-app browser, a permissions policy). Select the
        // text so the visitor can copy it by hand instead of being stuck.
        field.focus();
        field.select();
        copyNote.textContent = 'Press Ctrl/Cmd+C to copy the selected link.';
      }
    });

    // Prefilled share text. Written to be sendable as-is — a share button
    // that opens an empty compose box gets abandoned.
    const shareText = 'I entered ' + name + " in Whiskr's cat contest. One free click to vote:";
    const encoded = encodeURIComponent(shareText + ' ' + voteUrl);

    const shares = [
      {
        label: 'Text it',
        hint: 'iMessage, WhatsApp, anywhere',
        run: () => {
          // sms: with a prefilled body; falls back to the share sheet.
          if (navigator.share) {
            navigator.share({ text: shareText, url: voteUrl }).catch(() => {});
          } else {
            window.location.href = 'sms:?&body=' + encoded;
          }
        },
      },
      {
        label: 'Facebook',
        hint: 'Post the link',
        run: () => {
          window.open(
            'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(voteUrl),
            '_blank',
            'noopener,width=600,height=500'
          );
        },
      },
      {
        label: 'Copy for Instagram',
        hint: 'Caption + link, for your story',
        run: async () => {
          const caption = shareText + ' ' + voteUrl;
          try {
            await navigator.clipboard.writeText(caption);
            copyNote.textContent = 'Caption copied — paste it into your story or bio.';
          } catch (err) {
            field.value = caption;
            field.focus();
            field.select();
            copyNote.textContent = 'Press Ctrl/Cmd+C to copy the caption.';
          }
        },
      },
    ];

    const grid = document.getElementById('shareGrid');
    shares.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'share-btn';
      const strong = document.createElement('strong');
      strong.textContent = s.label;
      const span = document.createElement('span');
      span.textContent = s.hint;
      btn.appendChild(strong);
      btn.appendChild(span);
      btn.addEventListener('click', s.run);
      grid.appendChild(btn);
    });

    // The share card is generated server-side at entry time. It is optional
    // by design — generation failure never blocks an entry — so the block
    // only appears when one actually exists.
    if (data.shareImageUrl) {
      const preview = document.getElementById('cardPreview');
      const img = document.getElementById('shareCardImg');
      img.src = data.shareImageUrl;
      img.alt = 'A share card showing ' + name + ' and the link to vote';
      preview.hidden = false;

      document.getElementById('saveCardBtn').addEventListener('click', async () => {
        // Share the real image where the browser supports it, since a photo
        // posts far better than a bare link; otherwise download it.
        try {
          if (navigator.canShare) {
            const resp = await fetch(data.shareImageUrl);
            const blob = await resp.blob();
            const file = new File([blob], 'vote-for-' + name.replace(/[^\w-]+/g, '-') + '.png', { type: blob.type });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], text: shareText, url: voteUrl });
              return;
            }
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return; // they closed the sheet
        }
        const a = document.createElement('a');
        a.href = data.shareImageUrl;
        a.download = 'vote-for-' + name.replace(/[^\w-]+/g, '-') + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    }

    // ---------- Block B ----------
    if (data.discount && data.discount.percent > 0) {
      const badge = document.getElementById('discountBadge');
      badge.textContent = data.discount.percent + '% off, already applied';
      badge.hidden = false;
      // Stored the same way the entry form stores it, so the shop's existing
      // applyStoredDiscount() picks it up at checkout rather than this page
      // inventing a second discount mechanism.
      if (typeof storeDiscount === 'function') storeDiscount(data.discount);
    }

    const offerGrid = document.getElementById('offerGrid');
    (data.offers || []).forEach((p) => {
      const card = document.createElement('div');
      card.className = 'offer';

      const shot = document.createElement('div');
      shot.className = 'shot';
      const img = document.createElement('img');
      // Their own uploaded photo, shown at the product's real aspect ratio.
      // Not a photorealistic on-product mockup — this is honestly "your
      // photo, at this shape", which is what we can actually produce.
      img.src = data.photoPath;
      img.alt = name + ', shown at the shape of a ' + p.name;
      img.style.aspectRatio = p.mockupAspect;
      img.loading = 'lazy';
      shot.appendChild(img);
      card.appendChild(shot);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = p.name;
      meta.appendChild(nm);

      const priceWrap = document.createElement('div');
      const pct = data.discount && data.discount.percent ? data.discount.percent : 0;
      const finalPrice = pct ? Math.round(p.priceUsd * (1 - pct / 100) * 100) / 100 : p.priceUsd;
      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = money(finalPrice);
      priceWrap.appendChild(price);
      if (pct) {
        const was = document.createElement('span');
        was.className = 'was';
        was.textContent = money(p.priceUsd);
        priceWrap.appendChild(was);
      }
      meta.appendChild(priceWrap);

      const link = document.createElement('a');
      link.className = 'btn btn-primary';
      link.href = 'index.html#shop-custom';
      link.textContent = 'Order this';
      meta.appendChild(link);

      card.appendChild(meta);
      offerGrid.appendChild(card);
    });

    if (data.lowResolution) {
      const note = document.getElementById('lowResNote');
      note.textContent =
        'Heads up: this photo is ' + data.photoWidth + '\u00d7' + data.photoHeight +
        'px. It is fine on a mug, but a poster or canvas may look a little soft. ' +
        'Reply to your confirmation email with a sharper photo and we will swap it.';
      note.hidden = false;
    }

    // ---------- Block C ----------
    if (data.commission) {
      document.getElementById('commissionSub').textContent =
        '11x16 original ' + money(data.commission.fromUsd) + '. ' +
        data.commission.depositPercent + '% deposit holds your spot.';
    }

    if (data.statusUrl) document.getElementById('statusLink').href = data.statusUrl;

    loading.hidden = true;
    wrap.hidden = false;
  }

  load();
})();
