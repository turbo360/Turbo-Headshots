import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initIpc } from './ipc';
import './styles/app.css';

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
