#!/usr/bin/env node
// Standalone engine selftest — runs ONE frame through all pipeline stages
// against the real Replicate API (costs ~$0.06). No Electron required.
//
//   REPLICATE_API_TOKEN=r8_… node engine/selftest.js <portrait.jpg> [backdrop] [framing]
//
// Outputs land in a temp folder that is printed at the end.
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ReplicateClient } = require('./replicateClient');
const { processRender } = require('./pipeline');
const { Usage } = require('./usage');
const SidecarClient = require('../sidecar-client');

async function main() {
  const [, , imagePath, backdrop = 'grey', framing = 'chest-up'] = process.argv;
  if (!imagePath || !fs.existsSync(imagePath)) {
    console.error('Usage: REPLICATE_API_TOKEN=… node engine/selftest.js <portrait.jpg> [backdrop] [framing]');
    process.exit(1);
  }
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) { console.error('REPLICATE_API_TOKEN not set'); process.exit(1); }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'th-selftest-'));
  const fakeApp = { getPath: () => work, isPackaged: false, getAppPath: () => path.join(__dirname, '..') };
  const settings = {
    raw: {
      watchFolder: null, jpegQuality: 92, sharpening: 0.8,
      brightness: 1.12, whiteBalanceStrength: 1.0,
    },
  };
  const client = new ReplicateClient(() => token);
  const usage = new Usage(fakeApp);
  const sidecarPath = path.join(__dirname, '..', 'sidecar', '.build', 'release', 'HeadshotSidecar');
  const sidecar = new SidecarClient(sidecarPath);
  sidecar.start();

  const ext = path.extname(imagePath);
  const baseName = 'selftest_01';
  const frame = {
    file: path.join(work, `${baseName}${ext}`),
    jpegFile: null,
    baseName,
  };
  fs.copyFileSync(imagePath, frame.file);
  if (!['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'].includes(ext.toLowerCase())) {
    frame.jpegFile = frame.file;
  }

  const opts = {
    backdrops: [backdrop], framing, keepClothing: true, faceRestore: true,
    glasses: false, portrait: true, square: true, cutout: true,
    matte: 'inspyrenet', print8k: false,
  };

  console.log(`\n▶ selftest: ${path.basename(imagePath)} → ${backdrop} / ${framing}\n`);
  const t0 = Date.now();
  try {
    const result = await processRender(
      { frame, personFolder: work, baseName, backdrop, opts },
      {
        client, sidecar, usage, settings,
        onStage: (k, label, pct) => console.log(`  [${String(pct).padStart(3)}%] ${label}`),
      },
      new Map(),
    );
    console.log(`\n✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('  flags:', result.flags.length ? result.flags.join(', ') : '(none)');
    for (const o of result.outputs) {
      const kb = Math.round(fs.statSync(o.path).size / 1024);
      console.log(`  ${o.kind.padEnd(7)} ${kb}KB  ${o.path}`);
    }
    if (result.verify) {
      console.log(`  verify: hasBranding=${result.verify.hasBranding}`);
      console.log(`          ${result.verify.torsoIn}`);
      console.log(`          ${result.verify.torsoOut}`);
    }
    console.log(`\n  usage ledger: ${path.join(work, 'usage.jsonl')}`);
    console.log(`  outputs:      ${path.join(work, 'Processed')}\n`);
  } catch (err) {
    console.error('\n✗ selftest failed:', err.message);
    process.exitCode = 1;
  } finally {
    sidecar.stop();
  }
}

void main();
