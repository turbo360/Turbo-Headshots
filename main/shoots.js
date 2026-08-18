// Shoots + people records: userData/store/{shoots,people}.json.
// Also the one-time importer that surfaces pre-v2 session folders as a shoot.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./store');

const RAW_EXTS = ['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

class ShootsStore {
  constructor(app, settings) {
    const dir = path.join(app.getPath('userData'), 'store');
    this.settings = settings;
    this.shoots = new JsonStore(path.join(dir, 'shoots.json'), []);
    this.people = new JsonStore(path.join(dir, 'people.json'), []);
    this.counterPath = path.join(app.getPath('userData'), 'shoot_counter.json');
  }

  /* ---------- shoot numbers (v1 logic, reused verbatim) ---------- */

  generateShootNumber() {
    // LOCAL date — the UTC version stamped Melbourne-morning shoots with
    // yesterday's date and reset the counter mid-morning.
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    let counter = { date: dateStr, count: 0 };
    if (fs.existsSync(this.counterPath)) {
      try {
        counter = JSON.parse(fs.readFileSync(this.counterPath, 'utf-8'));
        if (counter.date !== dateStr) counter = { date: dateStr, count: 0 };
      } catch { counter = { date: dateStr, count: 0 }; }
    }
    counter.count++;
    fs.writeFileSync(this.counterPath, JSON.stringify(counter));
    return `${dateStr}-${String(counter.count).padStart(3, '0')}`;
  }

  /* ---------- shoots ---------- */

  listShoots() { return this.shoots.data; }

  getShoot(id) { return this.shoots.data.find((s) => s.id === id) ?? null; }

  createShoot({ name, client, date, location, galleryId, galleryName, checkinSlug, checkinUrl, galleryShareUrl, serverShootId, defaults }) {
    const outputFolder = this.settings.raw.outputFolder;
    let folderPath = null;
    if (outputFolder) {
      const d = (date || localDate()).replace(/-/g, '');
      const yyyy = d.slice(0, 4);
      const mm = d.slice(4, 6);
      const safe = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Shoot';
      folderPath = path.join(outputFolder, yyyy, mm, `${d}_${safe}`);
      try { fs.mkdirSync(folderPath, { recursive: true }); } catch { folderPath = null; }
    }
    const shoot = {
      id: uid(),
      name, client: client || '', date: date || localDate(), location: location || '',
      galleryId: galleryId ?? null,
      galleryName: galleryName ?? null,
      checkinSlug: checkinSlug ?? null,
      checkinUrl: checkinUrl ?? null,
      galleryShareUrl: galleryShareUrl ?? null,
      serverShootId: serverShootId ?? null,
      status: 'live',
      folderPath,
      defaults: defaults ?? this.settings.raw.defaultDispatchOpts,
      createdAt: nowIso(),
    };
    this.shoots.update((list) => list.push(shoot));
    return shoot;
  }

  updateShoot(id, patch) {
    let out = null;
    this.shoots.update((list) => {
      const s = list.find((x) => x.id === id);
      if (s) { Object.assign(s, patch); out = s; }
    });
    return out;
  }

  /** Remove the shoot record and its people. Files on disk are never touched. */
  deleteShoot(id) {
    this.people.update((list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].shootId === id) list.splice(i, 1);
      }
    });
    this.shoots.update((list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    });
  }

  /** Remove one person record. Files on disk are never touched. */
  deletePerson(id) {
    this.people.update((list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    });
  }

  /* ---------- people ---------- */

  listPeople(shootId) {
    return this.people.data.filter((p) => p.shootId === shootId);
  }

  getPerson(id) { return this.people.data.find((p) => p.id === id) ?? null; }

  createPerson({ shootId, firstName, lastName, email, mobile, company }) {
    const shoot = this.getShoot(shootId);
    if (!shoot) throw new Error('Shoot not found');
    const shootNumber = this.generateShootNumber();
    const person = {
      id: uid(),
      shootId, shootNumber,
      firstName: firstName.trim(), lastName: lastName.trim(),
      email: (email || '').trim(), mobile: (mobile || '').trim(), company: (company || '').trim(),
      folderPath: null, // created lazily on first frame
      frames: [],
      delivery: { status: 'not-sent', sentAt: null },
      createdAt: nowIso(),
    };
    this.people.update((list) => list.push(person));
    return person;
  }

  updatePerson(id, fn) {
    let out = null;
    this.people.update((list) => {
      const p = list.find((x) => x.id === id);
      if (p) { fn(p); out = p; }
    });
    return out;
  }

  /** Folder for a person: {shootFolder|outputFolder}/{shootNumber}_{Last}_{First}/ (v1 naming). */
  personFolder(person) {
    if (person.folderPath) return person.folderPath;
    const shoot = this.getShoot(person.shootId);
    const base = shoot?.folderPath || this.settings.raw.outputFolder;
    if (!base) return null;
    const safeName = `${person.lastName}_${person.firstName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const folder = path.join(base, `${person.shootNumber}_${safeName}`);
    fs.mkdirSync(folder, { recursive: true });
    this.updatePerson(person.id, (p) => { p.folderPath = folder; });
    return folder;
  }

  setApproved(personId, baseName, approved) {
    return this.updatePerson(personId, (p) => {
      const f = p.frames.find((x) => x.baseName === baseName);
      if (f) f.approved = approved;
    });
  }

  /* ---------- one-time importer for pre-v2 session folders ---------- */

  importLegacyFolders() {
    const out = this.settings.raw.outputFolder;
    if (!out || !fs.existsSync(out) || this.shoots.data.some((s) => s.imported)) return 0;
    let entries;
    try { entries = fs.readdirSync(out); } catch { return 0; }
    // v1 folders look like YYYYMMDD-NNN_Last_First
    const legacy = entries.filter((e) => {
      if (!/^\d{8}-\d{3}_/.test(e)) return false;
      try { return fs.statSync(path.join(out, e)).isDirectory(); } catch { return false; }
    });
    if (legacy.length === 0) return 0;

    const byDate = new Map();
    for (const folder of legacy) {
      const date = folder.slice(0, 8);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(folder);
    }

    let count = 0;
    for (const [date, folders] of byDate) {
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      const shoot = {
        id: uid(),
        name: `Imported — ${iso}`,
        client: '', date: iso, location: '',
        galleryId: null, galleryName: null, checkinSlug: null, checkinUrl: null,
        galleryShareUrl: null, serverShootId: null,
        status: 'archived', folderPath: null,
        defaults: this.settings.raw.defaultDispatchOpts,
        createdAt: nowIso(), imported: true,
      };
      this.shoots.update((list) => list.push(shoot));
      for (const folder of folders) {
        const m = folder.match(/^(\d{8}-\d{3})_([^_]+)_(.+)$/);
        if (!m) continue;
        const [, shootNumber, last, first] = m;
        const abs = path.join(out, folder);
        let files = [];
        try { files = fs.readdirSync(abs); } catch { /* ignore */ }
        const raws = files.filter((f) => !f.startsWith('._') && RAW_EXTS.includes(path.extname(f).toLowerCase()));
        const person = {
          id: uid(), shootId: shoot.id, shootNumber,
          firstName: first.replace(/_/g, ' '), lastName: last,
          email: '', mobile: '', company: '',
          folderPath: abs,
          frames: raws.map((f) => {
            const base = path.basename(f, path.extname(f));
            const jpeg = files.find((j) => j.toLowerCase() === `${base.toLowerCase()}.jpg`);
            return {
              file: path.join(abs, f),
              jpegFile: jpeg ? path.join(abs, jpeg) : null,
              baseName: base,
              capturedAt: nowIso(),
              approved: false, quality: null, flags: [],
            };
          }),
          delivery: { status: 'not-sent', sentAt: null },
          createdAt: nowIso(),
        };
        this.people.update((list) => list.push(person));
        count++;
      }
    }
    return count;
  }
}

module.exports = { ShootsStore, RAW_EXTS };
