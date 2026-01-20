const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let watcher;
let watchFolder = '';
let outputFolder = '';
let sessionsFile = '';
let contactsFile = '';

// Generate unique shoot number in format YYYYMMDD-NNN
function generateShootNumber() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

  const counterPath = path.join(app.getPath('userData'), 'shoot_counter.json');
  let counter = { date: dateStr, count: 0 };

  // Read existing counter
  if (fs.existsSync(counterPath)) {
    try {
      counter = JSON.parse(fs.readFileSync(counterPath, 'utf-8'));
      // Reset counter if it's a new day
      if (counter.date !== dateStr) {
        counter = { date: dateStr, count: 0 };
      }
    } catch (e) {
      console.log('Error reading counter:', e);
      counter = { date: dateStr, count: 0 };
    }
  }

  // Increment counter
  counter.count++;

  // Save updated counter
  fs.writeFileSync(counterPath, JSON.stringify(counter));

  // Format: YYYYMMDD-NNN
  const shootNumber = `${dateStr}-${String(counter.count).padStart(3, '0')}`;
  return shootNumber;
}

// Try to launch LUMIX Tether on startup
function launchLumixTether() {
  const possiblePaths = [
    '/Applications/LUMIX Tether.app',
    '/Applications/Panasonic/LUMIX Tether.app',
    `${process.env.HOME}/Applications/LUMIX Tether.app`
  ];
  
  for (const appPath of possiblePaths) {
    if (fs.existsSync(appPath)) {
      exec(`open "${appPath}"`, (err) => {
        if (err) console.log('Could not launch LUMIX Tether:', err);
        else console.log('LUMIX Tether launched');
      });
      return true;
    }
  }
  console.log('LUMIX Tether not found');
  return false;
}

// Auto-updater setup
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Configure for GitHub releases (public repo)
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'turbo360',
    repo: 'Turbo-Headshots'
  });

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
    if (mainWindow) {
      mainWindow.webContents.send('update-status', { status: 'checking' });
    }
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'available',
        version: info.version,
        releaseNotes: info.releaseNotes
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
    if (mainWindow) {
      mainWindow.webContents.send('update-status', { status: 'not-available' });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'downloading',
        percent: Math.round(progress.percent)
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'downloaded',
        version: info.version
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    if (mainWindow) {
      mainWindow.webContents.send('update-status', { status: 'error', error: err.message });
    }
  });
}

// IPC handlers for updates
ipcMain.handle('check-for-updates', () => {
  autoUpdater.checkForUpdates();
});

ipcMain.handle('download-update', () => {
  autoUpdater.downloadUpdate();
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Start a new session - generate shoot number and write to contacts.csv
ipcMain.handle('start-session', async (event, data) => {
  const { firstName, lastName, email, mobile, company } = data;

  if (!outputFolder || !fs.existsSync(outputFolder)) {
    return { success: false, error: 'Output folder not set' };
  }

  try {
    const shootNumber = generateShootNumber();

    // Write to contacts.csv
    if (contactsFile) {
      const csvLine = `"${shootNumber}","${firstName}","${lastName}","${email}","${mobile || ''}","${company || ''}"\n`;
      fs.appendFileSync(contactsFile, csvLine);
    }

    return { success: true, shootNumber };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    title: 'Turbo Headshots'
  });

  mainWindow.loadFile('index.html');
  
  // Load saved settings
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      watchFolder = settings.watchFolder || '';
      outputFolder = settings.outputFolder || '';
      sessionsFile = settings.sessionsFile || '';
      contactsFile = settings.contactsFile || '';

      // Start watcher if folder exists
      if (watchFolder && fs.existsSync(watchFolder)) {
        startWatcher();
      }
    } catch (e) {
      console.log('Error loading settings:', e);
    }
  }
  
  // Try to launch LUMIX Tether
  setTimeout(() => launchLumixTether(), 1000);
}

app.whenReady().then(() => {
  setupAutoUpdater();
  createWindow();

  // Check for updates after window is ready (delay to ensure UI is loaded)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.log('Update check failed:', err.message);
    });
  }, 3000);
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Handle folder selection for watch folder (LUMIX Tether output)
ipcMain.handle('select-watch-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select LUMIX Tether Output Folder',
    message: 'Choose the folder where LUMIX Tether saves photos'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    watchFolder = result.filePaths[0];
    saveSettings();
    startWatcher();
    return watchFolder;
  }
  return null;
});

// Handle folder selection for organized output
ipcMain.handle('select-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Output Folder for Organized Headshots',
    message: 'Choose where to save organized headshot folders'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    outputFolder = result.filePaths[0];
    sessionsFile = path.join(outputFolder, 'headshot_sessions.csv');
    contactsFile = path.join(outputFolder, 'contacts.csv');

    // Create headshot_sessions.csv if it doesn't exist
    if (!fs.existsSync(sessionsFile)) {
      fs.writeFileSync(sessionsFile, 'shoot_number,timestamp,first_name,last_name,email,mobile,company,original_filename,new_filename,original_path,new_path\n');
    }

    // Create contacts.csv if it doesn't exist
    if (!fs.existsSync(contactsFile)) {
      fs.writeFileSync(contactsFile, 'shoot_number,first_name,last_name,email,mobile,company\n');
    }

    saveSettings();
    return outputFolder;
  }
  return null;
});

// Get current settings
ipcMain.handle('get-settings', () => {
  return { watchFolder, outputFolder, sessionsFile };
});

// Save a headshot session
ipcMain.handle('save-session', async (event, data) => {
  const { firstName, lastName, email, mobile, company, shootNumber, originalFile } = data;

  if (!outputFolder || !fs.existsSync(outputFolder)) {
    return { success: false, error: 'Output folder not set' };
  }

  // Create person's folder using shoot number
  const safeName = `${lastName}_${firstName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const folderName = `${shootNumber}_${safeName}`;
  const personFolder = path.join(outputFolder, folderName);
  if (!fs.existsSync(personFolder)) {
    fs.mkdirSync(personFolder, { recursive: true });
  }

  // Count existing files to generate photo number
  const existingFiles = fs.readdirSync(personFolder).filter(f => f.startsWith(shootNumber));
  const photoNum = String(existingFiles.length + 1).padStart(2, '0');

  // Generate new filename with shoot number prefix and photo counter
  const ext = path.extname(originalFile);
  const newFileName = `${shootNumber}_${safeName}_${photoNum}${ext}`;
  const newFilePath = path.join(personFolder, newFileName);

  // Copy file to new location
  try {
    fs.copyFileSync(originalFile, newFilePath);

    // Append to CSV (includes shoot_number and mobile)
    const originalFileName = path.basename(originalFile);
    const csvLine = `"${shootNumber}","${new Date().toISOString()}","${firstName}","${lastName}","${email}","${mobile || ''}","${company || ''}","${originalFileName}","${newFileName}","${originalFile}","${newFilePath}"\n`;
    fs.appendFileSync(sessionsFile, csvLine);

    return { success: true, newPath: newFilePath, personFolder };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open folder in Finder
ipcMain.handle('open-folder', (event, folderPath) => {
  shell.openPath(folderPath);
});

// Track recently processed files to prevent duplicates (by filename, not full path)
const recentlyProcessed = new Map(); // filename -> timestamp

// Start watching folder for new images
function startWatcher() {
  // Use chokidar for file watching
  const chokidar = require('chokidar');

  if (watcher) watcher.close();

  if (!watchFolder || !fs.existsSync(watchFolder)) return;

  console.log('Starting watcher on:', watchFolder);

  watcher = chokidar.watch(watchFolder, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500
    },
    depth: 0,  // Only watch root folder, not subfolders
    usePolling: false
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];

    if (imageExtensions.includes(ext)) {
      // IMPORTANT: Ignore files in subfolders (these are already-organized output files)
      const fileDir = path.dirname(filePath);
      if (fileDir !== watchFolder) {
        console.log('Skipping file in subfolder (already organized):', filePath);
        return;
      }

      const filename = path.basename(filePath);
      const now = Date.now();

      // Check if this filename was processed recently (within 30 seconds)
      const lastProcessed = recentlyProcessed.get(filename);
      if (lastProcessed && (now - lastProcessed) < 30000) {
        console.log('Skipping duplicate:', filename);
        return;
      }

      // Mark as processed with current timestamp
      recentlyProcessed.set(filename, now);

      // Clean up old entries (older than 60 seconds)
      for (const [key, time] of recentlyProcessed.entries()) {
        if (now - time > 60000) {
          recentlyProcessed.delete(key);
        }
      }

      console.log('New image detected:', filename);
      mainWindow.webContents.send('new-image', filePath);
    }
  });
  
  watcher.on('error', (error) => {
    console.log('Watcher error:', error);
  });
}

function saveSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ watchFolder, outputFolder, sessionsFile, contactsFile }));
}
