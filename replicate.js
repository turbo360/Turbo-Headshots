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

// Rate limiting:
//   - Accounts with $5+ credit: 600 predictions/min (10/sec)
//   - Accounts with < $5 credit: 6 predictions/min with burst of 1
// Default to the low-tier safe pace (11s ≈ 5.5/min) so we don't hammer 429s.
// Top up Replicate credit ≥ $5 to unlock the 600/min tier (drop this to 100ms).
const MIN_REQUEST_INTERVAL_MS = 11000;

// Enhancement intensity mappings (off, low, medium, high)
// Higher fidelity = more faithful to original (less AI alteration)
// Calibrated for studio-quality input photos
const INTENSITY_MAP = {
  off: null,
  low: 0.95,      // Barely noticeable - preserves natural skin texture
  medium: 0.8,    // Gentle restoration
  high: 0.5       // Noticeable smoothing/restoration
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
      // Background removal - BRIA RMBG 2.0 for 256-level alpha masks (better hair edges)
      backgroundRemoval: 'bria/remove-background',
      // Face restoration - CodeFormer with adjustable fidelity
      faceRestoration: 'sczhou/codeformer:7de2ea26c616d5bf2245ad0d5e24f0ff9a6204578a5c876db53142edd9d2cd56',
      // Upscaling - Real-ESRGAN for high quality upscaling
      upscaling: 'nightmareai/real-esrgan:f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa'
    };
  }

  /**
   * Rate limiter - waits if needed before making a request
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
   * POST a prediction with automatic 429 retry.
   * Replicate's 429 message includes a `resets in ~Ns` hint we use as the wait.
   */
  async postPrediction(url, body, maxRetries = 5) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await axios.post(url, body, {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        });
      } catch (error) {
        const status = error.response?.status;
        const detail = error.response?.data?.detail || '';
        if (status === 429 && attempt < maxRetries) {
          const match = detail.match(/resets in ~(\d+)s/i);
          const waitMs = (match ? parseInt(match[1], 10) : 12) * 1000 + 500;
          console.log(`429 throttled. Retry ${attempt + 1}/${maxRetries} after ${Math.round(waitMs / 1000)}s...`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw error;
      }
    }
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
        .jpeg({ quality: 95 })
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

      // BRIA RMBG 2.0 uses model name (no version hash needed)
      const response = await this.postPrediction(
        `${this.baseUrl}/models/${this.models.backgroundRemoval}/predictions`,
        { input: { image: imageUri } }
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

      const response = await this.postPrediction(
        `${this.baseUrl}/predictions`,
        {
          version: this.models.faceRestoration.split(':')[1],
          input: {
            image: imageUri,
            upscale: 1,
            face_upsample: false,
            background_enhance: false,
            codeformer_fidelity: fidelity
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

      const response = await this.postPrediction(
        `${this.baseUrl}/predictions`,
        {
          version: this.models.upscaling.split(':')[1],
          input: {
            image: imageUri,
            scale: scaleFactor,
            face_enhance: false  // We handle face separately
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
