/**
 * Replicate API Client for AI-powered headshot enhancement
 * Handles background removal, face restoration, upscaling, and retouching
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Max dimension for images sent to API (larger images are resized)
const MAX_API_IMAGE_DIMENSION = 2048;

// Rate limiting: 6 requests per minute for accounts with < $5 credit
// We'll use 12 seconds between requests to be safe (5 per minute)
const MIN_REQUEST_INTERVAL_MS = 12000;

// Enhancement intensity mappings (off, low, medium, high)
const INTENSITY_MAP = {
  off: null,
  low: 0.85,      // Very subtle
  medium: 0.6,    // Balanced
  high: 0.3       // Aggressive
};

// Upscale factors
const UPSCALE_MAP = {
  off: 1,
  '2x': 2,
  '4x': 4
};

class ReplicateClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.replicate.com/v1';
    this.lastRequestTime = 0; // For rate limiting
    this.models = {
      // Background removal - rembg with u2net for better hair/edges
      backgroundRemoval: 'cjwbw/rembg:fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003',
      // Face restoration - CodeFormer with adjustable fidelity
      faceRestoration: 'sczhou/codeformer:7de2ea26c616d5bf2245ad0d5e24f0ff9a6204578a5c876db53142edd9d2cd56',
      // Upscaling - Real-ESRGAN for high quality upscaling
      upscaling: 'nightmareai/real-esrgan:f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa',
      // Skin retouching - using a specialized portrait enhancer
      skinRetouch: 'tencentarc/gfpgan:0fbacf7afc6c144e5be9767cff80f25aff23e52b0708f17e20f9879b2f21516c',
      // All-in-one face enhancement with more control
      faceEnhanceAll: 'daanelson/real-esrgan-a100:f94d7ed4a1f7e1ffed0a4b626e5086fd85bfb82e1127fd4a63f63d8e4e5f9a3e'
    };

    // Default enhancement settings
    this.settings = {
      faceEnhancement: 'medium',      // off, low, medium, high
      skinSmoothing: 'low',           // off, low, medium, high
      eyeEnhancement: 'low',          // off, low, medium, high
      teethWhitening: 'off',          // off, low, medium, high
      upscaling: 'off',               // off, 2x, 4x
      backgroundRemoval: true,
      backgroundColor: null           // null = transparent, or hex color like '#FFFFFF'
    };
  }

  /**
   * Rate limiter - waits if needed before making a request
   * Replicate limits to 6 req/min for accounts with < $5 credit
   */
  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
      const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
      console.log(`Rate limiting: waiting ${Math.round(waitTime / 1000)}s before next API call...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Update enhancement settings
   */
  setSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    console.log('Replicate client settings updated:', this.settings);
  }

  /**
   * Test API connection
   */
  async testConnection() {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 10000
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.detail || error.message
      };
    }
  }

  /**
   * Convert image file to base64 data URI, resizing if too large
   */
  async imageToDataUri(imagePath, maxDimension = MAX_API_IMAGE_DIMENSION) {
    const metadata = await sharp(imagePath).metadata();
    let buffer;

    if (metadata.width > maxDimension || metadata.height > maxDimension) {
      console.log(`Resizing image from ${metadata.width}x${metadata.height} to max ${maxDimension}px for API`);
      buffer = await sharp(imagePath)
        .resize(maxDimension, maxDimension, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 92 })
        .toBuffer();
    } else {
      buffer = fs.readFileSync(imagePath);
    }

    const base64 = buffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${base64}`;
  }

  /**
   * Wait for prediction to complete
   */
  async waitForPrediction(predictionUrl, maxAttempts = 300) {
    for (let i = 0; i < maxAttempts; i++) {
      const response = await axios.get(predictionUrl, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      const status = response.data.status;

      if (status === 'succeeded') {
        return { success: true, output: response.data.output };
      }

      if (status === 'failed' || status === 'canceled') {
        return {
          success: false,
          error: response.data.error || 'Prediction failed'
        };
      }

      if (i > 0 && i % 20 === 0) {
        console.log(`Still waiting for API response... (${i / 2}s)`);
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return { success: false, error: 'Timeout waiting for prediction (150s)' };
  }

  /**
   * Remove background from image
   * @param {string} imagePath - Path to input image
   * @param {string} backgroundColor - Optional background color (hex) or null for transparent
   */
  async removeBackground(imagePath, backgroundColor = null) {
    try {
      const imageUri = await this.imageToDataUri(imagePath);

      // Wait for rate limit before making API call
      await this.waitForRateLimit();

      const response = await axios.post(
        `${this.baseUrl}/predictions`,
        {
          version: this.models.backgroundRemoval.split(':')[1],
          input: { image: imageUri }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = await this.waitForPrediction(response.data.urls.get);

      if (result.success) {
        return { success: true, url: result.output };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.detail || error.message
      };
    }
  }

  /**
   * Enhance face using CodeFormer
   * @param {string} imagePath - Path to input image
   * @param {string} intensity - 'off', 'low', 'medium', 'high'
   */
  async enhanceFace(imagePath, intensity = 'medium') {
    if (intensity === 'off') {
      return { success: true, url: null, skipped: true };
    }

    try {
      const imageUri = await this.imageToDataUri(imagePath);
      const fidelity = INTENSITY_MAP[intensity] || 0.6;

      console.log(`Face enhancement with fidelity ${fidelity} (${intensity})`);

      // Wait for rate limit before making API call
      await this.waitForRateLimit();

      const response = await axios.post(
        `${this.baseUrl}/predictions`,
        {
          version: this.models.faceRestoration.split(':')[1],
          input: {
            image: imageUri,
            upscale: 2,
            face_upsample: true,
            background_enhance: false,
            codeformer_fidelity: fidelity
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = await this.waitForPrediction(response.data.urls.get);

      if (result.success) {
        return { success: true, url: result.output };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.detail || error.message
      };
    }
  }

  /**
   * Apply skin smoothing/retouching
   * Uses GFPGAN with adjusted settings for skin focus
   * @param {string} imagePath - Path to input image
   * @param {string} intensity - 'off', 'low', 'medium', 'high'
   */
  async smoothSkin(imagePath, intensity = 'low') {
    if (intensity === 'off') {
      return { success: true, url: null, skipped: true };
    }

    try {
      const imageUri = await this.imageToDataUri(imagePath);

      // GFPGAN scale affects smoothing intensity
      const scaleMap = { low: 1, medium: 2, high: 2 };
      const scale = scaleMap[intensity] || 1;

      console.log(`Skin smoothing with scale ${scale} (${intensity})`);

      // Wait for rate limit before making API call
      await this.waitForRateLimit();

      const response = await axios.post(
        `${this.baseUrl}/predictions`,
        {
          version: this.models.skinRetouch.split(':')[1],
          input: {
            img: imageUri,
            version: 'v1.4',
            scale: scale
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = await this.waitForPrediction(response.data.urls.get);

      if (result.success) {
        return { success: true, url: result.output };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.detail || error.message
      };
    }
  }

  /**
   * Upscale image using Real-ESRGAN
   * @param {string} imagePath - Path to input image
   * @param {string} scale - 'off', '2x', '4x'
   */
  async upscaleImage(imagePath, scale = '2x') {
    if (scale === 'off') {
      return { success: true, url: null, skipped: true };
    }

    try {
      const imageUri = await this.imageToDataUri(imagePath, 1024); // Smaller input for upscaling
      const scaleFactor = UPSCALE_MAP[scale] || 2;

      console.log(`Upscaling image ${scaleFactor}x`);

      // Wait for rate limit before making API call
      await this.waitForRateLimit();

      const response = await axios.post(
        `${this.baseUrl}/predictions`,
        {
          version: this.models.upscaling.split(':')[1],
          input: {
            image: imageUri,
            scale: scaleFactor,
            face_enhance: false  // We handle face separately
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = await this.waitForPrediction(response.data.urls.get);

      if (result.success) {
        return { success: true, url: result.output };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.detail || error.message
      };
    }
  }

  /**
   * Apply comprehensive portrait enhancement
   * Combines multiple enhancements based on settings
   * @param {string} imagePath - Path to input image
   * @param {object} options - Enhancement options
   */
  async enhancePortrait(imagePath, options = {}) {
    const opts = { ...this.settings, ...options };
    const results = { steps: [] };

    try {
      let currentImagePath = imagePath;
      let tempFiles = [];

      // Step 1: Face Enhancement (if enabled)
      if (opts.faceEnhancement !== 'off') {
        console.log(`Step 1: Face enhancement (${opts.faceEnhancement})`);
        const faceResult = await this.enhanceFace(currentImagePath, opts.faceEnhancement);

        if (faceResult.success && faceResult.url) {
          const tempPath = imagePath.replace(/\.[^.]+$/, '_face_temp.jpg');
          await this.downloadImage(faceResult.url, tempPath);
          currentImagePath = tempPath;
          tempFiles.push(tempPath);
          results.steps.push({ name: 'faceEnhancement', success: true });
        } else if (!faceResult.skipped) {
          results.steps.push({ name: 'faceEnhancement', success: false, error: faceResult.error });
        }
      }

      // Step 2: Skin Smoothing (if enabled and different from face enhancement)
      if (opts.skinSmoothing !== 'off' && opts.skinSmoothing !== opts.faceEnhancement) {
        console.log(`Step 2: Skin smoothing (${opts.skinSmoothing})`);
        const skinResult = await this.smoothSkin(currentImagePath, opts.skinSmoothing);

        if (skinResult.success && skinResult.url) {
          const tempPath = imagePath.replace(/\.[^.]+$/, '_skin_temp.jpg');
          await this.downloadImage(skinResult.url, tempPath);
          currentImagePath = tempPath;
          tempFiles.push(tempPath);
          results.steps.push({ name: 'skinSmoothing', success: true });
        } else if (!skinResult.skipped) {
          results.steps.push({ name: 'skinSmoothing', success: false, error: skinResult.error });
        }
      }

      // Step 3: Upscaling (if enabled) - do this last for best quality
      if (opts.upscaling !== 'off') {
        console.log(`Step 3: Upscaling (${opts.upscaling})`);
        const upscaleResult = await this.upscaleImage(currentImagePath, opts.upscaling);

        if (upscaleResult.success && upscaleResult.url) {
          const tempPath = imagePath.replace(/\.[^.]+$/, '_upscale_temp.jpg');
          await this.downloadImage(upscaleResult.url, tempPath);
          currentImagePath = tempPath;
          tempFiles.push(tempPath);
          results.steps.push({ name: 'upscaling', success: true });
        } else if (!upscaleResult.skipped) {
          results.steps.push({ name: 'upscaling', success: false, error: upscaleResult.error });
        }
      }

      results.success = true;
      results.finalImagePath = currentImagePath;
      results.tempFiles = tempFiles;

      return results;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        steps: results.steps
      };
    }
  }

  /**
   * Add solid color background to transparent image
   * @param {string} inputPath - Path to transparent PNG
   * @param {string} outputPath - Path for output
   * @param {string} color - Hex color like '#FFFFFF'
   */
  async addBackgroundColor(inputPath, outputPath, color) {
    try {
      // Parse hex color
      const hex = color.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);

      await sharp(inputPath)
        .flatten({ background: { r, g, b } })
        .jpeg({ quality: 95 })
        .toFile(outputPath);

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Download image from URL to local file
   */
  async downloadImage(url, outputPath) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000
      });

      fs.writeFileSync(outputPath, Buffer.from(response.data));
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Clean up temporary files
   */
  cleanupTempFiles(files) {
    for (const file of files) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (e) {
        console.log('Failed to cleanup temp file:', file);
      }
    }
  }
}

module.exports = ReplicateClient;
