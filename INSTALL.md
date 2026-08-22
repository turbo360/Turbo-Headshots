# Turbo Headshots — Fresh Mac Install Guide

Everything needed to run Turbo Headshots on a new machine, from zero to
shoot-ready. Written for Apple Silicon Macs (M1 or newer, 16 GB+ RAM;
64 GB recommended if you'll use the local AI runtime).

## 1. The app

1. Download the latest `turbo-headshots-x.y.z-universal.dmg` from
   <https://github.com/turbo360/Turbo-Headshots/releases/latest>.
2. Drag **Turbo Headshots** to Applications and launch it. The app is signed
   and notarized — no Gatekeeper overrides needed.
3. Updates are automatic from that same releases feed (a banner appears in
   the app; installing takes a quit + relaunch).

## 2. First-launch configuration (Settings)

| Setting | What to set |
|---|---|
| **Watch folder** | The folder LUMIX Tether saves captures into (e.g. `~/Documents/TURBO TETHER`) |
| **Output folder** | Where organised shoot folders are created (e.g. `~/Documents/TURBO TETHER/Outputs`) |
| **Replicate API key** | Settings → Integrations → paste the `r8_…` key (from replicate.com → Account → API tokens), then **Save & test** |
| **Turbo IQ login** | Gallery Upload → sign in with the IQ admin account — enables gallery auto-upload, QR check-in, and deliveries |
| **Worker lanes** | 4 is safe anywhere; 8 on a fast connection for big queues |

## 3. Camera tethering

- Install **LUMIX Tether** and set its save folder to the Watch folder above.
- Shoot **RAW+JPEG** — the app uses the JPEG for previews/processing and
  keeps the RAW beside it.
- If you must shoot RAW-only, install the fallback converters:
  `brew install exiftool` (extracts the camera's embedded full-res JPEG).

## 4. The three processing pipelines (chosen per shoot)

When creating a shoot you pick its pipeline:

| Pipeline | What runs where | Cost/render | When to use |
|---|---|---|---|
| **Replicate** | Everything in the cloud (Nano Banana re-light + cloud masks) | ~$0.31 | Default. Rescues rough capture lighting |
| **Hybrid Local** | Nano Banana in the cloud; masks/cutouts on the Mac | ~$0.30 | Same look, faster — needs the local runtime for best mattes |
| **Fully Local** | No AI re-render: real pixels, colour correction, procedural studio backdrop | $0.00 | Well-lit captures; zero identity risk; works with no internet |

## 5. Local AI runtime (optional, recommended for Hybrid/Fully Local)

The app works out of the box using Apple's built-in Vision person-mask.
Installing the **local BiRefNet runtime** upgrades mattes to studio-grade
hair edges (the same model the cloud pipeline uses).

**One-click (preferred):** Settings → Look & engine → **Local AI runtime →
Install local BiRefNet**. The app finds Python, builds a private
environment under its own data folder, and downloads ~2 GB of
dependencies, then pre-downloads the model weights (~900 MB) and warms the model up so the first shoot frame is instant.

**Prerequisite:** Python 3.10+ available at `/opt/homebrew/bin/python3`.
If the installer reports no Python: install [Homebrew](https://brew.sh),
run `brew install python`, and click Install again.

**Manual (equivalent to the button):**

```bash
D="$HOME/Library/Application Support/turbo-headshots/birefnet"
mkdir -p "$D"
/opt/homebrew/bin/python3 -m venv "$D/venv"
"$D/venv/bin/pip" install torch torchvision transformers timm einops kornia pillow
# the worker script ships inside the app; the in-app installer writes it,
# or copy engine/birefnetInstall.js's INFER_SCRIPT to "$D/birefnet_infer.py"
```

Nothing else is required — the app detects the runtime at
`~/Library/Application Support/turbo-headshots/birefnet/` on launch and on
each local-shoot dispatch, and silently falls back to Vision if it's absent
or broken.

## 6. Verify the install

1. Create a test shoot (pipeline: **Fully Local** — needs no key/credit).
2. Register a subject, drop a portrait JPEG into the watch folder.
3. Review → Approve → Send to pipeline. A grey-backdrop composite should
   appear in the person's `Processed/` folder within seconds.
4. Switch a second test shoot to **Replicate** to confirm the API key and
   IQ upload path end-to-end (bills ~$0.31).

## Troubleshooting

- **"No JPEG available"** — camera not in RAW+JPEG mode and exiftool not
  installed (`brew install exiftool`).
- **Engine paused / offline** — the queue auto-pauses without internet and
  resumes itself; Fully Local shoots are unaffected.
- **Local install fails on `torch`** — Python too old or too new for the
  current torch wheels; `brew install python` and retry with the fresh one.
- **Mattes look soft on hair** — the BiRefNet runtime isn't installed or
  its worker failed (check for `birefnetLocalFailed` flags in item logs);
  reinstall from Settings.
