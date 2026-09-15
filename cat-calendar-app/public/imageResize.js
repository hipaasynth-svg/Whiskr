// Shared by every photo-upload form on the site (contest entry, custom
// print order, and every admin.html photo upload). Vercel's serverless
// functions reject any request body over ~4.5MB at the edge — before our
// own code, and its friendlier error messages, ever run. A modern phone
// photo routinely comes in well over that (10-25MB+ at full resolution),
// so without this, a real entrant or paying customer's submission just
// fails outright with a raw platform error, and we never even find out —
// it never reaches server.js, so nothing gets logged or alerted on. This
// downscales/recompresses oversized photos in the browser first so the
// upload actually goes through. 3000px comfortably clears
// MIN_PRINT_DIMENSION_PX (2000, see server.js) so print-quality checks
// aren't affected by this for any normal photo.
async function resizeImageForUpload(file, opts) {
  const maxDimension = (opts && opts.maxDimension) || 3000;
  const maxBytes = (opts && opts.maxBytes) || 4 * 1024 * 1024;
  const startQuality = (opts && opts.quality) || 0.9;

  if (!file || !file.type || !file.type.startsWith('image/') || file.type === 'image/gif') return file;
  if (file.size <= maxBytes) return file;
  if (typeof createImageBitmap !== 'function') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    let quality = startQuality;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    // A very detailed/high-resolution photo can still be too big even after
    // the dimension cap — step quality down a few times rather than give up.
    for (let attempt = 0; blob && blob.size > maxBytes && attempt < 4; attempt++) {
      quality = Math.max(0.4, quality - 0.15);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }
    if (!blob) return file;

    const newName = file.name.replace(/\.\w+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg' });
  } catch (err) {
    console.error('image resize before upload failed, uploading original file', err);
    return file;
  }
}
