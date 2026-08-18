import React, { useEffect, useState } from 'react';
import { useStore, activeShoot } from '../state/store';
import { Button, Input, StatTile } from '../components/ds';

export default function CheckIn() {
  const s = useStore();
  const shoot = activeShoot(s);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', mobile: '', company: '' });
  const [busy, setBusy] = useState(false);

  const canStart = !!shoot && form.firstName.trim() && form.lastName.trim() && !busy;

  const start = async () => {
    if (!canStart || !shoot) return;
    setBusy(true);
    try {
      const res = await window.turbo.people.create({ ...form, shootId: shoot.id });
      if (!res.ok || !res.person) {
        s.showToast(res.error ?? 'Could not create person', 'error');
        return;
      }
      await window.turbo.session.start(res.person.id);
      setForm({ firstName: '', lastName: '', email: '', mobile: '', company: '' });
      s.go('capture');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const st = useStore.getState();
      if (e.key === 'Enter' && !s.session.active && canStart
          && !(el && (el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA'))
          && !st.qrOpen && !st.newShootOpen && !st.dispatchTarget) {
        e.preventDefault();
        void start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStart, s.session.active, form]);

  const peopleToday = s.people.length;
  const framesToday = s.people.reduce((n, p) => n + p.frames.length, 0);

  const waitedMins = (createdAt: string) =>
    Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60000));

  return (
    <div className="page">
      <div className="grid grid-tiles">
        <StatTile hero label="People today" value={peopleToday} />
        <StatTile label="Frames captured" value={framesToday} />
        <StatTile label="Waiting" value={s.checkin.entries.length} />
        <StatTile label="Avg per person" value={peopleToday ? Math.round(framesToday / peopleToday) : 0} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <div className="card">
          <div className="kicker" style={{ marginBottom: 4 }}>01 / Register</div>
          <div className="h-card" style={{ marginBottom: 16 }}>Next subject</div>
          {!shoot && (
            <div className="muted" style={{ marginBottom: 14 }}>
              No active shoot — create or activate one first.
            </div>
          )}
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Input label="First name" value={form.firstName} autoFocus
              onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            <Input label="Last name" value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            <Input label="Email" type="email" value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input label="Mobile" value={form.mobile}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
          </div>
          <div style={{ marginTop: 14 }}>
            <Input label="Company" value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </div>
          <Button variant="primary" size="lg" style={{ width: '100%', marginTop: 18 }}
            disabled={!canStart} onClick={start}>
            Start session & go to capture
          </Button>
          <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.1em', marginTop: 12, textAlign: 'center' }}>
            ⏎ START · ESC END SESSION
          </div>
        </div>

        <div className="card carbon">
          <div className="kicker" style={{ marginBottom: 4 }}>02 / Self check-in</div>
          <div className="h-display" style={{ fontSize: 22, marginBottom: 16 }}>They type. You shoot.</div>

          {s.checkin.available && s.checkin.url ? (
            <>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ background: '#fff', borderRadius: 10, padding: 10, display: 'inline-flex' }}>
                  <QrBlock url={s.checkin.url} size={120} />
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 14, color: '#B9B6AF', marginBottom: 8 }}>
                    Subjects scan the QR on their phone, type their details, and appear in the queue below.
                  </div>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--ignition-amber)', wordBreak: 'break-all' }}>
                    {s.checkin.url.replace(/^https?:\/\//, '')}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <Button size="sm" variant="secondary" onClick={() => useStore.setState({ qrOpen: true })}>Show fullscreen</Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  void navigator.clipboard.writeText(s.checkin.url!);
                  s.showToast('Check-in link copied', 'success');
                }}>Copy link</Button>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 14, color: '#B9B6AF' }}>
              {shoot ? 'Check-in service unavailable — register subjects manually.' : 'Create a shoot to get its check-in QR.'}
            </div>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid #222226', margin: '18px 0 12px' }} />
          <div className="kicker" style={{ marginBottom: 10 }}>
            Checked in · waiting ({s.checkin.entries.length})
          </div>
          <div className="row-list">
            {s.checkin.entries.length === 0 && (
              <div style={{ fontSize: 13, color: '#55555C' }}>No one waiting.</div>
            )}
            {s.checkin.entries.map((e) => (
              <div key={e.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: 'rgba(255,255,255,0.04)', border: '1px solid #222226',
                borderRadius: 10, padding: '10px 14px',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{e.name}</div>
                  <div style={{ fontSize: 12.5, color: '#B9B6AF', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.email}{e.mobile ? ` · ${e.mobile}` : ''}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: '#B9B6AF' }}>{waitedMins(e.createdAt)}M</span>
                <Button size="sm" variant="primary" onClick={async () => {
                  const res = await window.turbo.checkin.claimEntry(e.id);
                  if (res.ok && res.person) {
                    await window.turbo.session.start(res.person.id);
                    s.go('capture');
                  } else {
                    s.showToast(res.error ?? 'Entry already claimed', 'error');
                  }
                }}>Use</Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function QrBlock({ url, size }: { url: string; size: number }) {
  const [El, setEl] = useState<React.ComponentType<{ value: string; size: number }> | null>(null);
  useEffect(() => {
    void import('qrcode.react').then((m) => setEl(() => m.QRCodeSVG as never));
  }, []);
  if (!El) return <div style={{ width: size, height: size }} />;
  return <El value={url} size={size} />;
}
