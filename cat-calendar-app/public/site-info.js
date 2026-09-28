// Fills in the support email / mailing address on policy pages from the
// server's env (SUPPORT_EMAIL, BUSINESS_MAILING_ADDRESS) so they're set in
// one place instead of hard-coded into every page.
(async function siteInfo() {
  try {
    const res = await fetch('/api/site-info');
    const info = await res.json();
    document.querySelectorAll('[data-support-email]').forEach((el) => {
      if (!info.supportEmail) return;
      const a = document.createElement('a');
      a.href = `mailto:${info.supportEmail}`;
      a.textContent = info.supportEmail;
      el.replaceChildren(a);
    });
    document.querySelectorAll('[data-mailing-address]').forEach((el) => {
      if (info.mailingAddress) el.textContent = info.mailingAddress;
      else el.closest('[data-hide-if-empty]')?.remove();
    });
  } catch (_) {}
})();
