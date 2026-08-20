// Append-only cost ledger: userData/usage.jsonl — one row per Replicate call.
const fs = require('fs');
const path = require('path');

// NBP is Google's official per-image price for 4K output ($0.134 at 1K/2K).
// The time-billed models are averages measured from live 2026-08-20 predictions
// (predict_time × GPU rate): esrgan ~15s, birefnet ~6.3s, bg-remover ~5s.
const COST_USD = {
  'google/nano-banana-pro': 0.24,
  'sczhou/codeformer': 0.003,
  '851-labs/background-remover': 0.005,
  'men1scus/birefnet': 0.006,
  'nightmareai/real-esrgan': 0.015,
};

class Usage {
  constructor(app) {
    this.file = path.join(app.getPath('userData'), 'usage.jsonl');
    this._todayKey = null;
    this._todaySum = null;
  }

  _todayStart() {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }

  /** Cached day total — incremented on record(), full scan only on day change. */
  sumToday() {
    const key = this._todayStart().toISOString();
    if (this._todayKey !== key || this._todaySum === null) {
      this._todayKey = key;
      this._todaySum = this.sum(key);
    }
    return this._todaySum;
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
    if (this._todaySum !== null && this._todayKey === this._todayStart().toISOString()) {
      this._todaySum += row.costUsd;
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
