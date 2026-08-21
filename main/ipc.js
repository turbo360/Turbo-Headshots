// All ipcMain handlers, grouped by domain. ctx carries every service.
const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { estimate } = require('../engine/cost');

function registerIpc(ctx) {
  const parentWin = () => BrowserWindow.getAllWindows()[0] ?? null;
  const confirmBox = (opts) => {
    const win = parentWin();
    return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  };
  const { app, settings, shoots, session, checkin, engine, watcher, gallery, usage, replicate, push, updater, deliveries } = ctx;

  const h = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  /* ---------- app / updates ---------- */
  h('get-app-version', () => app.getVersion());
  h('check-for-updates', () => updater.check());
  h('download-update', () => updater.download());
  h('install-update', () => updater.install());
  h('open-folder', (p) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return;
    const roots = [settings.raw.outputFolder, settings.raw.watchFolder, app.getPath('userData')]
      .filter(Boolean).map((r) => path.resolve(r));
    const resolved = path.resolve(p);
    if (roots.some((r) => resolved === r || resolved.startsWith(r + path.sep))) shell.openPath(resolved);
  });

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
  h('shoots:list', () => shoots.listShoots().map((s) => {
    const people = shoots.listPeople(s.id);
    return {
      ...s,
      peopleCount: people.length,
      frameCount: people.reduce((n, p) => n + p.frames.length, 0),
      approvedCount: people.reduce((n, p) => n + p.frames.filter((f) => f.approved).length, 0),
    };
  }));
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
  h('shoots:delete', async (id) => {
    const shoot = shoots.getShoot(id);
    if (!shoot) return { ok: false, error: 'Shoot not found' };
    const people = shoots.listPeople(id);
    const frames = people.reduce((n, p) => n + p.frames.length, 0);
    const { response } = await confirmBox({
      type: 'warning',
      buttons: ['Cancel', 'Delete shoot'],
      defaultId: 0,
      cancelId: 0,
      message: `Delete "${shoot.name}"?`,
      detail: `Removes the shoot, ${people.length} ${people.length === 1 ? 'subject' : 'subjects'} and ${frames} frame record${frames === 1 ? '' : 's'} from the app. Photos on disk and the Turbo IQ gallery are NOT touched.`,
    });
    if (response !== 1) return { ok: false, cancelled: true };

    // End the session if it belongs to this shoot.
    const st = session.state();
    if (st.active && people.some((p) => p.id === st.personId)) session.end();
    engine.purgeBatches({ shootId: id });
    // Best-effort: close the public check-in link server-side.
    if (shoot.serverShootId) {
      try {
        const client = await gallery.ensureAuthed();
        if (client) await client.updateShoot(shoot.serverShootId, { status: 'closed' });
      } catch { /* non-fatal */ }
    }
    shoots.deleteShoot(id);
    if (settings.raw.activeShootId === id) settings.patch({ activeShootId: null });
    push('shoots:changed', {});
    push('people:changed', {});
    void checkin.poll();
    return { ok: true };
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
        engineMode: data.engineMode,
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
  h('people:delete', async (personId) => {
    const person = shoots.getPerson(personId);
    if (!person) return { ok: false, error: 'Person not found' };
    const { response } = await confirmBox({
      type: 'warning',
      buttons: ['Cancel', 'Delete subject'],
      defaultId: 0,
      cancelId: 0,
      message: `Delete ${person.firstName} ${person.lastName} (${person.shootNumber})?`,
      detail: `Removes the subject and ${person.frames.length} frame record${person.frames.length === 1 ? '' : 's'} from the app. Photos on disk are NOT touched${person.iq ? ', and their Turbo IQ headshot delivery stays (manage it in the gallery\u2019s Headshots panel)' : ''}.`,
    });
    if (response !== 1) return { ok: false, cancelled: true };

    const st = session.state();
    if (st.active && st.personId === personId) session.end();
    engine.purgeBatches({ personId });
    shoots.deletePerson(personId);
    push('people:changed', {});
    return { ok: true };
  });
  h('session:start', (personId) => {
    // Re-opening a subject from a non-active shoot activates that shoot so the
    // watcher routes new captures into the right folder + numbering.
    const person = shoots.getPerson(personId);
    if (person && settings.raw.activeShootId !== person.shootId) {
      settings.patch({ activeShootId: person.shootId });
      shoots.updateShoot(person.shootId, { status: 'live' });
      push('shoots:changed', {});
      void checkin.poll();
    }
    return session.start(personId);
  });
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

    // Preferred: real per-person delivery (their own photos, their own link).
    if (deliveries && shoot?.galleryId) {
      const iq = person.iq?.deliveryId ? person.iq : await deliveries.ensureForPerson(personId);
      if (iq?.deliveryId) {
        const client = await gallery.ensureAuthed();
        if (client) {
          const list = await client.listHeadshotDeliveries(shoot.galleryId);
          const d = list.success ? list.deliveries.find((x) => x.id === iq.deliveryId) : null;
          if (d && (d.match_count ?? 0) === 0) {
            return { ok: false, error: 'No photos matched yet — wait for renders to upload' };
          }
          const r = await client.sendHeadshotDelivery(shoot.galleryId, iq.deliveryId, {
            sendEmail: true, sendSms: !!person.mobile,
          });
          if (r.success) {
            shoots.updatePerson(personId, (p) => { p.delivery = { status: 'link-sent', sentAt: new Date().toISOString() }; });
            push('people:changed', {});
            return { ok: true, personal: true };
          }
          return { ok: false, error: r.error ?? 'Send failed' };
        }
      }
    }

    // Fallback: shared-gallery mail draft.
    const link = shoot?.galleryShareUrl;
    if (!link) return { ok: false, error: 'Shoot has no gallery link' };
    const subject = encodeURIComponent(`Your headshots — ${shoot.name}`);
    const body = encodeURIComponent(
      `Hi ${person.firstName},\n\nYour headshots are ready:\n${link}\n\nThanks,\nTurbo 360`);
    await shell.openExternal(`mailto:${person.email}?subject=${subject}&body=${body}`);
    shoots.updatePerson(personId, (p) => { p.delivery = { status: 'link-sent', sentAt: new Date().toISOString() }; });
    push('people:changed', {});
    return { ok: true, personal: false };
  });
  h('delivery:send-all', async (shootId) => {
    const shoot = shoots.getShoot(shootId);
    const pending = shoots.listPeople(shootId).filter((p) => p.delivery.status === 'not-sent' && p.email);
    if (pending.length === 0) return { ok: true, sent: 0, waiting: 0 };

    // Personal deliveries when the shoot has a gallery: probe match counts in
    // ONE list call, send only people whose photos have landed.
    if (deliveries && shoot?.galleryId) {
      const client = await gallery.ensureAuthed();
      if (client) {
        for (const p of pending) {
          if (!p.iq?.deliveryId) await deliveries.ensureForPerson(p.id).catch(() => {});
        }
        const list = await client.listHeadshotDeliveries(shoot.galleryId);
        const byId = new Map((list.success ? list.deliveries : []).map((d) => [d.id, d]));
        let sent = 0; let waiting = 0;
        for (const p of shoots.listPeople(shootId).filter((x) => x.delivery.status === 'not-sent' && x.email)) {
          const d = p.iq?.deliveryId ? byId.get(p.iq.deliveryId) : null;
          if (!d || (d.match_count ?? 0) === 0) { waiting++; continue; }
          const r = await client.sendHeadshotDelivery(shoot.galleryId, d.id, {
            sendEmail: true, sendSms: !!p.mobile,
          });
          if (r.success) {
            sent++;
            shoots.updatePerson(p.id, (x) => { x.delivery = { status: 'link-sent', sentAt: new Date().toISOString() }; });
          }
        }
        push('people:changed', {});
        return { ok: true, sent, waiting };
      }
    }

    // Fallback: one shared-gallery BCC draft.
    if (!shoot?.galleryShareUrl) return { ok: false, sent: 0, waiting: 0 };
    const bcc = pending.map((p) => p.email).join(',');
    const subject = encodeURIComponent(`Your headshots — ${shoot.name}`);
    const body = encodeURIComponent(`Hi,\n\nYour headshots are ready:\n${shoot.galleryShareUrl}\n\nThanks,\nTurbo 360`);
    await shell.openExternal(`mailto:?bcc=${bcc}&subject=${subject}&body=${body}`);
    for (const p of pending) {
      shoots.updatePerson(p.id, (x) => { x.delivery = { status: 'link-sent', sentAt: new Date().toISOString() }; });
    }
    push('people:changed', {});
    return { ok: true, sent: pending.length, waiting: 0 };
  });

  /* ---------- usage ---------- */
  h('usage:summary', () => ({
    todayUsd: Number(usage.sum().toFixed(3)),
    shootUsd: Number(usage.sum().toFixed(3)),
  }));
}

module.exports = { registerIpc };
