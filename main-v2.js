// Turbo Headshots v2 — main-process entry (operations cockpit).
// v1 remains available via TURBO_V1=1 (see main.js).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');

const { registerSchemes, registerMediaProtocol } = require('./main/media-protocol');
const { flushAll } = require('./main/store');
const { Settings } = require('./main/settings');
const { ShootsStore } = require('./main/shoots');
const { Session } = require('./main/session');
const { Watcher } = require('./main/watcher');
const { Checkin } = require('./main/checkin');
const { Gallery } = require('./main/gallery');
const { Deliveries } = require('./main/deliveries');
const { registerIpc } = require('./main/ipc');
const { Engine } = require('./engine/queue');
const { ReplicateClient } = require('./engine/replicateClient');
const { Usage } = require('./engine/usage');
const SidecarClient = require('./sidecar-client');

// EPIPE guard for packaged apps without a terminal (v1 behaviour)
process.stdout?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });

registerSchemes(); // must run before app ready

// Shoot-day incidents must be diagnosable after the fact: mirror engine logs
// and crashes to userData/logs/main.log (packaged apps have no visible stdout).
let logStream = null;
function fileLog(line) {
  try { logStream?.write(`${new Date().toISOString()} ${line}\n`); } catch { /* never throw from logging */ }
}
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  fileLog(`UNCAUGHT ${err.stack || err.message}`);
  flushAll();
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  fileLog(`UNHANDLED_REJECTION ${reason instanceof Error ? reason.stack : String(reason)}`);
});

let mainWindow = null;
let sidecar = null;

const push = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

function resolveSidecarPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'HeadshotSidecar');
  return path.join(app.getAppPath(), 'sidecar', '.build', 'release', 'HeadshotSidecar');
}

function getSidecar() {
  if (!sidecar) {
    sidecar = new SidecarClient(resolveSidecarPath());
    sidecar.start();
  }
  return sidecar;
}

function launchLumixTether() {
  const candidates = [
    '/Applications/LUMIX Tether.app',
    '/Applications/Panasonic/LUMIX Tether.app',
    `${process.env.HOME}/Applications/LUMIX Tether.app`,
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) exec(`open "${found}"`);
}

app.whenReady().then(() => {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logStream = fs.createWriteStream(path.join(logDir, 'main.log'), { flags: 'a' });
    fileLog(`--- boot v${app.getVersion()} ---`);
  } catch { /* logging is best-effort */ }
  if (!app.isPackaged && process.platform === 'darwin') {
    try { app.dock.setIcon(path.join(__dirname, 'build', 'icon-dev.png')); } catch { /* dev nicety only */ }
  }
  const settings = new Settings(app);
  const usage = new Usage(app);
  const shoots = new ShootsStore(app, settings);
  const replicate = new ReplicateClient(() => settings.raw.replicateApiKey);
  const gallery = new Gallery({ app, settings, shoots, push });
  const session = new Session(settings, shoots, push);
  const deliveries = new Deliveries({ settings, shoots, gallery, push });
  gallery.d.deliveries = deliveries;
  const checkin = new Checkin({ settings, shoots, gallery, push, deliveries });

  const engine = globalThis.__engine = new Engine({
    app, settings, shoots,
    client: replicate,
    sidecar: getSidecar,
    usage,
    push,
    log: (message, type = 'info') => { fileLog(`[${type}] ${message}`); push('processing-log', { message, type }); },
    onOutputs: (batch, person, item) => gallery.uploadItemOutputs(batch, item, person),
  });

  // Quality checks run one at a time in the background (unwired-in-v1 sidecar capability).
  let qualityChain = Promise.resolve();
  const qualityCheck = (jpegPath, personId, baseName) => {
    qualityChain = qualityChain.then(async () => {
      try {
        const q = await getSidecar().qualityCheck(jpegPath);
        shoots.updatePerson(personId, (p) => {
          const f = p.frames.find((x) => x.baseName === baseName);
          if (f) {
            f.quality = {
              eyesOpen: q.eyesOpen ?? true,
              blurScore: q.blurScore ?? 0,
              captureQuality: q.captureQuality ?? 0,
              recommendation: q.recommendation ?? 'use',
            };
          }
        });
        push('review:quality-updated', { personId, baseName });
        push('people:changed', {});
      } catch (err) {
        console.log('[quality] skipped:', err.message);
      }
    });
  };

  const watcher = new Watcher({
    settings,
    session,
    push,
    qualityCheck,
    onFrame: (person, frame) => {
      // processEveryFrame → immediate auto-batch with the shoot's defaults.
      if (!settings.raw.processEveryFrame) return;
      const shoot = shoots.getShoot(person.shootId);
      engine.createBatch({
        shootId: person.shootId,
        personId: person.id,
        files: [frame.baseName],
        opts: shoot?.defaults ?? settings.raw.defaultDispatchOpts,
        hold: !!settings.raw.holdUntilShootEnd,
      });
    },
  });

  registerMediaProtocol(app, () => [
    settings.raw.watchFolder,
    settings.raw.outputFolder,
    app.getPath('userData'),
  ]);

  /* ---------- updater ---------- */
  autoUpdater.autoDownload = true;
  let updateVersion = null;
  autoUpdater.on('update-available', (info) => {
    updateVersion = info.version;
    push('update-status', { status: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (p) => {
    push('update-status', { status: 'downloading', version: updateVersion, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-not-available', () => push('update-status', { status: 'current', version: app.getVersion() }));
  autoUpdater.on('update-downloaded', (info) => push('update-status', { status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => {
    fileLog(`UPDATER ${err.message}`);
    push('update-status', { status: 'error', message: err.message });
  });
  const updater = {
    check: () => { autoUpdater.checkForUpdates().catch(() => {}); },
    download: () => { autoUpdater.downloadUpdate().catch(() => {}); },
    install: () => autoUpdater.quitAndInstall(),
  };
  // Shoot-day apps stay open for hours — re-check every 30 minutes, not
  // just once at boot.
  setInterval(() => updater.check(), 30 * 60 * 1000);

  registerIpc({
    app, settings, shoots, session, checkin, engine, watcher, gallery, usage, replicate, push, updater, deliveries,
  });

  /* ---------- window ---------- */
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#EDEDF0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  mainWindow.on('focus', () => checkin.setBlurred(false));
  mainWindow.on('blur', () => checkin.setBlurred(true));

  /* ---------- boot ---------- */
  const boot = (label, fn) => { try { fn(); } catch (err) { console.error(`[boot] ${label}:`, err.message); fileLog(`BOOT ${label} failed: ${err.message}`); } };
  boot('faceRestore migration', () => {
    if (!settings.raw.shootFaceRestoreMigrated) {
      shoots.shoots.update((list) => { for (const s of list) if (s.defaults) s.defaults.faceRestore = false; });
      engine.batches.update((list) => { for (const b of list) if (b.status === 'held' && b.opts) b.opts.faceRestore = false; });
      settings.patch({ shootFaceRestoreMigrated: true });
    }
  });
  boot('reviewedFlag migration', () => {
    // One-time: people dispatched before frame.reviewed existed kept their
    // culled frames in the Review badge forever.
    if (!settings.raw.reviewedFlagMigrated) {
      const dispatched = new Set(engine.batches.data.map((b) => b.personId).filter(Boolean));
      shoots.people.update((list) => {
        for (const p of list) {
          if (dispatched.has(p.id)) for (const f of p.frames) f.reviewed = true;
        }
      });
      settings.patch({ reviewedFlagMigrated: true });
    }
  });
  boot('birefnetLocal', () => require('./engine/birefnetLocal').init(app.getPath('userData')));
  boot('importLegacyFolders', () => shoots.importLegacyFolders());
  boot('watcher', () => watcher.start());
  boot('checkin', () => checkin.start());
  boot('engine.pump', () => engine.pump()); // resume any recovered pending items
  setTimeout(() => { launchLumixTether(); }, 1000);
  setTimeout(() => { updater.check(); }, 3000);
});

app.on('window-all-closed', () => {
  if (sidecar) { sidecar.stop(); sidecar = null; }
  try { require('./engine/birefnetLocal').stop(); } catch { /* ignore */ }
  app.quit();
});

let quitConfirmed = false;
app.on('before-quit', (event) => {
  const busy = globalThis.__engine && (globalThis.__engine.running > 0 ||
    globalThis.__engine.queue.data.some((i) => i.status === 'pending'));
  if (busy && !quitConfirmed && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    const { dialog } = require('electron');
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'Renders are still running',
      detail: 'Pending renders will resume on next launch, but in-flight Replicate calls are abandoned (and still billed).',
    }).then(({ response }) => {
      if (response === 1) { quitConfirmed = true; app.quit(); }
    });
    return;
  }
  flushAll();
  if (sidecar) { sidecar.stop(); sidecar = null; }
  try { require('./engine/birefnetLocal').stop(); } catch { /* ignore */ }
});
