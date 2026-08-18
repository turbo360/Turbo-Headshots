// Watch-folder ingestion (v1 chokidar config) with RAW/JPEG routing moved
// main-side. RAW while a session is active → registerCapture → maybe enqueue.
// JPEG-only arrivals drive the capture preview.
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { RAW_EXTS } = require('./shoots');

const IMAGE_EXTS = ['.jpg', '.jpeg', ...RAW_EXTS];

class Watcher {
  /**
   * @param {object} deps { settings, session, push, onFrame(person, frame), qualityCheck(jpegPath, personId, baseName) }
   */
  constructor(deps) {
    this.deps = deps;
    this.watcher = null;
    this.recentlyProcessed = new Map(); // filename -> ts (30s dedup, v1 behaviour)
  }

  start() {
    const folder = this.deps.settings.raw.watchFolder;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (!folder || !fs.existsSync(folder)) return;

    this.watcher = chokidar.watch(folder, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
      depth: 0,
      usePolling: false,
    });

    this.watcher.on('add', (filePath) => this.onAdd(filePath, folder));
    this.watcher.on('error', (err) => console.error('[watcher]', err.message));
    console.log('[watcher] watching', folder);
  }

  onAdd(filePath, folder) {
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) return;
    if (path.dirname(filePath) !== folder) return; // ignore organized output

    const filename = path.basename(filePath);
    const now = Date.now();
    const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();
    const isRaw = RAW_EXTS.includes(ext);

    // Dedup: RAW+JPEG pairs share a stem; only the first arrival routes.
    // v1 keyed on the full filename, which let the pair double-fire when both
    // were image types — key on the stem instead, but let a RAW supersede a
    // JPEG that arrived first (the RAW is the capture of record).
    const seen = this.recentlyProcessed.get(stem);
    if (seen && now - seen.at < 30000) {
      if (!(isRaw && !seen.raw)) {
        return;
      }
    }
    this.recentlyProcessed.set(stem, { at: now, raw: isRaw });
    for (const [k, v] of this.recentlyProcessed) {
      if (now - v.at > 60000) this.recentlyProcessed.delete(k);
    }

    if (isRaw || this.deps.session.state().active) {
      const res = this.deps.session.registerCapture(filePath);
      if (res) {
        const jpeg = res.frame.jpegFile;
        if (jpeg && this.deps.qualityCheck) {
          this.deps.qualityCheck(jpeg, res.person.id, res.frame.baseName);
        }
        if (this.deps.onFrame) this.deps.onFrame(res.person, res.frame);
        return;
      }
      // No active session: fall through to preview so the operator sees frames.
    }

    // Preview-only (JPEG with no session, or unroutable capture).
    this.deps.push('session:preview', {
      previewUrl: `media://${encodeURI(filePath)}?w=1600`,
    });
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  }
}

module.exports = { Watcher };
