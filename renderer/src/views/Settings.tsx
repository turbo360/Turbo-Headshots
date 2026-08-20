import React, { useState } from 'react';
import { useStore, activeShoot } from '../state/store';
import { Button, Input, SwitchRow } from '../components/ds';
import type { AiSettings, DispatchOpts } from '../types';

const TABS = ['Look & engine', 'Output files', 'Folders & naming', 'Integrations'];

function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  fmt: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span className="mono ink2">{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        style={{ accentColor: 'var(--turbo-red)' }}
        onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export default function Settings() {
  const s = useStore();
  const ai = s.aiSettings;
  const [apiKey, setApiKey] = useState('');
  const shoot = activeShoot(s);

  if (!ai) return <div className="page"><div className="card muted">Loading…</div></div>;

  const patchAi = async (patch: Partial<AiSettings> & { replicateApiKey?: string }) => {
    useStore.setState({ aiSettings: await window.turbo.settings.setAi(patch) });
  };
  const patchOpts = (patch: Partial<DispatchOpts>) =>
    patchAi({ defaultDispatchOpts: { ...ai.defaultDispatchOpts, ...patch } });

  const presets: { id: AiSettings['preset']; label: string; desc: string }[] = [
    { id: 'studio', label: 'Studio', desc: 'Full engine — re-rendered backdrop, restored faces, print-ready.' },
    { id: 'natural', label: 'Natural', desc: 'Local pipeline only — colour-corrected crops, no generative pass.' },
    { id: 'punchy', label: 'Punchy', desc: 'Engine + stronger local sharpening and contrast at export.' },
  ];

  return (
    <div className="page">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {TABS.map((t, i) => (
          <button key={t} className="pick-card" style={{
            flexDirection: 'row', alignItems: 'center', gap: 12,
            ...(s.settingsTab === i ? { background: 'var(--admin-carbon)', color: 'var(--smoke)', borderColor: 'var(--admin-carbon)' } : {}),
          }} onClick={() => useStore.setState({ settingsTab: i })}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: s.settingsTab === i ? 'var(--turbo-red)' : 'var(--admin-muted)' }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <span style={{ fontSize: 14.5 }}>{t}</span>
          </button>
        ))}
      </div>

      {s.settingsTab === 0 && (
        <>
          <div className="card">
            <div className="kicker" style={{ marginBottom: 12 }}>Default preset</div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {presets.map((p) => (
                <button key={p.id} className={`pick-card${ai.preset === p.id ? ' on' : ''}`}
                  onClick={() => patchAi({ preset: p.id })}>
                  {ai.preset === p.id && <span className="on-tag">SELECTED</span>}
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-heading)' }}>{p.label}</span>
                  <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>{p.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div className="kicker">Fine-tune · local pipeline only (engine renders ship untouched, matching Turbo Enhance)</div>
              <Slider label="Brightness" value={ai.brightness} min={0.9} max={1.3} step={0.01}
                fmt={(v) => `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`} onChange={(v) => patchAi({ brightness: v })} />
              <Slider label="White balance" value={ai.whiteBalanceStrength} min={0} max={1} step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patchAi({ whiteBalanceStrength: v })} />
              <Slider label="Sharpening" value={ai.sharpening} min={0} max={2} step={0.1}
                fmt={(v) => v.toFixed(1)} onChange={(v) => patchAi({ sharpening: v })} />
              <Slider label="JPEG quality" value={ai.jpegQuality} min={70} max={100} step={1}
                fmt={(v) => String(v)} onChange={(v) => patchAi({ jpegQuality: v })} />
            </div>

            <div className="card">
              <div className="kicker" style={{ marginBottom: 6 }}>Engine</div>
              <SwitchRow title="AI processing" desc="Master switch — off = local pipeline only"
                on={ai.processingEnabled} onChange={(v) => patchAi({ processingEnabled: v })} />
              <SwitchRow title="Process every frame" desc="Off = only frames approved in Review enter the pipeline"
                on={ai.processEveryFrame} onChange={(v) => patchAi({ processEveryFrame: v })} />
              <SwitchRow title="Keep original clothing by default" desc="Branding guard on — garment logos protected"
                on={ai.defaultDispatchOpts.keepClothing} onChange={(v) => patchOpts({ keepClothing: v })} />
              <SwitchRow title="Face restore by default" desc="Leave OFF — faces ship exactly as rendered, matching Turbo Enhance. CodeFormer can distort large sharp faces."
                on={ai.defaultDispatchOpts.faceRestore} onChange={(v) => patchOpts({ faceRestore: v })} />
              <SwitchRow title="Hold batches until the shoot ends" desc="Dispatched batches queue as Held and start together"
                on={ai.holdUntilShootEnd} onChange={(v) => patchAi({ holdUntilShootEnd: v })} />
            </div>
          </div>
        </>
      )}

      {s.settingsTab === 1 && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <div className="card">
            <div className="kicker" style={{ marginBottom: 6 }}>Output files</div>
            <SwitchRow title="Portrait 4:5" desc="{base}-{backdrop}-4x5.jpg"
              on={ai.defaultDispatchOpts.portrait} onChange={(v) => patchOpts({ portrait: v })} />
            <SwitchRow title="Square 1:1" desc="{base}-{backdrop}-SQR.jpg"
              on={ai.defaultDispatchOpts.square} onChange={(v) => patchOpts({ square: v })} />
            <SwitchRow title="Transparent cut-out PNGs" desc="{base}-{backdrop}-4x5-TP.png / -SQR-TP.png"
              on={ai.defaultDispatchOpts.cutout} onChange={(v) => patchOpts({ cutout: v })} />
            <SwitchRow title="8K print upscale" desc="{base}-{backdrop}-print.jpg — Real-ESRGAN ×4"
              on={ai.defaultDispatchOpts.print8k} onChange={(v) => patchOpts({ print8k: v })} />
          </div>
          <div className="card">
            <div className="kicker" style={{ marginBottom: 12 }}>Cut-out engine</div>
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              {([['inspyrenet', 'InSPyReNet', 'Standard — soft alpha, ~$0.0005/image'],
                 ['birefnet', 'BiRefNet', 'Max detail — hairlines, ~$0.005/image']] as const).map(([id, label, desc]) => (
                <button key={id} className={`pick-card${ai.defaultDispatchOpts.matte === id ? ' on' : ''}`}
                  onClick={() => patchOpts({ matte: id })}>
                  {ai.defaultDispatchOpts.matte === id && <span className="on-tag">ON</span>}
                  <span style={{ fontWeight: 700 }}>{label}</span>
                  <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}>{desc}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {s.settingsTab === 2 && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="kicker">Folders</div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Watch folder (LUMIX Tether output)</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', color: s.appSettings?.watchFolder ? 'var(--admin-ink-2)' : 'var(--status-danger)' }}>
                  {s.appSettings?.watchFolder ?? 'Not set'}
                </span>
                <Button size="sm" variant="secondary" onClick={async () => {
                  useStore.setState({ appSettings: await window.turbo.settings.selectWatchFolder() });
                }}>Choose…</Button>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Output folder</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', color: s.appSettings?.outputFolder ? 'var(--admin-ink-2)' : 'var(--status-danger)' }}>
                  {s.appSettings?.outputFolder ?? 'Not set'}
                </span>
                <Button size="sm" variant="secondary" onClick={async () => {
                  useStore.setState({ appSettings: await window.turbo.settings.selectOutputFolder() });
                }}>Choose…</Button>
                {s.appSettings?.outputFolder && (
                  <Button size="sm" variant="ghost" onClick={() => window.turbo.app.openFolder(s.appSettings!.outputFolder!)}>Open</Button>
                )}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="kicker" style={{ marginBottom: 12 }}>Naming</div>
            <pre className="mono" style={{
              fontSize: 12, lineHeight: 1.8, background: 'var(--admin-surface-2)',
              border: '1px solid var(--admin-border)', borderRadius: 10, padding: '14px 16px',
              overflowX: 'auto', color: 'var(--admin-ink-2)',
            }}>
{`2026/08/20260818_Northline Corporate/
  20260818-004_Whitlam_Sarah/
    20260818-004_Whitlam_Sarah_01.RW2
    Processed/
      ..._01-grey-4x5.jpg
      ..._01-grey-4x5-TP.png
      ..._01-turbo-SQR.jpg`}
            </pre>
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Files are renamed to shoot number + name; each selected backdrop adds its slug to every output.
            </div>
          </div>
        </div>
      )}

      {s.settingsTab === 3 && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <div className="card">
            <div className="kicker" style={{ marginBottom: 12 }}>Replicate</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Input label="API key" type="password" placeholder={ai.hasApiKey ? 'r8_••••••••  (saved)' : 'r8_…'}
                  value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
              <Button size="sm" variant="secondary" disabled={!apiKey} onClick={async () => {
                await patchAi({ replicateApiKey: apiKey });
                const r = await window.turbo.settings.testApiConnection();
                s.showToast(r.ok ? 'Replicate connected' : `Key check failed: ${r.error}`, r.ok ? 'success' : 'error');
                if (r.ok) setApiKey('');
              }}>Save & test</Button>
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="kicker" style={{ marginBottom: 8 }}>Worker lanes</div>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(8, 1fr)', gap: 6 }}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <button key={n} className={`pick-card${(ai.workerCount ?? 4) === n ? ' on' : ''}`}
                    style={{ alignItems: 'center', textAlign: 'center' }}
                    onClick={() => patchAi({ workerCount: n })}>
                    <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-heading)' }}>{n}</span>
                  </button>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                Simultaneous renders. Applies from the next dispatch — no restart needed. Replicate
                rate limits are handled automatically (busy lanes back off and retry).
              </div>
            </div>
          </div>
          <div className="card">
            <div className="kicker" style={{ marginBottom: 12 }}>Check-in kiosk</div>
            {shoot?.checkinUrl ? (
              <>
                <div className="mono" style={{ fontSize: 13, color: 'var(--admin-ink-2)', wordBreak: 'break-all' }}>
                  {shoot.checkinUrl.replace(/^https?:\/\//, '')}
                </div>
                <div className="muted" style={{ fontSize: 13, margin: '8px 0 12px' }}>
                  {s.checkin.entries.length} waiting
                </div>
                <Button size="sm" variant="secondary" onClick={() => useStore.setState({ qrOpen: true })}>Show QR</Button>
              </>
            ) : (
              <div className="muted" style={{ fontSize: 14 }}>The active shoot has no check-in link.</div>
            )}
            <hr className="hairline" style={{ margin: '16px 0' }} />
            <div className="kicker" style={{ marginBottom: 8 }}>App updates</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <span className="mono" style={{ fontSize: 13 }}>v{s.version}</span>
              <span className="muted" style={{ fontSize: 13, flex: 1 }}>
                {s.updateInfo?.status === 'downloading' ? `Downloading v${s.updateInfo.version}… ${s.updateInfo.percent ?? 0}%`
                  : s.updateInfo?.status === 'downloaded' ? `v${s.updateInfo.version} ready — restart to install`
                  : s.updateInfo?.status === 'error' ? `Update error: ${s.updateInfo.message}`
                  : s.updateInfo?.status === 'current' ? 'Up to date'
                  : 'Checks on launch and every 30 min'}
              </span>
              <Button size="sm" variant="secondary" onClick={() => window.turbo.app.checkForUpdates()}>Check now</Button>
            </div>
            <div className="kicker" style={{ marginBottom: 8 }}>LUMIX Tether</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Use PC Tether mode with RAW+JPEG. The watch folder should be Tether's output folder.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
