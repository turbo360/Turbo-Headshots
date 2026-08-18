import { useStore } from './state/store';
import type { CheckinEntry, ProcessingStatus, SessionState, Transfer } from './types';

/* One-time wiring of main-process push channels into the store.
   Called from main.tsx before render. */

export async function initIpc(): Promise<void> {
  const t = window.turbo;
  const st = useStore.getState();

  t.on('session:state', (p) => {
    const next = p as SessionState;
    useStore.setState((s) => ({
      session: next,
      // New subject (or fresh session): never show the previous person's frames.
      ...(next.personId !== s.session.personId
        ? { sessionFrames: [], lastFrame: null }
        : {}),
    }));
  });

  t.on('session:frame-added', (p) => {
    const { previewUrl, baseName } = p as { previewUrl: string; baseName: string };
    const s = useStore.getState();
    useStore.setState({
      lastFrame: { previewUrl, baseName },
      sessionFrames: [...s.sessionFrames, { previewUrl, baseName }].slice(-24),
    });
  });

  t.on('session:preview', (p) => {
    // JPEG landed with no active session — still drive the capture preview.
    const { previewUrl } = p as { previewUrl: string };
    useStore.setState({ lastFrame: { previewUrl, baseName: '' } });
  });

  t.on('checkin:waiting', (p) =>
    useStore.setState((s) => ({ checkin: { ...s.checkin, ...(p as { available: boolean; entries: CheckinEntry[]; url: string | null }) } })));

  t.on('processing-status', (p) => useStore.setState({ processing: p as ProcessingStatus }));

  t.on('processing-log', (p) => {
    const { message, type } = p as { message: string; type: string };
    useStore.setState((s) => ({
      logLines: [...s.logLines, { msg: message, type, at: Date.now() }].slice(-200),
    }));
  });

  t.on('transfer:progress', (p) => {
    const tr = p as Transfer;
    useStore.setState((s) => {
      const i = s.transfers.findIndex((x) => x.id === tr.id);
      const transfers = i >= 0
        ? s.transfers.map((x) => (x.id === tr.id ? tr : x))
        : [...s.transfers, tr];
      return { transfers: transfers.slice(-100) };
    });
  });

  t.on('shoots:changed', async () => {
    const [shoots, appSettings] = await Promise.all([t.shoots.list(), t.settings.get()]);
    useStore.setState({ shoots, appSettings });
    await refreshActivePeople();
  });

  t.on('people:changed', () => { void refreshActivePeople(); });

  t.on('batches:changed', async () => {
    useStore.setState({ batches: await t.batches.list() });
  });

  t.on('update-status', (p) => useStore.setState({ updateInfo: p as { status: string; version?: string; percent?: number; message?: string } }));

  t.on('gallery-upload-result', (p) => {
    const r = p as { success: boolean; filename: string; error?: string | null };
    if (!r.success) {
      useStore.getState().showToast(`Upload failed: ${r.filename}${r.error ? ` — ${r.error}` : ''}`, 'error');
    }
  });

  // Initial load
  const [version, appSettings, aiSettings, shoots, gallerySettings, session, batches, processing, checkin, transfers] =
    await Promise.all([
      t.app.getVersion(), t.settings.get(), t.settings.getAi(), t.shoots.list(),
      t.gallery.getSettings(), t.session.current(), t.batches.list(),
      t.processing.getStatus(), t.checkin.getState(), t.gallery.listTransfers(),
    ]);
  useStore.setState({
    version, appSettings, aiSettings, shoots, gallerySettings, session, batches, processing, checkin, transfers,
    dispatchOpts: aiSettings?.defaultDispatchOpts ?? st.dispatchOpts,
  });
  await refreshActivePeople();
}

export async function refreshActivePeople(): Promise<void> {
  const s = useStore.getState();
  const activeId = s.appSettings?.activeShootId;
  if (activeId) {
    useStore.setState({ people: await window.turbo.people.list(activeId) });
  } else {
    useStore.setState({ people: [] });
  }
  if (s.detailShootId) {
    useStore.setState({ detailPeople: await window.turbo.people.list(s.detailShootId) });
  }
}
