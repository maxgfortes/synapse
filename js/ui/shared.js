// Pecas usadas pelas duas interfaces. A aparencia muda pelo CSS conforme a
// classe ui-desktop ou ui-mobile em <html>.

import { CONFIG } from '../config.js';
import { bus, escapeHtml as esc, formatTime } from '../core/bus.js';
import { db } from '../core/db.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { contextService, WEATHER_LABEL } from '../core/context.js';
import { readTags } from '../core/tags.js';
import { enrichQueue } from '../core/enrich.js';
import { resolve } from '../metis/features.js';
import { GENRES } from '../metis/genres.js';
import { icons, logo } from './icons.js';

export const ui = { mode: 'desktop', install: null };
export const isMobile = () => ui.mode === 'mobile';
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  ui.install = event;
  bus.emit('installable');
});

// No celular, menus e dialogos saem com animacao antes de sair do DOM.
function leave(element) {
  if (!isMobile()) {
    element.remove();
    return;
  }
  element.classList.add('leaving');
  setTimeout(() => element.remove(), 340);
}

export function html(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

export function cover(track, className = '') {
  if (track?.cover) return `<img class="cover ${className}" src="${track.cover}" alt="" loading="lazy" decoding="async">`;
  return `<span class="cover cover-empty ${className}">${icons.note}</span>`;
}

// A biblioteca guarda so a capa pequena. Telas grandes buscam a versao maior.
const largeCache = { id: null, src: null, zoom: false };

const loadImage = (src) => new Promise((done) => {
  const probe = new Image();
  probe.onload = () => done(probe.naturalWidth > 200 ? src : null);
  probe.onerror = () => done(null);
  probe.src = src;
});

// maxres nao existe em todo video. hqdefault tem faixas pretas: o zoom as corta.
async function youtubeCover(id) {
  const full = await loadImage(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`);
  if (full) return { src: full, zoom: false };
  return { src: await loadImage(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`), zoom: true };
}

export async function showLargeCover(track, element) {
  if (!track || !element) return;
  let src = largeCache.id === track.id ? largeCache.src : null;
  let zoom = largeCache.id === track.id && largeCache.zoom;
  if (!src) {
    if (track.sources?.yt) {
      ({ src, zoom } = await youtubeCover(track.sources.yt));
    } else if (track.sources?.local) {
      const row = await db.get('audio', track.id);
      const tags = row?.blob ? await readTags(row.blob).catch(() => null) : null;
      if (tags?.picture) src = URL.createObjectURL(tags.picture);
    }
    if (!src) return;
    if (largeCache.src?.startsWith('blob:')) URL.revokeObjectURL(largeCache.src);
    largeCache.id = track.id;
    largeCache.src = src;
    largeCache.zoom = zoom;
  }
  if (!element.isConnected) return;
  const image = element.tagName === 'IMG' ? element : html(`<img class="${element.className.replace('cover-empty', '')}" alt="">`);
  image.src = src;
  image.classList.toggle('zoomed', zoom);
  if (image !== element) element.replaceWith(image);
}

let toastTimer = null;
export function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = html('<div id="toast" role="status"></div>');
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

bus.on('toast', toast);

export function openModal({ title, body, buttons = [], className = '', onClose = null }) {
  const el = html(`<div class="modal ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-card">
      <header class="modal-head"><h2>${esc(title)}</h2></header>
      <div class="modal-body"></div>
      <footer class="modal-foot"></footer>
    </div>
  </div>`);
  const content = el.querySelector('.modal-body');
  if (typeof body === 'string') content.innerHTML = body;
  else if (body) content.append(body);

  const close = () => {
    leave(el);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  const foot = el.querySelector('.modal-foot');
  for (const button of buttons) {
    const b = html(`<button type="button" class="btn ${button.primary ? 'btn-primary' : ''} ${button.danger ? 'btn-danger' : ''}">${esc(button.label)}</button>`);
    b.addEventListener('click', async () => {
      const keep = await button.onClick?.({ close, el });
      if (keep !== true) close();
    });
    foot.append(b);
  }
  if (!buttons.length) foot.remove();
  document.body.append(el);
  return { close, el };
}

export function alertBox(title, message) {
  return new Promise((done) => {
    openModal({ title, className: 'alert', body: `<p>${esc(message)}</p>`, buttons: [{ label: 'OK', primary: true, onClick: () => done() }], onClose: done });
  });
}

export function confirmBox(title, message, { confirm = 'OK', danger = false } = {}) {
  return new Promise((done) => {
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      done(value);
    };
    openModal({
      title,
      className: 'alert',
      body: `<p>${esc(message)}</p>`,
      buttons: [
        { label: 'Cancelar', onClick: () => answer(false) },
        { label: confirm, primary: !danger, danger, onClick: () => answer(true) },
      ],
      onClose: () => answer(false),
    });
  });
}

export function promptBox(title, { value = '', placeholder = '', confirm = 'OK' } = {}) {
  return new Promise((done) => {
    let answered = false;
    const answer = (result) => {
      if (answered) return;
      answered = true;
      done(result);
    };
    const modal = openModal({
      title,
      className: 'alert',
      body: `<input class="field" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(title)}">`,
      buttons: [
        { label: 'Cancelar', onClick: () => answer(null) },
        { label: confirm, primary: true, onClick: ({ el }) => answer(el.querySelector('input').value.trim() || null) },
      ],
      onClose: () => answer(null),
    });
    const input = modal.el.querySelector('input');
    input.focus();
    input.select();
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        answer(input.value.trim() || null);
        modal.close();
      }
    });
  });
}

// Menu de contexto no desktop e sheet inferior no celular.
export function showMenu(items, { x = 0, y = 0, title = '' } = {}) {
  document.querySelector('.menu-layer')?.remove();
  const layer = html('<div class="menu-layer"></div>');
  const list = html(`<div class="menu" role="menu">${title ? `<div class="menu-title">${esc(title)}</div>` : ''}</div>`);
  const close = () => leave(layer);
  for (const item of items) {
    if (item === '-') {
      list.append(html('<div class="menu-sep" role="separator"></div>'));
      continue;
    }
    const row = html(`<button type="button" role="menuitem" class="menu-item ${item.danger ? 'danger' : ''} ${item.checked ? 'checked' : ''}" ${item.disabled ? 'disabled' : ''}><span>${esc(item.label)}</span>${item.hint ? `<kbd>${esc(item.hint)}</kbd>` : ''}${item.children ? '<i class="menu-arrow"></i>' : ''}</button>`);
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      if (item.children) {
        const rect = row.getBoundingClientRect();
        showMenu(item.children, { x: rect.right, y: rect.top, title: item.label });
        return;
      }
      close();
      item.onClick?.();
    });
    list.append(row);
  }
  layer.append(list);
  if (isMobile()) {
    list.append(html('<div class="menu-sep sheet-gap"></div>'));
    const cancel = html('<button type="button" class="menu-item sheet-cancel">Cancelar</button>');
    cancel.addEventListener('click', close);
    list.append(cancel);
  }
  layer.addEventListener('click', close);
  layer.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(layer);
  if (!isMobile()) {
    const box = list.getBoundingClientRect();
    list.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 6))}px`;
    list.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 6))}px`;
  }
  return close;
}

export function trackMenuItems(ids, { playlistId = null } = {}) {
  const single = ids.length === 1 ? store.get(ids[0]) : null;
  const playlists = store.playlists.map((p) => ({ label: p.name, onClick: () => { store.addToPlaylist(p.id, ids); toast(`Adicionada a ${p.name}.`); } }));
  const items = [
    { label: 'Reproduzir', onClick: () => player.play(ids[0], { intent: 'manual' }) },
    { label: 'Reproduzir a seguir', onClick: () => player.playNext(ids) },
    { label: 'Adicionar à lista', onClick: () => player.addToQueue(ids) },
    '-',
  ];
  if (single) {
    items.push({ label: single.liked ? 'Remover curtida' : 'Curtir', onClick: () => store.toggleLike(single.id, contextService.now()) });
  }
  items.push({
    label: 'Adicionar à playlist',
    children: [
      { label: 'Nova playlist...', onClick: () => newPlaylist(ids) },
      ...(playlists.length ? ['-', ...playlists] : []),
    ],
  });
  if (single) items.push({ label: 'Obter informações', onClick: () => openInfo(single.id) });
  items.push('-');
  if (playlistId) {
    items.push({ label: 'Remover da playlist', onClick: () => ids.forEach((id) => store.removeFromPlaylist(playlistId, id)) });
  }
  items.push({
    label: 'Apagar da biblioteca',
    danger: true,
    onClick: async () => {
      const name = single ? `"${single.title}"` : `${ids.length} músicas`;
      if (await confirmBox('Apagar da biblioteca', `Apagar ${name}? O histórico do Metís para ela também será removido.`, { confirm: 'Apagar', danger: true })) {
        store.remove(ids);
      }
    },
  });
  return items;
}

export async function newPlaylist(ids = []) {
  const name = await promptBox('Nova playlist', { placeholder: 'Nome da playlist', confirm: 'Criar' });
  if (!name) return null;
  const playlist = await store.createPlaylist(name, ids);
  toast(`Playlist "${playlist.name}" criada.`);
  return playlist;
}

function summarize(report) {
  const parts = [];
  if (report.added) parts.push(`${report.added} adicionada${report.added > 1 ? 's' : ''}`);
  if (report.linked) parts.push(`${report.linked} vinculada${report.linked > 1 ? 's' : ''} a faixas existentes`);
  if (report.repeated) parts.push(`${report.repeated} já na biblioteca`);
  if (report.failed.length) parts.push(`${report.failed.length} com erro`);
  return parts.join(', ') || 'Nada para adicionar.';
}

export function pickFiles({ multiple = true, accept = 'audio/*,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wav' } = {}) {
  return new Promise((done) => {
    const input = html(`<input type="file" ${multiple ? 'multiple' : ''} accept="${accept}" hidden>`);
    input.addEventListener('change', () => {
      done([...input.files]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      done([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

// URLs, arquivos locais ou os dois de uma vez.
export function openAdd({ files: initialFiles = [], text = '' } = {}) {
  let files = [...initialFiles];
  const body = html(`<div class="add-form">
    <label class="field-label" for="add-urls">Links do YouTube</label>
    <textarea id="add-urls" class="field" rows="4" placeholder="Cole um ou mais links de vídeo ou playlist"></textarea>
    <label class="field-label">Arquivos do aparelho</label>
    <button type="button" class="dropzone">
      <span class="dz-text">Escolher arquivos de áudio</span>
    </button>
    <p class="hint">Se uma música vier nas duas formas, o Synapse junta as fontes: toca o arquivo local e mantém o link do YouTube como reserva.</p>
    <div class="add-progress" hidden></div>
  </div>`);
  const textarea = body.querySelector('textarea');
  textarea.value = text;
  const zone = body.querySelector('.dropzone');
  const label = body.querySelector('.dz-text');
  const sync = () => {
    label.textContent = files.length
      ? `${files.length} arquivo${files.length > 1 ? 's' : ''} selecionado${files.length > 1 ? 's' : ''}`
      : (isMobile() ? 'Escolher arquivos de áudio' : 'Escolher arquivos ou arrastar para cá');
  };
  sync();
  zone.addEventListener('click', async () => {
    const picked = await pickFiles();
    if (picked.length) {
      files = [...files, ...picked];
      sync();
    }
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('over');
    files = [...files, ...event.dataTransfer.files];
    sync();
  });

  openModal({
    title: 'Adicionar músicas',
    className: 'sheet',
    body,
    buttons: [
      { label: 'Cancelar' },
      {
        label: 'Adicionar',
        primary: true,
        onClick: async ({ el }) => {
          const urls = textarea.value.trim();
          if (!urls && !files.length) return true;
          const progress = body.querySelector('.add-progress');
          progress.hidden = false;
          el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          const report = { added: 0, linked: 0, repeated: 0, failed: [], ids: [] };
          const merge = (r) => {
            report.added += r.added;
            report.linked += r.linked;
            report.repeated += r.repeated;
            report.failed.push(...r.failed);
          };
          if (files.length) {
            merge(await store.addFiles(files, (i, n) => { progress.textContent = `Lendo arquivos: ${i} de ${n}`; }));
          }
          if (urls) {
            progress.textContent = 'Buscando informações dos links...';
            merge(await store.addFromText(urls, (i, n) => { progress.textContent = `Salvando músicas: ${i} de ${n}`; }));
          }
          toast(summarize(report));
          return false;
        },
      },
    ],
  });
}

const KEYS = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
const percent = (x) => `${Math.round(x * 100)}%`;

export function genreLabel(track) {
  if (track.genre) return track.genre;
  const id = resolve(track).genreId;
  return id && id !== 'other' ? GENRES[id].label : '';
}

export function openInfo(id) {
  const track = store.get(id);
  if (!track) return;
  const f = track.features;
  const sourceLabel = { local: 'o próprio arquivo', preview: 'a prévia de 30 s do catálogo' }[f?.source] || '';
  const body = html(`<div class="info-form">
    <div class="info-top">${cover(track, 'info-cover')}<div><strong>${esc(track.title)}</strong><span>${esc(track.artist)}</span></div></div>
    <label class="field-label">Título<input class="field" name="title" value="${esc(track.title)}"></label>
    <label class="field-label">Artista<input class="field" name="artist" value="${esc(track.artist)}"></label>
    <label class="field-label">Álbum<input class="field" name="album" value="${esc(track.album)}"></label>
    <div class="field-row">
      <label class="field-label">Gênero<input class="field" name="genre" value="${esc(track.genre)}"></label>
      <label class="field-label">Ano<input class="field" name="year" inputmode="numeric" value="${esc(track.year ?? '')}"></label>
    </div>
    <h3>Fontes</h3>
    <dl class="info-list">
      <dt>YouTube</dt><dd>${track.url ? `<a href="${esc(track.url)}" target="_blank" rel="noopener">${esc(track.url.replace('https://www.', ''))}</a>` : '<button type="button" class="link" data-link-url>Vincular link</button>'}</dd>
      <dt>Arquivo</dt><dd>${track.sources?.local ? 'Salvo neste aparelho' : '<button type="button" class="link" data-link-file>Vincular arquivo</button>'}</dd>
    </dl>
    <h3>Análise do Metís</h3>
    ${f?.bpm ? `<dl class="info-list">
      <dt>Batidas</dt><dd>${Math.round(f.bpm)} BPM</dd>
      <dt>Tom</dt><dd>${KEYS[f.key]} ${f.mode ? 'maior' : 'menor'}</dd>
      <dt>Pitch</dt><dd>${Math.round(f.pitchHz)} Hz</dd>
      <dt>Energia</dt><dd>${percent(f.energy)}</dd>
      <dt>Graves</dt><dd>${percent(f.bass)}</dd>
      <dt>Agudos</dt><dd>${percent(f.treble)}</dd>
      <dt>Fonte</dt><dd>${sourceLabel}</dd>
    </dl>` : `<p class="hint">${track.enrichedAt ? 'Não foi possível medir o áudio desta faixa. O Metís usa gênero e título como estimativa.' : 'Análise na fila.'}</p>`}
  </div>`);
  body.querySelector('[data-link-file]')?.addEventListener('click', async () => {
    const [file] = await pickFiles({ multiple: false });
    if (file) {
      await store.linkFile(id, file);
      toast('Arquivo vinculado.');
    }
  });
  body.querySelector('[data-link-url]')?.addEventListener('click', async () => {
    const url = await promptBox('Link do YouTube', { placeholder: 'https://youtube.com/watch?v=...' });
    if (url && !(await store.linkYouTube(id, url))) toast('Link inválido.');
  });
  openModal({
    title: 'Informações',
    className: 'sheet',
    body,
    buttons: [
      { label: 'Cancelar' },
      {
        label: 'Salvar',
        primary: true,
        onClick: () => {
          const read = (name) => body.querySelector(`[name=${name}]`).value.trim();
          const year = parseInt(read('year'), 10);
          store.update(id, {
            title: read('title') || track.title,
            artist: read('artist') || track.artist,
            album: read('album'),
            genre: read('genre'),
            year: Number.isFinite(year) ? year : null,
          });
        },
      },
    ],
  });
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = html(`<a href="${url}" download="${name}" hidden></a>`);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportBackup(scope = 'all') {
  const data = await store.buildBackup(scope);
  const date = new Date().toISOString().slice(0, 10);
  download(scope === 'ml' ? `synapse-metis-${date}.json` : `synapse-backup-${date}.json`, JSON.stringify(data));
  toast(scope === 'ml' ? 'Modelo do Metís exportado.' : 'Backup exportado. Arquivos de áudio ficam de fora.');
}

export async function importBackup() {
  const [file] = await pickFiles({ multiple: false, accept: '.json,application/json' });
  if (!file) return;
  try {
    const report = await store.restoreBackup(JSON.parse(await file.text()));
    player.refill();
    toast(`Importado: ${report.tracks} músicas, ${report.playlists} playlists${report.model ? ' e o modelo do Metís' : ''}.`);
  } catch {
    alertBox('Importar', 'Este arquivo não é um backup válido do Synapse.');
  }
}

export async function openPrefs() {
  const key = await db.getKV('ytKey', '');
  const metis = store.metis;
  const adventure = Math.round(metis.settings.adventure * 100);
  const canInstall = !!ui.install;
  const body = html(`<div class="prefs">
    <h3>Metís</h3>
    <label class="field-label">Aventura <output>${adventure}%</output>
      <input type="range" name="adventure" min="0" max="100" value="${adventure}">
    </label>
    <p class="hint">Mais baixo: fica perto do que você já ouve. Mais alto: muda de clima mais vezes e arrisca mais.</p>
    <div class="switch-row">
      <span>Usar localização e clima</span>
      <button type="button" class="btn" data-geo>${contextService.consent === 'granted' ? 'Desativar' : 'Ativar'}</button>
    </div>
    <p class="hint">${contextService.consent === 'granted' ? `Ativo${contextService.place?.city ? `: ${esc(contextService.place.city)}` : ''}. Coordenadas arredondadas em cerca de 10 km.` : 'Sem localização, o Metís usa só data, hora e o que você ouve.'}</p>

    <h3>YouTube</h3>
    <label class="field-label">Chave própria da YouTube Data API (opcional)
      <input class="field" name="ytKey" type="password" autocomplete="off" spellcheck="false" value="${esc(key)}" placeholder="${CONFIG.youtubeApiKey ? 'Usando a chave do projeto' : 'Sem chave, usa um espelho público'}">
    </label>
    <p class="hint">Use uma chave sua se a cota do projeto acabar. Ela fica só neste aparelho e nunca entra nos backups.</p>

    <h3>Dados e aprendizado</h3>
    <div class="button-grid">
      <button type="button" class="btn" data-do="export-all">Exportar tudo</button>
      <button type="button" class="btn" data-do="export-ml">Exportar só o ML</button>
      <button type="button" class="btn" data-do="import">Importar</button>
      <button type="button" class="btn" data-do="reset-ml">Zerar aprendizado</button>
      <button type="button" class="btn btn-danger" data-do="wipe">Apagar tudo</button>
      ${canInstall ? '<button type="button" class="btn" data-do="install">Instalar app</button>' : ''}
    </div>
  </div>`);

  const range = body.querySelector('[name=adventure]');
  range.addEventListener('input', () => {
    body.querySelector('output').textContent = `${range.value}%`;
  });
  body.querySelector('[data-geo]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (contextService.consent === 'granted') {
      await contextService.setConsent('denied');
      button.textContent = 'Ativar';
    } else {
      const ok = await contextService.requestLocation();
      button.textContent = ok ? 'Desativar' : 'Ativar';
      if (!ok) toast('Localização não permitida.');
    }
  });
  body.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-do]')?.dataset.do;
    if (!action) return;
    if (action === 'export-all') exportBackup('all');
    if (action === 'export-ml') exportBackup('ml');
    if (action === 'import') importBackup();
    if (action === 'install') ui.install?.prompt();
    if (action === 'reset-ml' && await confirmBox('Zerar aprendizado', 'O Metís esquece tudo o que aprendeu. A biblioteca continua igual.', { confirm: 'Zerar', danger: true })) {
      await store.resetModel();
      player.refill();
      toast('Aprendizado zerado.');
    }
    if (action === 'wipe' && await confirmBox('Apagar tudo', 'Apaga músicas, playlists, áudio salvo e modelo deste aparelho. Isso não pode ser desfeito.', { confirm: 'Apagar tudo', danger: true })) {
      player.engine?.stop();
      await store.wipeAll();
      await db.setKV('introDone', true);
      location.reload();
    }
  });

  openModal({
    title: 'Preferências',
    className: 'sheet',
    body,
    buttons: [
      { label: 'Cancelar' },
      {
        label: 'Salvar',
        primary: true,
        onClick: async () => {
          metis.settings.adventure = range.value / 100;
          store.saveMetis();
          await db.setKV('ytKey', body.querySelector('[name=ytKey]').value.trim());
          player.refill();
          bus.emit('metis');
        },
      },
    ],
  });
}

const INTRO = [
  {
    title: 'Bem-vindo ao Synapse',
    text: 'Um player que descobre a ordem certa das suas músicas. Tudo fica salvo neste aparelho, sem conta e sem servidor.',
  },
  {
    title: 'Monte sua biblioteca',
    text: 'Busque no YouTube, cole links ou adicione arquivos do aparelho. Cada música fica salva com capa, título, artista e duração.',
  },
  {
    title: 'Conheça o Metís',
    text: 'Ele estima seu clima do momento com hora, tempo lá fora e o que você ouve ou pula. A ordem nunca acaba e muda de clima aos poucos, para você não ficar preso em um só.',
  },
];

export function runIntro() {
  return new Promise((done) => {
    let step = 0;
    const steps = INTRO.length + 1;
    const el = html(`<div class="intro" role="dialog" aria-modal="true" aria-label="Introdução ao Synapse">
      <div class="intro-card">
        <div class="intro-logo">${logo}</div>
        <div class="intro-content"></div>
        <div class="intro-dots"></div>
        <div class="intro-actions"></div>
      </div>
    </div>`);
    const finish = async () => {
      el.remove();
      await db.setKV('introDone', true);
      done();
    };
    const render = () => {
      const content = el.querySelector('.intro-content');
      const actions = el.querySelector('.intro-actions');
      el.querySelector('.intro-dots').innerHTML = Array.from({ length: steps }, (_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
      actions.innerHTML = '';
      const button = (label, primary, fn) => {
        const b = html(`<button type="button" class="btn ${primary ? 'btn-primary' : ''}">${esc(label)}</button>`);
        b.addEventListener('click', fn);
        actions.append(b);
      };
      content.classList.remove('step-in');
      void content.offsetWidth;
      content.classList.add('step-in');
      if (step < INTRO.length) {
        content.innerHTML = `<h2>${esc(INTRO[step].title)}</h2><p>${esc(INTRO[step].text)}</p>`;
        button('Pular', false, finish);
        button('Continuar', true, () => { step++; render(); });
      } else {
        const installHint = isIOS() && !isStandalone()
          ? '<p class="hint">Dica: no Safari, toque em Compartilhar e depois em Adicionar à Tela de Início para usar como app.</p>'
          : '';
        content.innerHTML = `<h2>Usar o clima da sua região?</h2><p>A localização serve para consultar o tempo lá fora e fica neste aparelho, arredondada em cerca de 10 km. Você pode mudar isso depois.</p>${installHint}`;
        button('Agora não', false, async () => {
          await contextService.setConsent('denied');
          finish();
        });
        button('Permitir', true, async () => {
          await contextService.requestLocation();
          finish();
        });
      }
    };
    render();
    document.body.append(el);
  });
}

const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export function contextChips() {
  const ctx = contextService.now();
  const hh = Math.floor(ctx.hour);
  const mm = String(Math.floor((ctx.hour % 1) * 60)).padStart(2, '0');
  const chips = [`${DAYS[ctx.dow]}, ${hh}:${mm}`];
  if (ctx.weather) chips.push(`${WEATHER_LABEL[ctx.weather]}, ${Math.round(ctx.temp)} °C`);
  if (ctx.city) chips.push(ctx.city);
  if (ctx.holiday) chips.push('Feriado');
  return chips;
}

function compass(snapshot) {
  const size = 240;
  const px = (x) => 12 + x * (size - 24);
  const py = (y) => size - 12 - y * (size - 24);
  const dots = snapshot.trail.map((p, i, all) => {
    const age = (i + 1) / all.length;
    return `<circle cx="${px(p.v).toFixed(1)}" cy="${py(p.a).toFixed(1)}" r="${(1.5 + age * 1.800).toFixed(1)}" fill="var(--accent)" opacity="${(0.1 + age * 0.45).toFixed(2)}"/>`;
  }).join('');
  const path = snapshot.trail.slice(-12).map((p, i) => `${i ? 'L' : 'M'}${px(p.v).toFixed(1)} ${py(p.a).toFixed(1)}`).join(' ');
  return `<svg class="compass" viewBox="0 0 ${size} ${size}" role="img" aria-label="Clima atual: ${esc(snapshot.mood.label)}. Alvo: ${esc(snapshot.target.label)}.">
    <rect x="12" y="12" width="${size - 24}" height="${size - 24}" rx="6" fill="var(--compass-bg)" stroke="var(--line)"/>
    <path d="M${size / 2} 12V${size - 12}M12 ${size / 2}H${size - 12}" stroke="var(--line)"/>
    <text x="${size / 2}" y="26" text-anchor="middle">Agitado</text>
    <text x="${size / 2}" y="${size - 18}" text-anchor="middle">Calmo</text>
    <text x="18" y="${size / 2 - 5}">Sombrio</text>
    <text x="${size - 18}" y="${size / 2 - 5}" text-anchor="end">Alegre</text>
    ${path ? `<path d="${path}" fill="none" stroke="var(--accent)" stroke-opacity=".3"/>` : ''}
    ${dots}
    <circle cx="${px(snapshot.target.v).toFixed(1)}" cy="${py(snapshot.target.a).toFixed(1)}" r="9" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 3"/>
    <circle cx="${px(snapshot.mood.v).toFixed(1)}" cy="${py(snapshot.mood.a).toFixed(1)}" r="5" fill="var(--accent)" stroke="var(--compass-bg)" stroke-width="1.5"/>
  </svg>`;
}

function rate(bucket) {
  if (!bucket?.n) return null;
  return Math.round((1 - bucket.skips / bucket.n) * 100);
}

// Painel do Metis: mesmo conteudo nas duas interfaces.
export function metisPanel() {
  const library = store.tracks;
  const snap = store.metis.snapshot(library, contextService.now());
  const rows = player.order === 'metis' ? player.upcoming(6).filter((r) => r.kind === 'metis') : [];
  const reasons = player.explain();
  const current = player.current;
  const i = snap.intents;
  const lines = [
    ['Audições analisadas', String(snap.samples)],
    ['Músicas com áudio medido', `${snap.analyzed} de ${library.length}`],
    ['Confiança no aprendizado', percent(snap.trust)],
  ];
  const metisRate = rate(i.metis);
  const shuffleRate = rate(i.shuffle);
  if (metisRate != null) lines.push(['Ouvidas sem pular no Metís', `${metisRate}%`]);
  if (shuffleRate != null) lines.push(['Ouvidas sem pular no aleatório', `${shuffleRate}%`]);

  return `<div class="metis-panel">
    <section class="metis-state">
      <h2>Clima agora: <em>${esc(snap.mood.label)}</em></h2>
      <p class="metis-sub">Indo para ${esc(snap.target.label)}${snap.target.urge > 0.3 ? ', para sair do mesmo clima' : ''}</p>
      ${compass(snap)}
      <ul class="chips">${contextChips().map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      ${contextService.consent !== 'granted' ? '<button type="button" class="link" data-action="enable-geo">Usar o clima da minha região</button>' : ''}
    </section>
    <section class="metis-next">
      ${current && reasons.length ? `<h3>Por que esta música</h3>
        <div class="why">${cover(current, 'why-cover')}<div><strong>${esc(current.title)}</strong><ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div></div>` : ''}
      <h3>A seguir no Metís</h3>
      ${rows.length ? `<ol class="metis-queue">${rows.map((r, n) => `<li data-action="jump" data-index="${n}">
        ${cover(r.track, 'row-cover')}
        <div><strong>${esc(r.track.title)}</strong><span>${esc(r.entry.reasons[0] || r.track.artist)}</span></div>
        <time>${formatTime(r.track.duration)}</time>
      </li>`).join('')}</ol>` : `<p class="hint">${library.length ? 'Ative o modo Metís para ver a ordem planejada.' : 'Adicione músicas para o Metís começar.'}</p>`}
      <h3>Aprendizado</h3>
      <dl class="info-list">${lines.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>
      <p class="hint">Tudo roda neste aparelho. Enquanto o histórico é pequeno, valem regras de partida; a cada audição o modelo pesa mais.</p>
    </section>
  </div>`;
}

export function bindMetisPanel(root) {
  root.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'enable-geo') {
      if (!(await contextService.requestLocation())) toast('Localização não permitida.');
    }
    if (target.dataset.action === 'jump') {
      const rows = player.upcoming(6).filter((r) => r.kind === 'metis');
      const row = rows[Number(target.dataset.index)];
      if (row) player.jumpTo(row);
    }
  });
}

export function enrichStatus() {
  const left = enrichQueue.queue.length;
  return left ? `Analisando músicas: faltam ${left}` : '';
}

export const links = {
  about: 'sobre.html',
  terms: 'termos.html',
  contact: 'contato.html',
  github: CONFIG.githubProfile,
  repo: CONFIG.githubRepo,
};
