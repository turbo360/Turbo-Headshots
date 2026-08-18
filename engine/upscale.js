// Print upscale — ported from turbo-enhance/src/lib/upscale.ts.
// Real-ESRGAN's hosted GPU OOMs reproducibly at 2.0M input px × scale 4 (as of
// Aug 2026), so the input is capped at 1.55M px → ≈24.8MP output (A2 @ 300dpi
// class). Pure pixel upscaler — never alters content.
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const MAX_INPUT_PIXELS = 1_550_000;
const DEFAULT_SCALE = 4;

/**
 * @param {import('./replicateClient').ReplicateClient} client
 * @param {Buffer} sourceBuf the 4K render
 * @param {string} outPath where to write the upscaled JPEG
 */
async function upscaleToPrint(client, sourceBuf, outPath) {
  // Cache is only valid for the SAME source render — a re-rendered frame must
  // not serve the previous render's print.
  const srcHash = crypto.createHash('sha1').update(sourceBuf).digest('hex');
  const hashPath = `${outPath}.src.sha1`;
  if (fs.existsSync(outPath)) {
    try {
      if (fs.readFileSync(hashPath, 'utf-8') === srcHash) {
        return { outPath, cached: true, predictionId: null };
      }
    } catch { /* no hash sidecar — treat as stale */ }
  }
  const meta = await sharp(sourceBuf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  let resizedBuf;
  if (w * h > MAX_INPUT_PIXELS) {
    const scale = Math.sqrt(MAX_INPUT_PIXELS / (w * h));
    resizedBuf = await sharp(sourceBuf)
      .resize(Math.floor(w * scale), Math.floor(h * scale), { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();
  } else {
    resizedBuf = await sharp(sourceBuf).jpeg({ quality: 95 }).toBuffer();
  }

  const result = await client.runRealEsrgan({
    image: `data:image/jpeg;base64,${resizedBuf.toString('base64')}`,
    scale: DEFAULT_SCALE,
    face_enhance: false,
  });
  const outBuf = await client.urlToBuffer(result.outputUrl);
  fs.writeFileSync(outPath, outBuf);
  try { fs.writeFileSync(hashPath, srcHash); } catch { /* best effort */ }
  return { outPath, cached: false, predictionId: result.predictionId };
}

module.exports = { upscaleToPrint, MAX_INPUT_PIXELS, DEFAULT_SCALE };
