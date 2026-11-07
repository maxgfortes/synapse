// Utilitarios numericos usados pelo Metis. Sem dependencias de DOM.

export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x, -30, 30)));
export const logit = (p) => {
  const q = clamp(p, 1e-4, 1 - 1e-4);
  return Math.log(q / (1 - q));
};

// FNV-1a de 32 bits: estavel entre sessoes e entre dispositivos.
export function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const hashUnit = (text) => hash32(text) / 0xffffffff;

// Mulberry32. O estado cabe em um inteiro, entao entra no export do modelo.
export function makeRng(seed = Date.now() >>> 0) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.state = () => s >>> 0;
  return rng;
}

export function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia-Tsang.
function gammaSample(shape, rng) {
  if (shape < 1) {
    return gammaSample(shape + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    const x = gaussian(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return d;
}

export function betaSample(a, b, rng) {
  const x = gammaSample(Math.max(a, 1e-3), rng);
  const y = gammaSample(Math.max(b, 1e-3), rng);
  return x / (x + y || 1);
}

// Sorteio softmax: quanto maior a temperatura, mais aleatorio.
export function softmaxPick(scores, temperature, rng) {
  const t = Math.max(temperature, 1e-3);
  let max = -Infinity;
  for (const s of scores) if (s > max) max = s;
  let total = 0;
  const p = new Float64Array(scores.length);
  for (let i = 0; i < scores.length; i++) {
    p[i] = Math.exp((scores[i] - max) / t);
    total += p[i];
  }
  let r = rng() * total;
  for (let i = 0; i < p.length; i++) {
    r -= p[i];
    if (r <= 0) return i;
  }
  return p.length - 1;
}

export function mean(values) {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function std(values, m = mean(values)) {
  if (values.length < 2) return 0;
  let s = 0;
  for (const v of values) s += (v - m) ** 2;
  return Math.sqrt(s / values.length);
}

export const round = (x, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
