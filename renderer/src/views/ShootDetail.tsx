import React, { useState } from 'react';
import { useStore, detailShoot } from '../state/store';
import { Badge, Button } from '../components/ds';
import { deliveryLabel, fmtDate, optsSummary } from '../meta';

export default function ShootDetail() {
  const s = useStore();
  const shoot = detailShoot(s);
  if (!shoot) {
    return <div className="page"><div className="card">Shoot not found. <Button size="sm" variant="ghost" onClick={() => s.go('shoots')}>All shoots</Button></div></div>;
  }

  const people = s.detailPeople;
  const frames = people.reduce((n, p) => n + p.frames.length, 0);
  const deliveredCount = people.filter((p) => p.delivery.status === 'link-sent' || p.delivery.status === 'opened').length;
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shownPeople = q
    ? people.filter((p) =>
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(q)
        || (p.shootNumber ?? '').toLowerCase().includes(q)
        || (p.email ?? '').toLowerCase().includes(q))
    : people;

  const reprocess = (personId: string | null, personName: string, files: string[], shootNumber = '') => {
    useStore.setState({
      dispatchTarget: { shootId: shoot.id, personId, personName, files },
      dispatchOpts: shoot.defaults,
    });
  };

  return (
    <div className="page">
      <div className="card carbon" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-end' }}>
        <div style={{ flex: 2, minWidth: 280 }}>
          <div className="kicker">{fmtDate(shoot.date || shoot.createdAt)}{shoot.location ? ` · ${shoot.location.toUpperCase()}` : ''}</div>
          <div className="h-display" style={{ fontSize: 30, margin: '8px 0 10px' }}>{shoot.name}</div>
          <div style={{ fontSize: 14, color: '#B9B6AF' }}>{optsSummary(shoot.defaults)}</div>
        </div>
        <div className="stat-strip" style={{ flex: 2, minWidth: 300 }}>
          <div className="stat"><span className="kicker">People</span><span className="v">{people.length}</span></div>
          <div className="stat"><span className="kicker">Frames</span><span className="v">{frames}</span></div>
          <div className="stat"><span className="kicker">Delivered</span><span className="v">{deliveredCount}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => s.go('shoots')}>All shoots</Button>
          <Button variant="ghost" onClick={async () => {
            const r = await window.turbo.shoots.remove(shoot.id);
            if (r.ok) {
              s.showToast('Shoot deleted (photos on disk kept)', 'success');
              s.go('shoots');
            }
          }}>Delete shoot</Button>
          <Button
            variant="primary"
            disabled={frames === 0}
            onClick={() => reprocess(null, shoot.name, people.flatMap((p) => p.frames.map((f) => f.baseName)))}
          >
            Reprocess whole shoot
          </Button>
        </div>
      </div>

      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people — name, number or email…"
          style={{
            flex: 1, minWidth: 200, background: 'var(--admin-surface)',
            border: '1px solid var(--admin-border)', borderRadius: 8,
            padding: '9px 12px', fontSize: 14, fontFamily: 'var(--font-body)',
          }}
        />
        {query && <Button size="sm" variant="ghost" onClick={() => setQuery('')}>Clear</Button>}
        <Button size="sm" variant="primary" onClick={async () => {
          // Register a new subject on this shoot: activate it and jump to
          // Capture, where the registration form lives.
          await window.turbo.shoots.setActive(shoot.id);
          s.go('capture');
        }}>Add person</Button>
      </div>

      <div className="row-list">
        {people.length === 0 && <div className="card muted">No people checked in on this shoot yet.</div>}
        {people.length > 0 && shownPeople.length === 0 && (
          <div className="card muted">No one matches “{query}”.</div>
        )}
        {shownPeople.map((p) => {
          const picks = p.frames.filter((f) => f.approved).length;
          const del = deliveryLabel(p.delivery.status);
          return (
            <div className="row-item" key={p.id}>
              <div style={{ minWidth: 220, flex: 1 }}>
                <div className="kicker mono">{p.shootNumber}</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>{p.firstName} {p.lastName}</div>
                <div className="muted" style={{ fontSize: 13 }}>{p.email}{p.mobile ? ` · ${p.mobile}` : ''}</div>
              </div>
              <div className="stat-strip" style={{ flex: 1, minWidth: 220, gap: 12 }}>
                <div className="stat"><span className="kicker">Frames</span><span className="v" style={{ fontSize: 18 }}>{p.frames.length}</span></div>
                <div className="stat"><span className="kicker">Picks</span><span className="v" style={{ fontSize: 18 }}>{picks}</span></div>
              </div>
              <Badge tone={del.tone}>{del.label}</Badge>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" variant="ghost" onClick={() => {
                  useStore.setState({ reviewPersonId: p.id });
                  s.go('review');
                }}>Review</Button>
                <Button
                  size="sm" variant="secondary"
                  disabled={p.frames.length === 0}
                  onClick={() => reprocess(p.id, `${p.firstName} ${p.lastName}`, p.frames.map((f) => f.baseName), p.shootNumber)}
                >
                  Reprocess
                </Button>
                <Button size="sm" variant="dark" onClick={async () => {
                  // Re-open this subject: activates the shoot and resumes their
                  // session — new captures continue their numbering.
                  await window.turbo.session.start(p.id);
                  s.go('capture');
                }}>
                  Continue shooting
                </Button>
                <Button size="sm" variant="ghost" style={{ color: 'var(--status-danger)' }}
                  onClick={async () => {
                    const r = await window.turbo.people.remove(p.id);
                    if (r.ok) s.showToast('Subject deleted (photos on disk kept)', 'success');
                  }}>
                  Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
