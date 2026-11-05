// Playback engine.
//
// Every track (and every pitched double) is one looping AudioBufferSource
// that starts at the same instant and never stops. Arrangements are just gain
// settings, switched with short ramps exactly on loop boundaries, so tracks
// can't drift apart.

import { voiceGain, songCycles, neededDoubles } from './state.js';
import { laneBuffer } from './lanes.js';

const RAMP = 0.006; // seconds; short fade so gain changes don't click
const LOOKAHEAD = 1.2; // seconds of gain changes planned ahead

/** Master chain: gain -> soft limiter -> destination. Returns the input node. */
export function buildMaster(ctx, dest) {
  const gain = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  gain.connect(limiter).connect(dest);
  return gain;
}

/** A voice loops a buffer that is exactly one loop long. */
function makeVoice(ctx, dest, trackId, semitones, buffer, when, offset) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(dest);
  src.start(when, offset);
  return { trackId, semitones, src, gain, planned: 0 };
}

/** One voice per track plus one per ready pitched double, all starting at `when`. */
export function buildVoices(ctx, dest, tracks, project, bank, when) {
  const doubles = neededDoubles(project);
  const voices = [];
  for (const t of tracks) {
    voices.push(makeVoice(ctx, dest, t.id, 0, laneBuffer(t, project), when, 0));
    for (const d of doubles) {
      if (d.trackId !== t.id) continue;
      const buf = bank.get(project, t, d.semitones);
      if (buf) voices.push(makeVoice(ctx, dest, t.id, d.semitones, buf, when, 0));
    }
  }
  return voices;
}

export function setGainsNow(voices, project, arrId) {
  for (const v of voices) {
    v.planned = voiceGain(project, arrId, v.trackId, v.semitones);
    v.gain.gain.value = v.planned;
  }
}

/** Ramp every voice to `arrId`'s gains, arriving exactly at time T. */
export function planGains(voices, project, arrId, T) {
  for (const v of voices) {
    const target = voiceGain(project, arrId, v.trackId, v.semitones);
    if (target === v.planned) continue;
    v.gain.gain.setValueAtTime(v.planned, Math.max(0, T - RAMP));
    v.gain.gain.linearRampToValueAtTime(target, T);
    v.planned = target;
  }
}

export class Engine {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = buildMaster(ctx, ctx.destination);
    this.voices = [];
    this.playing = false;
    this.timer = null;
    this.plan = [{ from: 0, kind: 'loop', arr: 'A' }];
  }

  get L() {
    return this.project.loop.end - this.project.loop.start;
  }

  setMaster(v) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** @param {{mode: 'loop'|'song', arr: string}} opts */
  async start(tracks, project, bank, opts) {
    this.stop();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.tracks = tracks;
    this.project = project;
    this.bank = bank;
    this.plan = [opts.mode === 'song' ? { from: 0, kind: 'song' } : { from: 0, kind: 'loop', arr: opts.arr }];
    this.t0 = this.ctx.currentTime + 0.06;
    this.voices = buildVoices(this.ctx, this.master, tracks, project, bank, this.t0);
    setGainsNow(this.voices, project, this.arrFor(0));
    this.nextCycle = 1;
    this.playing = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 50);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const v of this.voices) {
      try { v.src.stop(); } catch { /* already stopped */ }
      v.src.disconnect();
      v.gain.disconnect();
    }
    this.voices = [];
    this.playing = false;
  }

  tick() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    const L = this.L;
    while (this.t0 + this.nextCycle * L - RAMP < horizon) {
      planGains(this.voices, this.project, this.arrFor(this.nextCycle), this.t0 + this.nextCycle * L);
      this.nextCycle++;
    }
  }

  elapsed() {
    return Math.max(0, this.ctx.currentTime - this.t0);
  }

  currentCycle() {
    return Math.floor(this.elapsed() / this.L);
  }

  planEntry(k) {
    let e = this.plan[0];
    for (const p of this.plan) if (p.from <= k) e = p;
    return e;
  }

  arrFor(k) {
    const e = this.planEntry(k);
    if (e.kind === 'loop') return e.arr;
    const seq = songCycles(this.project);
    return seq[(k - e.from) % seq.length];
  }

  /** Where the song is at cycle k: {step, rep} indices, or null in loop mode. */
  songPosition(k) {
    const e = this.planEntry(k);
    if (e.kind !== 'song') return null;
    const seq = songCycles(this.project);
    let i = (k - e.from) % seq.length;
    for (let s = 0; s < this.project.song.length; s++) {
      const r = this.project.song[s].repeats;
      if (i < r) return { step: s, rep: i, of: r };
      i -= r;
    }
    return null;
  }

  /** Re-apply gains after an edit: now for the current cycle, re-plan the rest. */
  refresh() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const cur = this.currentCycle();
    const arr = this.arrFor(cur);
    for (const v of this.voices) {
      const target = voiceGain(this.project, arr, v.trackId, v.semitones);
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(target, now, 0.012);
      v.planned = target;
    }
    // Keep only the plan entry in effect now plus later ones.
    const keep = this.planEntry(cur);
    this.plan = this.plan.filter((p) => p === keep || p.from > cur);
    this.nextCycle = cur + 1;
    this.tick();
  }

  /** Switch what plays, starting at the next loop boundary. */
  queue(mode, arr) {
    const entry = mode === 'song' ? { kind: 'song' } : { kind: 'loop', arr };
    if (!this.playing) {
      this.plan = [{ from: 0, ...entry }];
      return;
    }
    const from = this.currentCycle() + 1;
    this.plan = this.plan.filter((p) => p.from < from);
    this.plan.push({ from, ...entry });
    this.refresh();
  }

  /** Start voices for doubles that became ready while playing. */
  addMissingVoices() {
    if (!this.playing) return;
    const have = new Set(this.voices.map((v) => `${v.trackId}|${v.semitones}`));
    let added = false;
    for (const d of neededDoubles(this.project)) {
      if (have.has(`${d.trackId}|${d.semitones}`)) continue;
      const track = this.tracks.find((t) => t.id === d.trackId);
      const buf = track && this.bank.get(this.project, track, d.semitones);
      if (!buf) continue;
      const when = Math.max(this.t0, this.ctx.currentTime + 0.03);
      const offset = (when - this.t0) % buf.duration;
      this.voices.push(makeVoice(this.ctx, this.master, d.trackId, d.semitones, buf, when, offset));
      added = true;
    }
    if (added) this.refresh();
  }

  /** Playhead position on the timeline, in seconds. */
  playhead() {
    if (!this.playing) return null;
    return this.project.loop.start + (this.elapsed() % this.L);
  }
}
