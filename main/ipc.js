// All ipcMain handlers, grouped by domain. ctx carries every service.
const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { estimate } = require('../engine/cost');

function registerIpc(ctx) {
  const { app, settings, shoots, session, checkin, engine, watcher, gallery, usage, replicate, push, updater } = ctx;

  const h = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  /* ---------- app / updates ---------- */
  h('get-app-version', () => app.getVersion());
  h('check-for-updates', () => updater.check());
  h('download-update', () => updater.download());
  h('install-update', () => updater.install());
  h('open-folder', (p) => { if (p && fs.existsSync(p)) shell.openPath(p); });

  /* ---------- settings ---------- */
  h('get-settings', () => settings.appSettings());
  h('get-ai-settings', () => settings.aiSettings());
  h('set-ai-settings', (patch = {}) => {
    const allowed = [
      'processingEnabled', 'processEveryFrame', 'holdUntilShootEnd', 'preset',
      'brightness', 'whiteBalanceStrength', 'sharpening', 'jpegQuality',
      'defaultDispatchOpts', 'workerCount', 'replicateApiKey',
    ];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    settings.patch(clean);
    return settings.aiSettings();
  });
  h('select-watch-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      settings.patch({ watchFolder: result.filePaths[0] });
      watcher.start();
    }
    return settings.appSettings();
  });
  h('select-output-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      const out = result.filePaths[0];
      const sessionsFile = path.join(out, 'headshot_sessions.csv');
      const contactsFile = path.join(out, 'contacts.csv');
      if (!fs.existsSync(sessionsFile)) {
        fs.writeFileSync(sessionsFile,
          'shoot_number,timestamp,first_name,last_name,email,mobile,company,original_file,new_file,original_path,new_path,processing_status,processed_4x5,processed_sqr,processed_4x5_tp,processed_sqr_tp,gallery_uploaded\n');
      }
      if (!fs.existsSync(contactsFile)) {
        fs.writeFileSync(contactsFile, 'shoot_number,timestamp,first_name,last_name,email,mobile,company\n');
      }
      settings.patch({ outputFolder: out, sessionsFile, contactsFile });
      shoots.importLegacyFolders();
      push('shoots:changed', {});
    }
    return settings.appSettings();
  });
  h('test-api-connection', (key) => replicate.testConnection(key));

  /* ---------- shoots ---------- */
  h('shoots:list', () => shoots.listShoots());
  h('shoots:get', (id) => {
    const shoot = shoots.getShoot(id);
    if (!shoot) return null;
    return { shoot, people: shoots.listPeople(id), batches: engine.listBatches().filter((b) => b.shootId === id) };
  });
  h('shoots:set-active', (id) => {
    settings.patch({ activeShootId: id });
    push('shoots:changed', {});
    void checkin.poll();
  });
  h('shoots:update', (id, patch) => {
    const allowed = ['name', 'client', 'date', 'location', 'status', 'defaults'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    const s = shoots.updateShoot(id, clean);
    push('shoots:changed', {});
    return s;
  });
  h('shoots:create', async (data) => {
    try {
      let server = null;
      const client = await gallery.ensureAuthed();
      if (client) {
        if (data.galleryMode === 'link' && data.galleryId) {
          server = await client.createShoot({
            name: data.name, client: data.client, shootDate: data.date,
            location: data.location, galleryId: data.galleryId,
          });
        } else {
          server = await client.createShoot({
            name: data.name, client: data.client, shootDate: data.date,
            location: data.location, galleryName: data.galleryName,
          });
        }
        if (!server.success) {
          console.error('[shoots] server provisioning failed:', server.error);
          server = null;
        }
      }
      let galleryName = null;
      if (server?.galleryId && client) {
        const list = await client.listGalleries();
        galleryName = (list.success && list.galleries.find((g) => g.id === server.galleryId)?.name) || data.galleryName || data.name;
        settings.patch({ lastGalleryId: server.galleryId, lastGalleryName: galleryName, galleryAutoUpload: data.autoUpload });
      }
      const shoot = shoots.createShoot({
        name: data.name, client: data.client, date: data.date, location: data.location,
        galleryId: server?.galleryId ?? null,
        galleryName,
        checkinSlug: server?.shoot?.checkin_slug ?? null,
        checkinUrl: server?.checkinUrl ?? null,
        galleryShareUrl: server?.galleryShareUrl ?? null,
        serverShootId: server?.shoot?.id ?? null,
      });
      settings.patch({ activeShootId: shoot.id });
      push('shoots:changed', {});
      void checkin.poll();
      return { ok: true, shoot };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---------- people / session ---------- */
  h('people:list', (shootId) => shoots.listPeople(shootId));
  h('people:create', (data) => {
    try {
      const person = shoots.createPerson(data);
      // Contacts CSV (v1 behaviour)
      const contactsFile = settings.raw.contactsFile;
      if (contactsFile && fs.existsSync(path.dirname(contactsFile))) {
        try {
          fs.appendFileSync(contactsFile,
            `"${person.shootNumber}","${new Date().toISOString()}","${person.firstName}","${person.lastName}","${person.email}","${person.mobile}","${person.company}"\n`);
        } catch { /* non-fatal */ }
      }
      push('people:changed', {});
      return { ok: true, person };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  h('session:start', (personId) => session.start(personId));
  h('session:end', () => {
    const st = session.end();
    if (settings.raw.holdUntilShootEnd) {
      // batches stay held; nothing to do — operator starts them from Processing
    }
    return st;
  });
  h('session:current', () => session.state());

  /* ---------- check-in ---------- */
  h('checkin:get-state', () => checkin.state());
  h('checkin:claim-entry', (entryId) => checkin.claim(entryId));

  /* ---------- review ---------- */
  h('review:set-approved', (personId, baseName, approved) => {
    shoots.setApproved(personId, baseName, approved);
    push('people:changed', {});
  });

  /* ---------- batches / processing ---------- */
  h('batches:estimate', (fileCount, opts) => estimate(fileCount, opts));
  h('batches:create', (data) => {
    const batch = engine.createBatch(data);
    return { ok: true, batch };
  });
  h('batches:list', () => engine.listBatches());
  h('batches:start', (id) => engine.startBatch(id));
  h('batches:start-all-held', () => engine.startAllHeld());
  h('batches:update-opts', (id, opts) => engine.updateBatchOpts(id, opts));
  h('batches:remove', (id) => engine.removeBatch(id));
  h('get-queue-status', () => engine.status());
  h('processing:pause', () => engine.pause());
  h('processing:resume', () => engine.resume());
  h('retry-failed', () => engine.retryFailed());
  h('clear-completed', () => engine.clearCompleted());

  /* ---------- gallery ---------- */
  h('get-gallery-settings', () => gallery.settingsView());
  h('gallery:set-credentials', async (username, password) => {
    const client = gallery.getClient();
    const r = await client.login(username, password);
    if (r.success) settings.patch({ galleryUsername: username, galleryPassword: password });
    return { ok: !!r.success, error: r.success ? undefined : r.message || r.error };
  });
  h('test-gallery-connection', async () => {
    const client = await gallery.ensureAuthed();
    return { ok: !!client, error: client ? undefined : 'Not authenticated' };
  });
  h('list-galleries', async () => {
    const client = await gallery.ensureAuthed();
    if (!client) return { ok: false, galleries: [] };
    const r = await client.listGalleries();
    return { ok: !!r.success, galleries: r.galleries ?? [] };
  });
  h('create-gallery', async (name, eventDate) => {
    const client = await gallery.ensureAuthed();
    if (!client) return { ok: false, error: 'Not authenticated' };
    const r = await client.createGallery(name, eventDate);
    return r.success ? { ok: true, gallery: r.gallery } : { ok: false, error: r.error };
  });
  h('gallery:select', (id, name) => {
    settings.patch({ lastGalleryId: id, lastGalleryName: name });
  });
  h('set-gallery-upload-options', (opts = {}) => {
    const map = { autoUpload: 'galleryAutoUpload', uploadPortrait: 'uploadPortrait', uploadSquare: 'uploadSquare', uploadTransparent: 'uploadTransparent' };
    const clean = {};
    for (const [k, v] of Object.entries(map)) if (opts[k] !== undefined) clean[v] = opts[k];
    settings.patch(clean);
    return gallery.settingsView();
  });
  h('gallery-logout', () => {
    gallery.getClient().logout();
    settings.patch({ galleryUsername: '', galleryPassword: '' });
  });
  h('transfers:list', () => gallery.listTransfers());
  h('transfers:retry', (id) => gallery.retryTransfer(id));

  /* ---------- delivery ---------- */
  h('delivery:list', (shootId) => shoots.listPeople(shootId));
  h('delivery:send-link', async (personId) => {
    const person = shoots.getPerson(personId);
    if (!person?.email) return { ok: false, error: 'No email for this person' };
    const shoot = shoots.getShoot(person.shootId);
    const link = shoot?.galleryShareUrl;
    if (!link) return { ok: false, error: 'Shoot has no gallery link' };
    const subject = encodeURIComponent(`Your headshots — ${shoot.name}`);
    const body = encodeURIComponent(
      `Hi ${person.firstName},\n\nYour headshots are ready:\n${link}\n\nThanks,\nTurbo 360`);
    await shell.openExternal(`mailto:${person.email}?subject=${subject}&body=${body}`);
    shoots.updatePerson(personId, (p) => { p.delivery = { status: 'link-sent', sentAt: new Date().toISOString() }; });
    push('people:changed', {});
    return { ok: true };
  });
  h('delivery:send-all', async (shootId) => {
    const people = shoots.listPeople(shootId).filter((p) => p.delivery.status === 'not-sent' && p.email);
    const shoot = shoots.getShoot(shootId);
    if (!shoot?.galleryShareUrl) return { ok: false, sent: 0 };
    // One mail draft with everyone BCC'd — a single operator action.
    const bcc = people.map((p) => p.email).join(',');
    if (!bcc) return { ok: true, sent: 0 };
    const subject = encodeURIComponent(`Your headshots — ${shoot.name}`);
    const body = encodeURIComponent(`Hi,\n\nYour headshots are ready:\n${shoot.galleryShareUrl}\n\nThanks,\nTurbo 360`);
    await shell.openExternal(`mailto:?bcc=${bcc}&subject=${subject}&body=${body}`);
    for (const p of people) {
      shoots.updatePerson(p.id, (x) => { x.delivery = { status: 'link-sent', sentAt: new Date().toISOString() }; });
    }
    push('people:changed', {});
    return { ok: true, sent: people.length };
  });

  /* ---------- usage ---------- */
  h('usage:summary', () => ({
    todayUsd: Number(usage.sum().toFixed(3)),
    shootUsd: Number(usage.sum().toFixed(3)),
  }));
}

module.exports = { registerIpc };
