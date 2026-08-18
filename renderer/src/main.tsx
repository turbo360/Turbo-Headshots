import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initIpc } from './ipc';
import './styles/app.css';

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  console.error('[renderer] unhandled rejection:', e.reason);
  import('./state/store').then(({ useStore }) => useStore.getState().showToast(msg, 'error'));
});

async function boot() {
  try {
    await initIpc();
  } catch (err) {
    console.error('[renderer] initIpc failed:', err);
  }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
