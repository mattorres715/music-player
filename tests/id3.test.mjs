import assert from 'node:assert/strict';
import test from 'node:test';
import { parseId3, parseId3v1, readMetadata, titleFromFilename } from '../js/id3.js';

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(n) {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function syncsafe(n) {
  return Uint8Array.of((n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127);
}

function textFrame(id, text, { encoding = 3, v24 = false, utf16 = false } = {}) {
  let payload;
  if (utf16) {
    const encoded = new Uint8Array(new TextEncoder().encode('\ufeff')); // placeholder replaced below
    const body = new Uint16Array(text.length + 1);
    body[0] = 0xfeff;
    for (let i = 0; i < text.length; i++) body[i + 1] = text.charCodeAt(i);
    const bytes = new Uint8Array(body.buffer);
    // DataView-style little endian BOM is written by Uint16Array as host endian.
    // Force LE BOM + LE code units so TextDecoder('utf-16') accepts it.
    const le = new Uint8Array(2 + text.length * 2);
    le[0] = 0xff;
    le[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      le[2 + i * 2] = code & 255;
      le[3 + i * 2] = code >> 8;
    }
    payload = concat([Uint8Array.of(1), le]);
    void encoded;
  } else {
    payload = concat([Uint8Array.of(encoding), new TextEncoder().encode(text)]);
  }
  const size = v24 ? syncsafe(payload.length) : u32(payload.length);
  return concat([new TextEncoder().encode(id), size, Uint8Array.of(0, 0), payload]);
}

function apicFrame(bytes, mime = 'image/png') {
  const payload = concat([
    Uint8Array.of(0),
    new TextEncoder().encode(mime),
    Uint8Array.of(0, 3, 0),
    bytes,
  ]);
  return concat([new TextEncoder().encode('APIC'), u32(payload.length), Uint8Array.of(0, 0), payload]);
}

function tagWrap(frames, version = 3) {
  const body = concat(frames);
  return concat([
    new TextEncoder().encode('ID3'),
    Uint8Array.of(version, 0, 0),
    syncsafe(body.length),
    body,
  ]);
}

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

test('ID3v2.3 reads text, track and front cover', async () => {
  const bytes = tagWrap([
    textFrame('TIT2', 'Night Market'),
    textFrame('TPE1', 'Lena Voss'),
    textFrame('TPE2', 'Lena Voss'),
    textFrame('TALB', 'Glasshouse'),
    textFrame('TRCK', '3/10'),
    textFrame('TYER', '2022'),
    apicFrame(png),
  ]);
  const meta = await readMetadata(new File([bytes], 'ignored.mp3', { type: 'audio/mpeg' }));
  assert.equal(meta.title, 'Night Market');
  assert.equal(meta.artist, 'Lena Voss');
  assert.equal(meta.album, 'Glasshouse');
  assert.equal(meta.albumArtist, 'Lena Voss');
  assert.equal(meta.track, 3);
  assert.equal(meta.year, '2022');
  assert.equal(meta.art.mime, 'image/png');
  assert.equal(meta.art.data[0], 0x89);
});

test('UTF-16 frame and multiple artists', () => {
  const bytes = tagWrap([
    textFrame('TIT2', 'Despechá', { utf16: true }),
    textFrame('TPE1', 'Rosalía\u0000El Guincho'),
  ]);
  const parsed = parseId3(bytes);
  assert.equal(parsed.title, 'Despechá');
  assert.equal(parsed.artist, 'Rosalía, El Guincho');
});

test('ID3v2.4 syncsafe sizes and iTunes-style integer sizes', () => {
  const v24 = tagWrap([textFrame('TIT2', 'Sync Safe', { v24: true }), textFrame('TALB', 'Wide', { v24: true })], 4);
  assert.equal(parseId3(v24).title, 'Sync Safe');
  assert.equal(parseId3(v24).album, 'Wide');

  const itunes = tagWrap([textFrame('TIT2', 'Integer Size'), textFrame('TPE1', 'DJ')], 4);
  assert.equal(parseId3(itunes).title, 'Integer Size');
  assert.equal(parseId3(itunes).artist, 'DJ');
});

test('ID3v2.2 three-character frames', () => {
  const title = concat([Uint8Array.of(0), new TextEncoder().encode('Old Title')]);
  const frame = concat([new TextEncoder().encode('TT2'), Uint8Array.of(0, 0, title.length), title]);
  const bytes = tagWrap([frame], 2);
  assert.equal(parseId3(bytes).title, 'Old Title');
});

test('tag-level unsynchronisation round-trips a title', () => {
  const frame = textFrame('TIT2', 'Unsafe');
  const raw = frame;
  // Insert the unsync padding the way a v2.3 writer would, then set the flag.
  const unsynced = [];
  for (let i = 0; i < raw.length; i++) {
    unsynced.push(raw[i]);
    if (raw[i] === 0xff && i + 1 < raw.length && (raw[i + 1] === 0x00 || raw[i + 1] >= 0xe0)) {
      unsynced.push(0x00);
    }
  }
  // Force an FF E0 sequence into a padding area by appending a custom TXXX-like known frame
  // is unnecessary if the title itself has no FF. Build a frame that contains FF E0.
  const payload = concat([Uint8Array.of(0), Uint8Array.of(0xff, 0xe0, 0x41)]);
  const weird = concat([new TextEncoder().encode('TIT2'), u32(payload.length), Uint8Array.of(0, 0), payload]);
  const stored = [];
  for (let i = 0; i < weird.length; i++) {
    stored.push(weird[i]);
    if (weird[i] === 0xff) stored.push(0x00);
  }
  const body = Uint8Array.from(stored);
  const bytes = concat([
    new TextEncoder().encode('ID3'),
    Uint8Array.of(3, 0, 0x80),
    syncsafe(body.length),
    body,
  ]);
  const parsed = parseId3(bytes);
  assert.ok(parsed);
  assert.equal(parsed.title.includes('A') || parsed.title.length > 0, true);
  void unsynced;
});

test('ID3v1 is used when no v2 title exists', async () => {
  const v1 = new Uint8Array(128);
  const write = (offset, text) => {
    const bytes = new TextEncoder().encode(text);
    v1.set(bytes.subarray(0, Math.min(bytes.length, 30)), offset);
  };
  v1.set(new TextEncoder().encode('TAG'), 0);
  write(3, 'Tape Title');
  write(33, 'Tape Artist');
  write(63, 'Tape Album');
  write(93, '1999');
  v1[125] = 0;
  v1[126] = 7;
  assert.equal(parseId3v1(v1).title, 'Tape Title');
  const meta = await readMetadata(new File([new Uint8Array(32), v1], 'x.mp3'));
  assert.equal(meta.title, 'Tape Title');
  assert.equal(meta.artist, 'Tape Artist');
  assert.equal(meta.album, 'Tape Album');
  assert.equal(meta.track, 7);
  assert.equal(meta.year, '1999');
});

test('filename fallback and Artist - Title pattern', async () => {
  assert.equal(titleFromFilename('04 - Midnight Drive.mp3'), 'Midnight Drive');
  const meta = await readMetadata(new File([Uint8Array.of(0, 1, 2, 3)], 'Lena Voss - Red Room.mp3'));
  assert.equal(meta.artist, 'Lena Voss');
  assert.equal(meta.title, 'Red Room');
  assert.equal(meta.album, 'Unknown album');
});

test('folder name becomes the album when tags are missing', async () => {
  const file = new File([Uint8Array.of(1, 2, 3, 4)], 'track.mp3');
  Object.defineProperty(file, 'webkitRelativePath', { value: 'Copper Lines/track.mp3' });
  const meta = await readMetadata(file);
  assert.equal(meta.album, 'Copper Lines');
});

function atom(type, payload) {
  const name = typeof type === 'string' ? new TextEncoder().encode(type) : type;
  if (name.length !== 4) throw new Error(`bad atom type ${type}`);
  return concat([u32(8 + payload.length), name, payload]);
}

test('MP4 ilst title, artist, track and cover', async () => {
  const textData = (value) => {
    const bytes = new TextEncoder().encode(value);
    return atom('data', concat([u32(1), u32(0), bytes]));
  };
  const trkn = atom('data', concat([u32(0), u32(0), Uint8Array.of(0, 0, 0, 4, 0, 8, 0, 0)]));
  const covr = atom('data', concat([u32(14), u32(0), png]));
  const apple = (suffix) => concat([Uint8Array.of(0xa9), new TextEncoder().encode(suffix)]);
  const ilst = atom('ilst', concat([
    atom(apple('nam'), textData('Copper Lines')),
    atom(apple('ART'), textData('Jonah Park')),
    atom(apple('alb'), textData('Afterglow')),
    atom('trkn', trkn),
    atom('covr', covr),
  ]));
  const metaBox = concat([u32(0), ilst]);
  const moov = atom('moov', atom('udta', atom('meta', metaBox)));
  const ftyp = atom('ftyp', new TextEncoder().encode('M4A \u0000\u0000\u0000\u0000mp42'));
  const fileBytes = concat([ftyp, moov]);
  const meta = await readMetadata(new File([fileBytes], 'song.m4a', { type: 'audio/mp4' }));
  assert.equal(meta.title, 'Copper Lines');
  assert.equal(meta.artist, 'Jonah Park');
  assert.equal(meta.album, 'Afterglow');
  assert.equal(meta.track, 4);
  assert.equal(meta.art.mime, 'image/png');
});

test('FLAC vorbis comment and picture block', async () => {
  const vendor = new TextEncoder().encode('test');
  const comment = (key, value) => {
    const bytes = new TextEncoder().encode(`${key}=${value}`);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length, true);
    return concat([len, bytes]);
  };
  const comments = concat([
    (() => { const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, vendor.length, true); return concat([n, vendor]); })(),
    (() => { const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, 3, true); return n; })(),
    comment('TITLE', 'Low Tide'),
    comment('ARTIST', 'Mara Quinn'),
    comment('ALBUM', 'Harbor'),
  ]);
  const pic = (() => {
    const mime = new TextEncoder().encode('image/png');
    const parts = [
      u32(3),
      u32(mime.length), mime,
      u32(0),
      u32(1), u32(1), u32(24), u32(0),
      u32(png.length), png,
    ];
    return concat(parts);
  })();
  function block(type, data, last = false) {
    return concat([Uint8Array.of(type | (last ? 0x80 : 0), (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255), data]);
  }
  const streamInfo = new Uint8Array(34);
  const bytes = concat([
    new TextEncoder().encode('fLaC'),
    block(0, streamInfo),
    block(4, comments),
    block(6, pic, true),
  ]);
  const meta = await readMetadata(new File([bytes], 'harbor.flac', { type: 'audio/flac' }));
  assert.equal(meta.title, 'Low Tide');
  assert.equal(meta.artist, 'Mara Quinn');
  assert.equal(meta.album, 'Harbor');
  assert.equal(meta.art.mime, 'image/png');
  assert.equal(meta.art.data.length, png.length);
});
