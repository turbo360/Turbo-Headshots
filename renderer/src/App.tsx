import React, { useEffect, useState } from 'react';
import { useStore, activeShoot } from './state/store';
import { Icon, ICONS, Button } from './components/ds';
import logo from './assets/logo.png';
import type { ViewId } from './types';

import Shoots from './views/Shoots';
import ShootDetail from './views/ShootDetail';
import CheckIn from './views/CheckIn';
import Capture from './views/Capture';
import Review from './views/Review';
import Processing from './views/Processing';
import GalleryUpload from './views/GalleryUpload';
import Delivery from './views/Delivery';
import Settings from './views/Settings';

import NewShootModal from './overlays/NewShootModal';
import DispatchSheet from './overlays/DispatchSheet';
import QROverlay from './overlays/QROverlay';

const TITLES: Record<ViewId, string> = {
  shoots: 'Shoots',
  shootDetail: 'Shoot dashboard',
  checkin: 'Check-in · register',
  capture: 'Capture',
  review: 'Review · cull & approve',
  processing: 'Processing · headshot engine',
  gallery: 'Gallery upload',
  delivery: 'Delivery & summary',
  settings: 'Settings',
};

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tb-clock">{now.toLocaleTimeString('en-AU', { hour12: false })}</span>;
}

export default function App() {
  const s = useStore();
  const shoot = activeShoot(s);
  const inFlight = s.processing?.processing ?? 0;
  const reviewCount = s.people.reduce((n, p) => n + p.frames.filter((f) => !f.approved).length, 0);

  const nav: { key: ViewId; label: string; icon: string[]; badge: string | null }[] = [
    { key: 'shoots', label: 'Shoots', icon: ICONS.shoots, badge: null },
    { key: 'checkin', label: 'Check-in', icon: ICONS.checkin, badge: s.checkin.entries.length ? String(s.checkin.entries.length) : null },
    { key: 'capture', label: 'Capture', icon: ICONS.capture, badge: s.session.active ? 'REC' : null },
    { key: 'review', label: 'Review', icon: ICONS.review, badge: reviewCount > 0 ? String(reviewCount) : null },
    { key: 'processing', label: 'Processing', icon: ICONS.processing, badge: inFlight > 0 ? String(inFlight + (s.processing?.pending ?? 0)) : null },
    { key: 'gallery', label: 'Gallery Upload', icon: ICONS.gallery, badge: null },
    { key: 'delivery', label: 'Delivery', icon: ICONS.delivery, badge: null },
    { key: 'settings', label: 'Settings', icon: ICONS.settings, badge: null },
  ];

  // Keyboard: Enter starts session from check-in (handled in CheckIn), Escape ends
  // session / closes topmost overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const el = e.target as HTMLElement | null;
        if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) { el.blur(); return; }
        const st = useStore.getState();
        if (st.newShootOpen) { useStore.setState({ newShootOpen: false }); return; }
        if (st.dispatchTarget) { useStore.setState({ dispatchTarget: null }); return; }
        if (st.qrOpen) { useStore.setState({ qrOpen: false }); return; }
        // Ending the session is a big deal mid-shoot: only from the shoot-day
        // views, never silently.
        if (st.session.active && (st.view === 'capture' || st.view === 'checkin')) {
          void window.turbo.session.end();
          st.showToast('Session ended — new captures are NOT being recorded', 'error');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const healthy = !s.processing || s.processing.failed === 0;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-brand">
          <img src={logo} alt="Turbo 360" />
          <span className="brand-word">HEADSHOTS</span>
          <span className="brand-ver">OPS v2.0</span>
        </div>
        <div className="signal-bar" />
        <nav>
          {nav.map((n) => (
            <button
              key={n.key}
              className={`nav-btn${s.view === n.key ? ' active' : ''}`}
              onClick={() => s.go(n.key)}
            >
              <Icon paths={n.icon} />
              <span>{n.label}</span>
              {n.badge && <span className="nav-badge">{n.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-health">
          <div className="row">
            <span className={`live-dot${healthy ? '' : ' red'}`} />
            <span>{healthy ? 'Healthy' : `${s.processing?.failed} failed`} · {inFlight} in flight</span>
          </div>
          {inFlight > 0 && <div className="sweep"><span /></div>}
          <div className="rail-foot">REPLICATE · TURBO IQ</div>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="tb-title">
            <span className="tb-shoot mono">
              {s.session.active ? s.session.shootNumber : shoot ? shoot.name.toUpperCase() : 'NO ACTIVE SHOOT'}
            </span>
            <span className="tb-view">{TITLES[s.view]}</span>
          </div>
          <div className="tb-chips" data-chips>
            <span className="chip">
              <span className={`dot${s.appSettings?.watchFolder ? '' : ' off'}`} />
              Watch folder
            </span>
            <span className="chip">
              <span className={`dot${s.appSettings?.outputFolder ? '' : ' off'}`} />
              Output folder
            </span>
            <span className="chip">
              <span className={`dot${s.aiSettings?.processingEnabled && s.aiSettings?.hasApiKey ? '' : ' warn'}`} />
              {s.aiSettings?.processingEnabled && s.aiSettings?.hasApiKey
                ? `AI on · ${s.aiSettings.preset[0].toUpperCase()}${s.aiSettings.preset.slice(1)} preset`
                : 'AI off'}
            </span>
          </div>
          <div className="tb-right">
            <Clock />
            <Button size="sm" variant="secondary" onClick={() => useStore.setState({ qrOpen: true })}>QR</Button>
            <Button size="sm" variant="primary" onClick={() => useStore.setState({ newShootOpen: true })}>New shoot</Button>
          </div>
        </header>

        {s.view === 'shoots' && <Shoots />}
        {s.view === 'shootDetail' && <ShootDetail />}
        {s.view === 'checkin' && <CheckIn />}
        {s.view === 'capture' && <Capture />}
        {s.view === 'review' && <Review />}
        {s.view === 'processing' && <Processing />}
        {s.view === 'gallery' && <GalleryUpload />}
        {s.view === 'delivery' && <Delivery />}
        {s.view === 'settings' && <Settings />}
      </main>

      {s.newShootOpen && <NewShootModal />}
      {s.dispatchTarget && <DispatchSheet />}
      {s.qrOpen && <QROverlay />}

      {s.toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 90, background: s.toast.tone === 'error' ? 'var(--status-danger)' : 'var(--admin-carbon)',
          color: '#fff', borderRadius: 10, padding: '12px 20px', fontSize: 14,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}>
          {s.toast.msg}
        </div>
      )}

      {(s.updateInfo?.status === 'downloaded' || s.updateInfo?.status === 'downloading') && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 90,
          background: 'var(--admin-carbon)', color: '#fff', borderRadius: 12,
          padding: '14px 18px', display: 'flex', gap: 12, alignItems: 'center',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}>
          {s.updateInfo.status === 'downloaded' ? (
            <>
              <span style={{ fontSize: 14 }}>Update {s.updateInfo.version} ready</span>
              <Button size="sm" variant="primary" onClick={() => window.turbo.app.installUpdate()}>Restart & install</Button>
            </>
          ) : (
            <span className="mono" style={{ fontSize: 13 }}>
              Downloading v{s.updateInfo.version}… {s.updateInfo.percent ?? 0}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}
