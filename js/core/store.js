// Biblioteca, playlists e backup. Uma unica fonte de verdade para as duas interfaces.

import { db } from './db.js';
import { bus, uid } from './bus.js';
import { readTags } from './tags.js';
import { fetchPlaylist, fetchVideoInfo, parsePlaylistId, parseYouTubeId } from './youtube.js';
import { enrichQueue } from './enrich.js';
import { fold, normalizeGenre } from '../metis/genres.js';
import { hash32 } from '../metis/math.js';
import { Metis } from '../metis/engine.js';

const COVER_SIZE = 96;
const BACKUP_FORMAT = 'synapse-backup';

const matchKey = (track) => `${fold(track.artist)}|${fold(track.title)}`.replace(/[^\w|]+/g, '');

// Capa em baixa qualidade: 96 px em JPEG, guardada direto com a faixa.
async function shrinkCover(source) {
  try {
    const blob = source instanceof Blob ? source : await fetch(source).then((r) => {
      if (!r.ok) throw new Error('cover');
      return r.blob();
    });
    const bitmap = await createImageBitmap(blob);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = COVER_SIZE;
    canvas.height = COVER_SIZE;
    canvas.getContext('2d').drawImage(
      bitmap,
      (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
      0, 0, COVER_SIZE, COVER_SIZE,
    );
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.62);
  } catch {
    return null;
  }
}

class Store {
  constructor() {
    this.tracks = [];
    this.byId = new Map();
    this.previews = new Map(); // ouvidas na busca, fora da biblioteca
    this.playlists = [];
    this.metis = null;
    this.saveTimer = null;
  }

  async init() {
    const [tracks, playlists, saved] = await Promise.all([
      db.all('tracks'), db.all('playlists'), db.getKV('metis'),
    ]);
    this.tracks = tracks;
    this.byId = new Map(tracks.map((t) => [t.id, t]));
    this.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
    this.metis = new Metis(saved);
    enrichQueue.bind({
      getTrack: (id) => this.byId.get(id),
      saveTrack: (id, patch) => this.update(id, patch),
    });
    const pending = tracks.filter((t) => !t.enrichedAt).map((t) => t.id);
    if (pending.length) enrichQueue.add(pending);
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  }

  get(id) {
    return this.byId.get(id) || this.previews.get(id);
  }

  isSaved(id) {
    return this.byId.has(id);
  }

  // Faixa para ouvir sem salvar. Se a musica ja esta na biblioteca, usa ela.
  preview(result) {
    const saved = this.tracks.find((t) => t.sources?.yt === result.id) || this.findMatch(result);
    if (saved) return saved;
    const id = `yt_${result.id}`;
    if (!this.previews.has(id)) {
      this.previews.set(id, {
        id,
        title: result.title,
        artist: result.artist,
        album: '',
        genre: '',
        duration: result.duration || 0,
        liked: false,
        plays: 0,
        skips: 0,
        lastPlayed: 0,
        url: `https://www.youtube.com/watch?v=${result.id}`,
        cover: result.cover,
        sources: { yt: result.id, local: false },
        features: null,
        preview: result,
      });
    }
    return this.previews.get(id);
  }

  // Salva na biblioteca a musica que esta so sendo ouvida.
  savePreview(id) {
    const item = this.previews.get(id);
    if (!item) return null;
    return this.addYouTube({ ...item.preview, id: item.sources.yt, duration: item.duration });
  }

  saveMetis() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => db.setKV('metis', this.metis.toJSON()), 800);
  }

  _changed(reason) {
    bus.emit('library', reason);
  }

  async _insert(track) {
    this.tracks.push(track);
    this.byId.set(track.id, track);
    await db.put('tracks', track);
  }

  findMatch(candidate) {
    const key = matchKey(candidate);
    return this.tracks.find((t) => matchKey(t) === key) || null;
  }

  async update(id, patch) {
    const preview = this.previews.get(id);
    if (preview) return Object.assign(preview, patch);
    const track = this.byId.get(id);
    if (!track) return null;
    Object.assign(track, patch);
    if (patch.genre !== undefined) track.genreId = normalizeGenre(patch.genre);
    // Objeto novo a cada mudanca invalida o cache de features do Metis.
    if (patch.features) track.features = { ...patch.features };
    await db.put('tracks', track);
    this._changed('update');
    return track;
  }

  // Adiciona um resultado do YouTube. Se ja existir a mesma musica como arquivo
  // local, vincula as duas fontes em vez de duplicar.
  async addYouTube(result, options) {
    const outcome = await this._addYouTube(result, options);
    const previewId = `yt_${result.id}`;
    if (this.previews.delete(previewId)) bus.emit('preview-saved', { id: previewId, track: outcome.track });
    return outcome;
  }

  async _addYouTube(result, { silent = false } = {}) {
    const id = `yt_${result.id}`;
    if (this.byId.has(id)) return { track: this.byId.get(id), added: false };
    const existing = this.tracks.find((t) => t.sources?.yt === result.id);
    if (existing) return { track: existing, added: false };
    const twin = this.findMatch(result);
    if (twin?.sources?.yt) return { track: twin, added: false };
    const url = `https://www.youtube.com/watch?v=${result.id}`;
    const cover = await shrinkCover(result.cover);
    if (twin) {
      await this.update(twin.id, {
        sources: { ...twin.sources, yt: result.id }, url, cover: twin.cover || cover,
      });
      return { track: twin, added: false, linked: true };
    }
    const track = {
      id,
      title: result.title,
      artist: result.artist,
      rawTitle: result.rawTitle || result.title,
      album: '',
      genre: '',
      genreId: null,
      year: null,
      duration: result.duration || 0,
      size: 0,
      addedAt: Date.now(),
      liked: false,
      plays: 0,
      skips: 0,
      lastPlayed: 0,
      url,
      cover,
      sources: { yt: result.id, local: false },
      features: null,
      enrichedAt: 0,
    };
    await this._insert(track);
    enrichQueue.add([id]);
    if (!silent) this._changed('add');
    return { track, added: true };
  }

  // Aceita URLs de video e de playlist, uma por linha ou misturadas no texto.
  async addFromText(text, onProgress = () => {}) {
    const tokens = text.split(/[\s,]+/).filter(Boolean);
    const report = { added: 0, linked: 0, repeated: 0, failed: [] };
    const results = [];
    for (const token of tokens) {
      const listId = parsePlaylistId(token);
      const videoId = parseYouTubeId(token);
      try {
        if (listId && !listId.startsWith('RD')) {
          const items = await fetchPlaylist(listId);
          if (items.length) results.push(...items);
          else if (videoId) results.push(await fetchVideoInfo(videoId));
          else report.failed.push(token);
        } else if (videoId) {
          results.push(await fetchVideoInfo(videoId));
        } else {
          report.failed.push(token);
        }
      } catch {
        report.failed.push(token);
      }
    }
    const added = [];
    for (let i = 0; i < results.length; i++) {
      const outcome = await this.addYouTube(results[i], { silent: true });
      if (outcome.added) report.added++;
      else if (outcome.linked) report.linked++;
      else report.repeated++;
      added.push(outcome.track.id);
      onProgress(i + 1, results.length);
    }
    if (results.length) this._changed('add');
    report.ids = added;
    return report;
  }

  async addFiles(files, onProgress = () => {}) {
    const report = { added: 0, linked: 0, repeated: 0, failed: [], ids: [] };
    const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|flac|ogg|opus|wav)$/i.test(f.name));
    for (let i = 0; i < audio.length; i++) {
      const file = audio[i];
      try {
        const id = `lc_${hash32(`${file.name}|${file.size}`).toString(36)}`;
        if (this.byId.has(id)) {
          report.repeated++;
          report.ids.push(id);
          continue;
        }
        const tags = await readTags(file);
        const duration = await this._probeDuration(file);
        const cover = tags.picture ? await shrinkCover(tags.picture) : null;
        const twin = this.findMatch(tags);
        if (twin && !twin.sources?.local) {
          await db.put('audio', { id: twin.id, blob: file, name: file.name });
          await this.update(twin.id, {
            sources: { ...twin.sources, local: true }, size: file.size, cover: twin.cover || cover, enrichedAt: 0,
          });
          enrichQueue.add([twin.id]);
          report.linked++;
          report.ids.push(twin.id);
        } else {
          await db.put('audio', { id, blob: file, name: file.name });
          const track = {
            id,
            title: tags.title,
            artist: tags.artist,
            album: tags.album,
            genre: tags.genre,
            genreId: normalizeGenre(tags.genre),
            year: tags.year,
            duration,
            size: file.size,
            addedAt: Date.now(),
            liked: false,
            plays: 0,
            skips: 0,
            lastPlayed: 0,
            url: null,
            cover,
            sources: { yt: null, local: true },
            features: null,
            enrichedAt: 0,
          };
          await this._insert(track);
          report.added++;
          report.ids.push(id);
          enrichQueue.add([id]);
        }
      } catch {
        report.failed.push(file.name);
      }
      onProgress(i + 1, audio.length);
    }
    this._changed('add');
    return report;
  }

  // Associa um arquivo local a uma faixa ja existente do YouTube.
  async linkFile(trackId, file) {
    const track = this.get(trackId);
    if (!track) return;
    await db.put('audio', { id: trackId, blob: file, name: file.name });
    await this.update(trackId, { sources: { ...track.sources, local: true }, size: file.size, enrichedAt: 0 });
    enrichQueue.add([trackId]);
  }

  // Associa uma URL do YouTube a uma faixa local.
  async linkYouTube(trackId, urlText) {
    const videoId = parseYouTubeId(urlText);
    const track = this.get(trackId);
    if (!videoId || !track) return false;
    await this.update(trackId, {
      sources: { ...track.sources, yt: videoId },
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
    return true;
  }

  _probeDuration(file) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      const finish = (value) => {
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(value) ? value : 0);
      };
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => finish(audio.duration);
      audio.onerror = () => finish(0);
      setTimeout(() => finish(audio.duration || 0), 4000);
      audio.src = url;
    });
  }

  async remove(ids) {
    const set = new Set(ids);
    this.tracks = this.tracks.filter((t) => !set.has(t.id));
    for (const id of ids) {
      this.byId.delete(id);
      this.metis.forget(id);
      await db.remove('tracks', id);
      await db.remove('audio', id);
    }
    for (const playlist of this.playlists) {
      const kept = playlist.trackIds.filter((id) => !set.has(id));
      if (kept.length !== playlist.trackIds.length) {
        playlist.trackIds = kept;
        await db.put('playlists', playlist);
      }
    }
    this.saveMetis();
    this._changed('remove');
    bus.emit('playlists');
  }

  async toggleLike(id, context) {
    const track = this.get(id);
    if (!track) return;
    const liked = !track.liked;
    await this.update(id, { liked });
    this.metis.feedback({ track, ctx: context, liked, library: this.tracks });
    this.saveMetis();
  }

  async createPlaylist(name, trackIds = []) {
    const playlist = { id: uid('pl'), name: name.trim() || 'Nova playlist', trackIds, createdAt: Date.now() };
    this.playlists.push(playlist);
    await db.put('playlists', playlist);
    bus.emit('playlists');
    return playlist;
  }

  async renamePlaylist(id, name) {
    const playlist = this.playlists.find((p) => p.id === id);
    if (!playlist) return;
    playlist.name = name.trim() || playlist.name;
    await db.put('playlists', playlist);
    bus.emit('playlists');
  }

  async deletePlaylist(id) {
    this.playlists = this.playlists.filter((p) => p.id !== id);
    await db.remove('playlists', id);
    bus.emit('playlists');
  }

  async addToPlaylist(id, trackIds) {
    const playlist = this.playlists.find((p) => p.id === id);
    if (!playlist) return;
    const present = new Set(playlist.trackIds);
    playlist.trackIds.push(...trackIds.filter((t) => !present.has(t)));
    await db.put('playlists', playlist);
    bus.emit('playlists');
  }

  async removeFromPlaylist(id, trackId) {
    const playlist = this.playlists.find((p) => p.id === id);
    if (!playlist) return;
    playlist.trackIds = playlist.trackIds.filter((t) => t !== trackId);
    await db.put('playlists', playlist);
    bus.emit('playlists');
  }

  search(query, list = this.tracks) {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return list;
    return list.filter((t) => {
      const text = fold(`${t.title} ${t.artist} ${t.album} ${t.genre}`);
      return terms.every((term) => text.includes(term));
    });
  }

  async buildBackup(scope = 'all') {
    await db.setKV('metis', this.metis.toJSON());
    const base = {
      format: BACKUP_FORMAT,
      scope,
      version: 1,
      exportedAt: new Date().toISOString(),
      metis: this.metis.toJSON(),
    };
    if (scope === 'ml') return base;
    return {
      ...base,
      // O audio local fica de fora: backups precisam caber em qualquer lugar.
      tracks: this.tracks,
      playlists: this.playlists,
      events: await db.all('events'),
    };
  }

  async restoreBackup(data) {
    if (data?.format !== BACKUP_FORMAT) throw new Error('invalid-backup');
    const report = { tracks: 0, playlists: 0, model: false };
    if (data.metis) {
      this.metis = new Metis(data.metis);
      await db.setKV('metis', this.metis.toJSON());
      report.model = true;
    }
    if (data.scope !== 'ml') {
      const fresh = (data.tracks || []).filter((t) => t?.id && !this.byId.has(t.id));
      for (const track of fresh) {
        // Arquivos locais nao vem no backup: a faixa precisa ser religada.
        await this._insert(track.sources?.local
          ? { ...track, sources: { ...track.sources, local: false, missing: !track.sources.yt } }
          : track);
      }
      report.tracks = fresh.length;
      const known = new Set(this.playlists.map((p) => p.id));
      for (const playlist of data.playlists || []) {
        if (!playlist?.id || known.has(playlist.id)) continue;
        this.playlists.push(playlist);
        await db.put('playlists', playlist);
        report.playlists++;
      }
      if (Array.isArray(data.events) && data.events.length) {
        await db.bulkPut('events', data.events.map(({ seq, ...event }) => event));
      }
    }
    this._changed('import');
    bus.emit('playlists');
    bus.emit('metis');
    return report;
  }

  async resetModel() {
    this.metis = new Metis(null);
    await db.setKV('metis', this.metis.toJSON());
    bus.emit('metis');
  }

  async wipeAll() {
    await db.wipe();
    this.tracks = [];
    this.byId = new Map();
    this.playlists = [];
    this.metis = new Metis(null);
    this._changed('wipe');
    bus.emit('playlists');
    bus.emit('metis');
  }
}

export const store = new Store();
