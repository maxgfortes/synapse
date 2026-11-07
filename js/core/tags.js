const decoders = {
  latin1: new TextDecoder('latin1'),
  utf8: new TextDecoder('utf-8'),
  utf16: new TextDecoder('utf-16'),
  utf16be: new TextDecoder('utf-16be'),
};

const clean = (text) => text.replace(/\0+$/g, '').replace(/\0/g, ' / ').trim();

function ascii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

function id3Text(bytes) {
  const encoding = bytes[0];
  const body = bytes.subarray(1);
  const decoder = [decoders.latin1, decoders.utf16, decoders.utf16be, decoders.utf8][encoding] || decoders.utf8;
  return clean(decoder.decode(body));
}

function id3Picture(bytes, v22) {
  let i = 1;
  let mime = 'image/jpeg';
  if (v22) {
    const format = decoders.latin1.decode(bytes.subarray(1, 4)).toLowerCase();
    mime = format === 'png' ? 'image/png' : 'image/jpeg';
    i = 4;
  } else {
    const end = bytes.indexOf(0, 1);
    mime = decoders.latin1.decode(bytes.subarray(1, end)) || mime;
    i = end + 1;
  }
  i += 1;
  const wide = bytes[0] === 1 || bytes[0] === 2;
  if (wide) {
    while (i + 1 < bytes.length && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < bytes.length && bytes[i] !== 0) i++;
    i += 1;
  }
  return new Blob([bytes.subarray(i)], { type: mime });
}

function unsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[n++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0) i++;
  }
  return out.subarray(0, n);
}

function parseId3(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 10 || ascii(view, 0, 3) !== 'ID3') return null;
  const major = view.getUint8(3);
  const flags = view.getUint8(5);
  const syncsafe = (o) => (view.getUint8(o) << 21) | (view.getUint8(o + 1) << 14) | (view.getUint8(o + 2) << 7) | view.getUint8(o + 3);
  const size = Math.min(syncsafe(6), buffer.byteLength - 10);
  let bytes = new Uint8Array(buffer, 10, size);
  if (flags & 0x80) bytes = unsync(bytes);
  const frames = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = {};
  let o = 0;
  if (flags & 0x40 && major >= 3) o += frames.getUint32(0) + (major === 3 ? 4 : 0);
  const v22 = major === 2;
  const idSize = v22 ? 3 : 4;
  const headerSize = v22 ? 6 : 10;
  const map = {
    TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre', TYER: 'year', TDRC: 'year', TBPM: 'bpm',
    TT2: 'title', TP1: 'artist', TAL: 'album', TCO: 'genre', TYE: 'year', TBP: 'bpm',
  };
  while (o + headerSize < bytes.length) {
    const id = ascii(frames, o, idSize);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let length;
    if (v22) length = (frames.getUint8(o + 3) << 16) | (frames.getUint8(o + 4) << 8) | frames.getUint8(o + 5);
    else if (major === 4) length = (frames.getUint8(o + 4) << 21) | (frames.getUint8(o + 5) << 14) | (frames.getUint8(o + 6) << 7) | frames.getUint8(o + 7);
    else length = frames.getUint32(o + 4);
    if (!length || o + headerSize + length > bytes.length) break;
    const body = bytes.subarray(o + headerSize, o + headerSize + length);
    if (map[id]) tags[map[id]] = id3Text(body);
    else if ((id === 'APIC' || id === 'PIC') && !tags.picture) tags.picture = id3Picture(body, v22);
    o += headerSize + length;
  }

  if (tags.genre && /^\(?\d+\)?$/.test(tags.genre)) delete tags.genre;
  return tags;
}

function parseMp4(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || ascii(view, 4, 4) !== 'ftyp') return null;
  const tags = {};
  const names = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', '©gen': 'genre', '©day': 'year' };
  const containers = new Set(['moov', 'udta', 'ilst']);

  const walk = (start, end) => {
    let o = start;
    while (o + 8 <= end) {
      const size = view.getUint32(o);
      const type = ascii(view, o + 4, 4);
      if (size < 8 || o + size > end) return;
      if (type === 'meta') walk(o + 12, o + size);
      else if (containers.has(type)) walk(o + 8, o + size);
      else if (names[type] || type === 'covr') {
        if (o + 24 <= o + size && ascii(view, o + 12, 4) === 'data') {
          const dataSize = view.getUint32(o + 8);
          const body = new Uint8Array(buffer, o + 24, Math.max(dataSize - 16, 0));
          if (type === 'covr') {
            const png = view.getUint32(o + 16) === 14;
            tags.picture = new Blob([body], { type: png ? 'image/png' : 'image/jpeg' });
          } else {
            tags[names[type]] = clean(decoders.utf8.decode(body));
          }
        }
      }
      o += size;
    }
  };
  walk(0, buffer.byteLength);
  return tags;
}

function parseFlac(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || ascii(view, 0, 4) !== 'fLaC') return null;
  const tags = {};
  let o = 4;
  let last = false;
  while (!last && o + 4 <= buffer.byteLength) {
    const head = view.getUint8(o);
    last = !!(head & 0x80);
    const type = head & 0x7f;
    const length = (view.getUint8(o + 1) << 16) | (view.getUint8(o + 2) << 8) | view.getUint8(o + 3);
    const start = o + 4;
    if (start + length > buffer.byteLength) break;
    if (type === 4) {
      let p = start + 4 + view.getUint32(start, true);
      const count = view.getUint32(p, true);
      p += 4;
      for (let i = 0; i < count; i++) {
        const size = view.getUint32(p, true);
        p += 4;
        const entry = decoders.utf8.decode(new Uint8Array(buffer, p, size));
        p += size;
        const eq = entry.indexOf('=');
        const key = entry.slice(0, eq).toUpperCase();
        const value = entry.slice(eq + 1);
        const field = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', GENRE: 'genre', DATE: 'year', BPM: 'bpm' }[key];
        if (field) tags[field] = value;
      }
    } else if (type === 6) {
      let p = start + 4;
      const mimeLength = view.getUint32(p);
      const mime = decoders.latin1.decode(new Uint8Array(buffer, p + 4, mimeLength));
      p += 4 + mimeLength;
      p += 4 + view.getUint32(p) + 16;
      const size = view.getUint32(p);
      tags.picture = new Blob([new Uint8Array(buffer, p + 4, size)], { type: mime });
    }
    o = start + length;
  }
  return tags;
}

export function parseFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const match = base.match(/^(?:\d{1,3}[\s.\-_]+)?(.+?)\s+[-–—]\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { title: base };
}

export async function readTags(file) {

  const head = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
  let tags = parseId3(head) || parseFlac(head);
  if (!tags) {
    const isMp4 = new DataView(head).byteLength >= 12 && ascii(new DataView(head), 4, 4) === 'ftyp';
    if (isMp4) {
      tags = parseMp4(file.size <= 64 * 1024 * 1024 ? await file.arrayBuffer() : head);
    }
  }
  const fromName = parseFilename(file.name);
  const year = parseInt(tags?.year, 10);
  return {
    title: tags?.title || fromName.title,
    artist: tags?.artist || fromName.artist || 'Artista desconhecido',
    album: tags?.album || '',
    genre: tags?.genre || '',
    year: Number.isFinite(year) ? year : null,
    picture: tags?.picture || null,
  };
}
