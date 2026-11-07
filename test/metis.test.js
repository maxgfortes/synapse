import test from 'node:test';
import assert from 'node:assert/strict';
import { Metis, heuristicPrior, moodLabel } from '../js/metis/engine.js';
import { buildContext, contextVector, dayparts, CONTEXT_DIM, weatherClass } from '../js/metis/context.js';
import { analyzePCM } from '../js/metis/dsp.js';
import { harmonicDistance, resolve, tempoGap, trackVector, TRACK_DIM, genreOf } from '../js/metis/features.js';
import { normalizeGenre } from '../js/metis/genres.js';
import { WideDeep } from '../js/metis/nn.js';
import { makeRng, sigmoid, std, mean, clamp } from '../js/metis/math.js';

function makeLibrary(size, seed = 1) {
  const rng = makeRng(seed);
  const genres = ['pop', 'rock', 'ambient', 'hiphop', 'jazz', 'electronic', 'mpb', 'lofi', 'metal', 'samba'];
  const out = [];
  for (let i = 0; i < size; i++) {
    const genre = genres[Math.floor(rng() * genres.length)];
    out.push({
      id: `t${i}`,
      title: `Faixa ${i}`,
      artist: `Artista ${Math.floor(rng() * size * 0.3)}`,
      genre,
      duration: 150 + rng() * 150,
      features: {
        bpm: 70 + rng() * 100,
        energy: rng(), bass: rng(), mid: rng(), treble: rng(), brightness: rng(),
        pitchHz: 110 + rng() * 300, key: Math.floor(rng() * 12), mode: rng() > 0.5 ? 1 : 0,
        dynamics: rng(), beat: rng(),
      },
    });
  }
  return out;
}

function completionChance(track, ctx) {
  const f = resolve(track);
  const night = ctx.hour >= 22 || ctx.hour < 6;
  const rainy = ctx.weather === 'rain';
  const wantArousal = night ? 0.28 : rainy ? 0.4 : 0.75;
  const wantValence = rainy ? 0.35 : 0.62;
  const miss = Math.hypot(f.arousal - wantArousal, f.valence - wantValence);
  return sigmoid(3.2 - miss * 11);
}

function simulate(mode, { days = 21, seed = 11, library = makeLibrary(240) } = {}) {
  const metis = new Metis(null, { seed });
  const rng = makeRng(seed * 31);
  const start = new Date(2026, 0, 5, 0, 0).getTime();
  const windows = [];
  for (let day = 0; day < days; day++) {
    let listens = 0;
    let completes = 0;
    const rainyDay = rng() < 0.35;
    for (const hour of [8, 13, 19, 23]) {
      let prev = null;
      let ts = start + day * 864e5 + hour * 36e5;
      for (let i = 0; i < 10; i++) {
        const date = new Date(ts);
        const ctx = buildContext({
          date,
          weather: { kind: rainyDay ? 'rain' : 'clear', temp: 24 },
          session: { depth: i },
        });
        let track = library[Math.floor(rng() * library.length)];
        if (mode === 'metis') {
          const id = metis.plan(library, ctx, 1, { current: prev })[0].id;
          track = library.find((t) => t.id === id);
        }
        const finished = rng() < completionChance(track, ctx);
        const ratio = finished ? 1 : 0.1 + rng() * 0.2;
        if (mode === 'metis') {
          metis.observe({
            track, prev, ctx, library, ratio, skipped: !finished,
            listened: ratio * track.duration, intent: 'metis',
          });
        }
        listens++;
        completes += finished ? 1 : 0;
        ts += ratio * track.duration * 1000;
        prev = track;
      }
    }
    windows.push(completes / listens);
  }
  return { windows, metis };
}

test('o ouvinte simulado escuta mais ate o fim com Metis do que com aleatorio', () => {
  const scores = { metis: [], random: [] };
  for (const seed of [3, 11, 29]) {
    const library = makeLibrary(240, seed);
    for (const mode of ['metis', 'random']) {
      const { windows } = simulate(mode, { seed, library });
      scores[mode].push(mean(windows.slice(-7)));
    }
  }
  const metis = mean(scores.metis);
  const random = mean(scores.random);
  console.log(`  taxa de conclusao, ultima semana: Metis ${(metis * 100).toFixed(1)}% | aleatorio ${(random * 100).toFixed(1)}%`);
  assert.ok(metis > random + 0.12, `Metis ${metis} vs aleatorio ${random}`);
});

test('o Metis melhora com o tempo: terceira semana melhor que a primeira', () => {
  const firstWeek = [];
  const lastWeek = [];
  for (const seed of [5, 17, 41]) {
    const { windows } = simulate('metis', { seed, library: makeLibrary(240, seed) });
    firstWeek.push(mean(windows.slice(0, 7)));
    lastWeek.push(mean(windows.slice(-7)));
  }
  console.log(`  semana 1: ${(mean(firstWeek) * 100).toFixed(1)}% | semana 3: ${(mean(lastWeek) * 100).toFixed(1)}%`);
  assert.ok(mean(lastWeek) > mean(firstWeek));
});

test('ordem infinita: sem repetir musica dentro da janela e sem colar artistas', () => {
  const library = makeLibrary(200);
  const metis = new Metis(null, { seed: 9 });
  let ts = new Date(2026, 2, 3, 15).getTime();
  let prev = null;
  const seen = [];
  let sameArtist = 0;
  for (let i = 0; i < 500; i++) {
    const ctx = buildContext({ date: new Date(ts), weather: { kind: 'clear', temp: 25 } });
    const entry = metis.plan(library, ctx, 1, { current: prev })[0];
    const track = library.find((t) => t.id === entry.id);
    assert.ok(track, 'sempre devolve uma musica');
    const window = seen.slice(-40);
    assert.ok(!window.includes(track.id), `repetiu ${track.id} dentro de 40 faixas`);
    if (prev && prev.artist === track.artist) sameArtist++;
    metis.observe({ track, prev, ctx, library, ratio: 1, intent: 'metis' });
    seen.push(track.id);
    prev = track;
    ts += track.duration * 1000;
  }
  assert.ok(sameArtist / 500 < 0.03, `artista repetido em ${sameArtist}/500 trocas`);
});

test('a onda muda o clima ao longo da sessao sem saltos bruscos', () => {
  const library = makeLibrary(300);
  const metis = new Metis(null, { seed: 21 });
  const space = metis._space(library);
  let ts = new Date(2026, 2, 3, 14).getTime();
  let prev = null;
  const arousal = [];
  const valence = [];

  for (let i = 0; i < 180; i++) {
    const ctx = buildContext({ date: new Date(new Date(2026, 2, 3, 15).getTime()), weather: { kind: 'cloudy', temp: 22 } });
    ctx.ts = ts;
    const entry = metis.plan(library, ctx, 1, { current: prev })[0];
    const track = library.find((t) => t.id === entry.id);
    metis.observe({ track, prev, ctx, library, ratio: 1, intent: 'metis' });
    const p = metis._place(track, space);
    arousal.push(p.a);
    valence.push(p.v);
    prev = track;
    ts += track.duration * 1000;
  }
  const blocks = [];
  for (let i = 0; i + 20 <= arousal.length; i += 20) {
    blocks.push({ a: mean(arousal.slice(i, i + 20)), v: mean(valence.slice(i, i + 20)) });
  }
  const moved = Math.max(std(blocks.map((b) => b.a)), std(blocks.map((b) => b.v)));
  const steps = arousal.slice(1).map((x, i) => Math.hypot(x - arousal[i], valence[i + 1] - valence[i]));
  const shuffled = library.slice().sort((a, b) => a.id.localeCompare(b.id));
  const randomSteps = shuffled.slice(1, 180).map((t, i) => {
    const p = metis._place(t, space);
    const q = metis._place(shuffled[i], space);
    return Math.hypot(p.a - q.a, p.v - q.v);
  });
  console.log(`  deriva entre blocos ${moved.toFixed(3)} | passo medio ${mean(steps).toFixed(3)} vs aleatorio ${mean(randomSteps).toFixed(3)}`);
  assert.ok(moved > 0.08, `sessao ficou parada: ${moved}`);
  assert.ok(mean(steps) < mean(randomSteps) * 0.85, 'transicoes deveriam ser mais suaves que aleatorio');
});

test('exportar e importar preserva o modelo', () => {
  const library = makeLibrary(60);
  const metis = new Metis(null, { seed: 4 });
  const ctx = buildContext({ date: new Date(2026, 5, 2, 20), weather: { kind: 'rain', temp: 14 } });
  for (const track of library.slice(0, 30)) {
    metis.observe({ track, ctx, library, ratio: 1, intent: 'manual' });
  }
  const restored = new Metis(JSON.parse(JSON.stringify(metis)));
  const x = new Float64Array(metis.net.inputDim).fill(0.3);
  const wide = new Float64Array(metis.net.wideDim).fill(0.1);
  assert.ok(Math.abs(metis.net.predict(x, wide) - restored.net.predict(x, wide)) < 1e-3);
  assert.equal(restored.metrics.samples, 30);
  assert.deepEqual(restored.plan(library, ctx, 3).map((p) => p.id), new Metis(JSON.parse(JSON.stringify(metis))).plan(library, ctx, 3).map((p) => p.id));
});

test('funciona em bibliotecas pequenas e com faixas sem audio analisado', () => {
  const ctx = buildContext({ date: new Date(2026, 5, 2, 20) });
  const metis = new Metis(null, { seed: 2 });
  assert.deepEqual(metis.plan([], ctx, 3), []);
  const one = [{ id: 'a', title: 'Solo', artist: 'X' }];
  assert.equal(metis.plan(one, ctx, 1, { current: one[0] })[0].id, 'a');
  const few = [{ id: 'a', title: 'Slowed', artist: 'X', genre: 'Rock' }, { id: 'b', title: 'Y', artist: 'Z' }];
  const plan = metis.plan(few, ctx, 5);
  assert.equal(plan.length, 5);
  assert.ok(metis.plan(few, ctx, 1)[0].reasons.length > 0);
});

test('forget remove todos os rastros da faixa', () => {
  const library = makeLibrary(10);
  const metis = new Metis(null, { seed: 2 });
  const ctx = buildContext({ date: new Date(2026, 5, 2, 20) });
  metis.observe({ track: library[1], prev: library[0], ctx, library, ratio: 1 });
  metis.forget('t1');
  assert.equal(metis.stats.t1, undefined);
  assert.ok(!metis.memory.some((m) => m.id === 't1'));
  assert.equal(Object.keys(metis.transitions).length, 0);
});

test('prior de contexto: madrugada e chuva puxam para baixo', () => {
  const day = heuristicPrior(buildContext({ date: new Date(2026, 5, 3, 16), weather: { kind: 'clear', temp: 26 } }));
  const late = heuristicPrior(buildContext({ date: new Date(2026, 5, 3, 3), weather: { kind: 'rain', temp: 14 } }));
  assert.ok(day.a > late.a + 0.3);
  assert.ok(day.v > late.v);
  assert.equal(moodLabel(0.9, 0.9), 'animado');
  assert.equal(moodLabel(0.1, 0.1), 'melancólico');
});

test('rede Wide & Deep aprende uma funcao nao linear (XOR)', () => {
  const net = new WideDeep({ inputDim: 2, wideDim: 1, hidden: [8, 4], lr: 0.03, l2: 0, seed: 3 });
  const data = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]].map(([a, b, y]) => ({
    x: Float64Array.from([a * 2 - 1, b * 2 - 1]), wide: Float64Array.from([0]), y, w: 1,
  }));
  for (let i = 0; i < 1500; i++) net.train(data);
  for (const d of data) assert.equal(Math.round(net.predict(d.x, d.wide)), d.y);
});

test('gradiente do backprop bate com a diferenca numerica', () => {
  const net = new WideDeep({ inputDim: 3, wideDim: 2, hidden: [4, 3], lr: 1e-9, l2: 0, seed: 8 });
  const x = Float64Array.from([0.2, -0.4, 0.7]);
  const wide = Float64Array.from([0.3, -0.2]);
  const y = 1;
  const loss = () => {
    const p = net.predict(x, wide);
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  };
  const before = loss();
  const h = 1e-5;
  const W = net.W[0];
  const original = W[2];
  W[2] = original + h;
  const numeric = (loss() - before) / h;
  W[2] = original;

  net.train([{ x, wide, y, w: 1 }]);
  assert.equal(Math.sign(W[2] - original), -Math.sign(numeric));
});

function synth(seconds, sr, fn) {
  const out = new Float32Array(Math.floor(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / sr);
  return out;
}

test('DSP encontra o BPM de um metronomo', () => {
  const sr = 22050;
  for (const bpm of [84, 120, 140]) {
    const period = 60 / bpm;
    const pcm = synth(30, sr, (t) => {
      const phase = t % period;
      return Math.exp(-phase * 60) * Math.sin(2 * Math.PI * 180 * phase);
    });
    const result = analyzePCM(pcm, sr);
    assert.ok(tempoGap(result.bpm, bpm) < 0.03, `esperado ${bpm}, veio ${result.bpm}`);
  }
});

test('DSP separa graves de agudos e acha o tom', () => {
  const sr = 22050;
  const low = analyzePCM(synth(10, sr, (t) => 0.5 * Math.sin(2 * Math.PI * 70 * t)), sr);
  const high = analyzePCM(synth(10, sr, (t) => 0.5 * Math.sin(2 * Math.PI * 7000 * t)), sr);
  assert.ok(low.bass > 0.8 && high.bass < 0.2, `grave ${low.bass}, agudo ${high.bass}`);
  assert.ok(high.treble > low.treble);
  assert.ok(high.brightness > low.brightness);

  const notes = [220, 261.63, 329.63, 440, 523.25, 659.25];
  const minor = analyzePCM(synth(10, sr, (t) => notes.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) / 8), sr);
  assert.equal(minor.key, 9);
  assert.equal(minor.mode, 0);
  const melody = analyzePCM(synth(10, sr, (t) => 0.5 * Math.sin(2 * Math.PI * 330 * t)), sr);
  assert.ok(Math.abs(melody.pitchHz - 330) < 12, `pitch ${melody.pitchHz}`);
});

test('DSP lida com silencio e audio curto', () => {
  assert.equal(analyzePCM(new Float32Array(100), 44100), null);
  const quiet = analyzePCM(new Float32Array(44100 * 5), 44100);
  assert.equal(quiet.energy, 0);
  assert.equal(quiet.bpm, 0);
});

test('features usam o genero como reserva e o audio quando existe', () => {
  const noAudio = resolve({ id: 'x', title: 'Song', artist: 'A', genre: 'Metal' });
  assert.equal(noAudio.confidence, 0.3);
  assert.ok(noAudio.arousal > 0.7);
  const slowed = resolve({ id: 'x', title: 'Meant To Be - Slowed', artist: 'A', genre: 'Rock' });
  assert.ok(slowed.bpm < 110);
  const v = trackVector({ id: 'y', title: 'S', artist: 'A' });
  assert.equal(v.length, TRACK_DIM);
  assert.equal(contextVector(buildContext()).length, CONTEXT_DIM);
  assert.ok(Math.abs(dayparts(13).reduce((s, x) => s + x, 0) - 1) < 1e-9);
  assert.equal(dayparts(3).indexOf(Math.max(...dayparts(3))), 3);
  assert.equal(dayparts(13).indexOf(Math.max(...dayparts(13))), 1);
});

test('genero, tom e clima sao normalizados', () => {
  assert.equal(normalizeGenre('Hip-Hop/Rap'), 'hiphop');
  assert.equal(normalizeGenre('Música Popular Brasileira'), 'mpb');
  assert.equal(normalizeGenre('Eletrônica'), 'electronic');
  assert.equal(normalizeGenre('Alternativa'), 'alternative');
  assert.equal(normalizeGenre('Sertanejo Universitário'), 'sertanejo');
  assert.equal(normalizeGenre('xyz'), null);
  assert.equal(genreOf({ title: 'lofi beats', artist: '' }), 'lofi');
  assert.equal(harmonicDistance({ key: 0, mode: 1 }, { key: 7, mode: 1 }), 1);
  assert.equal(harmonicDistance({ key: 0, mode: 1 }, { key: 9, mode: 0 }), 1);
  assert.equal(harmonicDistance({ key: null }, { key: 7 }), null);
  assert.equal(tempoGap(70, 140), 0);
  assert.equal(weatherClass(0), 'clear');
  assert.equal(weatherClass(61), 'rain');
  assert.equal(weatherClass(95), 'storm');
  assert.equal(weatherClass(73), 'snow');
  assert.equal(clamp(5), 1);
});

test('escolher a proxima musica e rapido mesmo com 5000 faixas', () => {
  const library = makeLibrary(5000);
  const metis = new Metis(null, { seed: 6 });
  const ctx = buildContext({ date: new Date(2026, 5, 2, 20), weather: { kind: 'clear', temp: 25 } });
  for (const track of library.slice(0, 200)) metis.observe({ track, ctx, library: library.slice(0, 300), ratio: 1 });
  const start = performance.now();
  metis.plan(library, ctx, 1);
  const elapsed = performance.now() - start;
  console.log(`  uma escolha em 5000 faixas: ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 400, `${elapsed} ms`);
});
