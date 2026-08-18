// media:// protocol — serves local images to the renderer, path-guarded to the
// watch/output/userData roots. ?w=N returns a cached sharp thumbnail.
const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/**
 * @param {Electron.App} app
 * @param {() => string[]} allowedRoots returns the currently-allowed root dirs
 */
function registerMediaProtocol(app, allowedRoots) {
  const thumbDir = path.join(app.getPath('userData'), 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  // Age sweep: thumbnails are re-derivable — drop anything older than 30 days.
  try {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(thumbDir)) {
      const p = path.join(thumbDir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* best effort */ }

  protocol.handle('media', async (request) => {
    try {
      const u = new URL(request.url);
      // media:///abs/path?w=480 — pathname carries the absolute file path
      const filePath = decodeURIComponent(u.pathname);
      const resolved = path.resolve(filePath);

      const roots = allowedRoots().filter(Boolean).map((r) => path.resolve(r));
      const allowed = roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
      if (!allowed) return new Response('Forbidden', { status: 403 });
      if (!fs.existsSync(resolved)) return new Response('Not found', { status: 404 });

      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME[ext];
      // Images only — userData is an allowed root for thumbnails, and serving
      // arbitrary bytes would hand the renderer settings.json (credentials).
      if (!mime) return new Response('Forbidden', { status: 403 });
      const w = Math.min(3200, Number(u.searchParams.get('w')) || 0);

      if (!w) {
        return new Response(fs.readFileSync(resolved), { headers: { 'Content-Type': mime } });
      }

      const st = fs.statSync(resolved);
      const key = crypto.createHash('sha1')
        .update(`${resolved}|${st.mtimeMs}|${st.size}|${w}`).digest('hex');
      const thumbPath = path.join(thumbDir, `${key}.jpg`);
      if (!fs.existsSync(thumbPath)) {
        await sharp(resolved)
          .rotate()
          .resize(w, w * 2, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toFile(thumbPath);
      }
      return new Response(fs.readFileSync(thumbPath), { headers: { 'Content-Type': 'image/jpeg' } });
    } catch (err) {
      console.error('[media]', err.message);
      return new Response('Error', { status: 500 });
    }
  });
}

module.exports = { registerSchemes, registerMediaProtocol };
