import React, { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { Badge, Button, Input, SwitchRow } from '../components/ds';

export default function NewShootModal() {
  const s = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    name: '', client: '', date: today, location: '',
    galleryMode: 'create' as 'create' | 'link',
    galleryName: '', galleryId: '',
    autoUpload: true,
    engineMode: 'replicate' as 'replicate' | 'local' | 'composite',
  });
  const [busy, setBusy] = useState(false);

  const galleryAuthed = s.gallerySettings?.isAuthenticated ?? false;

  useEffect(() => {
    if (galleryAuthed && s.galleries.length === 0) {
      void window.turbo.gallery.list().then((r) => { if (r.ok) useStore.setState({ galleries: r.galleries }); });
    }
  }, [galleryAuthed, s.galleries.length]);

  const canCreate = form.name.trim().length > 0 && !busy
    && (form.galleryMode === 'create' || form.galleryId || !galleryAuthed);

  const create = async () => {
    setBusy(true);
    try {
      const r = await window.turbo.shoots.create({
        name: form.name.trim(),
        client: form.client.trim(),
        date: form.date,
        location: form.location.trim(),
        galleryMode: form.galleryMode,
        galleryName: form.galleryName.trim() || form.name.trim(),
        galleryId: form.galleryId || undefined,
        autoUpload: form.autoUpload,
        engineMode: form.engineMode,
      });
      if (!r.ok) { s.showToast(r.error ?? 'Could not create shoot', 'error'); return; }
      useStore.setState({ newShootOpen: false });
      s.showToast(`Shoot created${r.shoot?.galleryName ? ` · gallery "${r.shoot.galleryName}"` : ''}`, 'success');
      s.go('checkin');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay z-newshoot" onClick={(e) => { if (e.target === e.currentTarget) useStore.setState({ newShootOpen: false }); }}>
      <div className="sheet" style={{ padding: '24px 28px', width: 'min(720px, 94vw)' }}>
        <div className="kicker">New shoot · creates a Turbo IQ gallery</div>
        <div className="h-card" style={{ margin: '4px 0 18px' }}>Set up the day</div>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Input label="Shoot name" value={form.name} autoFocus placeholder="Northline Corporate Headshots"
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Client" value={form.client}
            onChange={(e) => setForm({ ...form, client: e.target.value })} />
          <Input label="Date" type="date" value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <Input label="Location" value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </div>

        <div className="kicker" style={{ margin: '20px 0 10px' }}>Processing pipeline</div>
        <div style={{ display: 'flex', gap: 10 }}>
          {([
            {
              id: 'replicate' as const, label: 'Replicate',
              desc: 'Everything in the cloud. Nano Banana studio re-light + re-stage, cloud masks & cutouts. Highest polish — rescues rough capture lighting. ~$0.31 per render.',
            },
            {
              id: 'local' as const, label: 'Hybrid Local',
              desc: 'Nano Banana re-light in the cloud; masks & cutouts run on this Mac. Same premium look, faster per render. ~$0.30 per render.',
            },
            {
              id: 'composite' as const, label: 'Fully Local',
              desc: 'No AI re-render — your real pixels, colour corrected and composited onto a clean studio backdrop. Instant, free, zero identity risk. Needs good capture lighting.',
            },
          ]).map((m) => (
            <button key={m.id} className={`pick-card${form.engineMode === m.id ? ' on' : ''}`}
              style={{ flex: 1, padding: form.engineMode === m.id ? 11 : 12 }}
              onClick={() => setForm({ ...form, engineMode: m.id })}>
              {form.engineMode === m.id && <span className="on-tag">ON</span>}
              <span style={{ fontWeight: 700 }}>{m.label}</span>
              <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}>{m.desc}</span>
            </button>
          ))}
        </div>

        <div className="kicker" style={{ margin: '20px 0 10px' }}>Turbo IQ gallery</div>
        {!galleryAuthed && (
          <div className="muted" style={{ fontSize: 13.5, marginBottom: 8 }}>
            Not signed in to Turbo IQ — the shoot will be created without a gallery or check-in link.
            Sign in under Gallery Upload first for the full flow.
          </div>
        )}
        {galleryAuthed && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              {(['create', 'link'] as const).map((m) => (
                <button key={m} className={`pick-card${form.galleryMode === m ? ' on' : ''}`}
                  style={{ flex: 1, padding: form.galleryMode === m ? 11 : 12 }}
                  onClick={() => setForm({ ...form, galleryMode: m })}>
                  {m === 'create' ? 'Create new gallery' : 'Link existing gallery'}
                </button>
              ))}
            </div>
            {form.galleryMode === 'create' ? (
              <Input label="Gallery name" placeholder="defaults to the shoot name" value={form.galleryName}
                onChange={(e) => setForm({ ...form, galleryName: e.target.value })} />
            ) : (
              <div className="row-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
                {s.galleries.map((g) => (
                  <button key={g.id} className="row-item" style={{
                    cursor: 'pointer', width: '100%', textAlign: 'left', fontFamily: 'inherit',
                    background: 'var(--admin-surface)',
                    border: form.galleryId === g.id ? '2px solid var(--turbo-red)' : undefined,
                    padding: form.galleryId === g.id ? '13px 15px' : undefined,
                  }} onClick={() => setForm({ ...form, galleryId: g.id })}>
                    <span style={{ fontWeight: 600, flex: 1 }}>{g.name}</span>
                    <span className="kicker">{g.photo_count} photos{g.event_date ? ` · ${g.event_date}` : ''}</span>
                    {form.galleryId === g.id && <Badge tone="danger">Linked</Badge>}
                  </button>
                ))}
              </div>
            )}
            <SwitchRow title="Auto-upload processed frames" on={form.autoUpload}
              onChange={(v) => setForm({ ...form, autoUpload: v })} />
          </>
        )}

        <hr className="hairline" style={{ margin: '16px 0 14px' }} />
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => useStore.setState({ newShootOpen: false })}>Cancel</Button>
          <Button variant="primary" disabled={!canCreate} onClick={create}>
            {galleryAuthed ? 'Create shoot & gallery' : 'Create shoot'}
          </Button>
        </div>
      </div>
    </div>
  );
}
