// Project model + persistence (localStorage).

export const SEMITONES = [
  { value: 0, label: 'Off' },
  { value: -24, label: '2 octaves down' },
  { value: -12, label: 'Octave down' },
  { value: -7, label: 'Fifth down' },
  { value: -5, label: 'Fourth down' },
  { value: 5, label: 'Fourth up' },
  { value: 7, label: 'Fifth up' },
  { value: 12, label: 'Octave up' },
  { value: 24, label: '2 octaves up' },
];

export const TRACK_COLORS = ['#f5a524', '#5ac8fa', '#ff6b8b', '#7bd88f', '#b39bff', '#ffd166', '#4dd4c6', '#ff8f5a'];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PREFIX = 'loop:project:';
const RECENT_KEY = 'loop:recent';

const safe = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};
export const storage = safe;

export const defaultMix = () => ({ on: true, volume: 1, double: { semitones: 0, volume: 0.7 } });

/** Snap a time to the nearest sample frame. */
export const quantize = (t, sr) => Math.round(t * sr) / sr;

function guessMultiples(tracks, base) {
  const mult = {};
  for (const t of tracks) {
    const r = t.buffer.duration / base;
    let m = 1;
    for (const c of [8, 4, 2]) {
      if (r >= c * 0.99 && Math.abs(r - c) / c < 0.02) { m = c; break; }
    }
    mult[t.id] = m;
  }
  return mult;
}

export function createProject(sourceKey, tracks) {
  const sr = tracks[0].buffer.sampleRate;
  const base = Math.min(...tracks.map((t) => t.buffer.duration));
  const mixA = {};
  for (const t of tracks) mixA[t.id] = defaultMix();
  return {
    version: 1,
    sourceKey,
    loop: { start: 0, end: quantize(base, sr) },
    mult: guessMultiples(tracks, base),
    bpm: null,
    beatsPerBar: 4,
    snap: false,
    loopConfirmed: false,
    askedForB: false,
    arrangements: [{ id: 'A', name: 'A', mix: mixA }],
    song: [{ arr: 'A', repeats: 4 }],
  };
}

/** Make a saved project consistent with the tracks that actually loaded. */
export function reconcile(project, tracks) {
  const sr = tracks[0].buffer.sampleRate;
  const maxDur = Math.max(...tracks.map((t) => t.buffer.duration));
  project.mult ||= {};
  for (const t of tracks) {
    if (!project.mult[t.id]) project.mult[t.id] = 1;
    for (const a of project.arrangements) {
      a.mix[t.id] = { ...defaultMix(), ...(a.mix[t.id] || {}) };
      a.mix[t.id].double = { ...defaultMix().double, ...(a.mix[t.id].double || {}) };
    }
  }
  const { start, end } = project.loop;
  if (!(start >= 0) || !(end > start) || end > maxDur + 1e-6) {
    project.loop = createProject(project.sourceKey, tracks).loop;
  }
  project.loop.start = quantize(project.loop.start, sr);
  project.loop.end = quantize(project.loop.end, sr);
  clampMultiples(project, tracks);
  const ids = new Set(project.arrangements.map((a) => a.id));
  project.song = (project.song || []).filter((s) => ids.has(s.arr));
  if (!project.song.length) project.song = [{ arr: project.arrangements[0].id, repeats: 4 }];
  return project;
}

/** Longest multiple of the loop that still fits inside a track. */
export function maxMultiple(project, track) {
  const L = project.loop.end - project.loop.start;
  const room = track.buffer.duration - project.loop.start;
  let m = 1;
  for (const c of [2, 4, 8]) if (c * L <= room + 1e-6) m = c;
  return m;
}

export function clampMultiples(project, tracks) {
  for (const t of tracks) {
    const max = maxMultiple(project, t);
    if ((project.mult[t.id] || 1) > max) project.mult[t.id] = max;
  }
}

/** Latest allowed loop end for the current start and multiples. */
export function maxLoopEnd(project, tracks) {
  const s = project.loop.start;
  return Math.min(...tracks.map((t) => s + (t.buffer.duration - s) / (project.mult[t.id] || 1)));
}

export function loadProject(sourceKey) {
  const p = safe.get(PREFIX + sourceKey);
  return p && p.version === 1 ? p : null;
}

export function saveProject(project) {
  safe.set(PREFIX + project.sourceKey, project);
}

export function nextArrangementId(project) {
  const used = new Set(project.arrangements.map((a) => a.id));
  for (const l of LETTERS) if (!used.has(l)) return l;
  return 'X' + project.arrangements.length;
}

export function duplicateArrangement(project, fromId) {
  const from = project.arrangements.find((a) => a.id === fromId) || project.arrangements[0];
  const id = nextArrangementId(project);
  const arr = { id, name: id, mix: structuredClone(from.mix) };
  project.arrangements.push(arr);
  return arr;
}

export function getArrangement(project, id) {
  return project.arrangements.find((a) => a.id === id) || project.arrangements[0];
}

/** Gain for one voice (original = semitones 0, or a pitched double). */
export function voiceGain(project, arrId, trackId, semitones) {
  const mix = getArrangement(project, arrId).mix[trackId];
  if (!mix || !mix.on) return 0;
  if (semitones === 0) return mix.volume;
  return mix.double.semitones === semitones ? mix.double.volume : 0;
}

/** Every [trackId, semitones] double used by any arrangement. */
export function neededDoubles(project) {
  const set = new Map();
  for (const a of project.arrangements) {
    for (const [trackId, mix] of Object.entries(a.mix)) {
      const s = mix.double?.semitones;
      if (s) set.set(`${trackId}|${s}`, { trackId, semitones: s });
    }
  }
  return [...set.values()];
}

/** Song as a flat list of arrangement ids, one per loop cycle. */
export function songCycles(project) {
  const out = [];
  for (const step of project.song) for (let i = 0; i < step.repeats; i++) out.push(step.arr);
  return out.length ? out : [project.arrangements[0].id];
}

export function recentList() {
  return safe.get(RECENT_KEY) || [];
}

export function addRecent(entry) {
  const list = recentList().filter((r) => r.sourceKey !== entry.sourceKey);
  list.unshift({ ...entry, when: Date.now() });
  safe.set(RECENT_KEY, list.slice(0, 8));
}

export function removeRecent(sourceKey) {
  safe.set(RECENT_KEY, recentList().filter((r) => r.sourceKey !== sourceKey));
}

export function formatTime(sec, decimals = 3) {
  if (!Number.isFinite(sec)) return '–';
  const sign = sec < 0 ? '-' : '';
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${sign}${m}:${s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}`;
}
