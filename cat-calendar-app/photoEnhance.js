// Optional AI upscaling for low-resolution customer photos, via Replicate's
// hosted Real-ESRGAN model. Gated behind REPLICATE_API_TOKEN the same way
// printful.js gates behind PRINTFUL_API_KEY: unset, this module is a no-op
// that returns the original photo unchanged, so the app works today and
// this can be turned on later without a code change.
//
// Not exercised against a live Replicate account — no account exists yet
// to test against (same caveat as Printful's Mockup Generator API
// elsewhere in this codebase). Before relying on this for real customers,
// verify: the model still accepts a plain `owner/name` reference without a
// pinned version hash (Replicate's official-model shortcut — confirm
// nightmareai/real-esrgan still qualifies, or pin a version hash via
// REPLICATE_MODEL_VERSION if not), and that the output really is a
// downloadable image URL.
const sharp = require('sharp');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'nightmareai/real-esrgan';
const REPLICATE_BASE = 'https://api.replicate.com/v1';

// Below this on the long edge, Printful's own Smart Image Tool (a
// borderline-DPI nudge, not a real fix — see docs/audit-assembly.md) won't
// be enough for most print products either. 1500px targets "good enough
// for the smaller/cheaper products" (mug, phone case), not a full-bleed
// poster — raise it if you find posters printing soft.
const MIN_LONG_EDGE_PX = Number(process.env.PHOTO_ENHANCE_MIN_PX || 1500);

// Keeps the whole thing inside a Stripe webhook's delivery window and
// Vercel's function timeout (10s on the Hobby plan by default) alongside
// the other work that webhook does (mark paid, submit to Printful, maybe
// send a failure email). If you're on Hobby and see webhook timeouts after
// turning this on, either raise your function's maxDuration in
// vercel.json (Pro plan or above) or lower this further.
const WAIT_SECONDS = Number(process.env.PHOTO_ENHANCE_WAIT_SECONDS || 8);

function configured() {
  return Boolean(REPLICATE_API_TOKEN);
}

// Only false to true triggers an upscale — an already-good photo is left
// alone so you're not paying to "enhance" something that's already fine.
function needsEnhancement(width, height) {
  const longEdge = Math.max(width, height);
  return longEdge > 0 && longEdge < MIN_LONG_EDGE_PX;
}

async function runReplicate(buffer, format) {
  const mimetype = `image/${format === 'jpg' ? 'jpeg' : format || 'jpeg'}`;
  const dataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;

  const res = await fetch(`${REPLICATE_BASE}/models/${REPLICATE_MODEL}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: `wait=${WAIT_SECONDS}`,
    },
    body: JSON.stringify({
      input: {
        image: dataUri,
        scale: 2,
        // GFPGAN's face model is trained on human faces — leaving this off
        // by default rather than risk it "fixing" a cat's face into
        // something uncanny. Turn on with PHOTO_ENHANCE_FACE=true once
        // you've eyeballed some real results.
        face_enhance: process.env.PHOTO_ENHANCE_FACE === 'true',
      },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(`Replicate API error ${res.status}: ${data ? JSON.stringify(data.detail || data) : res.statusText}`);
  }
  if (data.status !== 'succeeded' || !data.output) {
    // Prefer:wait timed out before the model finished, or it failed outright.
    // Either way: don't block the order on it, the caller falls back to the
    // original photo.
    throw new Error(`Replicate prediction did not complete in time (status: ${data.status})`);
  }

  const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  const imgRes = await fetch(outputUrl);
  if (!imgRes.ok) throw new Error(`Failed to download enhanced image: ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

// Enhances buffer if configured and actually low-res; otherwise returns the
// same buffer reference unchanged (callers can use `!==` to detect whether
// anything happened). Never throws — an AI service being slow, down, or
// misconfigured degrades to "customer's original photo," not a broken
// order.
async function enhanceIfNeeded(buffer) {
  if (!configured()) return buffer;
  try {
    const meta = await sharp(buffer).metadata();
    const { width = 0, height = 0, format } = meta;
    if (!needsEnhancement(width, height)) return buffer;
    console.log(`[photoEnhance] upscaling ${width}x${height} ${format} photo (below ${MIN_LONG_EDGE_PX}px)`);
    return await runReplicate(buffer, format);
  } catch (err) {
    console.error('[photoEnhance] enhancement failed, using original photo:', err.message);
    return buffer;
  }
}

module.exports = { configured, needsEnhancement, enhanceIfNeeded, MIN_LONG_EDGE_PX };
