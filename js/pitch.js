// Builds and caches pitch-shifted copies of each track's loop region.

export class PitchBank {
  constructor(ctx) {
    this.ctx = ctx;
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

  /** Region of a track that a voice loops over, in sample frames. */
  static region(project, track) {
    const sr = track.buffer.sampleRate;
    const start = Math.round(project.loop.start * sr);
    const base = Math.round(project.loop.end * sr) - start;
    const frames = Math.min(base * (project.mult[track.id] || 1), track.buffer.length - start);
    return { start, frames };
  }

  key(track, semitones, region) {
    return `${track.id}|${semitones}|${region.start}|${region.frames}`;
  }

  get(project, track, semitones) {
    return this.cache.get(this.key(track, semitones, PitchBank.region(project, track)));
  }

  has(project, track, semitones) {
    return this.cache.has(this.key(track, semitones, PitchBank.region(project, track)));
  }

  /** @returns {Promise<AudioBuffer>} */
  ensure(project, track, semitones) {
    const region = PitchBank.region(project, track);
    const key = this.key(track, semitones, region);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.pending.has(key)) return this.pending.get(key);
    this.ensureWorker();
    const buf = track.buffer;
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      channels.push(buf.getChannelData(c).slice(region.start, region.start + region.frames));
    }
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ id, channels, semitones }, channels.map((c) => c.buffer));
    })
      .then((out) => {
        const ab = this.ctx.createBuffer(out.length, region.frames, buf.sampleRate);
        out.forEach((ch, i) => ab.copyToChannel(ch, i));
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
    for (const t of tracks) {
      const r = PitchBank.region(project, t);
      for (const s of [-24, -12, -7, -5, 5, 7, 12, 24]) keep.add(this.key(t, s, r));
    }
    for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
  }
}
