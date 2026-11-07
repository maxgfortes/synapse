// Fila, modos de ordem e aprendizado. As interfaces so chamam metodos daqui
// e reagem aos eventos do barramento.

import { bus } from './bus.js';
import { db } from './db.js';
import { store } from './store.js';
import { contextService } from './context.js';
import { AudioEngine, YouTubeEngine } from './engines.js';
import { findPlayable } from './youtube.js';
import { makeRng } from '../metis/math.js';

const PLAN_SIZE = 12;
const shuffleRng = makeRng();

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class Player {
  constructor() {
    this.audio = new AudioEngine();
    this.youtube = new YouTubeEngine();
    this.engine = null;
    this.current = null;
    this.currentEntry = null; // decisao do Metis para a faixa atual
    this.intent = 'metis';
    this.previous = null;
    this.order = 'metis'; // metis | shuffle | sequence
    this.repeat = 'off'; // off | all | one
    this.volume = 0.8;
    this.muted = false;
    this.playing = false;
    this.queue = []; // adicionados pelo usuario
    this.planned = []; // proximos do Metis
    this.bag = []; // proximos do aleatorio classico
    this.pool = null; // ids da playlist ou lista de origem; null = biblioteca
    this.poolLabel = 'Biblioteca';
    this.history = [];
    this.listened = 0;
    this.lastTime = 0;
    this.saveTick = 0;
    this.errorStreak = 0;
  }

  async init() {
    const saved = await db.getKV('player', {});
    this.order = saved.order || 'metis';
    this.repeat = saved.repeat || 'off';
    this.volume = saved.volume ?? 0.8;
    this.applyVolume();

    bus.on('engine:time', () => this._onTime());
    bus.on('engine:state', (playing) => {
      this.playing = playing;
      if (playing) this.errorStreak = 0;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      bus.emit('player');
    });
    bus.on('engine:ended', () => this._onEnded());
    bus.on('engine:duration', (seconds) => this._onDuration(seconds));
    bus.on('engine:error', (code) => this._onError(code));
    bus.on('library', () => this._onLibraryChange());
    this._bindMediaSession();

    const resume = saved.current && store.get(saved.current);
    if (resume) {
      this.current = resume;
      this.resumeAt = saved.position || 0;
      bus.emit('player');
    }
    this.refill();
  }

  _persist() {
    db.setKV('player', {
      order: this.order,
      repeat: this.repeat,
      volume: this.volume,
      current: this.current?.id || null,
      position: this.position,
    });
  }

  get position() {
    return this.engine ? this.engine.currentTime : this.resumeAt || 0;
  }

  get duration() {
    const engineDuration = this.engine?.duration;
    return engineDuration && Number.isFinite(engineDuration) ? engineDuration : this.current?.duration || 0;
  }

  get source() {
    if (!this.current) return null;
    return this.current.sources?.local ? 'local' : 'youtube';
  }

  // Faixas elegiveis para os modos automaticos.
  _pool() {
    const usable = (t) => (t.sources?.yt && !t.ytBlocked) || t.sources?.local;
    if (this.pool) {
      const list = this.pool.map((id) => store.get(id)).filter((t) => t && usable(t));
      if (list.length) return list;
    }
    return store.tracks.filter(usable);
  }

  // Replaneja a partir de agora. Chamado apos pulos, curtidas e mudancas.
  refill() {
    if (this.order !== 'metis') {
      this.planned = [];
      bus.emit('queue');
      return;
    }
    const pool = this._pool();
    this.planned = pool.length
      ? store.metis.plan(pool, contextService.now(), PLAN_SIZE, {
        current: this.current,
        exclude: this.queue,
      })
      : [];
    bus.emit('queue');
  }

  // Lista "A seguir" para as interfaces.
  upcoming(limit = 30) {
    const out = this.queue.map((id, index) => ({ track: store.get(id), kind: 'queue', index }));
    if (this.order === 'metis') {
      for (const entry of this.planned) out.push({ track: store.get(entry.id), kind: 'metis', entry });
    } else if (this.order === 'shuffle') {
      if (!this.bag.length) this.bag = shuffled(this._pool().map((t) => t.id)).filter((id) => id !== this.current?.id);
      for (const id of this.bag) out.push({ track: store.get(id), kind: 'shuffle' });
    } else {
      const list = this._sequence();
      const start = list.indexOf(this.current?.id);
      for (const id of list.slice(start + 1)) out.push({ track: store.get(id), kind: 'sequence' });
    }
    return out.filter((row) => row.track).slice(0, limit);
  }

  _sequence() {
    return this.pool || store.tracks.map((t) => t.id);
  }

  async play(id, { intent = 'manual', list = null, label = null, startAt = 0, entry = null } = {}) {
    const track = store.get(id);
    if (!track) return;
    if (list) {
      this.pool = list;
      this.poolLabel = label || 'Lista';
      this.bag = [];
    }
    if (this.current && this.engine) this._finish({ skipped: true });
    await this._start(track, { intent, startAt, entry });
    if (intent === 'manual') this.refill();
  }

  // Tocar uma lista inteira a partir do comeco.
  playList(ids, label, { order = null } = {}) {
    if (!ids.length) return;
    if (order) this.setOrder(order);
    if (this.order === 'sequence') {
      this.play(ids[0], { intent: 'manual', list: ids, label });
      return;
    }
    this.pool = ids;
    this.poolLabel = label;
    this.bag = [];
    this.refill();
    this.next({ intent: 'manual' });
  }

  async _start(track, { intent, startAt = 0, entry = null }) {
    this.previous = this.current && this.current.id !== track.id ? this.current : this.previous;
    if (this.current && this.current.id !== track.id) {
      this.history.push(this.current.id);
      if (this.history.length > 200) this.history.shift();
    }
    this.current = track;
    this.currentEntry = entry;
    this.intent = intent;
    this.listened = 0;
    this.lastTime = startAt;
    this.startContext = contextService.now();
    this.resumeAt = 0;
    store.metis.noteStart(track.id);

    const useLocal = !!track.sources?.local;
    const target = useLocal ? this.audio : this.youtube;
    if (this.engine && this.engine !== target) this.engine.stop();
    this.engine = target;
    document.getElementById('yt-host').className = useLocal ? 'yt-hidden' : '';
    this.applyVolume();
    bus.emit('player', { trackChanged: true });
    this._updateMediaSession();

    try {
      if (useLocal) {
        const row = await db.get('audio', track.id);
        if (!row?.blob) throw new Error('missing-audio');
        await this.audio.load(row.blob, startAt);
      } else {
        await this.youtube.load(track.sources.yt, startAt);
      }
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        // O navegador exige um toque antes de tocar.
        this.playing = false;
        bus.emit('player');
        bus.emit('toast', 'Toque em reproduzir para continuar.');
      } else {
        bus.emit('engine:error', error?.message || 'load');
      }
    }
  }

  _onTime() {
    if (!this.engine) return;
    const now = this.engine.currentTime;
    const delta = now - this.lastTime;
    // Conta so tempo realmente ouvido: um salto na barra nao vale como audicao.
    if (delta > 0 && delta < 2) this.listened += delta;
    this.lastTime = now;
    bus.emit('time');
    if (++this.saveTick % 20 === 0) this._persist();
    if ('mediaSession' in navigator && this.saveTick % 8 === 0 && this.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: this.duration, position: Math.min(now, this.duration), playbackRate: 1,
        });
      } catch { /* alguns navegadores recusam valores transitorios */ }
    }
  }

  _onDuration(seconds) {
    if (!this.current || !Number.isFinite(seconds) || seconds <= 0) return;
    if (Math.abs((this.current.duration || 0) - seconds) > 2) {
      store.update(this.current.id, { duration: seconds });
    }
    bus.emit('time');
  }

  // Video bloqueado ou removido: troca por outra versao da mesma musica.
  async _recover(track) {
    const tried = [...(track.ytTried || []), track.sources.yt];
    if (tried.length > 3) return false;
    const other = await findPlayable(track, tried).catch(() => null);
    if (!other) {
      await store.update(track.id, { ytTried: tried });
      return false;
    }
    await store.update(track.id, {
      sources: { ...track.sources, yt: other.id },
      url: `https://www.youtube.com/watch?v=${other.id}`,
      ytTried: tried,
      ytBlocked: false,
    });
    await this._start(track, { intent: this.intent, entry: this.currentEntry });
    return true;
  }

  async _onError(code) {
    const track = this.current;
    if (!track) return;
    this.errorStreak += 1;
    if (String(code).startsWith('youtube:')) {
      const reason = String(code).split(':')[1];
      // 100: removido. 101 e 150: o dono bloqueou a reproducao fora do YouTube.
      if (reason === '101' || reason === '150' || reason === '100') {
        if (await this._recover(track)) return;
        store.update(track.id, { ytBlocked: true });
        bus.emit('toast', `"${track.title}" não pode ser tocada fora do YouTube.`);
      } else {
        bus.emit('toast', `Não foi possível tocar "${track.title}".`);
      }
    } else if (code === 'missing-audio') {
      bus.emit('toast', `Arquivo de "${track.title}" não encontrado neste aparelho.`);
    } else {
      bus.emit('toast', `Não foi possível tocar "${track.title}".`);
    }
    this.engine?.stop();
    this.engine = null;
    this.playing = false;
    if (this.errorStreak < 4) this.next({ userAction: false, failed: true });
    else {
      bus.emit('toast', 'Várias músicas falharam em sequência. Reprodução pausada.');
      bus.emit('player');
    }
  }

  // Registra o fim da audicao e treina o modelo.
  _finish({ skipped }) {
    const track = this.current;
    if (!track || !this.startContext) return;
    const duration = this.duration || track.duration || 0;
    const listened = this.listened;
    // Abriu e trocou em menos de 3 segundos: sem sinal para aprender.
    if (listened < 3 && skipped) {
      this.startContext = null;
      return;
    }
    const ratio = duration ? Math.min(listened / duration, 1) : 0.5;
    const ctx = this.startContext;
    this.startContext = null;
    contextService.touchSession(skipped && ratio < 0.3);

    const y = store.metis.observe({
      track,
      prev: this.previous,
      ctx,
      library: this._pool(),
      ratio,
      listened,
      skipped,
      intent: this.intent,
      target: this.currentEntry?.target || null,
    });
    store.saveMetis();

    store.update(track.id, {
      plays: track.plays + (ratio >= 0.5 || !skipped ? 1 : 0),
      skips: track.skips + (skipped && ratio < 0.5 ? 1 : 0),
      lastPlayed: Date.now(),
    });

    db.addEvent({
      ts: ctx.ts,
      trackId: track.id,
      intent: this.intent,
      deliberate: this.intent === 'manual' || this.intent === 'queue',
      ratio: Math.round(ratio * 1000) / 1000,
      listened: Math.round(listened),
      skipped,
      reward: y,
      hour: Math.round(ctx.hour * 100) / 100,
      dow: ctx.dow,
      weekend: ctx.weekend,
      holiday: ctx.holiday,
      season: ctx.season,
      weather: ctx.weather,
      temp: ctx.temp,
      humidity: ctx.humidity,
      wind: ctx.wind,
      daylight: ctx.daylight,
      place: ctx.placeId,
      city: ctx.city,
      mobile: ctx.mobile,
      volume: ctx.volume,
      sessionDepth: ctx.sessionDepth,
      prevId: this.previous?.id || null,
    });
    if (store.metis.metrics.events % 200 === 0) db.trimEvents();
    bus.emit('metis');
  }

  _onEnded() {
    this._finish({ skipped: false });
    if (this.repeat === 'one' && this.current) {
      this._start(this.current, { intent: this.order });
      return;
    }
    this.next({ userAction: false });
  }

  _takeNext() {
    if (this.queue.length) return { id: this.queue.shift(), intent: 'queue' };
    if (this.order === 'metis') {
      if (!this.planned.length) this.refill();
      const entry = this.planned.shift();
      return entry ? { id: entry.id, intent: 'metis', entry } : null;
    }
    if (this.order === 'shuffle') {
      if (!this.bag.length) {
        const ids = this._pool().map((t) => t.id);
        if (this.bagUsed && this.repeat === 'off') {
          this.bagUsed = false;
          return null;
        }
        this.bag = shuffled(ids).filter((id) => id !== this.current?.id || ids.length === 1);
        this.bagUsed = false;
      }
      const id = this.bag.shift();
      if (!this.bag.length) this.bagUsed = true;
      return id ? { id, intent: 'shuffle' } : null;
    }
    const list = this._sequence();
    const index = list.indexOf(this.current?.id);
    if (index + 1 < list.length) return { id: list[index + 1], intent: 'sequence' };
    if (this.repeat === 'all' && list.length) return { id: list[0], intent: 'sequence' };
    return null;
  }

  async next({ userAction = true, intent = null, failed = false } = {}) {
    if (userAction && this.current && this.engine) this._finish({ skipped: true });
    const step = this._takeNext();
    if (!step) {
      this.engine?.pause();
      this.playing = false;
      bus.emit('player');
      return;
    }
    const track = store.get(step.id);
    if (!track) return this.next({ userAction: false });
    await this._start(track, { intent: intent || step.intent, entry: step.entry || null });
    // Um pulo muda a estimativa de humor, entao os proximos sao recalculados.
    if (this.order === 'metis') {
      if (userAction || failed || this.planned.length < PLAN_SIZE / 2) this.refill();
      else bus.emit('queue');
    } else {
      bus.emit('queue');
    }
  }

  async prev() {
    if (this.position > 4 || !this.history.length) {
      this.seek(0);
      return;
    }
    const id = this.history.pop();
    const track = store.get(id);
    if (!track) return this.prev();
    if (this.current && this.engine) this._finish({ skipped: true });
    const stepBack = this.current;
    await this._start(track, { intent: 'manual' });
    this.history.pop();
    if (stepBack && this.order !== 'metis') this.queue.unshift(stepBack.id);
    this.refill();
  }

  toggle() {
    if (!this.current) {
      this.next({ userAction: false });
      return;
    }
    if (!this.engine) {
      this._start(this.current, { intent: this.intent, startAt: this.resumeAt || 0 });
      return;
    }
    if (this.playing) this.engine.pause();
    else this.engine.play();
  }

  seek(seconds) {
    if (!this.engine) return;
    this.engine.seek(seconds);
    this.lastTime = seconds;
    bus.emit('time');
  }

  applyVolume() {
    const value = this.muted ? 0 : this.volume;
    this.audio.setVolume(value);
    this.youtube.setVolume(value);
    contextService.volume = this.volume;
  }

  setVolume(value) {
    this.volume = Math.min(Math.max(value, 0), 1);
    this.muted = false;
    this.applyVolume();
    this._persist();
    bus.emit('volume');
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
    bus.emit('volume');
  }

  setOrder(order) {
    this.order = order;
    this.bag = [];
    this.bagUsed = false;
    this._persist();
    this.refill();
    bus.emit('player');
  }

  // Botao classico de aleatorio: alterna com o modo sequencial.
  toggleShuffle() {
    this.setOrder(this.order === 'shuffle' ? 'sequence' : 'shuffle');
  }

  toggleMetis() {
    this.setOrder(this.order === 'metis' ? 'sequence' : 'metis');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this._persist();
    bus.emit('player');
  }

  addToQueue(ids) {
    this.queue.push(...[].concat(ids));
    this.refill();
    bus.emit('toast', [].concat(ids).length > 1 ? 'Adicionadas à lista.' : 'Adicionada à lista.');
  }

  playNext(ids) {
    this.queue.unshift(...[].concat(ids));
    this.refill();
    bus.emit('toast', 'Tocará a seguir.');
  }

  removeFromQueue(index) {
    this.queue.splice(index, 1);
    this.refill();
  }

  clearQueue() {
    this.queue = [];
    this.refill();
  }

  // Escolhe um item da lista A seguir: pula tudo o que estava antes dele.
  jumpTo(row) {
    if (row.kind === 'queue') {
      const [id] = this.queue.splice(row.index, 1);
      this.play(id, { intent: 'queue' });
      return;
    }
    if (row.kind === 'metis') {
      this.planned = this.planned.filter((e) => e !== row.entry);
      this.play(row.track.id, { intent: 'metis', entry: row.entry });
      this.refill();
      return;
    }
    this.play(row.track.id, { intent: this.order });
  }

  _onLibraryChange() {
    if (this.current && !store.get(this.current.id)) {
      this.engine?.stop();
      this.engine = null;
      this.current = null;
      this.playing = false;
      bus.emit('player', { trackChanged: true });
    }
    this.queue = this.queue.filter((id) => store.get(id));
    if (this.pool) this.pool = this.pool.filter((id) => store.get(id));
    const missing = this.planned.some((e) => !store.get(e.id));
    if (this.order === 'metis' && (missing || this.planned.length < 3)) this.refill();
  }

  explain() {
    return this.currentEntry?.reasons || [];
  }

  _updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const t = this.current;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album || 'Synapse',
      artwork: t.cover ? [{ src: t.cover, sizes: '96x96', type: 'image/jpeg' }] : [],
    });
  }

  _bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* acao nao suportada */ }
    };
    set('play', () => this.toggle());
    set('pause', () => this.toggle());
    set('nexttrack', () => this.next());
    set('previoustrack', () => this.prev());
    set('seekto', (e) => this.seek(e.seekTime));
  }
}

export const player = new Player();
