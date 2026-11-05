// Builds and caches pitch-shifted copies of each track's lane.

import { loopRegion, laneChannels, makeBuffer } from './lanes.js';

const SEMIS = [-24, -12, -7, -5, 5, 7, 12, 24];

export class PitchBank {
  constructor() {
    this.cache = new Map(); // key -> AudioBuffer
    this.pending = new Map(); // key -> Promise<AudioBuffer>
    this.jobs = new Map();
    this.nextId = 1;
    this.worker = null;
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./pitch-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const job = this.jobs.get(e.data.id);
      if (!job) return;
      this.jobs.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data.channels);
    };
    this.worker.onerror = (e) => {
      for (const job of this.jobs.values()) job.reject(new Error(e.message || 'Pitch worker failed'));
      this.jobs.clear();
      this.worker = null;
    };
  }

  key(project, track, semitones) {
    const r = loopRegion(project, track.buffer.sampleRate);
    return `${track.id}|${semitones}|${r.start}|${r.frames}`;
  }

  get(project, track, semitones) {
    return this.cache.get(this.key(project, track, semitones));
  }

  has(project, track, semitones) {
    return this.cache.has(this.key(project, track, semitones));
  }

  /** @returns {Promise<AudioBuffer>} */
  ensure(project, track, semitones) {
    const key = this.key(project, track, semitones);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.pending.has(key)) return this.pending.get(key);
    this.ensureWorker();
    const sr = track.buffer.sampleRate;
    const channels = laneChannels(track, loopRegion(project, sr));
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ id, channels, semitones }, channels.map((c) => c.buffer));
    })
      .then((out) => {
        const ab = makeBuffer(out, sr);
        this.cache.set(key, ab);
        return ab;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /** Drop cached buffers that don't match the current loop. */
  prune(project, tracks) {
    const keep = new Set();
    for (const t of tracks) for (const s of SEMIS) keep.add(this.key(project, t, s));
    for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
  }
}
