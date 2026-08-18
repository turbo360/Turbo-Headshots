import React, { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { Badge, Button } from '../components/ds';

function Elapsed({ since }: { since: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return <>—</>;
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</>;
}

export default function Capture() {
  const s = useStore();
  const person = s.people.find((p) => p.id === s.session.personId) ?? null;
  const nextWaiting = s.checkin.entries[0] ?? null;

  const endToReview = async () => {
    if (person) useStore.setState({ reviewPersonId: person.id });
    await window.turbo.session.end();
    s.go('review');
  };
  const endSkip = async () => {
    await window.turbo.session.end();
    s.go('checkin');
  };

  return (
    <div className="page">
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 340px)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            position: 'relative', background: 'var(--admin-carbon)', borderRadius: 14,
            minHeight: 420, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {s.lastFrame ? (
              <img src={s.lastFrame.previewUrl} alt=""
                style={{ maxWidth: '100%', maxHeight: 640, objectFit: 'contain', display: 'block' }} />
            ) : (
              <div style={{ color: '#55555C', fontSize: 15 }}>
                Waiting for the first frame from LUMIX Tether…
              </div>
            )}

            {/* framing overlay */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              <div style={{
                position: 'absolute', top: '4%', bottom: '4%', left: '50%', transform: 'translateX(-50%)',
                aspectRatio: '4 / 5', border: '1px solid rgba(191,33,47,0.85)', borderRadius: 2,
              }}>
                <div style={{ position: 'absolute', top: '16%', left: 0, right: 0, borderTop: '1px dashed rgba(242,169,0,0.9)' }} />
                <div style={{ position: 'absolute', top: '62%', left: 0, right: 0, borderTop: '1px solid rgba(15,163,163,0.7)' }} />
                <span className="mono" style={{
                  position: 'absolute', bottom: 6, right: 8, fontSize: 10, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.75)',
                }}>4:5 SAFE</span>
              </div>
            </div>

            <div style={{
              position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 8,
              background: !s.session.active && s.lastFrame ? 'rgba(220,38,38,0.92)' : 'rgba(10,10,11,0.55)',
              backdropFilter: 'blur(6px)', borderRadius: 999,
              padding: '6px 14px',
            }}>
              <span className={`live-dot${s.session.active ? ' red' : ''}`} />
              <span className="mono" style={{ fontSize: 11, letterSpacing: '0.12em', color: '#fff', fontWeight: 700 }}>
                {s.session.active
                  ? `TETHERED${s.lastFrame?.baseName ? ` · ${s.lastFrame.baseName}` : ''}`
                  : s.lastFrame
                    ? 'NOT RECORDING — frames arriving with no subject. Start a session.'
                    : 'IDLE'}
              </span>
            </div>
          </div>

          <div className="card" style={{ padding: '14px 18px' }}>
            <div className="kicker" style={{ marginBottom: 10 }}>
              This subject · {s.session.frameCount} frames
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(68px, 1fr))', gap: 8 }}>
              {s.sessionFrames.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No frames yet.</div>}
              {s.sessionFrames.map((f, i) => (
                <div key={f.baseName + i} className={`thumb${i === s.sessionFrames.length - 1 ? ' current' : ''}`}>
                  <img src={f.previewUrl} alt="" loading="lazy" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card carbon">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="kicker mono">{s.session.shootNumber ?? '—'}</span>
              {s.session.active && <Badge tone="danger">Rolling</Badge>}
            </div>
            <div className="h-display" style={{ fontSize: 22, margin: '10px 0 6px' }}>
              {s.session.personName ?? 'No subject'}
            </div>
            {person && (
              <div style={{ fontSize: 13, color: '#B9B6AF' }}>
                {person.email}{person.company ? ` · ${person.company}` : ''}
              </div>
            )}
            <div className="stat-strip" style={{ marginTop: 16 }}>
              <div className="stat"><span className="kicker">On set</span>
                <span className="v mono" style={{ fontSize: 18 }}><Elapsed since={s.session.startedAt} /></span></div>
              <div className="stat"><span className="kicker">Frames</span>
                <span className="v" style={{ fontSize: 18 }}>{s.session.frameCount}</span></div>
            </div>
          </div>

          {nextWaiting && (
            <div className="card" style={{ padding: '14px 18px' }}>
              <div className="kicker" style={{ marginBottom: 6 }}>Up next</div>
              <div style={{ fontWeight: 600 }}>{nextWaiting.name}</div>
              <div className="muted" style={{ fontSize: 13 }}>{nextWaiting.email}</div>
            </div>
          )}

          <Button variant="primary" size="lg" disabled={!s.session.active} onClick={endToReview}>
            End & review {s.session.frameCount} frames
          </Button>
          <Button variant="secondary" disabled={!s.session.active} onClick={endSkip}>
            End & skip review
          </Button>
        </div>
      </div>
    </div>
  );
}
