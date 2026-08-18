// Atomic JSON stores under userData/store/. tmp+rename writes, debounced.
const fs = require('fs');
const path = require('path');

// Every live store registers here so the app can flush pending debounced
// saves synchronously on quit (a 250ms timer dies with the process).
const REGISTRY = new Set();

function flushAll() {
  for (const store of REGISTRY) {
    try { store.saveNow(); } catch (err) { console.error('[store] flush failed:', err.message); }
  }
}

class JsonStore {
  /**
   * @param {string} filePath absolute path to the JSON file
   * @param {*} fallback value when the file is missing/corrupt
   */
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
    this._data = undefined;
    this._timer = null;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    REGISTRY.add(this);
  }

  get data() {
    if (this._data === undefined) this.load();
    return this._data;
  }

  set data(v) {
    this._data = v;
    this.scheduleSave();
  }

  load() {
    try {
      this._data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch (err) {
      // Corrupt/missing primary — try the backup before falling back empty.
      try {
        this._data = JSON.parse(fs.readFileSync(`${this.filePath}.bak`, 'utf-8'));
        console.error(`[store] ${path.basename(this.filePath)} unreadable (${err.code || err.message}); recovered from .bak`);
        return this._data;
      } catch { /* fall through */ }
      this._data = typeof this.fallback === 'function'
        ? this.fallback()
        : JSON.parse(JSON.stringify(this.fallback));
    }
    return this._data;
  }

  scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, 250);
  }

  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._data === undefined) return;
    const tmp = `${this.filePath}.tmp`;
    try {
      // Keep one backup generation: a corrupt/truncated write must never be
      // the only copy of the shoot records.
      if (fs.existsSync(this.filePath)) {
        try { fs.copyFileSync(this.filePath, `${this.filePath}.bak`); } catch { /* best effort */ }
      }
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 1));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`[store] save failed for ${this.filePath}:`, err.message);
    }
  }

  /** Mutate-and-persist helper. */
  update(fn) {
    const d = this.data;
    fn(d);
    this.scheduleSave();
    return d;
  }
}

module.exports = { JsonStore, flushAll };
