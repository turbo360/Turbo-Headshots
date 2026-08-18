/**
 * Turbo IQ Gallery API Client
 * Handles authentication and photo uploads to iq.turbo.net.au
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class TurboIQGalleryClient {
  constructor() {
    this.baseUrl = 'https://iq.turbo.net.au';
    this.accessToken = null;
    this.tokenExpiry = null;
    this.username = null;
  }

  /**
   * Make an HTTP request to the API
   */
  async request(endpoint, options = {}) {
    // All API endpoints use /api prefix
    const apiEndpoint = endpoint.startsWith('/api') ? endpoint : `/api${endpoint}`;
    const url = new URL(apiEndpoint, this.baseUrl);

    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    if (this.accessToken && !options.skipAuth) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers
      };

      const req = httpModule.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, data: json, statusCode: res.statusCode });
            } else {
              resolve({
                success: false,
                error: json.detail || json.message || json.error || `HTTP ${res.statusCode}`,
                statusCode: res.statusCode,
                data: json
              });
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, data: data, statusCode: res.statusCode });
            } else {
              resolve({ success: false, error: data || `HTTP ${res.statusCode}`, statusCode: res.statusCode });
            }
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Network error: ${e.message}`));
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  /**
   * Check if we have a valid token
   */
  isAuthenticated() {
    if (!this.accessToken) return false;
    if (this.tokenExpiry && Date.now() >= this.tokenExpiry) return false;
    return true;
  }

  /**
   * Authenticate with the Turbo IQ Gallery API
   * POST /api/auth/login
   */
  async login(username, password) {
    try {
      const result = await this.request('/auth/login', {
        method: 'POST',
        body: { username, password },
        skipAuth: true
      });

      if (result.success && result.data.access_token) {
        this.accessToken = result.data.access_token;
        this.username = result.data.username || username;
        // Set expiry to 23 hours from now (tokens last 24h)
        this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);

        return {
          success: true,
          message: 'Logged in successfully',
          username: this.username
        };
      }

      return {
        success: false,
        error: result.error || 'Login failed'
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Test the connection/authentication
   */
  async testConnection() {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      // Try to list galleries as a connection test
      const result = await this.listGalleries(1);
      return {
        success: result.success,
        error: result.error,
        message: result.success ? 'Connection successful' : result.error
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * List all galleries
   * GET /api/galleries
   */
  async listGalleries(page = 1) {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated', galleries: [] };
    }

    try {
      const result = await this.request('/galleries');

      if (result.success) {
        // The API returns an array directly
        const galleries = Array.isArray(result.data) ? result.data : (result.data.galleries || []);
        return {
          success: true,
          galleries: galleries.map(g => ({
            id: g.id,
            name: g.name,
            event_date: g.event_date,
            photo_count: g.photo_count || 0,
            created_at: g.created_at
          }))
        };
      }

      return { success: false, error: result.error, galleries: [] };
    } catch (error) {
      return { success: false, error: error.message, galleries: [] };
    }
  }

  /**
   * Create a new gallery
   * POST /api/galleries
   */
  async createGallery(name, eventDate = null) {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const body = {
        name,
        event_date: eventDate || new Date().toISOString().split('T')[0]
      };

      const result = await this.request('/galleries', {
        method: 'POST',
        body
      });

      if (result.success) {
        return {
          success: true,
          gallery: result.data,
          message: 'Gallery created successfully'
        };
      }

      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get a presigned URL for uploading to S3
   * POST /api/galleries/{id}/presigned-url
   */
  async getPresignedUrl(galleryId, filename, contentType = 'image/jpeg') {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const result = await this.request(`/galleries/${galleryId}/presigned-url`, {
        method: 'POST',
        body: { filename, content_type: contentType }
      });

      if (result.success) {
        return {
          success: true,
          photoId: result.data.photo_id,
          uploadUrl: result.data.presigned_url,
          s3Key: result.data.s3_key,
          fields: result.data.fields || {}
        };
      }

      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Upload file to S3 using presigned POST URL with multipart form data
   */
  async uploadToS3(presignedUrl, fields, filePath, contentType = 'image/jpeg') {
    return new Promise((resolve, reject) => {
      const fileBuffer = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substr(2);

      // Build multipart form data
      let body = '';

      // Add all the fields from presigned URL
      for (const [key, value] of Object.entries(fields)) {
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
        body += `${value}\r\n`;
      }

      // Add the file
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
      body += `Content-Type: ${contentType}\r\n\r\n`;

      const bodyStart = Buffer.from(body, 'utf8');
      const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const fullBody = Buffer.concat([bodyStart, fileBuffer, bodyEnd]);

      const url = new URL(presignedUrl);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': fullBody.length
        }
      };

      const req = httpModule.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // S3 returns 204 No Content on success
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `S3 upload failed: HTTP ${res.statusCode} - ${data}` });
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`S3 upload error: ${e.message}`));
      });

      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('S3 upload timeout'));
      });

      req.write(fullBody);
      req.end();
    });
  }

  /**
   * Notify server that upload is complete
   * POST /api/galleries/{id}/upload-complete
   */
  async notifyUploadComplete(galleryId, photoId, s3Key, filename) {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const result = await this.request(`/galleries/${galleryId}/upload-complete`, {
        method: 'POST',
        body: {
          photo_id: photoId,
          s3_key: s3Key,
          filename: filename
        }
      });

      if (result.success) {
        return {
          success: true,
          photo: result.data,
          message: 'Upload complete'
        };
      }

      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Upload a photo to a gallery (full flow)
   * 1. Get presigned URL
   * 2. Upload to S3
   * 3. Notify server
   */
  async uploadPhoto(galleryId, filePath) {
    if (!this.isAuthenticated()) {
      return { success: false, error: 'Not authenticated' };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }

    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

    try {
      // Step 1: Get presigned URL
      console.log(`[Gallery] Getting presigned URL for ${filename}...`);
      const presignedResult = await this.getPresignedUrl(galleryId, filename, contentType);

      if (!presignedResult.success) {
        return { success: false, error: `Failed to get upload URL: ${presignedResult.error}` };
      }

      // Step 2: Upload to S3 using multipart form data
      console.log(`[Gallery] Uploading to S3...`);
      const uploadResult = await this.uploadToS3(
        presignedResult.uploadUrl,
        presignedResult.fields,
        filePath,
        contentType
      );

      if (!uploadResult.success) {
        return { success: false, error: uploadResult.error };
      }

      // Step 3: Notify server
      console.log(`[Gallery] Notifying server of upload completion...`);
      const completeResult = await this.notifyUploadComplete(
        galleryId,
        presignedResult.photoId,
        presignedResult.s3Key,
        filename
      );

      if (!completeResult.success) {
        return { success: false, error: `Upload complete notification failed: ${completeResult.error}` };
      }

      console.log(`[Gallery] Successfully uploaded ${filename}`);
      return {
        success: true,
        photo: completeResult.photo,
        filename,
        message: `Uploaded ${filename} successfully`
      };

    } catch (error) {
      console.error(`[Gallery] Upload error:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear authentication tokens
   */
  logout() {
    this.accessToken = null;
    this.tokenExpiry = null;
    this.username = null;
  }

  /**
   * Get serializable state for persistence
   */
  getState() {
    return {
      accessToken: this.accessToken,
      tokenExpiry: this.tokenExpiry,
      username: this.username
    };
  }

  /**
   * Restore state from persistence
   */
  setState(state) {
    if (state) {
      this.accessToken = state.accessToken || null;
      this.tokenExpiry = state.tokenExpiry || null;
      this.username = state.username || null;
    }
  }

  /* ========== Shoots + QR check-in (Turbo Headshots v2) ==========
     Server side: /api/shoots + /api/checkin-entries + /api/public/checkin
     (turbo-iq backend). All shapes per the v2 check-in design. */

  /**
   * Create a shoot server-side (anchors the check-in slug + links the gallery).
   * If galleryId is omitted, creates (or reuses by name) a gallery first.
   */
  async createShoot({ name, client = null, shootDate = null, location = null, galleryId = null, galleryName = null }) {
    try {
      let gid = galleryId;
      if (!gid) {
        const gname = galleryName || name;
        const created = await this.createGallery(gname, shootDate || undefined);
        if (created.success) {
          gid = created.gallery.id;
        } else if (created.statusCode === 400 || /already exists/i.test(created.error || '')) {
          // A gallery with this name exists. Only reuse it when its event_date
          // matches this shoot — silently attaching to an old client's gallery
          // (whose share link is already in their inbox) is a privacy leak.
          const list = await this.listGalleries();
          const match = list.success && list.galleries.find((g) => g.name === gname);
          if (match && shootDate && match.event_date === shootDate) {
            gid = match.id;
          } else if (match) {
            return {
              success: false, galleryId: null,
              error: `A gallery named "${gname}" already exists (event ${match.event_date || 'unknown'}). Pick a unique gallery name, or link it explicitly.`,
            };
          }
        }
        if (!gid) return { success: false, galleryId: null, error: created.error || 'Could not create gallery' };
      }
      const result = await this.request('/shoots', {
        method: 'POST',
        body: { name, client, shoot_date: shootDate, location, gallery_id: gid },
      });
      // On failure still return the gallery we created so the caller can
      // retry/link it instead of stranding an orphan.
      if (!result.success) return { success: false, error: result.error, galleryId: gid };
      return {
        success: true,
        shoot: result.data,
        checkinUrl: result.data.checkin_url,
        galleryId: gid,
        galleryShareUrl: result.data.gallery?.share_url ?? null,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async listShoots(status = 'active') {
    try {
      const result = await this.request(`/shoots?status=${encodeURIComponent(status)}`);
      return result.success
        ? { success: true, shoots: result.data }
        : { success: false, error: result.error };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async getShoot(shootId) {
    try {
      const result = await this.request(`/shoots/${shootId}`);
      return result.success ? { success: true, shoot: result.data } : { success: false, error: result.error };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async updateShoot(shootId, updates) {
    try {
      const result = await this.request(`/shoots/${shootId}`, { method: 'PUT', body: updates });
      return result.success ? { success: true, shoot: result.data } : { success: false, error: result.error };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async getCheckinQueue(shootId) {
    try {
      const result = await this.request(`/shoots/${shootId}/checkin-entries?status=waiting`);
      return result.success
        ? { success: true, entries: result.data.entries, waitingCount: result.data.waiting_count, serverTime: result.data.server_time }
        : { success: false, error: result.error };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async useCheckinEntry(entryId, shootNumber = null) {
    try {
      const result = await this.request(`/checkin-entries/${entryId}/use`, {
        method: 'POST',
        body: shootNumber ? { shoot_number: shootNumber } : {},
      });
      return result.success
        ? { success: true, entry: result.data }
        : { success: false, error: result.error, statusCode: result.statusCode };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async cancelCheckinEntry(entryId) {
    try {
      const result = await this.request(`/checkin-entries/${entryId}/cancel`, { method: 'POST', body: {} });
      return result.success ? { success: true, entry: result.data } : { success: false, error: result.error };
    } catch (e) { return { success: false, error: e.message }; }
  }

  async requeueCheckinEntry(entryId) {
    try {
      const result = await this.request(`/checkin-entries/${entryId}/requeue`, { method: 'POST', body: {} });
      return result.success ? { success: true, entry: result.data } : { success: false, error: result.error };
    } catch (e) { return { success: false, error: e.message }; }
  }

  /**
   * Delete a gallery photo by its exact filename (indexed lookup). Used to
   * REPLACE a re-rendered deliverable — the gallery's duplicate-filename guard
   * otherwise 409s every re-upload.
   */
  async replaceExistingPhoto(galleryId, filename) {
    const found = await this.request(`/galleries/${galleryId}/photo-by-filename?filename=${encodeURIComponent(filename)}`);
    if (!found.success || !found.data?.id) return false;
    const del = await this.request(`/photos/${found.data.id}`, { method: 'DELETE' });
    return !!del.success;
  }

  /**
   * uploadPhoto with coarse progress callbacks + retry. onProgress(pct 0-100).
   * A duplicate-filename rejection deletes the existing photo and retries —
   * a re-render REPLACES the previous version in the gallery.
   */
  async uploadPhotoWithProgress(galleryId, filePath, onProgress, retries = 2) {
    const path = require('path');
    let lastError = 'upload failed';
    let replacedOnce = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (onProgress) onProgress(attempt === 0 ? 5 : 10);
        const result = await this.uploadPhoto(galleryId, filePath);
        if (result.success) {
          if (onProgress) onProgress(100);
          return result;
        }
        lastError = result.error || lastError;
        if (!replacedOnce && /already exists/i.test(lastError)) {
          replacedOnce = true;
          const replaced = await this.replaceExistingPhoto(galleryId, path.basename(filePath));
          if (replaced) continue; // immediate retry, doesn't consume backoff
        }
      } catch (e) {
        lastError = e.message;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    return { success: false, error: lastError };
  }
}

module.exports = TurboIQGalleryClient;
