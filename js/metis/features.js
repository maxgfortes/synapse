// Transforma uma faixa em numeros. Analise real de audio tem prioridade;
// sem ela, usa priors do genero e pistas do titulo com confianca menor.

import { GENRES, FAMILY_COUNT, normalizeGenre, titleHints } from './genres.js';
import { clamp, hashUnit, lerp } from './math.js';

const tempoNorm = (bpm) => clamp((bpm - 60) / 120);

export function genreOf(track) {
  return track.genreId || normalizeGenre(track.genre) || normalizeGenre(`${track.title} ${track.artist}`) || 'other';
}

// Uma faixa reanalisada recebe outro objeto em features, o que invalida o cache.
const cache = new WeakMap();

export function resolve(track) {
  const hit = cache.get(track);
  if (hit && hit.stamp === track.features && hit.genre === track.genre) return hit.value;
  const value = compute(track);
  cache.set(track, { stamp: track.features, genre: track.genre, value });
  return value;
}

function compute(track) {
  const genreId = genreOf(track);
  const g = GENRES[genreId] || GENRES.other;
  const hint = titleHints(track.title);
  const a = track.features;
  // Sem audio, um desvio estavel por faixa espalha as musicas do mesmo genero.
  const spreadV = (hashUnit(`${track.id}|v`) - 0.5) * 0.14;
  const spreadA = (hashUnit(`${track.id}|a`) - 0.5) * 0.14;

  if (!a || !a.bpm) {
    return {
      genreId,
      family: g.f,
      confidence: 0.3,
      bpm: g.bpm * hint.bpmScale,
      energy: clamp(g.a + hint.a),
      bass: clamp(g.bass + hint.bass),
      mid: 0.5,
      treble: g.treble,
      brightness: g.treble,
      pitch: 0.5,
      mode: g.v >= 0.5 ? 1 : 0,
      key: null,
      dynamics: 0.4,
      beat: 0.5,
      valence: clamp(g.v + hint.v + spreadV),
      arousal: clamp(g.a + hint.a + spreadA),
    };
  }

  const tempo = tempoNorm(a.bpm);
  const arousalAudio = 0.46 * a.energy + 0.26 * tempo + 0.16 * a.brightness + 0.12 * a.beat;
  const valenceAudio = 0.42 * (a.mode ? 0.72 : 0.3)
    + 0.22 * a.brightness + 0.2 * a.beat + 0.16 * (1 - a.dynamics);
  // Modo e brilho erram em generos sombrios, por isso o genero ainda opina.
  const hasGenre = genreId !== 'other';
  return {
    genreId,
    family: g.f,
    confidence: 1,
    bpm: a.bpm,
    energy: a.energy,
    bass: a.bass,
    mid: a.mid ?? 0.5,
    treble: a.treble,
    brightness: a.brightness,
    pitch: a.pitchHz ? clamp(Math.log2(a.pitchHz / 80) / 3.6) : 0.5,
    mode: a.mode,
    key: a.key ?? null,
    dynamics: a.dynamics,
    beat: a.beat,
    valence: clamp(lerp(valenceAudio, g.v + hint.v, hasGenre ? 0.45 : 0.1)),
    arousal: clamp(lerp(arousalAudio, g.a + hint.a, hasGenre ? 0.25 : 0.05)),
  };
}

const AUDIO_DIM = 13;
export const TRACK_DIM = AUDIO_DIM + FAMILY_COUNT;

export function trackVector(track) {
  const f = resolve(track);
  const v = new Float64Array(TRACK_DIM);
  v[0] = tempoNorm(f.bpm);
  v[1] = f.energy;
  v[2] = f.bass;
  v[3] = f.mid;
  v[4] = f.treble;
  v[5] = f.brightness;
  v[6] = f.pitch;
  v[7] = f.mode;
  v[8] = f.dynamics;
  v[9] = f.beat;
  v[10] = f.valence;
  v[11] = f.arousal;
  v[12] = clamp((track.duration || 210) / 480);
  v[AUDIO_DIM + f.family] = 1;
  return v;
}

// Roda de Camelot: distancia harmonica entre tons (0 = mesma casa).
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

export function harmonicDistance(a, b) {
  if (a.key == null || b.key == null) return null;
  const ca = (a.mode ? CAMELOT_MAJOR : CAMELOT_MINOR)[a.key];
  const cb = (b.mode ? CAMELOT_MAJOR : CAMELOT_MINOR)[b.key];
  const wheel = Math.min((ca - cb + 12) % 12, (cb - ca + 12) % 12);
  return wheel + (a.mode === b.mode ? 0 : wheel === 0 ? 1 : 1.5);
}

// Compara BPMs aceitando meio e dobro do tempo.
export function tempoGap(a, b) {
  if (!a || !b) return 0;
  return Math.min(
    Math.abs(Math.log2(a / b)),
    Math.abs(Math.log2((a * 2) / b)),
    Math.abs(Math.log2(a / (b * 2))),
  );
}

export function similarity(a, b) {
  const va = trackVector(a);
  const vb = trackVector(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i++) {
    const center = i < AUDIO_DIM ? 0.5 : 0;
    const x = va[i] - center;
    const y = vb[i] - center;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}
