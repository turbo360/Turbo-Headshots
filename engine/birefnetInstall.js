// In-app installer for the optional local BiRefNet runtime.
//
// The app ships with zero Python — this module can build the runtime on any
// Mac: find a python3 (>=3.10), create userData/birefnet/venv, pip install
// torch + transformers, and write the embedded worker script. Progress is
// streamed to the renderer so Settings can show a live install log.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Kept in lockstep with engine/birefnetLocal.js protocol: strict one JSON
// request line -> one JSON reply line; no banner output.
const INFER_SCRIPT = `#!/usr/bin/env python3
"""Persistent BiRefNet matting worker for Turbo Headshots (local pipeline).

Model: ZhengPeng7/BiRefNet_HR-matting (MIT) — high-res soft-alpha matting,
chosen 2026-08-22 after a head-to-head on live shoot frames (beat the general
1024 model, portrait variant, and a ViTMatte two-stage on flyaway hair).
Aspect-preserving inference at up to 2048px long side.
"""
import sys, json
import torch
from PIL import Image, ImageOps
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

device = 'mps' if torch.backends.mps.is_available() else 'cpu'
model = AutoModelForImageSegmentation.from_pretrained('ZhengPeng7/BiRefNet_HR-matting', trust_remote_code=True)
model.to(device).eval()
if device == 'mps':
    model.half()

RES = 2048

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        im = ImageOps.exif_transpose(Image.open(req['in'])).convert('RGB')
        w, h = im.size
        scale = min(RES / w, RES / h, 1.0)
        nw = max(32, int(w * scale) // 32 * 32)
        nh = max(32, int(h * scale) // 32 * 32)
        tf = transforms.Compose([
            transforms.Resize((nh, nw)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        x = tf(im).unsqueeze(0).to(device)
        if device == 'mps':
            x = x.half()
        with torch.no_grad():
            pred = model(x)[-1].sigmoid().float().cpu()
        mask = transforms.ToPILImage()(pred[0].squeeze()).resize((w, h), Image.LANCZOS)
        out = im.convert('RGBA')
        out.putalpha(mask)
        out.save(req['out'])
        print(json.dumps({'ok': True}), flush=True)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}), flush=True)
`;

const PY_CANDIDATES = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

function findPython() {
  for (const py of PY_CANDIDATES) {
    if (!fs.existsSync(py)) continue;
    try {
      const out = require('child_process').execFileSync(py, ['-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])']);
      if (parseInt(String(out).trim(), 10) >= 310) return py;
    } catch { /* try next */ }
  }
  return null;
}

function runtimeDir(userDataDir) { return path.join(userDataDir, 'birefnet'); }

function status(userDataDir) {
  const dir = runtimeDir(userDataDir);
  const installed = fs.existsSync(path.join(dir, 'venv', 'bin', 'python3'))
    && fs.existsSync(path.join(dir, 'birefnet_infer.py'));
  return { installed, python: findPython(), installing: !!currentInstall };
}

let currentInstall = null;

/**
 * Build the runtime. onProgress(line) streams human-readable steps.
 * Resolves { ok: true } or { ok: false, error }.
 */
async function install(userDataDir, onProgress) {
  if (currentInstall) return { ok: false, error: 'Install already running' };
  const dir = runtimeDir(userDataDir);
  const py = findPython();
  if (!py) {
    return {
      ok: false,
      error: 'No Python 3.10+ found. Install Homebrew (brew.sh), then `brew install python`, and try again.',
    };
  }
  const step = (msg) => { try { onProgress(msg); } catch { /* ignore */ } };
  const sh = (cmd, args) => new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => step(String(d).trim()));
    p.stderr.on('data', (d) => step(String(d).trim()));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}`))));
    p.on('error', reject);
  });

  currentInstall = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    step(`Using ${py}`);
    step('Creating Python environment…');
    await sh(py, ['-m', 'venv', path.join(dir, 'venv')]);
    const pip = path.join(dir, 'venv', 'bin', 'pip');
    step('Downloading PyTorch + BiRefNet dependencies (~2 GB — a few minutes)…');
    await sh(pip, ['install', '--quiet', '--upgrade', 'pip']);
    await sh(pip, ['install', '--quiet', 'torch', 'torchvision', 'transformers', 'timm', 'einops', 'kornia', 'pillow']);
    fs.writeFileSync(path.join(dir, 'birefnet_infer.py'), INFER_SCRIPT);
    step('Verifying…');
    await sh(path.join(dir, 'venv', 'bin', 'python3'), ['-c', 'import torch, transformers, timm']);
    step('Downloading model weights (~900 MB) and warming up — several minutes, one time only…');
    const tmpImg = path.join(dir, 'warmup.jpg');
    const tmpOut = path.join(dir, 'warmup.png');
    await sh(path.join(dir, 'venv', 'bin', 'python3'),
      ['-c', `from PIL import Image; Image.new('RGB',(256,256),(120,120,120)).save(${JSON.stringify(tmpImg)})`]);
    await new Promise((resolve, reject) => {
      const p = spawn(path.join(dir, 'venv', 'bin', 'python3'), [path.join(dir, 'birefnet_infer.py')],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } reject(new Error('warmup timed out')); }, 15 * 60 * 1000);
      p.stderr.on('data', (d) => step(String(d).trim().slice(0, 140)));
      p.stdout.once('data', (d) => {
        clearTimeout(timer);
        let ok = false;
        try { ok = JSON.parse(String(d).split('\n')[0]).ok; } catch { /* fall through */ }
        try { p.kill(); } catch { /* ignore */ }
        ok ? resolve() : reject(new Error('warmup matte failed'));
      });
      p.on('error', reject);
      p.stdin.write(`${JSON.stringify({ in: tmpImg, out: tmpOut })}\n`);
    });
    for (const f of [tmpImg, tmpOut]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    step('Done — local BiRefNet ready.');
    return { ok: true };
  })().catch((err) => ({ ok: false, error: err.message }));

  const result = await currentInstall;
  currentInstall = null;
  return result;
}

module.exports = { status, install, INFER_SCRIPT };
