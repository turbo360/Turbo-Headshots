// Settings — same flat userData/settings.json file as v1 (additive keys only),
// so a v1 install upgrades in place and TURBO_V1=1 still reads its own keys.
const fs = require('fs');
const path = require('path');

const DEFAULT_DISPATCH_OPTS = {
  backdrops: ['grey'],
  framing: 'chest-up',
  keepClothing: true,
  // OFF: CodeFormer distorts large sharp faces (waxy skin, doubled features)
  // — and live Turbo Enhance output has run WITHOUT it since the model's
  // hosted deployment vanished. Faces ship exactly as Nano Banana renders.
  faceRestore: false,
  glasses: false,
  portrait: true,
  square: true,
  cutout: true,
  matte: 'inspyrenet',
  print8k: false,
};

class Settings {
  constructor(app) {
    this.app = app;
    this.path = path.join(app.getPath('userData'), 'settings.json');
    this.raw = {};
    this.load();
  }

  load() {
    try {
      this.raw = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
    } catch {
      this.raw = {};
    }
    // v2 defaults layered over whatever exists (v1 keys preserved untouched)
    const r = this.raw;
    r.watchFolder = r.watchFolder || '';
    r.outputFolder = r.outputFolder || '';
    r.sessionsFile = r.sessionsFile || (r.outputFolder ? path.join(r.outputFolder, 'headshot_sessions.csv') : '');
    r.contactsFile = r.contactsFile || (r.outputFolder ? path.join(r.outputFolder, 'contacts.csv') : '');
    r.replicateApiKey = r.replicateApiKey || '';
    r.processingEnabled = r.processingEnabled !== false;
    r.brightness = r.brightness ?? 1.12;
    r.whiteBalanceStrength = r.whiteBalanceStrength ?? 1.0;
    r.sharpening = r.sharpening ?? 0.8;
    r.jpegQuality = r.jpegQuality ?? 92;
    // v2 additions
    r.preset = r.preset || 'studio';
    r.processEveryFrame = r.processEveryFrame ?? (r.autoProcessOnCapture !== false);
    r.holdUntilShootEnd = r.holdUntilShootEnd ?? false;
    r.workerCount = r.workerCount ?? 4;
    r.activeShootId = r.activeShootId ?? null;
    r.activeSession = r.activeSession ?? null;
    r.defaultDispatchOpts = { ...DEFAULT_DISPATCH_OPTS, ...(r.defaultDispatchOpts || {}) };
    // One-time migration (v2.4.1): flip pre-existing faceRestore defaults off.
    if (!r.faceRestoreMigrated) {
      r.defaultDispatchOpts.faceRestore = false;
      r.faceRestoreMigrated = true;
    }
    // gallery keys (v1 names kept)
    r.galleryUsername = r.galleryUsername || '';
    r.galleryPassword = r.galleryPassword || '';
    r.galleryAutoUpload = r.galleryAutoUpload ?? false;
    r.uploadPortrait = r.uploadPortrait !== false;
    r.uploadSquare = r.uploadSquare !== false;
    r.uploadTransparent = r.uploadTransparent !== false;
    r.lastGalleryId = r.lastGalleryId ?? null;
    r.lastGalleryName = r.lastGalleryName ?? null;
  }

  save() {
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.raw, null, 1));
    fs.renameSync(tmp, this.path);
  }

  patch(p) {
    Object.assign(this.raw, p);
    this.save();
  }

  /** Renderer-facing app settings. */
  appSettings() {
    return {
      watchFolder: this.raw.watchFolder || null,
      outputFolder: this.raw.outputFolder || null,
      activeShootId: this.raw.activeShootId,
    };
  }

  /** Renderer-facing AI settings (never leaks the key). */
  aiSettings() {
    const r = this.raw;
    return {
      hasApiKey: !!r.replicateApiKey,
      processingEnabled: r.processingEnabled,
      processEveryFrame: r.processEveryFrame,
      holdUntilShootEnd: r.holdUntilShootEnd,
      preset: r.preset,
      brightness: r.brightness,
      whiteBalanceStrength: r.whiteBalanceStrength,
      sharpening: r.sharpening,
      jpegQuality: r.jpegQuality,
      defaultDispatchOpts: r.defaultDispatchOpts,
      workerCount: r.workerCount,
    };
  }
}

module.exports = { Settings, DEFAULT_DISPATCH_OPTS };
