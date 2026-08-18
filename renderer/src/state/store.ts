import { create } from 'zustand';
import type {
  AiSettings, AppSettings, Batch, CheckinEntry, DispatchOpts, GalleryInfo,
  GallerySettings, Person, ProcessingStatus, SessionState, Shoot, Transfer, ViewId,
} from '../types';

export const DEFAULT_OPTS: DispatchOpts = {
  backdrops: ['grey'],
  framing: 'chest-up',
  keepClothing: true,
  faceRestore: true,
  glasses: false,
  portrait: true,
  square: true,
  cutout: true,
  matte: 'inspyrenet',
  print8k: false,
};

export interface DispatchTarget {
  shootId: string;
  personId: string | null;
  personName: string;
  files: string[];       // frame baseNames
  batchId?: string;      // when editing a held batch
}

interface State {
  // ui
  view: ViewId;
  detailShootId: string | null;
  dispatchTarget: DispatchTarget | null;
  newShootOpen: boolean;
  qrOpen: boolean;
  settingsTab: number;
  toast: { msg: string; tone: 'info' | 'error' | 'success' } | null;

  // data
  appSettings: AppSettings | null;
  aiSettings: AiSettings | null;
  shoots: Shoot[];
  people: Person[];              // people of the active shoot
  detailPeople: Person[];        // people of the detail shoot
  batches: Batch[];
  session: SessionState;
  lastFrame: { previewUrl: string; baseName: string } | null;
  sessionFrames: { previewUrl: string; baseName: string }[];
  checkin: { available: boolean; entries: CheckinEntry[]; url: string | null };
  processing: ProcessingStatus | null;
  gallerySettings: GallerySettings | null;
  galleries: GalleryInfo[];
  transfers: Transfer[];
  reviewPersonId: string | null;
  dispatchOpts: DispatchOpts;
  logLines: { msg: string; type: string; at: number }[];
  updateInfo: { status: string; version?: string } | null;
  version: string;

  set: (p: Partial<State>) => void;
  go: (view: ViewId) => void;
  showToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export const useStore = create<State>((set, get) => ({
  view: 'shoots',
  detailShootId: null,
  dispatchTarget: null,
  newShootOpen: false,
  qrOpen: false,
  settingsTab: 0,
  toast: null,

  appSettings: null,
  aiSettings: null,
  shoots: [],
  people: [],
  detailPeople: [],
  batches: [],
  session: { active: false, personId: null, shootNumber: null, personName: null, startedAt: null, frameCount: 0 },
  lastFrame: null,
  sessionFrames: [],
  checkin: { available: false, entries: [], url: null },
  processing: null,
  gallerySettings: null,
  galleries: [],
  transfers: [],
  reviewPersonId: null,
  dispatchOpts: DEFAULT_OPTS,
  logLines: [],
  updateInfo: null,
  version: '',

  set: (p) => set(p),
  go: (view) => set({ view, qrOpen: false }),
  showToast: (msg, tone = 'info') => {
    set({ toast: { msg, tone } });
    setTimeout(() => { if (get().toast?.msg === msg) set({ toast: null }); }, 4000);
  },
}));

export const activeShoot = (s: State): Shoot | null =>
  s.shoots.find((x) => x.id === s.appSettings?.activeShootId) ?? null;

export const detailShoot = (s: State): Shoot | null =>
  s.shoots.find((x) => x.id === s.detailShootId) ?? null;
