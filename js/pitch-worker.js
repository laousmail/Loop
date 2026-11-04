import { pitchShiftLoop } from './dsp/pitchshift.js';

self.onmessage = (e) => {
  const { id, channels, semitones } = e.data;
  try {
    const out = channels.map((ch) => pitchShiftLoop(ch, semitones));
    self.postMessage({ id, channels: out }, out.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
