// Interface de desktop: janela no estilo iTunes 12.

import { CONFIG } from '../config.js';
import { bus, escapeHtml as esc, formatDate, formatSize, formatTime, formatTotal } from '../core/bus.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { contextService } from '../core/context.js';
import { searchYouTube } from '../core/youtube.js';
import { icons, logo } from './icons.js';
import {
  bindMetisPanel, confirmBox, cover, enrichStatus, exportBackup, genreLabel, importBackup, links, metisPanel,
  newPlaylist, openAdd, openInfo, openPrefs, promptBox, showLargeCover, showMenu, toast, trackMenuItems, ui,
} from './shared.js';

const COLUMNS = [
  { key: 'title', label: 'Nome', cls: 'c-name' },
  { key: 'source', label: icons.cloud, cls: 'c-src', raw: true },
  { key: 'duration', label: 'Duração', cls: 'c-time' },
  { key: 'genre', label: 'Gênero', cls: 'c-genre' },
  { key: 'liked', label: icons.heart, cls: 'c-like', raw: true },
  { key: 'plays', label: 'Reproduções', cls: 'c-plays' },
  { key: 'artist', label: 'Artista', cls: 'c-artist' },
  { key: 'album', label: 'Álbum', cls: 'c-album' },
  { key: 'lastPlayed', label: 'Última Reprodução', cls: 'c-last' },
  { key: 'size', label: 'Tamanho', cls: 'c-size' },
];

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

const state = {
  route: { view: 'songs' },
  back: [],
  forward: [],
  sort: { key: 'artist', dir: 1 },
  filter: '',
  selected: new Set(),
  anchor: null,
  explore: { query: '', results: [], loading: false, error: '' },
  showUpNext: false,
};

let root;
let cleanups = [];

const $ = (selector) => root.querySelector(selector);

function sorted(list) {
  const { key, dir } = state.sort;
  const out = list.slice();
  const value = (t) => (key === 'genre' ? genreLabel(t) : key === 'source' ? (t.sources?.local ? 1 : 0) : t[key]);
  const byText = ['title', 'artist', 'album', 'genre'].includes(key);
  out.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const main = byText ? collator.compare(x || '', y || '') : (x || 0) - (y || 0);
    if (main) return main * dir;
    return collator.compare(a.album || '', b.album || '') || collator.compare(a.title, b.title);
  });
  return out;
}

function currentList() {
  const r = state.route;
  let list = store.tracks;
  if (r.view === 'playlist') {
    const playlist = store.playlists.find((p) => p.id === r.id);
    list = playlist ? playlist.trackIds.map((id) => store.get(id)).filter(Boolean) : [];
  } else if (r.view === 'liked') list = list.filter((t) => t.liked);
  else if (r.view === 'artist') list = list.filter((t) => t.artist === r.name);
  else if (r.view === 'album') list = list.filter((t) => (t.album || 'Álbum desconhecido') === r.name);
  else if (r.view === 'genre') list = list.filter((t) => (genreLabel(t) || 'Sem gênero') === r.name);
  list = store.search(state.filter, list);
  if (r.view === 'playlist' && !state.filter) return list;
  return sorted(list);
}

function go(route) {
  state.back.push(state.route);
  state.forward = [];
  state.route = route;
  state.selected.clear();
  render();
}

function history(from, to) {
  if (!from.length) return;
  to.push(state.route);
  state.route = from.pop();
  state.selected.clear();
  render();
}

function shell() {
  return `<div class="dt">
    <header class="dt-toolbar">
      <div class="dt-transport">
        <button type="button" class="tb" data-act="prev" aria-label="Anterior" title="Anterior">${icons.prev}</button>
        <button type="button" class="tb tb-play" data-act="toggle" aria-label="Reproduzir" title="Reproduzir">${icons.play}</button>
        <button type="button" class="tb" data-act="next" aria-label="Próxima" title="Próxima">${icons.next}</button>
        <input class="dt-volume" type="range" min="0" max="100" aria-label="Volume" title="Volume">
      </div>
      <div class="dt-lcd" id="lcd"></div>
      <div class="dt-tools">
        <button type="button" class="dt-listbtn" data-act="upnext" aria-label="A seguir" title="A seguir">${icons.list}</button>
        <label class="dt-search">${icons.search}<input type="search" id="dt-filter" placeholder="Buscar" aria-label="Buscar na biblioteca"></label>
      </div>
    </header>
    <nav class="dt-menubar" id="menubar" aria-label="Menu"></nav>
    <div class="dt-nav">
      <div class="dt-nav-left">
        <div class="dt-arrows">
          <button type="button" data-act="back" aria-label="Voltar">${icons.back}</button>
          <button type="button" data-act="forward" aria-label="Avançar">${icons.forward}</button>
        </div>
        <button type="button" class="dt-kind" data-act="kind">${icons.note}<span>Música</span><i></i></button>
      </div>
      <div class="dt-tabs" role="tablist">
        <button type="button" role="tab" data-tab="library">Biblioteca</button>
        <button type="button" role="tab" data-tab="metis">Metís</button>
        <button type="button" role="tab" data-tab="explore">Explorar</button>
      </div>
      <div class="dt-nav-right">
        <button type="button" class="dt-add" data-act="add">${icons.plus}<span>Adicionar</span></button>
      </div>
    </div>
    <div class="dt-body">
      <aside class="dt-side" aria-label="Biblioteca">
        <div class="dt-side-scroll" id="sidebar"></div>
        <div class="dt-art" id="art"><div id="art-cover"></div></div>
      </aside>
      <main class="dt-main" id="main"></main>
      <aside class="dt-upnext" id="upnext" hidden></aside>
    </div>
    <footer class="dt-status" id="status"></footer>
    <div class="dt-dropveil" hidden><div>Solte para adicionar à biblioteca</div></div>
  </div>`;
}

function renderSidebar() {
  const r = state.route;
  const item = (view, label, icon, name = '') => `<button type="button" class="side-item ${r.view === view && (r.name || '') === name ? 'on' : ''}" data-view="${view}">${icon}<span>${esc(label)}</span></button>`;
  $('#sidebar').innerHTML = `
    <h3>Biblioteca</h3>
    ${item('recent', 'Adições Recentes', icons.grid)}
    ${item('artists', 'Artistas', icons.mic)}
    ${item('albums', 'Álbuns', icons.album)}
    ${item('songs', 'Músicas', icons.note)}
    ${item('genres', 'Gêneros', icons.guitar)}
    ${item('liked', 'Curtidas', icons.heart)}
    <h3 class="side-head"><span>Todas as Playlists</span><button type="button" data-act="new-playlist" aria-label="Nova playlist" title="Nova playlist">${icons.plus}</button></h3>
    ${store.playlists.map((p) => `<button type="button" class="side-item ${r.view === 'playlist' && r.id === p.id ? 'on' : ''}" data-playlist="${p.id}">${icons.playlist}<span>${esc(p.name)}</span></button>`).join('')}
  `;
}

function renderTabs() {
  const v = state.route.view;
  const tab = v === 'metis' ? 'metis' : v === 'explore' ? 'explore' : 'library';
  root.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  });
  $('[data-act=back]').disabled = !state.back.length;
  $('[data-act=forward]').disabled = !state.forward.length;
}

function tableRows(list) {
  const currentId = player.current?.id;
  return list.map((t, i) => {
    const playing = t.id === currentId;
    const source = t.sources?.local ? icons.disk : icons.cloud;
    return `<tr data-id="${t.id}" data-index="${i}" class="${state.selected.has(t.id) ? 'sel' : ''} ${playing ? 'cur' : ''}">
      <td class="c-name"><span class="now">${playing ? (player.playing ? icons.speaker : icons.speakerLow) : ''}</span><span class="txt">${esc(t.title)}</span><button type="button" class="dots" data-more aria-label="Mais opções">${icons.more}</button></td>
      <td class="c-src" title="${t.sources?.local ? 'Arquivo local' : 'YouTube'}">${source}</td>
      <td class="c-time">${t.duration ? formatTime(t.duration) : ''}</td>
      <td class="c-genre">${esc(genreLabel(t))}</td>
      <td class="c-like"><button type="button" class="heart ${t.liked ? 'on' : ''}" data-like aria-label="${t.liked ? 'Remover curtida' : 'Curtir'}">${t.liked ? icons.heartFill : icons.heart}</button></td>
      <td class="c-plays">${t.plays || ''}</td>
      <td class="c-artist">${esc(t.artist)}</td>
      <td class="c-album">${esc(t.album)}</td>
      <td class="c-last">${formatDate(t.lastPlayed)}</td>
      <td class="c-size">${formatSize(t.size)}</td>
    </tr>`;
  }).join('');
}

function table(list) {
  const { key, dir } = state.sort;
  return `<div class="tbl-wrap" id="tbl"><table class="tbl">
    <thead><tr>${COLUMNS.map((c) => `<th class="${c.cls} ${key === c.key ? 'sorted' : ''}" data-sort="${c.key}" scope="col">${c.raw ? c.label : esc(c.label)}${key === c.key ? `<i class="${dir > 0 ? 'asc' : 'desc'}"></i>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${tableRows(list)}</tbody>
  </table></div>`;
}

function emptyLibrary() {
  return `<div class="empty">
    <div class="empty-logo">${logo}</div>
    <h2>Sua biblioteca está vazia</h2>
    <p>Busque no YouTube, cole um link ou arraste arquivos de áudio para esta janela.</p>
    <div class="empty-actions">
      <button type="button" class="btn btn-primary" data-tabgo="explore">Buscar músicas</button>
      <button type="button" class="btn" data-act="add">Adicionar links ou arquivos</button>
    </div>
  </div>`;
}

function groupBy(fn) {
  const map = new Map();
  for (const t of store.search(state.filter)) {
    const key = fn(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return [...map.entries()].sort((a, b) => collator.compare(a[0], b[0]));
}

function albumGrid(view) {
  const groups = groupBy((t) => t.album || 'Álbum desconhecido');
  return `<div class="grid-view">${groups.map(([name, tracks]) => `<button type="button" class="grid-item" data-open="${view}" data-name="${esc(name)}">
    ${cover(tracks.find((t) => t.cover) || tracks[0], 'grid-cover')}
    <strong>${esc(name)}</strong><span>${esc(tracks[0].artist)}</span>
  </button>`).join('')}</div>`;
}

function masterDetail(view, labelFn, label) {
  const groups = groupBy(labelFn);
  const selected = state.route.name || groups[0]?.[0];
  const tracks = groups.find(([name]) => name === selected)?.[1] || [];
  if (!state.route.name) state.route = { ...state.route, name: selected };
  return `<div class="md">
    <div class="md-list" role="listbox" aria-label="${esc(label)}">${groups.map(([name, list]) => `<button type="button" role="option" class="md-item ${name === selected ? 'on' : ''}" data-pick="${esc(name)}">
      ${cover(list.find((t) => t.cover) || list[0], 'md-cover')}<span><strong>${esc(name)}</strong><small>${list.length} ${list.length > 1 ? 'músicas' : 'música'}</small></span>
    </button>`).join('')}</div>
    <div class="md-detail">
      <header class="md-head"><h2>${esc(selected || '')}</h2>
        <p>${tracks.length} ${tracks.length > 1 ? 'músicas' : 'música'}, ${formatTotal(tracks.reduce((s, t) => s + (t.duration || 0), 0))}</p>
        ${tracks.length ? `<div class="md-actions"><button type="button" class="btn" data-playall>Reproduzir</button><button type="button" class="btn" data-playall="metis">Metís</button></div>` : ''}
      </header>
      ${table(sorted(tracks))}
    </div>
  </div>`;
}

function exploreView() {
  const e = state.explore;
  const rows = e.results.map((r) => {
    const inLibrary = store.tracks.some((t) => t.sources?.yt === r.id);
    return `<div class="ex-row" data-yt="${esc(r.id)}">
      <img class="cover" src="${esc(r.cover)}" alt="" loading="lazy">
      <div class="ex-text"><strong>${esc(r.title)}</strong><span>${esc(r.artist)}</span></div>
      <time>${r.duration ? formatTime(r.duration) : ''}</time>
      <button type="button" class="btn" data-ex="play">Reproduzir</button>
      <button type="button" class="btn ${inLibrary ? '' : 'btn-primary'}" data-ex="add" ${inLibrary ? 'disabled' : ''}>${inLibrary ? 'Na biblioteca' : 'Adicionar'}</button>
    </div>`;
  }).join('');
  return `<div class="explore">
    <form class="ex-form" id="ex-form">
      <h1>Explorar</h1>
      <div class="ex-search">${icons.search}<input type="search" name="q" value="${esc(e.query)}" placeholder="Música, artista ou link do YouTube" aria-label="Buscar no YouTube" autocomplete="off"></div>
    </form>
    ${e.loading ? '<p class="ex-msg">Buscando...</p>' : ''}
    ${e.error ? `<p class="ex-msg">${esc(e.error)}</p>` : ''}
    <div class="ex-list">${rows}</div>
  </div>`;
}

function renderMain() {
  const r = state.route;
  const main = $('#main');
  const emptyLib = !store.tracks.length;
  main.className = `dt-main view-${r.view}`;
  if (r.view === 'metis') {
    main.innerHTML = `<div class="page">${metisPanel()}</div>`;
  } else if (r.view === 'explore') {
    main.innerHTML = exploreView();
  } else if (emptyLib) {
    main.innerHTML = emptyLibrary();
  } else if (r.view === 'albums') {
    main.innerHTML = albumGrid('album');
  } else if (r.view === 'artists') {
    main.innerHTML = masterDetail('artist', (t) => t.artist, 'Artistas');
  } else if (r.view === 'genres') {
    main.innerHTML = masterDetail('genre', (t) => genreLabel(t) || 'Sem gênero', 'Gêneros');
  } else if (r.view === 'recent') {
    const list = store.search(state.filter).slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 60);
    main.innerHTML = `<div class="grid-view">${list.map((t) => `<button type="button" class="grid-item" data-play="${t.id}">
      ${cover(t, 'grid-cover')}<strong>${esc(t.title)}</strong><span>${esc(t.artist)}</span></button>`).join('')}</div>`;
  } else {
    const list = currentList();
    const playlist = r.view === 'playlist' ? store.playlists.find((p) => p.id === r.id) : null;
    const head = r.view === 'playlist' || r.view === 'album' || r.view === 'liked'
      ? `<header class="md-head list-head"><h2>${esc(playlist?.name || r.name || 'Curtidas')}</h2>
          <p>${list.length} ${list.length === 1 ? 'música' : 'músicas'}</p>
          ${list.length ? `<div class="md-actions"><button type="button" class="btn" data-playall>Reproduzir</button><button type="button" class="btn" data-playall="metis">Metís</button>${playlist ? '<button type="button" class="btn" data-pl-menu>Editar</button>' : ''}</div>` : ''}
        </header>`
      : '';
    main.innerHTML = `${head}${table(list)}`;
  }
}

function renderStatus() {
  const list = ['playlist', 'liked', 'artist', 'album', 'genre'].includes(state.route.view) ? currentList() : store.search(state.filter);
  const seconds = list.reduce((s, t) => s + (t.duration || 0), 0);
  const bytes = list.reduce((s, t) => s + (t.size || 0), 0);
  const count = `${list.length} ${list.length === 1 ? 'música' : 'músicas'}`;
  const parts = [count, formatTotal(seconds)];
  if (bytes) parts.push(formatSize(bytes));
  const busy = enrichStatus();
  $('#status').textContent = busy ? `${parts.join(', ')}   |   ${busy}` : parts.join(', ');
}

function renderLcd() {
  const t = player.current;
  const lcd = $('#lcd');
  const order = player.order;
  const toggles = (html_) => `
    <button type="button" class="lcd-toggle left ${order === 'shuffle' ? 'on' : ''}" data-act="shuffle" title="Aleatório clássico" aria-label="Aleatório clássico" aria-pressed="${order === 'shuffle'}">${icons.shuffle}</button>
    ${html_}
    <button type="button" class="lcd-toggle metis ${order === 'metis' ? 'on' : ''}" data-act="metis" title="Ordem inteligente Metís" aria-label="Ordem inteligente Metís" aria-pressed="${order === 'metis'}">${icons.metis}</button>
    <button type="button" class="lcd-toggle right ${player.repeat !== 'off' ? 'on' : ''}" data-act="repeat" title="Repetir" aria-label="Repetir">${player.repeat === 'one' ? icons.repeatOne : icons.repeat}</button>`;
  if (!t) {
    lcd.classList.remove('active');
    lcd.innerHTML = toggles(`<div class="lcd-logo">${logo}</div>`);
    return;
  }
  lcd.classList.add('active');
  lcd.innerHTML = toggles(`
    ${cover(t, 'lcd-cover')}
    <div class="lcd-center">
      <div class="lcd-title">${esc(t.title)}</div>
      <div class="lcd-sub">${esc([t.artist, t.album].filter(Boolean).join(' — '))}</div>
      <div class="lcd-time"><span id="lcd-pos">0:00</span>
        <div class="lcd-bar" id="lcd-bar"><div class="lcd-fill" id="lcd-fill"></div></div>
        <span id="lcd-left">-0:00</span></div>
    </div>`);
  renderTime();
}

function renderTime() {
  const fill = $('#lcd-fill');
  if (!fill) return;
  const position = player.position;
  const duration = player.duration;
  fill.style.width = `${duration ? Math.min((position / duration) * 100, 100) : 0}%`;
  $('#lcd-pos').textContent = formatTime(position);
  $('#lcd-left').textContent = `-${formatTime(Math.max(duration - position, 0))}`;
}

function renderPlayState() {
  const button = $('[data-act=toggle]');
  button.innerHTML = player.playing ? icons.pause : icons.play;
  const label = player.playing ? 'Pausar' : 'Reproduzir';
  button.setAttribute('aria-label', label);
  button.title = label;
  const t = player.current;
  const art = $('#art-cover');
  art.innerHTML = t ? cover(t, 'art-cover') : '';
  showLargeCover(t, art.firstElementChild);
  $('#art').classList.toggle('empty', !t);
}

function refreshRows() {
  const tbody = root.querySelector('.tbl tbody');
  if (!tbody) return;
  const currentId = player.current?.id;
  tbody.querySelectorAll('tr').forEach((row) => {
    const playing = row.dataset.id === currentId;
    row.classList.toggle('cur', playing);
    row.querySelector('.now').innerHTML = playing ? (player.playing ? icons.speaker : icons.speakerLow) : '';
  });
}

function renderUpNext() {
  const panel = $('#upnext');
  panel.hidden = !state.showUpNext;
  if (!state.showUpNext) return;
  const rows = player.upcoming(40);
  const label = { metis: 'Metís', shuffle: 'Aleatório', sequence: 'Em sequência' }[player.order];
  panel.innerHTML = `<header><h3>A Seguir</h3><span>${label}</span>${player.queue.length ? '<button type="button" class="link" data-act="clear-queue">Limpar</button>' : ''}</header>
    <ol>${rows.map((r, i) => `<li data-up="${i}">
      ${cover(r.track, 'row-cover')}
      <div><strong>${esc(r.track.title)}</strong><span>${esc(r.track.artist)}</span>${r.entry?.reasons?.[0] ? `<em>${esc(r.entry.reasons[0])}</em>` : ''}</div>
      ${r.kind === 'queue' ? `<button type="button" class="up-x" data-unqueue="${r.index}" aria-label="Remover da lista">${icons.close}</button>` : ''}
    </li>`).join('') || '<li class="up-empty">Nada na fila.</li>'}</ol>`;
}

function renderMenubar() {
  const names = ['Arquivo', 'Editar', 'Música', 'Visualizar', 'Controles', 'Metís', 'Ajuda'];
  $('#menubar').innerHTML = names.map((n) => `<button type="button" data-menu="${n}">${n}</button>`).join('');
}

function menuItems(name) {
  const open = (url) => () => window.open(url, '_blank', 'noopener');
  const selectedIds = () => [...state.selected];
  const hasSelection = state.selected.size > 0;
  const switchView = (view) => () => go({ view });
  switch (name) {
    case 'Arquivo': return [
      { label: 'Adicionar links ou arquivos...', hint: 'Ctrl+O', onClick: () => openAdd() },
      { label: 'Nova playlist...', hint: 'Ctrl+N', onClick: () => newPlaylist() },
      '-',
      { label: 'Exportar biblioteca e ML...', onClick: () => exportBackup('all') },
      { label: 'Exportar só o ML...', onClick: () => exportBackup('ml') },
      { label: 'Importar...', onClick: () => importBackup() },
      '-',
      { label: 'Instalar o Synapse', disabled: !ui.install, onClick: () => ui.install?.prompt() },
    ];
    case 'Editar': return [
      { label: 'Selecionar tudo', hint: 'Ctrl+A', onClick: selectAll },
      { label: 'Buscar na biblioteca', hint: 'Ctrl+F', onClick: () => $('#dt-filter').focus() },
      '-',
      { label: 'Preferências...', hint: 'Ctrl+,', onClick: openPrefs },
    ];
    case 'Música': return [
      { label: 'Reproduzir seleção', disabled: !hasSelection, onClick: () => player.play(selectedIds()[0], { intent: 'manual' }) },
      { label: 'Adicionar à lista', disabled: !hasSelection, onClick: () => player.addToQueue(selectedIds()) },
      { label: 'Curtir', disabled: state.selected.size !== 1, onClick: () => store.toggleLike(selectedIds()[0], contextService.now()) },
      { label: 'Obter informações', hint: 'Ctrl+I', disabled: state.selected.size !== 1, onClick: () => openInfo(selectedIds()[0]) },
    ];
    case 'Visualizar': return [
      { label: 'Adições Recentes', onClick: switchView('recent') },
      { label: 'Artistas', onClick: switchView('artists') },
      { label: 'Álbuns', onClick: switchView('albums') },
      { label: 'Músicas', onClick: switchView('songs') },
      { label: 'Gêneros', onClick: switchView('genres') },
      { label: 'Curtidas', onClick: switchView('liked') },
      '-',
      { label: 'A Seguir', checked: state.showUpNext, onClick: toggleUpNext },
    ];
    case 'Controles': return [
      { label: player.playing ? 'Pausar' : 'Reproduzir', hint: 'Espaço', onClick: () => player.toggle() },
      { label: 'Próxima', hint: 'Ctrl+→', onClick: () => player.next() },
      { label: 'Anterior', hint: 'Ctrl+←', onClick: () => player.prev() },
      '-',
      { label: 'Aumentar volume', hint: 'Ctrl+↑', onClick: () => player.setVolume(player.volume + 0.1) },
      { label: 'Diminuir volume', hint: 'Ctrl+↓', onClick: () => player.setVolume(player.volume - 0.1) },
      '-',
      { label: 'Ordem Metís', checked: player.order === 'metis', onClick: () => player.setOrder('metis') },
      { label: 'Aleatório clássico', checked: player.order === 'shuffle', onClick: () => player.setOrder('shuffle') },
      { label: 'Em sequência', checked: player.order === 'sequence', onClick: () => player.setOrder('sequence') },
      '-',
      {
        label: 'Repetir',
        children: [
          { label: 'Não repetir', checked: player.repeat === 'off', onClick: () => setRepeat('off') },
          { label: 'Repetir lista', checked: player.repeat === 'all', onClick: () => setRepeat('all') },
          { label: 'Repetir música', checked: player.repeat === 'one', onClick: () => setRepeat('one') },
        ],
      },
    ];
    case 'Metís': return [
      { label: 'Abrir painel do Metís', onClick: switchView('metis') },
      { label: 'Recalcular a ordem', onClick: () => { player.refill(); toast('Ordem recalculada.'); } },
      '-',
      { label: 'Ajustar aventura...', onClick: openPrefs },
      { label: 'Exportar o ML...', onClick: () => exportBackup('ml') },
    ];
    case 'Ajuda': return [
      { label: 'Sobre o Synapse', onClick: open(links.about) },
      { label: 'Termos e privacidade', onClick: open(links.terms) },
      { label: 'Contato', onClick: open(links.contact) },
      '-',
      { label: 'Projeto no GitHub', onClick: open(links.repo) },
      { label: 'GitHub do autor', onClick: open(links.github) },
      '-',
      { label: `Versão ${CONFIG.version}`, disabled: true },
    ];
    default: return [];
  }
}

function setRepeat(mode) {
  player.repeat = mode;
  player._persist();
  bus.emit('player');
}

function selectAll() {
  const rows = root.querySelectorAll('.tbl tbody tr');
  state.selected = new Set([...rows].map((r) => r.dataset.id));
  rows.forEach((r) => r.classList.add('sel'));
}

function toggleUpNext() {
  state.showUpNext = !state.showUpNext;
  renderUpNext();
}

function render() {
  renderSidebar();
  renderTabs();
  renderMain();
  renderStatus();
}

async function runSearch(query) {
  const e = state.explore;
  e.query = query;
  e.error = '';
  e.results = [];
  if (!query.trim()) {
    renderMain();
    return;
  }
  e.loading = true;
  renderMain();
  try {
    if (/youtu\.?be/.test(query)) {
      openAdd({ text: query });
      e.loading = false;
      e.query = '';
      renderMain();
      return;
    }
    e.results = await searchYouTube(query);
    if (!e.results.length) e.error = 'Nada encontrado.';
  } catch {
    e.error = 'A busca não respondeu agora. Tente de novo, cole um link ou configure uma chave em Preferências.';
  }
  e.loading = false;
  if (state.route.view === 'explore') renderMain();
}

function selectRow(row, event) {
  const id = row.dataset.id;
  if (event.shiftKey && state.anchor != null) {
    const rows = [...root.querySelectorAll('.tbl tbody tr')];
    const a = rows.findIndex((r) => r.dataset.id === state.anchor);
    const b = rows.indexOf(row);
    state.selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.dataset.id));
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    state.anchor = id;
  } else {
    state.selected = new Set([id]);
    state.anchor = id;
  }
  root.querySelectorAll('.tbl tbody tr').forEach((r) => r.classList.toggle('sel', state.selected.has(r.dataset.id)));
}

function listContext() {
  const r = state.route;
  const ids = () => [...root.querySelectorAll('.tbl tbody tr')].map((row) => row.dataset.id);
  const label = r.view === 'playlist'
    ? store.playlists.find((p) => p.id === r.id)?.name
    : r.name || 'Biblioteca';
  return { ids, label };
}

function onClick(event) {
  const t = event.target;
  const act = t.closest('[data-act]')?.dataset.act;
  if (act) {
    const actions = {
      toggle: () => player.toggle(),
      next: () => player.next(),
      prev: () => player.prev(),
      back: () => history(state.back, state.forward),
      forward: () => history(state.forward, state.back),
      add: () => openAdd(),
      upnext: toggleUpNext,
      shuffle: () => player.toggleShuffle(),
      metis: () => player.toggleMetis(),
      repeat: () => player.cycleRepeat(),
      'new-playlist': () => newPlaylist(),
      'clear-queue': () => player.clearQueue(),
      kind: () => {
        const rect = t.closest('[data-act]').getBoundingClientRect();
        showMenu(menuItems('Visualizar'), { x: rect.left, y: rect.bottom + 2 });
      },
    };
    actions[act]?.();
    return;
  }
  const menu = t.closest('[data-menu]');
  if (menu) {
    const rect = menu.getBoundingClientRect();
    showMenu(menuItems(menu.dataset.menu), { x: rect.left, y: rect.bottom });
    return;
  }
  const tab = t.closest('[data-tab]')?.dataset.tab || t.closest('[data-tabgo]')?.dataset.tabgo;
  if (tab) {
    go(tab === 'library' ? { view: 'songs' } : { view: tab });
    return;
  }
  const view = t.closest('[data-view]')?.dataset.view;
  if (view) {
    go({ view });
    return;
  }
  const playlistRow = t.closest('[data-playlist]');
  if (playlistRow) {
    go({ view: 'playlist', id: playlistRow.dataset.playlist });
    return;
  }
  const sort = t.closest('[data-sort]')?.dataset.sort;
  if (sort) {
    state.sort = { key: sort, dir: state.sort.key === sort ? -state.sort.dir : 1 };
    renderMain();
    return;
  }
  const like = t.closest('[data-like]');
  if (like) {
    event.stopPropagation();
    store.toggleLike(like.closest('tr').dataset.id, contextService.now());
    return;
  }
  const more = t.closest('[data-more]');
  if (more) {
    const id = more.closest('tr').dataset.id;
    const rect = more.getBoundingClientRect();
    showMenu(rowMenu(id), { x: rect.left, y: rect.bottom });
    return;
  }
  const row = t.closest('.tbl tbody tr');
  if (row) {
    selectRow(row, event);
    return;
  }
  const open = t.closest('[data-open]');
  if (open) {
    go({ view: open.dataset.open, name: open.dataset.name });
    return;
  }
  const pick = t.closest('[data-pick]');
  if (pick) {
    state.route = { ...state.route, name: pick.dataset.pick };
    render();
    return;
  }
  const play = t.closest('[data-play]');
  if (play) {
    player.play(play.dataset.play, { intent: 'manual' });
    return;
  }
  const playAll = t.closest('[data-playall]');
  if (playAll) {
    const { ids, label } = listContext();
    player.playList(ids(), label, { order: playAll.dataset.playall === 'metis' ? 'metis' : 'sequence' });
    return;
  }
  if (t.closest('[data-pl-menu]')) {
    const rect = t.closest('[data-pl-menu]').getBoundingClientRect();
    const id = state.route.id;
    showMenu([
      {
        label: 'Renomear...',
        onClick: async () => {
          const playlist = store.playlists.find((p) => p.id === id);
          const name = await promptBox('Renomear playlist', { value: playlist.name, confirm: 'Salvar' });
          if (name) store.renamePlaylist(id, name);
        },
      },
      {
        label: 'Apagar playlist',
        danger: true,
        onClick: async () => {
          if (await confirmBox('Apagar playlist', 'As músicas continuam na biblioteca.', { confirm: 'Apagar', danger: true })) {
            await store.deletePlaylist(id);
            go({ view: 'songs' });
          }
        },
      },
    ], { x: rect.left, y: rect.bottom + 2 });
    return;
  }
  const exAction = t.closest('[data-ex]');
  if (exAction) {
    const id = exAction.closest('[data-yt]').dataset.yt;
    const result = state.explore.results.find((r) => r.id === id);
    store.addYouTube(result).then(({ track }) => {
      if (exAction.dataset.ex === 'play') player.play(track.id, { intent: 'manual' });
      else toast('Adicionada à biblioteca.');
      if (state.route.view === 'explore') renderMain();
    });
    return;
  }
  const unqueue = t.closest('[data-unqueue]');
  if (unqueue) {
    player.removeFromQueue(Number(unqueue.dataset.unqueue));
    return;
  }
  const up = t.closest('[data-up]');
  if (up) {
    const rows = player.upcoming(40);
    if (rows[up.dataset.up]) player.jumpTo(rows[up.dataset.up]);
    return;
  }
  const bar = t.closest('#lcd-bar');
  if (bar) {
    const rect = bar.getBoundingClientRect();
    player.seek(((event.clientX - rect.left) / rect.width) * player.duration);
  }
}

function rowMenu(id) {
  const ids = state.selected.has(id) && state.selected.size > 1 ? [...state.selected] : [id];
  return trackMenuItems(ids, { playlistId: state.route.view === 'playlist' ? state.route.id : null });
}

function onDblClick(event) {
  const row = event.target.closest('.tbl tbody tr');
  if (!row || event.target.closest('button')) return;
  const { ids, label } = listContext();
  player.play(row.dataset.id, { intent: 'manual', list: ids(), label });
}

function onContextMenu(event) {
  const row = event.target.closest('.tbl tbody tr');
  if (row) {
    event.preventDefault();
    if (!state.selected.has(row.dataset.id)) selectRow(row, {});
    showMenu(rowMenu(row.dataset.id), { x: event.clientX, y: event.clientY });
    return;
  }
  const playlist = event.target.closest('[data-playlist]');
  if (playlist) {
    event.preventDefault();
    const id = playlist.dataset.playlist;
    showMenu([
      { label: 'Reproduzir', onClick: () => player.playList(store.playlists.find((p) => p.id === id).trackIds, store.playlists.find((p) => p.id === id).name) },
      {
        label: 'Renomear...',
        onClick: async () => {
          const item = store.playlists.find((p) => p.id === id);
          const name = await promptBox('Renomear playlist', { value: item.name, confirm: 'Salvar' });
          if (name) store.renamePlaylist(id, name);
        },
      },
      { label: 'Apagar', danger: true, onClick: () => store.deletePlaylist(id).then(() => state.route.id === id && go({ view: 'songs' })) },
    ], { x: event.clientX, y: event.clientY });
  }
}

function onKey(event) {
  const typing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
  const ctrl = event.ctrlKey || event.metaKey;
  if (event.code === 'Space' && !typing && event.target.tagName !== 'BUTTON') {
    event.preventDefault();
    player.toggle();
  } else if (ctrl && event.key === 'ArrowRight') {
    event.preventDefault();
    player.next();
  } else if (ctrl && event.key === 'ArrowLeft') {
    event.preventDefault();
    player.prev();
  } else if (ctrl && event.key === 'ArrowUp') {
    event.preventDefault();
    player.setVolume(player.volume + 0.1);
  } else if (ctrl && event.key === 'ArrowDown') {
    event.preventDefault();
    player.setVolume(player.volume - 0.1);
  } else if (ctrl && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    $('#dt-filter').focus();
  } else if (ctrl && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    openAdd();
  } else if (ctrl && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    newPlaylist();
  } else if (ctrl && event.key === ',') {
    event.preventDefault();
    openPrefs();
  } else if (ctrl && event.key.toLowerCase() === 'a' && !typing) {
    event.preventDefault();
    selectAll();
  } else if (ctrl && event.key.toLowerCase() === 'i' && state.selected.size === 1) {
    event.preventDefault();
    openInfo([...state.selected][0]);
  } else if (event.key === 'Delete' && !typing && state.selected.size) {
    trackMenuItems([...state.selected]).at(-1).onClick();
  }
}

function bindDrop() {
  const veil = $('.dt-dropveil');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const enter = (e) => {
    if (!hasFiles(e)) return;
    depth++;
    veil.hidden = false;
  };
  const leave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) veil.hidden = true;
  };
  const over = (e) => {
    if (hasFiles(e)) e.preventDefault();
  };
  const drop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    const report = await store.addFiles(e.dataTransfer.files);
    toast(report.added + report.linked ? `${report.added + report.linked} músicas adicionadas.` : 'Nenhum arquivo de áudio novo.');
  };
  document.addEventListener('dragenter', enter);
  document.addEventListener('dragleave', leave);
  document.addEventListener('dragover', over);
  document.addEventListener('drop', drop);
  cleanups.push(() => {
    document.removeEventListener('dragenter', enter);
    document.removeEventListener('dragleave', leave);
    document.removeEventListener('dragover', over);
    document.removeEventListener('drop', drop);
  });
}

export function mountDesktop(container) {
  root = container;
  root.innerHTML = shell();
  renderMenubar();
  render();
  renderLcd();
  renderPlayState();
  renderUpNext();

  const volume = $('.dt-volume');
  const paintVolume = () => {
    volume.value = Math.round(player.volume * 100);
    volume.style.setProperty('--fill', `${volume.value}%`);
  };
  paintVolume();
  volume.addEventListener('input', () => player.setVolume(volume.value / 100));

  const filter = $('#dt-filter');
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    if (state.route.view === 'metis' || state.route.view === 'explore') state.route = { view: 'songs' };
    render();
  });

  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDblClick);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id === 'ex-form') runSearch(new FormData(event.target).get('q'));
  });
  document.addEventListener('keydown', onKey);
  bindMetisPanel($('#main'));
  bindDrop();

  const refreshMetis = () => {
    if (state.route.view === 'metis') renderMain();
    renderUpNext();
  };
  const off = [
    bus.on('library', () => { render(); renderLcd(); }),
    bus.on('playlists', render),
    bus.on('player', (info) => {
      renderPlayState();
      if (info?.trackChanged) renderLcd();
      else renderLcdToggles();
      refreshRows();
      refreshMetis();
    }),
    bus.on('time', renderTime),
    bus.on('volume', paintVolume),
    bus.on('queue', refreshMetis),
    bus.on('metis', refreshMetis),
    bus.on('context', refreshMetis),
    bus.on('enrich', renderStatus),
  ];
  cleanups.push(() => {
    off.forEach((fn) => fn());
    document.removeEventListener('keydown', onKey);
  });
}

function renderLcdToggles() {
  const lcd = $('#lcd');
  if (!lcd) return;
  lcd.querySelector('[data-act=shuffle]')?.classList.toggle('on', player.order === 'shuffle');
  lcd.querySelector('[data-act=metis]')?.classList.toggle('on', player.order === 'metis');
  const repeat = lcd.querySelector('[data-act=repeat]');
  if (repeat) {
    repeat.classList.toggle('on', player.repeat !== 'off');
    repeat.innerHTML = player.repeat === 'one' ? icons.repeatOne : icons.repeat;
  }
}

export function unmountDesktop() {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  if (root) root.innerHTML = '';
}
