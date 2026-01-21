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

    // Enhancement options with scalable intensity controls
    this.enhancementOptions = {
      outputPortrait: true,
      outputSquare: true,
      faceEnhancement: 'medium',    // off, low, medium, high
      skinSmoothing: 'off',         // off, low, medium, high
      upscaling: 'off',             // off, 2x, 4x
      backgroundRemoval: true,
      backgroundColor: ''           // Empty = transparent, or hex like '#FFFFFF'
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
      if (opts.backgroundRemoval) {
        folders.portraitTransparent = path.join(outputFolder, '4x5_transparent');
      }
    }
    if (opts.outputSquare) {
      folders.square = path.join(outputFolder, 'square');
      if (opts.backgroundRemoval) {
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

      // Face enhancement if enabled (scalable: off, low, medium, high)
      if (opts.faceEnhancement && opts.faceEnhancement !== 'off') {
        console.log(`Enhancing face (4:5) - intensity: ${opts.faceEnhancement}...`);
        const enhanceResult = await client.enhanceFace(croppedPath, opts.faceEnhancement);
        if (!enhanceResult.success && !enhanceResult.skipped) {
          throw new Error(`Face enhancement failed: ${enhanceResult.error}`);
        }
        if (enhanceResult.url) {
          const tempEnhancedPath = path.join(outputFolder, `${baseName}_temp_enhanced.jpg`);
          tempFiles.push(tempEnhancedPath);
          const downloadResult = await client.downloadImage(enhanceResult.url, tempEnhancedPath);
          if (!downloadResult.success) {
            throw new Error(`Failed to download enhanced image: ${downloadResult.error}`);
          }
          portraitImagePath = tempEnhancedPath;
        }
      }

      // Skin smoothing if enabled (scalable: off, low, medium, high)
      if (opts.skinSmoothing && opts.skinSmoothing !== 'off') {
        console.log(`Smoothing skin (4:5) - intensity: ${opts.skinSmoothing}...`);
        const skinResult = await client.smoothSkin(portraitImagePath, opts.skinSmoothing);
        if (!skinResult.success && !skinResult.skipped) {
          throw new Error(`Skin smoothing failed: ${skinResult.error}`);
        }
        if (skinResult.url) {
          const tempSkinPath = path.join(outputFolder, `${baseName}_temp_skin.jpg`);
          tempFiles.push(tempSkinPath);
          const downloadResult = await client.downloadImage(skinResult.url, tempSkinPath);
          if (!downloadResult.success) {
            throw new Error(`Failed to download skin-smoothed image: ${downloadResult.error}`);
          }
          portraitImagePath = tempSkinPath;
        }
      }

      // Upscaling if enabled (scalable: off, 2x, 4x)
      if (opts.upscaling && opts.upscaling !== 'off') {
        console.log(`Upscaling (4:5) - scale: ${opts.upscaling}...`);
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

      // Save final portrait JPEG
      const finalPortraitPath = path.join(folders.portrait, `${baseName}.jpg`);
      if (portraitImagePath !== croppedPath) {
        fs.copyFileSync(portraitImagePath, finalPortraitPath);
      } else {
        fs.copyFileSync(croppedPath, finalPortraitPath);
      }
      results.enhancedJpegPath = finalPortraitPath;

      // Background removal if enabled
      if (opts.backgroundRemoval) {
        console.log('Removing background (4:5)...');
        const bgResult = await client.removeBackground(finalPortraitPath);
        if (!bgResult.success) {
          throw new Error(`Background removal failed: ${bgResult.error}`);
        }
        const transparentPngPath = path.join(folders.portraitTransparent, `${baseName}.png`);
        const pngDownloadResult = await client.downloadImage(bgResult.url, transparentPngPath);
        if (!pngDownloadResult.success) {
          throw new Error(`Failed to download transparent PNG: ${pngDownloadResult.error}`);
        }
        results.transparentPngPath = transparentPngPath;

        // Add solid background color if specified
        if (opts.backgroundColor && opts.backgroundColor.match(/^#[0-9A-Fa-f]{6}$/)) {
          console.log(`Adding background color: ${opts.backgroundColor}`);
          const coloredPath = path.join(folders.portrait, `${baseName}_colored.jpg`);
          const colorResult = await client.addBackgroundColor(transparentPngPath, coloredPath, opts.backgroundColor);
          if (colorResult.success) {
            results.coloredJpegPath = coloredPath;
          }
        }
      }
    }

    // Process Square (1:1) version if enabled
    if (opts.outputSquare) {
      const squarePath = path.join(outputFolder, `${baseName}_temp_square.jpg`);
      tempFiles.push(squarePath);

      await this.applySmartCropAndCorrection(workingImagePath, squarePath, faceData, SQUARE_ASPECT_RATIO);

      let squareImagePath = squarePath;

      // Face enhancement if enabled (scalable: off, low, medium, high)
      if (opts.faceEnhancement && opts.faceEnhancement !== 'off') {
        console.log(`Enhancing face (square) - intensity: ${opts.faceEnhancement}...`);
        const enhanceResult = await client.enhanceFace(squarePath, opts.faceEnhancement);
        if (!enhanceResult.success && !enhanceResult.skipped) {
          throw new Error(`Square face enhancement failed: ${enhanceResult.error}`);
        }
        if (enhanceResult.url) {
          const tempEnhancedPath = path.join(outputFolder, `${baseName}_temp_sq_enhanced.jpg`);
          tempFiles.push(tempEnhancedPath);
          const downloadResult = await client.downloadImage(enhanceResult.url, tempEnhancedPath);
          if (!downloadResult.success) {
            throw new Error(`Failed to download enhanced square image: ${downloadResult.error}`);
          }
          squareImagePath = tempEnhancedPath;
        }
      }

      // Skin smoothing if enabled (scalable: off, low, medium, high)
      if (opts.skinSmoothing && opts.skinSmoothing !== 'off') {
        console.log(`Smoothing skin (square) - intensity: ${opts.skinSmoothing}...`);
        const skinResult = await client.smoothSkin(squareImagePath, opts.skinSmoothing);
        if (!skinResult.success && !skinResult.skipped) {
          throw new Error(`Square skin smoothing failed: ${skinResult.error}`);
        }
        if (skinResult.url) {
          const tempSkinPath = path.join(outputFolder, `${baseName}_temp_sq_skin.jpg`);
          tempFiles.push(tempSkinPath);
          const downloadResult = await client.downloadImage(skinResult.url, tempSkinPath);
          if (!downloadResult.success) {
            throw new Error(`Failed to download skin-smoothed square image: ${downloadResult.error}`);
          }
          squareImagePath = tempSkinPath;
        }
      }

      // Upscaling if enabled (scalable: off, 2x, 4x)
      if (opts.upscaling && opts.upscaling !== 'off') {
        console.log(`Upscaling (square) - scale: ${opts.upscaling}...`);
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

      // Save final square JPEG
      const finalSquarePath = path.join(folders.square, `${baseName}.jpg`);
      if (squareImagePath !== squarePath) {
        fs.copyFileSync(squareImagePath, finalSquarePath);
      } else {
        fs.copyFileSync(squarePath, finalSquarePath);
      }
      results.enhancedSquarePath = finalSquarePath;

      // Background removal if enabled
      if (opts.backgroundRemoval) {
        console.log('Removing background (square)...');
        const bgSquareResult = await client.removeBackground(finalSquarePath);
        if (!bgSquareResult.success) {
          throw new Error(`Square background removal failed: ${bgSquareResult.error}`);
        }
        const transparentSquarePngPath = path.join(folders.squareTransparent, `${baseName}.png`);
        const squarePngDownloadResult = await client.downloadImage(bgSquareResult.url, transparentSquarePngPath);
        if (!squarePngDownloadResult.success) {
          throw new Error(`Failed to download transparent square PNG: ${squarePngDownloadResult.error}`);
        }
        results.transparentSquarePngPath = transparentSquarePngPath;

        // Add solid background color if specified
        if (opts.backgroundColor && opts.backgroundColor.match(/^#[0-9A-Fa-f]{6}$/)) {
          console.log(`Adding background color (square): ${opts.backgroundColor}`);
          const coloredPath = path.join(folders.square, `${baseName}_colored.jpg`);
          const colorResult = await client.addBackgroundColor(transparentSquarePngPath, coloredPath, opts.backgroundColor);
          if (colorResult.success) {
            results.coloredSquareJpegPath = coloredPath;
          }
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
    // First, create a properly oriented temp image for face detection
    // This ensures smartcrop works with the correct orientation
    const metadata = await sharp(imagePath).metadata();

    // Check if image needs rotation based on EXIF orientation
    const needsRotation = metadata.orientation && metadata.orientation > 1;

    let width, height, tempPath = null;

    if (needsRotation) {
      // Create a temp file with correct orientation for smartcrop
      tempPath = imagePath.replace(/\.[^.]+$/, `_detect_temp_${Date.now()}.jpg`);
      await sharp(imagePath)
        .rotate() // Auto-orient based on EXIF
        .jpeg({ quality: 95 })
        .toFile(tempPath);

      const orientedMeta = await sharp(tempPath).metadata();
      width = orientedMeta.width;
      height = orientedMeta.height;
      console.log(`Image rotated for detection: ${width}x${height} (was ${metadata.width}x${metadata.height}, orientation: ${metadata.orientation})`);
    } else {
      width = metadata.width;
      height = metadata.height;
    }

    const imageToCrop = tempPath || imagePath;

    // Step 1: Do a tight face detection to find the actual face region
    // Use a small square crop to pinpoint the face/nose area
    const faceResult = await smartcrop.crop(imageToCrop, {
      width: Math.round(Math.min(width, height) * 0.3),  // Small square for precise face detection
      height: Math.round(Math.min(width, height) * 0.3),
      boost: [
        // Heavily boost the upper-center region where faces typically are
        {
          x: Math.round(width * 0.25),
          y: 0,
          width: Math.round(width * 0.5),
          height: Math.round(height * 0.5),
          weight: 2.0
        }
      ]
    });

    // Clean up temp file
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }

    const faceRegion = faceResult.topCrop;

    // The nose is at the center of the detected face region
    // This is our primary horizontal reference point
    const noseCenterX = faceRegion.x + faceRegion.width / 2;
    const noseCenterY = faceRegion.y + faceRegion.height / 2;

    // Estimate the full face height based on the detected region
    // A face is roughly as wide as it is tall, so we use the region width
    const estimatedFaceHeight = faceRegion.width * 1.3; // Face is slightly taller than wide

    console.log(`Face/nose detection: region (${faceRegion.x}, ${faceRegion.y}) ${faceRegion.width}x${faceRegion.height}`);
    console.log(`Nose center: (${Math.round(noseCenterX)}, ${Math.round(noseCenterY)})`);

    return {
      imageWidth: width,
      imageHeight: height,
      // Nose/face center is the primary horizontal reference
      faceCenterX: noseCenterX,
      faceCenterY: noseCenterY,
      noseCenterX,
      noseCenterY,
      estimatedFaceHeight,
      smartcropRegion: faceRegion,
      wasRotated: needsRotation
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

      // Calculate white balance correction using gray world algorithm
      const whiteBalanceCorrection = await this.calculateWhiteBalance(orientedTempPath);

      // Apply crop and color correction to the already-oriented image
      await sharp(orientedTempPath)
        .extract({
          left: cropX,
          top: cropY,
          width: cropWidth,
          height: cropHeight
        })
        .recomb(whiteBalanceCorrection.matrix) // Apply white balance correction
        .modulate({
          saturation: 1.05,  // Subtle saturation boost
          brightness: 1.01
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
