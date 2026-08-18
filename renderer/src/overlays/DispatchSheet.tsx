import React, { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { Button, SwitchRow } from '../components/ds';
import { BACKDROPS, FRAMINGS, usd } from '../meta';
import type { BackdropId } from '../types';

export default function DispatchSheet() {
  const s = useStore();
  const target = s.dispatchTarget!;
  const opts = s.dispatchOpts;
  const [est, setEst] = useState({ perFrame: 0, total: 0 });
  const [busy, setBusy] = useState(false);

  const count = target.files.length;
  const versions = opts.backdrops.length;
  const ai = s.aiSettings;
  const engineOn = !!(ai?.processingEnabled && ai?.hasApiKey && ai?.preset !== 'natural');

  useEffect(() => {
    let live = true;
    void window.turbo.batches.estimate(count, opts).then((e) => { if (live) setEst(e); });
    return () => { live = false; };
  }, [count, opts]);

  const toggleBackdrop = (id: BackdropId) => {
    const has = opts.backdrops.includes(id);
    if (has && opts.backdrops.length === 1) return; // at least one stays selected
    useStore.setState({
      dispatchOpts: {
        ...opts,
        backdrops: has ? opts.backdrops.filter((b) => b !== id) : [...opts.backdrops, id],
      },
    });
  };

  const patch = (p: Partial<typeof opts>) => useStore.setState({ dispatchOpts: { ...opts, ...p } });

  const outputs = [opts.portrait && '4:5', opts.square && '1:1', opts.cutout && 'TP PNG', opts.print8k && '8K']
    .filter(Boolean).join(' · ');

  const queue = async (hold: boolean) => {
    setBusy(true);
    try {
      if (target.batchId) {
        await window.turbo.batches.updateOpts(target.batchId, opts);
        if (!hold) await window.turbo.batches.start(target.batchId);
      } else {
        const r = await window.turbo.batches.create({
          shootId: target.shootId, personId: target.personId, files: target.files, opts, hold,
        });
        if (!r.ok) { s.showToast('Could not create batch', 'error'); return; }
      }
      useStore.setState({ dispatchTarget: null });
      s.go('processing');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay z-dispatch" onClick={(e) => { if (e.target === e.currentTarget) useStore.setState({ dispatchTarget: null }); }}>
      <div className="sheet" style={{ padding: '24px 28px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'baseline', marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="kicker">Send to pipeline · {count} {target.batchId ? 'frames (held batch)' : 'approved frames'}</div>
            <div className="h-card" style={{ marginTop: 4 }}>How should the engine treat these?</div>
            <div className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>{target.personName}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="kicker">Batch estimate</div>
            <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{engineOn ? usd(est.total) : '$0.00'}</div>
            <div className="muted mono" style={{ fontSize: 11.5 }}>
              {engineOn ? `${usd(est.perFrame)} / frame` : 'local pipeline'}
            </div>
          </div>
        </div>

        {!engineOn && (
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 10,
            background: 'var(--pill-warning-bg, #FEF3C7)', color: 'var(--pill-warning-fg, #92400E)', fontSize: 13.5,
          }}>
            AI engine is off ({!ai?.hasApiKey ? 'no Replicate key' : ai?.preset === 'natural' ? 'Natural preset' : 'processing disabled'}) —
            frames get the local pipeline only: colour-corrected crops, backdrops ignored, $0.
          </div>
        )}
        <div className="kicker" style={{ margin: '18px 0 10px' }}>Backdrop · pick any</div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          {BACKDROPS.map((b) => {
            const on = opts.backdrops.includes(b.id);
            return (
              <button key={b.id} className={`pick-card${on ? ' on' : ''}`} onClick={() => toggleBackdrop(b.id)}>
                {on && <span className="on-tag">ON</span>}
                <span className="swatch" style={{ background: b.swatch }} />
                <span>{b.label}</span>
                <span className="kicker" style={{ fontSize: 9 }}>{b.group}</span>
              </button>
            );
          })}
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          {versions} backdrop{versions > 1 ? 's' : ''} · {versions} version{versions > 1 ? 's' : ''} of every approved frame
          {' '}({count * versions} render{count * versions !== 1 ? 's' : ''})
        </div>

        <div className="kicker" style={{ margin: '20px 0 10px' }}>Framing</div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          {FRAMINGS.map((f) => (
            <button key={f.id} className={`pick-card${opts.framing === f.id ? ' on' : ''}`}
              onClick={() => patch({ framing: f.id })}>
              {opts.framing === f.id && <span className="on-tag">ON</span>}
              <span>{f.label}</span>
            </button>
          ))}
        </div>
        {opts.framing === 'original' && (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            Original framing pins a concrete aspect ratio and unlocks the garment pixel-lock.
          </div>
        )}

        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, marginTop: 20 }}>
          <div>
            <div className="kicker" style={{ marginBottom: 4 }}>Protection & polish</div>
            <SwitchRow title="Keep original clothing" desc="Branding guard — garment logos protected"
              on={opts.keepClothing} onChange={(v) => patch({ keepClothing: v })} />
            <SwitchRow title="Face restore" desc="CodeFormer finishing pass"
              on={opts.faceRestore} onChange={(v) => patch({ faceRestore: v })} />
            <SwitchRow title="Preserve eyewear" desc="Explicit keep-glasses prompt line"
              on={opts.glasses} onChange={(v) => patch({ glasses: v })} />
          </div>
          <div>
            <div className="kicker" style={{ marginBottom: 4 }}>Outputs</div>
            <SwitchRow title="Portrait 4:5" on={opts.portrait} onChange={(v) => patch({ portrait: v })} />
            <SwitchRow title="Square 1:1" on={opts.square} onChange={(v) => patch({ square: v })} />
            <SwitchRow title="Transparent cut-out PNG" on={opts.cutout} onChange={(v) => patch({ cutout: v })} />
            {opts.cutout && (
              <div style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
                {([['inspyrenet', 'InSPyReNet · standard'], ['birefnet', 'BiRefNet · max detail']] as const).map(([id, label]) => (
                  <button key={id} className={`pick-card${opts.matte === id ? ' on' : ''}`}
                    style={{ flex: 1, padding: opts.matte === id ? 9 : 10, fontSize: 12.5 }}
                    onClick={() => patch({ matte: id })}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            <SwitchRow title="8K print upscale" on={opts.print8k} onChange={(v) => patch({ print8k: v })} />
          </div>
        </div>

        <hr className="hairline" style={{ margin: '18px 0 14px' }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13.5, flex: 1, minWidth: 220 }}>
            {count} frames × {versions} backdrop{versions > 1 ? 's' : ''} → {outputs || 'no outputs selected'}
          </span>
          <Button variant="ghost" onClick={() => useStore.setState({ dispatchTarget: null })}>Cancel</Button>
          <Button variant="dark" disabled={busy || !outputs} onClick={() => queue(true)}>Queue & hold for later</Button>
          <Button variant="primary" disabled={busy || !outputs} onClick={() => queue(false)}>Queue & start now</Button>
        </div>
      </div>
    </div>
  );
}
