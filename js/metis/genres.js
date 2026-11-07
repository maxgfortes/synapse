export const GENRES = {
  pop:        { label: 'Pop',          v: .68, a: .62, bpm: 116, bass: .55, treble: .55, f: 0 },
  kpop:       { label: 'K-Pop',        v: .72, a: .72, bpm: 124, bass: .55, treble: .62, f: 0 },
  jpop:       { label: 'J-Pop',        v: .70, a: .68, bpm: 128, bass: .48, treble: .62, f: 0 },
  rock:       { label: 'Rock',         v: .52, a: .72, bpm: 124, bass: .55, treble: .60, f: 1 },
  alternative:{ label: 'Alternativa',  v: .46, a: .55, bpm: 118, bass: .48, treble: .52, f: 1 },
  indie:      { label: 'Indie',        v: .50, a: .48, bpm: 114, bass: .42, treble: .50, f: 1 },
  punk:       { label: 'Punk',         v: .52, a: .85, bpm: 165, bass: .50, treble: .68, f: 1 },
  metal:      { label: 'Metal',        v: .32, a: .90, bpm: 140, bass: .62, treble: .72, f: 1 },
  hiphop:     { label: 'Hip-Hop/Rap',  v: .50, a: .62, bpm: 96,  bass: .78, treble: .50, f: 2 },
  trap:       { label: 'Trap',         v: .40, a: .66, bpm: 140, bass: .85, treble: .52, f: 2 },
  phonk:      { label: 'Phonk',        v: .28, a: .78, bpm: 130, bass: .88, treble: .55, f: 2 },
  funkbr:     { label: 'Funk BR',      v: .66, a: .80, bpm: 130, bass: .85, treble: .55, f: 2 },
  rnb:        { label: 'R&B/Soul',     v: .55, a: .42, bpm: 92,  bass: .62, treble: .45, f: 3 },
  soul:       { label: 'Soul',         v: .60, a: .46, bpm: 96,  bass: .55, treble: .46, f: 3 },
  funk:       { label: 'Funk',         v: .74, a: .68, bpm: 110, bass: .68, treble: .52, f: 3 },
  disco:      { label: 'Disco',        v: .80, a: .74, bpm: 120, bass: .62, treble: .58, f: 3 },
  electronic: { label: 'Eletrônica',   v: .58, a: .75, bpm: 126, bass: .72, treble: .62, f: 4 },
  house:      { label: 'House',        v: .66, a: .76, bpm: 124, bass: .74, treble: .60, f: 4 },
  techno:     { label: 'Techno',       v: .42, a: .82, bpm: 132, bass: .76, treble: .60, f: 4 },
  dnb:        { label: 'Drum & Bass',  v: .50, a: .88, bpm: 174, bass: .80, treble: .64, f: 4 },
  idm:        { label: 'IDM',          v: .40, a: .60, bpm: 130, bass: .58, treble: .62, f: 4 },
  ambient:    { label: 'Ambiente',     v: .46, a: .14, bpm: 70,  bass: .35, treble: .38, f: 5 },
  lofi:       { label: 'Lo-fi',        v: .50, a: .24, bpm: 80,  bass: .50, treble: .32, f: 5 },
  newage:     { label: 'New Age',      v: .55, a: .15, bpm: 70,  bass: .30, treble: .42, f: 5 },
  classical:  { label: 'Clássica',     v: .52, a: .28, bpm: 90,  bass: .30, treble: .45, f: 6 },
  soundtrack: { label: 'Trilha Sonora',v: .46, a: .36, bpm: 95,  bass: .38, treble: .46, f: 6 },
  jazz:       { label: 'Jazz',         v: .60, a: .36, bpm: 110, bass: .45, treble: .48, f: 6 },
  blues:      { label: 'Blues',        v: .38, a: .38, bpm: 88,  bass: .48, treble: .44, f: 6 },
  folk:       { label: 'Folk',         v: .52, a: .32, bpm: 104, bass: .32, treble: .46, f: 7 },
  country:    { label: 'Country',      v: .62, a: .48, bpm: 112, bass: .40, treble: .50, f: 7 },
  mpb:        { label: 'MPB',          v: .62, a: .38, bpm: 102, bass: .42, treble: .46, f: 8 },
  bossa:      { label: 'Bossa Nova',   v: .64, a: .26, bpm: 94,  bass: .38, treble: .42, f: 8 },
  samba:      { label: 'Samba',        v: .80, a: .70, bpm: 104, bass: .55, treble: .56, f: 8 },
  pagode:     { label: 'Pagode',       v: .76, a: .58, bpm: 98,  bass: .55, treble: .52, f: 8 },
  sertanejo:  { label: 'Sertanejo',    v: .60, a: .54, bpm: 112, bass: .48, treble: .52, f: 8 },
  forro:      { label: 'Forró',        v: .78, a: .66, bpm: 122, bass: .50, treble: .56, f: 8 },
  axe:        { label: 'Axé',          v: .84, a: .78, bpm: 128, bass: .55, treble: .58, f: 8 },
  latin:      { label: 'Latina',       v: .78, a: .70, bpm: 104, bass: .66, treble: .54, f: 9 },
  reggae:     { label: 'Reggae',       v: .70, a: .40, bpm: 84,  bass: .72, treble: .42, f: 9 },
  gospel:     { label: 'Gospel',       v: .68, a: .44, bpm: 96,  bass: .45, treble: .48, f: 9 },
  other:      { label: 'Outros',       v: .50, a: .50, bpm: 112, bass: .50, treble: .50, f: 10 },
};

export const FAMILY_COUNT = 11;

const RULES = [
  [/\bk-?pop\b/, 'kpop'], [/\bj-?pop\b|anime/, 'jpop'],
  [/phonk/, 'phonk'], [/\btrap\b/, 'trap'],
  [/funk\s*(br|carioca|ostenta|mandel|paulista)|brazilian funk|\bmandelao\b/, 'funkbr'],
  [/hip.?hop|\brap\b|drill|grime/, 'hiphop'],
  [/r&b|r\s*n\s*b|rhythm/, 'rnb'], [/soul/, 'soul'], [/disco/, 'disco'], [/funk/, 'funk'],
  [/drum.*bass|\bdnb\b|jungle/, 'dnb'], [/techno|trance/, 'techno'], [/house/, 'house'],
  [/\bidm\b|glitch|breakcore/, 'idm'],
  [/lo.?fi|chillhop/, 'lofi'], [/ambient|ambiente|drone/, 'ambient'], [/new age/, 'newage'],
  [/electr|eletr|dance|edm|synth/, 'electronic'],
  [/bossa/, 'bossa'], [/\bmpb\b|musica popular brasileira/, 'mpb'],
  [/pagode/, 'pagode'], [/samba/, 'samba'], [/sertanej/, 'sertanejo'],
  [/forro|piseiro|xote/, 'forro'], [/\baxe\b/, 'axe'],
  [/metal|hardcore/, 'metal'], [/punk|emo\b/, 'punk'],
  [/indie/, 'indie'], [/alternativ|grunge|shoegaze/, 'alternative'], [/rock/, 'rock'],
  [/classic|classica|opera|orchest|orquestr/, 'classical'],
  [/soundtrack|trilha|score/, 'soundtrack'],
  [/jazz/, 'jazz'], [/blues/, 'blues'], [/folk|singer.?songwriter|acoustic/, 'folk'],
  [/country/, 'country'], [/reggae|\bdub\b|\bska\b/, 'reggae'],
  [/latin|latina|reggaeton|salsa|bachata|cumbia/, 'latin'],
  [/gospel|christian|crista|worship|religios/, 'gospel'], [/\bpop\b/, 'pop'],
];

export const fold = (text) => String(text || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '');

export function normalizeGenre(raw) {
  const text = fold(raw);
  if (!text) return null;
  for (const [pattern, id] of RULES) if (pattern.test(text)) return id;
  return null;
}

const TITLE_HINTS = [
  [/slowed|reverb/, { a: -.2, v: -.12, bpmScale: .82, bass: .08 }],
  [/sped.?up|nightcore/, { a: .16, v: .08, bpmScale: 1.2 }],
  [/acoustic|acustic|unplugged/, { a: -.2, bass: -.14 }],
  [/lo.?fi/, { a: -.2 }],
  [/\bpiano\b/, { a: -.14, bass: -.1 }],
  [/instrumental/, { a: -.05 }],
  [/remix|bootleg|\bedit\b/, { a: .08 }],
  [/\blive\b|ao vivo/, { a: .04 }],
  [/phonk/, { a: .12, v: -.14, bass: .12 }],
];

export function titleHints(title) {
  const text = fold(title);
  const out = { a: 0, v: 0, bass: 0, bpmScale: 1 };
  for (const [pattern, hint] of TITLE_HINTS) {
    if (!pattern.test(text)) continue;
    out.a += hint.a || 0;
    out.v += hint.v || 0;
    out.bass += hint.bass || 0;
    out.bpmScale *= hint.bpmScale || 1;
  }
  return out;
}
