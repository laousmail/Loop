// Loop-aware pitch shifter.
//
// Method: phase-vocoder time-stretch by `ratio`, then resample back to the
// original length. Both stages treat the input as circular, so the result
// loops without a gap and stays sample-locked to the original track.

const TWO_PI = Math.PI * 2;

function makeFFT(n) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of 2');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((TWO_PI * i) / n);
    sin[i] = Math.sin((TWO_PI * i) / n);
  }
  // In-place complex FFT. inverse=true is unnormalised.
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sign * sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

const wrapPhase = (p) => p - TWO_PI * Math.round(p / TWO_PI);

/** Circular phase-vocoder stretch of `input` (length N) to length M. */
function stretchLoop(input, M, F, lowpassBin) {
  const N = input.length;
  const half = F >> 1;
  // Enough frames that the larger of the two hops is at most F/6.
  const K = Math.max(6, Math.ceil((Math.max(N, M) * 6) / F));
  const pa = (k) => Math.round((k * N) / K);
  const ps = (k) => Math.round((k * M) / K);

  const win = new Float64Array(F);
  for (let i = 0; i < F; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / F);

  const fft = makeFFT(F);
  const re = new Float64Array(F);
  const im = new Float64Array(F);
  const lastPhase = new Float64Array(half + 1);
  const synPhase = new Float64Array(half + 1);
  const acc = new Float64Array(M);
  const norm = new Float64Array(M);

  // Warm-up frames (taken from the end of the loop) prime the phase tracking.
  const warm = 8;
  for (let k = -warm; k < K; k++) {
    const kk = ((k % K) + K) % K;
    const aPos = pa(kk);
    const sPos = ps(kk);
    // hops from the previous frame to this one
    const ha = kk === 0 ? N - pa(K - 1) : aPos - pa(kk - 1);
    const hs = kk === 0 ? M - ps(K - 1) : sPos - ps(kk - 1);

    for (let i = 0; i < F; i++) {
      re[i] = input[(aPos + i) % N] * win[i];
      im[i] = 0;
    }
    fft(re, im, false);

    for (let b = 0; b <= half; b++) {
      const r = re[b], m = im[b];
      const mag = b > lowpassBin ? 0 : Math.sqrt(r * r + m * m);
      const phase = Math.atan2(m, r);
      const omega = (TWO_PI * b) / F; // bin centre, rad/sample
      const dev = wrapPhase(phase - lastPhase[b] - omega * ha);
      lastPhase[b] = phase;
      const trueOmega = omega + dev / ha;
      synPhase[b] = k === -warm ? phase : synPhase[b] + trueOmega * hs;
      re[b] = mag * Math.cos(synPhase[b]);
      im[b] = mag * Math.sin(synPhase[b]);
    }
    // Hermitian mirror so the inverse FFT is real.
    for (let b = 1; b < half; b++) {
      re[F - b] = re[b];
      im[F - b] = -im[b];
    }
    fft(re, im, true);

    if (k < 0) continue;
    for (let i = 0; i < F; i++) {
      const idx = (sPos + i) % M;
      acc[idx] += (re[i] / F) * win[i];
      norm[idx] += win[i] * win[i];
    }
  }

  const out = new Float32Array(M);
  for (let i = 0; i < M; i++) out[i] = norm[i] > 1e-9 ? acc[i] / norm[i] : 0;
  return out;
}

/** Circular cubic (Catmull-Rom) resample of `src` to length N. */
function resampleLoop(src, N) {
  const M = src.length;
  const out = new Float32Array(N);
  const step = M / N;
  for (let i = 0; i < N; i++) {
    const x = i * step;
    const i1 = Math.floor(x);
    const t = x - i1;
    const p0 = src[(i1 - 1 + M) % M];
    const p1 = src[i1 % M];
    const p2 = src[(i1 + 1) % M];
    const p3 = src[(i1 + 2) % M];
    out[i] =
      p1 +
      0.5 * t * (p2 - p0 +
        t * (2 * p0 - 5 * p1 + 4 * p2 - p3 +
          t * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}

/**
 * Pitch-shift one channel of a loop without changing its length.
 * @param {Float32Array} input
 * @param {number} semitones  e.g. 12 = octave up, -12 = octave down
 * @param {{frameSize?: number}} [opts]
 * @returns {Float32Array} same length as input
 */
export function pitchShiftLoop(input, semitones, opts = {}) {
  const N = input.length;
  if (!semitones || N === 0) return Float32Array.from(input);
  const ratio = Math.pow(2, semitones / 12);

  let F = opts.frameSize || 2048;
  // Larger frames keep low notes clean when shifting down.
  if (ratio < 1 && !opts.frameSize) F = 4096;
  while (F > 256 && F * 2 > N) F >>= 1;

  const M = Math.max(1, Math.round(N * ratio));
  // Shifting up = squeezing the stretched audio back down, so drop content
  // that would land above Nyquist and alias.
  const half = F >> 1;
  const lowpassBin = ratio > 1 ? Math.floor((half / ratio) * 0.97) : half;
  const stretched = stretchLoop(input, M, F, lowpassBin);
  return resampleLoop(stretched, N);
}
