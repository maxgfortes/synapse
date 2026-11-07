// Gera js/ui/icons.js a partir de assets/sfsymbols-svg-1.0/symbols.
// Inclui so os simbolos usados, para o app nao carregar 1.679 arquivos.
// Uso: node tools/make-icons.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const symbols = join(root, 'assets/sfsymbols-svg-1.0/symbols');
const output = join(root, 'js/ui/icons.js');

const MAP = {
  play: 'play.fill',
  pause: 'pause.fill',
  next: 'forward.fill',
  prev: 'backward.fill',
  shuffle: 'shuffle',
  repeat: 'repeat',
  repeatOne: 'repeat.1',
  list: 'list.bullet',
  heart: 'heart',
  heartFill: 'heart.fill',
  search: 'magnifyingglass',
  note: 'music.note',
  speaker: 'speaker.3.fill',
  speakerLow: 'speaker.fill',
  cloud: 'cloud',
  disk: 'arrow.down.circle',
  plus: 'plus',
  more: 'ellipsis',
  back: 'chevron.left',
  forward: 'chevron.right',
  down: 'chevron.down',
  close: 'xmark',
  check: 'checkmark',
  clock: 'clock',
  grid: 'square.grid.2x2',
  mic: 'music.mic',
  album: 'rectangle.stack',
  guitar: 'guitars',
  playlist: 'music.note.list',
  person: 'person',
  gear: 'gear',
  globe: 'globe',
  metis: 'wand.and.stars',
};

const shortNumber = (text) => text.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 100) / 100));

function convert(name) {
  const source = readFileSync(join(symbols, `${name}.svg`), 'utf8');
  const width = parseFloat(source.match(/width='([\d.]+)px'/)[1]);
  const height = parseFloat(source.match(/height='([\d.]+)px'/)[1]);
  const transform = source.match(/transform='([^']+)'/)[1];
  const paths = [...source.matchAll(/\sd='([^']+)'/g)]
    .map((m) => `<path d="${shortNumber(m[1]).replace(/\s+/g, ' ').trim()}"/>`)
    .join('');
  // Caixa quadrada: cada simbolo tem proporcao propria e o CSS usa 1em por 1em.
  const side = Math.max(width, height);
  const box = [(width - side) / 2, (height - side) / 2, side, side].map((n) => Math.round(n * 100) / 100).join(' ');
  return `<svg viewBox="${box}" aria-hidden="true" focusable="false"><g transform="${shortNumber(transform)}" fill="currentColor" stroke="currentColor" fill-rule="nonzero">${paths}</g></svg>`;
}

const lines = Object.entries(MAP).map(([key, name]) => `  ${key}: \`${convert(name)}\`,`);

writeFileSync(output, `// Gerado por tools/make-icons.mjs a partir dos SF Symbols. Nao editar a mao.

export const icons = {
${lines.join('\n')}
};

// Logo do Synapse.
export const logo = \`${convert('icloud.fill')}\`;
`);
console.log(`${lines.length} icones, ${Math.round(readFileSync(output).length / 1024)} KB`);
