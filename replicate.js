/**
 * Replicate API Client for AI-powered headshot enhancement
 * Handles background removal and face restoration using Replicate cloud models
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Max dimension for images sent to API (larger images are resized)
const MAX_API_IMAGE_DIMENSION = 2048;

class ReplicateClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.replicate.com/v1';
    this.models = {
      // Using rembg with u2net model - better for hair and fine edges
      backgroundRemoval: 'cjwbw/rembg:fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003',
      // CodeFormer with high fidelity - preserves natural look while fixing minor issues
      faceRestoration: 'sczhou/codeformer:7de2ea26c616d5bf2245ad0d5e24f0ff9a6204578a5c876db53142edd9d2cd56'
    };
    // Fidelity: 0 = more enhancement, 1 = more original. Use 0.7 for subtle touch-ups
    this.faceRestorationFidelity = 0.7;
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
  async imageToDataUri(imagePath) {
    // Check image dimensions
    const metadata = await sharp(imagePath).metadata();
    let buffer;

    if (metadata.width > MAX_API_IMAGE_DIMENSION || metadata.height > MAX_API_IMAGE_DIMENSION) {
      // Resize large images to speed up API processing
      console.log(`Resizing image from ${metadata.width}x${metadata.height} to max ${MAX_API_IMAGE_DIMENSION}px for API`);
      buffer = await sharp(imagePath)
        .resize(MAX_API_IMAGE_DIMENSION, MAX_API_IMAGE_DIMENSION, {
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

      // Log progress every 10 seconds
      if (i > 0 && i % 20 === 0) {
        console.log(`Still waiting for API response... (${i / 2}s)`);
      }

      // Wait 500ms before polling again
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return { success: false, error: 'Timeout waiting for prediction (150s)' };
  }

  /**
   * Remove background from image
   * Returns URL to transparent PNG
   */
  async removeBackground(imagePath) {
    try {
      const imageUri = await this.imageToDataUri(imagePath);

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
   * Uses high fidelity setting to preserve natural appearance
   * Returns URL to enhanced image
   */
  async enhanceFace(imagePath) {
    try {
      const imageUri = await this.imageToDataUri(imagePath);

      const response = await axios.post(
        `${this.baseUrl}/predictions`,
        {
          version: this.models.faceRestoration.split(':')[1],
          input: {
            image: imageUri,
            upscale: 2,
            face_upsample: true,
            background_enhance: false,
            // High fidelity (0.7) = subtle touch-ups, preserves natural look
            // Lower values = more aggressive enhancement
            codeformer_fidelity: this.faceRestorationFidelity
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
   * Download image from URL to local file
   */
  async downloadImage(url, outputPath) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      fs.writeFileSync(outputPath, Buffer.from(response.data));
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = ReplicateClient;
