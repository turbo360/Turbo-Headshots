/**
 * Replicate API Client for AI-powered headshot enhancement
 * Handles background removal and face restoration using Replicate cloud models
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

class ReplicateClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.replicate.com/v1';
    this.models = {
      backgroundRemoval: 'lucataco/remove-bg:95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1',
      faceRestoration: 'tencentarc/gfpgan:0fbacf7afc6c144e5be9767cff80f25aff23e52b0708f17e20f9879b2f21516c'
    };
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
   * Convert image file to base64 data URI
   */
  async imageToDataUri(imagePath) {
    const buffer = fs.readFileSync(imagePath);
    const base64 = buffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${base64}`;
  }

  /**
   * Wait for prediction to complete
   */
  async waitForPrediction(predictionUrl, maxAttempts = 120) {
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

      // Wait 500ms before polling again
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return { success: false, error: 'Timeout waiting for prediction' };
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
   * Enhance face using GFPGAN
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
            img: imageUri,
            version: 'v1.4',
            scale: 2
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
