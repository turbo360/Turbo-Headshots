import React from 'react';
import { useStore } from '../state/store';
import { Badge, Button } from '../components/ds';
import { batchStatusTone, optsSummary, usd } from '../meta';

export default function Processing() {
  const s = useStore();
  const p = s.processing;
  const held = s.batches.filter((b) => b.status === 'held');
  const active = s.batches.filter((b) => b.status === 'processing' || b.status === 'queued');

  return (
    <div className="page">
      <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
        <div className="stat-strip" style={{ flex: 1, minWidth: 320 }}>
          <div className="stat"><span className="kicker">Held batches</span><span className="v">{held.length}</span></div>
          <div className="stat"><span className="kicker">Processing</span><span className="v">{p?.processing ?? 0}</span></div>
          <div className="stat"><span className="kicker">Queued</span><span className="v">{p?.pending ?? 0}</span></div>
          <div className="stat"><span className="kicker">Done today</span><span className="v">{p?.completedToday ?? 0}</span></div>
          <div className="stat"><span className="kicker">Spend</span><span className="v" style={{ fontSize: 18 }}>{usd(p?.spendTodayUsd ?? 0)}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="ghost" onClick={() => (p?.paused ? window.turbo.processing.resume() : window.turbo.processing.pause())}>
            {p?.paused ? 'Resume engine' : 'Pause engine'}
          </Button>
          <Button variant="primary" disabled={held.length === 0} onClick={() => window.turbo.batches.startAllHeld()}>
            Start all held
          </Button>
        </div>
      </div>

      {p?.paused && p.pausedReason === 'offline' && (
        <div className="card" style={{ borderColor: 'var(--status-warning)', display: 'flex', gap: 12, alignItems: 'center' }}>
          <Badge tone="warning">Offline</Badge>
          <span className="muted" style={{ fontSize: 14 }}>
            No internet — the engine paused itself and will resume automatically when the connection returns. Nothing is lost.
          </span>
        </div>
      )}

      {(p?.failed ?? 0) > 0 && (
        <div className="card" style={{ borderColor: 'var(--status-danger)', display: 'flex', gap: 14, alignItems: 'center' }}>
          <Badge tone="danger">{p!.failed} failed</Badge>
          <span className="muted" style={{ flex: 1, fontSize: 14 }}>Renders that exhausted their retries.</span>
          <Button size="sm" variant="secondary" onClick={() => window.turbo.processing.retryFailed()}>Retry failed</Button>
          <Button size="sm" variant="ghost" onClick={() => window.turbo.processing.clearCompleted()}>Clear completed</Button>
        </div>
      )}

      <div className="card">
        <div className="kicker" style={{ marginBottom: 12 }}>Held · waiting for you to start</div>
        <div className="row-list">
          {held.length === 0 && <div className="muted" style={{ fontSize: 14 }}>No held batches.</div>}
          {held.map((b) => (
            <div className="row-item" key={b.id}>
              <span className="mono" style={{ fontSize: 12 }}>{b.shootNumber || '—'}</span>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>{b.personName}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {b.files.length} frames · {optsSummary(b.opts)}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 13 }}>{usd(b.estimateUsd)}</span>
              <Badge tone="warning">Held</Badge>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="sm" variant="ghost" onClick={() => useStore.setState({
                  dispatchTarget: {
                    shootId: b.shootId, personId: b.personId, personName: b.personName,
                    files: b.files, batchId: b.id,
                  },
                  dispatchOpts: b.opts,
                })}>Edit settings</Button>
                <Button size="sm" variant="secondary" onClick={() => window.turbo.batches.start(b.id)}>Start</Button>
                <Button size="sm" variant="ghost" style={{ color: 'var(--status-danger)' }}
                  onClick={() => window.turbo.batches.remove(b.id)}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="kicker" style={{ marginBottom: 12 }}>
          Now processing · {s.aiSettings?.workerCount ?? 4} workers{p?.paused ? ' · PAUSED' : ''}
        </div>
        <div className="row-list">
          {(!p || p.workers.length === 0) && <div className="muted" style={{ fontSize: 14 }}>Engine idle.</div>}
          {p?.workers.map((w) => (
            <div className="row-item" key={w.lane} style={{ alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{w.lane}</span>
              <div style={{ flex: 2, minWidth: 220 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <span className="mono" style={{ fontSize: 13 }}>{w.file}</span>
                  <span className="muted" style={{ fontSize: 13 }}>{w.person}</span>
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{w.stageLabel}</div>
                <div className={`bar${w.tone === 'success' ? ' green' : w.tone === 'warning' ? ' amber' : w.tone === 'danger' ? ' red' : ''}`}
                  style={{ marginTop: 8 }}>
                  <span style={{ width: `${Math.round(w.pct)}%` }} />
                </div>
              </div>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {Math.floor(w.elapsedMs / 60000)}:{String(Math.floor((w.elapsedMs % 60000) / 1000)).padStart(2, '0')}
              </span>
              <Badge tone={w.tone}>{w.status}</Badge>
            </div>
          ))}
        </div>
      </div>

      {active.length > 0 && (
        <div className="card">
          <div className="kicker" style={{ marginBottom: 12 }}>Batches in flight</div>
          <div className="row-list">
            {active.map((b) => (
              <div className="row-item" key={b.id} style={{ padding: '10px 14px' }}>
                <span style={{ fontWeight: 600 }}>{b.personName}</span>
                <span className="muted" style={{ fontSize: 13, flex: 1 }}>
                  {b.doneCount}/{b.totalRenders} renders{b.failedCount ? ` · ${b.failedCount} failed` : ''}
                </span>
                <div className="bar" style={{ width: 160 }}>
                  <span style={{ width: `${b.totalRenders ? Math.round((b.doneCount / b.totalRenders) * 100) : 0}%` }} />
                </div>
                <Badge tone={batchStatusTone(b.status)}>{b.status}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: '14px 18px' }}>
        <div className="kicker" style={{ marginBottom: 10 }}>Engine log</div>
        <div className="mono" style={{
          fontSize: 12, lineHeight: 1.7, maxHeight: 200, overflowY: 'auto',
          display: 'flex', flexDirection: 'column-reverse',
        }}>
          <div>
            {s.logLines.slice(-60).map((l, i) => (
              <div key={i} style={{
                color: l.type === 'error' ? 'var(--status-danger)'
                  : l.type === 'warning' ? 'var(--pill-warning-fg, #92400E)' : 'var(--admin-ink-2)',
              }}>
                {l.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
