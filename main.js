const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');
const HeadshotProcessor = require('./processor');
const ReplicateClient = require('./replicate');
const TurboIQGalleryClient = require('./gallery-client');

let mainWindow;
let watcher;
let watchFolder = '';
let outputFolder = '';
let sessionsFile = '';
let contactsFile = '';
let processor = null;

// Gallery integration
let galleryClient = null;
let selectedGalleryId = null;
let selectedGalleryName = null;

// AI Processing settings
let aiSettings = {
  replicateApiKey: '',
  processingEnabled: true,
  autoProcessOnCapture: true,
  // Output format options
  outputPortrait: true,      // 4:5 aspect ratio
  outputSquare: true,        // 1:1 aspect ratio
  // Enhancement options (off, low, medium, high)
  faceEnhancement: 'medium',
  skinSmoothing: 'off',
  // Upscaling (off, 2x, 4x)
  upscaling: 'off',
  // Background options
  backgroundRemoval: true,
  backgroundColor: ''        // Empty = transparent, or hex like '#FFFFFF'
};

// Gallery settings
let gallerySettings = {
  username: '',
  password: '',
  autoUpload: false,
  uploadPortrait: true,
  uploadSquare: true,
  uploadTransparent: true,
  lastGalleryId: null,
  lastGalleryName: null
};

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

  // Initialize the AI processor
  processor = new HeadshotProcessor(app);
  processor.onStatusUpdate = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('processing-status', status);
    }
  };
  processor.onLogMessage = (logData) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('processing-log', logData);
    }
  };

  // Hook processing completion for gallery auto-upload
  processor.onProcessingComplete = async (data) => {
    // Notify renderer of completion
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('processing-item-complete', data);
    }

    // Auto-upload to gallery if enabled
    if (selectedGalleryId && gallerySettings.autoUpload && galleryClient) {
      // Ensure we're authenticated
      if (!galleryClient.isAuthenticated() && gallerySettings.username && gallerySettings.password) {
        const loginResult = await galleryClient.login(gallerySettings.username, gallerySettings.password);
        if (!loginResult.success) {
          console.error('[Gallery] Auto-upload auth failed:', loginResult.error);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gallery-upload-result', {
              success: false,
              error: `Authentication failed: ${loginResult.error}`
            });
          }
          return;
        }
      }

      // Filter files based on upload preferences
      const filesToUpload = data.outputFiles.filter(filePath => {
        const filename = path.basename(filePath);
        const isPortrait = filename.includes('-4x5.') && !filename.includes('-TP.');
        const isSquare = filename.includes('-SQR.') && !filename.includes('-TP.');
        const isTransparent = filename.includes('-TP.');

        if (isTransparent && !gallerySettings.uploadTransparent) return false;
        if (isPortrait && !gallerySettings.uploadPortrait) return false;
        if (isSquare && !gallerySettings.uploadSquare) return false;

        return true;
      });

      // Upload each file
      for (const filePath of filesToUpload) {
        const filename = path.basename(filePath);
        console.log(`[Gallery] Auto-uploading: ${filename}`);

        try {
          const result = await galleryClient.uploadPhoto(selectedGalleryId, filePath);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gallery-upload-result', {
              filePath,
              filename,
              success: result.success,
              error: result.error
            });
          }

          if (result.success) {
            processor.log(`Uploaded to gallery: ${filename}`, 'success');
          } else {
            processor.log(`Gallery upload failed: ${filename} - ${result.error}`, 'error');
          }
        } catch (err) {
          console.error(`[Gallery] Upload error for ${filename}:`, err);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gallery-upload-result', {
              filePath,
              filename,
              success: false,
              error: err.message
            });
          }
        }
      }
    }
  };

  // Load saved settings
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      watchFolder = settings.watchFolder || '';
      outputFolder = settings.outputFolder || '';
      sessionsFile = settings.sessionsFile || '';
      contactsFile = settings.contactsFile || '';

      // Load AI settings
      aiSettings.replicateApiKey = settings.replicateApiKey || '';
      aiSettings.processingEnabled = settings.processingEnabled !== false;
      aiSettings.autoProcessOnCapture = settings.autoProcessOnCapture !== false;
      // Output format options
      aiSettings.outputPortrait = settings.outputPortrait !== false;
      aiSettings.outputSquare = settings.outputSquare !== false;
      // Scalable enhancement options
      aiSettings.faceEnhancement = settings.faceEnhancement || 'medium';
      aiSettings.skinSmoothing = settings.skinSmoothing || 'off';
      aiSettings.upscaling = settings.upscaling || 'off';
      aiSettings.backgroundRemoval = settings.backgroundRemoval !== false;
      aiSettings.backgroundColor = settings.backgroundColor || '';

      // Load gallery settings
      gallerySettings.username = settings.galleryUsername || '';
      gallerySettings.password = settings.galleryPassword || '';
      gallerySettings.autoUpload = settings.galleryAutoUpload || false;
      gallerySettings.uploadPortrait = settings.uploadPortrait !== false;
      gallerySettings.uploadSquare = settings.uploadSquare !== false;
      gallerySettings.uploadTransparent = settings.uploadTransparent !== false;
      gallerySettings.lastGalleryId = settings.lastGalleryId || null;
      gallerySettings.lastGalleryName = settings.lastGalleryName || null;

      // Restore gallery selection
      selectedGalleryId = gallerySettings.lastGalleryId;
      selectedGalleryName = gallerySettings.lastGalleryName;

      // Initialize gallery client if credentials exist
      if (gallerySettings.username && gallerySettings.password) {
        galleryClient = new TurboIQGalleryClient();
        // Don't await login here - will authenticate on first API call
      }

      // Configure processor with API key and watch folder
      if (aiSettings.replicateApiKey) {
        processor.setApiKey(aiSettings.replicateApiKey);
      }
      processor.setProcessingEnabled(aiSettings.processingEnabled);
      processor.setEnhancementOptions({
        outputPortrait: aiSettings.outputPortrait,
        outputSquare: aiSettings.outputSquare,
        faceEnhancement: aiSettings.faceEnhancement,
        skinSmoothing: aiSettings.skinSmoothing,
        upscaling: aiSettings.upscaling,
        backgroundRemoval: aiSettings.backgroundRemoval,
        backgroundColor: aiSettings.backgroundColor
      });
      if (watchFolder) {
        processor.setWatchFolder(watchFolder);
      }

      // Ensure contacts.csv exists if outputFolder is set (for upgrades from older versions)
      if (outputFolder && fs.existsSync(outputFolder)) {
        if (!contactsFile) {
          contactsFile = path.join(outputFolder, 'contacts.csv');
          saveSettings();
        }
        if (!fs.existsSync(contactsFile)) {
          fs.writeFileSync(contactsFile, 'shoot_number,first_name,last_name,email,mobile,company\n');
        }
      }

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
    // Update processor with watch folder for JPEG fallback lookup
    if (processor) {
      processor.setWatchFolder(watchFolder);
    }
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

    // Create headshot_sessions.csv if it doesn't exist (with new processing columns)
    if (!fs.existsSync(sessionsFile)) {
      fs.writeFileSync(sessionsFile, 'shoot_number,timestamp,first_name,last_name,email,mobile,company,original_filename,new_filename,original_path,new_path,processing_status,enhanced_jpeg_path,enhanced_png_path,enhanced_square_jpg_path,enhanced_square_png_path,processing_timestamp\n');
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

// AI Processing IPC Handlers

// Get AI settings
ipcMain.handle('get-ai-settings', () => {
  return {
    hasApiKey: !!aiSettings.replicateApiKey,
    processingEnabled: aiSettings.processingEnabled,
    autoProcessOnCapture: aiSettings.autoProcessOnCapture,
    outputPortrait: aiSettings.outputPortrait,
    outputSquare: aiSettings.outputSquare,
    faceEnhancement: aiSettings.faceEnhancement,
    skinSmoothing: aiSettings.skinSmoothing,
    upscaling: aiSettings.upscaling,
    backgroundRemoval: aiSettings.backgroundRemoval,
    backgroundColor: aiSettings.backgroundColor
  };
});

// Set AI settings
ipcMain.handle('set-ai-settings', async (event, settings) => {
  console.log('set-ai-settings called with:', JSON.stringify(settings));

  if (settings.replicateApiKey !== undefined) {
    aiSettings.replicateApiKey = settings.replicateApiKey;
    console.log('API key set, length:', settings.replicateApiKey.length);
    if (processor) {
      processor.setApiKey(settings.replicateApiKey);
    }
  }
  if (settings.processingEnabled !== undefined) {
    aiSettings.processingEnabled = settings.processingEnabled;
    if (processor) {
      processor.setProcessingEnabled(settings.processingEnabled);
    }
  }
  if (settings.autoProcessOnCapture !== undefined) {
    aiSettings.autoProcessOnCapture = settings.autoProcessOnCapture;
  }
  // Output format options
  if (settings.outputPortrait !== undefined) {
    aiSettings.outputPortrait = settings.outputPortrait;
  }
  if (settings.outputSquare !== undefined) {
    aiSettings.outputSquare = settings.outputSquare;
  }
  // Scalable enhancement options
  if (settings.faceEnhancement !== undefined) {
    aiSettings.faceEnhancement = settings.faceEnhancement;
  }
  if (settings.skinSmoothing !== undefined) {
    aiSettings.skinSmoothing = settings.skinSmoothing;
  }
  if (settings.upscaling !== undefined) {
    aiSettings.upscaling = settings.upscaling;
  }
  if (settings.backgroundRemoval !== undefined) {
    aiSettings.backgroundRemoval = settings.backgroundRemoval;
  }
  if (settings.backgroundColor !== undefined) {
    aiSettings.backgroundColor = settings.backgroundColor;
  }

  // Update processor with enhancement options
  if (processor) {
    processor.setEnhancementOptions({
      outputPortrait: aiSettings.outputPortrait,
      outputSquare: aiSettings.outputSquare,
      faceEnhancement: aiSettings.faceEnhancement,
      skinSmoothing: aiSettings.skinSmoothing,
      upscaling: aiSettings.upscaling,
      backgroundRemoval: aiSettings.backgroundRemoval,
      backgroundColor: aiSettings.backgroundColor
    });
  }

  saveSettings();
  console.log('Settings saved. Current aiSettings:', JSON.stringify(aiSettings));

  return { success: true };
});

// Test API connection
ipcMain.handle('test-api-connection', async (event, apiKey) => {
  const client = new ReplicateClient(apiKey || aiSettings.replicateApiKey);
  return await client.testConnection();
});

// Get processing queue status
ipcMain.handle('get-queue-status', () => {
  if (processor) {
    return processor.getStatus();
  }
  return {
    queueLength: 0,
    pending: 0,
    processing: 0,
    failed: 0,
    completed: 0,
    isProcessing: false,
    hasApiKey: false,
    processingEnabled: false
  };
});

// Retry failed items
ipcMain.handle('retry-failed', (event, itemId) => {
  if (processor) {
    if (itemId) {
      processor.retryFailed(itemId);
    } else {
      processor.retryAllFailed();
    }
  }
});

// Get failed items
ipcMain.handle('get-failed-items', () => {
  if (processor) {
    return processor.getFailedItems();
  }
  return [];
});

// Clear completed items
ipcMain.handle('clear-completed', () => {
  if (processor) {
    processor.clearCompleted();
  }
});

// Stop processing (after current item completes)
ipcMain.handle('stop-processing', () => {
  if (processor) {
    return processor.stopProcessing();
  }
  return { success: false, error: 'Processor not initialized' };
});

// Clear queue (pending items, optionally failed too)
ipcMain.handle('clear-queue', (event, clearFailed = false) => {
  if (processor) {
    return processor.clearQueue(clearFailed);
  }
  return { success: false, error: 'Processor not initialized' };
});

// ============================================
// Gallery IPC Handlers
// ============================================

// Get gallery settings
ipcMain.handle('get-gallery-settings', () => {
  return {
    isAuthenticated: galleryClient ? galleryClient.isAuthenticated() : false,
    autoUpload: gallerySettings.autoUpload,
    uploadPortrait: gallerySettings.uploadPortrait,
    uploadSquare: gallerySettings.uploadSquare,
    uploadTransparent: gallerySettings.uploadTransparent,
    selectedGalleryId: selectedGalleryId,
    selectedGalleryName: selectedGalleryName,
    hasCredentials: !!(gallerySettings.username && gallerySettings.password)
  };
});

// Set gallery credentials and test connection
ipcMain.handle('set-gallery-credentials', async (event, { username, password }) => {
  try {
    // Initialize client if needed
    if (!galleryClient) {
      galleryClient = new TurboIQGalleryClient();
    }

    // Try to login
    const result = await galleryClient.login(username, password);

    if (result.success) {
      // Save credentials
      gallerySettings.username = username;
      gallerySettings.password = password;
      saveSettings();

      return {
        success: true,
        message: 'Connected to Turbo IQ Gallery',
        user: result.user
      };
    }

    return { success: false, error: result.error };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Test gallery connection
ipcMain.handle('test-gallery-connection', async () => {
  if (!galleryClient) {
    return { success: false, error: 'Not configured' };
  }

  // If not authenticated but we have credentials, try to login
  if (!galleryClient.isAuthenticated() && gallerySettings.username && gallerySettings.password) {
    const loginResult = await galleryClient.login(gallerySettings.username, gallerySettings.password);
    if (!loginResult.success) {
      return { success: false, error: loginResult.error };
    }
  }

  return await galleryClient.testConnection();
});

// List galleries
ipcMain.handle('list-galleries', async (event, page = 1) => {
  if (!galleryClient) {
    return { success: false, error: 'Not configured', galleries: [] };
  }

  // Ensure we're authenticated
  if (!galleryClient.isAuthenticated() && gallerySettings.username && gallerySettings.password) {
    const loginResult = await galleryClient.login(gallerySettings.username, gallerySettings.password);
    if (!loginResult.success) {
      return { success: false, error: loginResult.error, galleries: [] };
    }
  }

  return await galleryClient.listGalleries(page);
});

// Create a new gallery
ipcMain.handle('create-gallery', async (event, { name, eventDate }) => {
  if (!galleryClient) {
    return { success: false, error: 'Not configured' };
  }

  // Ensure we're authenticated
  if (!galleryClient.isAuthenticated() && gallerySettings.username && gallerySettings.password) {
    const loginResult = await galleryClient.login(gallerySettings.username, gallerySettings.password);
    if (!loginResult.success) {
      return { success: false, error: loginResult.error };
    }
  }

  return await galleryClient.createGallery(name, eventDate);
});

// Set selected gallery for auto-upload
ipcMain.handle('set-selected-gallery', (event, { galleryId, galleryName }) => {
  selectedGalleryId = galleryId;
  selectedGalleryName = galleryName;
  gallerySettings.lastGalleryId = galleryId;
  gallerySettings.lastGalleryName = galleryName;
  saveSettings();

  return {
    success: true,
    galleryId: selectedGalleryId,
    galleryName: selectedGalleryName
  };
});

// Clear gallery selection
ipcMain.handle('clear-gallery-selection', () => {
  selectedGalleryId = null;
  selectedGalleryName = null;
  return { success: true };
});

// Set gallery upload options
ipcMain.handle('set-gallery-upload-options', (event, options) => {
  if (options.autoUpload !== undefined) {
    gallerySettings.autoUpload = options.autoUpload;
  }
  if (options.uploadPortrait !== undefined) {
    gallerySettings.uploadPortrait = options.uploadPortrait;
  }
  if (options.uploadSquare !== undefined) {
    gallerySettings.uploadSquare = options.uploadSquare;
  }
  if (options.uploadTransparent !== undefined) {
    gallerySettings.uploadTransparent = options.uploadTransparent;
  }
  saveSettings();

  return { success: true };
});

// Upload a single photo to gallery
ipcMain.handle('upload-to-gallery', async (event, { galleryId, filePath }) => {
  if (!galleryClient) {
    return { success: false, error: 'Gallery not configured' };
  }

  if (!galleryClient.isAuthenticated() && gallerySettings.username && gallerySettings.password) {
    const loginResult = await galleryClient.login(gallerySettings.username, gallerySettings.password);
    if (!loginResult.success) {
      return { success: false, error: loginResult.error };
    }
  }

  return await galleryClient.uploadPhoto(galleryId, filePath);
});

// Logout from gallery
ipcMain.handle('gallery-logout', () => {
  if (galleryClient) {
    galleryClient.logout();
  }
  gallerySettings.username = '';
  gallerySettings.password = '';
  selectedGalleryId = null;
  selectedGalleryName = null;
  saveSettings();

  return { success: true };
});

// Get list of existing session folders for reprocessing
ipcMain.handle('get-session-folders', () => {
  if (!outputFolder || !fs.existsSync(outputFolder)) {
    return [];
  }

  const folders = fs.readdirSync(outputFolder, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => {
      const folderPath = path.join(outputFolder, dirent.name);
      const files = fs.readdirSync(folderPath);

      // Count RAW and processed files
      const rawExtensions = ['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];
      const rawFiles = files.filter(f => rawExtensions.includes(path.extname(f).toLowerCase()));
      const processedJpgs = files.filter(f => f.endsWith('.jpg') && !f.includes('_temp') && !f.includes('_corrected'));
      const processedPngs = files.filter(f => f.endsWith('.png'));

      // Parse folder name for shoot number and name
      const match = dirent.name.match(/^(\d{8}-\d{3})_(.+)$/);

      return {
        name: dirent.name,
        path: folderPath,
        shootNumber: match ? match[1] : dirent.name,
        personName: match ? match[2].replace(/_/g, ' ') : dirent.name,
        rawCount: rawFiles.length,
        processedCount: processedJpgs.length,
        hasTransparent: processedPngs.length > 0,
        needsProcessing: rawFiles.length > 0 && processedJpgs.length < rawFiles.length
      };
    })
    .filter(f => f.rawCount > 0) // Only show folders with photos
    .sort((a, b) => b.shootNumber.localeCompare(a.shootNumber)); // Newest first

  return folders;
});

// Reprocess an existing session folder
ipcMain.handle('reprocess-folder', async (event, folderPath) => {
  if (!processor) {
    return { success: false, error: 'Processor not initialized' };
  }

  if (!fs.existsSync(folderPath)) {
    return { success: false, error: 'Folder not found' };
  }

  const folderName = path.basename(folderPath);
  const match = folderName.match(/^(\d{8}-\d{3})_(.+)$/);
  const shootNumber = match ? match[1] : folderName;

  // Find all RAW/JPEG files that haven't been processed yet
  const files = fs.readdirSync(folderPath);
  const rawExtensions = ['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];
  const jpegExtensions = ['.jpg', '.jpeg'];

  // Get RAW files
  const rawFiles = files.filter(f => rawExtensions.includes(path.extname(f).toLowerCase()));

  let queuedCount = 0;

  for (const rawFile of rawFiles) {
    const baseName = path.basename(rawFile, path.extname(rawFile));
    const sourcePath = path.join(folderPath, rawFile);

    // Check if already processed (has corresponding .jpg that's not the source)
    const hasProcessedJpg = files.some(f =>
      f === `${baseName}.jpg` && !jpegExtensions.includes(path.extname(rawFile).toLowerCase())
    );

    // Skip if already has processed outputs
    if (hasProcessedJpg && files.includes(`${baseName}.png`)) {
      continue;
    }

    // Add to processing queue
    processor.addToQueue({
      sourcePath: sourcePath,
      outputFolder: folderPath,
      shootNumber: shootNumber,
      baseName: baseName
    });
    queuedCount++;
  }

  return {
    success: true,
    queued: queuedCount,
    message: queuedCount > 0 ? `Added ${queuedCount} photo(s) to processing queue` : 'All photos already processed'
  };
});

// Reprocess all session folders
ipcMain.handle('reprocess-all-folders', async () => {
  if (!processor) {
    return { success: false, error: 'Processor not initialized' };
  }

  if (!outputFolder || !fs.existsSync(outputFolder)) {
    return { success: false, error: 'Output folder not set' };
  }

  const rawExtensions = ['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];
  const jpegExtensions = ['.jpg', '.jpeg'];

  let totalQueued = 0;
  let foldersProcessed = 0;

  // Get all session folders
  const folders = fs.readdirSync(outputFolder, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => {
      const folderPath = path.join(outputFolder, dirent.name);
      const match = dirent.name.match(/^(\d{8}-\d{3})_(.+)$/);
      return {
        path: folderPath,
        name: dirent.name,
        shootNumber: match ? match[1] : dirent.name
      };
    });

  for (const folder of folders) {
    const files = fs.readdirSync(folder.path);
    const rawFiles = files.filter(f => rawExtensions.includes(path.extname(f).toLowerCase()));

    if (rawFiles.length === 0) continue;

    let folderQueued = 0;

    for (const rawFile of rawFiles) {
      const baseName = path.basename(rawFile, path.extname(rawFile));
      const sourcePath = path.join(folder.path, rawFile);

      // Check if already processed (has corresponding enhanced files)
      const hasProcessedJpg = files.some(f =>
        f === `${baseName}.jpg` && !jpegExtensions.includes(path.extname(rawFile).toLowerCase())
      );

      // Skip if already has processed outputs
      if (hasProcessedJpg && files.includes(`${baseName}.png`)) {
        continue;
      }

      // Add to processing queue
      processor.addToQueue({
        sourcePath: sourcePath,
        outputFolder: folder.path,
        shootNumber: folder.shootNumber,
        baseName: baseName
      });
      folderQueued++;
      totalQueued++;
    }

    if (folderQueued > 0) {
      foldersProcessed++;
    }
  }

  return {
    success: true,
    totalQueued,
    foldersProcessed,
    message: totalQueued > 0 ? `Added ${totalQueued} photo(s) from ${foldersProcessed} folder(s) to queue` : 'All photos already processed'
  };
});

// Select and reprocess a folder via dialog
ipcMain.handle('select-folder-to-reprocess', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: outputFolder,
    title: 'Select Session Folder to Reprocess',
    message: 'Choose a headshot session folder to add to processing queue'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
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

  // Count existing files to generate photo number (only count RAW files to avoid double-counting)
  const rawExtensions = ['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];
  const existingFiles = fs.readdirSync(personFolder).filter(f => {
    const fileExt = path.extname(f).toLowerCase();
    return f.startsWith(shootNumber) && rawExtensions.includes(fileExt);
  });
  const photoNum = String(existingFiles.length + 1).padStart(2, '0');

  // Generate new filename with shoot number prefix and photo counter
  const ext = path.extname(originalFile);
  const baseName = `${shootNumber}_${safeName}_${photoNum}`;
  const newFileName = `${baseName}${ext}`;
  const newFilePath = path.join(personFolder, newFileName);

  // Copy file to new location
  try {
    fs.copyFileSync(originalFile, newFilePath);

    // If this is a RAW file, also copy the corresponding JPEG if it exists (needed for AI processing)
    const rawExtensionsLower = ['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'];
    if (rawExtensionsLower.includes(ext.toLowerCase())) {
      // Look for JPEG with same name in source folder
      const originalDir = path.dirname(originalFile);
      const originalBaseName = path.basename(originalFile, ext);

      // Try different JPEG naming conventions
      const jpegVariants = [
        path.join(originalDir, `${originalBaseName}.jpg`),
        path.join(originalDir, `${originalBaseName}.JPG`),
        path.join(originalDir, `${originalBaseName}.jpeg`),
        path.join(originalDir, `${originalBaseName}.JPEG`)
      ];

      for (const jpegSource of jpegVariants) {
        if (fs.existsSync(jpegSource)) {
          const jpegDest = path.join(personFolder, `${baseName}.jpg`);
          fs.copyFileSync(jpegSource, jpegDest);
          console.log('Copied JPEG for AI processing:', jpegDest);
          break;
        }
      }
    }

    // Append to CSV (includes shoot_number, mobile, and processing status)
    const originalFileName = path.basename(originalFile);
    const csvLine = `"${shootNumber}","${new Date().toISOString()}","${firstName}","${lastName}","${email}","${mobile || ''}","${company || ''}","${originalFileName}","${newFileName}","${originalFile}","${newFilePath}","pending","","","","",""\n`;
    fs.appendFileSync(sessionsFile, csvLine);

    // Add to AI processing queue if enabled
    if (aiSettings.autoProcessOnCapture && processor) {
      processor.addToQueue({
        sourcePath: newFilePath,
        outputFolder: personFolder,
        shootNumber: shootNumber,
        baseName: baseName
      });
    }

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
  const settingsData = {
    watchFolder,
    outputFolder,
    sessionsFile,
    contactsFile,
    replicateApiKey: aiSettings.replicateApiKey,
    processingEnabled: aiSettings.processingEnabled,
    autoProcessOnCapture: aiSettings.autoProcessOnCapture,
    outputPortrait: aiSettings.outputPortrait,
    outputSquare: aiSettings.outputSquare,
    faceEnhancement: aiSettings.faceEnhancement,
    skinSmoothing: aiSettings.skinSmoothing,
    upscaling: aiSettings.upscaling,
    backgroundRemoval: aiSettings.backgroundRemoval,
    backgroundColor: aiSettings.backgroundColor,
    // Gallery settings
    galleryUsername: gallerySettings.username,
    galleryPassword: gallerySettings.password,
    galleryAutoUpload: gallerySettings.autoUpload,
    uploadPortrait: gallerySettings.uploadPortrait,
    uploadSquare: gallerySettings.uploadSquare,
    uploadTransparent: gallerySettings.uploadTransparent,
    lastGalleryId: gallerySettings.lastGalleryId,
    lastGalleryName: gallerySettings.lastGalleryName
  };
  console.log('Saving settings to:', settingsPath);
  console.log('API key length being saved:', aiSettings.replicateApiKey?.length || 0);
  fs.writeFileSync(settingsPath, JSON.stringify(settingsData));
  console.log('Settings saved successfully');
}
