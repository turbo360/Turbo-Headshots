import React, { useEffect, useMemo, useState } from 'react';
import { useStore, activeShoot } from '../state/store';
import { Badge, Button } from '../components/ds';
import { mediaUrl } from '../media';
import { usd } from '../meta';

export default function Review() {
  const s = useStore();
  const shoot = activeShoot(s);
  const pool = s.reviewPersonId
    ? [...s.people, ...s.detailPeople].find((p) => p.id === s.reviewPersonId) ?? null
    : null;
  // Fall back to most recent person with frames on the active shoot.
  const person = pool ?? [...s.people].reverse().find((p) => p.frames.length > 0) ?? null;

  const approvedCount = person ? person.frames.filter((f) => f.approved).length : 0;
  const [est, setEst] = useState<{ perFrame: number; total: number }>({ perFrame: 0, total: 0 });

  const opts = person && shoot ? shoot.defaults : s.dispatchOpts;

  useEffect(() => {
    let live = true;
    void window.turbo.batches.estimate(approvedCount, opts).then((e) => { if (live) setEst(e); });
    return () => { live = false; };
  }, [approvedCount, opts]);

  const toggle = async (baseName: string, approved: boolean) => {
    if (!person) return;
    await window.turbo.review.setApproved(person.id, baseName, approved);
  };

  const clearPicks = async () => {
    if (!person) return;
    for (const f of person.frames.filter((x) => x.approved)) {
      await window.turbo.review.setApproved(person.id, f.baseName, false);
    }
  };

  const send = () => {
    if (!person || approvedCount === 0) return;
    useStore.setState({
      dispatchTarget: {
        shootId: person.shootId,
        personId: person.id,
        personName: `${person.firstName} ${person.lastName}`,
        files: person.frames.filter((f) => f.approved).map((f) => f.baseName),
      },
      dispatchOpts: opts,
    });
  };

  if (!person) {
    return (
      <div className="page">
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div className="h-section" style={{ marginBottom: 8 }}>Nothing to review</div>
          <div className="muted">Capture some frames first — they land here for cull &amp; approve.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="kicker mono">{person.shootNumber}</div>
          <div className="h-card" style={{ marginTop: 2 }}>{person.firstName} {person.lastName}</div>
        </div>
        <div className="stat-strip" style={{ flex: 1, minWidth: 280 }}>
          <div className="stat"><span className="kicker">Captured</span><span className="v">{person.frames.length}</span></div>
          <div className="stat"><span className="kicker">Approved</span>
            <span className="v" style={{ color: 'var(--turbo-red)' }}>{approvedCount}</span></div>
          <div className="stat"><span className="kicker">Est. AI cost</span>
            <span className="v" style={{ fontSize: 18 }}>{usd(est.total)}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="ghost" onClick={clearPicks} disabled={approvedCount === 0}>Clear picks</Button>
          <Button variant="primary" onClick={send} disabled={approvedCount === 0}>
            Send approved to pipeline
          </Button>
        </div>
      </div>

      <div className="grid grid-frames">
        {person.frames.map((f) => {
          const src = f.jpegFile ?? f.file;
          return (
            <div className="card" key={f.baseName} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="thumb">
                <img src={mediaUrl(src, 480)} alt={f.baseName} loading="lazy" />
                {f.quality && (
                  <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6 }}>
                    {!f.quality.eyesOpen && <Badge tone="warning">Eyes?</Badge>}
                    {f.quality.recommendation === 'review' && f.quality.eyesOpen && <Badge tone="warning">Check</Badge>}
                    {f.quality.recommendation === 'use' && <Badge tone="success">Sharp</Badge>}
                  </div>
                )}
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--admin-ink-2)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {f.baseName}
              </div>
              <Button
                variant={f.approved ? 'dark' : 'secondary'}
                size="sm"
                onClick={() => toggle(f.baseName, !f.approved)}
              >
                {f.approved ? 'Approved ✓' : 'Approve'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
