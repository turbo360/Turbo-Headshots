/**
 * Background Processing Queue for AI-powered headshot enhancement
 * Handles queuing, processing, and status tracking for headshot images
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
let smartcrop = null;
try { smartcrop = require('smartcrop-sharp'); } catch { /* removed in v2; sidecar is primary */ }
const ReplicateClient = require('./replicate');
const SidecarClient = require('./sidecar-client');

// Handle EPIPE errors when console output stream is closed (packaged app without terminal)
process.stdout?.on?.('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});
process.stderr?.on?.('error', (err) => {
  if (err.code === 'EPIPE') return;
  throw err;
});

// Headshot cropping constants
const HEADSHOT_ASPECT_RATIO = 4 / 5;  // Standard headshot ratio (4:5)
const SQUARE_ASPECT_RATIO = 1;         // 1:1 for square output
const FACE_POSITION_FROM_TOP = 0.33;   // Face should be ~33% from top
const MIN_HEAD_ROOM = 0.08;            // Minimum 8% space above head
const SHOULDER_ROOM = 0.25;            // Include ~25% below face for shoulders

class HeadshotProcessor {
  constructor(app) {
    this.app = app;
    this.queue = [];
    this.processing = false;
    this.currentItem = null;
    this.apiKey = null;
    this.processingEnabled = true;
    this.maxRetries = 3;
    this.onStatusUpdate = null; // Callback for UI updates
    this.onLogMessage = null;   // Callback for log messages to UI
    this.onProcessingComplete = null; // Callback when item finishes processing
    this.watchFolder = null; // Set by main.js for JPEG fallback lookup
    this.queueFilePath = path.join(app.getPath('userData'), 'processing_queue.json');
    this.stopRequested = false; // Flag to stop processing after current item

    // Enhancement options with scalable intensity controls
    this.enhancementOptions = {
      outputPortrait: true,
      outputSquare: true,
      faceEnhancement: 'medium',    // off, low, medium, high (local: brightness/saturation/skin softening + sharpen)
      skinSmoothing: 'off',         // off, low, medium, high (local blur+blend)
      shineRemoval: 'off',          // off, low, medium, high - reduces oily skin shine
      eyeEnhancement: 'medium',     // off, low, medium, high (region-targeted sharpen + brightness on eye landmarks)
      upscaling: 'off',             // off, 2x, 4x (Replicate; off by default — source 24MP is enough)
      backgroundRemoval: true,
      backgroundColor: '',          // Empty = transparent, or hex like '#FFFFFF'
      transparentPortrait: false,   // generate 4:5 transparent PNG (off by default — most use cases don't need it)
      transparentSquare: true,      // generate 1:1 transparent PNG (default on for compositing)
      useBackgroundImage: false,    // composite -SQR-TP onto a chosen background image -> -SQR-BG.jpg
      backgroundImagePath: '',      // absolute path to user-selected background image
      brightness: 1.12,             // 0.90 - 1.30
      whiteBalanceStrength: 1.0,    // 0.0 (no correction) - 1.0 (full correction)
      sharpening: 0.8,              // 0.0 - 2.0 sigma
      jpegQuality: 92               // 70 - 100
    };

    // Sidecar (Apple Vision face detection + foreground mask + quality checks).
    // Lazy-initialized on first use so we don't pay startup cost when not needed.
    this.sidecar = null;

    // Load persisted queue on startup
    this.loadQueue();
  }

  /**
   * Resolve the path to the rembg binary if installed via pipx/pip.
   * Returns null if not found — caller falls back to Apple Vision matting.
   */
  resolveRembgPath() {
    const candidates = [
      `${process.env.HOME}/.local/bin/rembg`,
      '/opt/homebrew/bin/rembg',
      '/usr/local/bin/rembg'
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }

  /**
   * Run a high-quality background removal using rembg + BiRefNet portrait model.
   * Designed for fine hair detail; ~13s per 2095px square. Falls back to the
   * Swift sidecar's Apple Vision foreground mask if rembg isn't installed.
   */
  async removeBackgroundLocal(inputPath, outputPath) {
    const rembg = this.resolveRembgPath();
    if (rembg) {
      const { spawn } = require('child_process');
      return new Promise((resolve, reject) => {
        const proc = spawn(rembg, [
          'i',
          '-m', 'birefnet-portrait',
          inputPath,
          outputPath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error('rembg timed out (60s)'));
        }, 60000);

        proc.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(outputPath)) {
            resolve();
          } else {
            reject(new Error(`rembg exited with code ${code}: ${stderr.slice(0, 200)}`));
          }
        });
      });
    }

    // Fallback: Apple Vision foreground mask (binary-ish edges, no fine hair detail)
    console.log('rembg not installed; falling back to Apple Vision foreground mask');
    return this.getSidecar().foregroundMask(inputPath, outputPath);
  }

  /**
   * Resolve the path to the bundled Swift sidecar binary.
   * Dev: <repo>/sidecar/.build/release/HeadshotSidecar
   * Packaged: <Resources>/HeadshotSidecar
   */
  resolveSidecarPath() {
    if (this.app.isPackaged) {
      return path.join(process.resourcesPath, 'HeadshotSidecar');
    }
    return path.join(this.app.getAppPath(), 'sidecar', '.build', 'release', 'HeadshotSidecar');
  }

  /**
   * Get the (lazily-started) sidecar client.
   */
  getSidecar() {
    if (!this.sidecar) {
      this.sidecar = new SidecarClient(this.resolveSidecarPath());
      this.sidecar.start();
    }
    return this.sidecar;
  }

  /**
   * Stop the sidecar (e.g. on app quit).
   */
  stopSidecar() {
    if (this.sidecar) {
      this.sidecar.stop();
      this.sidecar = null;
    }
  }

  /**
   * Set the watch folder path for JPEG fallback lookup
   */
  setWatchFolder(folder) {
    this.watchFolder = folder;
  }

  /**
   * Set the API key and optionally start processing
   */
  setApiKey(apiKey) {
    this.apiKey = apiKey;
    // Pipeline is now local-first — start processing as long as we have a queue,
    // regardless of whether a Replicate key is set.
    if (this.queue.length > 0 && !this.processing && this.processingEnabled) {
      this.processNext();
    }
  }

  /**
   * Enable or disable processing
   */
  setProcessingEnabled(enabled) {
    this.processingEnabled = enabled;
    if (enabled && this.queue.length > 0 && !this.processing) {
      this.processNext();
    }
  }

  /**
   * Set enhancement options
   */
  setEnhancementOptions(options) {
    this.enhancementOptions = { ...this.enhancementOptions, ...options };
    console.log('Enhancement options updated:', this.enhancementOptions);
  }

  /**
   * Load queue from disk (for persistence across restarts)
   */
  loadQueue() {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.queueFilePath, 'utf-8'));
        this.queue = data.filter(item => {
          // Only restore items that haven't been processed and source file still exists
          return item.status !== 'completed' && fs.existsSync(item.sourcePath);
        });
        // Reset any 'processing' items back to 'pending'
        this.queue.forEach(item => {
          if (item.status === 'processing') {
            item.status = 'pending';
            item.retries = (item.retries || 0);
          }
        });
        this.saveQueue();
      }
    } catch (error) {
      console.error('Error loading processing queue:', error);
      this.queue = [];
    }
  }

  /**
   * Save queue to disk
   */
  saveQueue() {
    try {
      fs.writeFileSync(this.queueFilePath, JSON.stringify(this.queue, null, 2));
    } catch (error) {
      console.error('Error saving processing queue:', error);
    }
  }

  /**
   * Add an image to the processing queue
   */
  addToQueue(item) {
    const queueItem = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sourcePath: item.sourcePath,
      outputFolder: item.outputFolder,
      shootNumber: item.shootNumber,
      baseName: item.baseName,
      status: 'pending',
      retries: 0,
      addedAt: new Date().toISOString(),
      error: null
    };

    this.queue.push(queueItem);
    this.saveQueue();
    this.notifyStatusUpdate();

    // Start processing if not already running
    if (this.processingEnabled && !this.processing) {
      this.processNext();
    }

    return queueItem.id;
  }

  /**
   * Get current queue status
   */
  getStatus() {
    const pending = this.queue.filter(i => i.status === 'pending').length;
    const failed = this.queue.filter(i => i.status === 'failed').length;
    const completed = this.queue.filter(i => i.status === 'completed').length;

    return {
      queueLength: this.queue.length,
      pending,
      processing: this.processing ? 1 : 0,
      failed,
      completed,
      currentItem: this.currentItem ? {
        shootNumber: this.currentItem.shootNumber,
        baseName: this.currentItem.baseName
      } : null,
      isProcessing: this.processing,
      hasApiKey: !!this.apiKey,
      processingEnabled: this.processingEnabled
    };
  }

  /**
   * Notify UI of status changes
   */
  notifyStatusUpdate() {
    if (this.onStatusUpdate) {
      this.onStatusUpdate(this.getStatus());
    }
  }

  /**
   * Send log message to UI
   * @param {string} message - Log message
   * @param {string} type - 'info', 'success', 'warning', 'error', 'step'
   */
  log(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    if (this.onLogMessage) {
      this.onLogMessage({ message, type });
    }
  }

  /**
   * Process the next item in the queue
   */
  async processNext() {
    if (this.processing || !this.processingEnabled) {
      return;
    }

    // Find next pending item
    const nextItem = this.queue.find(i => i.status === 'pending');
    if (!nextItem) {
      return;
    }

    // Clear any previous stop request when starting fresh processing
    this.stopRequested = false;

    this.processing = true;
    this.currentItem = nextItem;
    nextItem.status = 'processing';
    this.saveQueue();
    this.notifyStatusUpdate();

    const pendingCount = this.queue.filter(i => i.status === 'pending').length;
    this.log(`Starting: ${nextItem.baseName} (${pendingCount} remaining in queue)`, 'info');

    try {
      await this.processHeadshot(nextItem);
      nextItem.status = 'completed';
      nextItem.completedAt = new Date().toISOString();
      this.log(`Completed: ${nextItem.baseName}`, 'success');

      // Trigger completion callback with output files for gallery upload
      if (this.onProcessingComplete) {
        const outputFiles = [
          nextItem.enhancedJpegPath,             // -4x5.jpg
          nextItem.transparentPngPath,            // -4x5-TP.png
          nextItem.enhancedSquarePath,            // -SQR.jpg
          nextItem.transparentSquarePngPath,      // -SQR-TP.png
          nextItem.backgroundCompositeSquarePath  // -SQR-BG.jpg
        ].filter(f => f && fs.existsSync(f));

        this.onProcessingComplete({
          item: nextItem,
          outputFiles
        });
      }
    } catch (error) {
      console.error('Processing error:', error);
      nextItem.error = error.message;
      nextItem.retries++;

      if (nextItem.retries >= this.maxRetries) {
        nextItem.status = 'failed';
        this.log(`Failed: ${nextItem.baseName} - ${error.message}`, 'error');
      } else {
        nextItem.status = 'pending';
        this.log(`Retry ${nextItem.retries}/${this.maxRetries}: ${nextItem.baseName} - ${error.message}`, 'warning');
        // Exponential backoff
        await new Promise(resolve =>
          setTimeout(resolve, Math.pow(2, nextItem.retries) * 1000)
        );
      }
    }

    this.processing = false;
    this.currentItem = null;
    this.saveQueue();
    this.notifyStatusUpdate();

    // Check if stop was requested
    if (this.stopRequested) {
      this.stopRequested = false;
      this.log('Processing stopped by user', 'warning');
      return;
    }

    // Process next item
    setImmediate(() => this.processNext());
  }

  /**
   * Main processing pipeline for a headshot
   */
  async processHeadshot(item) {
    const { sourcePath, outputFolder, baseName } = item;

    // Verify source file exists
    if (!fs.existsSync(sourcePath)) {
      throw new Error('Source file not found');
    }

    // Step 1: Find or create working image (JPEG/TIFF for RAW files)
    const ext = path.extname(sourcePath).toLowerCase();
    let workingImagePath;
    let tempFileCreated = false;

    if (['.rw2', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.dng'].includes(ext)) {
      // Try to find existing JPEG in output folder
      const jpegInOutput = sourcePath.replace(new RegExp(ext + '$', 'i'), '.jpg');
      const jpegInOutputAlt = sourcePath.replace(new RegExp(ext + '$', 'i'), '.JPG');

      if (fs.existsSync(jpegInOutput)) {
        workingImagePath = jpegInOutput;
        console.log('Found JPEG in output folder:', workingImagePath);
      } else if (fs.existsSync(jpegInOutputAlt)) {
        workingImagePath = jpegInOutputAlt;
        console.log('Found JPEG in output folder:', workingImagePath);
      } else if (this.watchFolder) {
        // Try to find JPEG in watch folder - but ONLY if the filename matches
        // This is a fallback for initial processing when JPEG wasn't copied to output folder
        const originalBaseName = path.basename(sourcePath, ext);

        // For reprocessing, the file might be named like "20260120-001_Smith_John_01"
        // We should NOT grab random JPEGs from the watch folder
        // Only look for exact filename match (without extension)
        const watchFiles = fs.existsSync(this.watchFolder) ? fs.readdirSync(this.watchFolder) : [];
        const jpegFile = watchFiles.find(f => {
          const watchBaseName = path.basename(f, path.extname(f));
          // Only match if the base names are exactly equal (case-insensitive)
          return f.toLowerCase().endsWith('.jpg') &&
                 watchBaseName.toLowerCase() === originalBaseName.toLowerCase();
        });
        if (jpegFile) {
          workingImagePath = path.join(this.watchFolder, jpegFile);
          console.log('Found matching JPEG in watch folder:', workingImagePath);
        }
      }

      // If still no JPEG, try to convert RAW using sips (macOS) or dcraw
      if (!workingImagePath) {
        console.log('No JPEG found, attempting RAW conversion...');
        const convertedPath = await this.convertRawToJpeg(sourcePath, outputFolder, baseName);
        if (convertedPath) {
          workingImagePath = convertedPath;
          tempFileCreated = true;
          console.log('Converted RAW to JPEG:', workingImagePath);
        } else {
          throw new Error('No JPEG available and RAW conversion failed. Please enable JPEG+RAW mode on camera, or install exiftool (recommended) / dcraw: brew install exiftool dcraw');
        }
      }
    } else {
      workingImagePath = sourcePath;
    }

    // Store temp file flag for cleanup
    item.tempFileCreated = tempFileCreated;
    item.workingImagePath = workingImagePath;

    // Get enhancement options
    const opts = this.enhancementOptions;
    console.log('Processing with options:', JSON.stringify(opts));

    // Check that at least one output is enabled
    if (!opts.outputPortrait && !opts.outputSquare) {
      throw new Error('No output formats enabled. Enable at least Portrait or Square in settings.');
    }

    // All AI-processed files go into a "Processed" subfolder
    // Files are distinguished by suffix: -4x5, -4x5-TP, -SQR, -SQR-TP
    const processedFolder = path.join(outputFolder, 'Processed');
    if (!fs.existsSync(processedFolder)) {
      fs.mkdirSync(processedFolder, { recursive: true });
    }

    // Step 2: Detect face and calculate smart crop region
    this.log('Detecting face position...', 'step');
    const faceData = await this.detectFaceAndCrop(workingImagePath);

    const client = new ReplicateClient(this.apiKey);
    const tempFiles = [];
    const results = {};

    // Process Portrait (4:5) version if enabled
    if (opts.outputPortrait) {
      this.log('Creating 4:5 portrait crop...', 'step');
      const croppedPath = path.join(outputFolder, `${baseName}_temp_cropped.jpg`);
      tempFiles.push(croppedPath);

      await this.applySmartCropAndCorrection(workingImagePath, croppedPath, faceData, HEADSHOT_ASPECT_RATIO);

      let portraitImagePath = croppedPath;

      // Local face enhancement (subtle skin softening + brightness/saturation lift + detail sharpen).
      // Replaces the Replicate CodeFormer/GFPGAN call. All in Sharp, ~1s per photo, no network.
      if (opts.faceEnhancement && opts.faceEnhancement !== 'off') {
        this.log(`Face enhancement (4:5) - ${opts.faceEnhancement}...`, 'step');
        const tempEnhancedPath = path.join(outputFolder, `${baseName}_temp_enhanced.jpg`);
        tempFiles.push(tempEnhancedPath);
        await this.applyLocalFaceEnhancement(portraitImagePath, tempEnhancedPath, opts.faceEnhancement);
        portraitImagePath = tempEnhancedPath;
      }

      // Skin smoothing if enabled (additional pass on top of face enhancement)
      if (opts.skinSmoothing && opts.skinSmoothing !== 'off') {
        this.log(`Skin smoothing (4:5) - ${opts.skinSmoothing}...`, 'step');
        const tempSkinPath = path.join(outputFolder, `${baseName}_temp_skin.jpg`);
        tempFiles.push(tempSkinPath);
        await this.applySkinSmoothing(portraitImagePath, tempSkinPath, opts.skinSmoothing);
        portraitImagePath = tempSkinPath;
      }

      // Shine removal if enabled (local)
      if (opts.shineRemoval && opts.shineRemoval !== 'off') {
        this.log(`Shine removal (4:5) - ${opts.shineRemoval}...`, 'step');
        const tempShinePath = path.join(outputFolder, `${baseName}_temp_shine.jpg`);
        tempFiles.push(tempShinePath);
        await this.removeShine(portraitImagePath, tempShinePath, opts.shineRemoval);
        portraitImagePath = tempShinePath;
      }

      // Eye enhancement (region-targeted sharpen + brightness using landmarks)
      if (opts.eyeEnhancement && opts.eyeEnhancement !== 'off') {
        this.log(`Eye enhancement (4:5) - ${opts.eyeEnhancement}...`, 'step');
        const tempEyePath = path.join(outputFolder, `${baseName}_temp_eyes.jpg`);
        tempFiles.push(tempEyePath);
        try {
          const cropFaceData = await this.getSidecar().detectFace(portraitImagePath);
          await this.applyEyeEnhancement(portraitImagePath, tempEyePath, cropFaceData, opts.eyeEnhancement);
          portraitImagePath = tempEyePath;
        } catch (err) {
          console.log(`Eye enhancement skipped: ${err.message}`);
        }
      }

      // Upscaling: kept for compatibility if user explicitly asks; uses Replicate when set.
      // For local processing, leave at 'off' — source 24MP is already plenty for any output use.
      if (opts.upscaling && opts.upscaling !== 'off') {
        this.log(`Upscaling (4:5) - ${opts.upscaling}...`, 'step');
        const upscaleResult = await client.upscaleImage(portraitImagePath, opts.upscaling);
        if (!upscaleResult.success && !upscaleResult.skipped) {
          throw new Error(`Upscaling failed: ${upscaleResult.error}`);
        }
        if (upscaleResult.url) {
          const tempUpscalePath = path.join(outputFolder, `${baseName}_temp_upscale.jpg`);
          tempFiles.push(tempUpscalePath);
          const downloadResult = await client.downloadImage(upscaleResult.url, tempUpscalePath);
          if (!downloadResult.success) {
            throw new Error(`Failed to download upscaled image: ${downloadResult.error}`);
          }
          portraitImagePath = tempUpscalePath;
        }
      }

      // Save final portrait JPEG with -4x5 suffix
      this.log('Saving 4:5 portrait...', 'step');
      const finalPortraitPath = path.join(processedFolder, `${baseName}-4x5.jpg`);
      if (portraitImagePath !== croppedPath) {
        fs.copyFileSync(portraitImagePath, finalPortraitPath);
      } else {
        fs.copyFileSync(croppedPath, finalPortraitPath);
      }
      results.enhancedJpegPath = finalPortraitPath;

      // Background removal — local via Apple Vision (VNGenerateForegroundInstanceMaskRequest).
      // Replaces the Replicate BRIA call; 0.5–1s/photo on Apple Silicon, no network.
      if (opts.backgroundRemoval && opts.transparentPortrait) {
        this.log('Removing background (4:5)...', 'step');
        const transparentPngPath = path.join(processedFolder, `${baseName}-4x5-TP.png`);
        try {
          await this.removeBackgroundLocal(finalPortraitPath, transparentPngPath);
          results.transparentPngPath = transparentPngPath;

          // Add solid background color if specified
          if (opts.backgroundColor && opts.backgroundColor.match(/^#[0-9A-Fa-f]{6}$/)) {
            this.log(`Adding background color ${opts.backgroundColor}...`, 'step');
            const coloredPath = path.join(processedFolder, `${baseName}-4x5-BG.jpg`);
            const hex = opts.backgroundColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            await sharp(transparentPngPath).flatten({ background: { r, g, b } }).jpeg({ quality: 95 }).toFile(coloredPath);
            results.coloredJpegPath = coloredPath;
          }
        } catch (err) {
          this.log(`Background removal failed: ${err.message}`, 'warning');
        }
      }
    }

    // Process Square (1:1) version if enabled
    if (opts.outputSquare) {
      this.log('Creating square crop...', 'step');
      const squarePath = path.join(outputFolder, `${baseName}_temp_square.jpg`);
      tempFiles.push(squarePath);

      await this.applySmartCropAndCorrection(workingImagePath, squarePath, faceData, SQUARE_ASPECT_RATIO);

      let squareImagePath = squarePath;

      // Face enhancement if enabled (scalable: off, low, medium, high)
      if (opts.faceEnhancement && opts.faceEnhancement !== 'off') {
        this.log(`Face enhancement (square) - ${opts.faceEnhancement}...`, 'step');
        const tempEnhancedPath = path.join(outputFolder, `${baseName}_temp_sq_enhanced.jpg`);
        tempFiles.push(tempEnhancedPath);
        await this.applyLocalFaceEnhancement(squareImagePath, tempEnhancedPath, opts.faceEnhancement);
        squareImagePath = tempEnhancedPath;
      }

      // Skin smoothing if enabled
      if (opts.skinSmoothing && opts.skinSmoothing !== 'off') {
        this.log(`Skin smoothing (square) - ${opts.skinSmoothing}...`, 'step');
        const tempSkinPath = path.join(outputFolder, `${baseName}_temp_sq_skin.jpg`);
        tempFiles.push(tempSkinPath);
        await this.applySkinSmoothing(squareImagePath, tempSkinPath, opts.skinSmoothing);
        squareImagePath = tempSkinPath;
      }

      // Shine removal if enabled
      if (opts.shineRemoval && opts.shineRemoval !== 'off') {
        this.log(`Shine removal (square) - ${opts.shineRemoval}...`, 'step');
        const tempShinePath = path.join(outputFolder, `${baseName}_temp_sq_shine.jpg`);
        tempFiles.push(tempShinePath);
        await this.removeShine(squareImagePath, tempShinePath, opts.shineRemoval);
        squareImagePath = tempShinePath;
      }

      // Eye enhancement (region-targeted)
      if (opts.eyeEnhancement && opts.eyeEnhancement !== 'off') {
        this.log(`Eye enhancement (square) - ${opts.eyeEnhancement}...`, 'step');
        const tempEyePath = path.join(outputFolder, `${baseName}_temp_sq_eyes.jpg`);
        tempFiles.push(tempEyePath);
        try {
          const cropFaceData = await this.getSidecar().detectFace(squareImagePath);
          await this.applyEyeEnhancement(squareImagePath, tempEyePath, cropFaceData, opts.eyeEnhancement);
          squareImagePath = tempEyePath;
        } catch (err) {
          console.log(`Eye enhancement (square) skipped: ${err.message}`);
        }
      }

      // Upscaling if enabled (Replicate; off by default)
      if (opts.upscaling && opts.upscaling !== 'off') {
        this.log(`Upscaling (square) - ${opts.upscaling}...`, 'step');
        const upscaleResult = await client.upscaleImage(squareImagePath, opts.upscaling);
        if (!upscaleResult.success && !upscaleResult.skipped) {
          throw new Error(`Square upscaling failed: ${upscaleResult.error}`);
        }
        if (upscaleResult.url) {
          const tempUpscalePath = path.join(outputFolder, `${baseName}_temp_sq_upscale.jpg`);
          tempFiles.push(tempUpscalePath);
          const downloadResult = await client.downloadImage(upscaleResult.url, tempUpscalePath);
          if (!downloadResult.success) {
            throw new Error(`Failed to download upscaled square image: ${downloadResult.error}`);
          }
          squareImagePath = tempUpscalePath;
        }
      }

      // Save final square JPEG with -SQR suffix
      this.log('Saving square...', 'step');
      const finalSquarePath = path.join(processedFolder, `${baseName}-SQR.jpg`);
      if (squareImagePath !== squarePath) {
        fs.copyFileSync(squareImagePath, finalSquarePath);
      } else {
        fs.copyFileSync(squarePath, finalSquarePath);
      }
      results.enhancedSquarePath = finalSquarePath;

      // Background removal (square) — local via Apple Vision
      if (opts.backgroundRemoval && opts.transparentSquare) {
        this.log('Removing background (square)...', 'step');
        const transparentSquarePngPath = path.join(processedFolder, `${baseName}-SQR-TP.png`);
        try {
          await this.removeBackgroundLocal(finalSquarePath, transparentSquarePngPath);
          results.transparentSquarePngPath = transparentSquarePngPath;

          if (opts.backgroundColor && opts.backgroundColor.match(/^#[0-9A-Fa-f]{6}$/)) {
            this.log(`Adding background color (square) ${opts.backgroundColor}...`, 'step');
            const coloredPath = path.join(processedFolder, `${baseName}-SQR-BG.jpg`);
            const hex = opts.backgroundColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            await sharp(transparentSquarePngPath).flatten({ background: { r, g, b } }).jpeg({ quality: 95 }).toFile(coloredPath);
            results.coloredSquareJpegPath = coloredPath;
          }

          // Image-based background composite (takes precedence over solid colour fill above)
          if (opts.useBackgroundImage && opts.backgroundImagePath && fs.existsSync(opts.backgroundImagePath)) {
            this.log('Compositing background image (square)...', 'step');
            const bgCompositePath = path.join(processedFolder, `${baseName}-SQR-BG.jpg`);
            try {
              const fgMeta = await sharp(transparentSquarePngPath).metadata();
              const resizedBg = await sharp(opts.backgroundImagePath)
                .resize(fgMeta.width, fgMeta.height, { fit: 'cover', position: 'centre' })
                .toBuffer();
              await sharp(resizedBg)
                .composite([{ input: transparentSquarePngPath }])
                .jpeg({ quality: opts.jpegQuality || 92 })
                .toFile(bgCompositePath);
              results.backgroundCompositeSquarePath = bgCompositePath;
            } catch (e) {
              this.log(`Background composite (square) failed: ${e.message}`, 'warning');
            }
          }
        } catch (err) {
          this.log(`Background removal (square) failed: ${err.message}`, 'warning');
        }
      }
    }

    // Clean up temp files
    for (const tempFile of tempFiles) {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
      }
    }

    // Update item with output paths
    Object.assign(item, results);

    console.log('Processing complete:', baseName);

    return results;
  }

  /**
   * Detect face/nose position using smartcrop and calculate optimal crop region
   * Handles EXIF orientation to get correct dimensions
   * The nose (center of face) is used as the horizontal center reference
   */
  async detectFaceAndCrop(imagePath) {
    // Apple Vision via the Swift sidecar — returns landmark-driven geometry
    // in the *oriented* image space (EXIF applied). 76 landmarks per face.
    const sidecar = this.getSidecar();
    let result;
    try {
      result = await sidecar.detectFace(imagePath);
    } catch (err) {
      console.log('Sidecar face detection failed, falling back to smartcrop:', err.message);
      return this._detectFaceAndCropFallback(imagePath);
    }

    if (!result.found) {
      console.log('No face detected by Vision; falling back to smartcrop');
      return this._detectFaceAndCropFallback(imagePath);
    }

    const {
      imageWidth, imageHeight,
      boundingBox,
      eyeLineY, noseTipX, noseTipY,
      estimatedTopOfHead,
      faceHeight,
      confidence,
      yaw, pitch, roll
    } = result;

    console.log(
      `Vision face: bb (${Math.round(boundingBox.x)},${Math.round(boundingBox.y)}) ` +
      `${Math.round(boundingBox.width)}×${Math.round(boundingBox.height)} ` +
      `eye=${Math.round(eyeLineY)} nose=(${Math.round(noseTipX)},${Math.round(noseTipY)}) ` +
      `conf=${confidence.toFixed(2)}`
    );

    // Keep the legacy field names so existing callers continue to work,
    // but add the new landmark fields for the rewritten cropper.
    return {
      imageWidth,
      imageHeight,
      faceCenterX: noseTipX,
      faceCenterY: (boundingBox.y + boundingBox.height / 2),
      noseCenterX: noseTipX,
      noseCenterY: noseTipY,
      estimatedFaceHeight: faceHeight,
      // New landmark-driven fields
      eyeLineY,
      noseTipX,
      noseTipY,
      faceBoundingBox: boundingBox,
      estimatedTopOfHead,
      confidence,
      pose: { yaw, pitch, roll }
    };
  }

  /**
   * Legacy smartcrop-based detection — kept as a fallback when the sidecar
   * fails or no face is detected (e.g. occluded, extreme angle).
   */
  async _detectFaceAndCropFallback(imagePath) {
    if (!smartcrop) throw new Error('smartcrop-sharp not installed and Vision sidecar unavailable');
    const metadata = await sharp(imagePath).metadata();
    const needsRotation = metadata.orientation && metadata.orientation > 1;
    let width, height, tempPath = null;

    if (needsRotation) {
      tempPath = imagePath.replace(/\.[^.]+$/, `_detect_temp_${Date.now()}.jpg`);
      await sharp(imagePath).rotate().jpeg({ quality: 95 }).toFile(tempPath);
      const orientedMeta = await sharp(tempPath).metadata();
      width = orientedMeta.width;
      height = orientedMeta.height;
    } else {
      width = metadata.width;
      height = metadata.height;
    }

    const imageToCrop = tempPath || imagePath;
    const faceResult = await smartcrop.crop(imageToCrop, {
      width: Math.round(Math.min(width, height) * 0.3),
      height: Math.round(Math.min(width, height) * 0.3),
      boost: [{
        x: Math.round(width * 0.25),
        y: 0,
        width: Math.round(width * 0.5),
        height: Math.round(height * 0.5),
        weight: 2.0
      }]
    });

    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }

    const r = faceResult.topCrop;
    const noseCenterX = r.x + r.width / 2;
    const noseCenterY = r.y + r.height / 2;
    const estimatedFaceHeight = r.width * 1.3;
    const eyeLineY = r.y + r.height * 0.4;

    return {
      imageWidth: width,
      imageHeight: height,
      faceCenterX: noseCenterX,
      faceCenterY: noseCenterY,
      noseCenterX,
      noseCenterY,
      estimatedFaceHeight,
      eyeLineY,
      noseTipX: noseCenterX,
      noseTipY: noseCenterY,
      faceBoundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
      estimatedTopOfHead: r.y - r.height * 0.2,
      confidence: 0.5,
      pose: { yaw: 0, pitch: 0, roll: 0 }
    };
  }

  /**
   * Apply smart crop with proper headshot framing and color correction
   * Ensures person is centered horizontally in the frame
   */
  async applySmartCropAndCorrection(inputPath, outputPath, faceData, aspectRatio) {
    const {
      imageWidth, imageHeight,
      noseTipX, eyeLineY,
      faceBoundingBox, estimatedFaceHeight
    } = faceData;

    // Pro headshot framing rules:
    //  - eye line at ~38% from top of crop (rule of thirds; slightly above for portraits)
    //  - the visible head (chin to top of hair) ≈ 35% of crop height for 4:5,
    //    50% for square. Vision's bbox covers eyebrows-to-chin (~80% of full head),
    //    so multiply by 1.25 to estimate full head height.
    const isSquare = aspectRatio >= 1;
    const headHeightFactor = 1.25;
    const fullHeadHeight = (faceBoundingBox?.height || estimatedFaceHeight) * headHeightFactor;
    const headFractionOfFrame = isSquare ? 0.50 : 0.35;
    const eyeLineFraction = isSquare ? 0.38 : 0.38;

    const edgeMargin = Math.round(Math.min(imageWidth, imageHeight) * 0.03);
    const safeWidth = imageWidth - edgeMargin * 2;
    const safeHeight = imageHeight - edgeMargin * 2;

    // Crop height sized so the head occupies the desired fraction of the frame.
    let cropHeight = Math.min(fullHeadHeight / headFractionOfFrame, safeHeight);
    let cropWidth = cropHeight * aspectRatio;
    if (cropWidth > safeWidth) {
      cropWidth = safeWidth;
      cropHeight = cropWidth / aspectRatio;
    }
    cropWidth = Math.round(cropWidth);
    cropHeight = Math.round(cropHeight);

    // Anchor the eye line at eyeLineFraction from top of crop, nose centered horizontally.
    let cropX = Math.round(noseTipX - cropWidth / 2);
    let cropY = Math.round(eyeLineY - cropHeight * eyeLineFraction);

    // Clamp to safe bounds (with edge margin) to avoid backdrop corners
    if (cropX < edgeMargin) {
      console.log(`Adjusting crop to avoid left edge`);
      cropX = edgeMargin;
    } else if (cropX + cropWidth > imageWidth - edgeMargin) {
      console.log(`Adjusting crop to avoid right edge`);
      cropX = imageWidth - edgeMargin - cropWidth;
    }

    if (cropY < edgeMargin) {
      cropY = edgeMargin;
    } else if (cropY + cropHeight > imageHeight - edgeMargin) {
      cropY = imageHeight - edgeMargin - cropHeight;
    }

    // Final safety check - ensure we're within actual image bounds
    cropX = Math.max(0, Math.min(cropX, imageWidth - cropWidth));
    cropY = Math.max(0, Math.min(cropY, imageHeight - cropHeight));

    console.log(`Cropping: ${cropWidth}×${cropHeight} at (${cropX}, ${cropY}) — eye line ${Math.round(eyeLineY)}, nose ${Math.round(noseTipX)}, aspect ${aspectRatio}`);

    // First, create a properly oriented version of the image
    // This ensures all subsequent operations use correct coordinates
    const orientedTempPath = inputPath.replace(/\.[^.]+$/, `_oriented_${Date.now()}.jpg`);

    await sharp(inputPath)
      .rotate() // Auto-orient based on EXIF orientation tag
      .jpeg({ quality: 98 })
      .toFile(orientedTempPath);

    try {
      // Verify the oriented image dimensions match our expected dimensions
      const orientedMeta = await sharp(orientedTempPath).metadata();
      console.log(`Oriented image: ${orientedMeta.width}x${orientedMeta.height}, expected: ${imageWidth}x${imageHeight}`);

      // Recalculate crop if dimensions don't match (shouldn't happen, but safety check)
      if (orientedMeta.width !== imageWidth || orientedMeta.height !== imageHeight) {
        console.log('Warning: Dimension mismatch after rotation, recalculating crop');
        // Swap coordinates if needed
        const scaleX = orientedMeta.width / imageWidth;
        const scaleY = orientedMeta.height / imageHeight;
        cropX = Math.round(cropX * scaleX);
        cropY = Math.round(cropY * scaleY);
        cropWidth = Math.round(cropWidth * scaleX);
        cropHeight = Math.round(cropHeight * scaleY);
      }

      // Ensure crop is within bounds
      cropX = Math.max(0, Math.min(cropX, orientedMeta.width - cropWidth));
      cropY = Math.max(0, Math.min(cropY, orientedMeta.height - cropHeight));
      cropWidth = Math.min(cropWidth, orientedMeta.width - cropX);
      cropHeight = Math.min(cropHeight, orientedMeta.height - cropY);

      // Get configurable settings
      const opts = this.enhancementOptions;
      const brightness = opts.brightness !== undefined ? opts.brightness : 1.12;
      const wbStrength = opts.whiteBalanceStrength !== undefined ? opts.whiteBalanceStrength : 1.0;
      const sharpenSigma = opts.sharpening !== undefined ? opts.sharpening : 0.8;
      const jpegQuality = opts.jpegQuality !== undefined ? opts.jpegQuality : 92;

      // Calculate white balance correction
      const whiteBalanceCorrection = await this.calculateWhiteBalance(orientedTempPath);

      // Interpolate white balance matrix based on strength setting
      // 0.0 = identity (no correction), 1.0 = full correction
      const wbMatrix = whiteBalanceCorrection.matrix.map((row, i) =>
        row.map((val, j) => {
          const identity = i === j ? 1 : 0;
          return identity + (val - identity) * wbStrength;
        })
      );

      // Build the sharp pipeline with configurable settings
      let pipeline = sharp(orientedTempPath)
        .extract({
          left: cropX,
          top: cropY,
          width: cropWidth,
          height: cropHeight
        })
        .recomb(wbMatrix)
        .modulate({
          saturation: 1.05,
          brightness: brightness
        });

      // Only apply sharpening if sigma > 0
      if (sharpenSigma > 0) {
        pipeline = pipeline.sharpen({
          sigma: sharpenSigma,
          m1: 0.5,
          m2: 0.5
        });
      }

      await pipeline
        .jpeg({
          quality: jpegQuality,
          mozjpeg: true
        })
        .toFile(outputPath);
    } finally {
      // Clean up temp oriented file
      if (fs.existsSync(orientedTempPath)) {
        try { fs.unlinkSync(orientedTempPath); } catch (e) { /* ignore */ }
      }
    }
  }

  /**
   * Calculate white balance correction using highlights-based algorithm
   * Uses the brightest pixels as white reference - better for studio photos with white backdrops
   * Only corrects color temperature, preserves brightness
   */
  async calculateWhiteBalance(imagePath) {
    try {
      // Get image data for white balance calculation
      const { data, info } = await sharp(imagePath)
        .rotate() // Apply EXIF orientation first
        .resize(200, 200, { fit: 'inside' }) // Downsample for faster processing
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { width, height, channels: numChannels } = info;
      const pixelCount = width * height;

      // Collect pixel data and find highlights (brightest 10% of pixels)
      const pixels = [];
      for (let i = 0; i < data.length; i += numChannels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        pixels.push({ r, g, b, luminance });
      }

      // Sort by luminance and get the brightest 10%
      pixels.sort((a, b) => b.luminance - a.luminance);
      const highlightCount = Math.max(10, Math.floor(pixelCount * 0.1));
      const highlights = pixels.slice(0, highlightCount);

      // Calculate average of highlights (these should be white/near-white)
      let hR = 0, hG = 0, hB = 0;
      for (const p of highlights) {
        hR += p.r;
        hG += p.g;
        hB += p.b;
      }
      hR /= highlightCount;
      hG /= highlightCount;
      hB /= highlightCount;

      // Check if highlights are already close to white (neutral)
      const maxChannel = Math.max(hR, hG, hB);
      const highlightBrightness = (hR + hG + hB) / 3;

      // If the image is very bright overall (white background), apply minimal correction
      if (highlightBrightness > 220) {
        console.log(`White balance: Bright image detected (${highlightBrightness.toFixed(0)}), minimal correction`);
        // Only correct slight color casts, don't change brightness
        let rFactor = maxChannel / hR;
        let gFactor = maxChannel / hG;
        let bFactor = maxChannel / hB;

        // Very conservative limits for bright images (max 5% adjustment)
        const maxAdj = 1.05;
        const minAdj = 0.95;
        rFactor = Math.max(minAdj, Math.min(maxAdj, rFactor));
        gFactor = Math.max(minAdj, Math.min(maxAdj, gFactor));
        bFactor = Math.max(minAdj, Math.min(maxAdj, bFactor));

        console.log(`White balance correction: R=${rFactor.toFixed(3)}, G=${gFactor.toFixed(3)}, B=${bFactor.toFixed(3)}`);

        return {
          matrix: [
            [rFactor, 0, 0],
            [0, gFactor, 0],
            [0, 0, bFactor]
          ],
          factors: { r: rFactor, g: gFactor, b: bFactor }
        };
      }

      // For darker images, apply standard highlight-based correction
      // Target: make highlights neutral (equal R, G, B at max brightness)
      let rFactor = maxChannel / hR;
      let gFactor = maxChannel / hG;
      let bFactor = maxChannel / hB;

      // Limit correction (max 15% adjustment)
      const maxCorrection = 1.15;
      const minCorrection = 0.85;
      rFactor = Math.max(minCorrection, Math.min(maxCorrection, rFactor));
      gFactor = Math.max(minCorrection, Math.min(maxCorrection, gFactor));
      bFactor = Math.max(minCorrection, Math.min(maxCorrection, bFactor));

      console.log(`White balance correction: R=${rFactor.toFixed(3)}, G=${gFactor.toFixed(3)}, B=${bFactor.toFixed(3)}`);

      // Return as 3x3 color matrix for sharp.recomb()
      return {
        matrix: [
          [rFactor, 0, 0],
          [0, gFactor, 0],
          [0, 0, bFactor]
        ],
        factors: { r: rFactor, g: gFactor, b: bFactor }
      };
    } catch (error) {
      console.log('White balance calculation failed, using defaults:', error.message);
      // Return identity matrix (no correction)
      return {
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1]
        ],
        factors: { r: 1, g: 1, b: 1 }
      };
    }
  }

  /**
   * Remove shine/oily highlights from skin
   * Uses gamma correction to compress highlights while preserving midtones
   * @param {string} inputPath - Path to input image
   * @param {string} outputPath - Path for output image
   * @param {string} intensity - 'off', 'low', 'medium', 'high'
   */
  async removeShine(inputPath, outputPath, intensity = 'medium') {
    if (intensity === 'off') {
      // Just copy the file
      fs.copyFileSync(inputPath, outputPath);
      return { success: true, skipped: true };
    }

    try {
      // Intensity settings for highlight compression
      // Lower gamma = darker highlights, brightness compensates slightly
      const settings = {
        low: { gamma: 0.95, brightness: 0.98, saturation: 1.02 },
        medium: { gamma: 0.88, brightness: 0.96, saturation: 1.05 },
        high: { gamma: 0.80, brightness: 0.94, saturation: 1.08 }
      };

      const s = settings[intensity] || settings.medium;

      // Get raw pixel data for highlight detection (for logging)
      const { data, info } = await sharp(inputPath)
        .resize(200, 200, { fit: 'inside' }) // Downsample for analysis
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Calculate average brightness to log shine level
      let totalBrightness = 0;
      let highlightPixels = 0;
      const pixelCount = info.width * info.height;

      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        totalBrightness += luminance;
        if (luminance > 220) highlightPixels++; // Count very bright pixels
      }

      const avgBrightness = totalBrightness / pixelCount;
      const highlightRatio = highlightPixels / pixelCount;

      console.log(`Shine removal: avg brightness=${avgBrightness.toFixed(1)}, highlight ratio=${(highlightRatio * 100).toFixed(1)}%`);

      // Apply highlight compression using gamma and modulation
      // Gamma < 1 compresses highlights (bright areas get darker)
      // while preserving midtones and shadows
      await sharp(inputPath)
        .gamma(s.gamma, 3.0)
        .modulate({
          brightness: s.brightness,
          saturation: s.saturation
        })
        .jpeg({ quality: 95 })
        .toFile(outputPath);

      console.log(`Shine removal applied (${intensity})`);
      return { success: true };
    } catch (error) {
      console.error('Shine removal failed:', error.message);
      // On failure, just copy the original
      fs.copyFileSync(inputPath, outputPath);
      return { success: false, error: error.message };
    }
  }

  /**
   * Apply local skin smoothing using sharp blur+blend
   * No API call needed - instant processing with controllable intensity
   * @param {string} inputPath - Path to input image
   * @param {string} outputPath - Path for output image
   * @param {string} intensity - 'off', 'low', 'medium', 'high'
   */
  /**
   * Subtle, all-local "face enhancement" — replaces the Replicate CodeFormer/GFPGAN call.
   * Lightly softens skin via blurred-layer composite, gives a small brightness/saturation lift,
   * and applies a detail sharpen so eyes and textures stay crisp. ~1s on a 24MP image.
   *
   * Intensity scales the strength of each component:
   *   off    — copy as-is
   *   low    — barely perceptible (preserves natural skin texture)
   *   medium — corporate-headshot polish (default)
   *   high   — softer, more retouched look
   */
  async applyLocalFaceEnhancement(inputPath, outputPath, intensity = 'medium') {
    if (intensity === 'off') {
      fs.copyFileSync(inputPath, outputPath);
      return { success: true, skipped: true };
    }

    // Conservative presets — face enhancement should never make the image
    // perceptibly blurry. Smoothing is a very subtle pore-softening pass;
    // the sharpen on top is what should dominate.
    const presets = {
      low:    { brightness: 1.02, saturation: 1.02, smoothOpacity: 0.05, sharpenSigma: 1.0, sharpenM2: 0.6 },
      medium: { brightness: 1.04, saturation: 1.03, smoothOpacity: 0.10, sharpenSigma: 1.2, sharpenM2: 0.8 },
      high:   { brightness: 1.05, saturation: 1.04, smoothOpacity: 0.18, sharpenSigma: 1.5, sharpenM2: 1.0 }
    };
    const p = presets[intensity] || presets.medium;

    const meta = await sharp(inputPath).metadata();
    const shortDim = Math.min(meta.width, meta.height);
    const blurRadius = Math.max(3, Math.round(shortDim * 0.005));

    console.log(`Face enhancement (local): intensity=${intensity}, blur=${blurRadius}, brightness=${p.brightness}`);

    // Blurred layer for skin softening — bake the alpha into the buffer because
    // Sharp's composite `opacity` parameter is ignored on JPEG (no-alpha) buffers
    // in 0.33.x. ensureAlpha(value) adds a uniform alpha channel so blend: 'over' respects it.
    const softLayer = await sharp(inputPath)
      .blur(blurRadius)
      .ensureAlpha(p.smoothOpacity)
      .png()
      .toBuffer();

    await sharp(inputPath)
      .composite([{ input: softLayer, blend: 'over' }])
      .modulate({ brightness: p.brightness, saturation: p.saturation })
      .sharpen({ sigma: p.sharpenSigma, m1: 0.5, m2: p.sharpenM2 })
      .jpeg({ quality: 95 })
      .toFile(outputPath);

    return { success: true };
  }

  /**
   * Region-targeted eye enhancement.
   * Builds a soft elliptical mask covering both eyes, then composites a sharpened+brightened
   * version of the image through the mask so eyes get a subtle "pop" without affecting skin.
   *
   * Requires faceData with leftEyeRect / rightEyeRect (run detectFace on the cropped image first).
   */
  async applyEyeEnhancement(inputPath, outputPath, faceData, intensity = 'medium') {
    if (intensity === 'off' || !faceData?.found) {
      fs.copyFileSync(inputPath, outputPath);
      return { success: true, skipped: true };
    }

    const left = faceData.leftEyeRect;
    const right = faceData.rightEyeRect;
    if (!left && !right) {
      fs.copyFileSync(inputPath, outputPath);
      return { success: true, skipped: true };
    }

    // Conservative — eye enhancement should never produce a visible halo on skin.
    // Smaller padFactor keeps the mask tight to the eye contour; lower brightness
    // boost prevents the bright aura that leaks onto surrounding skin.
    const presets = {
      low:    { brightness: 1.02, sharpenSigma: 1.0, sharpenM2: 0.8, padFactor: 1.05 },
      medium: { brightness: 1.04, sharpenSigma: 1.3, sharpenM2: 1.0, padFactor: 1.15 },
      high:   { brightness: 1.07, sharpenSigma: 1.7, sharpenM2: 1.4, padFactor: 1.30 }
    };
    const p = presets[intensity] || presets.medium;

    const meta = await sharp(inputPath).metadata();
    const W = meta.width, H = meta.height;

    // Build SVG mask: black background, soft-feathered white ellipses on each eye.
    // Heavy feather (~1.2% of short dim) blends the effect into the skin imperceptibly.
    const featherStdDev = Math.round(Math.min(W, H) * 0.012);
    const ellipseSvg = (rect) => {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const rx = (rect.width / 2) * p.padFactor;
      const ry = (rect.height / 2) * p.padFactor * 1.2;
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="white" filter="url(#blur)" />`;
    };

    const ellipses = [left, right].filter(Boolean).map(ellipseSvg).join('');
    const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${featherStdDev}" /></filter></defs>
      <rect width="${W}" height="${H}" fill="black"/>
      ${ellipses}
    </svg>`;

    const maskBuffer = await sharp(Buffer.from(maskSvg)).png().toBuffer();

    // Sharpened+brightened version of the whole image
    const enhancedBuffer = await sharp(inputPath)
      .modulate({ brightness: p.brightness, saturation: 1.05 })
      .sharpen({ sigma: p.sharpenSigma, m1: 0.5, m2: p.sharpenM2 })
      .toColorspace('srgb')
      .png()
      .toBuffer();

    // Apply mask alpha to enhanced layer (only eye regions remain visible)
    const maskedEnhanced = await sharp(enhancedBuffer)
      .ensureAlpha()
      .joinChannel(await sharp(maskBuffer).extractChannel(0).toBuffer(), { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer()
      .catch(async () => {
        // Fallback: composite mask via dest-in
        return sharp(enhancedBuffer)
          .ensureAlpha()
          .composite([{ input: maskBuffer, blend: 'dest-in' }])
          .png()
          .toBuffer();
      });

    // Composite masked enhancement over original
    await sharp(inputPath)
      .composite([{ input: maskedEnhanced, blend: 'over' }])
      .jpeg({ quality: 95 })
      .toFile(outputPath);

    console.log(`Eye enhancement applied (${intensity})`);
    return { success: true };
  }

  async applySkinSmoothing(inputPath, outputPath, intensity = 'medium') {
    if (intensity === 'off') {
      fs.copyFileSync(inputPath, outputPath);
      return { success: true, skipped: true };
    }

    try {
      // Opacity of blurred layer over original
      const opacityMap = {
        low: 0.15,     // Very subtle smoothing
        medium: 0.30,  // Moderate smoothing
        high: 0.50     // Strong smoothing
      };

      const opacity = opacityMap[intensity] || 0.30;

      // Get image dimensions to calculate blur radius proportional to size
      const metadata = await sharp(inputPath).metadata();
      const shortDim = Math.min(metadata.width, metadata.height);
      // Blur radius ~0.7% of shorter dimension (e.g., 7px for a 1000px image)
      const blurRadius = Math.max(3, Math.round(shortDim * 0.007));

      console.log(`Skin smoothing (local): opacity=${opacity}, blur=${blurRadius}px (${intensity})`);

      // Create blurred version
      const blurredBuffer = await sharp(inputPath)
        .blur(blurRadius)
        .toBuffer();

      // Composite blurred layer over original with opacity
      await sharp(inputPath)
        .composite([{
          input: blurredBuffer,
          blend: 'over',
          opacity: opacity
        }])
        .jpeg({ quality: 95 })
        .toFile(outputPath);

      console.log(`Skin smoothing applied (${intensity})`);
      return { success: true };
    } catch (error) {
      console.error('Skin smoothing failed:', error.message);
      // On failure, just copy the original
      fs.copyFileSync(inputPath, outputPath);
      return { success: false, error: error.message };
    }
  }

  /**
   * Convert RAW file to JPEG using available tools (sips, dcraw)
   */
  async convertRawToJpeg(rawPath, outputFolder, baseName) {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    const outputPath = path.join(outputFolder, `${baseName}_converted.jpg`);

    // GUI-launched Electron apps on macOS don't inherit Homebrew's PATH
    const findBin = (name) => {
      const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, name];
      return candidates.find(p => p === name || fs.existsSync(p)) || name;
    };
    const dcrawBin = findBin('dcraw');
    const exiftoolBin = findBin('exiftool');

    // Try exiftool first - extracts the full-res embedded JPEG that the camera baked in.
    // Works for modern cameras (Nikon Z6_3, etc.) where dcraw 9.28 produces garbled output.
    // The embedded preview JPEG strips EXIF metadata, so we copy the Orientation tag back
    // from the RAW file — otherwise portrait shots come out as landscape sideways.
    try {
      await execPromise(`"${exiftoolBin}" -b -JpgFromRaw "${rawPath}" > "${outputPath}"`);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
        try {
          await execPromise(`"${exiftoolBin}" -tagsfromfile "${rawPath}" -Orientation -overwrite_original "${outputPath}"`);
        } catch (e) {
          console.log('Could not copy orientation from RAW (continuing):', e.message);
        }
        console.log('RAW converted via exiftool (embedded JPEG)');
        return outputPath;
      } else if (fs.existsSync(outputPath)) {
        // Empty/tiny file - extraction failed, remove and fall through
        try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      console.log('exiftool not available or no embedded JPEG:', err.message);
    }

    // Try dcraw next (works for older cameras dcraw 9.28 still supports)
    try {
      // dcraw -T creates a .tiff file in the same directory as the input
      // Don't use -c (stdout) as it can cause data corruption with pipes
      // -w: use camera white balance
      // -q 3: high quality interpolation
      // -T: output TIFF format
      // -o 1: sRGB colorspace
      const rawDir = path.dirname(rawPath);
      const rawName = path.basename(rawPath, path.extname(rawPath));
      const dcrawTiffOutput = path.join(rawDir, `${rawName}.tiff`);

      // Clean up any existing tiff from previous failed attempts
      if (fs.existsSync(dcrawTiffOutput)) {
        try { fs.unlinkSync(dcrawTiffOutput); } catch (e) { /* ignore */ }
      }

      await execPromise(`"${dcrawBin}" -w -q 3 -T -o 1 "${rawPath}"`);

      if (fs.existsSync(dcrawTiffOutput)) {
        // Convert TIFF to high-quality JPEG using sharp
        // Apply .rotate() to handle EXIF orientation correctly
        await sharp(dcrawTiffOutput)
          .rotate() // Auto-orient based on EXIF
          .jpeg({ quality: 95 })
          .toFile(outputPath);
        fs.unlinkSync(dcrawTiffOutput);
        console.log('RAW converted via dcraw');
        return outputPath;
      }
    } catch (err) {
      console.log('dcraw not available or failed:', err.message);
    }

    // Try sips (macOS built-in) - limited RAW support but works for some formats
    try {
      await execPromise(`sips -s format jpeg -s formatOptions 95 "${rawPath}" --out "${outputPath}"`);
      if (fs.existsSync(outputPath)) {
        console.log('RAW converted via sips');
        return outputPath;
      }
    } catch (err) {
      console.log('sips failed:', err.message);
    }

    // Try using macOS CoreImage via quick script
    try {
      const script = `
        tell application "Image Events"
          launch
          set theImage to open "${rawPath}"
          save theImage as JPEG in "${outputPath}" with compression level medium
          close theImage
        end tell
      `;
      await execPromise(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
      if (fs.existsSync(outputPath)) {
        console.log('RAW converted via Image Events');
        return outputPath;
      }
    } catch (err) {
      console.log('Image Events failed:', err.message);
    }

    return null;
  }

  /**
   * Retry a failed item
   */
  retryFailed(itemId) {
    const item = this.queue.find(i => i.id === itemId && i.status === 'failed');
    if (item) {
      item.status = 'pending';
      item.retries = 0;
      item.error = null;
      this.saveQueue();
      this.notifyStatusUpdate();

      if (this.processingEnabled && !this.processing) {
        this.processNext();
      }
    }
  }

  /**
   * Retry all failed items
   */
  retryAllFailed() {
    this.queue
      .filter(i => i.status === 'failed')
      .forEach(item => {
        item.status = 'pending';
        item.retries = 0;
        item.error = null;
      });

    this.saveQueue();
    this.notifyStatusUpdate();

    if (this.processingEnabled && !this.processing) {
      this.processNext();
    }
  }

  /**
   * Clear completed items from queue
   */
  clearCompleted() {
    this.queue = this.queue.filter(i => i.status !== 'completed');
    this.saveQueue();
    this.notifyStatusUpdate();
  }

  /**
   * Get failed items for UI display
   */
  getFailedItems() {
    return this.queue
      .filter(i => i.status === 'failed')
      .map(i => ({
        id: i.id,
        shootNumber: i.shootNumber,
        baseName: i.baseName,
        error: i.error,
        retries: i.retries
      }));
  }

  /**
   * Stop processing after current item completes
   */
  stopProcessing() {
    this.stopRequested = true;
    this.processingEnabled = false;

    // If currently processing, mark the item back to pending so it's not lost
    if (this.processing && this.currentItem) {
      this.currentItem.status = 'pending';
      this.currentItem.retries = 0;
      console.log('Stop requested - current item returned to pending');
    }

    this.processing = false;
    this.currentItem = null;
    this.saveQueue();
    this.notifyStatusUpdate();

    console.log('Processing stopped');
    return { success: true, message: 'Processing stopped' };
  }

  /**
   * Clear queue - removes pending and optionally failed items
   * @param {boolean} clearFailed - Also clear failed items
   */
  clearQueue(clearFailed = false) {
    // Stop any current processing first
    this.stopRequested = true;
    this.processing = false;
    this.currentItem = null;

    const pendingCount = this.queue.filter(i => i.status === 'pending' || i.status === 'processing').length;
    const failedCount = this.queue.filter(i => i.status === 'failed').length;

    if (clearFailed) {
      // Clear everything except completed
      this.queue = this.queue.filter(i => i.status === 'completed');
    } else {
      // Clear pending and processing items (but keep failed and completed)
      this.queue = this.queue.filter(i => i.status !== 'pending' && i.status !== 'processing');
    }

    this.saveQueue();
    this.notifyStatusUpdate();

    const clearedFailed = clearFailed ? failedCount : 0;
    console.log(`Queue cleared: ${pendingCount} pending, ${clearedFailed} failed items removed`);

    return {
      success: true,
      clearedPending: pendingCount,
      clearedFailed: clearedFailed
    };
  }
}

module.exports = HeadshotProcessor;
