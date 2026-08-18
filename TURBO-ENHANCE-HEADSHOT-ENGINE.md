# Turbo Headshot Engine — porting Turbo Enhance's headshot pipeline into Turbo Headshots

> Handoff doc for the Turbo Headshots redesign. Documents exactly what Turbo Enhance does
> for headshots (models, parameters, prompts, safeguards) so the same engine can be built
> into this app. Shareable designed version: https://claude.ai/code/artifact/f898ac9e-c76d-413d-8333-2a6ea9e72836
>
> Source of truth: `turbo-enhance/src/app/api/headshot/route.ts` (pipeline),
> `turbo-enhance/src/lib/prompts.ts` (prompt text), `turbo-enhance/src/lib/replicate.ts`
> (Replicate client + wrappers), `turbo-enhance/src/lib/brandingCheck.ts` (logo guard),
> `turbo-enhance/src/lib/upscale.ts` (print upscale). These are plain Node + sharp with no
> Next.js dependency — liftable near-verbatim into the Electron main process.

## 1. What the operator gets in Turbo Enhance today

Bulk tool: drop up to **200 photos**, batch-level style settings, 4-wide worker pool, one
`POST /api/headshot` per photo, 2 automatic retries per photo, per-photo failure isolation.

Style controls (batch-level):

| Control | Options | Default |
|---|---|---|
| Backdrop (neutral) | White seamless · Mid grey · Corporate navy · Outdoor bokeh · Soft office | Mid grey |
| Backdrop (branded) | Turbo (dark + orange edge light) · Stage (keynote bokeh) · Event floor (fairy-light bokeh) | — |
| Framing | Chest up · Shoulders up · Head tight · Original framing | Chest up |
| Keep glasses | on/off (both directions preserve eyewear; neither adds/removes) | off |
| Keep original clothing | on = preserve exact garments + branding · off = restyle into business attire | **on** |
| Enhance faces | CodeFormer face-restore pass | on |
| Upscale for print (8K) | chains Real-ESRGAN per photo | off |

Results screen: before/after compare slider, per-photo download, per-photo 8K upscale,
**Verify branding** (side-by-side input/output chest crops), badges ("Clothing
pixel-locked" / "⚠ Pixel-lock skipped: reason"), Download all → server-streamed ZIP
(prefers the 8K `-print-` file when it exists).

## 2. The pipeline (execution order)

One request = one photo. Steps 2, 5, 6 are **fail-soft** — an error degrades protection or
polish but never blocks the headshot.

1. **Prepare input (sharp, local)** — validate (JPEG/PNG/WebP, ≤30MB) → `.rotate()` (EXIF)
   → longest side ≤ **4096px** → JPEG **q95, 4:4:4** → data URI. 4096 is headshot-specific
   (other tools cap at 2048): at 2048 a chest logo reaches the model at a few dozen pixels
   and gets hallucinated back. The prepared image is the one canonical coordinate space for
   the whole request.
2. **Branding guard, input side (keep-clothing only, fail-soft)** — InSPyReNet matte
   (`851-labs/background-remover`) → person bbox from alpha (≤512px proxy, threshold >32)
   → torso band = 28–92% of person height, 8–92% of width → native-res chest crop (JPEG
   q95, ≤2048) sent as `image_input[1]` ("authoritative reference").
3. **Build prompt** — `buildHeadshotPrompt()` (see §3). Attempt 2 (operator re-run after
   flagged branding drift) appends a harder "garment area is read-only pixels" line.
4. **Generate — `google/nano-banana-pro`** — `image_input: [photo, torsoCrop?]`,
   `resolution: "4K"`, `output_format: "jpg"`, `safety_filter_level: "block_only_high"`.
   Aspect ratio: `match_input_image` for the three reframing crops; **Original framing pins
   the nearest concrete ratio** from {1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9} —
   `match_input_image` drifts the canvas (a 3:4 input came back ≈2:3 live), which sinks the
   pixel-lock geometry gate.
5. **Face restore — `sczhou/codeformer` (toggle, default on, fail-soft)** —
   `codeformer_fidelity: 0.7`, `background_enhance: false`, `face_upsample: true`,
   `upscale: 1`. Faces only; the single biggest win against "AI sheen". On failure the
   un-restored result ships with `faceRestoreError` in the response.
6. **Branding guard, output side (fail-soft)** — second InSPyReNet matte on the output →
   output torso crop. Both torso crops persisted (`-torso-in`/`-torso-out`) for the
   Verify-branding UI. Original framing runs the pixel-lock here (§4). A cheap chroma+edge
   presence probe sets `hasBranding`.
7. **Persist + meter** — final buffer mirrored to `data/generated/{yyyy}/{mm}/`; usage rows:
   `headshot` (~$0.05), `headshot-guard` (~$0.0005 × 2), `photo-faces` (~$0.003).
8. **Optional 8K upscale** — separate client-side `POST /api/upscale` chain (two sub-100s
   requests keeps Cloudflare happy; a desktop app has no such ceiling and could do one job).

## 3. The prompt (`buildHeadshotPrompt`)

Skeleton, in order:

```
Re-render this photo as a professional corporate headshot.
Background: {backdrop fragment}.
Framing: {framing fragment}.
Lighting: soft, large key light from camera-left (~45°), gentle fill from camera-right,
  subtle rim light separating the subject from the backdrop.
Skin: polished but natural — keep real skin texture, pores, and asymmetric expressions;
  do not smooth into plastic.
Eyes sharp and well-lit with a small natural catchlight. Mouth and jaw relaxed,
  professional but warm.
CRITICAL IDENTITY: keep the exact same person. Same face geometry, same age, same
  ethnicity, same hairstyle and colour, same facial hair (or lack thereof), same
  expression character. Do not slim, de-age, or change facial features.
{wardrobe block} {branding-reference line?} {retry line?} {glasses line}
Output: high-resolution, sharp focus on the eyes, cinematic but commercial. Do not add
  text, logos, watermarks, jewellery, or accessories that aren't in the original.
```

Backdrop fragments (`BACKDROP_PROMPTS`): white / grey (#7a7d80 vignette) / navy (#1a2a3d
radial) / outdoor-soft / office-soft / turbo (dark + warm orange edge light) / stage /
event-bokeh. Framing fragments (`CROP_PROMPTS`): chest-up / shoulders-up / head-tight /
original ("keep the subject's exact framing, scale, position and pose … only the backdrop
and lighting change").

Key wardrobe language (keep-clothing on) — reuse verbatim, it is the battle-tested wording
that stops Nano Banana re-lettering text:

> "WARDROBE — KEEP ORIGINAL CLOTHING: … only relight it to match the new studio lighting.
> BRANDING IS SACRED: ALL logos, brand marks, embroidery, printed graphics and lettering on
> the clothing must remain character-for-character and pixel-for-pixel identical to the
> input — never re-spell, re-letter, re-font, re-size, warp, blur, sharpen-invent or redraw
> any logo or text on a garment. If any part of a logo is unclear, reproduce it exactly as
> it appears rather than guessing."

Full text of all fragments: `turbo-enhance/src/lib/prompts.ts`.

## 4. Shirt-logo protection (`brandingCheck.ts`)

Five layers, all fail-soft:

1. **4096px inputs** — logos legible at inference.
2. **Hi-res torso reference** as `image_input[1]` + "authoritative reference" prompt line.
3. **Hardened prompt** (BRANDING IS SACRED block).
4. **Human-verifiable compare** — persisted torso crops behind a "Verify branding" button.
   Deliberately NO automated verdict: calibration showed collars/jawlines out-score badges
   and NCC forgives same-style re-lettering. A false "ok" ships a mangled logo.
5. **Pixel-lock (Original framing only) — the hard guarantee.** Composite the ORIGINAL
   clothing pixels into the output: input person-bbox → output person-bbox similarity
   transform; luminance-matched (softened linear a/b at 50%); mask = person alpha minus the
   top 30% head band, feathered (10px blur). Gates: bbox aspect drift ≤ 12%, scale within
   0.4–3× — beyond that the composite is skipped with a reason rather than smearing pixels.

## 5. Models & Replicate mechanics

| Model | Role | Key inputs | ~Cost |
|---|---|---|---|
| `google/nano-banana-pro` | Headshot re-render (Gemini 3 Pro Image); up to 14 image refs | prompt, image_input[], aspect_ratio, resolution 1K/2K/4K, output_format, safety_filter_level | $0.05 @4K |
| `sczhou/codeformer` | Face restore (~5s) | fidelity 0.7, background_enhance false, face_upsample true, upscale 1 | $0.003 |
| `851-labs/background-remover` | InSPyReNet matte — guard + default cutout; preserves input res | threshold 0 (soft alpha), background_type "rgba", format "png" | $0.0005 |
| `men1scus/birefnet` | BiRefNet "max detail" cutout (~4s A100) | image, resolution "WxH" (pass exact prepared dims or it drops to ~1024px) | $0.005 |
| `nightmareai/real-esrgan` | Print upscale, pure pixel (10–30s) | image, scale 4, face_enhance false | $0.005 |
| `black-forest-labs/flux-fill-pro` | Mask-strict inpaint — Reframe outpaint + Magic Eraser | image, mask (white=repaint, black=byte-identical), prompt | $0.05 |

Calling conventions:

- Official models: `POST /v1/models/{owner}/{name}/predictions` with `Prefer: wait=0`, poll
  `urls.get` every 1.5s (max ~3 min).
- **Community models 404 on the slug shortcut** — run `851-labs/background-remover` and
  `men1scus/birefnet` via `POST /v1/predictions` with pinned, env-overridable version
  hashes: `REPLICATE_REMOVE_BG_VERSION=a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc`,
  `REPLICATE_BIREFNET_VERSION=f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7`.
- 429: parse "resets in ~Ns", wait N+0.5s, retry (max 5).
- Transient failed predictions (error matches `E9243` / `(code: PA)` / "please retry" /
  "interrupted" / `ModelRateLimitError` / `E003` / "high demand") → retry up to 3× with
  linear backoff. Anything else surfaces immediately.
- Auth: `REPLICATE_API_TOKEN`. Set a spend limit at replicate.com/account/billing.

## 6. Companion tools (the "edit / cut out / resize" set)

- **Transparent cut-out** — prep: EXIF-rotate, cap 4096px, JPEG q95 4:4:4 (PNG re-encode
  would only inflate the payload). Standard = InSPyReNet (soft alpha, ~2–6s); Max detail =
  BiRefNet (always pass exact `"WxH"`). Enhance runs 5-wide, 400/batch, 2 retries.
- **Print upscale (8K)** — resize input so total pixels ≤ **1,550,000** (hosted Real-ESRGAN
  OOMs at 2.0M × scale 4 as of Aug 2026), then scale 4 → ≈24.8MP (~5800px long side for
  16:9; A2 @ 300dpi class). Cache result so re-clicks don't re-bill.
- **Reframe (aspect resize by outpainting)** — targets 16:9 / 9:16 / 1:1 / 9:21 / 4:5.
  sharp builds centred canvas + mask (white = new rim), `flux-fill-pro` extends the scene
  ("no new objects, people, text, or branding"). Original pixels byte-identical. Skipped
  free if source is within 0.5% of target.
- **Magic eraser** — `meta/sam-2` click-to-segment + brush → `flux-fill-pro` fill. Headshot
  use: removing lanyards/badges/background clutter.

## 7. Cost per headshot

| Scenario | ~USD |
|---|---|
| Headshot, keep-clothing (default): NBP 4K + 2× guard mattes + CodeFormer | $0.054 |
| Headshot, restyled wardrobe (no guard) | $0.053 |
| + 8K print upscale | +$0.005 |
| + transparent cut-out (InSPyReNet / BiRefNet) | +$0.0005 / +$0.005 |
| + one reframe target | +$0.05 |

200-photo batch at defaults ≈ $11. Every call is ledgered to `usage.jsonl` (tool, model,
prediction id, cost) — keep an equivalent ledger here.

## 8. Porting map for Turbo Headshots

Current `processor.js` pipeline → target:

| Today | Target |
|---|---|
| smartcrop-sharp face detect → 4:5 / 1:1 crops | Keep — but run **after** the AI pass, on the 4K output |
| Local white-balance + brightness/saturation | Superseded by the Nano Banana Pro re-render |
| `tencentarc/gfpgan` face enhance + skin smooth | Replace with **Nano Banana Pro + CodeFormer** |
| `nightmareai/real-esrgan` upscale | Keep, adopt the 1.55M-pixel input cap + scale 4 |
| `cjwbw/rembg` background removal | Replace with **InSPyReNet / BiRefNet** for the `-TP.png` outputs |
| Output suffixes `-4x5.jpg` / `-4x5-TP.png` / `-SQR.jpg` / `-SQR-TP.png` | Unchanged |

Design decisions for the new UI:

- **Session-level style, not per-photo** — pick backdrop/framing/toggles once at session
  start; every watched-folder frame processes identically.
- **Auto-processing defaults**: keep-clothing ON, face restore ON, neutral backdrop,
  chest-up. Original framing + pixel-lock when garment branding is contractually critical.
- **Surface the fail-soft states as per-photo badges** (guard failed → prompt-only
  protection; CodeFormer failed → unrestored result; pixel-lock skipped → reason). Silent
  degradation is how a mangled logo reaches a client.
- **Keep the Verify-branding compare** (persist torso crops). Do not build an automated
  verdict — tried and removed for cause.
- **Concurrency 4, retries 2 per photo**, per-photo failure isolation. Desktop has no
  Cloudflare 100s ceiling, so enhance + upscale can be one job.
- **Meter everything** — one ledger row per model call.
