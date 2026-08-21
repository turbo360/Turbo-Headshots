// Optional local BiRefNet matte — full Replicate-quality hair edges, no cloud.
//
// Looks for a user-installed runtime at userData/birefnet/ (venv + infer
// script). When present, a persistent Python worker is spawned lazily and kept
// warm (model load is ~10s; per-image inference ~1-2s on Apple Silicon MPS).
// When absent, callers fall back to the sidecar's Vision mask — the app ships
// with zero Python dependencies.
//
// Protocol: one JSON line per request  {"in": path, "out": path}
//           one JSON line per reply    {"ok": true} | {"ok": false, "error": s}
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let dir = null; // userData/birefnet
let proc = null;
let queue = Promise.resolve(); // serialize requests to the single worker

function init(userDataDir) {
  dir = path.join(userDataDir, 'birefnet');
}

function available() {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'venv', 'bin', 'python3'))
    && fs.existsSync(path.join(dir, 'birefnet_infer.py'));
}

function ensureWorker() {
  if (proc && proc.exitCode === null) return proc;
  const py = path.join(dir, 'venv', 'bin', 'python3');
  proc = spawn(py, [path.join(dir, 'birefnet_infer.py')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' },
  });
  proc.stderr.on('data', (d) => console.error('[birefnet]', String(d).trim()));
  proc.on('exit', (code) => { console.error(`[birefnet] worker exited (${code})`); proc = null; });
  return proc;
}

/** Matte one image file to a transparent PNG. Rejects on worker failure —
    callers should catch and fall back to the Vision mask. */
function matte(inputPath, outputPath, timeoutMs = 120000) {
  const run = () => new Promise((resolve, reject) => {
    const p = ensureWorker();
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      try { p.kill(); } catch { /* ignore */ }
      reject(new Error('birefnet worker timed out'));
    }, timeoutMs);
    const onData = (d) => {
      buf += String(d);
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      cleanup();
      try {
        const res = JSON.parse(buf.slice(0, nl));
        res.ok ? resolve() : reject(new Error(res.error || 'birefnet failed'));
      } catch (err) { reject(err); }
    };
    const onExit = () => { cleanup(); reject(new Error('birefnet worker died')); };
    const cleanup = () => {
      clearTimeout(timer);
      p.stdout.off('data', onData);
      p.off('exit', onExit);
    };
    p.stdout.on('data', onData);
    p.on('exit', onExit);
    p.stdin.write(`${JSON.stringify({ in: inputPath, out: outputPath })}\n`);
  });
  queue = queue.then(run, run);
  return queue;
}

function stop() {
  if (proc) { try { proc.kill(); } catch { /* ignore */ } proc = null; }
}

module.exports = { init, available, matte, stop };
