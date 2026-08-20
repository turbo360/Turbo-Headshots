// Append-only cost ledger: userData/usage.jsonl — one row per Replicate call.
const fs = require('fs');
const path = require('path');

// Rates derived from the actual Replicate August 2026 invoice (invoice $ /
// app-logged run counts) + the model's published price card: NBP 4K is $0.30
// per output image ON REPLICATE (1K/2K $0.15) — higher than Google's direct
// API. Beware: timed-out NBP predictions still bill; they never reach this
// ledger, so the real account spend runs slightly above the app's figure.
const COST_USD = {
  'google/nano-banana-pro': 0.30,
  'sczhou/codeformer': 0.012,
  '851-labs/background-remover': 0.002,
  'men1scus/birefnet': 0.009,
  'nightmareai/real-esrgan': 0.002,
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
