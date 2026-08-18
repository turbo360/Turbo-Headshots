// Turbo Headshots v2 — main-process entry (operations cockpit).
// v1 remains available via TURBO_V1=1 (see main.js).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');

const { registerSchemes, registerMediaProtocol } = require('./main/media-protocol');
const { Settings } = require('./main/settings');
const { ShootsStore } = require('./main/shoots');
const { Session } = require('./main/session');
const { Watcher } = require('./main/watcher');
const { Checkin } = require('./main/checkin');
const { Gallery } = require('./main/gallery');
const { registerIpc } = require('./main/ipc');
const { Engine } = require('./engine/queue');
const { ReplicateClient } = require('./engine/replicateClient');
const { Usage } = require('./engine/usage');
const SidecarClient = require('./sidecar-client');

// EPIPE guard for packaged apps without a terminal (v1 behaviour)
process.stdout?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });

registerSchemes(); // must run before app ready

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
  if (!app.isPackaged && process.platform === 'darwin') {
    try { app.dock.setIcon(path.join(__dirname, 'build', 'icon-dev.png')); } catch { /* dev nicety only */ }
  }
  const settings = new Settings(app);
  const usage = new Usage(app);
  const shoots = new ShootsStore(app, settings);
  const replicate = new ReplicateClient(() => settings.raw.replicateApiKey);
  const gallery = new Gallery({ settings, shoots, push });
  const session = new Session(settings, shoots, push);
  const checkin = new Checkin({ settings, shoots, gallery: () => gallery.client, push });

  const engine = new Engine({
    app, settings, shoots,
    client: replicate,
    sidecar: getSidecar,
    usage,
    push,
    log: (message, type = 'info') => push('processing-log', { message, type }),
    onOutputs: (batch, person, item) => gallery.uploadItemOutputs(batch, item),
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
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', (info) => push('update-status', { status: 'available', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => push('update-status', { status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => console.log('[updater]', err.message));
  const updater = {
    check: () => { autoUpdater.checkForUpdates().catch(() => {}); },
    download: () => { autoUpdater.downloadUpdate().catch(() => {}); },
    install: () => autoUpdater.quitAndInstall(),
  };

  registerIpc({
    app, settings, shoots, session, checkin, engine, watcher, gallery, usage, replicate, push, updater,
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
  shoots.importLegacyFolders();
  watcher.start();
  checkin.start();
  engine.pump(); // resume any recovered pending items
  setTimeout(() => { launchLumixTether(); }, 1000);
  setTimeout(() => { updater.check(); }, 3000);
});

app.on('window-all-closed', () => {
  if (sidecar) { sidecar.stop(); sidecar = null; }
  app.quit();
});

app.on('before-quit', () => {
  if (sidecar) { sidecar.stop(); sidecar = null; }
});
