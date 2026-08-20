// Dispatch cost model — single source of truth for estimates.
// Rates match engine/usage.js COST_USD (NBP 4K $0.24 official; time-billed
// models measured live 2026-08-20). keepClothing = guard-in + guard-out
// bg-remover calls; non-birefnet cutout reuses the guard-out matte for free.
function estimate(fileCount, opts) {
  const versions = Math.max(1, (opts.backdrops || []).length);
  const perVersion =
    0.24 +
    (opts.faceRestore ? 0.003 : 0) +
    (opts.keepClothing ? 0.01 : 0) +
    (opts.cutout && opts.matte === 'birefnet' ? 0.006 : 0) +
    (opts.print8k ? 0.015 : 0);
  const perFrame = versions * perVersion;
  return {
    perFrame: Number(perFrame.toFixed(4)),
    total: Number((perFrame * fileCount).toFixed(4)),
  };
}

module.exports = { estimate };
