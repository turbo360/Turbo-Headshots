import React, { useEffect, useState } from 'react';
import { useStore, activeShoot, detailShoot } from '../state/store';
import { Badge, Button, StatTile } from '../components/ds';
import { deliveryLabel, usd } from '../meta';

export default function Delivery() {
  const s = useStore();
  const shoot = detailShoot(s) ?? activeShoot(s) ?? s.shoots[0] ?? null;
  const people = shoot
    ? (s.detailShootId === shoot.id ? s.detailPeople : s.people.filter((p) => p.shootId === shoot.id))
    : [];
  const [spend, setSpend] = useState(0);

  useEffect(() => {
    void window.turbo.usage.summary().then((u) => setSpend(u.shootUsd));
  }, [shoot?.id]);

  if (!shoot) {
    return <div className="page"><div className="card muted">No shoot selected — open one from Shoots.</div></div>;
  }

  const approved = people.reduce((n, p) => n + p.frames.filter((f) => f.approved).length, 0);
  const sent = people.filter((p) => p.delivery.status !== 'not-sent' && p.delivery.status !== 'bounced').length;
  const remaining = people.filter((p) => p.delivery.status === 'not-sent').length;

  return (
    <div className="page">
      <div className="grid grid-tiles">
        <StatTile hero label="People shot" value={people.length} />
        <StatTile label="Approved frames" value={approved} />
        <StatTile label="Links sent" value={sent} />
        <StatTile label="AI spend" value={usd(spend)} />
      </div>

      {shoot.galleryShareUrl && (
        <div className="card carbon" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="kicker" style={{ marginBottom: 6 }}>Client gallery link</div>
            <div className="mono" style={{ fontSize: 14, color: 'var(--ignition-amber)', wordBreak: 'break-all' }}>
              {shoot.galleryShareUrl.replace(/^https?:\/\//, '')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button size="sm" variant="secondary" onClick={() => {
              void navigator.clipboard.writeText(shoot.galleryShareUrl!);
              s.showToast('Gallery link copied', 'success');
            }}>Copy link</Button>
            <Button size="sm" variant="primary" disabled={remaining === 0} onClick={async () => {
              const r = await window.turbo.delivery.sendAll(shoot.id);
              const waitNote = r.waiting ? ` · ${r.waiting} waiting for photos` : '';
              s.showToast(r.ok ? `Sent ${r.sent} personal link${r.sent === 1 ? '' : 's'}${waitNote}` : 'Send failed', r.ok ? 'success' : 'error');
            }}>Send {remaining} remaining links</Button>
          </div>
        </div>
      )}

      <div className="row-list">
        {people.length === 0 && <div className="card muted">No people on this shoot yet.</div>}
        {people.map((p) => {
          const del = deliveryLabel(p.delivery.status);
          const picks = p.frames.filter((f) => f.approved).length;
          return (
            <div className="row-item" key={p.id}>
              <span className="mono" style={{ fontSize: 12 }}>{p.shootNumber}</span>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>{p.firstName} {p.lastName}</div>
                <div className="muted" style={{ fontSize: 13 }}>{p.email || 'no email'}</div>
              </div>
              <span className="muted" style={{ fontSize: 13 }}>{picks} picks</span>
              {p.iq?.headshotUrl ? (
                <Button size="sm" variant="ghost" title="Copy their personal photos link"
                  onClick={() => {
                    void navigator.clipboard.writeText(p.iq!.headshotUrl);
                    s.showToast(`Personal link copied for ${p.firstName}`, 'success');
                  }}>
                  Personal link
                </Button>
              ) : (
                <Badge tone="neutral">No delivery</Badge>
              )}
              <Badge tone={del.tone}>{del.label}</Badge>
              <Button size="sm" variant={p.delivery.status === 'not-sent' ? 'primary' : 'ghost'}
                disabled={!p.email}
                onClick={async () => {
                  const r = await window.turbo.delivery.sendLink(p.id);
                  s.showToast(
                    r.ok
                      ? (r.personal ? `Personal photos link emailed to ${p.firstName}` : 'Gallery link draft opened')
                      : (r.error ?? 'Send failed'),
                    r.ok ? 'success' : 'error');
                }}>
                {p.delivery.status === 'not-sent' ? 'Send' : 'Resend'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
