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

export function createProject(sourceKey, tracks) {
  const sr = tracks[0].buffer.sampleRate;
  // Default loop = the longest track; shorter tracks repeat to fill it.
  const longest = Math.max(...tracks.map((t) => t.buffer.duration));
  const mixA = {};
  for (const t of tracks) mixA[t.id] = defaultMix();
  return {
    version: 1,
    sourceKey,
    loop: { start: 0, end: quantize(longest, sr) },
    names: {},
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
  project.names ||= {};
  for (const t of tracks) {
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
  const ids = new Set(project.arrangements.map((a) => a.id));
  project.song = (project.song || []).filter((s) => ids.has(s.arr));
  if (!project.song.length) project.song = [{ arr: project.arrangements[0].id, repeats: 4 }];
  return project;
}

/** Latest allowed loop end: the end of the longest track. */
export function maxLoopEnd(tracks) {
  return Math.max(...tracks.map((t) => t.buffer.duration));
}

/** Name shown for a track: the user's name for it, or its file name. */
export function trackName(project, track) {
  return (project.names && project.names[track.id]) || track.short;
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
