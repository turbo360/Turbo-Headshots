# Turbo Headshots - Development Guide

## Overview

Turbo Headshots is an Electron-based desktop application for professional headshot photography workflows. It integrates with LUMIX Tether for camera control, processes photos through AI enhancement pipelines via Replicate API, and uploads finished headshots to Turbo IQ Gallery for client delivery.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Turbo Headshots (Electron)                  │
├─────────────────────────────────────────────────────────────────┤
│  index.html          │  main.js              │  processor.js    │
│  - Registration UI   │  - IPC handlers       │  - Queue system  │
│  - Preview panel     │  - File watcher       │  - AI pipeline   │
│  - Queue panel       │  - Settings mgmt      │  - Smart crop    │
│  - Gallery modal     │  - Gallery client     │  - Color correct │
└─────────────────────────────────────────────────────────────────┘
          │                      │                      │
          ▼                      ▼                      ▼
   ┌──────────────┐    ┌─────────────────┐    ┌────────────────┐
   │ LUMIX Tether │    │  Replicate API  │    │  Turbo IQ API  │
   │ (Watch Dir)  │    │  (AI Models)    │    │ iq.turbo.net.au│
   └──────────────┘    └─────────────────┘    └────────────────┘
```

## File Structure

```
turbo-headshots/
├── main.js                 # Electron main process
├── index.html              # UI (single-page app)
├── processor.js            # AI enhancement queue & processing
├── replicate.js            # Replicate API client
├── gallery-client.js       # Turbo IQ Gallery API client
├── package.json            # Dependencies & build config
├── logo.png                # App logo
├── entitlements.mac.plist  # macOS code signing entitlements
└── .github/
    └── workflows/
        └── release.yml     # GitHub Actions build workflow
```

## Key Components

### 1. Main Process (`main.js`)

The Electron main process handles:
- Window management
- File system watching (chokidar) for new photos from LUMIX Tether
- IPC communication with renderer
- Settings persistence (`~/Library/Application Support/turbo-headshots/settings.json`)
- Processor initialization and callbacks
- Gallery client management

**Key IPC Handlers:**
| Handler | Purpose |
|---------|---------|
| `start-session` | Begin new photo session, generate shoot number |
| `save-session` | Save captured photo to organized folder |
| `get-ai-settings` / `set-ai-settings` | AI enhancement configuration |
| `get-queue-status` | Processing queue status |
| `reprocess-folder` / `reprocess-all-folders` | Batch reprocessing |
| `get-gallery-settings` / `set-gallery-credentials` | Gallery auth |
| `list-galleries` / `create-gallery` | Gallery management |
| `set-selected-gallery` | Select gallery for auto-upload |

### 2. Processor (`processor.js`)

Background queue system for AI-powered headshot enhancement:

**Processing Pipeline:**
1. **Face Detection** - Uses smartcrop-sharp to detect face position
2. **Smart Crop** - Crops to 4:5 portrait or 1:1 square with proper head positioning
3. **Color Correction** - White balance via highlights-based algorithm, brightness/saturation boost
4. **AI Enhancement** (via Replicate):
   - Face enhancement (GFPGAN) - off/low/medium/high
   - Skin smoothing - off/low/medium/high
   - Upscaling (Real-ESRGAN) - off/2x/4x
   - Background removal (rembg)
5. **Output** - Saves to `Processed/` subfolder with suffixes:
   - `-4x5.jpg` - Portrait JPEG
   - `-4x5-TP.png` - Portrait transparent PNG
   - `-SQR.jpg` - Square JPEG
   - `-SQR-TP.png` - Square transparent PNG

**Callbacks:**
- `onStatusUpdate(status)` - Queue status changes
- `onLogMessage({message, type})` - Processing log entries
- `onProcessingComplete({item, outputFiles})` - Triggers gallery upload

### 3. Gallery Client (`gallery-client.js`)

API client for Turbo IQ Gallery system:

**Authentication:**
```javascript
const client = new TurboIQGalleryClient();
await client.login(username, password);  // Returns JWT token
```

**Upload Flow:**
1. `getPresignedUrl(galleryId, filename, contentType)` - Get S3 upload URL
2. `uploadToS3(url, fields, filePath, contentType)` - Multipart POST to S3
3. `notifyUploadComplete(galleryId, photoId, s3Key, filename)` - Trigger processing

### 4. Replicate Client (`replicate.js`)

Wraps Replicate API for AI model inference:

**Models Used:**
- Face Enhancement: `tencentarc/gfpgan`
- Skin Smoothing: `tencentarc/gfpgan` (with parameters)
- Upscaling: `nightmareai/real-esrgan`
- Background Removal: `cjwbw/rembg`

## Turbo IQ Backend Integration

**Server:** `iq.turbo.net.au` (Port 8002)
**Service:** `turbo-iq-backend.service`
**Location:** `/home/turbo/turbo-iq/backend/`

### API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/login` | POST | Authenticate, get JWT |
| `/api/galleries` | GET | List all galleries |
| `/api/galleries` | POST | Create new gallery |
| `/api/galleries/{id}/presigned-url` | POST | Get S3 upload URL |
| `/api/galleries/{id}/upload-complete` | POST | Confirm upload |

### Backend Architecture

```
Turbo IQ Backend (FastAPI)
├── server.py           # Main API server (8002)
├── aws_utils.py        # S3, Rekognition, Lambda utilities
├── email_service.py    # Notification emails
├── sms_service.py      # SMS notifications
└── .env                # Environment configuration

Storage:
├── S3: turbo-iq-originals     # Original uploads
├── S3: turbo-iq-thumbnails    # Generated thumbnails
├── S3: turbo-iq-previews      # Preview images
└── CloudFront                  # CDN distribution

Database: MongoDB (turbo_iq_production)
├── galleries           # Gallery metadata
├── photos              # Photo records with AI tags
├── users               # User accounts
└── face_subscriptions  # Find Me feature
```

## Development

### Prerequisites

- Node.js 20+
- macOS (for building signed releases)
- Apple Developer certificate (for code signing)

### Local Development

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build unsigned DMG (local testing)
npm run build
```

### Environment Variables

**Turbo Headshots** stores settings in:
`~/Library/Application Support/turbo-headshots/settings.json`

Key settings:
```json
{
  "watchFolder": "/path/to/lumix/output",
  "outputFolder": "/path/to/organized/headshots",
  "replicateApiKey": "r8_xxx...",
  "galleryUsername": "turbo",
  "galleryPassword": "xxx",
  "galleryAutoUpload": true,
  "uploadPortrait": true,
  "uploadSquare": true,
  "uploadTransparent": true
}
```

### Testing Gallery Integration

```javascript
const TurboIQGalleryClient = require('./gallery-client');
const client = new TurboIQGalleryClient();

// Test connection
const login = await client.login('turbo', 'password');
console.log(login);  // { success: true, username: 'turbo' }

// List galleries
const galleries = await client.listGalleries();
console.log(galleries);  // { success: true, galleries: [...] }

// Upload photo
const result = await client.uploadPhoto('gallery-id', '/path/to/photo.jpg');
console.log(result);  // { success: true, photo: {...} }
```

## Deployment

### GitHub Actions Release

Releases are triggered by pushing a version tag:

```bash
# Update version in package.json
npm version 1.6.0 --no-git-tag-version

# Commit changes
git add -A
git commit -m "v1.6.0 - Feature description"
git push origin main

# Create and push tag to trigger build
git tag -a v1.6.0 -m "Release notes..."
git push origin v1.6.0
```

**Workflow:** `.github/workflows/release.yml`
- Runs on: `macos-latest`
- Signs with Apple Developer certificate
- Notarizes with Apple
- Creates GitHub Release with DMG and ZIP

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `CSC_LINK` | Base64-encoded .p12 certificate |
| `CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Developer Team ID (ETURVK9WSA) |

### Auto-Update

The app uses `electron-updater` for automatic updates:
- Checks GitHub releases on startup
- Shows update banner when available
- Downloads and installs on user confirmation

Feed URL configured in `package.json`:
```json
{
  "publish": {
    "provider": "github",
    "owner": "turbo360",
    "repo": "Turbo-Headshots"
  }
}
```

## Turbo IQ Server Management

**SSH Access:**
```bash
ssh root@208.87.135.158
# Password: GBasqKXy2q
```

**Service Management:**
```bash
# Check status
systemctl status turbo-iq-backend

# Restart service
systemctl restart turbo-iq-backend

# View logs
tail -f /home/turbo/turbo-iq/logs/backend.log
tail -f /home/turbo/turbo-iq/logs/backend-error.log
```

**IMPORTANT - Shared Server Warning:**
This server hosts multiple websites. Only modify files within `/home/turbo/turbo-iq/`. Do NOT:
- Restart nginx globally
- Modify shared configs
- Change server-wide settings

## Workflow Overview

### Typical Photography Session

1. **Setup**
   - Launch Turbo Headshots
   - Connect camera via LUMIX Tether
   - Set watch folder (LUMIX output) and output folder

2. **Registration**
   - Enter client details (name, email, mobile, company)
   - Click "Start Session" → generates shoot number (YYYYMMDD-NNN)

3. **Photography**
   - Take photos in LUMIX Tether (RAW+JPEG mode recommended)
   - Photos appear in preview automatically
   - RAW files are copied to organized folder structure

4. **AI Processing**
   - Photos automatically queue for processing (if enabled)
   - Face detection → Smart crop → Color correction → AI enhancement
   - Outputs: Portrait, Square, Transparent versions

5. **Gallery Upload**
   - Select gallery in Turbo IQ (or create new)
   - Enable auto-upload
   - Processed photos upload automatically after AI enhancement

6. **Client Delivery**
   - Client receives gallery link via Turbo IQ
   - Can browse, download, or use "Find Me" face search

## Troubleshooting

### Common Issues

**"No JPEG available for RAW processing"**
- Enable RAW+JPEG mode on camera
- Or install `dcraw` for RAW conversion: `brew install dcraw`

**Gallery upload fails with 401**
- Token expired - re-login in Gallery modal
- Check credentials are correct

**Processing queue stuck**
- Check Replicate API key is valid
- Check internet connection
- View logs in Processing Log panel

**App won't start after update**
- Delete app preferences: `rm -rf ~/Library/Application\ Support/turbo-headshots/`
- Reinstall from GitHub releases

### Debug Logging

Open DevTools in Electron:
- View → Toggle Developer Tools
- Check Console for errors

Backend logs:
```bash
ssh root@208.87.135.158
tail -100 /home/turbo/turbo-iq/logs/backend.log
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.6.0 | 2026-01-22 | Turbo IQ Gallery integration, auto-upload, Reprocess All |
| 1.5.x | 2026-01 | Face framing improvements, brightness adjustments |
| 1.4.x | 2025-12 | AI enhancement pipeline, background removal |
| 1.3.x | 2025-11 | Smart crop, color correction |
| 1.0.0 | 2025-10 | Initial release |

## Repository Links

- **Turbo Headshots:** https://github.com/turbo360/Turbo-Headshots
- **Turbo IQ:** https://github.com/turbo360/TURBO-IQ
