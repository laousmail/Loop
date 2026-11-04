// Offline render of the song to a WAV file for "on the road" playback.
// An <audio> element keeps playing with the screen locked, unlike Web Audio.

import { buildMaster, buildVoices, setGainsNow, planGains } from './engine.js';
import { songCycles } from './state.js';

/**
 * Render one seamless pass of the song (or of a single arrangement).
 * One extra warm-up cycle is rendered first and dropped, which also absorbs
 * the limiter's lookahead delay, so the pass repeats without a seam.
 * @returns {Promise<{channels: Float32Array[], sampleRate: number, duration: number}>}
 */
export async function renderPass(tracks, project, bank, { mode, arr }) {
  const sr = tracks[0].buffer.sampleRate;
  const startF = Math.round(project.loop.start * sr);
  const loopFrames = Math.round(project.loop.end * sr) - startF;
  const L = loopFrames / sr;
  const seq = mode === 'song' ? songCycles(project) : [arr];
  // Make the pass a whole number of every track's period (multiples are powers of 2).
  const maxMult = Math.max(...tracks.map((t) => project.mult[t.id] || 1));
  let cycles = seq.length;
  while (cycles % maxMult) cycles += seq.length;
  const warm = maxMult; // keeps every track's phase aligned with the pass
  const arrAt = (c) => seq[(((c - warm) % seq.length) + seq.length) % seq.length];

  const frames = cycles * loopFrames;
  const ctx = new OfflineAudioContext(2, frames + warm * loopFrames, sr);
  const master = buildMaster(ctx, ctx.destination);
  const voices = buildVoices(ctx, master, tracks, project, bank, 0);
  setGainsNow(voices, project, arrAt(0));
  for (let c = 1; c <= cycles + warm; c++) planGains(voices, project, arrAt(c), c * L);
  const out = await ctx.startRendering();
  const channels = [];
  for (let c = 0; c < out.numberOfChannels; c++) {
    channels.push(out.getChannelData(c).slice(warm * loopFrames));
  }
  return { channels, sampleRate: sr, duration: frames / sr };
}

/** 16-bit PCM bytes (interleaved). */
function toPCM16(chs) {
  const n = chs[0].length;
  const out = new Int16Array(n * chs.length);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (const ch of chs) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out.buffer;
}

function wavHeader(dataBytes, channels, sr) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  h.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, channels, true);
  h.setUint32(24, sr, true);
  h.setUint32(28, sr * channels * 2, true);
  h.setUint16(32, channels * 2, true);
  h.setUint16(34, 16, true);
  str(36, 'data');
  h.setUint32(40, dataBytes, true);
  return h.buffer;
}

/**
 * WAV blob that repeats one pass until it reaches `minutes`.
 * The pass bytes are shared, so memory stays at one pass.
 */
export function passToWav(pass, minutes) {
  const pcm = toPCM16(pass.channels);
  const repeats = Math.max(1, Math.round((minutes * 60) / pass.duration));
  const header = wavHeader(pcm.byteLength * repeats, pass.channels.length, pass.sampleRate);
  const parts = [header];
  for (let i = 0; i < repeats; i++) parts.push(pcm);
  return { blob: new Blob(parts, { type: 'audio/wav' }), duration: pass.duration * repeats, repeats };
}
