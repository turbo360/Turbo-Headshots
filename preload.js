// contextBridge surface — the ONLY door between renderer and main.
// Channel whitelist on both invoke and push; no generic passthrough.
const { contextBridge, ipcRenderer } = require('electron');

const PUSH_CHANNELS = new Set([
  'update-status',
  'processing-status',
  'processing-log',
  'processing-item-complete',
  'gallery-upload-result',
  'session:state',
  'session:frame-added',
  'session:preview',
  'checkin:waiting',
  'review:quality-updated',
  'transfer:progress',
  'shoots:changed',
  'people:changed',
  'batches:changed',
]);

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('turbo', {
  app: {
    getVersion: invoke('get-app-version'),
    checkForUpdates: invoke('check-for-updates'),
    downloadUpdate: invoke('download-update'),
    installUpdate: invoke('install-update'),
    openFolder: invoke('open-folder'),
  },
  settings: {
    get: invoke('get-settings'),
    getAi: invoke('get-ai-settings'),
    setAi: invoke('set-ai-settings'),
    selectWatchFolder: invoke('select-watch-folder'),
    selectOutputFolder: invoke('select-output-folder'),
    testApiConnection: invoke('test-api-connection'),
  },
  shoots: {
    list: invoke('shoots:list'),
    create: invoke('shoots:create'),
    get: invoke('shoots:get'),
    setActive: invoke('shoots:set-active'),
    update: invoke('shoots:update'),
  },
  people: {
    create: invoke('people:create'),
    list: invoke('people:list'),
  },
  session: {
    start: invoke('session:start'),
    end: invoke('session:end'),
    current: invoke('session:current'),
  },
  checkin: {
    getState: invoke('checkin:get-state'),
    claimEntry: invoke('checkin:claim-entry'),
  },
  review: {
    setApproved: invoke('review:set-approved'),
  },
  batches: {
    estimate: invoke('batches:estimate'),
    create: invoke('batches:create'),
    list: invoke('batches:list'),
    start: invoke('batches:start'),
    startAllHeld: invoke('batches:start-all-held'),
    updateOpts: invoke('batches:update-opts'),
    remove: invoke('batches:remove'),
  },
  processing: {
    getStatus: invoke('get-queue-status'),
    pause: invoke('processing:pause'),
    resume: invoke('processing:resume'),
    retryFailed: invoke('retry-failed'),
    clearCompleted: invoke('clear-completed'),
  },
  gallery: {
    getSettings: invoke('get-gallery-settings'),
    setCredentials: invoke('gallery:set-credentials'),
    test: invoke('test-gallery-connection'),
    list: invoke('list-galleries'),
    create: invoke('create-gallery'),
    select: invoke('gallery:select'),
    setUploadOptions: invoke('set-gallery-upload-options'),
    logout: invoke('gallery-logout'),
    listTransfers: invoke('transfers:list'),
    retryTransfer: invoke('transfers:retry'),
  },
  delivery: {
    list: invoke('delivery:list'),
    sendLink: invoke('delivery:send-link'),
    sendAll: invoke('delivery:send-all'),
  },
  usage: {
    summary: invoke('usage:summary'),
  },
  on(channel, cb) {
    if (!PUSH_CHANNELS.has(channel)) {
      console.warn('[preload] blocked subscription to unknown channel:', channel);
      return () => {};
    }
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
