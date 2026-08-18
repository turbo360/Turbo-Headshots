// Turbo IQ gallery integration: client lifecycle, auto-upload of engine
// outputs (structured kinds, not filename sniffing), transfers registry.
const path = require('path');
const crypto = require('crypto');
const TurboIQGalleryClient = require('../gallery-client');

class Gallery {
  /** @param {object} deps { settings, shoots, push } */
  constructor(deps) {
    this.d = deps;
    this.client = null;
    this.transfers = []; // { id, filename, filePath, galleryId, pct, status }
  }

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
    const galleryId = shoot?.galleryId ?? r.lastGalleryId;
    if (!galleryId) return;
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
      this.transfers.push(transfer);
      if (this.transfers.length > 200) this.transfers.splice(0, this.transfers.length - 200);
      this.emit(transfer);
      const res = await client.uploadPhotoWithProgress(galleryId, out.path, (pct) => {
        transfer.pct = pct;
        this.emit(transfer);
      });
      transfer.status = res.success ? 'done' : 'failed';
      transfer.pct = res.success ? 100 : transfer.pct;
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
    t.status = 'uploading'; t.pct = 0; this.emit(t);
    const res = await client.uploadPhotoWithProgress(t.galleryId, t.filePath, (pct) => {
      t.pct = pct; this.emit(t);
    });
    t.status = res.success ? 'done' : 'failed';
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
