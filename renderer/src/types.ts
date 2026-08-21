/* Shared shapes for the main ⇄ renderer IPC contract.
   The main process (main/ + engine/) is the source of truth for these. */

export type BackdropId =
  | 'white' | 'grey' | 'navy' | 'outdoor-soft'
  | 'office-soft' | 'turbo' | 'stage' | 'event-bokeh';

export type FramingId = 'chest-up' | 'shoulders-up' | 'head-tight' | 'original';
export type MatteId = 'inspyrenet' | 'birefnet';

export type EngineMode = 'replicate' | 'local';

export interface DispatchOpts {
  /** Resolved per shoot at dispatch/run time; 'local' = masks on this Mac. */
  engine?: EngineMode;
  backdrops: BackdropId[];
  framing: FramingId;
  keepClothing: boolean;
  faceRestore: boolean;
  glasses: boolean;
  portrait: boolean;
  square: boolean;
  cutout: boolean;
  matte: MatteId;
  print8k: boolean;
}

export type ShootStatus = 'live' | 'held' | 'delivered' | 'archived';

export interface Shoot {
  id: string;
  name: string;
  client: string;
  date: string;          // YYYY-MM-DD
  location: string;
  galleryId: string | null;
  galleryName: string | null;
  checkinSlug: string | null;
  checkinUrl: string | null;
  galleryShareUrl: string | null;
  serverShootId: string | null;   // Turbo IQ shoots.id
  status: ShootStatus;
  folderPath: string | null;
  defaults: DispatchOpts;
  engineMode?: EngineMode;
  createdAt: string;
  // Populated by shoots:list
  peopleCount?: number;
  frameCount?: number;
  approvedCount?: number;
}

export interface FrameQuality {
  eyesOpen: boolean;
  blurScore: number;
  captureQuality: number;
  recommendation: 'use' | 'review';
}

export interface OutputFile {
  path: string;
  kind: '4x5' | 'sqr' | '4x5-tp' | 'sqr-tp' | 'print';
  backdrop: BackdropId | null;
}

export interface Frame {
  file: string;          // abs path to RAW (or JPEG when no RAW)
  jpegFile: string | null;
  baseName: string;      // {shootNumber}_{Last}_{First}_{NN}
  capturedAt: string;
  approved: boolean;
  /** Set when a batch was dispatched for this person — frame no longer awaits review. */
  reviewed?: boolean;
  quality: FrameQuality | null;
  flags: string[];       // fail-soft flags from processing
}

export type DeliveryStatus = 'not-sent' | 'link-sent' | 'opened' | 'bounced';

export interface Person {
  id: string;
  shootId: string;
  shootNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
  company: string;
  folderPath: string | null;
  frames: Frame[];
  delivery: { status: DeliveryStatus; sentAt: string | null };
  createdAt: string;
  checkinEntryId?: string | null;
  /** Their Turbo IQ personal headshot delivery (set once ensured). */
  iq?: { deliveryId: string; accessToken: string; headshotUrl: string } | null;
}

export type BatchStatus = 'held' | 'queued' | 'processing' | 'done' | 'partial' | 'failed';

export interface Batch {
  id: string;
  shootId: string;
  personId: string | null;
  personName: string;
  shootNumber: string;
  files: string[];       // frame baseNames
  opts: DispatchOpts;
  estimateUsd: number;
  status: BatchStatus;
  createdAt: string;
  startedAt: string | null;
  doneCount: number;
  failedCount: number;
  totalRenders: number;
}

export interface WorkerLane {
  lane: string;          // 'W1'..'W4'
  batchId: string;
  file: string;
  person: string;
  stage: string;         // '01-prepare' .. '07-upload'
  stageLabel: string;
  pct: number;
  elapsedMs: number;
  status: string;        // 'Rendering' | 'Locked' | 'Degraded' | 'Retry 1/2' ...
  tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  flags: string[];
}

export interface ProcessingStatus {
  pending: number;
  processing: number;
  completedToday: number;
  failed: number;
  heldBatches: number;
  spendTodayUsd: number;
  paused: boolean;
  pausedReason: 'paused' | 'offline' | null;
  workers: WorkerLane[];
}

export interface Transfer {
  id: string;
  filename: string;
  galleryId: string;
  pct: number;
  status: 'uploading' | 'done' | 'failed';
}

export interface CheckinEntry {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  createdAt: string;
}

export interface SessionState {
  active: boolean;
  personId: string | null;
  shootNumber: string | null;
  personName: string | null;
  startedAt: string | null;
  frameCount: number;
}

export interface AppSettings {
  watchFolder: string | null;
  outputFolder: string | null;
  activeShootId: string | null;
}

export interface AiSettings {
  hasApiKey: boolean;
  processingEnabled: boolean;
  processEveryFrame: boolean;
  holdUntilShootEnd: boolean;
  preset: 'studio' | 'natural' | 'punchy';
  brightness: number;
  whiteBalanceStrength: number;
  sharpening: number;
  jpegQuality: number;
  defaultDispatchOpts: DispatchOpts;
  workerCount: number;
}

export interface GallerySettings {
  isAuthenticated: boolean;
  username: string | null;
  selectedGalleryId: string | null;
  selectedGalleryName: string | null;
  autoUpload: boolean;
  uploadPortrait: boolean;
  uploadSquare: boolean;
  uploadTransparent: boolean;
}

export interface GalleryInfo {
  id: string;
  name: string;
  photo_count: number;
  event_date: string | null;
}

export type ViewId =
  | 'shoots' | 'shootDetail' | 'checkin' | 'capture' | 'review'
  | 'processing' | 'gallery' | 'delivery' | 'settings';

/* ---------- window.turbo (preload) ---------- */

export interface TurboApi {
  app: {
    getVersion(): Promise<string>;
    checkForUpdates(): Promise<void>;
    downloadUpdate(): Promise<void>;
    installUpdate(): Promise<void>;
    openFolder(p: string): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    getAi(): Promise<AiSettings>;
    setAi(patch: Partial<AiSettings> & { replicateApiKey?: string }): Promise<AiSettings>;
    selectWatchFolder(): Promise<AppSettings>;
    selectOutputFolder(): Promise<AppSettings>;
    testApiConnection(key?: string): Promise<{ ok: boolean; error?: string }>;
  };
  shoots: {
    list(): Promise<Shoot[]>;
    create(data: {
      name: string; client: string; date: string; location: string;
      galleryMode: 'create' | 'link'; galleryName?: string; galleryId?: string;
      autoUpload: boolean; engineMode?: EngineMode;
    }): Promise<{ ok: boolean; shoot?: Shoot; error?: string }>;
    get(id: string): Promise<{ shoot: Shoot; people: Person[]; batches: Batch[] } | null>;
    setActive(id: string | null): Promise<void>;
    update(id: string, patch: Partial<Shoot>): Promise<Shoot>;
    remove(id: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
  };
  people: {
    create(data: { firstName: string; lastName: string; email: string; mobile: string; company: string; shootId: string })
      : Promise<{ ok: boolean; person?: Person; error?: string }>;
    list(shootId: string): Promise<Person[]>;
    remove(personId: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
  };
  session: {
    start(personId: string): Promise<SessionState>;
    end(): Promise<SessionState>;
    current(): Promise<SessionState>;
  };
  checkin: {
    getState(): Promise<{ available: boolean; entries: CheckinEntry[]; url: string | null }>;
    claimEntry(entryId: string): Promise<{ ok: boolean; person?: Person; error?: string }>;
  };
  review: {
    setApproved(personId: string, baseName: string, approved: boolean): Promise<void>;
  };
  batches: {
    estimate(fileCount: number, opts: DispatchOpts): Promise<{ perFrame: number; total: number }>;
    create(data: { shootId: string; personId: string | null; files: string[]; opts: DispatchOpts; hold: boolean })
      : Promise<{ ok: boolean; batch?: Batch }>;
    list(): Promise<Batch[]>;
    start(id: string): Promise<void>;
    startAllHeld(): Promise<void>;
    updateOpts(id: string, opts: DispatchOpts): Promise<Batch>;
    remove(id: string): Promise<void>;
  };
  processing: {
    getStatus(): Promise<ProcessingStatus>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    retryFailed(): Promise<void>;
    clearCompleted(): Promise<void>;
  };
  gallery: {
    getSettings(): Promise<GallerySettings>;
    setCredentials(u: string, p: string): Promise<{ ok: boolean; error?: string }>;
    test(): Promise<{ ok: boolean; error?: string }>;
    list(): Promise<{ ok: boolean; galleries: GalleryInfo[] }>;
    create(name: string, eventDate?: string): Promise<{ ok: boolean; gallery?: GalleryInfo; error?: string }>;
    select(id: string, name: string): Promise<void>;
    setUploadOptions(opts: Partial<GallerySettings>): Promise<GallerySettings>;
    logout(): Promise<void>;
    listTransfers(): Promise<Transfer[]>;
    retryTransfer(id: string): Promise<void>;
  };
  delivery: {
    list(shootId: string): Promise<Person[]>;
    sendLink(personId: string): Promise<{ ok: boolean; personal?: boolean; error?: string }>;
    sendAll(shootId: string): Promise<{ ok: boolean; sent: number; waiting?: number }>;
  };
  usage: {
    summary(): Promise<{ todayUsd: number; shootUsd: number }>;
  };
  on(channel: string, cb: (payload: unknown) => void): () => void;
}

declare global {
  interface Window { turbo: TurboApi; }
}
