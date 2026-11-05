// A "lane" is what one track plays during one pass of the loop: the track's
// audio from loop start to loop end. A track shorter than that keeps
// repeating from its own beginning until the loop ends.

/** Loop region in sample frames. */
export function loopRegion(project, sampleRate) {
  const start = Math.round(project.loop.start * sampleRate);
  const frames = Math.max(1, Math.round(project.loop.end * sampleRate) - start);
  return { start, frames };
}

/** One channel's lane: samples [start, start+frames) of a track repeated forever. */
function tile(src, start, frames) {
  const out = new Float32Array(frames);
  const n = src.length;
  let o = 0;
  let i = start % n;
  while (o < frames) {
    const take = Math.min(n - i, frames - o);
    out.set(src.subarray(i, i + take), o);
    o += take;
    i = 0;
  }
  return out;
}

export function laneChannels(track, region) {
  const buf = track.buffer;
  const out = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(tile(buf.getChannelData(c), region.start, region.frames));
  return out;
}

export function makeBuffer(channels, sampleRate) {
  const ab = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate });
  channels.forEach((ch, i) => ab.copyToChannel(ch, i));
  return ab;
}

const cache = new WeakMap(); // track -> { key, buffer }

/** AudioBuffer of the track's lane for the current loop (cached). */
export function laneBuffer(track, project) {
  const sr = track.buffer.sampleRate;
  const region = loopRegion(project, sr);
  const key = `${region.start}:${region.frames}`;
  const hit = cache.get(track);
  if (hit && hit.key === key) return hit.buffer;
  const buffer = makeBuffer(laneChannels(track, region), sr);
  cache.set(track, { key, buffer });
  return buffer;
}
