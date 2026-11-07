import { clamp } from './math.js';

const FRAME = 2048;
const HOP = 1024;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / (Math.sqrt(da * db) || 1);
}

export function detectKey(chroma) {
  let best = { key: 0, mode: 1, score: -Infinity };
  for (let key = 0; key < 12; key++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chroma[(i + key) % 12]);
    const major = correlate(rotated, MAJOR);
    const minor = correlate(rotated, MINOR);
    if (major > best.score) best = { key, mode: 1, score: major };
    if (minor > best.score) best = { key, mode: 0, score: minor };
  }
  return best;
}

export function detectTempo(onset, frameRate, minBpm = 60, maxBpm = 190) {
  const n = onset.length;
  if (n < 64) return { bpm: 0, strength: 0 };
  const mean = onset.reduce((s, x) => s + x, 0) / n;
  const x = onset.map((v) => Math.max(0, v - mean));
  const minLag = Math.floor((60 * frameRate) / maxBpm);
  const maxLag = Math.min(n >> 1, Math.ceil((60 * frameRate) / minBpm));
  const ac = new Float64Array(maxLag * 3 + 2);
  let zero = 0;
  for (let i = 0; i < n; i++) zero += x[i] * x[i];
  if (zero < 1e-9) return { bpm: 0, strength: 0 };
  const top = Math.min(maxLag * 3, n - 1);
  for (let lag = minLag; lag <= top; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (n - lag);
  }
  const norm = zero / n || 1;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {

    const comb = ac[lag] + 0.5 * (ac[lag * 2] || 0) + 0.25 * (ac[lag * 3] || 0);
    const bpm = (60 * frameRate) / lag;

    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = comb * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag) return { bpm: 0, strength: 0 };
  const a = ac[bestLag - 1] || 0;
  const b = ac[bestLag];
  const c = ac[bestLag + 1] || 0;
  const denom = a - 2 * b + c;
  const refined = bestLag + (denom ? clamp((a - c) / (2 * denom), -0.5, 0.5) : 0);
  return { bpm: (60 * frameRate) / refined, strength: clamp(b / norm) };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function centerSlice(samples, sampleRate, maxSeconds) {
  const max = Math.floor(maxSeconds * sampleRate);
  if (samples.length <= max) return samples;
  const start = (samples.length - max) >> 1;
  return samples.subarray(start, start + max);
}

const round3 = (x) => Math.round(x * 1000) / 1000;

export function analyzePCM(input, sampleRate, { maxSeconds = 90 } = {}) {
  const samples = centerSlice(input, sampleRate, maxSeconds);
  if (samples.length < FRAME * 8) return null;

  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const half = FRAME >> 1;
  const hzPerBin = sampleRate / FRAME;
  const binBass = Math.ceil(250 / hzPerBin);
  const binMid = Math.ceil(4000 / hzPerBin);
  const pitchLow = Math.ceil(80 / hzPerBin);
  const pitchHigh = Math.min(half - 1, Math.floor(1000 / hzPerBin));

  const frames = Math.floor((samples.length - FRAME) / HOP);
  const onset = new Array(frames).fill(0);
  const rmsDb = [];
  const pitches = [];
  const chroma = new Float64Array(12);
  let prevMag = new Float64Array(half);
  let sumBass = 0;
  let sumMid = 0;
  let sumTreble = 0;
  let sumCentroid = 0;
  let centroidFrames = 0;
  let sumRms = 0;
  let zeroCross = 0;

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[offset + i];
      energy += s * s;
      re[i] = s * window[i];
      im[i] = 0;
      if (i && (s >= 0) !== (samples[offset + i - 1] >= 0)) zeroCross++;
    }
    const rms = Math.sqrt(energy / FRAME);
    sumRms += rms;
    rmsDb.push(20 * Math.log10(rms + 1e-7));
    fft(re, im);

    const mag = new Float64Array(half);
    let flux = 0;
    let weighted = 0;
    let total = 0;
    let bestBin = 0;
    let bestMag = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      const p = m * m;
      if (k < binBass) sumBass += p;
      else if (k < binMid) sumMid += p;
      else sumTreble += p;
      weighted += k * m;
      total += m;

      const d = Math.log1p(m * 10) - Math.log1p(prevMag[k] * 10);
      if (d > 0) flux += d;
      if (k >= pitchLow && k <= pitchHigh && m > bestMag) {
        bestMag = m;
        bestBin = k;
      }
      const hz = k * hzPerBin;
      if (hz >= 65 && hz <= 2100) {
        const pc = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12 + 9) % 12;
        chroma[pc] += p;
      }
    }
    onset[f] = flux;
    prevMag = mag;
    if (total > 1e-4) {
      sumCentroid += (weighted / total) * hzPerBin;
      centroidFrames++;
    }
    if (bestBin && rms > 0.005) pitches.push(bestBin * hzPerBin);
  }

  const frameRate = sampleRate / HOP;
  const tempo = detectTempo(onset, frameRate);
  const key = detectKey(Array.from(chroma));
  const power = sumBass + sumMid + sumTreble || 1;
  const sortedDb = rmsDb.slice().sort((a, b) => a - b);
  const sortedPitch = pitches.sort((a, b) => a - b);
  const meanRms = sumRms / (frames || 1);
  const dynamicsDb = percentile(sortedDb, 0.95) - percentile(sortedDb, 0.1);

  return {
    bpm: Math.round(tempo.bpm * 10) / 10,
    beat: round3(tempo.strength),

    energy: round3(clamp((20 * Math.log10(meanRms + 1e-7) + 40) / 32)),

    bass: round3(clamp(Math.sqrt(sumBass / power))),
    mid: round3(clamp(Math.sqrt(sumMid / power))),
    treble: round3(clamp(Math.sqrt(sumTreble / power) * 2.2)),
    brightness: round3(clamp(sumCentroid / (centroidFrames || 1) / 5000)),
    pitchHz: Math.round(percentile(sortedPitch, 0.5) * 10) / 10,
    key: key.key,
    mode: key.mode,
    keyConfidence: round3(clamp(key.score)),
    dynamics: round3(clamp(dynamicsDb / 30)),
    zcr: round3(clamp((zeroCross / (frames * FRAME || 1)) * 8)),
  };
}
