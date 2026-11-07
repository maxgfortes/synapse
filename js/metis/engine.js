// Metis: estima o estado emocional do ouvinte no plano valencia/excitacao e
// sorteia a proxima musica. Cinco pecas trabalham juntas:
//   1. Prior de contexto: regras (hora, clima) + memoria por kernel do que foi
//      ouvido em momentos parecidos.
//   2. Estado da sessao: segue o que voce escuta e se afasta do que pula.
//   3. Onda: mare lenta mais inquietacao, que tira a sessao de um clima so.
//   4. Aprendizado: rede Wide & Deep on-line e regressao por kernel, que cruza
//      momento e som. O kernel rende com poucos dados; a rede, com muitos.
//   5. Sorteio: Thompson sampling e softmax mantem a ordem infinita e variada.

import { clamp, hash32, hashUnit, lerp, logit, makeRng, betaSample, softmaxPick, round } from './math.js';
import { FAMILY_COUNT } from './genres.js';
import { CONTEXT_DIM, contextVector, compactContext, dayparts } from './context.js';
import { TRACK_DIM, harmonicDistance, resolve, similarity, tempoGap, trackVector } from './features.js';
import { WideDeep } from './nn.js';

export const METIS_VERSION = 1;

const EXTRA_DIM = 12;
const INPUT_DIM = TRACK_DIM + CONTEXT_DIM + EXTRA_DIM;
const WIDE_TRACK = [10, 11, 0, 1, 2, 5]; // valencia, excitacao, tempo, energia, graves, brilho
const WIDE_DIM = WIDE_TRACK.length * 10 + FAMILY_COUNT * 4;

const MEMORY_CAP = 1500;
const REPLAY_CAP = 320;
const TRAIL_CAP = 600;
const TRANSITION_CAP = 4000;
const RECENT_CAP = 80;
const SESSION_WINDOW = 3 * 36e5;
const TAU = 2 * Math.PI;

const artistKey = (track) => (track.artist || '').trim().toLowerCase();

export function moodLabel(v, a) {
  const hi = 0.58;
  const lo = 0.42;
  if (a >= hi && v >= hi) return 'animado';
  if (a >= hi && v <= lo) return 'intenso';
  if (a <= lo && v >= hi) return 'sereno';
  if (a <= lo && v <= lo) return 'melancólico';
  if (a >= hi) return 'enérgico';
  if (a <= lo) return 'calmo';
  if (v >= hi) return 'leve';
  if (v <= lo) return 'introspectivo';
  return 'equilibrado';
}

// Regras de partida. Valem sozinhas ate existir historico suficiente.
export function heuristicPrior(ctx) {
  let a = 0.5 + 0.24 * Math.cos((TAU * (ctx.hour - 17)) / 24);
  let v = 0.52;
  if (ctx.weekend && (ctx.hour >= 20 || ctx.hour < 2)) a += 0.12;
  if (!ctx.weekend && ctx.hour >= 6 && ctx.hour < 10) a += 0.05;
  a += (ctx.daylight - 0.5) * 0.08;
  switch (ctx.weather) {
    case 'rain': v -= 0.08; a -= 0.07; break;
    case 'storm': v -= 0.1; a += 0.02; break;
    case 'fog': v -= 0.03; a -= 0.06; break;
    case 'snow': v += 0.02; a -= 0.06; break;
    case 'clear':
      if (ctx.daylight > 0.5) { v += 0.09; a += 0.04; }
      break;
    default: break;
  }
  if (ctx.temp != null) {
    if (ctx.temp >= 28) { a += 0.05; v += 0.02; }
    if (ctx.temp <= 12) { a -= 0.05; v -= 0.03; }
  }
  if ((ctx.tempAnomaly || 0) > 4) v += 0.03;
  if (ctx.weekend) v += 0.05;
  if (ctx.holiday) v += 0.06;
  if ((ctx.sessionMinutes || 0) > 150) a -= 0.04;
  return { v: clamp(v, 0.05, 0.95), a: clamp(a, 0.05, 0.95) };
}

export class Metis {
  constructor(saved = null, { seed = (Date.now() ^ (Math.random() * 2 ** 31)) >>> 0 } = {}) {
    const s = saved && saved.version === METIS_VERSION ? saved : null;
    this.seed = s?.seed ?? seed;
    this.rng = makeRng(s?.rngState ?? this.seed);
    this.net = s?.net
      ? WideDeep.fromJSON(s.net)
      : new WideDeep({ inputDim: INPUT_DIM, wideDim: WIDE_DIM, seed: this.seed });
    this.stats = s?.stats ?? {};
    this.transitions = s?.transitions ?? {};
    this.memory = s?.memory ?? [];
    this.replay = s?.replay ?? [];
    this.trail = s?.trail ?? [];
    this.recent = s?.recent ?? [];
    this.mood = s?.mood ?? { v: 0.5, a: 0.5, ts: 0 };
    this.settings = { adventure: 0.35, ...(s?.settings || {}) };
    this.metrics = {
      events: 0, samples: 0, loss: null, baseLoss: null, meanY: 0.6,
      intents: {},
      ...(s?.metrics || {}),
    };
    this.createdAt = s?.createdAt ?? Date.now();
  }

  toJSON() {
    return {
      version: METIS_VERSION,
      seed: this.seed,
      rngState: this.rng.state(),
      createdAt: this.createdAt,
      net: this.net.toJSON(),
      stats: this.stats,
      transitions: this.transitions,
      memory: this.memory,
      replay: this.replay,
      trail: this.trail,
      recent: this.recent,
      mood: this.mood,
      settings: this.settings,
      metrics: this.metrics,
    };
  }

  // Espaco emocional relativo a biblioteca: 0,5 e o centro do que voce tem.
  // Sem isso, uma biblioteca so de rock nunca alcancaria um alvo calmo.
  _space(library) {
    let sumV = 0;
    let sumA = 0;
    for (const t of library) {
      const f = resolve(t);
      sumV += f.valence;
      sumA += f.arousal;
    }
    const n = library.length || 1;
    const mv = sumV / n;
    const ma = sumA / n;
    let varV = 0;
    let varA = 0;
    for (const t of library) {
      const f = resolve(t);
      varV += (f.valence - mv) ** 2;
      varA += (f.arousal - ma) ** 2;
    }
    const sv = Math.max(Math.sqrt(varV / n), 0.06);
    const sa = Math.max(Math.sqrt(varA / n), 0.06);
    return {
      v: (x) => clamp(0.5 + (x - mv) / (4 * sv)),
      a: (x) => clamp(0.5 + (x - ma) / (4 * sa)),
    };
  }

  _place(track, space) {
    const f = resolve(track);
    return { v: space.v(f.valence), a: space.a(f.arousal) };
  }

  // Memoria por kernel: pesa cada audicao passada pela semelhanca do momento.
  _memoryView(ctx, space) {
    const now = compactContext(ctx);
    const byTrack = new Map();
    const byArtist = new Map();
    const byFamily = new Map();
    const neighbors = [];
    let sumV = 0;
    let sumA = 0;
    let weight = 0;
    const bump = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
    for (const m of this.memory) {
      let d2 = 0;
      for (let i = 0; i < now.length; i++) d2 += (now[i] - m.c[i]) ** 2;
      const age = (ctx.ts - m.ts) / 864e5;
      const k = Math.exp(-d2 / 0.6) * Math.exp(-Math.max(age, 0) / 120) * m.w;
      if (k < 0.01) continue;
      const signed = k * (2 * m.y - 1);
      bump(byTrack, m.id, signed);
      bump(byArtist, m.ar, signed);
      bump(byFamily, m.f, signed);
      // A sessao atual nao conta como evidencia: senao o que acabou de tocar
      // puxaria mais do mesmo e o clima nunca mudaria.
      if (ctx.ts - m.ts < SESSION_WINDOW) continue;
      neighbors.push({ k, y: m.y, v: space.v(m.v), a: space.a(m.a), f: m.f });
      if (m.y >= 0.5) {
        const gain = k * m.y;
        sumV += space.v(m.v) * gain;
        sumA += space.a(m.a) * gain;
        weight += gain;
      }
    }
    if (neighbors.length > 360) {
      neighbors.sort((x, y) => y.k - x.k);
      neighbors.length = 360;
    }
    return {
      byTrack, byArtist, byFamily, neighbors,
      learned: weight > 0 ? { v: sumV / weight, a: sumA / weight } : null,
      weight,
    };
  }

  // Regressao por kernel no contexto e no som: em momentos parecidos, como foram
  // as musicas com som parecido? Generaliza entre faixas com poucos exemplos,
  // que e justamente onde a rede ainda erra.
  _neighborEstimate(place, family, neighbors) {
    let support = 0;
    let hits = 0;
    for (const n of neighbors) {
      const d2 = (place.v - n.v) ** 2 + (place.a - n.a) ** 2;
      if (d2 > 0.1) continue;
      const k = n.k * Math.exp(-d2 / 0.018) * (n.f === family ? 1 : 0.75);
      support += k;
      hits += k * n.y;
    }
    const prior = this.metrics.meanY;
    return { value: (hits + prior * 1.2) / (support + 1.2), prior, support };
  }

  // Mare lenta: osciladores de periodos que nao se alinham. A fase e pessoal
  // e o tempo e o do relogio, entao o clima muda sozinho ao longo das horas.
  _tide(ts) {
    const h = ts / 36e5;
    const phase = (i) => TAU * hashUnit(`${this.seed}:${i}`);
    const wave = (period, i) => Math.sin((TAU * h) / period + phase(i));
    return {
      v: 0.1 * wave(5.3, 1) + 0.07 * wave(1.7, 2) + 0.05 * wave(17, 3),
      a: 0.11 * wave(3.9, 4) + 0.08 * wave(1.1, 5) + 0.05 * wave(13, 6),
    };
  }

  // Inquietacao: quando a sessao para no mesmo lugar do mapa, cresce uma forca
  // que empurra para a regiao menos visitada nas ultimas 48 horas.
  _restless(ts, base, adventure) {
    const windowed = this.trail.slice(-14);
    if (windowed.length < 6) return { v: 0, a: 0, urge: 0 };
    let cv = 0;
    let ca = 0;
    for (const p of windowed) { cv += p.v; ca += p.a; }
    cv /= windowed.length;
    ca /= windowed.length;
    let spread = 0;
    for (const p of windowed) spread += (p.v - cv) ** 2 + (p.a - ca) ** 2;
    spread = Math.sqrt(spread / windowed.length);
    const urge = clamp((0.17 - spread) / 0.12) * clamp(windowed.length / 12);
    if (urge <= 0) return { v: 0, a: 0, urge: 0 };

    const horizon = ts - 48 * 36e5;
    const recent = this.trail.filter((p) => p.ts >= horizon);
    const hourBucket = Math.floor(ts / 36e5);
    let best = null;
    for (let i = 0; i < 8; i++) {
      const angle = (TAU * i) / 8;
      const x = base.v + 0.32 * Math.cos(angle);
      const y = base.a + 0.32 * Math.sin(angle);
      if (x < 0.06 || x > 0.94 || y < 0.06 || y > 0.94) continue;
      let density = 0;
      for (const p of recent) density += Math.exp(-((p.v - x) ** 2 + (p.a - y) ** 2) / 0.05);
      // Desempate por hora: a direcao fica estavel dentro de uma mesma hora.
      density += hashUnit(`${this.seed}:${hourBucket}:${i}`) * 0.5;
      if (!best || density < best.density) best = { x, y, density };
    }
    if (!best) return { v: 0, a: 0, urge };
    const gain = urge * (0.7 + 0.5 * adventure);
    return { v: (best.x - base.v) * gain, a: (best.y - base.a) * gain, urge };
  }

  _target(ctx, view, sim) {
    const adventure = this.settings.adventure;
    const rule = heuristicPrior(ctx);
    const beta = view.weight / (view.weight + 3);
    const base = view.learned
      ? { v: lerp(rule.v, view.learned.v, beta), a: lerp(rule.a, view.learned.a, beta) }
      : rule;
    const gapMinutes = (ctx.ts - sim.mood.ts) / 6e4;
    const pull = clamp(0.18 + (1 - Math.exp(-gapMinutes / 60)) * 0.82);
    const current = { v: lerp(sim.mood.v, base.v, pull), a: lerp(sim.mood.a, base.a, pull) };
    const tide = this._tide(ctx.ts);
    const restless = this._restless(ctx.ts, current, adventure);
    let dv = tide.v + restless.v;
    let da = tide.a + restless.a;
    // Limite de passo: a onda sobe devagar, sem saltos de clima.
    const size = Math.hypot(dv, da);
    const limit = 0.2 + 0.12 * adventure + 0.1 * restless.urge;
    if (size > limit) {
      dv *= limit / size;
      da *= limit / size;
    }
    return {
      v: clamp(current.v + dv, 0.03, 0.97),
      a: clamp(current.a + da, 0.03, 0.97),
      base,
      rule,
      beta,
      urge: restless.urge,
    };
  }

  _extra(track, target, prev, space, ts) {
    const f = resolve(track);
    const p = this._place(track, space);
    const stat = this.stats[track.id];
    const plays = stat?.plays || 0;
    let gapTempo = 0;
    let keyDist = 0.3;
    let gapEnergy = 0;
    let sameFamily = 0;
    let sameArtist = 0;
    if (prev) {
      const fp = resolve(prev);
      gapTempo = clamp(tempoGap(f.bpm, fp.bpm));
      const h = harmonicDistance(f, fp);
      keyDist = h == null ? 0.3 : clamp(h / 6);
      gapEnergy = Math.abs(f.energy - fp.energy);
      sameFamily = f.family === fp.family ? 1 : 0;
      sameArtist = artistKey(track) === artistKey(prev) ? 1 : 0;
    }
    return Float64Array.from([
      p.v - target.v, p.a - target.a, clamp(Math.hypot(p.v - target.v, p.a - target.a)),
      gapTempo, keyDist, gapEnergy, sameFamily, sameArtist,
      clamp(Math.log1p(plays) / 5),
      track.liked ? 1 : 0,
      plays ? clamp((stat.skips || 0) / plays) : 0.3,
      stat?.last ? clamp((ts - stat.last) / (30 * 864e5)) : 1,
    ]);
  }

  _wide(trackVec, family, ctx) {
    const parts = dayparts(ctx.hour);
    const rainy = ctx.weather === 'rain' || ctx.weather === 'storm' ? 1 : 0;
    const clear = ctx.weather === 'clear' ? 1 : 0;
    const cold = ctx.temp != null && ctx.temp < 15 ? 1 : 0;
    const hot = ctx.temp != null && ctx.temp > 27 ? 1 : 0;
    const cross = [...parts, ctx.weekend ? 1 : 0, rainy, clear, cold, hot, 1 - ctx.daylight];
    const wide = new Float64Array(WIDE_DIM);
    let i = 0;
    for (const t of WIDE_TRACK) {
      const value = trackVec[t] - 0.5;
      for (const c of cross) wide[i++] = value * c;
    }
    wide[i + family * 4] = parts[0];
    wide[i + family * 4 + 1] = parts[1];
    wide[i + family * 4 + 2] = parts[2];
    wide[i + family * 4 + 3] = parts[3];
    return wide;
  }

  _input(track, ctxVec, ctx, target, prev, space) {
    const tv = trackVector(track);
    const extra = this._extra(track, target, prev, space, ctx.ts);
    const x = new Float64Array(INPUT_DIM);
    x.set(tv, 0);
    x.set(ctxVec, TRACK_DIM);
    x.set(extra, TRACK_DIM + CONTEXT_DIM);
    return { x, wide: this._wide(tv, resolve(track).family, ctx) };
  }

  // Peso da rede: comeca em zero e cresce conforme ela acumula evidencia.
  _alpha() {
    const n = this.metrics.samples;
    return Math.min(0.9, n / (n + 40));
  }

  _rest(track, ts, libSize) {
    const stat = this.stats[track.id];
    if (!stat?.last) return 1;
    const tau = clamp(libSize * 4, 45, 14 * 1440) * (1 + 0.2 * Math.log1p(stat.plays || 0));
    return 1 - Math.exp(-Math.max(ts - stat.last, 0) / 6e4 / tau);
  }

  _score(track, s) {
    const f = resolve(track);
    const p = this._place(track, s.space);
    const parts = {};
    const adventure = this.settings.adventure;

    const sigma = 0.15 + 0.09 * adventure;
    const d2 = (p.v - s.target.v) ** 2 + (p.a - s.target.a) ** 2;
    parts.fit = Math.max(-1.5 * (d2 / (2 * sigma * sigma)), -6);

    parts.flow = 0;
    parts.trans = 0;
    if (s.prev) {
      const fp = resolve(s.prev);
      const conf = Math.min(f.confidence, fp.confidence);
      parts.flow -= tempoGap(f.bpm, fp.bpm) * 2.4 * Math.max(conf, 0.5);
      parts.flow -= Math.abs(f.energy - fp.energy) * 1.3;
      const h = harmonicDistance(f, fp);
      if (h != null) parts.flow -= 0.11 * h;
      parts.flow += 0.25 * similarity(track, s.prev);
      if (f.family === fp.family) parts.flow += 0.25;
      const tr = this.transitions[`${s.prev.id}>${track.id}`];
      if (tr) parts.trans = 1.3 * Math.tanh(tr / 1.5);
    }

    const artist = artistKey(track);
    const gap = s.artistGap.get(artist);
    parts.artist = gap == null ? 0 : gap === 0 ? -2.4 : gap < 3 ? -1.2 : gap < 8 ? -0.45 : 0;

    parts.rest = 0.75 * Math.log(this._rest(track, s.ts, s.size) + 0.03);

    const stat = this.stats[track.id];
    const a = stat?.a ?? 1.2;
    const b = stat?.b ?? 1;
    parts.taste = (0.3 + 0.45 * adventure) * logit(betaSample(a, b, this.rng));

    parts.memory = 1.1 * Math.tanh(s.view.byTrack.get(track.id) || 0)
      + 0.5 * Math.tanh((s.view.byArtist.get(hash32(artist)) || 0) / 2)
      + 0.4 * Math.tanh((s.view.byFamily.get(f.family) || 0) / 3);

    const near = this._neighborEstimate(p, f.family, s.view.neighbors);
    const appetite = 1 - 0.75 * s.target.urge;
    const lift = clamp(logit(near.value) - logit(near.prior), -3, 3);
    // Rejeicao segue valendo inteira; so o reforco positivo cede a inquietacao.
    parts.neighbors = 2.6 * (lift > 0 ? lift * appetite : lift);

    parts.like = track.liked ? 0.5 : 0;
    parts.model = 0;
    if (s.alpha > 0.02 && s.useModel) {
      const { x, wide } = this._input(track, s.ctxVec, s.ctx, s.target, s.prev, s.space);
      parts.model = s.alpha * 3 * clamp(this.net.logit(x, wide), -4, 4);
    }
    let total = 0;
    for (const key in parts) total += parts[key];
    return { total, parts };
  }

  // Devolve as proximas n musicas simulando a sessao adiante.
  plan(library, ctx, n = 1, { current = null, exclude = [], history = [] } = {}) {
    const pool = library.filter((t) => t.playable !== false);
    if (!pool.length) return [];
    const space = this._space(pool);
    const view = this._memoryView(ctx, space);
    const ctxVec = contextVector(ctx);
    const alpha = this._alpha();
    const size = pool.length;
    const blockSize = Math.min(Math.floor(size * 0.6), 40);
    const out = [];
    const recent = [...this.recent, ...history];
    const sim = { mood: { ...this.mood }, ts: ctx.ts, prev: current };
    const skipPressure = clamp((ctx.recentSkips || 0) / 4);
    const byId = new Map(pool.map((t) => [t.id, t]));
    const excluded = new Set(exclude);

    for (let i = 0; i < n; i++) {
      const stepCtx = { ...ctx, ts: sim.ts, hour: (ctx.hour + (sim.ts - ctx.ts) / 36e5) % 24 };
      const target = this._target(stepCtx, view, sim);
      const blocked = new Set(recent.slice(-blockSize));
      if (current) blocked.add(current.id);
      for (const id of excluded) blocked.add(id);
      let candidates = pool.filter((t) => !blocked.has(t.id));
      if (!candidates.length) candidates = pool.filter((t) => t.id !== sim.prev?.id);
      if (!candidates.length) candidates = pool;

      const artistGap = new Map();
      const tail = recent.slice(-10).reverse();
      tail.forEach((id, index) => {
        const t = byId.get(id);
        if (!t) return;
        const key = artistKey(t);
        if (!artistGap.has(key)) artistGap.set(key, index);
      });
      if (sim.prev) artistGap.set(artistKey(sim.prev), 0);

      const state = {
        ctx: stepCtx, ctxVec, target, prev: sim.prev, space, view, alpha, size,
        ts: sim.ts, artistGap, useModel: false,
      };
      // Bibliotecas grandes: filtro barato antes de consultar a rede.
      if (candidates.length > 320) {
        const ranked = candidates
          .map((t) => ({ t, s: this._score(t, state).total }))
          .sort((x, y) => y.s - x.s);
        candidates = ranked.slice(0, 260).map((r) => r.t);
      }
      state.useModel = true;
      const scored = candidates.map((t) => ({ t, ...this._score(t, state) }));
      const temperature = 0.42 + 0.5 * this.settings.adventure + 0.25 * skipPressure;
      const index = softmaxPick(scored.map((r) => r.total), temperature, this.rng);
      const pick = scored[index];
      const typical = {};
      for (const row of scored) {
        for (const key in row.parts) typical[key] = (typical[key] || 0) + row.parts[key] / scored.length;
      }

      out.push({
        id: pick.t.id,
        target: { v: round(target.v, 3), a: round(target.a, 3) },
        urge: round(target.urge, 3),
        parts: pick.parts,
        reasons: this._reasons(pick, state, typical),
      });

      const place = this._place(pick.t, space);
      sim.mood = { v: lerp(sim.mood.v, place.v, 0.3), a: lerp(sim.mood.a, place.a, 0.3), ts: sim.ts };
      sim.ts += (pick.t.duration || 210) * 1000;
      sim.prev = pick.t;
      recent.push(pick.t.id);
      excluded.add(pick.t.id);
    }
    return out;
  }

  // Explica o que distingue a escolha das demais candidatas, nao o valor bruto.
  _reasons(pick, s, typical) {
    const { t: track, parts } = pick;
    const edge = (key) => parts[key] - (typical[key] || 0);
    const f = resolve(track);
    const out = [];
    const add = (score, text) => out.push({ score, text });
    add(0.5 + edge('fit'), `Combina com o clima alvo: ${moodLabel(s.target.v, s.target.a)}`);
    if (s.target.urge > 0.3) add(1.4, 'Mudando de ares: a sessão ficou tempo demais no mesmo clima');
    if (s.prev) {
      const fp = resolve(s.prev);
      if (f.confidence === 1 && fp.confidence === 1) {
        if (tempoGap(f.bpm, fp.bpm) < 0.08) add(0.9, `Transição suave: ${Math.round(fp.bpm)} para ${Math.round(f.bpm)} BPM`);
        const h = harmonicDistance(f, fp);
        if (h != null && h <= 1) add(0.8, 'Tom compatível com a música anterior');
      }
      if (parts.trans > 0.3) add(parts.trans, `Costuma funcionar depois de "${s.prev.title}"`);
    }
    if (edge('memory') > 0.3) add(edge('memory'), 'Você ouve isso em momentos parecidos com este');
    if (edge('neighbors') > 0.5) add(edge('neighbors') * 0.7, 'Músicas com som parecido funcionaram em momentos assim');
    if (edge('model') > 0.8) add(edge('model') * 0.6, 'O modelo prevê que você vai ouvir até o fim');
    if (parts.like) add(0.6, 'Você curtiu esta música');
    const stat = this.stats[track.id];
    if (!stat?.plays) add(0.7, 'Ainda não tocou: hora de descobrir');
    else if (stat.last && s.ts - stat.last > 7 * 864e5) {
      add(0.65, `Descansou por ${Math.round((s.ts - stat.last) / 864e5)} dias`);
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 3).map((r) => r.text);
  }

  // Marca a faixa como recente ja no inicio: quem pula rapido nao deve reouvir.
  noteStart(id) {
    if (this.recent.at(-1) === id) return;
    this.recent.push(id);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
  }

  // Recompensa de 0 a 1 a partir de quanto da musica foi ouvida.
  static reward({ ratio, skipped, listened = Infinity }) {
    if (!skipped) return 1;
    if (ratio >= 0.85) return 0.9;
    if (ratio < 0.15 || listened < 20) return 0;
    return clamp(ratio * 0.75, 0.05, 0.6);
  }

  // Chamado quando uma musica termina ou e pulada.
  observe({ track, prev = null, ctx, library, ratio = 1, listened, skipped = false, intent = 'metis', target = null }) {
    const pool = library?.length ? library : [track];
    const space = this._space(pool);
    const y = Metis.reward({ ratio, skipped, listened });
    const deliberate = intent === 'manual' || intent === 'queue';
    const weight = deliberate ? 1.6 : 1;
    const f = resolve(track);
    const ts = ctx.ts;

    const stat = this.stats[track.id] || { a: 1.2, b: 1, plays: 0, skips: 0, last: 0, manual: 0 };
    stat.a = 1.2 + (stat.a - 1.2) * 0.985 + y * weight;
    stat.b = 1 + (stat.b - 1) * 0.985 + (1 - y) * weight;
    stat.plays += 1;
    if (skipped && y < 0.25) stat.skips += 1;
    if (deliberate) stat.manual += 1;
    stat.last = ts;
    this.stats[track.id] = stat;

    if (prev) {
      const key = `${prev.id}>${track.id}`;
      this.transitions[key] = round((this.transitions[key] || 0) * 0.9 + (y - 0.5) * 2 * weight, 3);
      this._trimTransitions();
    }

    const place = this._place(track, space);
    if (y >= 0.5) {
      const gain = (deliberate ? 0.5 : 0.22) + 0.2 * y;
      this.mood = { v: lerp(this.mood.v, place.v, gain), a: lerp(this.mood.a, place.a, gain), ts };
    } else if (y < 0.25) {
      // Pular e um sinal negativo: o estado se afasta um pouco dessa regiao.
      this.mood = {
        v: clamp(this.mood.v - (place.v - this.mood.v) * 0.12),
        a: clamp(this.mood.a - (place.a - this.mood.a) * 0.12),
        ts,
      };
    } else {
      this.mood = { ...this.mood, ts };
    }
    this.trail.push({ ts, v: round(place.v, 3), a: round(place.a, 3), y: round(y, 2) });
    if (this.trail.length > TRAIL_CAP) this.trail.splice(0, this.trail.length - TRAIL_CAP);

    this.noteStart(track.id);

    this.memory.push({
      c: compactContext(ctx), id: track.id, ar: hash32(artistKey(track)), f: f.family,
      v: round(f.valence, 3), a: round(f.arousal, 3), y: round(y, 2), w: weight, ts,
    });
    if (this.memory.length > MEMORY_CAP) this.memory.splice(0, this.memory.length - MEMORY_CAP);

    const situation = target || this.mood;
    const { x, wide } = this._input(track, contextVector(ctx), ctx, situation, prev, space);
    this._learn(x, wide, y, weight);

    const bucket = this.metrics.intents[intent] || { n: 0, skips: 0, reward: 0 };
    bucket.n += 1;
    if (skipped && y < 0.25) bucket.skips += 1;
    bucket.reward = round(bucket.reward + y, 3);
    this.metrics.intents[intent] = bucket;
    this.metrics.events += 1;
    return y;
  }

  _learn(x, wide, y, w) {
    // Perda prequencial: avalia antes de treinar, entao e uma medida honesta.
    const m = this.metrics;
    const p = clamp(this.net.predict(x, wide), 1e-4, 1 - 1e-4);
    const q = clamp(m.meanY, 1e-4, 1 - 1e-4);
    const loss = -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    const base = -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
    const blend = 0.03;
    m.loss = m.loss == null ? loss : lerp(m.loss, loss, blend);
    m.baseLoss = m.baseLoss == null ? base : lerp(m.baseLoss, base, blend);
    m.meanY = lerp(m.meanY, y, 0.02);
    m.samples += 1;

    const packed = { x: Array.from(x, (v) => round(v, 3)), wide: Array.from(wide, (v) => round(v, 3)), y, w };
    if (this.replay.length < REPLAY_CAP) this.replay.push(packed);
    else this.replay[Math.floor(this.rng() * REPLAY_CAP)] = packed;

    const batch = [{ x, wide, y, w }];
    for (let i = 0; i < 15 && this.replay.length > 1; i++) {
      const r = this.replay[Math.floor(this.rng() * this.replay.length)];
      batch.push({ x: Float64Array.from(r.x), wide: Float64Array.from(r.wide), y: r.y, w: r.w });
    }
    this.net.train(batch);
  }

  _trimTransitions() {
    const keys = Object.keys(this.transitions);
    if (keys.length <= TRANSITION_CAP) return;
    keys.sort((a, b) => Math.abs(this.transitions[a]) - Math.abs(this.transitions[b]));
    for (const key of keys.slice(0, keys.length - TRANSITION_CAP)) delete this.transitions[key];
  }

  // Curtir sem esperar a musica acabar tambem ensina o modelo.
  feedback({ track, ctx, liked, library }) {
    const stat = this.stats[track.id] || { a: 1.2, b: 1, plays: 0, skips: 0, last: 0, manual: 0 };
    stat.a = Math.max(1.2, stat.a + (liked ? 2 : -2));
    this.stats[track.id] = stat;
    if (!liked) return;
    const pool = library?.length ? library : [track];
    const space = this._space(pool);
    const f = resolve(track);
    this.memory.push({
      c: compactContext(ctx), id: track.id, ar: hash32(artistKey(track)), f: f.family,
      v: round(f.valence, 3), a: round(f.arousal, 3), y: 1, w: 1.5, ts: ctx.ts,
    });
    if (this.memory.length > MEMORY_CAP) this.memory.shift();
    const { x, wide } = this._input(track, contextVector(ctx), ctx, this.mood, null, space);
    this._learn(x, wide, 1, 1.5);
  }

  // Remove uma faixa de todas as estruturas do modelo.
  forget(trackId) {
    delete this.stats[trackId];
    this.memory = this.memory.filter((m) => m.id !== trackId);
    this.recent = this.recent.filter((id) => id !== trackId);
    for (const key of Object.keys(this.transitions)) {
      const [a, b] = key.split('>');
      if (a === trackId || b === trackId) delete this.transitions[key];
    }
  }

  // Resumo para o painel do Metis.
  snapshot(library, ctx) {
    const pool = library.filter((t) => t.playable !== false);
    const space = this._space(pool.length ? pool : [{ id: '_', title: '', artist: '' }]);
    const view = this._memoryView(ctx, space);
    const target = this._target(ctx, view, { mood: this.mood });
    const m = this.metrics;
    const improvement = m.loss != null && m.samples >= 30 && m.baseLoss
      ? clamp(1 - m.loss / m.baseLoss, -1, 1)
      : null;
    return {
      mood: { v: this.mood.v, a: this.mood.a, label: moodLabel(this.mood.v, this.mood.a) },
      target: { v: target.v, a: target.a, label: moodLabel(target.v, target.a), urge: target.urge },
      base: target.base,
      rule: target.rule,
      trust: this._alpha(),
      contextTrust: target.beta,
      samples: m.samples,
      events: m.events,
      improvement,
      intents: m.intents,
      trail: this.trail.slice(-48),
      tracksKnown: Object.keys(this.stats).length,
      analyzed: library.filter((t) => t.features?.bpm).length,
    };
  }
}
