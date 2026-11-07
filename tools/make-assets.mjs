// Gera o icone do app, os splash do iPhone e a imagem de compartilhamento a
// partir do simbolo icloud.fill, usando o Edge ou o Chrome em modo headless.
// Uso: node tools/make-assets.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const browser = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!browser) throw new Error('Edge ou Chrome nao encontrado.');

const DARK = '#000000';
const LIGHT = '#ffffff';

const source = readFileSync(join(root, 'assets/sfsymbols-svg-1.0/symbols/icloud.fill.svg'), 'utf8');
const width = parseFloat(source.match(/width='([\d.]+)px'/)[1]);
const height = parseFloat(source.match(/height='([\d.]+)px'/)[1]);
const transform = source.match(/transform='([^']+)'/)[1];
const paths = [...source.matchAll(/\sd='([^']+)'/g)].map((m) => `<path d="${m[1].replace(/\s+/g, ' ').trim()}"/>`).join('');
const side = Math.max(width, height);
const box = `${(width - side) / 2} ${(height - side) / 2} ${side} ${side}`;

// Desenha o simbolo em uma caixa quadrada, dentro de qualquer SVG.
const glyph = (color) => `<g transform="${transform}" fill="${color}" stroke="${color}" fill-rule="nonzero">${paths}</g>`;
const mark = (size, color) => `<svg width="${size}" height="${size}" viewBox="${box}">${glyph(color)}</svg>`;

// Icone vetorial monocromatico: nuvem branca em fundo preto.
writeFileSync(join(root, 'assets/icons/icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${DARK}"/><svg x="12.200" y="12.200" width="39.600" height="39.600" viewBox="${box}">${glyph('#ffffff')}</svg></svg>\n`);

const work = mkdtempSync(join(tmpdir(), 'synapse-assets-'));

function shot(name, w, h, body) {
  const page = join(work, 'page.html');
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:"SF Pro";src:url("${pathToFileURL(join(root, 'assets/fonts/SFPro-Regular.woff2')).href}")}
    *{margin:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;overflow:hidden;background:transparent}
    svg{display:block}</style>${body}`);
  const out = join(root, name);
  mkdirSync(join(out, '..'), { recursive: true });
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${w},${h}`,
    `--screenshot=${out}`, pathToFileURL(page).href,
  ], { stdio: 'ignore' });
  console.log(name);
}

const center = 'display:grid;place-items:center';
const rounded = (size) => `<div style="width:${size}px;height:${size}px;border-radius:22%;background:${DARK};${center}">${mark(Math.round(size * 0.62), LIGHT)}</div>`;
const bleed = (size) => `<div style="width:${size}px;height:${size}px;background:${DARK};${center}">${mark(Math.round(size * 0.56), LIGHT)}</div>`;

for (const size of [192, 512]) {
  shot(`assets/icons/icon-${size}.png`, size, size, rounded(size));
  shot(`assets/icons/maskable-${size}.png`, size, size, bleed(size));
}
shot('assets/icons/monochrome-512.png', 512, 512, `<div style="width:512px;height:512px;${center}">${mark(288, LIGHT)}</div>`);
shot('assets/icons/favicon-32.png', 32, 32, rounded(32));
shot('assets/icons/apple-touch-icon.png', 180, 180, bleed(180));

for (const [w, h] of [[1179, 2556], [1290, 2796], [1170, 2532], [1125, 2436], [750, 1334]]) {
  const size = Math.round(w * 0.3);
  shot(`assets/splash/iphone-${w}x${h}.png`, w, h, `<div style="width:${w}px;height:${h}px;background:${DARK};${center}">${mark(size, LIGHT)}</div>`);
}

shot('assets/og-image.png', 1200, 630, `<div style="width:1200px;height:630px;background:${DARK};display:flex;align-items:center;gap:64px;padding:0 96px;font-family:'SF Pro',Arial,sans-serif;color:#f8f9f9">
  <div style="flex:none">${mark(280, LIGHT)}</div>
  <div><div style="font-size:84px;font-weight:700;line-height:1.05">Synapse</div>
  <div style="margin-top:18px;font-size:34px;color:#999;line-height:1.3">A ordem certa para cada momento, aprendida no seu aparelho.</div></div>
</div>`);

rmSync(work, { recursive: true, force: true });
