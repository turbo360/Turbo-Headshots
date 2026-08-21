// Dispatch cost model — single source of truth for estimates.
// Rates match engine/usage.js COST_USD (derived from the real August 2026
// Replicate invoice; NBP 4K bills $0.30/image on Replicate). keepClothing =
// guard-in + guard-out bg-remover calls; non-birefnet cutout reuses the
// guard-out matte for free.
function estimate(fileCount, opts) {
  const versions = Math.max(1, (opts.backdrops || []).length);
  // Local engine: masks run on this Mac — only NBP (and print upscale) bill.
  const localMasks = opts.engine === 'local';
  const perVersion =
    0.30 +
    (opts.faceRestore ? 0.012 : 0) +
    (opts.keepClothing && !localMasks ? 0.004 : 0) +
    (opts.cutout && opts.matte === 'birefnet' && !localMasks ? 0.009 : 0) +
    (opts.print8k ? 0.002 : 0);
  const perFrame = versions * perVersion;
  return {
    perFrame: Number(perFrame.toFixed(4)),
    total: Number((perFrame * fileCount).toFixed(4)),
  };
}

module.exports = { estimate };
