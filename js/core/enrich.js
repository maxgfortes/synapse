import { bus, sleep } from './bus.js';
import { db } from './db.js';
import { shrinkCover } from './cover.js';
import { fold, normalizeGenre } from '../metis/genres.js';

const SAMPLE_RATE = 22050;
let worker = null;
const pending = new Map();
let nextJob = 1;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
  }
  return worker;
}

function analyzeInWorker(pcm, sampleRate) {
  return new Promise((resolve, reject) => {
    const id = nextJob++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, pcm, sampleRate }, [pcm.buffer]);
  });
}

async function decodeToMono(arrayBuffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const decoder = new Offline(1, 1, 44100);
  const decoded = await decoder.decodeAudioData(arrayBuffer);

  const seconds = Math.min(decoded.duration, 180);
  const start = Math.max(0, (decoded.duration - seconds) / 2);
  const offline = new Offline(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, start, seconds);
  const rendered = await offline.startRendering();
  return { pcm: rendered.getChannelData(0).slice(), duration: decoded.duration };
}

export async function analyzeBuffer(arrayBuffer) {
  const { pcm, duration } = await decodeToMono(arrayBuffer);
  const features = await analyzeInWorker(pcm, SAMPLE_RATE);
  return { features, duration };
}

const score = (a, b) => {
  const wa = new Set(fold(a).split(/\W+/).filter(Boolean));
  const wb = new Set(fold(b).split(/\W+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let same = 0;
  for (const w of wa) if (wb.has(w)) same++;
  return same / Math.max(wa.size, wb.size);
};

export async function lookupCatalog(track) {
  const country = (navigator.language || 'pt-BR').split('-')[1] || 'BR';
  const term = `${track.artist === 'YouTube' ? '' : track.artist} ${track.title}`.trim();
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term, media: 'music', entity: 'song', limit: '6', country })}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`itunes ${response.status}`);
  const { results = [] } = await response.json();
  let best = null;
  let bestScore = 0.35;
  for (const r of results) {
    const s = score(track.title, r.trackName) * 0.65 + score(track.artist, r.artistName) * 0.35;
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

class EnrichQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.getTrack = () => null;
    this.saveTrack = async () => {};
    this.progress = { done: 0, total: 0 };
  }

  bind({ getTrack, saveTrack }) {
    this.getTrack = getTrack;
    this.saveTrack = saveTrack;
  }

  add(ids) {
    const fresh = ids.filter((id) => !this.queue.includes(id));
    this.queue.push(...fresh);
    this.progress.total += fresh.length;
    this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      if (!navigator.onLine) {
        await sleep(30000);
        continue;
      }
      const id = this.queue.shift();
      const track = this.getTrack(id);
      if (track) {
        const usedNetwork = await this.process(track).catch(() => true);
        this.progress.done += 1;
        bus.emit('enrich', { ...this.progress, left: this.queue.length });
        if (usedNetwork) await sleep(3200);
      }
    }
    this.progress = { done: 0, total: 0 };
    this.running = false;
    bus.emit('enrich', { done: 0, total: 0, left: 0 });
  }

  async process(track) {
    const patch = { enrichedAt: Date.now() };
    let usedNetwork = false;

    if (track.sources?.local && !track.features) {
      const row = await db.get('audio', track.id);
      if (row?.blob) {
        const { features } = await analyzeBuffer(await row.blob.arrayBuffer());
        if (features) patch.features = { ...features, source: 'local' };
      }
    }

    const remoteCover = /^https?:/.test(track.cover || '');
    if (remoteCover) {
      usedNetwork = true;
      patch.cover = await shrinkCover(track.cover);
    }
    const needsCatalog = !track.genre || !track.album || !track.cover || !(track.features || patch.features);
    if (needsCatalog) {
      usedNetwork = true;
      const match = await lookupCatalog(track);
      if (match) {
        if (!track.genre && match.primaryGenreName) {
          patch.genre = match.primaryGenreName;
          patch.genreId = normalizeGenre(match.primaryGenreName);
        }
        if (!track.duration && match.trackTimeMillis) patch.duration = match.trackTimeMillis / 1000;
        if (!track.cover && !patch.cover && match.artworkUrl100) patch.cover = await shrinkCover(match.artworkUrl100);
        if (!track.album && match.collectionName) patch.album = match.collectionName;
        if (!track.year && match.releaseDate) patch.year = new Date(match.releaseDate).getFullYear();
        if (match.artistName && (track.artist === 'YouTube' || track.needsArtist)) patch.artist = match.artistName;
        if (!track.features && !patch.features && match.previewUrl) {
          const audio = await fetch(match.previewUrl).then((r) => r.arrayBuffer());
          const { features } = await analyzeBuffer(audio);
          if (features) patch.features = { ...features, source: 'preview' };
        }
      }
    }
    await this.saveTrack(track.id, patch);
    return usedNetwork;
  }
}

export const enrichQueue = new EnrichQueue();
