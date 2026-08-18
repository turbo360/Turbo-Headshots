// Turbo IQ gallery integration: client lifecycle, auto-upload of engine
// outputs (structured kinds, not filename sniffing), transfers registry.
const path = require('path');
const crypto = require('crypto');
const TurboIQGalleryClient = require('../gallery-client');
const { JsonStore } = require('./store');

class Gallery {
  /** @param {object} deps { app, settings, shoots, push } */
  constructor(deps) {
    this.d = deps;
    this.client = null;
    // Persisted: failed uploads must survive a restart or they're silently
    // undelivered client photos.
    this.transferStore = new JsonStore(
      path.join(deps.app.getPath('userData'), 'store', 'transfers.json'), []);
    // In-flight at crash → mark failed so Retry works after relaunch.
    this.transferStore.update((list) => {
      for (const t of list) if (t.status === 'uploading') t.status = 'failed';
    });
  }

  get transfers() { return this.transferStore.data; }

  getClient() {
    if (!this.client) this.client = new TurboIQGalleryClient();
    return this.client;
  }

  async ensureAuthed() {
    const c = this.getClient();
    if (c.isAuthenticated()) return c;
    const { galleryUsername, galleryPassword } = this.d.settings.raw;
    if (galleryUsername && galleryPassword) {
      const r = await c.login(galleryUsername, galleryPassword);
      if (r.success) return c;
    }
    return null;
  }

  settingsView() {
    const c = this.client;
    const r = this.d.settings.raw;
    return {
      isAuthenticated: !!(c && c.isAuthenticated()),
      username: c?.username ?? r.galleryUsername ?? null,
      selectedGalleryId: r.lastGalleryId,
      selectedGalleryName: r.lastGalleryName,
      autoUpload: r.galleryAutoUpload,
      uploadPortrait: r.uploadPortrait,
      uploadSquare: r.uploadSquare,
      uploadTransparent: r.uploadTransparent,
    };
  }

  kindEnabled(kind) {
    const r = this.d.settings.raw;
    if (kind === '4x5' || kind === 'print') return r.uploadPortrait;
    if (kind === 'sqr') return r.uploadSquare;
    if (kind === '4x5-tp' || kind === 'sqr-tp') return r.uploadTransparent;
    return true;
  }

  /** Upload a completed render item's outputs to the batch's shoot gallery. */
  async uploadItemOutputs(batch, item) {
    const r = this.d.settings.raw;
    if (!r.galleryAutoUpload) return;
    const shoot = this.d.shoots.getShoot(batch.shootId);
    // Deliberately NO fallback to lastGalleryId: a shoot without its own
    // gallery must never leak photos into a previous client's gallery.
    const galleryId = shoot?.galleryId;
    if (!galleryId) {
      this.d.push('processing-log', { message: `Upload skipped for ${path.basename(item.outputs?.[0]?.path ?? '')}: shoot has no linked gallery`, type: 'warning' });
      return;
    }
    const client = await this.ensureAuthed();
    if (!client) return;

    for (const out of item.outputs ?? []) {
      if (!this.kindEnabled(out.kind)) continue;
      const transfer = {
        id: crypto.randomUUID(),
        filename: path.basename(out.path),
        filePath: out.path,
        galleryId,
        pct: 0,
        status: 'uploading',
      };
      this.transferStore.update((list) => {
        list.push(transfer);
        // Cap, but never evict entries still marked failed (they're the
        // undelivered-work ledger).
        while (list.length > 300) {
          const idx = list.findIndex((t) => t.status !== 'failed');
          if (idx < 0) break;
          list.splice(idx, 1);
        }
      });
      this.emit(transfer);
      const res = await client.uploadPhotoWithProgress(galleryId, out.path, (pct) => {
        transfer.pct = pct;
        this.emit(transfer);
      });
      this.transferStore.update((list) => {
        const t = list.find((x) => x.id === transfer.id);
        if (t) { t.status = res.success ? 'done' : 'failed'; t.pct = res.success ? 100 : t.pct; }
      });
      transfer.status = res.success ? 'done' : 'failed';
      this.emit(transfer);
      this.d.push('gallery-upload-result', {
        success: res.success, filename: transfer.filename, error: res.error ?? null,
      });
    }
  }

  async retryTransfer(id) {
    const t = this.transfers.find((x) => x.id === id);
    if (!t || t.status !== 'failed') return;
    const client = await this.ensureAuthed();
    if (!client) return;
    this.transferStore.update((list) => {
      const x = list.find((y) => y.id === id);
      if (x) { x.status = 'uploading'; x.pct = 0; }
    });
    this.emit(t);
    const res = await client.uploadPhotoWithProgress(t.galleryId, t.filePath, (pct) => {
      t.pct = pct; this.emit(t);
    });
    this.transferStore.update((list) => {
      const x = list.find((y) => y.id === id);
      if (x) { x.status = res.success ? 'done' : 'failed'; x.pct = res.success ? 100 : x.pct; }
    });
    this.emit(t);
  }

  emit(t) {
    this.d.push('transfer:progress', {
      id: t.id, filename: t.filename, galleryId: t.galleryId, pct: t.pct, status: t.status,
    });
  }

  listTransfers() {
    return this.transfers.map((t) => ({
      id: t.id, filename: t.filename, galleryId: t.galleryId, pct: t.pct, status: t.status,
    }));
  }
}

module.exports = { Gallery };
