// Ponto de entrada: abre os dados, escolhe a interface e registra o PWA.

import { db } from './core/db.js';
import { store } from './core/store.js';
import { player } from './core/player.js';
import { contextService } from './core/context.js';
import { openAdd, runIntro, toast, ui } from './ui/shared.js';
import { mountDesktop, unmountDesktop } from './ui/desktop.js';
import { mountMobile, unmountMobile } from './ui/mobile.js';

// O HTML guarda o titulo completo para os buscadores.
document.title = 'Synapse';

const MOBILE_QUERY = matchMedia('(max-width: 820px)');

function mountInterface() {
  const mobile = MOBILE_QUERY.matches;
  const next = mobile ? 'mobile' : 'desktop';
  if (ui.mounted === next) return;
  if (ui.mounted === 'mobile') unmountMobile();
  if (ui.mounted === 'desktop') unmountDesktop();
  // Troca o elemento para descartar os listeners da interface anterior.
  const current = document.getElementById('app');
  const fresh = current.cloneNode(false);
  current.replaceWith(fresh);
  ui.mode = next;
  ui.mounted = next;
  document.documentElement.classList.toggle('ui-mobile', mobile);
  document.documentElement.classList.toggle('ui-desktop', !mobile);
  if (mobile) mountMobile(fresh);
  else mountDesktop(fresh);
}

// Compartilhar um link para o app ou abrir audio pelo Windows.
function handleLaunch() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text');
  if (shared || params.get('shortcut') === 'add') {
    history.replaceState(null, '', location.pathname);
    openAdd({ text: shared || '' });
  }
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launch) => {
      if (!launch.files?.length) return;
      const files = await Promise.all(launch.files.map((handle) => handle.getFile()));
      const report = await store.addFiles(files);
      if (report.ids[0]) player.play(report.ids[0], { intent: 'manual' });
    });
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((registration) => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nova versão pronta. Ela entra na próxima abertura.');
        }
      });
    });
  }).catch(() => {});
}

async function start() {
  await store.init();
  await contextService.init();
  await player.init();
  mountInterface();
  MOBILE_QUERY.addEventListener('change', mountInterface);
  document.getElementById('boot')?.remove();
  if (!(await db.getKV('introDone', false))) await runIntro();
  handleLaunch();
  registerServiceWorker();

  // Salva a posicao ao sair: o iOS mata PWAs sem aviso.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      player._persist();
      db.setKV('metis', store.metis.toJSON());
    }
  });
}

start().catch((error) => {
  console.error(error);
  const boot = document.getElementById('boot');
  if (boot) boot.querySelector('p').textContent = 'Não foi possível abrir os dados deste aparelho. Verifique se o navegador permite armazenamento.';
});
