// Interface de celular: areas do app Musica do iOS, em preto solido.
// Abas trocam na hora; so push, pop e paginas modais se movem.

import { CONFIG } from '../config.js';
import { bus, escapeHtml as esc, formatTime } from '../core/bus.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { contextService } from '../core/context.js';
import { clearRecentSearches, getRecentSearches, saveRecentSearch, searchYouTube } from '../core/youtube.js';
import { fold } from '../metis/genres.js';
import { icons } from './icons.js';
import {
  bindMetisPanel, confirmBox, cover, enrichStatus, genreLabel, html, isIOS, links, metisPanel, newPlaylist, openAdd,
  openPrefs, promptBox, showLargeCover, showMenu, toast, trackMenuItems,
} from './shared.js';

const TABS = [
  { id: 'metis', label: 'Metís', icon: icons.metis },
  { id: 'playlists', label: 'Playlists', icon: icons.playlist },
  { id: 'songs', label: 'Músicas', icon: icons.note },
  { id: 'explore', label: 'Explorar', icon: icons.search },
  { id: 'more', label: 'Mais', icon: icons.more },
];

const TITLES = { metis: 'Metís', playlists: 'Playlists', songs: 'Músicas', explore: 'Explorar', more: 'Mais' };
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const EQ = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
const LOADING = '<div class="m-loading"><img src="assets/icons/loading.gif" alt="Carregando"></div>';
const info = (text) => `<p class="m-info">${esc(text)}</p>`;

const state = {
  tab: 'songs',
  stacks: { metis: [{ view: 'metis' }], playlists: [{ view: 'playlists' }], songs: [{ view: 'songs' }], explore: [{ view: 'explore' }], more: [{ view: 'more' }] },
  filter: '',
  explore: { query: '', results: [], loading: false, error: '', recents: [], ticket: 0 },
  nowOpen: false,
  nowTrack: null,
  seeking: false,
};

// O iOS ignora mudancas de volume via JavaScript.
const canSetVolume = !isIOS();

let root;
let cleanups = [];
const $ = (selector) => root.querySelector(selector);
const top = () => state.stacks[state.tab].at(-1);

function push(route) {
  state.stacks[state.tab].push(route);
  render('push');
  $('.m-content').scrollTop = 0;
}

function pop() {
  if (state.stacks[state.tab].length > 1) {
    state.stacks[state.tab].pop();
    render('pop');
  }
}

function setTab(tab) {
  if (tab === state.tab && state.stacks[tab].length === 1) {
    $('.m-content').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (tab === state.tab) state.stacks[tab].length = 1;
  state.tab = tab;
  render('tab');
  $('.m-content').scrollTop = 0;
}

function titleOf(route) {
  switch (route.view) {
    case 'playlist': return store.playlists.find((p) => p.id === route.id)?.name || 'Playlist';
    case 'artists': return 'Artistas';
    case 'albums': return 'Álbuns';
    case 'genres': return 'Gêneros';
    case 'liked': return 'Curtidas';
    case 'recent': return 'Recentes';
    case 'group': return route.name;
    default: return TITLES[route.view] || 'Synapse';
  }
}

function shell() {
  return `<div class="ios">
    <header class="m-nav"><div class="m-nav-bar">
      <div class="m-nav-left" id="nav-left"></div>
      <h1 id="nav-title"></h1>
      <div class="m-nav-right" id="nav-right"></div>
    </div></header>
    <main class="m-content" id="content"></main>
    <nav class="m-tabs" aria-label="Seções">${TABS.map((t) => `<button type="button" data-tab="${t.id}">${t.icon}<span>${t.label}</span></button>`).join('')}</nav>
    <section class="m-now" id="now" aria-label="Tocando agora" aria-hidden="true"></section>
  </div>`;
}

const songCell = (t) => {
  const on = player.current?.id === t.id;
  return `<div class="cell song ${on ? 'cur' : ''}" data-song="${t.id}">
    ${cover(t, 'cell-art')}
    <div class="cell-text"><strong>${esc(t.title)}</strong><span>${esc([t.artist, t.album].filter(Boolean).join(' - '))}</span></div>
    ${on ? EQ : ''}
    ${t.liked ? `<span class="cell-like">${icons.heartFill}</span>` : ''}
    <button type="button" class="cell-more" data-more="${t.id}" aria-label="Mais opções">${icons.more}</button>
  </div>`;
};

const navCell = (attrs, art, title, sub = '') => `<div class="cell nav" ${attrs}>${art}
  <div class="cell-text"><strong>${esc(title)}</strong>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
  <span class="cell-arrow">${icons.forward}</span></div>`;

const glyph = (icon) => `<span class="cell-glyph">${icon}</span>`;
const count = (n) => `${n} ${n === 1 ? 'música' : 'músicas'}`;
const actionCell = (name, icon, label, danger = false) => `<div class="cell action ${danger ? 'danger' : ''}" data-do="${name}">${icon}<strong>${label}</strong></div>`;

const searchBar = () => `<label class="m-search">${icons.search}<input type="search" id="m-filter" placeholder="Buscar" value="${esc(state.filter)}" aria-label="Buscar na biblioteca"></label>`;

function sectionKey(title) {
  const c = fold(title).charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

function songList(list, { sections = true } = {}) {
  if (!sections) return list.map(songCell).join('');
  const sorted = list.slice().sort((a, b) => collator.compare(a.title, b.title));
  let last = null;
  let out = '';
  const keys = [];
  for (const t of sorted) {
    const key = sectionKey(t.title);
    if (key !== last) {
      out += `<h2 class="section" id="sec-${key === '#' ? 'num' : key}">${key}</h2>`;
      keys.push(key);
      last = key;
    }
    out += songCell(t);
  }
  const index = keys.length > 3
    ? `<nav class="m-index" aria-label="Índice">${keys.map((k) => `<button type="button" data-sec="${k === '#' ? 'num' : k}">${k}</button>`).join('')}</nav>`
    : '';
  return out + index;
}

function emptyState() {
  return `<div class="m-empty">
    <p>Busque músicas, cole um link ou escolha arquivos do aparelho.</p>
    <button type="button" class="ios-btn" data-go="explore">Buscar músicas</button>
    <button type="button" class="ios-btn" data-do="add">Adicionar links ou arquivos</button>
  </div>`;
}

function groupsOf(fn) {
  const map = new Map();
  for (const t of store.tracks) {
    const key = fn(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return [...map.entries()].sort((a, b) => collator.compare(a[0], b[0]));
}

const GROUPS = {
  artists: (t) => t.artist,
  albums: (t) => t.album || 'Álbum desconhecido',
  genres: (t) => genreLabel(t) || 'Sem gênero',
};

function view(route) {
  switch (route.view) {
    case 'songs': {
      if (!store.tracks.length) return emptyState();
      const list = store.search(state.filter);
      const busy = enrichStatus();
      return `${searchBar()}
        ${actionCell('metis-all', icons.metis, 'Tocar com Metís')}
        ${actionCell('shuffle-all', icons.shuffle, 'Aleatório')}
        ${songList(list)}
        <p class="m-count">${count(list.length)}${busy ? `. ${busy}` : ''}</p>`;
    }
    case 'metis':
      return `<div class="m-metis">${metisPanel()}</div>`;
    case 'playlists':
      return `${actionCell('new-playlist', icons.plus, 'Nova playlist...')}
        ${navCell('data-push="liked"', glyph(icons.heart), 'Curtidas')}
        ${store.playlists.map((p) => navCell(`data-playlist="${p.id}"`, cover(store.get(p.trackIds[0]), 'cell-art'), p.name, count(p.trackIds.length))).join('')}`;
    case 'playlist': {
      const playlist = store.playlists.find((p) => p.id === route.id);
      if (!playlist) return '';
      const list = playlist.trackIds.map((id) => store.get(id)).filter(Boolean);
      return `${actionCell('list-metis', icons.metis, 'Tocar com Metís')}
        ${actionCell('list-shuffle', icons.shuffle, 'Aleatório')}
        ${songList(list, { sections: false })}
        ${actionCell('rename-playlist', '', 'Renomear playlist')}
        ${actionCell('delete-playlist', '', 'Apagar playlist', true)}`;
    }
    case 'liked':
      return songList(store.tracks.filter((t) => t.liked), { sections: false }) || info('Curta músicas para vê-las aqui.');
    case 'recent':
      return songList(store.tracks.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 60), { sections: false });
    case 'artists':
    case 'albums':
    case 'genres':
      return groupsOf(GROUPS[route.view]).map(([name, list]) => navCell(`data-group="${route.view}" data-name="${esc(name)}"`, cover(list.find((t) => t.cover) || list[0], 'cell-art'), name, count(list.length))).join('') || info('Nada por aqui ainda.');
    case 'group': {
      const list = store.tracks.filter((t) => GROUPS[route.group](t) === route.name);
      return `${actionCell('list-metis', icons.metis, 'Tocar com Metís')}${songList(list, { sections: false })}`;
    }
    case 'explore': {
      const e = state.explore;
      const showRecents = !e.query && !e.loading && !e.error && e.recents.length;
      return `<form class="m-search-form" id="m-ex"><label class="m-search">${icons.search}<input type="search" id="m-q" name="q" value="${esc(e.query)}" placeholder="Música, artista ou link" aria-label="Buscar músicas" autocomplete="off"></label></form>
        ${e.loading ? LOADING : ''}
        ${e.error ? info(e.error) : ''}
        ${showRecents ? `<div class="recent-head"><h2>Recentes</h2><button type="button" data-do="clear-recents">Limpar</button></div>
          ${e.recents.map((r, i) => `<div class="cell recent" data-recent="${i}">${icons.search}<div class="cell-text"><strong>${esc(r.query)}</strong><span>${count(r.results.length)}</span></div></div>`).join('')}` : ''}
        ${e.results.map((r) => {
    const saved = store.tracks.some((t) => t.sources?.yt === r.id);
    return `<div class="cell song" data-yt="${esc(r.id)}">
          <img class="cover cell-art" src="${esc(r.cover)}" alt="" loading="lazy">
          <div class="cell-text"><strong>${esc(r.title)}</strong><span>${esc(r.artist)}${r.duration ? ` - ${formatTime(r.duration)}` : ''}</span></div>
          <button type="button" class="cell-add ${saved ? 'done' : ''}" data-ytadd aria-label="${saved ? 'Na biblioteca' : 'Adicionar'}" ${saved ? 'disabled' : ''}>${saved ? icons.check : icons.plus}</button>
        </div>`;
  }).join('')}
        ${!e.results.length && !e.loading && !e.error && !showRecents ? info('Busque músicas e salve na sua biblioteca.') : ''}`;
    }
    case 'more': {
      const external = (href, icon, label, blank = true) => `<a class="cell nav" href="${href}" ${blank ? 'target="_blank" rel="noopener"' : ''}>${glyph(icon)}<div class="cell-text"><strong>${label}</strong></div><span class="cell-arrow">${icons.forward}</span></a>`;
      return `${navCell('data-push="artists"', glyph(icons.mic), 'Artistas')}
        ${navCell('data-push="albums"', glyph(icons.album), 'Álbuns')}
        ${navCell('data-push="genres"', glyph(icons.guitar), 'Gêneros')}
        ${navCell('data-push="recent"', glyph(icons.clock), 'Adições recentes')}
        <h2 class="section plain">Biblioteca</h2>
        ${navCell('data-do="add"', glyph(icons.plus), 'Adicionar músicas')}
        ${navCell('data-do="prefs"', glyph(icons.gear), 'Preferências, dados e ML')}
        <h2 class="section plain">Synapse</h2>
        ${external(links.about, icons.globe, 'Sobre', false)}
        ${external(links.terms, icons.check, 'Termos e privacidade', false)}
        ${external(links.contact, icons.person, 'Contato', false)}
        ${external(links.repo, icons.metis, 'Projeto no GitHub')}
        ${external(links.github, icons.person, 'GitHub do autor')}
        <p class="m-count">Versão ${CONFIG.version}</p>`;
    }
    default: return '';
  }
}

function renderNav(moving = false) {
  const stack = state.stacks[state.tab];
  const route = stack.at(-1);
  const previous = stack.at(-2);
  const title = $('#nav-title');
  title.textContent = titleOf(route);
  title.classList.remove('changing');
  if (moving) {
    void title.offsetWidth;
    title.classList.add('changing');
  }
  $('#nav-left').innerHTML = previous
    ? `<button type="button" class="nav-btn" data-do="back">${icons.back}<span>${esc(titleOf(previous))}</span></button>`
    : (route.view === 'songs' && store.tracks.length ? `<button type="button" class="nav-btn plain" data-do="add" aria-label="Adicionar músicas">${icons.plus}</button>` : '');
  $('#nav-right').innerHTML = player.current
    ? `<button type="button" class="nav-btn now-btn" data-do="open-now"><span>Tocando</span>${icons.forward}</button>`
    : '';
}

function renderTabs() {
  root.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
}

// Com movimento, a tela anterior fica por baixo ate a animacao terminar.
function render(movement = '') {
  renderNav(!!movement);
  renderTabs();
  const content = $('#content');
  const focused = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;
  content.querySelectorAll('.m-view.out').forEach((old) => old.remove());
  const previous = movement && movement !== 'tab' ? content.querySelector('.m-view') : null;
  const next = html(`<div class="m-view ${movement ? `in-${movement}` : ''}">${view(top())}</div>`);
  if (previous) {
    const offset = parseFloat(getComputedStyle(content).paddingTop) - content.scrollTop;
    previous.style.top = `${offset}px`;
    previous.classList.add('out', `out-${movement}`);
    previous.addEventListener('animationend', () => previous.remove(), { once: true });
    content.append(next);
  } else {
    content.replaceChildren(next);
  }
  if (focused === 'm-filter' || focused === 'm-q') {
    const input = $(`#${focused}`);
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
}

function renderNow() {
  const t = player.current;
  const panel = $('#now');
  if (!t) {
    closeNow();
    panel.innerHTML = '';
    state.nowTrack = null;
    return;
  }
  const swapped = state.nowTrack && state.nowTrack !== t.id;
  state.nowTrack = t.id;
  panel.innerHTML = `<header class="now-top">
      <button type="button" class="now-icon" data-do="close-now" aria-label="Fechar">${icons.down}</button>
      <span class="now-pool" id="now-pool"></span>
      <button type="button" class="now-icon" data-do="up-next" aria-label="A seguir">${icons.list}</button>
    </header>
    <div class="now-art ${swapped ? 'swap' : ''}">${cover(t, 'now-cover')}</div>
    <div class="now-scrub">
      <input type="range" id="now-seek" min="0" max="1000" value="0" aria-label="Posição">
      <div class="now-times"><span id="now-pos">0:00</span><span id="now-left">-0:00</span></div>
    </div>
    <div class="now-meta ${swapped ? 'swap' : ''}">
      <button type="button" class="now-side" id="now-like" data-do="like"></button>
      <div class="now-text"><strong id="now-title"></strong><span id="now-artist"></span></div>
      <button type="button" class="now-side" data-more="${t.id}" aria-label="Mais opções">${icons.more}</button>
    </div>
    <div class="now-controls">
      <button type="button" data-do="prev" aria-label="Anterior">${icons.prev}</button>
      <button type="button" class="now-play" id="now-play" data-do="toggle"></button>
      <button type="button" data-do="next" aria-label="Próxima">${icons.next}</button>
    </div>
    ${canSetVolume ? `<div class="now-volume">${icons.speakerLow}<input type="range" id="now-vol" min="0" max="100" value="${Math.round(player.volume * 100)}" aria-label="Volume">${icons.speaker}</div>` : ''}
    <div class="now-modes">
      <button type="button" id="mode-repeat" data-do="repeat"></button>
      <button type="button" id="mode-metis" data-do="metis">Metís</button>
      <button type="button" id="mode-shuffle" data-do="shuffle">Aleatório</button>
    </div>`;
  syncNow();
  renderTime();
  showLargeCover(t, panel.querySelector('.now-cover'));
  panel.querySelector('#now-seek').addEventListener('input', (e) => {
    state.seeking = true;
    const seconds = (e.target.value / 1000) * player.duration;
    panel.querySelector('#now-pos').textContent = formatTime(seconds);
    paintSeek(e.target);
  });
  panel.querySelector('#now-seek').addEventListener('change', (e) => {
    state.seeking = false;
    player.seek((e.target.value / 1000) * player.duration);
  });
  panel.querySelector('#now-vol')?.addEventListener('input', (e) => player.setVolume(e.target.value / 100));
}

// Atualiza sem recriar a tela, para a capa poder recuar ao pausar.
function syncNow() {
  const t = player.current;
  const panel = $('#now');
  $('.ios').classList.toggle('is-playing', player.playing);
  if (!t || !panel.firstElementChild) return;
  panel.classList.toggle('paused', !player.playing);
  panel.querySelector('#now-title').textContent = t.title;
  panel.querySelector('#now-artist').textContent = [t.artist, t.album].filter(Boolean).join(' - ');
  panel.querySelector('#now-pool').textContent = player.order === 'metis' ? 'Metís' : player.poolLabel;

  const play = panel.querySelector('#now-play');
  if (play.dataset.state !== String(player.playing)) {
    play.dataset.state = String(player.playing);
    play.innerHTML = player.playing ? icons.pause : icons.play;
    play.setAttribute('aria-label', player.playing ? 'Pausar' : 'Reproduzir');
  }

  const like = panel.querySelector('#now-like');
  // Musica fora da biblioteca: no lugar de curtir, o botao adiciona.
  const saved = store.isSaved(t.id);
  like.dataset.do = saved ? 'like' : 'save-current';
  like.classList.toggle('on', saved ? !!t.liked : true);
  like.innerHTML = saved ? (t.liked ? icons.heartFill : icons.heart) : icons.plus;
  like.setAttribute('aria-label', saved ? (t.liked ? 'Remover curtida' : 'Curtir') : 'Adicionar à biblioteca');

  const repeat = panel.querySelector('#mode-repeat');
  repeat.textContent = { off: 'Repetir', all: 'Repetir lista', one: 'Repetir música' }[player.repeat];
  repeat.classList.toggle('on', player.repeat !== 'off');
  panel.querySelector('#mode-metis').classList.toggle('on', player.order === 'metis');
  panel.querySelector('#mode-shuffle').classList.toggle('on', player.order === 'shuffle');
}

function paintSeek(input) {
  input.style.setProperty('--fill', `${input.value / 10}%`);
}

function renderTime() {
  const seek = $('#now-seek');
  if (!seek || state.seeking) return;
  const position = player.position;
  const duration = player.duration;
  seek.value = duration ? Math.round((position / duration) * 1000) : 0;
  paintSeek(seek);
  $('#now-pos').textContent = formatTime(position);
  $('#now-left').textContent = `-${formatTime(Math.max(duration - position, 0))}`;
}

function openNow() {
  state.nowOpen = true;
  const panel = $('#now');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeNow() {
  state.nowOpen = false;
  const panel = $('#now');
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
}

function openUpNext() {
  const rows = player.upcoming(30);
  const body = html(`<div class="m-upnext">${rows.map((r, i) => `<div class="cell song" data-index="${i}">
    ${cover(r.track, 'cell-art')}
    <div class="cell-text"><strong>${esc(r.track.title)}</strong><span>${esc(r.entry?.reasons?.[0] || r.track.artist)}</span></div>
  </div>`).join('') || info('Nada na fila.')}</div>`);
  const layer = html(`<div class="modal sheet"><div class="modal-card">
    <header class="modal-head"><h2>A seguir</h2></header><div class="modal-body"></div>
    <footer class="modal-foot"><button type="button" class="btn btn-primary">OK</button></footer>
  </div></div>`);
  const close = () => {
    layer.classList.add('leaving');
    setTimeout(() => layer.remove(), 340);
  };
  layer.querySelector('.modal-body').append(body);
  layer.querySelector('.modal-foot button').addEventListener('click', close);
  body.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-index]');
    if (!cell) return;
    player.jumpTo(rows[Number(cell.dataset.index)]);
    close();
  });
  document.body.append(layer);
}

function currentIds() {
  const route = top();
  if (route.view === 'playlist') return store.playlists.find((p) => p.id === route.id)?.trackIds || [];
  if (route.view === 'group') return store.tracks.filter((t) => GROUPS[route.group](t) === route.name).map((t) => t.id);
  if (route.view === 'liked') return store.tracks.filter((t) => t.liked).map((t) => t.id);
  if (route.view === 'recent') return store.tracks.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 60).map((t) => t.id);
  return store.search(state.filter).slice().sort((a, b) => collator.compare(a.title, b.title)).map((t) => t.id);
}

function listLabel() {
  return titleOf(top());
}

async function action(name) {
  const route = top();
  const actions = {
    back: pop,
    add: () => openAdd(),
    prefs: openPrefs,
    'new-playlist': () => newPlaylist(),
    'open-now': openNow,
    'close-now': closeNow,
    'up-next': openUpNext,
    toggle: () => player.toggle(),
    next: () => player.next(),
    prev: () => player.prev(),
    repeat: () => player.cycleRepeat(),
    metis: () => player.toggleMetis(),
    shuffle: () => player.toggleShuffle(),
    like: () => store.toggleLike(player.current.id, contextService.now()),
    'save-current': async () => {
      await store.savePreview(player.current.id);
      toast('Adicionada à biblioteca.');
    },
    'clear-recents': async () => {
      state.explore.recents = await clearRecentSearches();
      render();
    },
    'metis-all': () => { player.pool = null; player.playList(store.tracks.map((t) => t.id), 'Biblioteca', { order: 'metis' }); openNow(); },
    'shuffle-all': () => { player.playList(store.tracks.map((t) => t.id), 'Biblioteca', { order: 'shuffle' }); openNow(); },
    'list-metis': () => { player.playList(currentIds(), listLabel(), { order: 'metis' }); openNow(); },
    'list-shuffle': () => { player.playList(currentIds(), listLabel(), { order: 'shuffle' }); openNow(); },
    'rename-playlist': async () => {
      const playlist = store.playlists.find((p) => p.id === route.id);
      const name_ = await promptBox('Renomear playlist', { value: playlist.name, confirm: 'Salvar' });
      if (name_) store.renamePlaylist(route.id, name_);
    },
    'delete-playlist': async () => {
      if (await confirmBox('Apagar playlist', 'As músicas continuam na biblioteca.', { confirm: 'Apagar', danger: true })) {
        pop();
        store.deletePlaylist(route.id);
      }
    },
  };
  await actions[name]?.();
}

function onClick(event) {
  const t = event.target;
  const tab = t.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const go = t.closest('[data-go]');
  if (go) return setTab(go.dataset.go);
  const more = t.closest('[data-more]');
  if (more) {
    const id = more.dataset.more;
    const route = top();
    return showMenu(trackMenuItems([id], { playlistId: route.view === 'playlist' ? route.id : null }), { title: store.get(id)?.title });
  }
  const doer = t.closest('[data-do]');
  if (doer) return action(doer.dataset.do);
  const pushed = t.closest('[data-push]');
  if (pushed) return push({ view: pushed.dataset.push });
  const playlist = t.closest('[data-playlist]');
  if (playlist) return push({ view: 'playlist', id: playlist.dataset.playlist });
  const group = t.closest('[data-group]');
  if (group) return push({ view: 'group', group: group.dataset.group, name: group.dataset.name });
  const section = t.closest('[data-sec]');
  if (section) return document.getElementById(`sec-${section.dataset.sec}`)?.scrollIntoView();
  const song = t.closest('[data-song]');
  if (song) {
    player.play(song.dataset.song, { intent: 'manual', list: currentIds(), label: listLabel() });
    openNow();
    return undefined;
  }
  const recent = t.closest('[data-recent]');
  if (recent) {
    const item = state.explore.recents[Number(recent.dataset.recent)];
    state.explore.query = item.query;
    state.explore.results = item.results;
    render();
    return undefined;
  }
  const yt = t.closest('[data-yt]');
  if (yt) {
    const result = state.explore.results.find((r) => r.id === yt.dataset.yt);
    const adding = !!t.closest('[data-ytadd]');
    if (adding) {
      store.addYouTube(result).then(() => {
        toast('Adicionada à biblioteca.');
        render();
      });
    } else {
      player.play(store.preview(result).id, { intent: 'manual' });
      openNow();
    }
  }
  return undefined;
}

async function runSearch(query) {
  const e = state.explore;
  // So a busca mais recente pode mostrar resultado.
  const ticket = ++e.ticket;
  e.query = query;
  e.error = '';
  e.results = [];
  if (!query.trim()) return render();
  if (/youtu\.?be/.test(query)) {
    e.query = '';
    render();
    return openAdd({ text: query });
  }
  e.loading = true;
  render();
  try {
    const results = await searchYouTube(query);
    if (ticket !== e.ticket) return undefined;
    e.results = results;
    if (results.length) e.recents = await saveRecentSearch(query, results);
    else e.error = 'Nada encontrado.';
  } catch {
    if (ticket !== e.ticket) return undefined;
    e.error = 'A busca não respondeu agora. Tente de novo ou cole um link.';
  }
  e.loading = false;
  if (top().view === 'explore') render();
  return undefined;
}

function bindLongPress() {
  let timer = null;
  const start = (event) => {
    const cell = event.target.closest('[data-song]');
    if (!cell) return;
    timer = setTimeout(() => {
      navigator.vibrate?.(10);
      showMenu(trackMenuItems([cell.dataset.song]), { title: store.get(cell.dataset.song)?.title });
    }, 520);
  };
  const cancel = () => clearTimeout(timer);
  root.addEventListener('touchstart', start, { passive: true });
  root.addEventListener('touchmove', cancel, { passive: true });
  root.addEventListener('touchend', cancel);
}

// A tela Tocando acompanha o dedo e fecha ao passar de um terco da altura.
function bindSwipeDown() {
  const panel = $('#now');
  let startY = null;
  let distance = 0;
  panel.addEventListener('touchstart', (event) => {
    startY = event.target.closest('input, .now-controls, .now-modes') ? null : event.touches[0].clientY;
    distance = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (event) => {
    if (startY == null) return;
    distance = Math.max(0, event.touches[0].clientY - startY);
    panel.classList.add('dragging');
    panel.style.transform = `translateY(${distance}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (startY == null) return;
    startY = null;
    panel.classList.remove('dragging');
    panel.style.transform = '';
    if (distance > innerHeight / 3 || distance > 140) closeNow();
  });
}

export function mountMobile(container) {
  root = container;
  root.innerHTML = shell();
  render();
  renderNow();

  root.addEventListener('click', onClick);
  root.addEventListener('input', (event) => {
    if (event.target.id === 'm-filter') {
      state.filter = event.target.value;
      render();
    }
    if (event.target.id === 'm-q' && !event.target.value && state.explore.query) {
      state.explore.ticket++;
      Object.assign(state.explore, { query: '', results: [], error: '', loading: false });
      render();
    }
  });
  root.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id === 'm-ex') {
      document.activeElement?.blur();
      runSearch(new FormData(event.target).get('q'));
    }
  });
  bindMetisPanel($('#content'));
  getRecentSearches().then((list) => {
    state.explore.recents = list;
    if (top().view === 'explore') render();
  });
  bindLongPress();
  bindSwipeDown();

  const rerenderIfMetis = () => {
    if (top().view === 'metis') render();
  };
  const off = [
    bus.on('library', () => {
      render();
      syncNow();
    }),
    bus.on('playlists', render),
    bus.on('player', (info) => {
      if (info?.trackChanged || !$('#now').firstElementChild) {
        renderNow();
        render();
      } else {
        syncNow();
        renderNav();
        rerenderIfMetis();
      }
    }),
    bus.on('time', renderTime),
    bus.on('queue', rerenderIfMetis),
    bus.on('metis', rerenderIfMetis),
    bus.on('context', rerenderIfMetis),
  ];
  cleanups.push(() => off.forEach((fn) => fn()));
}

export function unmountMobile() {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  if (root) root.innerHTML = '';
}
