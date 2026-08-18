import React from 'react';
import { useStore } from '../state/store';
import { Button } from '../components/ds';
import { QrBlock } from '../views/CheckIn';

export default function QROverlay() {
  const s = useStore();
  const url = s.checkin.url;
  const lastEntry = s.checkin.entries[s.checkin.entries.length - 1];

  return (
    <div className="overlay z-qr" onClick={(e) => { if (e.target === e.currentTarget) useStore.setState({ qrOpen: false }); }}>
      <div className="sheet carbon" style={{
        width: 'min(1000px, 92vw)', padding: '48px 40px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, textAlign: 'center',
      }}>
        {url ? (
          <>
            <div style={{ background: '#fff', borderRadius: 16, padding: 24, display: 'inline-flex' }}>
              <QrBlock url={url} size={320} />
            </div>
            <div className="h-display" style={{ fontSize: 34 }}>Scan. Type. Step up.</div>
            <div className="mono" style={{ fontSize: 16, color: 'var(--ignition-amber)', wordBreak: 'break-all' }}>
              {url.replace(/^https?:\/\//, '')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="live-dot" />
              <span className="mono" style={{ fontSize: 12, letterSpacing: '0.14em', color: '#B9B6AF' }}>
                {s.checkin.entries.length} CHECKED IN{lastEntry ? ` · LAST ${new Date(lastEntry.createdAt).toLocaleTimeString('en-AU', { hour12: false, hour: '2-digit', minute: '2-digit' })}` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <Button variant="secondary" onClick={() => window.print()}>Print A5 card</Button>
              <Button variant="primary" onClick={() => useStore.setState({ qrOpen: false })}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <div className="h-display" style={{ fontSize: 26 }}>No check-in link</div>
            <div style={{ fontSize: 15, color: '#B9B6AF', maxWidth: 440 }}>
              Create a shoot (with Turbo IQ signed in) to generate its self check-in QR code.
            </div>
            <Button variant="primary" onClick={() => useStore.setState({ qrOpen: false })}>Close</Button>
          </>
        )}
      </div>
    </div>
  );
}
