// Append-only cost ledger: userData/usage.jsonl — one row per Replicate call.
const fs = require('fs');
const path = require('path');

const COST_USD = {
  'google/nano-banana-pro': 0.05,
  'sczhou/codeformer': 0.003,
  '851-labs/background-remover': 0.0005,
  'men1scus/birefnet': 0.005,
  'nightmareai/real-esrgan': 0.005,
};

class Usage {
  constructor(app) {
    this.file = path.join(app.getPath('userData'), 'usage.jsonl');
  }

  record({ tool, model, predictionId, costUsd, meta }) {
    const row = {
      at: new Date().toISOString(),
      tool, model, predictionId,
      costUsd: costUsd ?? COST_USD[model] ?? 0,
      ...(meta ? { meta } : {}),
    };
    try {
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    } catch (err) {
      console.error('[usage]', err.message);
    }
    return row;
  }

  /** Sum of costUsd for rows on/after `sinceIso` (default: today local midnight). */
  sum(sinceIso) {
    const since = sinceIso ?? (() => {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
    })();
    let total = 0;
    try {
      const lines = fs.readFileSync(this.file, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row.at >= since) total += row.costUsd || 0;
        } catch { /* skip bad row */ }
      }
    } catch { /* no file yet */ }
    return total;
  }
}

module.exports = { Usage, COST_USD };
