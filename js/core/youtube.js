import { CONFIG } from '../config.js';
import { db } from './db.js';

const API = 'https://www.googleapis.com/youtube/v3';
const RECENT_LIMIT = 12;

export const getRecentSearches = () => db.getKV('recentSearches', []);

export async function saveRecentSearch(query, results) {
  const key = query.trim().toLowerCase();
  const others = (await getRecentSearches()).filter((r) => r.query.trim().toLowerCase() !== key);
  const list = [{ query: query.trim(), results }, ...others].slice(0, RECENT_LIMIT);
  await db.setKV('recentSearches', list);
  return list;
}

export async function clearRecentSearches() {
  await db.setKV('recentSearches', []);
  return [];
}

export function parseYouTubeId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return url.pathname.slice(1, 12) || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = url.searchParams.get('v');
      if (v) return v.slice(0, 11);
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {  }
  return null;
}

export function parsePlaylistId(input) {
  try {
    const text = String(input || '').trim();
    return new URL(text.startsWith('http') ? text : `https://${text}`).searchParams.get('list');
  } catch {
    return null;
  }
}

export function cleanTitle(rawTitle, channel = '') {
  const noise = /[([{][^)\]}]*(official|oficial|lyric|letra|legendado|audio|áudio|video|vídeo|clipe|visualizer|hd|4k|mv|m\/v)[^)\]}]*[)\]}]/gi;
  const text = rawTitle.replace(noise, '').replace(/\s+/g, ' ').trim();
  const artistFromChannel = channel
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*(official|oficial)\s*$/i, '')
    .trim();
  const match = text.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (match) return { artist: match[1].trim(), title: match[2].trim() };
  return { artist: artistFromChannel || 'YouTube', title: text };
}

function isoDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function toResult({ id, title, channel, duration, cover }) {
  const clean = cleanTitle(title, channel);
  return { id, title: clean.title, artist: clean.artist, rawTitle: title, channel, duration: duration || 0, cover: cover || thumb(id) };
}

export async function getApiKey() {
  return (await db.getKV('ytKey', '')) || CONFIG.youtubeApiKey;
}

async function searchOfficial(query, key) {
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '25', q: query, key,
    regionCode: (navigator.language || 'pt-BR').split('-')[1] || 'BR',
  });
  const response = await fetch(`${API}/search?${params}`);
  if (!response.ok) {
    const error = new Error('youtube-api');
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const ids = data.items.map((item) => item.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = await fetch(`${API}/videos?part=contentDetails,status&id=${ids.join(',')}&key=${encodeURIComponent(key)}`)
    .then((r) => (r.ok ? r.json() : { items: [] }));
  const durations = new Map(details.items.map((v) => [v.id, isoDuration(v.contentDetails?.duration)]));
  const blocked = new Set(details.items.filter((v) => v.status?.embeddable === false).map((v) => v.id));
  return data.items.filter((item) => item.id.videoId && !blocked.has(item.id.videoId)).map((item) => toResult({
    id: item.id.videoId,
    title: decodeEntities(item.snippet.title),
    channel: item.snippet.channelTitle,
    duration: durations.get(item.id.videoId),
  }));
}

function decodeEntities(text) {
  const area = document.createElement('textarea');
  area.innerHTML = text;
  return area.value;
}

async function searchPiped(query) {
  let lastError = null;
  for (const base of CONFIG.pipedInstances) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}&filter=music_songs`, { signal: controller.signal })
        .catch(() => fetch(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`, { signal: controller.signal }));
      clearTimeout(timer);
      if (!response.ok) throw new Error(`piped ${response.status}`);
      const data = await response.json();
      let items = data.items || [];
      if (!items.length) {
        const fallback = await fetch(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`);
        items = fallback.ok ? (await fallback.json()).items || [] : [];
      }
      return items
        .filter((item) => item.url?.includes('watch') && item.duration > 0)
        .slice(0, 25)
        .map((item) => toResult({
          id: new URLSearchParams(item.url.split('?')[1]).get('v'),
          title: item.title,
          channel: item.uploaderName || '',
          duration: item.duration,
        }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('search-unavailable');
}

export async function findPlayable(track, excludeIds = []) {
  const results = await searchYouTube(`${track.artist} ${track.title}`);
  const options = results.filter((r) => !excludeIds.includes(r.id));
  if (!options.length) return null;
  const gap = (r) => (track.duration && r.duration ? Math.abs(r.duration - track.duration) : 1e4);
  return options.slice(0, 10).sort((a, b) => gap(a) - gap(b))[0];
}

export async function searchYouTube(query) {
  const key = await getApiKey();
  if (key) {
    try {
      return await searchOfficial(query, key);
    } catch (error) {

      if (error.status !== 403 && error.status !== 400) throw error;
    }
  }
  return searchPiped(query);
}

export async function fetchVideoInfo(id) {
  const key = await getApiKey();
  if (key) {
    try {
      const response = await fetch(`${API}/videos?part=snippet,contentDetails&id=${id}&key=${encodeURIComponent(key)}`);
      const item = response.ok ? (await response.json()).items?.[0] : null;
      if (item) {
        return toResult({
          id, title: item.snippet.title, channel: item.snippet.channelTitle,
          duration: isoDuration(item.contentDetails.duration),
        });
      }
    } catch {  }
  }
  const url = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
  const response = await fetch(`https://www.youtube.com/oembed?url=${url}&format=json`);
  if (!response.ok) throw new Error('video-unavailable');
  const data = await response.json();
  return toResult({ id, title: data.title, channel: data.author_name, duration: 0 });
}

export async function fetchPlaylist(listId) {
  const key = await getApiKey();
  if (key) {
    const out = [];
    let page = '';
    do {
      const params = new URLSearchParams({ part: 'snippet', maxResults: '50', playlistId: listId, key, pageToken: page });
      const response = await fetch(`${API}/playlistItems?${params}`);
      if (!response.ok) break;
      const data = await response.json();
      for (const item of data.items || []) {
        const id = item.snippet.resourceId?.videoId;
        if (id) out.push(toResult({ id, title: item.snippet.title, channel: item.snippet.videoOwnerChannelTitle || '' }));
      }
      page = data.nextPageToken || '';
    } while (page && out.length < 500);
    if (out.length) return out;
  }
  for (const base of CONFIG.pipedInstances) {
    try {
      const response = await fetch(`${base}/playlists/${encodeURIComponent(listId)}`);
      if (!response.ok) continue;
      const data = await response.json();
      return (data.relatedStreams || []).map((item) => toResult({
        id: new URLSearchParams(item.url.split('?')[1]).get('v'),
        title: item.title,
        channel: item.uploaderName || '',
        duration: item.duration,
      }));
    } catch {  }
  }
  return [];
}
