// Batches + the 4-worker render pool. Replaces v1 processor.js's concurrency-1
// loop; keeps its persistence + restart-recovery semantics (processing →
// pending on load, drop items whose source frame vanished).
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('../main/store');
const { processRender, processLocal } = require('./pipeline');
const { estimate } = require('./cost');

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

const isNetworkClass = (msg) =>
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|API key is not set/i.test(msg || '');

class Engine {
  /**
   * @param {object} deps { app, settings, shoots, client, sidecar, usage,
   *                        push(channel, payload), log(message, type),
   *                        onOutputs(batch, person, item) }
   */
  constructor(deps) {
    this.d = deps;
    const dir = path.join(deps.app.getPath('userData'), 'store');
    this.batches = new JsonStore(path.join(dir, 'batches.json'), []);
    this.queue = new JsonStore(path.join(dir, 'queue.json'), []);
    this.paused = false;
    this.workers = new Map(); // lane -> {item, stageKey, stageLabel, pct, startedAt, status, tone}
    this.frameCaches = new Map(); // `${batchId}|${baseName}` -> Map
    this.running = 0;
    this.completedToday = 0;
    this._statusTimer = null;

    // Restart recovery
    this.queue.update((items) => {
      for (const it of items) {
        if (it.status === 'processing') it.status = 'pending';
      }
    });
    this.batches.update((list) => {
      for (const b of list) {
        if (b.status === 'processing' || b.status === 'queued') {
          const items = this.queue.data.filter((i) => i.batchId === b.id);
          if (items.some((i) => i.status === 'pending')) {
            b.status = 'queued';
          } else if (items.length > 0) {
            // All items already finished but the batch flush was lost in a
            // crash — recompute the terminal status so it isn't stuck forever.
            b.doneCount = items.filter((i) => i.status === 'completed').length;
            b.failedCount = items.filter((i) => i.status === 'failed').length;
            b.status = b.failedCount === 0 ? 'done' : (b.doneCount > 0 ? 'partial' : 'failed');
          }
        }
      }
    });
    // Housekeeping: completed queue items older than 7 days.
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    this.queue.update((items) => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status === 'completed' && items[i].finishedAt &&
            new Date(items[i].finishedAt).getTime() < cutoff) items.splice(i, 1);
      }
    });
  }

  workerCount() {
    return Math.max(1, Math.min(8, this.d.settings.raw.workerCount ?? 4));
  }

  /* ---------- batches ---------- */

  listBatches() { return this.batches.data; }

  createBatch({ shootId, personId, files, opts, hold }) {
    const person = personId ? this.d.shoots.getPerson(personId) : null;
    const est = estimate(files.length, opts);
    const batch = {
      id: uid(),
      shootId,
      personId: personId ?? null,
      personName: person ? `${person.firstName} ${person.lastName}` : (this.d.shoots.getShoot(shootId)?.name ?? 'Batch'),
      shootNumber: person?.shootNumber ?? '',
      files,
      opts,
      estimateUsd: est.total,
      status: hold ? 'held' : 'queued',
      createdAt: nowIso(),
      startedAt: null,
      doneCount: 0,
      failedCount: 0,
      totalRenders: 0,
    };
    this.batches.update((list) => list.push(batch));
    // Review handled: every frame on screen at dispatch time was either
    // approved (sent) or culled — only frames captured AFTER this moment
    // should count as awaiting review again.
    if (personId) {
      this.d.shoots.updatePerson(personId, (p) => {
        for (const f of p.frames) f.reviewed = true;
      });
    }
    if (!hold) this.startBatch(batch.id);
    this.notifyBatches();
    return batch;
  }

  updateBatchOpts(id, opts) {
    let out = null;
    this.batches.update((list) => {
      const b = list.find((x) => x.id === id);
      if (b && b.status === 'held') {
        b.opts = opts;
        b.estimateUsd = estimate(b.files.length, opts).total;
        out = b;
      }
    });
    this.notifyBatches();
    return out;
  }

  removeBatch(id) {
    this.queue.update((items) => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].batchId === id && items[i].status === 'pending') items.splice(i, 1);
      }
    });
    this.batches.update((list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0 && ['held', 'done', 'failed', 'partial', 'processing'].includes(list[i].status)
        && !this.queue.data.some((q) => q.batchId === id && q.status === 'processing')) list.splice(i, 1);
    });
    this.notifyBatches();
  }

  startBatch(id) {
    const batch = this.batches.data.find((b) => b.id === id);
    if (!batch || (batch.status !== 'held' && batch.status !== 'queued')) return;
    // Idempotent: a queued batch already has its items — starting it again
    // must never enqueue (and bill) the whole set a second time.
    if (this.queue.data.some((i) => i.batchId === id)) { this.pump(); return; }
    const engineOn = this.engineAvailable();
    const backdrops = engineOn ? batch.opts.backdrops : [null];
    const items = [];
    for (const baseName of batch.files) {
      for (const backdrop of backdrops) {
        items.push({
          id: uid(),
          batchId: batch.id,
          personId: batch.personId,
          shootId: batch.shootId,
          baseName,
          backdrop,
          status: 'pending',
          retries: 0,
          error: null,
          flags: [],
          addedAt: nowIso(),
        });
      }
    }
    this.queue.update((q) => q.push(...items));
    this.batches.update((list) => {
      const b = list.find((x) => x.id === id);
      if (b) {
        b.status = 'queued';
        b.startedAt = nowIso();
        b.totalRenders = items.length;
        b.doneCount = 0;
        b.failedCount = 0;
      }
    });
    this.d.log(`Batch queued: ${batch.personName} — ${items.length} renders`, 'info');
    this.notifyBatches();
    this.pump();
  }

  startAllHeld() {
    for (const b of [...this.batches.data]) {
      if (b.status === 'held') this.startBatch(b.id);
    }
  }

  /**
   * Drop all batches + pending queue items for a deleted shoot or person.
   * In-flight items are left to finish; finishItem tolerates a missing batch.
   */
  purgeBatches({ shootId, personId }) {
    const match = (x) =>
      (shootId && x.shootId === shootId) || (personId && x.personId === personId);
    const batchIds = new Set(this.batches.data.filter(match).map((b) => b.id));
    this.queue.update((items) => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (batchIds.has(items[i].batchId) && items[i].status !== 'processing') items.splice(i, 1);
      }
    });
    this.batches.update((list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (batchIds.has(list[i].id)) list.splice(i, 1);
      }
    });
    for (const id of batchIds) this.frameCachesClear(id);
    this.notifyBatches();
  }

  engineAvailable() {
    return !!(this.d.settings.raw.processingEnabled && this.d.settings.raw.replicateApiKey
      && this.d.settings.raw.preset !== 'natural');
  }

  /* ---------- worker pool ---------- */

  pump() {
    if (this.paused) return;
    const max = this.workerCount();
    while (this.running < max) {
      const item = this.queue.data.find((i) => i.status === 'pending');
      if (!item) break;
      item.status = 'processing';
      this.queue.scheduleSave();
      this.running++;
      const lane = this.allocLane();
      void this.runItem(item, lane).finally(() => {
        this.running--;
        this.workers.delete(lane);
        this.notifyStatus();
        setImmediate(() => this.pump());
      });
    }
    this.notifyStatus();
  }

  allocLane() {
    for (let i = 1; i <= this.workerCount(); i++) {
      if (!this.workers.has(`W${i}`)) return `W${i}`;
    }
    return `W${this.workers.size + 1}`;
  }

  frameCache(batchId, baseName) {
    const key = `${batchId}|${baseName}`;
    if (!this.frameCaches.has(key)) {
      // simple bound: drop oldest caches beyond 8 frames
      if (this.frameCaches.size > 8) {
        const first = this.frameCaches.keys().next().value;
        this.frameCaches.delete(first);
      }
      this.frameCaches.set(key, new Map());
    }
    return this.frameCaches.get(key);
  }

  async runItem(item, lane) {
    try {
      await this._runItemInner(item, lane);
    } catch (err) {
      // Deps construction / anything unexpected: never leave an item stuck in
      // 'processing' with no error surfaced.
      console.error('[engine] runItem fatal:', err.message);
      this.finishItem(item, 'failed', err.message);
    }
  }

  async _runItemInner(item, lane) {
    const person = item.personId ? this.d.shoots.getPerson(item.personId) : null;
    const frame = person?.frames.find((f) => f.baseName === item.baseName)
      ?? this.findFrameAcrossShoot(item.shootId, item.baseName);
    const personName = person ? `${person.firstName} ${person.lastName}` : '';

    const setLane = (stageKey, stageLabel, pct, status = 'Rendering', tone = 'info') => {
      this.workers.set(lane, {
        item, stageKey, stageLabel, pct,
        startedAt: this.workers.get(lane)?.startedAt ?? Date.now(),
        status, tone, personName,
      });
      this.notifyStatus();
    };

    if (!frame) {
      this.finishItem(item, 'failed', 'Frame no longer exists');
      return;
    }
    const owner = person ?? this.findPersonByFrame(item.shootId, item.baseName);
    const personFolder = owner ? this.d.shoots.personFolder(owner) : null;
    if (!personFolder) {
      this.finishItem(item, 'failed', 'Person folder unavailable');
      return;
    }

    const batch = this.batches.data.find((b) => b.id === item.batchId);
    // Per-shoot pipeline: 'local' runs the guard/cutout masks on this Mac
    // (Vision sidecar + optional BiRefNet worker); NBP always stays remote.
    const opts = {
      ...(batch?.opts ?? this.d.settings.raw.defaultDispatchOpts),
      engine: this.d.shoots.getShoot(item.shootId)?.engineMode ?? 'replicate',
    };
    const deps = {
      client: this.d.client,
      sidecar: this.d.sidecar(),
      usage: this.d.usage,
      settings: this.d.settings,
      onStage: (k, l, p) => setLane(k, l, p),
    };
    const cache = this.frameCache(item.batchId, item.baseName);
    const workItem = { frame, personFolder, baseName: item.baseName, backdrop: item.backdrop, opts, brandingRetry: item.retries > 0 };

    try {
      let result;
      if (item.backdrop === null || !this.engineAvailable()) {
        result = await processLocal(workItem, deps, cache);
      } else {
        result = await processRender(workItem, deps, cache);
      }
      item.outputs = result.outputs;
      item.flags = result.flags;
      item.verify = result.verify;
      this.applyFrameFlags(owner, item.baseName, result.flags);
      this.finishItem(item, 'completed', null);
      this.d.log(`Done: ${item.baseName}${item.backdrop ? ` · ${item.backdrop}` : ''} (${result.outputs.length} files)`, 'info');
      if (this.d.onOutputs && batch) {
        try { await this.d.onOutputs(batch, owner, item); } catch (err) {
          this.d.log(`Upload failed for ${item.baseName}: ${err.message}`, 'warning');
        }
      }
    } catch (err) {
      const msg = err.message || 'processing failed';
      this.d.log(`Error: ${item.baseName}${item.backdrop ? ` · ${item.backdrop}` : ''} — ${msg}`, 'error');

      // Offline: don't burn retries or degrade to local — hold the item,
      // auto-pause the engine, and auto-resume when connectivity returns.
      if (item.backdrop !== null && isNetworkClass(msg)) {
        item.status = 'pending';
        this.queue.scheduleSave();
        this.autoPauseOffline();
        return;
      }

      if (item.retries < 2) {
        item.retries++;
        setLane('render', `Retry ${item.retries}/2`, 0, `Retry ${item.retries}/2`, 'warning');
        await new Promise((r) => setTimeout(r, 2000 * item.retries));
        item.status = 'pending'; // only now — nobody else picks it up mid-backoff
        this.queue.scheduleSave();
        return;
      }
      this.finishItem(item, 'failed', msg);
    }
  }

  findPersonByFrame(shootId, baseName) {
    return this.d.shoots.listPeople(shootId).find((p) => p.frames.some((f) => f.baseName === baseName)) ?? null;
  }

  findFrameAcrossShoot(shootId, baseName) {
    const p = this.findPersonByFrame(shootId, baseName);
    return p?.frames.find((f) => f.baseName === baseName) ?? null;
  }

  applyFrameFlags(person, baseName, flags) {
    if (!person) return;
    this.d.shoots.updatePerson(person.id, (p) => {
      const f = p.frames.find((x) => x.baseName === baseName);
      if (f) f.flags = Array.from(new Set([...(f.flags || []), ...flags]));
    });
  }

  finishItem(item, status, error) {
    item.status = status;
    item.error = error;
    item.finishedAt = nowIso();
    if (status === 'completed') this.completedToday++;
    this.queue.scheduleSave();

    this.batches.update((list) => {
      const b = list.find((x) => x.id === item.batchId);
      if (!b) return;
      if (status === 'completed') b.doneCount++;
      if (status === 'failed') b.failedCount++;
      const remaining = this.queue.data.some((i) => i.batchId === b.id && (i.status === 'pending' || i.status === 'processing'));
      if (!remaining) {
        b.status = b.failedCount === 0 ? 'done' : (b.doneCount > 0 ? 'partial' : 'failed');
        this.frameCachesClear(b.id);
      } else {
        b.status = 'processing';
      }
    });
    this.notifyBatches();
  }

  frameCachesClear(batchId) {
    for (const key of [...this.frameCaches.keys()]) {
      if (key.startsWith(`${batchId}|`)) this.frameCaches.delete(key);
    }
  }

  /* ---------- controls ---------- */

  pause() { this.paused = true; this.pausedReason = 'paused'; this.notifyStatus(); }
  resume() {
    this.paused = false;
    this.pausedReason = null;
    if (this._onlineProbe) { clearInterval(this._onlineProbe); this._onlineProbe = null; }
    this.pump();
  }

  /** Network dropped mid-render: hold the queue and resume when it returns. */
  autoPauseOffline() {
    if (this.paused && this.pausedReason === 'offline') return;
    this.paused = true;
    this.pausedReason = 'offline';
    this.d.log('No internet — engine paused; will resume automatically when the connection returns', 'warning');
    this.notifyStatus();
    if (this._onlineProbe) clearInterval(this._onlineProbe);
    this._onlineProbe = setInterval(() => {
      fetch('https://api.replicate.com/', { method: 'HEAD' })
        .then(() => {
          clearInterval(this._onlineProbe);
          this._onlineProbe = null;
          this.d.log('Connection restored — engine resuming', 'info');
          this.resume();
        })
        .catch(() => { /* still offline */ });
    }, 20000);
  }

  retryFailed() {
    this.queue.update((items) => {
      for (const i of items) {
        if (i.status === 'failed') { i.status = 'pending'; i.retries = 0; i.error = null; }
      }
    });
    this.batches.update((list) => {
      for (const b of list) {
        if (b.status === 'failed' || b.status === 'partial') {
          b.failedCount = 0;
          b.status = 'queued';
        }
      }
    });
    this.notifyBatches();
    this.pump();
  }

  clearCompleted() {
    this.queue.update((items) => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status === 'completed') items.splice(i, 1);
      }
    });
    this.notifyStatus();
  }

  /* ---------- status ---------- */

  status() {
    const q = this.queue.data;
    return {
      pending: q.filter((i) => i.status === 'pending').length,
      processing: q.filter((i) => i.status === 'processing').length,
      completedToday: this.completedToday,
      failed: q.filter((i) => i.status === 'failed').length,
      heldBatches: this.batches.data.filter((b) => b.status === 'held').length,
      spendTodayUsd: Number(this.d.usage.sumToday().toFixed(3)),
      paused: this.paused,
      pausedReason: this.pausedReason ?? null,
      workers: [...this.workers.entries()].map(([lane, w]) => ({
        lane,
        batchId: w.item.batchId,
        file: w.item.baseName,
        person: w.personName,
        stage: w.stageKey,
        stageLabel: w.stageLabel,
        pct: w.pct,
        elapsedMs: Date.now() - w.startedAt,
        status: w.status,
        tone: w.tone,
        flags: w.item.flags ?? [],
      })),
    };
  }

  notifyStatus() {
    // Debounce a little — stage callbacks can be chatty.
    if (this._statusTimer) return;
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      this.d.push('processing-status', this.status());
    }, 150);
  }

  notifyBatches() {
    this.d.push('batches:changed', {});
    this.notifyStatus();
  }
}

module.exports = { Engine };
