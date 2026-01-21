/**
 * Background Processing Queue for AI-powered headshot enhancement
 * Handles queuing, processing, and status tracking for headshot images
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const smartcrop = require('smartcrop-sharp');
const ReplicateClient = require('./replicate');

// Headshot cropping constants
const HEADSHOT_ASPECT_RATIO = 4 / 5;  // Standard headshot ratio (4:5)
const SQUARE_ASPECT_RATIO = 1;         // 1:1 for square output
const FACE_POSITION_FROM_TOP = 0.35;   // Face should be ~35% from top
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
    this.watchFolder = null; // Set by main.js for JPEG fallback lookup
    this.queueFilePath = path.join(app.getPath('userData'), 'processing_queue.json');
    this.stopRequested = false; // Flag to stop processing after current item

    // Enhancement options (all enabled by default)
    this.enhancementOptions = {
      enableFaceEnhancement: true,
      enableBackgroundRemoval: true,
      outputPortrait: true,
      outputSquare: true
    };

    // Load persisted queue on startup
    this.loadQueue();
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
    if (apiKey && this.queue.length > 0 && !this.processing) {
      this.processNext();
    }
  }

  /**
   * Enable or disable processing
   */
  setProcessingEnabled(enabled) {
    this.processingEnabled = enabled;
    if (enabled && this.apiKey && this.queue.length > 0 && !this.processing) {
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
    if (this.apiKey && this.processingEnabled && !this.processing) {
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
   * Process the next item in the queue
   */
  async processNext() {
    if (this.processing || !this.apiKey || !this.processingEnabled) {
      return;
    }

    // Find next pending item
    const nextItem = this.queue.find(i => i.status === 'pending');
    if (!nextItem) {
      return;
    }

    this.processing = true;
    this.currentItem = nextItem;
    nextItem.status = 'processing';
    this.saveQueue();
    this.notifyStatusUpdate();

    try {
      await this.processHeadshot(nextItem);
      nextItem.status = 'completed';
      nextItem.completedAt = new Date().toISOString();
    } catch (error) {
      console.error('Processing error:', error);
      nextItem.error = error.message;
      nextItem.retries++;

      if (nextItem.retries >= this.maxRetries) {
        nextItem.status = 'failed';
      } else {
        nextItem.status = 'pending';
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
      console.log('Processing stopped by user request');
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
        // Try to find JPEG in watch folder with original naming
        const originalBaseName = path.basename(sourcePath, ext);
        // Extract the original filename pattern (remove shoot number prefix)
        const match = originalBaseName.match(/_(\d+)$/);
        if (match) {
          // Try common camera naming patterns in watch folder
          const watchFiles = fs.existsSync(this.watchFolder) ? fs.readdirSync(this.watchFolder) : [];
          const jpegFile = watchFiles.find(f =>
            f.toLowerCase().endsWith('.jpg') &&
            (f.includes(originalBaseName) || watchFiles.indexOf(f) !== -1)
          );
          if (jpegFile) {
            workingImagePath = path.join(this.watchFolder, jpegFile);
            console.log('Found JPEG in watch folder:', workingImagePath);
          }
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
          throw new Error('No JPEG available and RAW conversion failed. Please enable JPEG+RAW mode on camera, or install dcraw for RAW processing.');
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

    // Create output subfolders for enabled output types only
    const folders = {};
    if (opts.outputPortrait) {
      folders.portrait = path.join(outputFolder, '4x5');
      if (opts.enableBackgroundRemoval) {
        folders.portraitTransparent = path.join(outputFolder, '4x5_transparent');
      }
    }
    if (opts.outputSquare) {
      folders.square = path.join(outputFolder, 'square');
      if (opts.enableBackgroundRemoval) {
        folders.squareTransparent = path.join(outputFolder, 'square_transparent');
      }
    }

    // Create subfolders
    for (const folder of Object.values(folders)) {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
    }

    // Step 2: Detect face and calculate smart crop region
    console.log('Detecting face and calculating crop...');
    const faceData = await this.detectFaceAndCrop(workingImagePath);

    const client = new ReplicateClient(this.apiKey);
    const tempFiles = [];
    const results = {};

    // Process Portrait (4:5) version if enabled
    if (opts.outputPortrait) {
      const croppedPath = path.join(outputFolder, `${baseName}_temp_cropped.jpg`);
      tempFiles.push(croppedPath);

      await this.applySmartCropAndCorrection(workingImagePath, croppedPath, faceData, HEADSHOT_ASPECT_RATIO);

      let portraitImagePath = croppedPath;

      // Face enhancement if enabled
      if (opts.enableFaceEnhancement) {
        console.log('Enhancing face (4:5)...');
        const enhanceResult = await client.enhanceFace(croppedPath);
        if (!enhanceResult.success) {
          throw new Error(`Face enhancement failed: ${enhanceResult.error}`);
        }
        portraitImagePath = path.join(folders.portrait, `${baseName}.jpg`);
        const downloadResult = await client.downloadImage(enhanceResult.url, portraitImagePath);
        if (!downloadResult.success) {
          throw new Error(`Failed to download enhanced image: ${downloadResult.error}`);
        }
        results.enhancedJpegPath = portraitImagePath;
      } else {
        // Just copy the cropped version without AI enhancement
        portraitImagePath = path.join(folders.portrait, `${baseName}.jpg`);
        fs.copyFileSync(croppedPath, portraitImagePath);
        results.enhancedJpegPath = portraitImagePath;
      }

      // Background removal if enabled
      if (opts.enableBackgroundRemoval) {
        console.log('Removing background (4:5)...');
        const bgResult = await client.removeBackground(portraitImagePath);
        if (!bgResult.success) {
          throw new Error(`Background removal failed: ${bgResult.error}`);
        }
        const transparentPngPath = path.join(folders.portraitTransparent, `${baseName}.png`);
        const pngDownloadResult = await client.downloadImage(bgResult.url, transparentPngPath);
        if (!pngDownloadResult.success) {
          throw new Error(`Failed to download transparent PNG: ${pngDownloadResult.error}`);
        }
        results.transparentPngPath = transparentPngPath;
      }
    }

    // Process Square (1:1) version if enabled
    if (opts.outputSquare) {
      const squarePath = path.join(outputFolder, `${baseName}_temp_square.jpg`);
      tempFiles.push(squarePath);

      await this.applySmartCropAndCorrection(workingImagePath, squarePath, faceData, SQUARE_ASPECT_RATIO);

      let squareImagePath = squarePath;

      // Face enhancement if enabled
      if (opts.enableFaceEnhancement) {
        console.log('Enhancing face (square)...');
        const enhanceSquareResult = await client.enhanceFace(squarePath);
        if (!enhanceSquareResult.success) {
          throw new Error(`Square face enhancement failed: ${enhanceSquareResult.error}`);
        }
        squareImagePath = path.join(folders.square, `${baseName}.jpg`);
        const squareDownloadResult = await client.downloadImage(enhanceSquareResult.url, squareImagePath);
        if (!squareDownloadResult.success) {
          throw new Error(`Failed to download enhanced square image: ${squareDownloadResult.error}`);
        }
        results.enhancedSquarePath = squareImagePath;
      } else {
        // Just copy the cropped version without AI enhancement
        squareImagePath = path.join(folders.square, `${baseName}.jpg`);
        fs.copyFileSync(squarePath, squareImagePath);
        results.enhancedSquarePath = squareImagePath;
      }

      // Background removal if enabled
      if (opts.enableBackgroundRemoval) {
        console.log('Removing background (square)...');
        const bgSquareResult = await client.removeBackground(squareImagePath);
        if (!bgSquareResult.success) {
          throw new Error(`Square background removal failed: ${bgSquareResult.error}`);
        }
        const transparentSquarePngPath = path.join(folders.squareTransparent, `${baseName}.png`);
        const squarePngDownloadResult = await client.downloadImage(bgSquareResult.url, transparentSquarePngPath);
        if (!squarePngDownloadResult.success) {
          throw new Error(`Failed to download transparent square PNG: ${squarePngDownloadResult.error}`);
        }
        results.transparentSquarePngPath = transparentSquarePngPath;
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
   * Detect face position using smartcrop and calculate optimal crop region
   */
  async detectFaceAndCrop(imagePath) {
    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;

    // Use smartcrop to find the best face-focused region
    // Request a square crop to find the face center
    const result = await smartcrop.crop(imagePath, {
      width: Math.min(width, height),
      height: Math.min(width, height),
      boost: [{ x: 0, y: 0, width: width, height: height * 0.7, weight: 1.0 }] // Boost upper portion where faces typically are
    });

    const topCrop = result.topCrop;

    // Calculate face center from smartcrop result
    const faceCenterX = topCrop.x + topCrop.width / 2;
    const faceCenterY = topCrop.y + topCrop.height / 2;

    // Estimate face bounds (smartcrop doesn't give exact face box, so we estimate)
    // The crop region usually centers on the face, so we use it as reference
    const estimatedFaceHeight = topCrop.height * 0.4; // Face is roughly 40% of the crop height
    const estimatedFaceTop = faceCenterY - estimatedFaceHeight * 0.6; // Face center is ~60% down the face

    return {
      imageWidth: width,
      imageHeight: height,
      faceCenterX,
      faceCenterY,
      estimatedFaceTop,
      estimatedFaceHeight,
      smartcropRegion: topCrop
    };
  }

  /**
   * Apply smart crop with proper headshot framing and color correction
   * Ensures person is centered horizontally in the frame
   */
  async applySmartCropAndCorrection(inputPath, outputPath, faceData, aspectRatio) {
    const { imageWidth, imageHeight, faceCenterX, faceCenterY, estimatedFaceTop, estimatedFaceHeight } = faceData;

    // Calculate crop dimensions based on desired aspect ratio
    // Use a larger multiplier to include more of the person and avoid cutting edges
    let cropHeight, cropWidth;

    if (aspectRatio >= 1) {
      // Square - include head to chest
      cropHeight = Math.min(estimatedFaceHeight * 3.5, imageHeight);
      cropWidth = cropHeight * aspectRatio;
    } else {
      // Portrait (like 4:5) - include more body/shoulders
      cropHeight = Math.min(estimatedFaceHeight * 4, imageHeight);
      cropWidth = cropHeight * aspectRatio;
    }

    // Ensure crop doesn't exceed image bounds - scale down proportionally if needed
    if (cropWidth > imageWidth) {
      const scale = imageWidth / cropWidth;
      cropWidth = imageWidth;
      cropHeight = cropWidth / aspectRatio;
    }
    if (cropHeight > imageHeight) {
      const scale = imageHeight / cropHeight;
      cropHeight = imageHeight;
      cropWidth = cropHeight * aspectRatio;
    }

    // Round dimensions
    cropWidth = Math.round(cropWidth);
    cropHeight = Math.round(cropHeight);

    // HORIZONTAL: Center crop on the face center - this is the priority
    let cropX = Math.round(faceCenterX - cropWidth / 2);

    // VERTICAL: Position face in upper portion of frame
    // For headshots, face should be around 30-35% from top
    const targetFacePositionY = aspectRatio === 1
      ? cropHeight * 0.35  // For square, face in upper third
      : cropHeight * 0.30; // For portrait, face higher up

    let cropY = Math.round(faceCenterY - targetFacePositionY);

    // Clamp to image bounds while trying to maintain centering
    // If we hit a boundary, adjust but log a warning
    if (cropX < 0) {
      console.log(`Warning: Face near left edge, adjusting crop`);
      cropX = 0;
    } else if (cropX + cropWidth > imageWidth) {
      console.log(`Warning: Face near right edge, adjusting crop`);
      cropX = imageWidth - cropWidth;
    }

    if (cropY < 0) {
      cropY = 0;
    } else if (cropY + cropHeight > imageHeight) {
      cropY = imageHeight - cropHeight;
    }

    console.log(`Cropping: ${cropWidth}x${cropHeight} at (${cropX}, ${cropY}) - face center: (${Math.round(faceCenterX)}, ${Math.round(faceCenterY)}) - aspect ratio: ${aspectRatio}`);

    // Apply crop and color correction
    await sharp(inputPath)
      .extract({
        left: cropX,
        top: cropY,
        width: cropWidth,
        height: cropHeight
      })
      .normalize() // Auto white balance / histogram stretch
      .modulate({
        saturation: 1.08,  // Slightly reduced saturation boost
        brightness: 1.02
      })
      .sharpen({
        sigma: 0.8,
        m1: 0.5,
        m2: 0.5
      })
      .jpeg({
        quality: 92,
        mozjpeg: true
      })
      .toFile(outputPath);
  }

  /**
   * Convert RAW file to JPEG using available tools (sips, dcraw)
   */
  async convertRawToJpeg(rawPath, outputFolder, baseName) {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    const outputPath = path.join(outputFolder, `${baseName}_converted.jpg`);

    // Try dcraw first (better quality, supports more formats)
    try {
      // dcraw -c -w outputs to stdout, we pipe to convert or save directly
      // -w: use camera white balance
      // -q 3: high quality interpolation
      // -T: output TIFF
      const tiffPath = path.join(outputFolder, `${baseName}_temp.tiff`);
      await execPromise(`dcraw -w -q 3 -T -o 1 -c "${rawPath}" > "${tiffPath}"`);

      if (fs.existsSync(tiffPath)) {
        // Convert TIFF to high-quality JPEG using sharp
        await sharp(tiffPath)
          .jpeg({ quality: 95 })
          .toFile(outputPath);
        fs.unlinkSync(tiffPath);
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

      if (this.apiKey && this.processingEnabled && !this.processing) {
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

    if (this.apiKey && this.processingEnabled && !this.processing) {
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
