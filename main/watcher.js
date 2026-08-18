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
    // stem -> { at, raw, registered: {personId, baseName} | null }
    // A RAW+JPEG pair shares a stem; only the first arrival registers, and a
    // late RAW is ATTACHED to the already-registered frame (never re-registered
    // — that was double-billing every shot when the JPEG stabilised first).
    this.recentlyProcessed = new Map();
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

    this.watcher.on('add', (filePath) => {
      try {
        this.onAdd(filePath, folder);
      } catch (err) {
        // A full disk / unplugged SSD / vanished file must never crash the
        // app mid-shoot — surface it in the engine log instead.
        console.error('[watcher] onAdd failed:', err.message);
        this.deps.push('processing-log', { message: `Capture ingest failed for ${path.basename(filePath)}: ${err.message}`, type: 'error' });
      }
    });
    this.watcher.on('error', (err) => console.error('[watcher]', err.message));
    console.log('[watcher] watching', folder);

    this.reconcile(folder);
  }

  /**
   * Captures taken while the app was down: chokidar (ignoreInitial) never
   * re-fires 'add' for pre-existing files, so on start with a restored active
   * session, route files newer than the last registered frame.
   */
  reconcile(folder) {
    try {
      const st = this.deps.session.state();
      if (!st.active || !st.startedAt) return;
      const person = this.deps.session.personId
        ? this.deps.session.shoots.getPerson(this.deps.session.personId) : null;
      const lastFrameAt = person?.frames.length
        ? new Date(person.frames[person.frames.length - 1].capturedAt).getTime()
        : new Date(st.startedAt).getTime();
      const candidates = fs.readdirSync(folder)
        .filter((f) => !f.startsWith('.') && IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
        .map((f) => ({ f, mtime: fs.statSync(path.join(folder, f)).mtimeMs }))
        .filter((x) => x.mtime > lastFrameAt)
        .sort((a, b) => a.mtime - b.mtime);
      for (const { f } of candidates) {
        try { this.onAdd(path.join(folder, f), folder); } catch (err) {
          console.error('[watcher] reconcile item failed:', err.message);
        }
      }
      if (candidates.length) {
        this.deps.push('processing-log', { message: `Recovered ${candidates.length} capture(s) taken while the app was closed`, type: 'warning' });
      }
    } catch (err) {
      console.error('[watcher] reconcile failed:', err.message);
    }
  }

  onAdd(filePath, folder) {
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) return;
    if (path.dirname(filePath) !== folder) return; // ignore organized output

    const now = Date.now();
    const stem = path.basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
    const isRaw = RAW_EXTS.includes(ext);

    for (const [k, v] of this.recentlyProcessed) {
      if (now - v.at > 60000) this.recentlyProcessed.delete(k);
    }

    const seen = this.recentlyProcessed.get(stem);
    if (seen && now - seen.at < 30000) {
      if (isRaw && !seen.raw) {
        seen.raw = true;
        // The pair's JPEG already routed. If it was registered as a frame,
        // attach the RAW to that frame instead of registering a second one.
        if (seen.registered) {
          this.deps.session.attachRaw(seen.registered.personId, seen.registered.baseName, filePath);
        }
      }
      return;
    }
    this.recentlyProcessed.set(stem, { at: now, raw: isRaw, registered: null });

    if (isRaw || this.deps.session.state().active) {
      const res = this.deps.session.registerCapture(filePath);
      if (res) {
        this.recentlyProcessed.get(stem).registered = {
          personId: res.person.id, baseName: res.frame.baseName,
        };
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
