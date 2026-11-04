// Stacked waveform timeline with draggable loop start/end handles.

import { TRACK_COLORS, quantize, maxLoopEnd, formatTime } from './state.js';

const RULER = 26;
const HANDLE_HIT = 28; // px, generous for touch
const MIN_LOOP = 0.05;
const BLOCK = 256; // samples per peak block

function computePeaks(buffer) {
  const n = Math.ceil(buffer.length / BLOCK);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  for (let b = 0; b < n; b++) {
    let lo = 0, hi = 0;
    const s0 = b * BLOCK, s1 = Math.min(buffer.length, s0 + BLOCK);
    for (const ch of chs) {
      for (let i = s0; i < s1; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class Timeline {
  /**
   * @param {{canvas: HTMLCanvasElement, labels: HTMLElement,
   *   onInput: () => void, onCommit: () => void, onMult: (id: string, m: number) => void}} opts
   */
  constructor(opts) {
    this.canvas = opts.canvas;
    this.labels = opts.labels;
    this.opts = opts;
    this.ctx2d = this.canvas.getContext('2d');
    this.wave = document.createElement('canvas');
    this.view = { t0: 0, t1: 1 };
    this.drag = null;
    this.active = 'end';
    this.laneH = 56;
    this.tracks = [];
    this.playheads = null;
    this.waveDirty = true;

    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', () => this.onUp());
    this.canvas.addEventListener('pointercancel', () => this.onUp());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('keydown', (e) => this.onKey(e));
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.invalidate());
  }

  setData(tracks, project) {
    this.tracks = tracks.map((t, i) => ({ ...t, color: TRACK_COLORS[i % TRACK_COLORS.length], peaks: t.peaks || (t.peaks = computePeaks(t.buffer)) }));
    this.project = project;
    this.duration = Math.max(...tracks.map((t) => t.buffer.duration));
    this.sr = tracks[0].buffer.sampleRate;
    this.renderLabels();
    this.fit();
  }

  renderLabels() {
    this.labels.innerHTML = '';
    for (const t of this.tracks) {
      const row = document.createElement('div');
      row.className = 'lane-label';
      row.style.setProperty('--c', t.color);
      row.style.height = this.laneH + 'px';
      row.innerHTML = `<span class="lane-name" title="${escapeHtml(t.name)}"><span class="dot"></span>${escapeHtml(t.short)}</span>`;
      const sel = document.createElement('select');
      sel.className = 'mult';
      sel.setAttribute('aria-label', `${t.name} length in loops`);
      sel.title = 'Track length, in loops';
      row.appendChild(sel);
      sel.addEventListener('change', () => this.opts.onMult(t.id, Number(sel.value)));
      t.multSelect = sel;
      this.labels.appendChild(row);
    }
    this.updateMultOptions();
  }

  updateMultOptions() {
    const L = this.project.loop.end - this.project.loop.start;
    for (const t of this.tracks) {
      const room = t.buffer.duration - this.project.loop.start;
      const cur = this.project.mult[t.id] || 1;
      t.multSelect.innerHTML = [1, 2, 4, 8]
        .filter((m) => m === 1 || m * L <= room + 1e-6 || m === cur)
        .map((m) => `<option value="${m}" ${m === cur ? 'selected' : ''}>×${m}</option>`)
        .join('');
    }
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth;
    this.laneH = w < 560 ? 52 : 64;
    for (const row of this.labels.children) row.style.height = this.laneH + 'px';
    const h = RULER + this.laneH * this.tracks.length;
    const dpr = window.devicePixelRatio || 1;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.wave.width = this.canvas.width;
    this.wave.height = this.canvas.height;
    this.invalidate();
  }

  invalidate() {
    this.waveDirty = true;
    this.draw();
  }

  // --- view -----------------------------------------------------------
  x(t) { return ((t - this.view.t0) / (this.view.t1 - this.view.t0)) * this.w; }
  t(x) { return this.view.t0 + (x / this.w) * (this.view.t1 - this.view.t0); }

  setView(t0, t1) {
    const span = Math.min(this.duration, Math.max(0.02, t1 - t0));
    t0 = Math.max(0, Math.min(this.duration - span, t0));
    this.view = { t0, t1: t0 + span };
    this.invalidate();
  }

  fit() { this.setView(0, this.duration); }
  zoom(f, at) {
    const c = at ?? this.project.loop[this.active];
    const { t0, t1 } = this.view;
    const span = (t1 - t0) / f;
    const r = (c - t0) / (t1 - t0);
    this.setView(c - span * Math.min(1, Math.max(0, r)), c - span * Math.min(1, Math.max(0, r)) + span);
  }
  focus(which) {
    this.active = which;
    const c = this.project.loop[which];
    this.setView(c - 0.25, c + 0.25);
  }

  // --- interaction ----------------------------------------------------
  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    const { x } = this.pos(e);
    const ds = Math.abs(x - this.x(this.project.loop.start));
    const de = Math.abs(x - this.x(this.project.loop.end));
    const which = de <= ds ? 'end' : 'start';
    if (Math.min(ds, de) <= HANDLE_HIT) {
      this.drag = { kind: 'handle', which, dx: x - this.x(this.project.loop[which]) };
      this.active = which;
    } else {
      this.drag = { kind: 'pan', x, view: { ...this.view } };
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
  }

  onMove(e) {
    const { x } = this.pos(e);
    if (!this.drag) {
      const near = Math.min(Math.abs(x - this.x(this.project.loop.start)), Math.abs(x - this.x(this.project.loop.end)));
      this.canvas.style.cursor = near <= 10 ? 'ew-resize' : 'grab';
      return;
    }
    if (this.drag.kind === 'pan') {
      const dt = ((x - this.drag.x) / this.w) * (this.view.t1 - this.view.t0);
      this.setView(this.drag.view.t0 - dt, this.drag.view.t1 - dt);
      return;
    }
    this.setHandle(this.drag.which, this.t(x - this.drag.dx), true);
  }

  onUp() {
    if (!this.drag) return;
    const wasHandle = this.drag.kind === 'handle';
    this.drag = null;
    if (wasHandle) this.opts.onCommit();
  }

  onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const { x } = this.pos(e);
      this.zoom(Math.exp(-e.deltaY * 0.01), this.t(x));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const dt = (e.deltaX / this.w) * (this.view.t1 - this.view.t0);
      this.setView(this.view.t0 + dt, this.view.t1 + dt);
    }
  }

  onKey(e) {
    const step = e.shiftKey ? 0.01 : 0.001;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -step : step;
      this.setHandle(this.active, this.project.loop[this.active] + d, false);
      this.opts.onCommit();
    } else if (e.key === '[' || e.key === ']') {
      this.active = e.key === '[' ? 'start' : 'end';
      this.draw();
    }
  }

  /** Move a handle, applying limits and snapping. `live` = mid-drag. */
  setHandle(which, t, live) {
    const p = this.project;
    if (p.snap && p.bpm > 0) {
      const beat = 60 / p.bpm;
      t = Math.round(t / beat) * beat;
    }
    t = quantize(t, this.sr);
    if (which === 'start') {
      t = Math.max(0, Math.min(t, p.loop.end - MIN_LOOP));
      const oldStart = p.loop.start;
      p.loop.start = t;
      if (p.loop.end > maxLoopEnd(p, this.tracks)) p.loop.start = oldStart;
    } else {
      t = Math.max(p.loop.start + MIN_LOOP, Math.min(t, maxLoopEnd(p, this.tracks)));
      p.loop.end = quantize(t, this.sr);
    }
    if (live) this.opts.onInput();
    this.draw();
  }

  // --- drawing --------------------------------------------------------
  drawWaves() {
    const g = this.wave.getContext('2d');
    const { dpr, w } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const { t0, t1 } = this.view;
    const spp = ((t1 - t0) * this.sr) / w; // samples per pixel
    this.tracks.forEach((t, i) => {
      const y0 = RULER + i * this.laneH;
      const mid = y0 + this.laneH / 2;
      const amp = this.laneH / 2 - 6;
      g.fillStyle = t.color;
      const chs = [];
      if (spp < BLOCK) for (let c = 0; c < t.buffer.numberOfChannels; c++) chs.push(t.buffer.getChannelData(c));
      for (let px = 0; px < w; px++) {
        const s0 = Math.floor((t0 + (px / w) * (t1 - t0)) * this.sr);
        const s1 = Math.max(s0 + 1, Math.floor((t0 + ((px + 1) / w) * (t1 - t0)) * this.sr));
        if (s0 >= t.buffer.length || s1 <= 0) continue;
        let lo = 0, hi = 0;
        if (spp >= BLOCK) {
          const b0 = Math.floor(s0 / BLOCK), b1 = Math.min(t.peaks.min.length, Math.ceil(s1 / BLOCK));
          for (let b = b0; b < b1; b++) {
            if (t.peaks.min[b] < lo) lo = t.peaks.min[b];
            if (t.peaks.max[b] > hi) hi = t.peaks.max[b];
          }
        } else {
          const e = Math.min(t.buffer.length, s1 + 1);
          for (const ch of chs) for (let s = Math.max(0, s0); s < e; s++) {
            if (ch[s] < lo) lo = ch[s];
            if (ch[s] > hi) hi = ch[s];
          }
        }
        const top = mid - Math.min(1, hi) * amp;
        const bot = mid - Math.max(-1, lo) * amp;
        g.fillRect(px, top, 1, Math.max(1, bot - top));
      }
    });
    this.waveDirty = false;
  }

  draw() {
    if (!this.w || !this.project) return;
    if (this.waveDirty) this.drawWaves();
    const g = this.ctx2d;
    const { dpr, w, h } = this;
    const p = this.project;
    const col = {
      bg: css('--lane-bg'), line: css('--line'), text: css('--text-2'), dim: css('--dim'),
      start: css('--handle-start'), end: css('--handle-end'), loop: css('--loop-tint'), head: css('--text-1'),
    };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // lanes
    this.tracks.forEach((t, i) => {
      g.fillStyle = col.bg;
      g.fillRect(0, RULER + i * this.laneH + 1, w, this.laneH - 2);
    });
    const xs = this.x(p.loop.start), xe = this.x(p.loop.end);
    g.fillStyle = col.loop;
    g.fillRect(xs, RULER, xe - xs, h - RULER);

    // tracks that run 2x/4x the loop: show their extra length
    const L = p.loop.end - p.loop.start;
    this.tracks.forEach((t, i) => {
      const m = p.mult[t.id] || 1;
      if (m > 1) {
        g.fillStyle = col.loop;
        g.fillRect(xe, RULER + i * this.laneH + 1, this.x(p.loop.start + L * m) - xe, this.laneH - 2);
      }
    });

    g.drawImage(this.wave, 0, 0, w, h);

    // dim everything outside each track's loop
    g.fillStyle = col.dim;
    this.tracks.forEach((t, i) => {
      const y = RULER + i * this.laneH;
      const endX = this.x(p.loop.start + L * (p.mult[t.id] || 1));
      if (xs > 0) g.fillRect(0, y, xs, this.laneH);
      if (endX < w) g.fillRect(endX, y, w - endX, this.laneH);
    });

    this.drawRuler(g, col);

    // handles
    for (const which of ['start', 'end']) {
      const x = Math.round(this.x(p.loop[which])) + 0.5;
      if (x < -20 || x > w + 20) continue;
      const c = which === 'start' ? col.start : col.end;
      g.strokeStyle = c;
      g.lineWidth = this.active === which ? 2 : 1.5;
      g.beginPath();
      g.moveTo(x, RULER - 4);
      g.lineTo(x, h);
      g.stroke();
      g.fillStyle = c;
      g.beginPath();
      if (which === 'start') {
        g.moveTo(x, 4); g.lineTo(x + 12, 4); g.lineTo(x + 12, RULER - 8); g.lineTo(x, RULER - 2);
      } else {
        g.moveTo(x, 4); g.lineTo(x - 12, 4); g.lineTo(x - 12, RULER - 8); g.lineTo(x, RULER - 2);
      }
      g.closePath();
      g.fill();
    }

    // playheads
    if (this.playheads) {
      g.strokeStyle = col.head;
      g.lineWidth = 1.5;
      this.tracks.forEach((t, i) => {
        const ph = this.playheads[t.id];
        if (ph == null) return;
        const x = Math.round(this.x(ph)) + 0.5;
        g.beginPath();
        g.moveTo(x, RULER + i * this.laneH + 2);
        g.lineTo(x, RULER + (i + 1) * this.laneH - 2);
        g.stroke();
      });
    }
  }

  drawRuler(g, col) {
    const { w } = this;
    const { t0, t1 } = this.view;
    const span = t1 - t0;
    const p = this.project;
    g.fillStyle = css('--surface');
    g.fillRect(0, 0, w, RULER);
    g.strokeStyle = col.line;
    g.beginPath();
    g.moveTo(0, RULER - 0.5);
    g.lineTo(w, RULER - 0.5);
    g.stroke();

    // beat grid when a tempo is set
    if (p.bpm > 0) {
      const beat = 60 / p.bpm;
      if ((beat / span) * w >= 6) {
        const bpb = p.beatsPerBar || 4;
        for (let b = Math.ceil(t0 / beat); b * beat <= t1; b++) {
          const x = Math.round(this.x(b * beat)) + 0.5;
          g.strokeStyle = col.line;
          g.globalAlpha = b % bpb === 0 ? 0.9 : 0.4;
          g.beginPath();
          g.moveTo(x, b % bpb === 0 ? RULER - 10 : RULER - 5);
          g.lineTo(x, this.h);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
    }

    const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => (s / span) * w >= 70) || 60;
    const dec = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
    g.fillStyle = col.text;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'middle';
    for (let k = Math.ceil(t0 / step); k * step <= t1; k++) {
      const x = Math.round(this.x(k * step)) + 0.5;
      g.strokeStyle = col.line;
      g.beginPath();
      g.moveTo(x, RULER - 6);
      g.lineTo(x, RULER);
      g.stroke();
      g.fillText(formatTime(k * step, dec), x + 3, RULER / 2 - 1);
    }
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
