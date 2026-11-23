// Tag reader for files Matt already owns. No network. Supports ID3v2.2/2.3/2.4,
// ID3v1, FLAC Vorbis comments + pictures, and MP4/M4A ilst atoms.

const TEXT_DECODER_UTF8 = new TextDecoder('utf-8');

const V22 = {
  TT2: 'TIT2',
  TP1: 'TPE1',
  TP2: 'TPE2',
  TAL: 'TALB',
  TRK: 'TRCK',
  TPA: 'TPOS',
  TYE: 'TYER',
  TCO: 'TCON',
  PIC: 'PIC',
};

const KNOWN = new Set([
  'TIT2', 'TPE1', 'TPE2', 'TALB', 'TRCK', 'TPOS', 'TYER', 'TDRC', 'TDRL',
  'TCON', 'APIC', 'COMM', 'TXXX', 'TCOM', 'TIT1', 'TIT3', 'TLEN', 'TSRC',
  'TPUB', 'TCOP', 'WOAR', 'USLT', 'TALB',
]);

function u32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function u24(b, o) {
  return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
}

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function latin1(bytes) {
  let s = '';
  const n = bytes.length;
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function cleanText(s) {
  return String(s || '').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
}

function decodeBytes(bytes, encoding) {
  if (!bytes || !bytes.length) return '';
  try {
    if (encoding === 0) return latin1(bytes);
    if (encoding === 1) return new TextDecoder('utf-16').decode(bytes);
    if (encoding === 2) return new TextDecoder('utf-16be').decode(bytes);
    return TEXT_DECODER_UTF8.decode(bytes);
  } catch {
    try { return latin1(bytes); } catch { return ''; }
  }
}

function decodeTextFrame(data) {
  if (!data || data.length < 2) return '';
  const encoding = data[0] <= 3 ? data[0] : 3;
  const text = decodeBytes(data.subarray(1), encoding);
  const parts = text.split('\u0000').map(cleanText).filter(Boolean);
  return parts.join(', ');
}

function readTerminated(data, offset, encoding) {
  if (offset >= data.length) return { text: '', offset: data.length };
  if (encoding === 1 || encoding === 2) {
    let i = offset;
    while (i + 1 < data.length) {
      if (data[i] === 0 && data[i + 1] === 0) {
        return { text: cleanText(decodeBytes(data.subarray(offset, i), encoding)), offset: i + 2 };
      }
      i += 2;
    }
    return { text: cleanText(decodeBytes(data.subarray(offset), encoding)), offset: data.length };
  }
  let i = offset;
  while (i < data.length && data[i] !== 0) i++;
  return { text: cleanText(decodeBytes(data.subarray(offset, i), encoding)), offset: Math.min(data.length, i + 1) };
}

function unsyncDecode(bytes) {
  const out = new Uint8Array(bytes.length);
  let w = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out[w++] = b;
    if (b === 0xff && i + 1 < bytes.length) {
      const n = bytes[i + 1];
      if (n >= 0xe0) return bytes;
      if (n === 0x00) i++;
    }
  }
  return out.subarray(0, w);
}

function sniffMime(data, hinted) {
  const h = String(hinted || '').toLowerCase().split(';')[0].trim();
  if (h === 'image/jpg' || h === 'image/jpeg' || h === 'jpg' || h === 'jpeg') return 'image/jpeg';
  if (h === 'image/png' || h === 'png') return 'image/png';
  if (h === 'image/gif' || h === 'gif') return 'image/gif';
  if (h === 'image/webp' || h === 'webp') return 'image/webp';
  if (data && data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data && data.length >= 4 && data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data && data.length >= 3 && data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (h.startsWith('image/')) return h;
  return 'image/jpeg';
}

function parseApic(data) {
  if (!data || data.length < 6) return null;
  const encoding = data[0] <= 3 ? data[0] : 0;
  let o = 1;
  let mimeEnd = o;
  while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
  const mime = latin1(data.subarray(o, mimeEnd));
  o = Math.min(data.length, mimeEnd + 1);
  if (o >= data.length) return null;
  const type = data[o++];
  const desc = readTerminated(data, o, encoding);
  const img = data.subarray(desc.offset);
  if (!img.length) return null;
  return { type, mime: sniffMime(img, mime), data: img };
}

function parsePic22(data) {
  if (!data || data.length < 6) return null;
  const encoding = data[0] <= 3 ? data[0] : 0;
  const fmt = latin1(data.subarray(1, 4)).toUpperCase();
  const type = data[4];
  const desc = readTerminated(data, 5, encoding);
  const img = data.subarray(desc.offset);
  if (!img.length) return null;
  const hinted = fmt === 'PNG' ? 'image/png' : fmt === 'GIF' ? 'image/gif' : 'image/jpeg';
  return { type, mime: sniffMime(img, hinted), data: img };
}

function parseTrackField(s) {
  const m = String(s || '').split(',')[0].trim().match(/^(\d+)\s*(?:\/\s*(\d+))?/);
  if (!m) return { n: 0, total: 0 };
  return { n: Number(m[1]) || 0, total: m[2] ? Number(m[2]) || 0 : 0 };
}

function parseYear(s) {
  const m = String(s || '').match(/(\d{4})/);
  return m ? m[1] : '';
}

function bestPic(pics) {
  if (!pics || !pics.length) return null;
  return pics.find((p) => p.type === 3) || pics.find((p) => p.type === 0) || pics[0];
}

function emptyTags() {
  return {
    title: '', artist: '', album: '', albumArtist: '',
    track: 0, disc: 0, year: '', pictures: [],
  };
}

function looksLikeId(b, o, len) {
  if (o + len > b.length) return false;
  for (let i = 0; i < len; i++) {
    const c = b[o + i];
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
    if (!ok) return false;
  }
  return true;
}

function frameScore(body, useSyncsafe) {
  let p = 0;
  let known = 0;
  let frames = 0;
  while (p + 10 <= body.length) {
    if (body[p] === 0) return { known, frames, end: p, clean: true };
    if (!looksLikeId(body, p, 4)) return { known, frames, end: p, clean: false };
    const size = useSyncsafe ? syncsafe(body, p + 4) : u32(body, p + 4);
    if (!size || p + 10 + size > body.length) return { known, frames, end: p, clean: false };
    const id = fourcc(body, p);
    frames++;
    if (KNOWN.has(id)) known++;
    p += 10 + size;
  }
  return { known, frames, end: p, clean: p >= body.length - 1 };
}

function preferSyncsafe(body) {
  const a = frameScore(body, true);
  const b = frameScore(body, false);
  const score = (s) => s.known * 10 + s.frames + (s.clean ? 3 : 0);
  return score(a) >= score(b);
}

function applyText(out, id, text) {
  if (!text) return;
  if (id === 'TIT2' && !out.title) out.title = text;
  else if (id === 'TPE1' && !out.artist) out.artist = text;
  else if (id === 'TPE2' && !out.albumArtist) out.albumArtist = text;
  else if (id === 'TALB' && !out.album) out.album = text;
  else if (id === 'TRCK' && !out.track) out.track = parseTrackField(text).n;
  else if (id === 'TPOS' && !out.disc) out.disc = parseTrackField(text).n;
  else if ((id === 'TYER' || id === 'TDRC' || id === 'TDRL') && !out.year) out.year = parseYear(text);
}

/**
 * Parse an ID3v2 tag sitting at the start of `bytes`.
 * Returns null when the buffer is not an ID3 tag.
 */
export function parseId3(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  const ver = bytes[3];
  if (ver < 2 || ver > 4) return null;
  const flags = bytes[5];
  const tagSize = syncsafe(bytes, 6);
  let offset = 10;
  const end = Math.min(bytes.length, 10 + tagSize);
  if (end < 10) return null;

  if (flags & 0x40) {
    const v22 = ver === 2;
    const idLen = v22 ? 3 : 4;
    if (!looksLikeId(bytes, offset, idLen)) {
      if (ver >= 4) {
        const ext = syncsafe(bytes, offset);
        if (ext >= 6) offset += ext;
      } else if (offset + 4 <= end) {
        const ext = u32(bytes, offset);
        offset += 4 + ext;
      }
    }
  }
  if (offset > end) return null;

  let body = bytes.subarray(offset, end);
  if ((flags & 0x80) && ver < 4) body = unsyncDecode(body);

  const out = emptyTags();
  const v22 = ver === 2;

  if (v22) {
    let p = 0;
    while (p + 6 <= body.length) {
      if (body[p] === 0) break;
      if (!looksLikeId(body, p, 3)) break;
      const id = String.fromCharCode(body[p], body[p + 1], body[p + 2]);
      const size = u24(body, p + 3);
      p += 6;
      if (!size || p + size > body.length) break;
      const data = body.subarray(p, p + size);
      p += size;
      if (id === 'PIC') {
        const pic = parsePic22(data);
        if (pic) out.pictures.push(pic);
      } else {
        const mapped = V22[id];
        if (mapped && mapped !== 'PIC') applyText(out, mapped, decodeTextFrame(data));
      }
    }
  } else {
    const useSync = ver >= 4 ? preferSyncsafe(body) : false;
    let p = 0;
    while (p + 10 <= body.length) {
      if (body[p] === 0) break;
      if (!looksLikeId(body, p, 4)) break;
      const id = fourcc(body, p);
      const size = useSync ? syncsafe(body, p + 4) : u32(body, p + 4);
      const frameFlags = (body[p + 8] << 8) | body[p + 9];
      p += 10;
      if (!size || p + size > body.length) break;
      let data = body.subarray(p, p + size);
      p += size;

      if (ver >= 4) {
        const format = frameFlags & 0xff;
        if (format & 0x40 && data.length) data = data.subarray(1);
        if ((format & 0x08) || (format & 0x04)) continue;
        if (format & 0x01 && data.length >= 4) data = data.subarray(4);
        if ((format & 0x02) || (flags & 0x80)) data = unsyncDecode(data);
      } else {
        const format = frameFlags & 0xff;
        if (format & 0x80 || format & 0x40) continue;
        if (format & 0x20 && data.length) data = data.subarray(1);
      }

      if (id === 'APIC') {
        const pic = parseApic(data);
        if (pic) out.pictures.push(pic);
      } else {
        applyText(out, id, decodeTextFrame(data));
      }
    }
  }

  if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
  out.art = bestPic(out.pictures);
  return out;
}

export function parseId3v1(bytes) {
  if (!bytes || bytes.length < 128) return null;
  const b = bytes.subarray(bytes.length - 128);
  if (b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return null;
  const cut = (o, n) => latin1(b.subarray(o, o + n)).replace(/\u0000[\s\S]*$/, '').trim();
  let track = 0;
  if (b[125] === 0 && b[126] !== 0) track = b[126];
  return {
    title: cut(3, 30),
    artist: cut(33, 30),
    album: cut(63, 30),
    year: cut(93, 4),
    track,
  };
}

function parseVorbis(data) {
  if (data.length < 8) return {};
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  const vendorLen = view.getUint32(o, true);
  o += 4 + vendorLen;
  if (o + 4 > data.length) return {};
  const count = view.getUint32(o, true);
  o += 4;
  const map = {};
  for (let i = 0; i < count && o + 4 <= data.length; i++) {
    const len = view.getUint32(o, true);
    o += 4;
    if (o + len > data.length) break;
    const s = TEXT_DECODER_UTF8.decode(data.subarray(o, o + len));
    o += len;
    const eq = s.indexOf('=');
    if (eq > 0) {
      const k = s.slice(0, eq).toLowerCase();
      const v = s.slice(eq + 1).trim();
      if (v && !map[k]) map[k] = v;
    }
  }
  return {
    title: map.title || '',
    artist: map.artist || '',
    album: map.album || '',
    albumArtist: map.albumartist || '',
    track: Number.parseInt(map.tracknumber || '0', 10) || 0,
    disc: Number.parseInt(map.discnumber || '0', 10) || 0,
    year: parseYear(map.date || map.year || ''),
  };
}

function parseFlacPic(data) {
  if (data.length < 32) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  const type = view.getUint32(o); o += 4;
  const mimeLen = view.getUint32(o); o += 4;
  if (o + mimeLen + 4 > data.length) return null;
  const mime = latin1(data.subarray(o, o + mimeLen)); o += mimeLen;
  const descLen = view.getUint32(o); o += 4 + descLen + 16;
  if (o + 4 > data.length) return null;
  const dataLen = view.getUint32(o); o += 4;
  if (o + dataLen > data.length) return null;
  const img = data.subarray(o, o + dataLen);
  return { type, mime: sniffMime(img, mime), data: img };
}

async function parseFlac(file) {
  let offset = 4;
  const out = emptyTags();
  const cap = Math.min(file.size, 24 * 1024 * 1024);
  while (offset + 4 <= cap) {
    const hdr = await readRange(file, offset, 4);
    if (hdr.length < 4) break;
    const last = hdr[0] & 0x80;
    const type = hdr[0] & 0x7f;
    const size = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    offset += 4;
    if (size <= 0) break;
    if (type === 4 || type === 6) {
      const data = await readRange(file, offset, size);
      if (type === 4) {
        const v = parseVorbis(data);
        if (v.title && !out.title) out.title = v.title;
        if (v.artist && !out.artist) out.artist = v.artist;
        if (v.album && !out.album) out.album = v.album;
        if (v.albumArtist && !out.albumArtist) out.albumArtist = v.albumArtist;
        if (v.track && !out.track) out.track = v.track;
        if (v.disc && !out.disc) out.disc = v.disc;
        if (v.year && !out.year) out.year = v.year;
      } else {
        const pic = parseFlacPic(data);
        if (pic) out.pictures.push(pic);
      }
    }
    offset += size;
    if (last || type === 0) {
      if (type !== 4 && type !== 6 && last) break;
      if (last) break;
    }
    if (type > 6 && type !== 127) {
      // STREAMINFO is 0; keep walking until the last-metadata flag.
    }
  }
  if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
  out.art = bestPic(out.pictures);
  return out;
}

async function findChild(file, start, end, type) {
  let off = start;
  const limit = Math.min(end, start + 64 * 1024 * 1024);
  while (off + 8 <= end && off < limit) {
    const hdr = await readRange(file, off, 16);
    if (hdr.length < 8) break;
    let size = u32(hdr, 0);
    const typ = fourcc(hdr, 4);
    let header = 8;
    if (size === 1) {
      if (hdr.length < 16) break;
      size = u32(hdr, 8) * 4294967296 + u32(hdr, 12);
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (!Number.isFinite(size) || size < header) break;
    if (typ === type) {
      return { start: off + header, end: Math.min(off + size, end) };
    }
    off += size;
  }
  return null;
}

function dataAtoms(body) {
  const out = [];
  let o = 0;
  while (o + 8 <= body.length) {
    const size = u32(body, o);
    if (size < 8 || o + size > body.length) break;
    if (fourcc(body, o + 4) === 'data' && size >= 16) {
      out.push({ indicator: u32(body, o + 8), bytes: body.subarray(o + 16, o + size) });
    }
    o += size;
  }
  return out;
}

function parseIlst(data) {
  const out = emptyTags();
  const C = String.fromCharCode(169);
  const textKeys = {
    [`${C}nam`]: 'title',
    [`${C}ART`]: 'artist',
    [`${C}alb`]: 'album',
    aART: 'albumArtist',
    [`${C}day`]: 'year',
  };
  let o = 0;
  while (o + 8 <= data.length) {
    const size = u32(data, o);
    if (size < 8 || o + size > data.length) break;
    const typ = fourcc(data, o + 4);
    const body = data.subarray(o + 8, o + size);
    const atoms = dataAtoms(body);
    if (typ === 'covr') {
      for (const atom of atoms) {
        const mime = atom.indicator === 14 ? 'image/png' : 'image/jpeg';
        if (atom.bytes.length) out.pictures.push({ type: 3, mime: sniffMime(atom.bytes, mime), data: atom.bytes });
      }
    } else if ((typ === 'trkn' || typ === 'disk') && atoms[0] && atoms[0].bytes.length >= 4) {
      const n = (atoms[0].bytes[2] << 8) | atoms[0].bytes[3];
      if (typ === 'trkn' && !out.track) out.track = n;
      if (typ === 'disk' && !out.disc) out.disc = n;
    } else if (textKeys[typ] && atoms[0]) {
      const text = cleanText(TEXT_DECODER_UTF8.decode(atoms[0].bytes));
      const field = textKeys[typ];
      if (text && !out[field]) {
        out[field] = field === 'year' ? parseYear(text) : text;
      }
    }
    o += size;
  }
  if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
  out.art = bestPic(out.pictures);
  return out;
}

async function parseMp4(file) {
  const moov = await findChild(file, 0, file.size, 'moov');
  if (!moov) return null;
  const udta = await findChild(file, moov.start, moov.end, 'udta');
  const searchFrom = udta || moov;
  const meta = await findChild(file, searchFrom.start, searchFrom.end, 'meta');
  if (!meta) return null;
  const ilst = await findChild(file, meta.start + 4, meta.end, 'ilst');
  if (!ilst) return null;
  const data = await readRange(file, ilst.start, ilst.end - ilst.start);
  return parseIlst(data);
}

async function readRange(file, offset, length) {
  if (length <= 0 || offset >= file.size) return new Uint8Array();
  const end = Math.min(file.size, offset + length);
  const buf = await file.slice(offset, end).arrayBuffer();
  return new Uint8Array(buf);
}

export function titleFromFilename(name) {
  let base = String(name || 'Unknown').replace(/\.[^.]+$/, '');
  base = base.replace(/^\d{1,3}\s*[-._)]\s*/, '');
  base = base.replace(/[_]+/g, ' ').trim();
  return base || 'Unknown';
}

function filenameHints(file) {
  const base = String(file.name || '').replace(/\.[^.]+$/, '');
  const m = base.match(/^(?:\d{1,3}\s*[-._)]\s*)?(.+?)\s+-\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: titleFromFilename(file.name || '') };
}

function folderAlbum(file) {
  const rel = file.webkitRelativePath || '';
  const parts = rel.split('/').filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return '';
}

/**
 * Read tags from a File/Blob. Always returns a displayable title.
 * `art` is `{ mime, data: Uint8Array }` or null.
 */
export async function readMetadata(file) {
  const hints = filenameHints(file);
  const meta = {
    title: hints.title,
    artist: hints.artist,
    album: '',
    albumArtist: '',
    track: 0,
    disc: 0,
    year: '',
    art: null,
    hadTitle: false,
    hadArtist: !!hints.artist,
    hadAlbum: false,
  };

  const take = (parsed) => {
    if (!parsed) return;
    if (parsed.title) { meta.title = parsed.title; meta.hadTitle = true; }
    if (parsed.artist) { meta.artist = parsed.artist; meta.hadArtist = true; }
    if (parsed.album) { meta.album = parsed.album; meta.hadAlbum = true; }
    if (parsed.albumArtist) meta.albumArtist = parsed.albumArtist;
    if (parsed.track) meta.track = parsed.track;
    if (parsed.disc) meta.disc = parsed.disc;
    if (parsed.year) meta.year = parsed.year;
    if (parsed.art && parsed.art.data && parsed.art.data.length) meta.art = parsed.art;
  };

  try {
    const head = await readRange(file, 0, 12);
    if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const size = syncsafe(head, 6);
      const len = Math.min(file.size, 10 + Math.min(size, 20 * 1024 * 1024));
      const buf = await readRange(file, 0, len);
      take(parseId3(buf));
    } else if (head.length >= 4 && fourcc(head, 0) === 'fLaC') {
      take(await parseFlac(file));
    } else if (head.length >= 8 && fourcc(head, 4) === 'ftyp') {
      take(await parseMp4(file));
    }
    if (!meta.hadTitle || !meta.hadArtist || !meta.hadAlbum) {
      if (file.size >= 128) {
        const tail = await readRange(file, Math.max(0, file.size - 128), 128);
        const v1 = parseId3v1(tail);
        if (v1) {
          if (v1.title && !meta.hadTitle) { meta.title = v1.title; meta.hadTitle = true; }
          if (v1.artist && !meta.hadArtist) { meta.artist = v1.artist; meta.hadArtist = true; }
          if (v1.album && !meta.hadAlbum) { meta.album = v1.album; meta.hadAlbum = true; }
          if (v1.year && !meta.year) meta.year = v1.year;
          if (v1.track && !meta.track) meta.track = v1.track;
        }
      }
    }
  } catch (err) {
    console.warn('tag read failed', file && file.name, err);
  }

  if (!meta.hadAlbum) {
    const folder = folderAlbum(file);
    if (folder) { meta.album = folder; meta.hadAlbum = true; }
  }
  if (!meta.title) meta.title = titleFromFilename(file.name || 'Unknown');
  if (!meta.artist) meta.artist = 'Unknown artist';
  if (!meta.album) meta.album = 'Unknown album';
  return meta;
}
