import { DEFAULT_DRIVE_API_KEY } from './config.js';
import { parseDriveLinks, resolveDriveSource, downloadFile, isAudioFile } from './drive.js';
import * as cache from './cache.js';
import { Engine } from './engine.js';
import { PitchBank } from './pitch.js';
import { Timeline, escapeHtml } from './timeline.js';
import { renderPass, passToWav } from './render.js';
import {
  SEMITONES, TRACK_COLORS, storage, createProject, reconcile, loadProject, saveProject,
  duplicateArrangement, getArrangement, neededDoubles, songCycles, addRecent, recentList,
  removeRecent, formatTime, quantize, clampMultiples, maxLoopEnd,
} from './state.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const app = {
  ctx: null,
  engine: null,
  bank: null,
  tracks: [],
  project: null,
  name: '',
  source: null, // { kind: 'drive', link } | { kind: 'local' }
  editing: 'A',
  mode: 'loop',
  busy: new Set(),
  raf: 0,
  wakeLock: null,
  roadUrl: null,
};

// --- helpers ---------------------------------------------------------------

const API_KEY = 'loop:apiKey';
const BUILT_IN_KEY = Boolean(DEFAULT_DRIVE_API_KEY);
// A key built into the site always wins, so visitors never deal with keys.
const apiKey = () => DEFAULT_DRIVE_API_KEY || storage.get(API_KEY) || '';

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const save = debounce(() => app.project && saveProject(app.project), 200);

function shortName(name) {
  return name.replace(/\.[a-z0-9]{2,4}$/i, '');
}

function fmtBytes(n) {
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function ensureAudio() {
  if (!app.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    app.ctx = new AC({ latencyHint: 'playback' });
    app.engine = new Engine(app.ctx);
    app.bank = new PitchBank(app.ctx);
    app.engine.setMaster(Number($('#master').value));
  }
  try {
    // iOS: play even when the ringer switch is on silent.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* unsupported */ }
  return app.ctx;
}

// --- loading ---------------------------------------------------------------

const progress = {
  el: () => $('#load-progress'),
  start(title) {
    const el = this.el();
    el.hidden = false;
    el.innerHTML = `<p class="progress-title">${escapeHtml(title)}</p>`;
  },
  files(files) {
    const el = this.el();
    el.innerHTML = `<p class="progress-title">Loading ${files.length} track${files.length === 1 ? '' : 's'}</p>` +
      files.map((f, i) => `<div class="progress-row" data-i="${i}"><span class="name">${escapeHtml(f.name)}</span><span class="pct">0%</span><span class="bar"><i></i></span></div>`).join('');
  },
  update(i, p, label) {
    const row = $(`.progress-row[data-i="${i}"]`, this.el());
    if (!row) return;
    $('.pct', row).textContent = label || `${Math.round(p * 100)}%`;
    $('.bar > i', row).style.width = `${Math.round(p * 100)}%`;
  },
  hide() { this.el().hidden = true; },
};

function showLoadError(msg) {
  const el = $('#load-error');
  el.textContent = msg;
  el.hidden = !msg;
}

function setLoading(on) {
  $('#btn-load').disabled = on;
  $('#btn-load').textContent = on ? 'Loading…' : 'Load tracks';
  $('#file-input').disabled = on;
}

async function decode(bytes, name) {
  try {
    return await app.ctx.decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error(`Couldn’t read “${name}”. Export it as WAV or MP3 and try again.`);
  }
}

async function loadDrive(text) {
  showLoadError('');
  const links = parseDriveLinks(text);
  if (!links.length) {
    showLoadError('That doesn’t look like a Google Drive link. In Drive, select Share → Copy link on the folder, then paste it here.');
    return;
  }
  const key = apiKey();
  if (!key) {
    showLoadError('Add your Google Drive API key in Settings, then select Load tracks again.');
    openSettings();
    return;
  }
  ensureAudio();
  const sourceKey = 'drive:' + links.map((l) => l.id).join(',');
  const manifestKey = 'loop:manifest:' + sourceKey;
  setLoading(true);
  progress.start('Finding tracks…');
  try {
    let src;
    try {
      src = await resolveDriveSource(links, key);
      storage.set(manifestKey, src);
    } catch (e) {
      src = e.code === 'network' ? storage.get(manifestKey) : null;
      if (!src) throw e;
      toast('You’re offline. Using the tracks saved on this device.');
    }
    const files = src.files
      .filter(isAudioFile)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    if (!files.length) {
      throw new Error('No audio files in that folder. Check the tracks are inside the folder you shared, not in a subfolder.');
    }
    if (files.length > 12) throw new Error(`That folder has ${files.length} audio files. Put just the loop’s tracks (up to 12) in their own folder.`);
    progress.files(files);
    const tracks = await mapLimit(files, 3, async (f, i) => {
      const ck = `drive:${f.id}:${f.modifiedTime || ''}:${f.size || ''}`;
      let bytes = await cache.get(ck);
      if (bytes) progress.update(i, 1, 'saved');
      else {
        bytes = await downloadFile(f, key, (p) => progress.update(i, p));
        cache.put(ck, bytes);
      }
      const buffer = await decode(bytes, f.name);
      progress.update(i, 1, 'ready');
      return { id: f.id, name: f.name, buffer };
    });
    openProject(sourceKey, src.name, tracks, { kind: 'drive', link: text.trim() });
    addRecent({ sourceKey, name: src.name, link: text.trim(), count: tracks.length });
  } catch (e) {
    let msg = e.message || String(e);
    if (BUILT_IN_KEY && ['key', 'key-referrer', 'api-disabled'].includes(e.code)) {
      // Visitors can't fix the site's key, so don't send them to Settings.
      msg = 'Loop Road can’t connect to Google Drive right now. Try again later, or open the files from your device below.';
      console.error('Drive key problem:', e.code, e.message);
    }
    showLoadError(msg);
    progress.hide();
  } finally {
    setLoading(false);
  }
}

async function loadLocal(fileList) {
  showLoadError('');
  const files = [...fileList]
    .filter((f) => isAudioFile({ name: f.name, mimeType: f.type }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (!files.length) {
    showLoadError('Those files aren’t audio. Choose the WAV or MP3 tracks you exported from your looper.');
    return;
  }
  ensureAudio();
  setLoading(true);
  progress.files(files);
  try {
    const tracks = await mapLimit(files, 3, async (f, i) => {
      const buffer = await decode(await f.arrayBuffer(), f.name);
      progress.update(i, 1, 'ready');
      return { id: `file:${f.name}:${f.size}`, name: f.name, buffer };
    });
    const sourceKey = 'local:' + files.map((f) => `${f.name}:${f.size}`).join('|');
    openProject(sourceKey, files.length > 1 ? 'Tracks from this device' : files[0].name, tracks, { kind: 'local' });
  } catch (e) {
    showLoadError(e.message || String(e));
    progress.hide();
  } finally {
    setLoading(false);
    $('#file-input').value = '';
  }
}

function openProject(sourceKey, name, tracks, source) {
  app.engine.stop();
  tracks.forEach((t) => (t.short = shortName(t.name)));
  const saved = loadProject(sourceKey);
  const project = saved ? reconcile(saved, tracks) : createProject(sourceKey, tracks);
  Object.assign(app, { project, tracks, name, source, editing: project.arrangements[0].id, mode: 'loop' });
  saveProject(project);

  if (source.kind === 'drive') {
    history.replaceState(null, '', '#' + new URLSearchParams({ drive: source.link }).toString());
  }
  progress.hide();
  $('#screen-load').hidden = true;
  $('#screen-studio').hidden = false;
  $('#transport').hidden = false;
  $('#project-name').textContent = name;
  const sr = tracks[0].buffer.sampleRate;
  $('#project-meta').textContent = `${tracks.length} tracks · ${(sr / 1000).toFixed(1)} kHz`;
  timeline.setData(tracks, project);
  syncTempoFields();
  renderAll();
  setPlayingUI(false);
  ensureDoubles();
  window.scrollTo({ top: 0 });
}

function closeProject() {
  stopPlayback();
  app.project = null;
  history.replaceState(null, '', location.pathname + location.search);
  $('#screen-studio').hidden = true;
  $('#transport').hidden = true;
  $('#screen-load').hidden = false;
  renderRecent();
}

// --- loop card -------------------------------------------------------------

const timeline = new Timeline({
  canvas: $('#tl-canvas'),
  labels: $('#lane-labels'),
  onInput: () => renderLoopFields(),
  onCommit: () => commitLoop(),
  onMult: (id, m) => {
    app.project.mult[id] = m;
    const max = maxLoopEnd(app.project, app.tracks);
    if (app.project.loop.end > max) app.project.loop.end = quantize(max, app.tracks[0].buffer.sampleRate);
    commitLoop();
    timeline.draw();
  },
});

function renderLoopFields() {
  const { start, end } = app.project.loop;
  const L = end - start;
  if (document.activeElement !== $('#loop-start')) $('#loop-start').value = start.toFixed(3);
  if (document.activeElement !== $('#loop-end')) $('#loop-end').value = end.toFixed(3);
  const p = app.project;
  let txt = formatTime(L);
  if (p.bpm > 0) {
    const beats = (L * p.bpm) / 60;
    const bars = beats / (p.beatsPerBar || 4);
    txt += ` · ${+bars.toFixed(2)} bars`;
  }
  $('#loop-length').textContent = txt;
  $('#tempo-guess').textContent = p.bpm > 0 ? `${+p.bpm.toFixed(2)} BPM` : guessTempo(L);
}

function guessTempo(L) {
  const bpb = app.project.beatsPerBar || 4;
  for (const bars of [1, 2, 4, 8, 16]) {
    const bpm = (bars * bpb * 60) / L;
    if (bpm >= 70 && bpm <= 170) return `≈ ${bpm.toFixed(1)} BPM if ${bars} bar${bars > 1 ? 's' : ''}`;
  }
  return '';
}

function syncTempoFields() {
  const p = app.project;
  $('#bpm').value = p.bpm || '';
  $('#bpb').value = p.beatsPerBar || 4;
  $('#snap').checked = !!p.snap;
}

const restartSoon = debounce(async () => {
  if (!app.engine.playing) return;
  await ensureDoubles();
  if (app.engine.playing) startPlayback(true);
}, 250);

function commitLoop() {
  clampMultiples(app.project, app.tracks);
  timeline.updateMultOptions();
  renderLoopFields();
  renderSummary();
  renderSongLength();
  app.bank.prune(app.project, app.tracks);
  save();
  restartSoon();
  if (!app.engine.playing) ensureDoubles();
}

function renderSummary() {
  const { start, end } = app.project.loop;
  $('#loop-summary').textContent = `${formatTime(start)} → ${formatTime(end)} · ${formatTime(end - start)} long`;
}

function nudge(dir) {
  const which = timeline.active;
  const sel = $('#nudge-step').value;
  const sr = app.tracks[0].buffer.sampleRate;
  let step;
  if (sel === 'sample') step = 1 / sr;
  else if (sel === 'beat') {
    if (!(app.project.bpm > 0)) {
      toast('Set a BPM under Tempo & bars first.');
      $('#tempo').open = true;
      return;
    }
    step = 60 / app.project.bpm;
  } else step = Number(sel);
  const snap = app.project.snap;
  app.project.snap = false; // nudges are exact
  timeline.setHandle(which, app.project.loop[which] + dir * step, false);
  app.project.snap = snap;
  commitLoop();
}

function setNudgeTarget(which) {
  timeline.active = which;
  $$('[data-nudge-target]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nudgeTarget === which)));
  timeline.draw();
}

// --- arrangements ----------------------------------------------------------

function renderTabs() {
  const p = app.project;
  $('#arr-tabs').innerHTML = p.arrangements
    .map((a) => `<button type="button" role="tab" class="tab" data-arr="${a.id}" aria-selected="${a.id === app.editing}">${escapeHtml(a.name)}<span class="live" hidden></span></button>`)
    .join('');
  $('#new-arr-from').textContent = getArrangement(p, app.editing).name;
  $('#del-arr-name').textContent = getArrangement(p, app.editing).name;
  $('#btn-delete-arr').hidden = p.arrangements.length < 2;
  const name = getArrangement(p, app.editing).name;
  $('#arr-hint').textContent = app.mode === 'song'
    ? `Editing ${name}. Song mode plays arrangements in song order.`
    : `Editing ${name}. Loop mode plays the selected arrangement.`;
}

function volPct(v) {
  return `${Math.round(v * 100)}%`;
}

function renderMixer() {
  const arr = getArrangement(app.project, app.editing);
  $('#mixer').innerHTML = app.tracks.map((t, i) => {
    const m = arr.mix[t.id];
    const c = TRACK_COLORS[i % TRACK_COLORS.length];
    const dbl = m.double.semitones;
    const busy = app.busy.has(`${t.id}|${dbl}`);
    return `<div class="mix-row ${m.on ? '' : 'off'}" data-id="${escapeHtml(t.id)}" style="--c:${c}">
      <div class="mix-name"><span class="dot"></span><span title="${escapeHtml(t.name)}">${escapeHtml(t.short)}</span></div>
      <button type="button" class="mute" data-k="on" aria-pressed="${m.on}" aria-label="${escapeHtml(t.short)} on">${m.on ? 'On' : 'Off'}</button>
      <label class="mix-vol"><span>Vol</span><input type="range" data-k="volume" min="0" max="1.5" step="0.01" value="${m.volume}" aria-label="${escapeHtml(t.short)} volume"><output>${volPct(m.volume)}</output></label>
      <div class="mix-double">
        <select data-k="semitones" aria-label="${escapeHtml(t.short)} pitch double">
          ${SEMITONES.map((s) => `<option value="${s.value}" ${s.value === dbl ? 'selected' : ''}>${s.value ? s.label : 'No double'}</option>`).join('')}
        </select>
      </div>
      <label class="mix-dvol ${dbl ? '' : 'disabled'}"><span>${busy ? '<span class="busy"><span class="spinner"></span>Preparing</span>' : 'Double'}</span><input type="range" data-k="dvolume" min="0" max="1.5" step="0.01" value="${m.double.volume}" aria-label="${escapeHtml(t.short)} double volume"><output>${volPct(m.double.volume)}</output></label>
    </div>`;
  }).join('');
}

function updateBusyUI() {
  if ($('#arr-card').hidden) return;
  const arr = getArrangement(app.project, app.editing);
  for (const row of $$('.mix-row')) {
    const m = arr.mix[row.dataset.id];
    const busy = m && app.busy.has(`${row.dataset.id}|${m.double.semitones}`);
    $('.mix-dvol > span', row).innerHTML = busy ? '<span class="busy"><span class="spinner"></span>Preparing</span>' : 'Double';
  }
}

/** Make sure every pitched double used anywhere is computed. */
function ensureDoubles() {
  const jobs = [];
  for (const d of neededDoubles(app.project)) {
    const track = app.tracks.find((t) => t.id === d.trackId);
    if (!track || app.bank.has(app.project, track, d.semitones)) continue;
    const key = `${d.trackId}|${d.semitones}`;
    app.busy.add(key);
    jobs.push(
      app.bank.ensure(app.project, track, d.semitones)
        .then(() => app.engine.addMissingVoices())
        .catch((e) => toast(`Couldn’t make the pitch double: ${e.message}`))
        .finally(() => { app.busy.delete(key); updateBusyUI(); }),
    );
  }
  updateBusyUI();
  return Promise.all(jobs);
}

function selectArrangement(id) {
  app.editing = id;
  if (app.mode === 'loop') {
    app.engine.queue('loop', id);
    if (app.engine.playing) toast(`${getArrangement(app.project, id).name} starts at the next loop.`, 1800);
  }
  renderTabs();
  renderMixer();
}

function newArrangement() {
  const p = app.project;
  const arr = duplicateArrangement(p, app.editing);
  p.song.push({ arr: arr.id, repeats: 4 });
  p.askedForB = true;
  save();
  selectArrangement(arr.id);
  renderAll();
}

function deleteArrangement() {
  const p = app.project;
  if (p.arrangements.length < 2) return;
  const a = getArrangement(p, app.editing);
  if (!confirm(`Delete arrangement ${a.name}? It’s also removed from the song.`)) return;
  p.arrangements = p.arrangements.filter((x) => x.id !== a.id);
  p.song = p.song.filter((s) => s.arr !== a.id);
  if (!p.song.length) p.song = [{ arr: p.arrangements[0].id, repeats: 4 }];
  save();
  selectArrangement(p.arrangements[0].id);
  app.engine.refresh();
  renderAll();
}

// --- song ------------------------------------------------------------------

function renderSong() {
  const p = app.project;
  $('#song-steps').innerHTML = p.song.map((s, i) => `
    <li class="song-step" data-i="${i}">
      <span class="idx">${i + 1}</span>
      <label class="visually-hidden" for="step-arr-${i}">Part ${i + 1} arrangement</label>
      <select id="step-arr-${i}" data-k="arr">
        ${p.arrangements.map((a) => `<option value="${a.id}" ${a.id === s.arr ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
      </select>
      <span class="stepper" role="group" aria-label="Times through the loop">
        <button type="button" data-k="minus" aria-label="Fewer loops">−</button>
        <output>${s.repeats}×</output>
        <button type="button" data-k="plus" aria-label="More loops">+</button>
      </span>
      <span class="rep" hidden></span>
      <span class="spacer"></span>
      <button type="button" class="icon-btn" data-k="up" aria-label="Move part ${i + 1} up" title="Move up" ${i === 0 ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="icon-btn" data-k="remove" aria-label="Remove part ${i + 1}" title="Remove" ${p.song.length < 2 ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </li>`).join('');
  renderSongLength();
}

function renderSongLength() {
  const p = app.project;
  const L = p.loop.end - p.loop.start;
  const n = songCycles(p).length;
  $('#song-length').textContent = `${n} loops · ${fmtDuration(n * L)}`;
}

function songChanged() {
  save();
  renderSong();
  app.engine.refresh();
}

// --- render all ------------------------------------------------------------

function renderAll() {
  const p = app.project;
  const confirmed = p.loopConfirmed;
  $('#loop-body').hidden = confirmed;
  $('#loop-summary').hidden = !confirmed;
  $('#btn-edit-loop').hidden = !confirmed;
  $('#arr-prompt').hidden = !confirmed || p.askedForB || p.arrangements.length > 1;
  $('#arr-card').hidden = !confirmed;
  $('#song-card').hidden = !confirmed || p.arrangements.length < 2;
  $('#road-card').hidden = !confirmed;
  $('#road-what').value = p.arrangements.length > 1 ? 'song' : 'arr';
  $$('.seg.mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === app.mode)));
  $('.seg.mode').hidden = p.arrangements.length < 2;
  renderLoopFields();
  renderSummary();
  renderTabs();
  renderMixer();
  renderSong();
  if (!confirmed) requestAnimationFrame(() => timeline.resize());
}

// --- playback --------------------------------------------------------------

async function startPlayback(isRestart = false) {
  ensureAudio();
  const ctx = app.ctx;
  if (ctx.state !== 'running') ctx.resume();
  if (!isRestart && neededDoubles(app.project).some((d) => app.busy.has(`${d.trackId}|${d.semitones}`))) {
    toast('Preparing pitch doubles… they join in when ready.');
  }
  const roadAudio = $('#road-audio');
  if (!roadAudio.paused) roadAudio.pause();
  await app.engine.start(app.tracks, app.project, app.bank, { mode: app.mode, arr: app.editing });
  setPlayingUI(true);
  requestWakeLock();
  setMediaSession();
  cancelAnimationFrame(app.raf);
  app.raf = requestAnimationFrame(frame);
}

function stopPlayback() {
  app.engine?.stop();
  setPlayingUI(false);
  cancelAnimationFrame(app.raf);
  timeline.playheads = null;
  timeline.draw();
  releaseWakeLock();
  updateNow();
}

function setPlayingUI(on) {
  const b = $('#btn-play');
  b.classList.toggle('on', on);
  b.setAttribute('aria-label', on ? 'Stop' : 'Play');
  b.title = on ? 'Stop (Space)' : 'Play (Space)';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
}

let lastStep = -1;
function frame() {
  if (!app.engine.playing) return;
  if (!$('#loop-body').hidden) {
    timeline.playheads = app.engine.playheads();
    timeline.draw();
  }
  updateNow();
  app.raf = requestAnimationFrame(frame);
}

function updateNow() {
  const e = app.engine;
  if (!e || !e.playing || !app.project) {
    $('#now-arr').textContent = app.project ? getArrangement(app.project, app.editing).name : '';
    $('#now-detail').textContent = app.project ? `${formatTime(app.project.loop.end - app.project.loop.start, 1)} loop` : '';
    $$('.song-step.current').forEach((el) => el.classList.remove('current'));
    $$('.tab .live').forEach((el) => (el.hidden = true));
    lastStep = -1;
    return;
  }
  const k = e.currentCycle();
  const arr = getArrangement(app.project, e.arrFor(k));
  const L = e.L;
  const into = e.elapsed() - k * L;
  $('#now-arr').textContent = arr.name;
  const pos = e.songPosition(k);
  $('#now-detail').textContent = pos
    ? `Part ${pos.step + 1}/${app.project.song.length} · ${pos.rep + 1}/${pos.of} · ${formatTime(into, 1)}`
    : `Loop ${k + 1} · ${formatTime(into, 1)} / ${formatTime(L, 1)}`;
  $$('.tab').forEach((t) => ($('.live', t).hidden = t.dataset.arr !== arr.id));
  const step = pos ? pos.step : -1;
  if (step !== lastStep) {
    $$('.song-step').forEach((el, i) => {
      el.classList.toggle('current', i === step);
      $('.rep', el).hidden = i !== step;
    });
    lastStep = step;
  }
  if (pos) {
    const rep = $(`.song-step[data-i="${pos.step}"] .rep`);
    if (rep) rep.textContent = `${pos.rep + 1}/${pos.of}`;
  }
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !app.wakeLock) {
      app.wakeLock = await navigator.wakeLock.request('screen');
      app.wakeLock.addEventListener('release', () => (app.wakeLock = null));
    }
  } catch { /* not allowed */ }
}

function releaseWakeLock() {
  app.wakeLock?.release().catch(() => {});
  app.wakeLock = null;
}

function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: app.name,
    artist: 'Loop Road',
    artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  navigator.mediaSession.setActionHandler('play', () => startPlayback());
  navigator.mediaSession.setActionHandler('pause', () => stopPlayback());
  navigator.mediaSession.setActionHandler('stop', () => stopPlayback());
}

function setMode(mode) {
  app.mode = mode;
  app.engine?.queue(mode, app.editing);
  if (app.engine?.playing) toast(mode === 'song' ? 'Song starts at the next loop.' : `Looping ${getArrangement(app.project, app.editing).name} from the next loop.`, 1800);
  $$('.seg.mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  renderTabs();
}

// --- road render -----------------------------------------------------------

async function renderRoad() {
  const btn = $('#btn-render');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    ensureAudio();
    await ensureDoubles();
    btn.textContent = 'Rendering…';
    const what = $('#road-what').value;
    const mins = Number($('#road-mins').value);
    const pass = await renderPass(app.tracks, app.project, app.bank, { mode: what === 'song' ? 'song' : 'loop', arr: app.editing });
    const { blob, duration } = passToWav(pass, mins);
    if (app.roadUrl) URL.revokeObjectURL(app.roadUrl);
    app.roadUrl = URL.createObjectURL(blob);
    const audio = $('#road-audio');
    audio.src = app.roadUrl;
    const label = what === 'song' ? 'song' : getArrangement(app.project, app.editing).name;
    const a = $('#road-download');
    a.href = app.roadUrl;
    a.download = `${app.name.replace(/[\\/:*?"<>|]+/g, '-')} – ${label}.wav`;
    $('#road-info').textContent = `${fmtDuration(duration)} · ${fmtBytes(blob.size)} · WAV`;
    $('#road-out').hidden = false;
    toast('Ready. Press play on the player below.');
  } catch (e) {
    toast(`Render failed: ${e.message || e}`, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Render';
  }
}

// --- recent ----------------------------------------------------------------

function renderRecent() {
  const list = recentList();
  $('#recent').hidden = !list.length;
  $('#recent-list').innerHTML = list.map((r) => `
    <li>
      <button type="button" class="recent-open" data-key="${escapeHtml(r.sourceKey)}">
        <span class="name">${escapeHtml(r.name)}</span>
        <span class="meta">${r.count} tracks · ${new Date(r.when).toLocaleDateString()}</span>
      </button>
      <button type="button" class="icon-btn" data-remove="${escapeHtml(r.sourceKey)}" aria-label="Remove ${escapeHtml(r.name)} from recent" title="Remove">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </li>`).join('');
}

// --- settings --------------------------------------------------------------

function openSettings() {
  $('#key-section').hidden = BUILT_IN_KEY;
  $('#btn-save-settings').hidden = BUILT_IN_KEY;
  $('#btn-cancel-settings').hidden = BUILT_IN_KEY;
  $('#btn-close-settings').hidden = !BUILT_IN_KEY;
  $('#api-key').value = storage.get(API_KEY) || '';
  $('#settings').showModal();
}

// --- events ----------------------------------------------------------------

function bind() {
  $('#load-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ensureAudio();
    loadDrive($('#drive-link').value);
  });
  $('#file-input').addEventListener('change', (e) => e.target.files.length && loadLocal(e.target.files));
  $('#recent-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-key]');
    const rm = e.target.closest('[data-remove]');
    if (rm) { removeRecent(rm.dataset.remove); renderRecent(); return; }
    if (open) {
      const r = recentList().find((x) => x.sourceKey === open.dataset.key);
      if (r) { $('#drive-link').value = r.link; ensureAudio(); loadDrive(r.link); }
    }
  });
  $('#btn-change').addEventListener('click', closeProject);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue === 'save' && !BUILT_IN_KEY) {
      storage.set(API_KEY, $('#api-key').value.trim());
      toast('API key saved on this device.');
    }
  });
  $('#btn-clear-cache').addEventListener('click', async () => {
    await cache.clear();
    toast('Downloaded audio cleared. Tracks download again next time.');
  });

  // loop
  $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const z = b.dataset.zoom;
    if (z === 'in') timeline.zoom(2);
    else if (z === 'out') timeline.zoom(0.5);
    else if (z === 'fit') timeline.fit();
    else { timeline.focus(z); setNudgeTarget(z); }
  }));
  for (const which of ['start', 'end']) {
    const input = $(`#loop-${which}`);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return renderLoopFields();
      setNudgeTarget(which);
      timeline.setHandle(which, v, false);
      commitLoop();
    });
    input.addEventListener('focus', () => setNudgeTarget(which));
  }
  $$('[data-nudge-target]').forEach((b) => b.addEventListener('click', () => setNudgeTarget(b.dataset.nudgeTarget)));
  $$('[data-nudge]').forEach((b) => b.addEventListener('click', () => nudge(Number(b.dataset.nudge))));
  $('#tl-canvas').addEventListener('pointerdown', () => setTimeout(() => setNudgeTarget(timeline.active)));
  $('#btn-reset-loop').addEventListener('click', () => {
    const fresh = createProject(app.project.sourceKey, app.tracks);
    app.project.loop = fresh.loop;
    app.project.mult = fresh.mult;
    timeline.updateMultOptions();
    timeline.fit();
    commitLoop();
  });
  $('#bpm').addEventListener('input', () => {
    const v = Number($('#bpm').value);
    app.project.bpm = v >= 30 && v <= 300 ? v : null;
    renderLoopFields();
    timeline.draw();
    save();
  });
  $('#bpb').addEventListener('input', () => {
    const v = Math.round(Number($('#bpb').value));
    app.project.beatsPerBar = v >= 1 && v <= 16 ? v : 4;
    renderLoopFields();
    timeline.draw();
    save();
  });
  $('#snap').addEventListener('change', () => { app.project.snap = $('#snap').checked; save(); });
  $('#btn-fit-bars').addEventListener('click', () => {
    const p = app.project;
    if (!(p.bpm > 0)) { toast('Enter the BPM first.'); $('#bpm').focus(); return; }
    const bars = Math.max(1, Math.round(Number($('#bars').value) || 4));
    const end = p.loop.start + (bars * (p.beatsPerBar || 4) * 60) / p.bpm;
    const max = maxLoopEnd(p, app.tracks);
    if (end > max + 1e-6) { toast(`${bars} bars at ${p.bpm} BPM is longer than your tracks.`); return; }
    const snap = p.snap; p.snap = false;
    timeline.setHandle('end', end, false);
    p.snap = snap;
    commitLoop();
  });
  $('#btn-confirm-loop').addEventListener('click', () => {
    app.project.loopConfirmed = true;
    save();
    renderAll();
    const next = !$('#arr-prompt').hidden ? $('#arr-prompt') : $('#arr-card');
    next.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#btn-edit-loop').addEventListener('click', () => {
    app.project.loopConfirmed = false;
    save();
    renderAll();
  });

  // prompt
  $('#btn-make-b').addEventListener('click', () => {
    app.editing = app.project.arrangements[0].id;
    newArrangement();
    $('#arr-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#btn-skip-b').addEventListener('click', () => {
    app.project.askedForB = true;
    save();
    renderAll();
  });

  // arrangements
  $('#arr-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-arr]');
    if (t) selectArrangement(t.dataset.arr);
  });
  $('#arr-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const ids = app.project.arrangements.map((a) => a.id);
    const i = ids.indexOf(app.editing) + (e.key === 'ArrowLeft' ? -1 : 1);
    if (i >= 0 && i < ids.length) {
      selectArrangement(ids[i]);
      $(`.tab[data-arr="${ids[i]}"]`).focus();
    }
  });
  $('#btn-new-arr').addEventListener('click', newArrangement);
  $('#btn-delete-arr').addEventListener('click', deleteArrangement);

  const mixer = $('#mixer');
  mixer.addEventListener('input', (e) => {
    const row = e.target.closest('.mix-row');
    if (!row || e.target.type !== 'range') return;
    const m = getArrangement(app.project, app.editing).mix[row.dataset.id];
    const v = Number(e.target.value);
    if (e.target.dataset.k === 'volume') m.volume = v;
    else m.double.volume = v;
    e.target.nextElementSibling.textContent = volPct(v);
    app.engine?.refresh();
    save();
  });
  mixer.addEventListener('change', (e) => {
    const row = e.target.closest('.mix-row');
    if (!row || e.target.dataset.k !== 'semitones') return;
    const m = getArrangement(app.project, app.editing).mix[row.dataset.id];
    m.double.semitones = Number(e.target.value);
    $('.mix-dvol', row).classList.toggle('disabled', !m.double.semitones);
    app.engine?.refresh();
    save();
    ensureDoubles();
  });
  mixer.addEventListener('click', (e) => {
    const b = e.target.closest('.mute');
    if (!b) return;
    const row = b.closest('.mix-row');
    const m = getArrangement(app.project, app.editing).mix[row.dataset.id];
    m.on = !m.on;
    b.setAttribute('aria-pressed', String(m.on));
    b.textContent = m.on ? 'On' : 'Off';
    row.classList.toggle('off', !m.on);
    app.engine?.refresh();
    save();
  });

  // song
  const steps = $('#song-steps');
  steps.addEventListener('change', (e) => {
    const li = e.target.closest('.song-step');
    if (!li || e.target.dataset.k !== 'arr') return;
    app.project.song[Number(li.dataset.i)].arr = e.target.value;
    songChanged();
  });
  steps.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    const li = e.target.closest('.song-step');
    if (!b || !li) return;
    const song = app.project.song;
    const i = Number(li.dataset.i);
    const k = b.dataset.k;
    if (k === 'minus') song[i].repeats = Math.max(1, song[i].repeats - 1);
    else if (k === 'plus') song[i].repeats = Math.min(64, song[i].repeats + 1);
    else if (k === 'up' && i > 0) [song[i - 1], song[i]] = [song[i], song[i - 1]];
    else if (k === 'remove' && song.length > 1) song.splice(i, 1);
    songChanged();
    lastStep = -1;
  });
  $('#btn-add-step').addEventListener('click', () => {
    const p = app.project;
    const last = p.song[p.song.length - 1];
    const ids = p.arrangements.map((a) => a.id);
    const nextArr = ids[(ids.indexOf(last?.arr) + 1) % ids.length] || ids[0];
    p.song.push({ arr: nextArr, repeats: last?.repeats || 4 });
    songChanged();
  });

  // transport
  $('#btn-play').addEventListener('click', () => {
    ensureAudio();
    if (app.ctx.state !== 'running') app.ctx.resume(); // inside the tap, for iOS
    if (app.engine.playing) stopPlayback();
    else startPlayback();
  });
  $$('.seg.mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#master').addEventListener('input', (e) => app.engine?.setMaster(Number(e.target.value)));
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !app.project || $('#screen-studio').hidden) return;
    const t = e.target;
    if (t.closest('input, select, textarea, button, a, dialog, audio, [role="tab"]')) return;
    e.preventDefault();
    $('#btn-play').click();
  });

  // road
  $('#btn-render').addEventListener('click', renderRoad);
  $('#road-audio').addEventListener('play', () => {
    if (app.engine?.playing) stopPlayback();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: app.name,
        artist: 'Loop Road',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      for (const a of ['play', 'pause', 'stop']) navigator.mediaSession.setActionHandler(a, null);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.engine?.playing) requestWakeLock();
  });
}

// --- start -----------------------------------------------------------------

bind();
renderRecent();

const hash = new URLSearchParams(location.hash.slice(1));
const shared = hash.get('drive') || new URLSearchParams(location.search).get('folder');
if (shared) {
  $('#drive-link').value = shared;
  if (apiKey()) loadDrive(shared);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// For debugging in the console.
window.loopRoad = app;
