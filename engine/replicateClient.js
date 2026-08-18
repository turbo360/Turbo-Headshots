// Replicate client — ported from turbo-enhance/src/lib/replicate.ts (headshot
// subset). Token comes from settings (not env). Official models run via the
// model-slug shortcut; community models (InSPyReNet, BiRefNet) must run via
// /v1/predictions with a pinned version hash (the slug shortcut 404s).
const sharp = require('sharp');

const REPLICATE_BASE = 'https://api.replicate.com/v1';
const MAX_HEADSHOT_DIMENSION = 4096; // keeps garment branding legible at inference
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 120; // ~3 minutes

const NANO_BANANA_PRO_MODEL = 'google/nano-banana-pro';
// CodeFormer is a community model with no official deployment — the slug
// shortcut 404s (confirmed live 2026-08-18); run via /v1/predictions with a
// pinned, env-overridable version hash.
const CODEFORMER_MODEL = 'sczhou/codeformer';
const CODEFORMER_VERSION =
  process.env.REPLICATE_CODEFORMER_VERSION ||
  '7de2ea26c616d5bf2245ad0d5e24f0ff9a6204578a5c876db53142edd9d2cd56';
const REAL_ESRGAN_MODEL = 'nightmareai/real-esrgan';
const REMOVE_BG_MODEL = '851-labs/background-remover'; // InSPyReNet — soft alpha, preserves resolution
const REMOVE_BG_VERSION =
  process.env.REPLICATE_REMOVE_BG_VERSION ||
  'a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc';
const BIREFNET_MODEL = 'men1scus/birefnet'; // true BiRefNet — SOTA fine-edge detail
const BIREFNET_VERSION =
  process.env.REPLICATE_BIREFNET_VERSION ||
  'f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7';

/** Replicate-side transient failures worth retrying (orchestrator/PA/capacity). */
function isTransientPredictionFailure(error) {
  if (!error) return false;
  return /\bE9243\b|\(code:\s*PA\)|please retry|interrupted|ModelRateLimitError|\bE003\b|high demand/i.test(error);
}

class ReplicateClient {
  /** @param {() => string} getToken */
  constructor(getToken) {
    this.getToken = getToken;
  }

  token() {
    const t = this.getToken();
    if (!t) throw new Error('Replicate API key is not set (Settings → Integrations)');
    return t;
  }

  /** EXIF-rotate, cap longest side at 4096, JPEG q95 4:4:4, → data URI + dims. */
  async prepareImageForHeadshot(buffer) {
    const meta = await sharp(buffer).rotate().metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    let pipeline = sharp(buffer).rotate();
    if (longest > MAX_HEADSHOT_DIMENSION) {
      pipeline = pipeline.resize(MAX_HEADSHOT_DIMENSION, MAX_HEADSHOT_DIMENSION, {
        fit: 'inside', withoutEnlargement: true,
      });
    }
    const outBuf = await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    const outMeta = await sharp(outBuf).metadata();
    return {
      buffer: outBuf,
      dataUri: `data:image/jpeg;base64,${outBuf.toString('base64')}`,
      width: outMeta.width ?? 0,
      height: outMeta.height ?? 0,
    };
  }

  async postPrediction(modelSlug, input, maxRetries = 5) {
    const url = `${REPLICATE_BASE}/models/${modelSlug}/predictions`;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token()}`,
          'Content-Type': 'application/json',
          Prefer: 'wait=0',
        },
        body: JSON.stringify({ input }),
      });
      if (res.status === 429 && attempt < maxRetries) {
        const text = await res.text();
        const match = text.match(/resets in ~(\d+)s/i);
        const waitMs = (match ? parseInt(match[1], 10) : 12) * 1000 + 500;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Replicate POST ${modelSlug} failed (${res.status}): ${text.slice(0, 300)}`);
      }
      return res.json();
    }
    throw new Error(`Replicate POST ${modelSlug} exceeded retry limit (429)`);
  }

  async postVersionPrediction(modelSlug, version, input, maxRetries = 5) {
    const url = `${REPLICATE_BASE}/predictions`;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token()}`,
          'Content-Type': 'application/json',
          Prefer: 'wait=0',
        },
        body: JSON.stringify({ version, input }),
      });
      if (res.status === 429 && attempt < maxRetries) {
        const text = await res.text();
        const match = text.match(/resets in ~(\d+)s/i);
        const waitMs = (match ? parseInt(match[1], 10) : 12) * 1000 + 500;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Replicate POST ${modelSlug} (versioned) failed (${res.status}): ${text.slice(0, 300)}`);
      }
      return res.json();
    }
    throw new Error(`Replicate POST ${modelSlug} exceeded retry limit (429)`);
  }

  async pollPrediction(getUrl) {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const res = await fetch(getUrl, {
        headers: { Authorization: `Bearer ${this.token()}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Replicate poll failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'canceled') {
        return data;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error('Replicate prediction timed out');
  }

  async runPrediction(modelSlug, input, maxTransientRetries = 3, version) {
    const started = Date.now();
    let lastError = 'unknown error';
    for (let attempt = 0; attempt <= maxTransientRetries; attempt++) {
      const created = version
        ? await this.postVersionPrediction(modelSlug, version, input)
        : await this.postPrediction(modelSlug, input);
      const final = created.urls?.get ? await this.pollPrediction(created.urls.get) : created;

      if (final.status === 'succeeded') {
        const output = Array.isArray(final.output) ? final.output[0] : final.output;
        if (!output || typeof output !== 'string') {
          throw new Error(`${modelSlug} returned no output URL`);
        }
        return { outputUrl: output, predictionId: final.id, durationMs: Date.now() - started };
      }
      lastError = final.error ?? `${final.status}`;
      if (attempt < maxTransientRetries && isTransientPredictionFailure(final.error)) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(`${modelSlug} prediction ${final.status}: ${lastError}`);
    }
    throw new Error(`${modelSlug} prediction failed after retries: ${lastError}`);
  }

  runNanoBananaPro(input) {
    return this.runPrediction(NANO_BANANA_PRO_MODEL, input);
  }

  runCodeFormer(input) {
    return this.runPrediction(CODEFORMER_MODEL, {
      background_enhance: false,
      face_upsample: true,
      upscale: 1,
      codeformer_fidelity: 0.7,
      ...input,
    }, 3, CODEFORMER_VERSION);
  }

  /** InSPyReNet: threshold 0 = soft alpha (hair/fine edges); preserves resolution. */
  runRemoveBackground(image) {
    return this.runPrediction(
      REMOVE_BG_MODEL,
      { image, background_type: 'rgba', threshold: 0, format: 'png' },
      3,
      REMOVE_BG_VERSION,
    );
  }

  /** BiRefNet: always pass the exact "WxH" or it downsamples to ~1024px. */
  runBirefnet(image, resolution) {
    const input = { image };
    if (resolution) input.resolution = resolution;
    return this.runPrediction(BIREFNET_MODEL, input, 3, BIREFNET_VERSION);
  }

  runRealEsrgan(input) {
    return this.runPrediction(REAL_ESRGAN_MODEL, input);
  }

  async urlToBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url.slice(0, 80)} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async testConnection(overrideToken) {
    const token = overrideToken || this.getToken();
    if (!token) return { ok: false, error: 'No API key set' };
    try {
      const res = await fetch(`${REPLICATE_BASE}/models?cursor=`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = {
  ReplicateClient,
  MODELS: {
    NANO_BANANA_PRO: NANO_BANANA_PRO_MODEL,
    CODEFORMER: CODEFORMER_MODEL,
    REAL_ESRGAN: REAL_ESRGAN_MODEL,
    REMOVE_BG: REMOVE_BG_MODEL,
    BIREFNET: BIREFNET_MODEL,
  },
};
