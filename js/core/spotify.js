import { CONFIG } from '../config.js';
import { sleep } from './bus.js';

const AUTH = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
const PENDING = 'synapse-spotify-pkce';

export const canLogin = () => !!CONFIG.spotifyClientId;

export const redirectUri = () => `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;

const base64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function authorizeUrl(challenge, state, clientId = CONFIG.spotifyClientId, redirect = redirectUri()) {
  return `${AUTH}/authorize?${new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirect,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES,
  })}`;
}

export async function startLogin() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  localStorage.setItem(PENDING, JSON.stringify({ verifier, state }));
  location.href = authorizeUrl(base64url(new Uint8Array(digest)), state);
}

export async function finishLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return null;
  const pending = JSON.parse(localStorage.getItem(PENDING) || 'null');
  localStorage.removeItem(PENDING);
  history.replaceState(null, '', location.pathname);
  if (error || !pending || pending.state !== params.get('state')) throw new Error('spotify-denied');
  const response = await fetch(`${AUTH}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CONFIG.spotifyClientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: pending.verifier,
    }),
  });
  if (!response.ok) throw new Error('spotify-token');
  return (await response.json()).access_token;
}

async function getJson(url, token) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 429) {
      await sleep((Number(response.headers.get('Retry-After')) || 2) * 1000);
      continue;
    }
    if (!response.ok) throw new Error(`spotify-${response.status}`);
    return response.json();
  }
  throw new Error('spotify-rate-limit');
}

async function* pages(url, token) {
  let next = url;
  while (next) {
    const page = await getJson(next, token);
    yield page.items || [];
    next = page.next;
  }
}

function fromApi(track) {
  if (!track?.id || track.is_local) return null;
  const images = track.album?.images || [];
  return {
    spotifyId: track.id,
    title: track.name,
    artist: track.artists?.map((a) => a.name).join(', ') || 'Artista desconhecido',
    album: track.album?.name || '',
    duration: (track.duration_ms || 0) / 1000,
    cover: images.at(-1)?.url || null,
  };
}

export async function fetchLibrary(token, onProgress = () => {}) {
  const tracks = [];
  for await (const items of pages(`${API}/me/tracks?limit=50`, token)) {
    tracks.push(...items.map((item) => fromApi(item.track)).filter(Boolean));
    onProgress(`Curtidas: ${tracks.length} músicas`);
  }
  const playlists = [];
  for await (const items of pages(`${API}/me/playlists?limit=50`, token)) {
    for (const list of items.filter(Boolean)) {
      const rows = [];
      for await (const part of pages(`${API}/playlists/${list.id}/tracks?limit=100`, token)) {
        rows.push(...part.map((item) => fromApi(item.track)).filter(Boolean));
      }
      playlists.push({ name: list.name, tracks: rows });
      onProgress(`Playlists: ${playlists.length}`);
    }
  }
  return { tracks, playlists };
}

const idFromUri = (uri) => String(uri || '').split(':').pop() || null;

export function parseExport(documents) {
  const tracks = [];
  const playlists = [];
  for (const doc of documents) {
    for (const item of doc?.tracks || []) {
      if (item.track && item.artist) {
        tracks.push({ spotifyId: idFromUri(item.uri), title: item.track, artist: item.artist, album: item.album || '' });
      }
    }
    for (const list of doc?.playlists || []) {
      const rows = (list.items || []).map((row) => row.track).filter((t) => t?.trackName).map((t) => ({
        spotifyId: idFromUri(t.trackUri),
        title: t.trackName,
        artist: t.artistName || 'Artista desconhecido',
        album: t.albumName || '',
      }));
      if (rows.length) playlists.push({ name: list.name, tracks: rows });
    }
  }
  return { tracks, playlists };
}
