// Local (no-AI) stages, extracted from v1 processor.js: RAW conversion,
// Vision-sidecar face detection (with a geometric fallback), the v1 crop math,
// white balance, and local background removal. This is BOTH the fallback path
// when the engine is off/unreachable AND the crop+export stage the engine
// pipeline runs on its 4K renders.
const fs = require('fs');
const path = require('path');
const util = require('util');
const { exec, spawn } = require('child_process');
const sharp = require('sharp');

const execP = util.promisify(exec);
const RAW_EXTS = ['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];

/* ---------- RAW → JPEG (v1 processor.js:1377 chain, verbatim behaviour) ---------- */

function findBin(name) {
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, name];
  return candidates.find((p) => p === name || fs.existsSync(p)) || name;
}

async function convertRawToJpeg(rawPath, outputFolder, baseName) {
  const outputPath = path.join(outputFolder, `${baseName}_converted.jpg`);
  const exiftoolBin = findBin('exiftool');
  const dcrawBin = findBin('dcraw');

  // exiftool: extract the camera's full-res embedded JPEG (works on modern RAWs),
  // then copy the Orientation tag back (the preview strips EXIF).
  try {
    await execP(`"${exiftoolBin}" -b -JpgFromRaw "${rawPath}" > "${outputPath}"`);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
      try {
        await execP(`"${exiftoolBin}" -tagsfromfile "${rawPath}" -Orientation -overwrite_original "${outputPath}"`);
      } catch { /* continue without orientation */ }
      return outputPath;
    }
    if (fs.existsSync(outputPath)) { try { fs.unlinkSync(outputPath); } catch { /* */ } }
  } catch { /* fall through */ }

  // dcraw (older cameras)
  try {
    const rawDir = path.dirname(rawPath);
    const rawName = path.basename(rawPath, path.extname(rawPath));
    const tiff = path.join(rawDir, `${rawName}.tiff`);
    if (fs.existsSync(tiff)) { try { fs.unlinkSync(tiff); } catch { /* */ } }
    await execP(`"${dcrawBin}" -w -q 3 -T -o 1 "${rawPath}"`);
    if (fs.existsSync(tiff)) {
      await sharp(tiff).rotate().jpeg({ quality: 95 }).toFile(outputPath);
      fs.unlinkSync(tiff);
      return outputPath;
    }
  } catch { /* fall through */ }

  // sips (macOS built-in, limited RAW support)
  try {
    await execP(`sips -s format jpeg -s formatOptions 95 "${rawPath}" --out "${outputPath}"`);
    if (fs.existsSync(outputPath)) return outputPath;
  } catch { /* fall through */ }

  return null;
}

/**
 * Resolve a working JPEG for a frame (v1 processor.js:401-456): the frame's own
 * copied camera JPEG → exact-stem match in the watch folder → RAW conversion.
 */
async function resolveWorkingImage(frame, personFolder, watchFolder) {
  const ext = path.extname(frame.file).toLowerCase();
  if (!RAW_EXTS.includes(ext)) return frame.file;
  if (frame.jpegFile && fs.existsSync(frame.jpegFile)) return frame.jpegFile;

  const jpegInFolder = frame.file.replace(new RegExp(`${ext}$`, 'i'), '.jpg');
  if (fs.existsSync(jpegInFolder)) return jpegInFolder;
  const jpegInFolderU = frame.file.replace(new RegExp(`${ext}$`, 'i'), '.JPG');
  if (fs.existsSync(jpegInFolderU)) return jpegInFolderU;

  if (watchFolder && fs.existsSync(watchFolder)) {
    const stem = path.basename(frame.file, path.extname(frame.file)).toLowerCase();
    const match = fs.readdirSync(watchFolder).find((f) =>
      f.toLowerCase().endsWith('.jpg') &&
      path.basename(f, path.extname(f)).toLowerCase() === stem);
    if (match) return path.join(watchFolder, match);
  }

  return convertRawToJpeg(frame.file, personFolder, frame.baseName);
}

/* ---------- Face detection (sidecar → geometric fallback) ---------- */

async function detectFace(sidecar, imagePath) {
  try {
    const result = await sidecar.detectFace(imagePath);
    if (result.found) {
      return {
        imageWidth: result.imageWidth,
        imageHeight: result.imageHeight,
        noseTipX: result.noseTipX,
        eyeLineY: result.eyeLineY,
        faceBoundingBox: result.boundingBox,
        estimatedFaceHeight: result.faceHeight,
        confidence: result.confidence,
      };
    }
  } catch (err) {
    console.log('[localPipeline] sidecar face detect failed:', err.message);
  }
  // Geometric fallback (smartcrop removed): assume a centred subject with the
  // head in the upper third — correct for a tethered headshot workflow.
  const meta = await sharp(imagePath).rotate().metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const faceH = h * 0.22;
  return {
    imageWidth: w,
    imageHeight: h,
    noseTipX: w / 2,
    eyeLineY: h * 0.3,
    faceBoundingBox: { x: w / 2 - faceH * 0.4, y: h * 0.22, width: faceH * 0.8, height: faceH },
    estimatedFaceHeight: faceH,
    confidence: 0.2,
  };
}

/* ---------- v1 white balance (processor.js:1001) ---------- */

async function calculateWhiteBalance(imagePath) {
  try {
    const { data, info } = await sharp(imagePath)
      .rotate()
      .resize(200, 200, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const pixelCount = width * height;
    const pixels = [];
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      pixels.push({ r, g, b, l: 0.299 * r + 0.587 * g + 0.114 * b });
    }
    pixels.sort((a, b) => b.l - a.l);
    const highlightCount = Math.max(10, Math.floor(pixelCount * 0.1));
    const hi = pixels.slice(0, highlightCount);
    let hR = 0, hG = 0, hB = 0;
    for (const p of hi) { hR += p.r; hG += p.g; hB += p.b; }
    hR /= highlightCount; hG /= highlightCount; hB /= highlightCount;
    const maxChannel = Math.max(hR, hG, hB);
    const bright = (hR + hG + hB) / 3 > 220;
    const lim = bright ? 0.05 : 0.15;
    const clamp = (v) => Math.max(1 - lim, Math.min(1 + lim, v));
    const rF = clamp(maxChannel / hR), gF = clamp(maxChannel / hG), bF = clamp(maxChannel / hB);
    return [[rF, 0, 0], [0, gF, 0], [0, 0, bF]];
  } catch {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
}

/* ---------- v1 crop math (processor.js:851) ---------- */

function computeCrop(faceData, aspectRatio) {
  const { imageWidth, imageHeight, noseTipX, eyeLineY, faceBoundingBox, estimatedFaceHeight } = faceData;
  const isSquare = aspectRatio >= 1;
  const fullHeadHeight = (faceBoundingBox?.height || estimatedFaceHeight) * 1.25;
  const headFractionOfFrame = isSquare ? 0.50 : 0.35;
  const eyeLineFraction = 0.38;

  const edgeMargin = Math.round(Math.min(imageWidth, imageHeight) * 0.03);
  const safeWidth = imageWidth - edgeMargin * 2;
  const safeHeight = imageHeight - edgeMargin * 2;

  let cropHeight = Math.min(fullHeadHeight / headFractionOfFrame, safeHeight);
  let cropWidth = cropHeight * aspectRatio;
  if (cropWidth > safeWidth) {
    cropWidth = safeWidth;
    cropHeight = cropWidth / aspectRatio;
  }
  cropWidth = Math.round(cropWidth);
  cropHeight = Math.round(cropHeight);

  let cropX = Math.round(noseTipX - cropWidth / 2);
  let cropY = Math.round(eyeLineY - cropHeight * eyeLineFraction);
  if (cropX < edgeMargin) cropX = edgeMargin;
  else if (cropX + cropWidth > imageWidth - edgeMargin) cropX = imageWidth - edgeMargin - cropWidth;
  if (cropY < edgeMargin) cropY = edgeMargin;
  else if (cropY + cropHeight > imageHeight - edgeMargin) cropY = imageHeight - edgeMargin - cropHeight;
  cropX = Math.max(0, Math.min(cropX, imageWidth - cropWidth));
  cropY = Math.max(0, Math.min(cropY, imageHeight - cropHeight));
  return { left: cropX, top: cropY, width: cropWidth, height: cropHeight };
}

/**
 * Crop an (already-oriented) buffer to the given aspect using face data, with
 * optional WB/brightness (local path) and export sharpening/quality.
 */
async function cropToAspect(buffer, faceData, aspectRatio, opts = {}) {
  const crop = computeCrop(faceData, aspectRatio);
  let pipeline = sharp(buffer).extract(crop);
  if (opts.wbMatrix) pipeline = pipeline.recomb(opts.wbMatrix);
  if (opts.brightness) {
    pipeline = pipeline.modulate({ saturation: 1.05, brightness: opts.brightness });
  }
  if (opts.sharpening > 0) {
    pipeline = pipeline.sharpen({ sigma: opts.sharpening, m1: 0.5, m2: 0.5 });
  }
  return pipeline;
}

/* ---------- local background removal (v1 processor.js:93) ---------- */

function resolveRembgPath() {
  const candidates = [
    `${process.env.HOME}/.local/bin/rembg`,
    '/opt/homebrew/bin/rembg',
    '/usr/local/bin/rembg',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function removeBackgroundLocal(sidecar, inputPath, outputPath) {
  const rembg = resolveRembgPath();
  if (rembg) {
    return new Promise((resolve, reject) => {
      const proc = spawn(rembg, ['i', '-m', 'birefnet-portrait', inputPath, outputPath],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('rembg timed out (60s)')); }, 60000);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outputPath)) resolve();
        else reject(new Error(`rembg exited ${code}: ${stderr.slice(0, 200)}`));
      });
    });
  }
  return sidecar.foregroundMask(inputPath, outputPath);
}

module.exports = {
  RAW_EXTS,
  convertRawToJpeg,
  resolveWorkingImage,
  detectFace,
  calculateWhiteBalance,
  computeCrop,
  cropToAspect,
  removeBackgroundLocal,
};
