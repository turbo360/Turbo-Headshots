import React, { useEffect, useState } from 'react';
import { useStore, activeShoot } from '../state/store';
import { Badge, Button, Input, SwitchRow } from '../components/ds';

export default function GalleryUpload() {
  const s = useStore();
  const g = s.gallerySettings;
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [newGallery, setNewGallery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (g?.isAuthenticated) void window.turbo.gallery.list().then((r) => {
      if (r.ok) useStore.setState({ galleries: r.galleries });
    });
  }, [g?.isAuthenticated]);

  const shoot = activeShoot(s);
  const doneToday = s.transfers.filter((t) => t.status === 'done').length;
  const failed = s.transfers.filter((t) => t.status === 'failed');

  if (!g) return <div className="page"><div className="card muted">Loading…</div></div>;

  if (!g.isAuthenticated) {
    return (
      <div className="page">
        <div className="card" style={{ maxWidth: 460 }}>
          <div className="kicker" style={{ marginBottom: 4 }}>Turbo IQ Gallery</div>
          <div className="h-card" style={{ marginBottom: 16 }}>Sign in</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input label="Username" value={creds.username} autoComplete="username"
              onChange={(e) => setCreds({ ...creds, username: e.target.value })} />
            <Input label="Password" type="password" value={creds.password} autoComplete="current-password"
              onChange={(e) => setCreds({ ...creds, password: e.target.value })} />
            <Button variant="primary" disabled={busy || !creds.username || !creds.password} onClick={async () => {
              setBusy(true);
              const r = await window.turbo.gallery.setCredentials(creds.username, creds.password);
              setBusy(false);
              if (!r.ok) { s.showToast(r.error ?? 'Login failed', 'error'); return; }
              useStore.setState({ gallerySettings: await window.turbo.gallery.getSettings() });
            }}>Sign in</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card carbon" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end' }}>
        <div style={{ flex: 2, minWidth: 260 }}>
          <div className="kicker">Uploading to</div>
          <div className="h-display" style={{ fontSize: 24, margin: '8px 0' }}>
            {shoot?.galleryName ?? g.selectedGalleryName ?? 'No gallery selected'}
          </div>
          {shoot?.galleryName && (
            <div className="kicker" style={{ marginBottom: 4 }}>Set by the active shoot</div>
          )}
          <div style={{ fontSize: 13, color: '#B9B6AF' }}>{g.username}</div>
        </div>
        <div className="stat-strip" style={{ flex: 1, minWidth: 240 }}>
          <div className="stat"><span className="kicker">Today</span><span className="v">{doneToday}</span></div>
          <div className="stat"><span className="kicker">Failed</span>
            <span className="v" style={{ color: failed.length ? 'var(--turbo-red)' : undefined }}>{failed.length}</span></div>
        </div>
        <Button variant="secondary" size="sm" onClick={async () => {
          await window.turbo.gallery.logout();
          useStore.setState({ gallerySettings: await window.turbo.gallery.getSettings() });
        }}>Sign out</Button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className="card">
          <div className="kicker" style={{ marginBottom: 12 }}>Galleries</div>
          <div className="row-list" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {s.galleries.map((gal) => (
              <button key={gal.id} className="row-item" style={{
                cursor: 'pointer', textAlign: 'left', width: '100%',
                border: gal.id === g.selectedGalleryId ? '2px solid var(--turbo-red)' : undefined,
                padding: gal.id === g.selectedGalleryId ? '13px 15px' : undefined,
                fontFamily: 'inherit', fontSize: 'inherit', background: 'var(--admin-surface)',
              }} onClick={async () => {
                await window.turbo.gallery.select(gal.id, gal.name);
                useStore.setState({ gallerySettings: await window.turbo.gallery.getSettings() });
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{gal.name}</div>
                  <div className="kicker" style={{ marginTop: 3 }}>
                    {gal.photo_count} photos{gal.event_date ? ` · ${gal.event_date}` : ''}
                  </div>
                </div>
                {gal.id === g.selectedGalleryId && <Badge tone="danger">Selected</Badge>}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Input label="New gallery name" value={newGallery} onChange={(e) => setNewGallery(e.target.value)} />
            </div>
            <Button variant="secondary" disabled={!newGallery.trim()} onClick={async () => {
              const r = await window.turbo.gallery.create(newGallery.trim());
              if (!r.ok) { s.showToast(r.error ?? 'Create failed', 'error'); return; }
              setNewGallery('');
              const list = await window.turbo.gallery.list();
              if (list.ok) useStore.setState({ galleries: list.galleries });
            }}>Create</Button>
          </div>
        </div>

        <div className="card">
          <div className="kicker" style={{ marginBottom: 6 }}>What gets uploaded</div>
          <SwitchRow title="Auto-upload processed frames" on={g.autoUpload}
            onChange={async (v) => useStore.setState({ gallerySettings: await window.turbo.gallery.setUploadOptions({ autoUpload: v }) })} />
          <SwitchRow title="Portrait 4:5 JPEGs" on={g.uploadPortrait}
            onChange={async (v) => useStore.setState({ gallerySettings: await window.turbo.gallery.setUploadOptions({ uploadPortrait: v }) })} />
          <SwitchRow title="Square 1:1 JPEGs" on={g.uploadSquare}
            onChange={async (v) => useStore.setState({ gallerySettings: await window.turbo.gallery.setUploadOptions({ uploadSquare: v }) })} />
          <SwitchRow title="Transparent PNGs" on={g.uploadTransparent}
            onChange={async (v) => useStore.setState({ gallerySettings: await window.turbo.gallery.setUploadOptions({ uploadTransparent: v }) })} />
        </div>
      </div>

      <div className="card">
        <div className="kicker" style={{ marginBottom: 12 }}>Transfers</div>
        <div className="row-list">
          {s.transfers.length === 0 && <div className="muted" style={{ fontSize: 14 }}>No transfers yet.</div>}
          {[...s.transfers].reverse().slice(0, 40).map((t) => (
            <div className="row-item" key={t.id} style={{ padding: '10px 14px' }}>
              <span className="mono" style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.filename}</span>
              <div className={`bar${t.status === 'done' ? ' green' : t.status === 'failed' ? ' red' : ''}`} style={{ width: 180 }}>
                <span style={{ width: `${t.status === 'done' ? 100 : Math.round(t.pct)}%` }} />
              </div>
              <Badge tone={t.status === 'done' ? 'success' : t.status === 'failed' ? 'danger' : 'info'}>{t.status}</Badge>
              {t.status === 'failed' && (
                <Button size="sm" variant="ghost" onClick={() => window.turbo.gallery.retryTransfer(t.id)}>Retry</Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
