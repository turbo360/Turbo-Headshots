// Dispatch cost model — single source of truth for estimates.
// Matches the v2 design prototype formula:
//   perFrame = versions × (0.05 NBP + faceRestore·0.003 + keepClothing·0.001 guard
//              + cutout·(birefnet ? 0.005 : 0.0005) + print8k·0.005)
function estimate(fileCount, opts) {
  const versions = Math.max(1, (opts.backdrops || []).length);
  const perVersion =
    0.05 +
    (opts.faceRestore ? 0.003 : 0) +
    (opts.keepClothing ? 0.001 : 0) +
    (opts.cutout ? (opts.matte === 'birefnet' ? 0.005 : 0.0005) : 0) +
    (opts.print8k ? 0.005 : 0);
  const perFrame = versions * perVersion;
  return {
    perFrame: Number(perFrame.toFixed(4)),
    total: Number((perFrame * fileCount).toFixed(4)),
  };
}

module.exports = { estimate };
