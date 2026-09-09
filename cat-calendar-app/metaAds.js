// Meta Marketing API integration — read-only. This module can only ever
// READ spend numbers; nothing in here can create, pause, resume, or change
// the budget of a real ad campaign. That's a deliberate scope decision
// (see docs/audit-assembly.md): the owner asked for automatic spend/ROAS
// tracking without any automated action on a live ad account — no
// auto-pause, no auto-budget-changes. If that ever changes, it's a new,
// separate module with its own explicit write scope, not an extension of
// this one.
//
// Same pattern as printful.js/stripe elsewhere in this app: if
// META_ACCESS_TOKEN / META_AD_ACCOUNT_ID aren't set, calls return a
// dry-run result instead of throwing, and the marketing ledger just falls
// back to manual spend entry (see /api/admin/marketing/campaigns/:id/spend
// in server.js) — the feature works either way, just without the
// automatic pull.
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // e.g. "act_1234567890", the "act_" prefix included
const META_API_BASE = 'https://graph.facebook.com/v21.0';

function configured() {
  return Boolean(META_ACCESS_TOKEN && META_AD_ACCOUNT_ID);
}

async function metaRequest(path, params = {}) {
  const url = new URL(`${META_API_BASE}${path}`);
  url.searchParams.set('access_token', META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.error ? JSON.stringify(data.error) : res.statusText;
    throw new Error(`Meta API error ${res.status}: ${detail}`);
  }
  return data;
}

// Every campaign on the connected ad account, id + name only — used to
// link an ad_campaigns row to a real Meta campaign by matching name
// (case-insensitive) the first time, then remembered by id afterward (see
// ad_campaigns.meta_campaign_id in db.js) so a later rename in Meta's own
// UI doesn't break the link.
async function listCampaigns() {
  if (!configured()) return { dryRun: true, campaigns: [] };
  const data = await metaRequest(`/${META_AD_ACCOUNT_ID}/campaigns`, {
    fields: 'id,name,status',
    limit: '200',
  });
  return { dryRun: false, campaigns: data.data || [] };
}

// Real spend for one campaign on one calendar day (YYYY-MM-DD), in USD.
// Meta's insights endpoint returns an array (usually 0 or 1 rows for a
// single-day time_range); 0 rows means no spend that day, not an error.
async function getCampaignSpendForDate(metaCampaignId, dateYmd) {
  if (!configured()) return { dryRun: true, amountUsd: 0 };
  const data = await metaRequest(`/${metaCampaignId}/insights`, {
    fields: 'spend',
    time_range: JSON.stringify({ since: dateYmd, until: dateYmd }),
  });
  const row = (data.data || [])[0];
  return { dryRun: false, amountUsd: row ? Number(row.spend) : 0 };
}

module.exports = { configured, listCampaigns, getCampaignSpendForDate };
