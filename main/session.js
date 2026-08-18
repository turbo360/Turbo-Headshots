// Active-subject session state + frame registration (the v1 save-session logic,
// moved main-side). Persists to settings.activeSession so a crash mid-shoot
// restores the rolling subject.
const fs = require('fs');
const path = require('path');
const { RAW_EXTS } = require('./shoots');

const csvField = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

class Session {
  /**
   * @param {import('./settings').Settings} settings
   * @param {import('./shoots').ShootsStore} shoots
   * @param {(channel: string, payload: any) => void} push
   */
  constructor(settings, shoots, push) {
    this.settings = settings;
    this.shoots = shoots;
    this.push = push;
    this.personId = null;
    this.startedAt = null;
    // restore after crash/restart
    const saved = settings.raw.activeSession;
    if (saved && shoots.getPerson(saved.personId)) {
      this.personId = saved.personId;
      this.startedAt = saved.startedAt;
    }
  }

  state() {
    const person = this.personId ? this.shoots.getPerson(this.personId) : null;
    return {
      active: !!person,
      personId: person?.id ?? null,
      shootNumber: person?.shootNumber ?? null,
      personName: person ? `${person.firstName} ${person.lastName}` : null,
      startedAt: this.startedAt,
      frameCount: person?.frames.length ?? 0,
    };
  }

  start(personId) {
    const person = this.shoots.getPerson(personId);
    if (!person) throw new Error('Person not found');
    this.personId = personId;
    this.startedAt = new Date().toISOString();
    this.settings.patch({ activeSession: { personId, startedAt: this.startedAt } });
    const st = this.state();
    this.push('session:state', st);
    return st;
  }

  end() {
    this.personId = null;
    this.startedAt = null;
    this.settings.patch({ activeSession: null });
    const st = this.state();
    this.push('session:state', st);
    return st;
  }

  /**
   * A RAW arriving after its sibling JPEG already registered the frame:
   * copy it in under the frame's baseName and point the frame at it —
   * never register a second frame for the same shutter press.
   */
  attachRaw(personId, baseName, rawPath) {
    try {
      const person = this.shoots.getPerson(personId);
      if (!person) return;
      const frame = person.frames.find((f) => f.baseName === baseName);
      if (!frame) return;
      const folder = path.dirname(frame.file);
      const dest = path.join(folder, `${baseName}${path.extname(rawPath)}`);
      fs.copyFileSync(rawPath, dest);
      this.shoots.updatePerson(personId, (p) => {
        const f = p.frames.find((x) => x.baseName === baseName);
        if (f) {
          if (!f.jpegFile) f.jpegFile = f.file; // the JPEG that registered it
          f.file = dest;
        }
      });
    } catch (err) {
      console.error('[session] attachRaw failed:', err.message);
    }
  }

  /**
   * A RAW (or JPEG-only) capture landed in the watch folder while a session is
   * active: copy + rename into the person folder (v1 save-session logic),
   * append the CSV row, register the frame, notify the renderer.
   * @returns {{ person, frame } | null}
   */
  registerCapture(sourcePath) {
    if (!this.personId) return null;
    const person = this.shoots.getPerson(this.personId);
    if (!person) return null;
    const personFolder = this.shoots.personFolder(person);
    if (!personFolder) return null;

    const ext = path.extname(sourcePath);
    const isRaw = RAW_EXTS.includes(ext.toLowerCase());
    const shootNumber = person.shootNumber;
    const safeName = `${person.lastName}_${person.firstName}`.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Photo number = count of existing captures for this person + 1 (v1 counted
    // RAW files on disk; the frames record is now authoritative).
    const photoNum = String(person.frames.length + 1).padStart(2, '0');
    const baseName = `${shootNumber}_${safeName}_${photoNum}`;
    const newFilePath = path.join(personFolder, `${baseName}${ext}`);

    fs.copyFileSync(sourcePath, newFilePath);

    // Sibling camera JPEG (RAW+JPEG mode) — copied for processing + preview.
    let jpegDest = null;
    if (isRaw) {
      const dir = path.dirname(sourcePath);
      const stem = path.basename(sourcePath, ext);
      for (const v of [`${stem}.jpg`, `${stem}.JPG`, `${stem}.jpeg`, `${stem}.JPEG`]) {
        const cand = path.join(dir, v);
        if (fs.existsSync(cand)) {
          jpegDest = path.join(personFolder, `${baseName}.jpg`);
          fs.copyFileSync(cand, jpegDest);
          break;
        }
      }
    } else {
      jpegDest = newFilePath;
    }

    // CSV append (v1 17-column format preserved).
    const sessionsFile = this.settings.raw.sessionsFile;
    if (sessionsFile) {
      try {
        const csvLine = [shootNumber, new Date().toISOString(), person.firstName, person.lastName,
          person.email, person.mobile || '', person.company || '', path.basename(sourcePath),
          `${baseName}${ext}`, sourcePath, newFilePath, 'pending', '', '', '', '', '']
          .map(csvField).join(',') + '\n';
        fs.appendFileSync(sessionsFile, csvLine);
      } catch (err) {
        console.error('[session] CSV append failed:', err.message);
      }
    }

    const frame = {
      file: newFilePath,
      jpegFile: jpegDest,
      baseName,
      capturedAt: new Date().toISOString(),
      approved: false,
      quality: null,
      flags: [],
    };
    this.shoots.updatePerson(person.id, (p) => p.frames.push(frame));

    this.push('session:state', this.state());
    this.push('session:frame-added', {
      personId: person.id,
      baseName,
      previewUrl: `media://${encodeURI(jpegDest || newFilePath)}?w=1600`,
    });
    this.push('people:changed', {});
    return { person: this.shoots.getPerson(person.id), frame };
  }
}

module.exports = { Session };
