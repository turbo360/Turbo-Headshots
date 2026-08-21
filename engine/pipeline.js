// The headshot engine pipeline — one work item = one frame × one backdrop.
// Stage ordering ports turbo-enhance/src/app/api/headshot/route.ts; the
// crop+export stage runs the v1 face-detect/crop on the 4K render.
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { buildHeadshotPrompt } = require('./prompts');
const guard = require('./brandingGuard');
const local = require('./localPipeline');
const birefnetLocal = require('./birefnetLocal');
const { upscaleToPrint } = require('./upscale');

/** Local-engine cutout: BiRefNet worker when installed (Replicate-parity hair
    edges), else reuse the guard-out mask, else a fresh Vision mask. */
async function localCutout(renderBuf, outAlpha, locked, sidecar, flags) {
  if (birefnetLocal.available()) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpIn = path.join(os.tmpdir(), `th-matte-${stamp}.jpg`);
    const tmpOut = path.join(os.tmpdir(), `th-matte-${stamp}.png`);
    fs.writeFileSync(tmpIn, renderBuf);
    try {
      await birefnetLocal.matte(tmpIn, tmpOut);
      return fs.readFileSync(tmpOut);
    } catch (err) {
      console.error('[engine] local birefnet failed, using Vision mask:', err.message);
      flags.push('birefnetLocalFailed');
    } finally {
      for (const f of [tmpIn, tmpOut]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    }
  }
  if (outAlpha && !locked) return outAlpha.png;
  return (await guard.personAlphaLocal(sidecar, renderBuf)).png;
}

// Nano Banana's match_input_image drifts the canvas (a 3:4 input came back
// ≈2:3 live), sinking the pixel-lock geometry gate — pin the nearest concrete
// ratio for Original framing instead. (route.ts:67-80)
const NB_RATIOS = [
  ['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3],
  ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9],
];
function nearestAspect(w, h) {
  const r = w / Math.max(1, h);
  let best = NB_RATIOS[0];
  for (const cand of NB_RATIOS) {
    if (Math.abs(Math.log(r / cand[1])) < Math.abs(Math.log(r / best[1]))) best = cand;
  }
  return best[0];
}

const FRAMING_TO_CROP = {
  'chest-up': 'chest-up',
  'shoulders-up': 'shoulders-up',
  'head-tight': 'head-tight',
  original: 'original',
};

/**
 * Minimal trim of the model's 4K output to a target aspect — NEVER a zoom.
 * enhance.turbo.net.au delivers the Nano Banana frame untouched; the model
 * already composed the requested framing (chest-up etc). Face data is used
 * only to anchor WHICH side gets trimmed.
 */
function aspectTrim(faceData, W, H, ratio) {
  const current = W / H;
  if (Math.abs(current - ratio) / ratio < 0.005) {
    return { left: 0, top: 0, width: W, height: H };
  }
  if (current > ratio) {
    // too wide → trim sides, centred on the face
    const cropW = Math.round(H * ratio);
    const anchorX = faceData?.noseTipX ?? W / 2;
    const left = Math.max(0, Math.min(W - cropW, Math.round(anchorX - cropW / 2)));
    return { left, top: 0, width: cropW, height: H };
  }
  // too tall → trim top/bottom, eye line at ~38% from the top of the crop
  const cropH = Math.round(W / ratio);
  const anchorY = faceData?.eyeLineY ?? H * 0.35;
  const top = Math.max(0, Math.min(H - cropH, Math.round(anchorY - cropH * 0.38)));
  return { left: 0, top, width: W, height: cropH };
}

const STAGES = {
  prepare: '01 Prepare · 4096px q95',
  guardIn: '02 Guard in · torso reference',
  render: '03 Re-render · nano-banana-pro 4K',
  faceRestore: '04 Face restore · codeformer 0.7',
  guardOut: '05 Guard out · matte + pixel-lock',
  export: '06 Crop + export',
  upload: '07 Upload · turbo iq gallery',
};

const toDataUri = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

/**
 * Process one render.
 * @param {object} item { frame, personFolder, baseName, backdrop, opts, brandingRetry }
 * @param {object} deps { client, sidecar, usage, settings, onStage(stageKey, label, pct) }
 * @returns {{ outputs: Array<{path, kind, backdrop}>, flags: string[], verify: object|null }}
 */
async function processRender(item, deps, frameCache) {
  const { frame, personFolder, baseName, backdrop, opts } = item;
  const { client, sidecar, usage, settings, onStage } = deps;
  const flags = [];
  const slug = backdrop;
  const processedDir = path.join(personFolder, 'Processed');
  fs.mkdirSync(processedDir, { recursive: true });

  /* ---- 01 PREPARE (cached per frame across backdrops; the cache holds a
     PROMISE so 4 parallel backdrop workers share one in-flight prepare
     instead of each paying for their own) ---- */
  onStage('prepare', STAGES.prepare, 5);
  let prepPromise = frameCache.get('prep');
  if (!prepPromise) {
    prepPromise = (async () => {
      const workingPath = await local.resolveWorkingImage(frame, personFolder, settings.raw.watchFolder);
      if (!workingPath) {
        throw new Error('No JPEG available and RAW conversion failed — enable RAW+JPEG on camera or install exiftool');
      }
      const prepared = await client.prepareImageForHeadshot(fs.readFileSync(workingPath));
      return { ...prepared, workingPath };
    })();
    frameCache.set('prep', prepPromise);
    prepPromise.catch(() => frameCache.delete('prep')); // don't cache failures
  }
  const prep = await prepPromise;

  /* ---- 02 GUARD-IN (fail-soft, cached per frame) ---- */
  let inputAlpha = null;
  let inputTorsoBuf = null;
  let torsoDataUri = null;
  if (opts.keepClothing) {
    onStage('guardIn', STAGES.guardIn, 15);
    let guardPromise = frameCache.get('guardIn');
    if (!guardPromise) {
      guardPromise = (async () => {
        const alpha = opts.engine === 'local'
          ? await guard.personAlphaLocal(sidecar, prep.buffer)
          : await guard.personAlpha(client, toDataUri(prep.buffer));
        if (alpha.predictionId) usage.record({ tool: 'headshot-guard', model: '851-labs/background-remover', predictionId: alpha.predictionId });
        const torso = guard.torsoRegion(alpha.bbox, prep.width, prep.height);
        const torsoBuf = await guard.cropRegion(prep.buffer, torso);
        return { inputAlpha: alpha, inputTorsoBuf: torsoBuf, torsoDataUri: toDataUri(torsoBuf) };
      })();
      frameCache.set('guardIn', guardPromise);
    }
    try {
      ({ inputAlpha, inputTorsoBuf, torsoDataUri } = await guardPromise);
    } catch (err) {
      console.error('[engine] input guard (non-fatal):', err.message);
      flags.push('guardInFailed');
      inputAlpha = null; inputTorsoBuf = null; torsoDataUri = null;
    }
  }

  /* ---- 03 RENDER ---- */
  onStage('render', STAGES.render, 30);
  const crop = FRAMING_TO_CROP[opts.framing] || 'chest-up';
  const prompt = buildHeadshotPrompt(backdrop, crop, opts.glasses, opts.keepClothing, {
    hasBrandingReference: !!torsoDataUri,
    brandingRetry: !!item.brandingRetry,
  });
  const nb = await client.runNanoBananaPro({
    prompt,
    image_input: torsoDataUri ? [toDataUri(prep.buffer), torsoDataUri] : [toDataUri(prep.buffer)],
    aspect_ratio: crop === 'original' ? nearestAspect(prep.width, prep.height) : 'match_input_image',
    resolution: '4K',
    output_format: 'jpg',
    safety_filter_level: 'block_only_high',
  });
  usage.record({ tool: 'headshot', model: 'google/nano-banana-pro', predictionId: nb.predictionId, meta: { backdrop, framing: opts.framing } });
  let enhancedUrl = nb.outputUrl;

  /* ---- 04 FACE RESTORE (fail-soft) ---- */
  if (opts.faceRestore) {
    onStage('faceRestore', STAGES.faceRestore, 55);
    try {
      const cf = await client.runCodeFormer({ image: enhancedUrl });
      enhancedUrl = cf.outputUrl;
      usage.record({ tool: 'photo-faces', model: 'sczhou/codeformer', predictionId: `${nb.predictionId}-cf` });
    } catch (err) {
      console.error('[engine] CodeFormer (non-fatal):', err.message);
      flags.push('faceRestoreFailed');
    }
  }

  let renderBuf = await client.urlToBuffer(enhancedUrl);

  /* ---- 05 GUARD-OUT / PIXEL-LOCK (fail-soft) ---- */
  let verify = null;
  let outAlpha = null;
  if (opts.keepClothing && inputAlpha && inputTorsoBuf) {
    onStage('guardOut', STAGES.guardOut, 70);
    try {
      outAlpha = opts.engine === 'local'
        ? await guard.personAlphaLocal(sidecar, renderBuf)
        : await guard.personAlpha(client, toDataUri(renderBuf));
      if (outAlpha.predictionId) usage.record({ tool: 'headshot-guard', model: '851-labs/background-remover', predictionId: outAlpha.predictionId });
      const outMeta = await sharp(renderBuf).metadata();
      const outW = outMeta.width ?? outAlpha.width;
      const outH = outMeta.height ?? outAlpha.height;
      const outTorsoBuf = await guard.cropRegion(renderBuf, guard.torsoRegion(outAlpha.bbox, outW, outH));

      if (crop === 'original') {
        const lock = await guard.pixelLockWithKnownBoxes(prep.buffer, renderBuf, inputAlpha, outAlpha.bbox, outW, outH);
        if (lock.ok && lock.buffer) {
          renderBuf = lock.buffer;
          flags.push('pixelLocked');
        } else {
          flags.push(`pixelLockSkipped:${lock.reason}`);
        }
      }

      const verifyDir = path.join(processedDir, 'verify');
      fs.mkdirSync(verifyDir, { recursive: true });
      const inPath = path.join(verifyDir, `${baseName}-${slug}-torso-in.jpg`);
      const outPath = path.join(verifyDir, `${baseName}-${slug}-torso-out.jpg`);
      fs.writeFileSync(inPath, inputTorsoBuf);
      fs.writeFileSync(outPath, outTorsoBuf);
      const presence = await guard.brandingPresence(inputTorsoBuf);
      verify = { hasBranding: presence.hasBranding, torsoIn: inPath, torsoOut: outPath };
    } catch (err) {
      console.error('[engine] output guard (non-fatal):', err.message);
      flags.push('guardOutFailed');
    }
  }

  /* ---- 06 EXPORT (parity with enhance.turbo.net.au: the model's frame is
     the deliverable — aspect versions are minimal trims, never zooms, and
     nothing is re-sharpened or colour-adjusted) ---- */
  onStage('export', STAGES.export, 82);
  const outputs = [];

  // The untouched engine output — byte-for-byte what Enhance would deliver
  // (pixel-locked buffer when that ran).
  const fullPath = path.join(processedDir, `${baseName}-${slug}-full.jpg`);
  fs.writeFileSync(fullPath, renderBuf);
  outputs.push({ path: fullPath, kind: 'full', backdrop: slug });

  // Face-detect on the 4K render — used ONLY to anchor the aspect trims.
  const tmpRender = path.join(os.tmpdir(), `th-render-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmpRender, renderBuf);
  let faceData;
  try {
    faceData = await local.detectFace(sidecar, tmpRender);
  } finally {
    try { fs.unlinkSync(tmpRender); } catch { /* ignore */ }
  }
  const renderMeta = await sharp(renderBuf).metadata();
  const rW = renderMeta.width ?? 0;
  const rH = renderMeta.height ?? 0;

  const cropRects = {};
  const exportCrop = async (ratio, kindJpg, suffix) => {
    const rect = aspectTrim(faceData, rW, rH, ratio);
    cropRects[suffix] = rect;
    const jpgPath = path.join(processedDir, `${baseName}-${slug}-${suffix}.jpg`);
    await sharp(renderBuf).extract(rect)
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toFile(jpgPath);
    outputs.push({ path: jpgPath, kind: kindJpg, backdrop: slug });
  };

  if (opts.portrait) await exportCrop(4 / 5, '4x5', '4x5');
  if (opts.square) await exportCrop(1, 'sqr', 'SQR');

  /* ---- transparent cut-outs of the render ---- */
  if (opts.cutout) {
    try {
      let cutoutPng;
      const locked = flags.includes('pixelLocked');
      if (opts.engine === 'local') {
        cutoutPng = await localCutout(renderBuf, outAlpha, locked, sidecar, flags);
      } else if (opts.matte === 'birefnet') {
        const meta = await sharp(renderBuf).metadata();
        const bi = await client.runBirefnet(toDataUri(renderBuf), `${meta.width}x${meta.height}`);
        usage.record({ tool: 'cutout', model: 'men1scus/birefnet', predictionId: bi.predictionId });
        cutoutPng = await client.urlToBuffer(bi.outputUrl);
      } else if (outAlpha && !locked) {
        // reuse the guard-out matte — no extra call. NOT valid after pixel-lock:
        // that matte was cut from the pre-lock render and would ship the
        // AI-drawn garment in the transparent PNGs.
        cutoutPng = outAlpha.png;
      } else {
        const rb = await client.runRemoveBackground(toDataUri(renderBuf));
        usage.record({ tool: 'cutout', model: '851-labs/background-remover', predictionId: rb.predictionId });
        cutoutPng = await client.urlToBuffer(rb.outputUrl);
      }
      // Crop the transparent PNG to the same regions as the JPEG outputs.
      if (opts.portrait) {
        const p = path.join(processedDir, `${baseName}-${slug}-4x5-TP.png`);
        const c = cropRects['4x5'] ?? aspectTrim(faceData, rW, rH, 4 / 5);
        await sharp(cutoutPng).extract(c).png().toFile(p);
        outputs.push({ path: p, kind: '4x5-tp', backdrop: slug });
      }
      if (opts.square) {
        const p = path.join(processedDir, `${baseName}-${slug}-SQR-TP.png`);
        const c = cropRects['SQR'] ?? aspectTrim(faceData, rW, rH, 1);
        await sharp(cutoutPng).extract(c).png().toFile(p);
        outputs.push({ path: p, kind: 'sqr-tp', backdrop: slug });
      }
    } catch (err) {
      console.error('[engine] cutout (non-fatal):', err.message);
      flags.push('cutoutFailed');
    }
  }

  /* ---- 8K print upscale ---- */
  if (opts.print8k) {
    try {
      const printPath = path.join(processedDir, `${baseName}-${slug}-print.jpg`);
      const up = await upscaleToPrint(client, renderBuf, printPath);
      if (!up.cached) usage.record({ tool: 'print', model: 'nightmareai/real-esrgan', predictionId: up.predictionId });
      outputs.push({ path: printPath, kind: 'print', backdrop: slug });
    } catch (err) {
      console.error('[engine] print upscale (non-fatal):', err.message);
      flags.push('printFailed');
    }
  }

  return { outputs, flags, verify };
}

/* ---------- Fully Local (composite) pipeline ---------- */

// Procedural studio backdrops matching the NBP prompt palette. Deterministic
// gradients: every subject in a shoot gets EXACTLY the same backdrop.
const COMPOSITE_BACKDROPS = {
  grey: { center: '#7e8184', edge: '#63666a' },
  white: { center: '#f5f5f3', edge: '#e0e0dd' },
  navy: { center: '#24364d', edge: '#141f31' },
  turbo: { center: '#2b2725', edge: '#131110' },
};

function backdropSvg(w, h, c) {
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><radialGradient id="g" cx="50%" cy="38%" r="80%">` +
    `<stop offset="0%" stop-color="${c.center}"/>` +
    `<stop offset="100%" stop-color="${c.edge}"/>` +
    `</radialGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/></svg>`
  );
}

/**
 * Fully Local: no generative re-render. The subject's real pixels are colour
 * corrected, matted (local BiRefNet or Vision), and composited onto a
 * procedural studio backdrop. Zero identity/expression/branding risk, $0.
 */
async function processComposite(item, deps, frameCache) {
  const { frame, personFolder, baseName, backdrop, opts } = item;
  const { sidecar, settings, onStage } = deps;
  const flags = ['composite'];
  const slug = backdrop;
  const processedDir = path.join(personFolder, 'Processed');
  fs.mkdirSync(processedDir, { recursive: true });

  /* ---- prepare + correct (cached per frame across backdrops) ---- */
  onStage('prepare', '01 Prepare · colour correct', 10);
  let prepPromise = frameCache.get('compositePrep');
  if (!prepPromise) {
    prepPromise = (async () => {
      const workingPath = await local.resolveWorkingImage(frame, personFolder, settings.raw.watchFolder);
      if (!workingPath) throw new Error('No JPEG available and RAW conversion failed');
      const oriented = await sharp(fs.readFileSync(workingPath)).rotate().jpeg({ quality: 98 }).toBuffer();
      const tmp = path.join(os.tmpdir(), `th-comp-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
      fs.writeFileSync(tmp, oriented);
      let faceData; let wbMatrix;
      try {
        faceData = await local.detectFace(sidecar, tmp);
        wbMatrix = await local.calculateWhiteBalance(tmp);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      const wbStrength = settings.raw.whiteBalanceStrength ?? 1.0;
      const matrix = wbMatrix.map((row, i) => row.map((v, j) => {
        const identity = i === j ? 1 : 0;
        return identity + (v - identity) * wbStrength;
      }));
      const corrected = await sharp(oriented)
        .recomb(matrix)
        .modulate({ saturation: 1.05, brightness: settings.raw.brightness ?? 1.12 })
        .sharpen({ sigma: settings.raw.sharpening ?? 0.8, m1: 0.5, m2: 0.5 })
        .jpeg({ quality: 98 }).toBuffer();

      /* ---- matte the corrected frame (BiRefNet local → Vision) ---- */
      onStage('guardOut', '02 Matte · local BiRefNet / Vision', 35);
      const cutoutPng = await localCutout(corrected, null, false, sidecar, flags);
      const meta = await sharp(corrected).metadata();
      return { corrected, cutoutPng, faceData, width: meta.width ?? 0, height: meta.height ?? 0 };
    })();
    frameCache.set('compositePrep', prepPromise);
    prepPromise.catch(() => frameCache.delete('compositePrep'));
  }
  const prep = await prepPromise;

  /* ---- composite onto the procedural backdrop ---- */
  onStage('export', '03 Composite + export', 65);
  const bg = COMPOSITE_BACKDROPS[backdrop] ?? COMPOSITE_BACKDROPS.grey;
  if (!COMPOSITE_BACKDROPS[backdrop]) flags.push(`backdropFallback:${backdrop}`);
  const renderBuf = await sharp(backdropSvg(prep.width, prep.height, bg))
    .composite([{ input: prep.cutoutPng }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();

  const outputs = [];
  const fullPath = path.join(processedDir, `${baseName}-${slug}-full.jpg`);
  fs.writeFileSync(fullPath, renderBuf);
  outputs.push({ path: fullPath, kind: 'full', backdrop: slug });

  const rW = prep.width;
  const rH = prep.height;
  const cropRects = {};
  const exportCrop = async (ratio, kindJpg, suffix) => {
    const rect = aspectTrim(prep.faceData, rW, rH, ratio);
    cropRects[suffix] = rect;
    const jpgPath = path.join(processedDir, `${baseName}-${slug}-${suffix}.jpg`);
    await sharp(renderBuf).extract(rect)
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toFile(jpgPath);
    outputs.push({ path: jpgPath, kind: kindJpg, backdrop: slug });
  };
  if (opts.portrait) await exportCrop(4 / 5, '4x5', '4x5');
  if (opts.square) await exportCrop(1, 'sqr', 'SQR');

  if (opts.cutout) {
    if (opts.portrait) {
      const p = path.join(processedDir, `${baseName}-${slug}-4x5-TP.png`);
      const c = cropRects['4x5'] ?? aspectTrim(prep.faceData, rW, rH, 4 / 5);
      await sharp(prep.cutoutPng).extract(c).png().toFile(p);
      outputs.push({ path: p, kind: '4x5-tp', backdrop: slug });
    }
    if (opts.square) {
      const p = path.join(processedDir, `${baseName}-${slug}-SQR-TP.png`);
      const c = cropRects['SQR'] ?? aspectTrim(prep.faceData, rW, rH, 1);
      await sharp(prep.cutoutPng).extract(c).png().toFile(p);
      outputs.push({ path: p, kind: 'sqr-tp', backdrop: slug });
    }
  }
  // print8k is a generative-pipeline concern (ESRGAN) — not applicable here.

  return { outputs, flags, verify: null };
}

/**
 * Local-only fallback render (no Replicate): v1-style crop + colour correction.
 * Outputs carry no backdrop slug (original backdrop preserved).
 */
async function processLocal(item, deps, frameCache) {
  const { frame, personFolder, baseName, opts } = item;
  const { sidecar, settings, onStage } = deps;
  const flags = ['localFallback'];
  const processedDir = path.join(personFolder, 'Processed');
  fs.mkdirSync(processedDir, { recursive: true });

  onStage('prepare', STAGES.prepare, 10);
  let prep = frameCache.get('localPrep');
  if (!prep) {
    const workingPath = await local.resolveWorkingImage(frame, personFolder, settings.raw.watchFolder);
    if (!workingPath) throw new Error('No JPEG available and RAW conversion failed');
    // Orient once; all coordinates below live in the oriented space.
    const oriented = await sharp(fs.readFileSync(workingPath)).rotate().jpeg({ quality: 98 }).toBuffer();
    prep = { oriented, workingPath };
    frameCache.set('localPrep', prep);
  }

  onStage('export', '02 Local crop + correct', 45);
  const tmp = path.join(os.tmpdir(), `th-local-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmp, prep.oriented);
  let faceData;
  let wbMatrix;
  try {
    faceData = await local.detectFace(sidecar, tmp);
    wbMatrix = await local.calculateWhiteBalance(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  const wbStrength = settings.raw.whiteBalanceStrength ?? 1.0;
  const matrix = wbMatrix.map((row, i) => row.map((v, j) => {
    const identity = i === j ? 1 : 0;
    return identity + (v - identity) * wbStrength;
  }));

  const outputs = [];
  const jpegQuality = settings.raw.jpegQuality ?? 92;
  const common = {
    wbMatrix: matrix,
    brightness: settings.raw.brightness ?? 1.12,
    sharpening: settings.raw.sharpening ?? 0.8,
  };
  if (opts.portrait) {
    const p = path.join(processedDir, `${baseName}-4x5.jpg`);
    const pipe = await local.cropToAspect(prep.oriented, faceData, 4 / 5, common);
    await pipe.jpeg({ quality: jpegQuality, mozjpeg: true }).toFile(p);
    outputs.push({ path: p, kind: '4x5', backdrop: null });
  }
  if (opts.square) {
    const p = path.join(processedDir, `${baseName}-SQR.jpg`);
    const pipe = await local.cropToAspect(prep.oriented, faceData, 1, common);
    await pipe.jpeg({ quality: jpegQuality, mozjpeg: true }).toFile(p);
    outputs.push({ path: p, kind: 'sqr', backdrop: null });
  }
  if (opts.cutout && outputs.length > 0) {
    onStage('export', '03 Local background removal', 75);
    try {
      const srcJpg = outputs.find((o) => o.kind === 'sqr')?.path ?? outputs[0].path;
      const tp = srcJpg.replace(/\.jpg$/, '-TP.png');
      await local.removeBackgroundLocal(sidecar, srcJpg, tp);
      outputs.push({ path: tp, kind: srcJpg.includes('-SQR') ? 'sqr-tp' : '4x5-tp', backdrop: null });
    } catch (err) {
      console.error('[engine] local bg removal (non-fatal):', err.message);
      flags.push('cutoutFailed');
    }
  }
  return { outputs, flags, verify: null };
}

module.exports = { processRender, processLocal, processComposite, STAGES, nearestAspect };
