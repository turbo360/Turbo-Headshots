// Shirt-logo protection — ported whole from turbo-enhance/src/lib/brandingCheck.ts.
// All geometry is relative to the PERSON bounding box (InSPyReNet alpha matte),
// which survives reframing. Everything here is sharp-only; the matte itself
// comes from the injected replicate client.
const sharp = require('sharp');

/** Bounding box of alpha > threshold, computed on a ≤512px proxy for speed. */
async function alphaBbox(png) {
  const meta = await sharp(png).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error('alpha image has no dimensions');
  const proxyW = Math.min(512, W);
  const scale = proxyW / W;
  const proxyH = Math.max(1, Math.round(H * scale));

  const raw = await sharp(png)
    .ensureAlpha()
    .resize(proxyW, proxyH, { fit: 'fill' })
    .extractChannel('alpha')
    .raw()
    .toBuffer();

  let minX = proxyW, minY = proxyH, maxX = -1, maxY = -1;
  for (let y = 0; y < proxyH; y++) {
    for (let x = 0; x < proxyW; x++) {
      if (raw[y * proxyW + x] > 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('no subject found in alpha matte');

  const inv = 1 / scale;
  const bbox = {
    left: Math.max(0, Math.floor(minX * inv)),
    top: Math.max(0, Math.floor(minY * inv)),
    width: Math.min(W, Math.ceil((maxX - minX + 1) * inv)),
    height: Math.min(H, Math.ceil((maxY - minY + 1) * inv)),
  };
  bbox.width = Math.min(bbox.width, W - bbox.left);
  bbox.height = Math.min(bbox.height, H - bbox.top);
  return { bbox, width: W, height: H };
}

/** Run the InSPyReNet matte and return { png, bbox, width, height }. */
async function personAlpha(client, imageDataUri) {
  const result = await client.runRemoveBackground(imageDataUri);
  const png = await client.urlToBuffer(result.outputUrl);
  const { bbox, width, height } = await alphaBbox(png);
  return { png, bbox, width, height, predictionId: result.predictionId };
}

/** Torso band of the person bbox — vertical 28–92%, horizontal 8–92%. */
function torsoRegion(bbox, imgW, imgH) {
  const left = Math.max(0, Math.round(bbox.left + bbox.width * 0.08));
  const top = Math.max(0, Math.round(bbox.top + bbox.height * 0.28));
  const right = Math.min(imgW, Math.round(bbox.left + bbox.width * 0.92));
  const bottom = Math.min(imgH, Math.round(bbox.top + bbox.height * 0.92));
  return {
    left, top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Crop a region (inputs must already be orientation-normalised), JPEG q95. */
async function cropRegion(image, region, maxSide = 2048) {
  let p = sharp(image).extract(region);
  if (Math.max(region.width, region.height) > maxSide) {
    p = p.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true });
  }
  return p.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function toGrey(buf, maxSide) {
  const meta = await sharp(buf).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(8, Math.round(W * scale));
  const h = Math.max(8, Math.round(H * scale));
  const raw = await sharp(buf).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer();
  const px = new Float32Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = raw[i];
  return { px, w, h };
}

async function toChroma(buf, w, h) {
  const raw = await sharp(buf).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    out[i] = Math.max(r, g, b) - Math.min(r, g, b); // crude saturation
  }
  return out;
}

/** Presence probe only — no automated ok/mangled verdict, by design. */
async function brandingPresence(inputTorso) {
  const inGrey = await toGrey(inputTorso, 256);
  const inChroma = await toChroma(inputTorso, inGrey.w, inGrey.h);
  const WIN = Math.min(40, Math.floor(Math.min(inGrey.w, inGrey.h) / 2));
  let best = 0;
  for (let y = 0; y + WIN <= inGrey.h; y += 8) {
    for (let x = 0; x + WIN <= inGrey.w; x += 8) {
      let chroma = 0, edges = 0;
      for (let j = 0; j < WIN; j++) {
        for (let i = 0; i < WIN - 1; i++) {
          const idx = (y + j) * inGrey.w + (x + i);
          chroma += inChroma[idx];
          edges += Math.abs(inGrey.px[idx + 1] - inGrey.px[idx]);
        }
      }
      const norm = WIN * WIN;
      const sc = (chroma / norm) * 0.6 + (edges / norm) * 1.0;
      if (sc > best) best = sc;
    }
  }
  return { hasBranding: best >= 14 };
}

/**
 * "Original framing" hard guarantee: warp the ORIGINAL clothing pixels into
 * the output's person geometry (bbox similarity transform, luminance-matched,
 * head band excluded, feathered). Gated on aspect stability (≤12% drift) and
 * plausible scale (0.4–3×) — beyond that, skip rather than smear.
 */
async function pixelLockWithKnownBoxes(original, generated, alpha, generatedBox, generatedW, generatedH) {
  const origMeta = await sharp(original).metadata();
  const W = origMeta.width ?? 0;
  const H = origMeta.height ?? 0;
  if (!W || !H) return { ok: false, reason: 'original has no dimensions' };

  const inBox = alpha.bbox;
  const sx = generatedBox.width / Math.max(1, inBox.width);
  const sy = generatedBox.height / Math.max(1, inBox.height);
  const aspectDrift = Math.abs(sx / sy - 1);
  if (aspectDrift > 0.12) {
    return { ok: false, reason: `pose/framing changed beyond a zoom (aspect drift ${(aspectDrift * 100).toFixed(0)}%)` };
  }
  if (sx < 0.4 || sx > 3 || sy < 0.4 || sy > 3) {
    return { ok: false, reason: 'person scale changed implausibly' };
  }

  const scaledW = Math.max(2, Math.round(W * sx));
  const scaledH = Math.max(2, Math.round(H * sy));
  const dx = Math.round(generatedBox.left - inBox.left * sx);
  const dy = Math.round(generatedBox.top - inBox.top * sy);

  // Clothing mask in input coords: person alpha minus the head band (top 30%).
  const headBandBottom = Math.round(inBox.top + inBox.height * 0.3);
  const alphaRaw = await sharp(alpha.png)
    .ensureAlpha()
    .resize(W, H, { fit: 'fill' })
    .extractChannel('alpha')
    .raw()
    .toBuffer();
  const headClear = Math.min(H, Math.max(0, headBandBottom));
  alphaRaw.fill(0, 0, headClear * W);

  // Luminance match BEFORE warping (stats in each image's own torso).
  const inTorso = torsoRegion(inBox, W, H);
  const outTorso = torsoRegion(generatedBox, generatedW, generatedH);
  async function lumStats(buf, region) {
    const stats = await sharp(buf).extract(region).greyscale().stats();
    const c = stats.channels[0];
    return { mean: c.mean, std: Math.max(1, c.stdev) };
  }
  const [orig, gen] = await Promise.all([
    lumStats(original, inTorso),
    lumStats(generated, outTorso),
  ]);
  const aRaw = gen.std / orig.std;
  const a = 1 + (aRaw - 1) * 0.5;
  const b = (gen.mean - orig.mean * aRaw) * 0.5;

  const left = Math.max(0, dx);
  const top = Math.max(0, dy);
  const cropLeft = Math.max(0, -dx);
  const cropTop = Math.max(0, -dy);
  const cropW = Math.min(scaledW - cropLeft, generatedW - left);
  const cropH = Math.min(scaledH - cropTop, generatedH - top);
  if (cropW < 2 || cropH < 2) return { ok: false, reason: 'warped clothing falls outside the frame' };

  const litScaled = await sharp(original)
    .linear(a, b)
    .resize(scaledW, scaledH, { fit: 'fill' })
    .removeAlpha()
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .toBuffer();
  const maskScaled = await sharp(alphaRaw, { raw: { width: W, height: H, channels: 1 } })
    .resize(scaledW, scaledH, { fit: 'fill' })
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .blur(10)
    .raw()
    .toBuffer();

  const clothingLayer = await sharp(litScaled)
    .joinChannel(maskScaled, { raw: { width: cropW, height: cropH, channels: 1 } })
    .png()
    .toBuffer();

  const out = await sharp(generated)
    .composite([{ input: clothingLayer, left, top }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return { ok: true, buffer: out };
}

module.exports = { personAlpha, torsoRegion, cropRegion, brandingPresence, pixelLockWithKnownBoxes };
