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
const { upscaleToPrint } = require('./upscale');

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

  /* ---- 01 PREPARE (cached per frame across backdrops) ---- */
  onStage('prepare', STAGES.prepare, 5);
  let prep = frameCache.get('prep');
  if (!prep) {
    const workingPath = await local.resolveWorkingImage(frame, personFolder, settings.raw.watchFolder);
    if (!workingPath) {
      throw new Error('No JPEG available and RAW conversion failed — enable RAW+JPEG on camera or install exiftool');
    }
    const prepared = await client.prepareImageForHeadshot(fs.readFileSync(workingPath));
    prep = { ...prepared, workingPath };
    frameCache.set('prep', prep);
  }

  /* ---- 02 GUARD-IN (fail-soft, cached per frame) ---- */
  let inputAlpha = null;
  let inputTorsoBuf = null;
  let torsoDataUri = null;
  if (opts.keepClothing) {
    onStage('guardIn', STAGES.guardIn, 15);
    const cached = frameCache.get('guardIn');
    if (cached !== undefined) {
      ({ inputAlpha, inputTorsoBuf, torsoDataUri } = cached ?? {});
      if (cached === null) flags.push('guardInFailed');
    } else {
      try {
        inputAlpha = await guard.personAlpha(client, toDataUri(prep.buffer));
        usage.record({ tool: 'headshot-guard', model: '851-labs/background-remover', predictionId: inputAlpha.predictionId });
        const torso = guard.torsoRegion(inputAlpha.bbox, prep.width, prep.height);
        inputTorsoBuf = await guard.cropRegion(prep.buffer, torso);
        torsoDataUri = toDataUri(inputTorsoBuf);
        frameCache.set('guardIn', { inputAlpha, inputTorsoBuf, torsoDataUri });
      } catch (err) {
        console.error('[engine] input guard (non-fatal):', err.message);
        flags.push('guardInFailed');
        frameCache.set('guardIn', null);
        inputAlpha = null; inputTorsoBuf = null; torsoDataUri = null;
      }
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
      outAlpha = await guard.personAlpha(client, toDataUri(renderBuf));
      usage.record({ tool: 'headshot-guard', model: '851-labs/background-remover', predictionId: outAlpha.predictionId });
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

  /* ---- 06 CROP + EXPORT ---- */
  onStage('export', STAGES.export, 82);
  const outputs = [];
  const jpegQuality = settings.raw.jpegQuality ?? 92;
  const sharpening = settings.raw.sharpening ?? 0.8;

  // Face-detect on the 4K render (temp file for the sidecar).
  const tmpRender = path.join(os.tmpdir(), `th-render-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmpRender, renderBuf);
  let faceData;
  try {
    faceData = await local.detectFace(sidecar, tmpRender);
  } finally {
    try { fs.unlinkSync(tmpRender); } catch { /* ignore */ }
  }

  const exportCrop = async (aspect, kindJpg, kindPng, suffix) => {
    const jpgPath = path.join(processedDir, `${baseName}-${slug}-${suffix}.jpg`);
    const pipeline = await local.cropToAspect(renderBuf, faceData, aspect, { sharpening });
    await pipeline.jpeg({ quality: jpegQuality, mozjpeg: true }).toFile(jpgPath);
    outputs.push({ path: jpgPath, kind: kindJpg, backdrop: slug });
    return jpgPath;
  };

  if (opts.portrait) await exportCrop(4 / 5, '4x5', null, '4x5');
  if (opts.square) await exportCrop(1, 'sqr', null, 'SQR');

  /* ---- transparent cut-outs of the render ---- */
  if (opts.cutout) {
    try {
      let cutoutPng;
      if (opts.matte === 'birefnet') {
        const meta = await sharp(renderBuf).metadata();
        const bi = await client.runBirefnet(toDataUri(renderBuf), `${meta.width}x${meta.height}`);
        usage.record({ tool: 'cutout', model: 'men1scus/birefnet', predictionId: bi.predictionId });
        cutoutPng = await client.urlToBuffer(bi.outputUrl);
      } else if (outAlpha) {
        cutoutPng = outAlpha.png; // reuse the guard-out matte — no extra call
      } else {
        const rb = await client.runRemoveBackground(toDataUri(renderBuf));
        usage.record({ tool: 'cutout', model: '851-labs/background-remover', predictionId: rb.predictionId });
        cutoutPng = await client.urlToBuffer(rb.outputUrl);
      }
      // Crop the transparent PNG to the same regions as the JPEG outputs.
      if (opts.portrait) {
        const p = path.join(processedDir, `${baseName}-${slug}-4x5-TP.png`);
        const c = local.computeCrop(faceData, 4 / 5);
        await sharp(cutoutPng).extract(c).png().toFile(p);
        outputs.push({ path: p, kind: '4x5-tp', backdrop: slug });
      }
      if (opts.square) {
        const p = path.join(processedDir, `${baseName}-${slug}-SQR-TP.png`);
        const c = local.computeCrop(faceData, 1);
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

module.exports = { processRender, processLocal, STAGES, nearestAspect };
