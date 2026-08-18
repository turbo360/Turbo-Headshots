import React from 'react';
import { useStore } from '../state/store';
import { Badge, Button } from '../components/ds';
import { fmtDate, shootStatusTone } from '../meta';

export default function Shoots() {
  const s = useStore();

  const totalPeople = s.shoots.length ? '—' : '0';
  const delivered = s.shoots.filter((x) => x.status === 'delivered').length;

  const open = async (id: string) => {
    useStore.setState({ detailShootId: id });
    const data = await window.turbo.shoots.get(id);
    if (data) useStore.setState({ detailPeople: data.people });
    s.go('shootDetail');
  };

  return (
    <div className="page">
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <div className="stat-strip" style={{ flex: 1, minWidth: 260 }}>
          <div className="stat"><span className="kicker">Shoots</span><span className="v">{s.shoots.length}</span></div>
          <div className="stat"><span className="kicker">Delivered</span><span className="v">{delivered}</span></div>
          <div className="stat"><span className="kicker">Live</span><span className="v">{s.shoots.filter((x) => x.status === 'live').length}</span></div>
        </div>
        <Button variant="primary" onClick={() => useStore.setState({ newShootOpen: true })}>New shoot</Button>
      </div>

      <div className="row-list">
        {s.shoots.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div className="h-section" style={{ marginBottom: 8 }}>No shoots yet</div>
            <div className="muted" style={{ marginBottom: 16 }}>
              Create your first shoot — it provisions the Turbo IQ gallery and check-in link at the same time.
            </div>
            <Button variant="primary" onClick={() => useStore.setState({ newShootOpen: true })}>New shoot</Button>
          </div>
        )}
        {s.shoots.map((shoot) => {
          const isActive = s.appSettings?.activeShootId === shoot.id;
          return (
            <div className="row-item" key={shoot.id}>
              <div style={{ minWidth: 220, flex: 1 }}>
                <div className="kicker">{fmtDate(shoot.date || shoot.createdAt)}</div>
                <div style={{ fontSize: 16.5, fontWeight: 600, marginTop: 2 }}>{shoot.name}</div>
                <div className="muted" style={{ fontSize: 14 }}>{shoot.client || '—'}</div>
              </div>
              <div className="stat-strip" style={{ flex: 1, minWidth: 220, gap: 12 }}>
                <div className="stat"><span className="kicker">Status</span>
                  <Badge tone={shootStatusTone(shoot.status)}>{isActive ? 'Live · active' : shoot.status}</Badge>
                </div>
                <div className="stat"><span className="kicker">Gallery</span>
                  <span style={{ fontSize: 13 }} className="ink2">{shoot.galleryName ?? 'None'}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!isActive && (
                  <Button size="sm" variant="ghost" onClick={async () => {
                    await window.turbo.shoots.setActive(shoot.id);
                  }}>Make active</Button>
                )}
                <Button size="sm" variant="ghost" style={{ color: 'var(--status-danger)' }}
                  onClick={async () => {
                    const r = await window.turbo.shoots.remove(shoot.id);
                    if (r.ok) s.showToast('Shoot deleted (photos on disk kept)', 'success');
                  }}>Delete</Button>
                <Button size="sm" variant="secondary" onClick={() => open(shoot.id)}>Open</Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
