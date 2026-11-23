import { APP_VERSION } from './version.js';
import { readMetadata } from './id3.js';
import * as db from './db.js';
import { albumKeyOf, buildIndex, fileIdentity, isAudioFile, norm, searchLibrary } from './library.js';
import { createPlayer } from './player.js';
import { createVirtual } from './virtual.js';

const $ = (id) => document.getElementById(id);
const main = $('main');
const sticky = $('sticky');
const view = $('view');
const audio = $('player-audio');
const fileInput = $('file-input');
const dirInput = $('dir-input');

const S = {
  view: { name: 'home' },
  stack: [],
  tab: 'home',
  chip: 'songs',
  query: '',
  songSort: 'title',
  npOpen: false,
  virtual: null,
  storage: { usage: 0, quota: 0 },
  persisted: false,
  cancelImport: false,
};

let songs = [];
let playlists = [];
let index = buildIndex([]);
let fileKeys = new Set();
let artKeySet = new Set();
let player = null;
let importing = false;
let picksCache = null;
let picksStamp = -1;
let queueVirtual = null;
let wide = window.matchMedia('(min-width: 720px)').matches;
const artUrls = new Map();
const artInflight = new Map();
const glowCache = new Map();
let pinnedKey = '';

const ic = (id, cls = 'ic') => `<svg class="${cls}" width="24" height="24" aria-hidden="true"><use href="#${id}"></use></svg>`;
const eqHtml = () => '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (h) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const digits = v >= 10 || i === 0 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function hue(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function artHtml(artKey, seed, cls) {
  const h = hue(seed || artKey || 'music');
  const note = '<svg class="ph-note" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-note"></use></svg>';
  if (!artKey) return `<div class="ph ${cls}" style="--h:${h}">${note}</div>`;
  return `<div class="ph ${cls}" style="--h:${h}">${note}<img alt="" decoding="async" draggable="false" data-art="${esc(artKey)}"></div>`;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function reindex() {
  index = buildIndex(songs);
  fileKeys = new Set(songs.map((s) => s.fileKey).filter(Boolean));
  artKeySet = new Set(songs.map((s) => s.artKey).filter(Boolean));
}

function quickPicks() {
  if (!picksCache || picksStamp !== songs.length) {
    const copy = songs.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    picksCache = copy.slice(0, 12);
    picksStamp = songs.length;
  }
  return picksCache;
}

function sortedSongs() {
  const list = songs.slice();
  if (S.songSort === 'recent') list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  else if (S.songSort === 'artist') {
    list.sort((a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base', numeric: true })
      || a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
  } else {
    list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
      || a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base', numeric: true }));
  }
  return list;
}

function contextIds() {
  const v = S.view;
  if (v.name === 'album') return index.albums.get(v.key)?.songIds?.slice() || [];
  if (v.name === 'artist') return index.artists.get(v.id)?.songIds?.slice() || [];
  if (v.name === 'playlist') {
    const pl = playlists.find((p) => p.id === v.id);
    return pl ? pl.songIds.filter((id) => index.byId.has(id)) : [];
  }
  if (v.name === 'explore') return searchLibrary(index, S.query).songs.map((s) => s.id);
  if (v.name === 'library' && S.chip === 'songs') return sortedSongs().map((s) => s.id);
  if (v.name === 'home') return index.recent.map((s) => s.id);
  return songs.map((s) => s.id);
}

function isLiked(id) {
  const pl = playlists.find((p) => p.id === 'liked');
  return !!pl && pl.songIds.includes(id);
}

function urlInUse(url) {
  return !!document.querySelector(`img[src="${url}"]`);
}

function trimArt() {
  if (artUrls.size <= 160) return;
  for (const key of [...artUrls.keys()]) {
    if (artUrls.size <= 160) break;
    if (key === pinnedKey) continue;
    const url = artUrls.get(key);
    if (urlInUse(url)) continue;
    URL.revokeObjectURL(url);
    artUrls.delete(key);
  }
}

async function artURL(key) {
  if (!key) return null;
  if (artUrls.has(key)) {
    const url = artUrls.get(key);
    artUrls.delete(key);
    artUrls.set(key, url);
    return url;
  }
  if (artInflight.has(key)) return artInflight.get(key);
  const job = (async () => {
    const rec = await db.getArt(key);
    if (!rec?.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    artUrls.set(key, url);
    trimArt();
    return url;
  })();
  artInflight.set(key, job);
  try { return await job; } finally { artInflight.delete(key); }
}

async function fillArt(img) {
  const key = img.dataset.art;
  if (!key || img.dataset.got === '1') return;
  img.dataset.got = '1';
  const url = await artURL(key);
  if (!url || !img.isConnected || img.dataset.art !== key) return;
  img.src = url;
  img.parentElement?.classList.add('has-art');
}

const artObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    artObserver.unobserve(entry.target);
    fillArt(entry.target);
  }
}, { root: null, rootMargin: '280px' });

function hydrate(root) {
  if (!root) return;
  root.querySelectorAll('img[data-art]').forEach((img) => {
    if (img.dataset.got === '1') return;
    const rect = img.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    if (rect.bottom > -240 && rect.top < vh + 240) fillArt(img);
    else artObserver.observe(img);
  });
}

function songRow(song, opts = {}) {
  if (!song) return '';
  const on = song.id === player?.currentId ? ' on' : '';
  const ctx = opts.ctx ? ` data-ctx="${esc(opts.ctx)}"` : '';
  const visual = opts.track
    ? `<span class="trk"><span class="num">${song.track ? esc(String(song.track)) : '–'}</span>${eqHtml()}</span>`
    : `<span class="visual">${artHtml(song.artKey, song.album || song.title, 'thumb')}${eqHtml()}</span>`;
  const sub = opts.track && song.artist ? esc(song.artist) : esc(song.artist || '');
  const dur = opts.duration ? `<span class="dur">${song.duration ? fmt(song.duration) : ''}</span>` : '';
  return `<div class="song${on}" data-song="${song.id}">
    <button class="song-main" data-act="play-song" data-id="${song.id}"${ctx}>
      ${visual}
      <span class="meta"><span class="t">${esc(song.title)}</span>${sub ? `<span class="s">${sub}</span>` : ''}</span>
    </button>
    ${dur}
    <button class="icon-btn" data-act="song-menu" data-id="${song.id}" aria-label="More options for ${esc(song.title)}">${ic('i-more')}</button>
  </div>`;
}

function albumCard(album) {
  return `<button class="acard" data-act="open-album" data-key="${encodeURIComponent(album.key)}">
    ${artHtml(album.artKey, album.name, 'cover')}
    <span class="t clamp2">${esc(album.name)}</span>
    <span class="s clamp1">${esc(album.artist)}</span>
  </button>`;
}

function artistCard(artist) {
  return `<button class="acard artist" data-act="open-artist" data-artist="${encodeURIComponent(artist.id)}">
    ${artHtml(artist.artKey, artist.name, 'cover round')}
    <span class="t clamp2 center">${esc(artist.name)}</span>
  </button>`;
}

function songCard(song, ctx) {
  return `<button class="acard" data-act="play-song" data-id="${song.id}" data-ctx="${esc(ctx)}">
    ${artHtml(song.artKey, song.album || song.title, 'cover')}
    <span class="t clamp2">${esc(song.title)}</span>
    <span class="s clamp1">${esc(song.artist)}</span>
  </button>`;
}

function destroyVirtual() {
  if (S.virtual) {
    S.virtual.destroy();
    S.virtual = null;
  }
}

function mountList(list, opts) {
  const host = $('vhost');
  if (!list.length) {
    host.innerHTML = `<div class="empty small"><p>${opts.empty || 'Nothing here yet.'}</p></div>`;
    host.style.height = 'auto';
    return;
  }
  S.virtual = createVirtual({
    scrollEl: main,
    host,
    getMetrics: () => {
      const w = host.clientWidth || main.clientWidth || 360;
      const cols = opts.cols ? opts.cols(w) : 1;
      const rowHeight = opts.rowHeight ? opts.rowHeight(w, cols) : 64;
      return {
        count: list.length,
        cols,
        rowHeight,
        stamp: `${list.length}:${cols}:${Math.round(rowHeight)}`,
        onPaint: hydrate,
      };
    },
    renderItem: (i) => opts.render(list[i], i),
  });
}

function gridMetrics(lines) {
  return (w, cols) => {
    const gap = 12;
    const pad = 32;
    const art = Math.max(96, (w - pad - gap * (cols - 1)) / cols);
    return Math.round(art + (lines === 1 ? 48 : 82));
  };
}

function showView({ scroll = true } = {}) {
  destroyVirtual();
  renderSticky();
  renderBody();
  if (scroll) main.scrollTop = 0;
  paintTabs();
}

function renderSticky() {
  const v = S.view;
  if (v.name === 'home') {
    sticky.innerHTML = `<div class="top"><div class="brand"><span class="brand-mark">${ic('i-note', 'ic sm')}</span> Music</div>
      <button class="icon-btn" data-act="add" aria-label="Add music">${ic('i-add')}</button></div>`;
    return;
  }
  if (v.name === 'explore') {
    sticky.innerHTML = `<div class="top search-top"><label class="search">${ic('i-search', 'ic search-ic')}
      <input id="q" type="search" placeholder="Search songs, albums, artists" autocomplete="off" enterkeyhint="search" value="${esc(S.query)}" aria-label="Search"></label></div>`;
    const input = $('q');
    input.addEventListener('input', () => {
      S.query = input.value;
      renderBody();
    });
    return;
  }
  if (v.name === 'library') {
    const chips = [['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists']];
    sticky.innerHTML = `<div class="top"><h1>Library</h1><div class="top-actions">
        <button class="pill solid sm" data-act="add">Add music</button>
        <button class="icon-btn" data-act="settings" aria-label="Settings">${ic('i-gear')}</button>
      </div></div>
      <div class="chips">${chips.map(([id, label]) => `<button class="chip${S.chip === id ? ' on' : ''}" data-act="chip" data-chip="${id}" aria-pressed="${S.chip === id}">${label}</button>`).join('')}</div>`;
    return;
  }
  const titles = { settings: 'Settings', album: '', artist: '', playlist: '' };
  sticky.innerHTML = `<div class="top"><button class="icon-btn" data-act="back" aria-label="Back">${ic('i-back')}</button><div class="top-title">${esc(titles[v.name] || '')}</div></div>`;
}

function renderBody() {
  destroyVirtual();
  const v = S.view;
  if (v.name === 'home') renderHome();
  else if (v.name === 'explore') renderExplore();
  else if (v.name === 'library') renderLibrary();
  else if (v.name === 'album') renderAlbum(v.key);
  else if (v.name === 'artist') renderArtist(v.id);
  else if (v.name === 'playlist') renderPlaylist(v.id);
  else if (v.name === 'settings') renderSettings();
}

function emptyLibrary() {
  return `<div class="empty"><div class="empty-mark">${ic('i-note', 'ic xl')}</div>
    <h2>Add your music</h2>
    <p>Songs stay on this device and play offline, with the screen off.</p>
    <button class="pill solid" data-act="add">Add music</button></div>`;
}

function renderHome() {
  if (!songs.length) { view.innerHTML = emptyLibrary(); return; }
  const recent = index.recent.slice(0, 12);
  const picks = quickPicks().slice(0, window.innerWidth >= 720 ? 12 : 8);
  const albums = index.albumList.slice(0, 24);
  const artists = index.artistList.slice(0, 24);
  view.innerHTML = `
    <section><div class="sec-h"><h2>Recently added</h2></div><div class="hrow">${recent.map((s) => songCard(s, 'recent')).join('')}</div></section>
    <section><div class="sec-h"><h2>Quick picks</h2><button class="icon-round" data-act="shuffle-all" aria-label="Shuffle library">${ic('i-play')}</button></div>
      <div class="qp">${picks.map((s) => `<div class="qp-cell">${songRow(s, { ctx: 'picks' })}</div>`).join('')}</div></section>
    <section><div class="sec-h"><h2>Albums</h2><button class="textbtn" data-act="see" data-chip="albums">See all</button></div>
      <div class="hrow">${albums.map(albumCard).join('')}</div></section>
    <section><div class="sec-h"><h2>Artists</h2><button class="textbtn" data-act="see" data-chip="artists">See all</button></div>
      <div class="hrow">${artists.map(artistCard).join('')}</div></section>`;
  hydrate(view);
}

function renderExplore() {
  const q = S.query.trim();
  if (!q) {
    const liked = playlists.find((p) => p.id === 'liked');
    const n = liked ? liked.songIds.filter((id) => index.byId.has(id)).length : 0;
    view.innerHTML = `<div class="explore-hint"><h2>Search your library</h2><p>Find songs, albums, and artists stored on this device.</p></div>
      ${n ? `<button class="pl-row" data-act="open-playlist" data-pl="liked">${artHtml('', 'liked', 'thumb liked-ph')}<span class="meta"><span class="t">Liked songs</span><span class="s">${n} song${n === 1 ? '' : 's'}</span></span></button>` : ''}`;
    return;
  }
  const result = searchLibrary(index, q);
  if (!result.songs.length && !result.albums.length && !result.artists.length) {
    view.innerHTML = `<div class="empty small"><h2>No matches</h2><p>Nothing in your library matches “${esc(q)}”.</p></div>`;
    return;
  }
  const albums = result.albums.slice(0, 12).map(albumCard).join('');
  const artists = result.artists.slice(0, 12).map(artistCard).join('');
  view.innerHTML = `<div class="page">
      ${artists ? `<h3 class="group-label">Artists</h3><div class="hrow">${artists}</div>` : ''}
      ${albums ? `<h3 class="group-label">Albums</h3><div class="hrow">${albums}</div>` : ''}
      ${result.songs.length ? `<h3 class="group-label">Songs</h3><div id="vhost" class="vhost"></div>` : ''}
    </div>`;
  hydrate(view);
  if (result.songs.length) {
    mountList(result.songs, { render: (song) => songRow(song) });
  }
}

function renderLibrary() {
  if (!songs.length && S.chip !== 'playlists') { view.innerHTML = emptyLibrary(); return; }
  if (S.chip === 'songs') {
    const list = sortedSongs();
    view.innerHTML = `<div class="page"><div class="sortbar">
        <button data-act="sort" data-sort="title" class="${S.songSort === 'title' ? 'on' : ''}">A–Z</button>
        <button data-act="sort" data-sort="artist" class="${S.songSort === 'artist' ? 'on' : ''}">Artist</button>
        <button data-act="sort" data-sort="recent" class="${S.songSort === 'recent' ? 'on' : ''}">Recent</button>
        <span class="spacer"></span>
        <button data-act="shuffle-all">Shuffle</button>
      </div><div id="vhost" class="vhost"></div></div>`;
    mountList(list, {
      cols: (w) => (w >= 720 ? 2 : 1),
      render: (song) => songRow(song),
      empty: 'No songs yet.',
    });
    return;
  }
  if (S.chip === 'albums') {
    view.innerHTML = `<div class="page"><div id="vhost" class="vhost grid"></div></div>`;
    mountList(index.albumList, {
      cols: (w) => (w >= 1100 ? 6 : w >= 720 ? 4 : 2),
      rowHeight: gridMetrics(2),
      render: (album) => albumCard(album),
      empty: 'No albums yet.',
    });
    return;
  }
  if (S.chip === 'artists') {
    view.innerHTML = `<div class="page"><div id="vhost" class="vhost grid"></div></div>`;
    mountList(index.artistList, {
      cols: (w) => (w >= 1100 ? 6 : w >= 720 ? 4 : 2),
      rowHeight: gridMetrics(1),
      render: (artist) => artistCard(artist),
      empty: 'No artists yet.',
    });
    return;
  }
  renderPlaylistIndex();
}

function renderPlaylistIndex() {
  const lists = playlists.slice().sort((a, b) => (a.system === b.system ? a.name.localeCompare(b.name) : a.system ? -1 : 1));
  view.innerHTML = `<div class="page plist"><button class="pl-create" data-act="new-playlist">${ic('i-add')} New playlist</button>
    ${lists.map((pl) => {
      const ids = pl.songIds.filter((id) => index.byId.has(id));
      const first = ids.map((id) => index.byId.get(id)).find((s) => s?.artKey);
      const art = pl.system
        ? `<div class="ph thumb liked-ph">${ic('i-thumb')}</div>`
        : artHtml(first?.artKey || '', pl.name, 'thumb');
      return `<button class="pl-row" data-act="open-playlist" data-pl="${pl.id}">${art}<span class="meta"><span class="t">${esc(pl.name)}</span><span class="s">${ids.length} song${ids.length === 1 ? '' : 's'}</span></span></button>`;
    }).join('')}</div>`;
  hydrate(view);
}

function renderAlbum(key) {
  const album = index.albums.get(key);
  if (!album) { view.innerHTML = `<div class="empty small"><h2>Album unavailable</h2></div>`; return; }
  const tracks = album.songIds.map((id) => index.byId.get(id)).filter(Boolean);
  const secs = tracks.reduce((n, s) => n + (s.duration || 0), 0);
  const artistId = norm(album.artist);
  const artistBtn = index.artists.has(artistId)
    ? `<button class="link" data-act="open-artist" data-artist="${encodeURIComponent(artistId)}">${esc(album.artist)}</button>`
    : esc(album.artist);
  view.innerHTML = `<div class="page"><div class="hero">
      ${artHtml(album.artKey, album.name, 'hero-art')}
      <div class="hero-copy">
        <h1>${esc(album.name)}</h1>
        <p>${artistBtn}${album.year ? ` · ${esc(album.year)}` : ''}</p>
        <p class="s">${tracks.length} song${tracks.length === 1 ? '' : 's'}${secs ? ` · ${fmt(secs)}` : ''}</p>
        <div class="actions">
          <button class="pill solid" data-act="play-context" data-mode="order">${ic('i-play')} Play</button>
          <button class="pill" data-act="play-context" data-mode="shuffle">${ic('i-shuffle')} Shuffle</button>
        </div>
      </div>
    </div><div id="vhost" class="vhost"></div></div>`;
  hydrate(view);
  mountList(tracks, { render: (song) => songRow(song, { track: true, duration: true }) });
}

function renderArtist(id) {
  const artist = index.artists.get(id);
  if (!artist) { view.innerHTML = `<div class="empty small"><h2>Artist unavailable</h2></div>`; return; }
  const albums = artist.albumKeys.map((key) => index.albums.get(key)).filter(Boolean);
  const tracks = artist.songIds.map((sid) => index.byId.get(sid)).filter(Boolean);
  view.innerHTML = `<div class="page"><div class="hero">
      ${artHtml(artist.artKey, artist.name, 'hero-art round')}
      <div class="hero-copy">
        <h1>${esc(artist.name)}</h1>
        <p class="s">${tracks.length} song${tracks.length === 1 ? '' : 's'} · ${albums.length} album${albums.length === 1 ? '' : 's'}</p>
        <div class="actions">
          <button class="pill solid" data-act="play-context" data-mode="order">${ic('i-play')} Play</button>
          <button class="pill" data-act="play-context" data-mode="shuffle">${ic('i-shuffle')} Shuffle</button>
        </div>
      </div>
    </div>
    ${albums.length ? `<h3 class="group-label">Albums</h3><div class="hrow">${albums.map(albumCard).join('')}</div>` : ''}
    <h3 class="group-label">Songs</h3>
    <div id="vhost" class="vhost"></div></div>`;
  hydrate(view);
  mountList(tracks, { render: (song) => songRow(song, { duration: true }) });
}

function renderPlaylist(id) {
  const pl = playlists.find((p) => p.id === id);
  if (!pl) { view.innerHTML = `<div class="empty small"><h2>Playlist unavailable</h2></div>`; return; }
  const tracks = pl.songIds.map((sid) => index.byId.get(sid)).filter(Boolean);
  const first = tracks.find((s) => s.artKey);
  const art = pl.system
    ? `<div class="ph hero-art liked-ph">${ic('i-thumb', 'ic xl')}</div>`
    : artHtml(first?.artKey || '', pl.name, 'hero-art');
  const manage = pl.system ? '' : `<button class="icon-btn" data-act="playlist-menu" data-pl="${pl.id}" aria-label="Playlist options">${ic('i-more')}</button>`;
  view.innerHTML = `<div class="page"><div class="hero">
      ${art}
      <div class="hero-copy">
        <h1>${esc(pl.name)}</h1>
        <p class="s">${tracks.length} song${tracks.length === 1 ? '' : 's'}</p>
        <div class="actions">
          <button class="pill solid" data-act="play-context" data-mode="order" ${tracks.length ? '' : 'disabled'}>${ic('i-play')} Play</button>
          <button class="pill" data-act="play-context" data-mode="shuffle" ${tracks.length ? '' : 'disabled'}>${ic('i-shuffle')} Shuffle</button>
          ${manage}
        </div>
      </div>
    </div><div id="vhost" class="vhost"></div></div>`;
  hydrate(view);
  mountList(tracks, {
    render: (song) => songRow(song, { duration: true }),
    empty: pl.system ? 'Tap the thumb on a song to save it here.' : 'Use the menu on any song to add it here.',
  });
}

async function refreshStorage() {
  S.storage = await db.storageEstimate();
  S.persisted = await db.isPersisted();
}

function renderSettings() {
  const bytes = songs.reduce((n, s) => n + (s.size || 0), 0);
  const quota = S.storage.quota ? formatBytes(S.storage.quota) : 'the available space';
  view.innerHTML = `<div class="page settings">
    <section>
      <h2>Storage</h2>
      <p>${songs.length} song${songs.length === 1 ? '' : 's'} · ${formatBytes(bytes)} in your library</p>
      <p class="s">This site is using ${formatBytes(S.storage.usage)} of ${quota}.</p>
      <p class="s">${S.persisted ? 'Persistent storage is on, so the browser should keep this library.' : 'Persistent storage is off. The browser may clear this library when space is low.'}</p>
      ${S.persisted ? '' : '<button class="pill" data-act="persist">Keep music on this device</button>'}
    </section>
    <section>
      <h2>Library</h2>
      <button class="pill danger" data-act="wipe">Remove all music</button>
    </section>
    <section>
      <h2>Keyboard</h2>
      <p class="s">Space plays or pauses. N next, P previous. Left and right seek while the player is open.</p>
    </section>
    <p id="app-version" class="version">Music ${esc(APP_VERSION)}</p>
  </div>`;
}

function paintTabs() {
  if (S.view.name === 'home' || S.view.name === 'explore' || S.view.name === 'library') S.tab = S.view.name;
  for (const name of ['home', 'explore', 'library']) {
    const button = $(`tab-${name}`);
    if (S.tab === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function navigate(next) {
  S.stack.push(S.view);
  S.view = next;
  showView({ scroll: true });
}

function back() {
  S.view = S.stack.pop() || { name: S.tab || 'home' };
  showView({ scroll: true });
}

function tabTo(name) {
  S.stack = [];
  S.view = { name };
  S.tab = name;
  showView({ scroll: true });
}

function openSheet(html) {
  const sheet = $('sheet');
  sheet.hidden = false;
  sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
}

function closeSheet() {
  const sheet = $('sheet');
  sheet.hidden = true;
  sheet.innerHTML = '';
}

function openAddSheet() {
  openSheet(`<h3 class="sheet-title">Add music</h3>
    <button class="rowbtn" data-act="add-files">${ic('i-add')} Audio files</button>
    <button class="rowbtn" data-act="add-folder">${ic('i-folder')} Folder</button>
    <p class="sheet-note">Files are copied into this app and play with no network. You can also drop a folder or files onto the page.</p>`);
}

function openSongMenu(id) {
  const song = index.byId.get(id);
  if (!song) return;
  const liked = isLiked(id);
  const onPlaylist = S.view.name === 'playlist';
  const remove = onPlaylist
    ? `<button class="rowbtn" data-act="remove-from-pl" data-id="${song.id}">${ic('i-close')} Remove from playlist</button>`
    : '';
  openSheet(`<div class="sheet-song">${artHtml(song.artKey, song.album || song.title, 'sheet-art')}<div><div class="t">${esc(song.title)}</div><div class="s">${esc(song.artist)}</div></div></div>
    <button class="rowbtn" data-act="menu-next" data-id="${song.id}">${ic('i-next')} Play next</button>
    <button class="rowbtn" data-act="menu-queue" data-id="${song.id}">${ic('i-list')} Add to queue</button>
    <button class="rowbtn" data-act="add-to-pl" data-id="${song.id}">${ic('i-add')} Add to playlist</button>
    <button class="rowbtn" data-act="like" data-id="${song.id}">${ic('i-thumb')} ${liked ? 'Unlike' : 'Like'}</button>
    <button class="rowbtn" data-act="goto-album" data-id="${song.id}">${ic('i-library')} Go to album</button>
    <button class="rowbtn" data-act="goto-artist" data-id="${song.id}">${ic('i-explore')} Go to artist</button>
    ${remove}
    <button class="rowbtn danger" data-act="ask-delete" data-id="${song.id}">${ic('i-delete')} Delete from library</button>`);
}

function openAddToPlaylist(songId) {
  const rows = playlists.map((pl) => {
    const on = pl.songIds.includes(songId);
    return `<button class="rowbtn${on ? ' checked' : ''}" data-act="pl-toggle" data-pl="${pl.id}" data-id="${songId}" data-pl-toggle="${pl.id}">
      ${ic(pl.system ? 'i-thumb' : 'i-list')}<span>${esc(pl.name)}</span><span class="checkline">${on ? ic('i-check') : ''}</span></button>`;
  }).join('');
  openSheet(`<h3 class="sheet-title">Add to playlist</h3>
    <form data-act="create-pl" data-id="${songId}">
      <input name="name" type="text" maxlength="80" placeholder="New playlist name" aria-label="New playlist name" required>
      <div class="sheet-actions"><button class="pill solid sm" type="submit">Create</button></div>
    </form>
    ${rows}`);
}

function openCreatePlaylist() {
  openSheet(`<h3 class="sheet-title">New playlist</h3>
    <form data-act="create-pl">
      <input name="name" type="text" maxlength="80" placeholder="Playlist name" aria-label="Playlist name" required>
      <div class="sheet-actions"><button class="pill" type="button" data-act="close-sheet">Cancel</button><button class="pill solid sm" type="submit">Create</button></div>
    </form>`);
  $('sheet').querySelector('input')?.focus();
}

function openPlaylistMenu(id) {
  const pl = playlists.find((p) => p.id === id);
  if (!pl || pl.system) return;
  openSheet(`<h3 class="sheet-title">${esc(pl.name)}</h3>
    <button class="rowbtn" data-act="ask-rename" data-pl="${pl.id}">${ic('i-list')} Rename</button>
    <button class="rowbtn danger" data-act="ask-delete-pl" data-pl="${pl.id}">${ic('i-delete')} Delete playlist</button>`);
}

function markPlaying() {
  const id = player?.currentId || '';
  document.querySelectorAll('.song.on').forEach((el) => {
    if (el.dataset.song !== id) el.classList.remove('on');
  });
  if (!id) return;
  document.querySelectorAll(`.song[data-song="${CSS.escape(id)}"]`).forEach((el) => el.classList.add('on'));
}

function paintPlayIcons() {
  const playing = !!player?.playing;
  const miniPlay = $('mini-play');
  const npPlay = $('np-play');
  miniPlay.innerHTML = ic(playing ? 'i-pause' : 'i-play');
  miniPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  npPlay.innerHTML = ic(playing ? 'i-pause' : 'i-play', 'ic xl');
  npPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const shuf = $('np-shuf');
  shuf.setAttribute('aria-pressed', player.shuffle ? 'true' : 'false');
  const rep = $('np-rep');
  rep.setAttribute('aria-pressed', player.repeat === 'off' ? 'false' : 'true');
  rep.classList.toggle('one', player.repeat === 'one');
  rep.setAttribute('aria-label', player.repeat === 'one' ? 'Repeat one' : player.repeat === 'all' ? 'Repeat all' : 'Repeat off');
  const vol = $('np-vol');
  if (document.activeElement !== vol) vol.value = String(Math.round(audio.volume * 100));
}

function paintLikeButtons() {
  const on = !!(player?.currentId && isLiked(player.currentId));
  for (const id of ['mini-like', 'np-like']) {
    const button = $(id);
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Unlike' : 'Like');
  }
}

async function paintBoxArt(boxId, imgId, song) {
  const box = $(boxId);
  const img = $(imgId);
  box.style.setProperty('--h', String(hue(song.album || song.title)));
  if (!song.artKey) {
    img.removeAttribute('src');
    delete img.dataset.key;
    box.classList.remove('has-art');
    return null;
  }
  if (img.dataset.key === song.artKey && img.getAttribute('src')) {
    box.classList.add('has-art');
    return img.src;
  }
  const url = await artURL(song.artKey);
  if (player.currentId !== song.id) return url;
  img.dataset.key = song.artKey;
  if (url) img.src = url;
  else img.removeAttribute('src');
  box.classList.toggle('has-art', !!url);
  return url;
}

async function applyGlow(artKey, url) {
  const np = $('np');
  if (!artKey || !url) { np.style.setProperty('--glow', '#3a3a3a'); return; }
  if (glowCache.has(artKey)) { np.style.setProperty('--glow', glowCache.get(artKey)); return; }
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 12;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 12, 12);
    const data = ctx.getImageData(0, 0, 12, 12).data;
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] < 24) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
    if (!n) n = 1;
    const color = `rgb(${Math.min(255, Math.round((r / n) * 1.2))}, ${Math.min(255, Math.round((g / n) * 1.2))}, ${Math.min(255, Math.round((b / n) * 1.2))})`;
    glowCache.set(artKey, color);
    if (pinnedKey === artKey) np.style.setProperty('--glow', color);
  } catch {
    np.style.setProperty('--glow', '#3a3a3a');
  }
}

function paintMini() {
  const mini = $('mini');
  const song = player.currentId ? index.byId.get(player.currentId) : null;
  if (!song) {
    mini.hidden = true;
    document.body.classList.remove('has-player');
    document.title = 'Music';
    return;
  }
  mini.hidden = false;
  document.body.classList.add('has-player');
  $('mini-title').textContent = song.title;
  $('mini-artist').textContent = song.artist;
  document.title = `${song.title} · ${song.artist}`;
  paintLikeButtons();
  paintPlayIcons();
  paintBoxArt('mini-artbox', 'mini-img', song);
}

function paintProgress() {
  const d = audio.duration;
  const t = audio.currentTime || 0;
  const ratio = Number.isFinite(d) && d > 0 ? Math.min(1, Math.max(0, t / d)) : 0;
  $('mini-bar').style.transform = `scaleX(${ratio})`;
  const seek = $('np-seek');
  if (seek.dataset.drag !== '1') {
    const v = Math.round(ratio * 1000);
    seek.value = String(v);
    seek.style.setProperty('--pct', `${(ratio * 100).toFixed(2)}%`);
    seek.setAttribute('aria-valuenow', String(v));
    seek.setAttribute('aria-valuetext', fmt(t));
  }
  $('np-cur').textContent = fmt(t);
  $('np-dur').textContent = Number.isFinite(d) ? fmt(d) : '0:00';
}

async function paintPlayer() {
  const song = player.currentId ? index.byId.get(player.currentId) : null;
  if (!song) return;
  pinnedKey = song.artKey || '';
  $('np-title').textContent = song.title;
  $('np-artist').textContent = song.artist;
  $('np-from').textContent = song.album || '';
  paintLikeButtons();
  paintPlayIcons();
  paintProgress();
  const url = await paintBoxArt('np-artbox', 'np-img', song);
  if (player.currentId === song.id) applyGlow(song.artKey, url);
}

function queueScroller() {
  return window.matchMedia('(min-width: 720px)').matches ? $('qscroll') : $('np-body');
}

function bindQueue() {
  if (queueVirtual) {
    queueVirtual.destroy();
    queueVirtual = null;
  }
  refreshQueue();
}

function refreshQueue() {
  if (!S.npOpen) return;
  const host = $('qhost');
  const count = Math.max(0, player.queue.length - player.index - 1);
  $('qcount').textContent = count ? String(count) : '';
  if (!count) {
    if (queueVirtual) { queueVirtual.destroy(); queueVirtual = null; }
    host.replaceChildren();
    host.style.height = 'auto';
    host.innerHTML = '<p class="qempty">Nothing else is queued.</p>';
    return;
  }
  if (!queueVirtual) {
    queueVirtual = createVirtual({
      scrollEl: queueScroller(),
      host,
      getMetrics: () => ({
        count: Math.max(0, player.queue.length - player.index - 1),
        cols: 1,
        rowHeight: 64,
        stamp: `${player.index}:${player.queue.length}:${player.currentId}`,
        onPaint: hydrate,
      }),
      renderItem: (i) => {
        const qi = player.index + 1 + i;
        const song = index.byId.get(player.queue[qi]);
        if (!song) return '';
        return `<div class="song qsong"><button class="song-main" data-act="q-jump" data-q="${qi}">
            ${artHtml(song.artKey, song.title, 'thumb')}
            <span class="meta"><span class="t">${esc(song.title)}</span><span class="s">${esc(song.artist)}</span></span>
          </button><button class="icon-btn" data-act="q-remove" data-q="${qi}" aria-label="Remove from queue">${ic('i-close')}</button></div>`;
      },
    });
    return;
  }
  queueVirtual.paint();
}

function openPlayer() {
  if (!player.currentId) return;
  const np = $('np');
  np.classList.add('open');
  np.setAttribute('aria-hidden', 'false');
  np.removeAttribute('inert');
  S.npOpen = true;
  paintPlayer();
  bindQueue();
}

function closePlayer() {
  const np = $('np');
  np.classList.remove('open');
  np.setAttribute('aria-hidden', 'true');
  np.setAttribute('inert', '');
  S.npOpen = false;
}

let saveTimer = 0;
let lastTimeSave = 0;
function maybeSave(force) {
  const now = Date.now();
  if (!force && now - lastTimeSave < 5000) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    lastTimeSave = Date.now();
    db.setKV('player', player.snapshot()).catch(() => {});
  }, force ? 40 : 180);
}

function onPlayer(kind) {
  if (kind === 'time') {
    paintProgress();
    maybeSave(false);
    return;
  }
  paintMini();
  markPlaying();
  if (S.npOpen) {
    if (kind === 'track') paintPlayer();
    else paintPlayIcons();
    if (kind === 'track' || kind === 'queue') refreshQueue();
  }
  if (kind !== 'time') maybeSave(true);
}

function playSongFrom(id, ctx) {
  let ids;
  if (ctx === 'recent') ids = index.recent.map((s) => s.id);
  else if (ctx === 'picks') ids = quickPicks().map((s) => s.id);
  else ids = contextIds();
  if (!ids.includes(id)) ids = [id, ...ids];
  player.playIds(ids, id);
}

function playContext(mode) {
  const ids = contextIds();
  if (!ids.length) return;
  const shuffle = mode === 'shuffle';
  const start = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
  player.playIds(ids, start, { shuffle });
}

async function toggleLike(id) {
  const pl = playlists.find((p) => p.id === 'liked');
  if (!pl || !index.byId.has(id)) return;
  const at = pl.songIds.indexOf(id);
  if (at >= 0) pl.songIds.splice(at, 1);
  else pl.songIds.unshift(id);
  pl.updatedAt = Date.now();
  await db.putPlaylist(pl);
  paintLikeButtons();
  if (S.view.name === 'playlist' && S.view.id === 'liked') showView({ scroll: false });
  if (S.view.name === 'explore' && !S.query) renderBody();
  toast(at >= 0 ? 'Removed from Liked songs' : 'Saved to Liked songs');
}

async function togglePlaylist(plId, songId) {
  const pl = playlists.find((p) => p.id === plId);
  if (!pl || !index.byId.has(songId)) return;
  const at = pl.songIds.indexOf(songId);
  if (at >= 0) pl.songIds.splice(at, 1);
  else pl.songIds.push(songId);
  pl.updatedAt = Date.now();
  await db.putPlaylist(pl);
  const on = pl.songIds.includes(songId);
  const button = document.querySelector(`[data-pl-toggle="${CSS.escape(plId)}"]`);
  if (button) {
    button.classList.toggle('checked', on);
    const mark = button.querySelector('.checkline');
    if (mark) mark.innerHTML = on ? ic('i-check') : '';
  }
  if (S.view.name === 'playlist' && S.view.id === plId) showView({ scroll: false });
}

async function createPlaylist(name, songId) {
  const title = name.trim().slice(0, 80);
  if (!title) return;
  const pl = {
    id: crypto.randomUUID(),
    name: title,
    system: false,
    songIds: songId && index.byId.has(songId) ? [songId] : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  playlists.push(pl);
  await db.putPlaylist(pl);
  toast(`Created “${title}”`);
  if (songId) openAddToPlaylist(songId);
  else {
    closeSheet();
    if (S.view.name === 'library' && S.chip === 'playlists') showView({ scroll: false });
    navigate({ name: 'playlist', id: pl.id });
  }
}

async function renamePlaylist(id, name) {
  const pl = playlists.find((p) => p.id === id);
  const title = name.trim().slice(0, 80);
  if (!pl || pl.system || !title) return;
  pl.name = title;
  pl.updatedAt = Date.now();
  await db.putPlaylist(pl);
  closeSheet();
  showView({ scroll: false });
  toast('Playlist renamed');
}

async function deletePlaylist(id) {
  const pl = playlists.find((p) => p.id === id);
  if (!pl || pl.system) return;
  playlists = playlists.filter((p) => p.id !== id);
  await db.deletePlaylist(id);
  closeSheet();
  if (S.view.name === 'playlist' && S.view.id === id) back();
  else showView({ scroll: false });
  toast('Playlist deleted');
}

async function removeFromCurrentPlaylist(songId) {
  if (S.view.name !== 'playlist') return;
  if (S.view.id === 'liked') { await toggleLike(songId); closeSheet(); return; }
  await togglePlaylist(S.view.id, songId);
  closeSheet();
  toast('Removed from playlist');
}

async function deleteSong(id) {
  const song = index.byId.get(id);
  if (!song) return;
  await player.removeSong(id);
  await db.deleteAudio(id);
  await db.deleteSong(id);
  for (const pl of playlists) {
    const at = pl.songIds.indexOf(id);
    if (at >= 0) {
      pl.songIds.splice(at, 1);
      pl.updatedAt = Date.now();
      await db.putPlaylist(pl);
    }
  }
  if (song.artKey && !songs.some((s) => s.id !== id && s.artKey === song.artKey)) {
    await db.deleteArt(song.artKey);
    const url = artUrls.get(song.artKey);
    if (url) { URL.revokeObjectURL(url); artUrls.delete(song.artKey); }
    glowCache.delete(song.artKey);
  }
  songs = songs.filter((s) => s.id !== id);
  reindex();
  picksStamp = -1;
  closeSheet();
  showView({ scroll: false });
  paintMini();
  if (S.npOpen) {
    if (player.currentId) { paintPlayer(); refreshQueue(); }
    else closePlayer();
  }
  toast('Removed from library');
  refreshStorage();
}

async function wipeLibrary() {
  player.clear();
  closePlayer();
  await db.clearLibrary();
  for (const url of artUrls.values()) URL.revokeObjectURL(url);
  artUrls.clear();
  glowCache.clear();
  songs = [];
  playlists = [];
  picksCache = null;
  picksStamp = -1;
  await ensureLiked();
  reindex();
  closeSheet();
  S.stack = [];
  S.view = { name: 'library' };
  showView({ scroll: true });
  paintMini();
  await refreshStorage();
  toast('Library cleared');
}

function mimeOf(file) {
  if (file.type && (file.type.startsWith('audio/') || file.type === 'video/mp4')) return file.type.startsWith('audio/') ? file.type : 'audio/mp4';
  const ext = (String(file.name || '').match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
    flac: 'audio/flac', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff',
  }[ext] || 'audio/mpeg';
}

async function hashArt(bytes) {
  const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function showImport(total) {
  const overlay = $('overlay');
  overlay.hidden = false;
  overlay.innerHTML = `<div class="modal" role="dialog" aria-label="Import progress"><h3>Adding music</h3>
    <p id="imp-name" class="s"></p><div class="bar"><div id="imp-bar"></div></div>
    <p id="imp-count"></p><button class="pill" data-act="cancel-import">Cancel</button></div>`;
  paintImport(0, total, '');
}

function paintImport(done, total, name) {
  const bar = $('imp-bar');
  const label = $('imp-count');
  const file = $('imp-name');
  if (!bar) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  if (label) label.textContent = `${done} of ${total}`;
  if (file) file.textContent = name || '';
}

function hideImport() {
  $('overlay').hidden = true;
  $('overlay').innerHTML = '';
}

async function importFiles(fileList) {
  const files = [...fileList].filter(isAudioFile);
  if (!files.length) { toast('No audio files found'); return; }
  if (importing) { toast('Still adding music'); return; }
  importing = true;
  S.cancelImport = false;
  showImport(files.length);
  db.persistStorage().then((ok) => { S.persisted = ok || S.persisted; });
  let added = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      if (S.cancelImport) break;
      const file = files[i];
      paintImport(i, files.length, file.name);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const identity = fileIdentity(file);
      if (fileKeys.has(identity)) { skipped += 1; continue; }
      try {
        const meta = await readMetadata(file);
        const id = crypto.randomUUID();
        let artKey = '';
        if (meta.art?.data?.length) {
          const bytes = meta.art.data;
          artKey = await hashArt(bytes);
          if (!artKeySet.has(artKey)) {
            await db.putArt({ key: artKey, blob: new Blob([bytes], { type: meta.art.mime || 'image/jpeg' }), mime: meta.art.mime || 'image/jpeg' });
            artKeySet.add(artKey);
          }
        }
        const blob = file.type ? file : new Blob([file], { type: mimeOf(file) });
        const song = {
          id,
          title: meta.title.slice(0, 300),
          artist: (meta.artist || 'Unknown artist').slice(0, 300),
          album: (meta.album || 'Unknown album').slice(0, 300),
          albumArtist: (meta.albumArtist || '').slice(0, 300),
          track: meta.track || 0,
          disc: meta.disc || 0,
          year: meta.year || '',
          filename: file.name,
          fileKey: identity,
          mime: mimeOf(file),
          size: file.size || 0,
          addedAt: Date.now(),
          artKey,
          duration: 0,
        };
        await db.putSongAndAudio(song, blob);
        songs.push(song);
        fileKeys.add(identity);
        added += 1;
      } catch (err) {
        console.error(err);
        failed += 1;
        if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
          toast('Storage is full');
          break;
        }
      }
    }
  } finally {
    importing = false;
    hideImport();
  }
  reindex();
  picksStamp = -1;
  showView({ scroll: false });
  const parts = [`Added ${added} song${added === 1 ? '' : 's'}`];
  if (skipped) parts.push(`${skipped} already in the library`);
  if (failed) parts.push(`${failed} failed`);
  if (S.cancelImport) parts.push('import canceled');
  toast(parts.join(' · '));
  refreshStorage();
}

async function collectDropped(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])];
  const out = [];
  async function walk(entry, path) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      try { Object.defineProperty(file, 'webkitRelativePath', { value: path + file.name }); } catch { /* ignore */ }
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      let batch = [];
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        all.push(...batch);
      } while (batch.length);
      for (const child of all) await walk(child, `${path}${entry.name}/`);
    }
  }
  for (const entry of entries) await walk(entry, '');
  return out;
}

async function ensureLiked() {
  if (playlists.some((p) => p.id === 'liked')) return;
  const pl = { id: 'liked', name: 'Liked songs', system: true, songIds: [], createdAt: Date.now(), updatedAt: Date.now() };
  playlists.unshift(pl);
  await db.putPlaylist(pl);
}

function goAlbum(song) {
  const key = albumKeyOf(song);
  if (!index.albums.has(key)) return;
  closePlayer();
  closeSheet();
  navigate({ name: 'album', key });
}

function goArtistName(name) {
  const id = index.artists.has(name) ? name : norm(name);
  if (!index.artists.has(id)) { toast('No other songs by this artist'); return; }
  closePlayer();
  closeSheet();
  navigate({ name: 'artist', id });
}

document.body.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (!button || !player) return;
  const act = button.dataset.act;
  const id = button.dataset.id;
  if (act === 'tab') tabTo(button.dataset.tab);
  else if (act === 'add') openAddSheet();
  else if (act === 'add-files') { closeSheet(); fileInput.click(); }
  else if (act === 'add-folder') { closeSheet(); dirInput.click(); }
  else if (act === 'close-sheet') closeSheet();
  else if (act === 'cancel-import') S.cancelImport = true;
  else if (act === 'chip' || act === 'see') {
    S.chip = button.dataset.chip;
    if (act === 'see') tabTo('library');
    else showView({ scroll: true });
  } else if (act === 'settings') navigate({ name: 'settings' });
  else if (act === 'back') back();
  else if (act === 'open-np') openPlayer();
  else if (act === 'close-np') closePlayer();
  else if (act === 'toggle') player.toggle();
  else if (act === 'next') player.next();
  else if (act === 'prev') player.prev();
  else if (act === 'shuffle') player.toggleShuffle();
  else if (act === 'repeat') player.cycleRepeat();
  else if (act === 'shuffle-all') {
    if (songs.length) player.playIds(songs.map((s) => s.id), songs[0].id, { shuffle: true });
  } else if (act === 'play-song') playSongFrom(id, button.dataset.ctx || '');
  else if (act === 'play-context') playContext(button.dataset.mode || 'order');
  else if (act === 'song-menu') openSongMenu(id);
  else if (act === 'menu-current' && player.currentId) openSongMenu(player.currentId);
  else if (act === 'menu-next') { player.playNext(id); closeSheet(); toast('Playing next'); }
  else if (act === 'menu-queue') { player.enqueue(id); closeSheet(); toast('Added to queue'); }
  else if (act === 'add-to-pl') openAddToPlaylist(id);
  else if (act === 'like') { toggleLike(id); closeSheet(); }
  else if (act === 'like-current' && player.currentId) toggleLike(player.currentId);
  else if (act === 'goto-album') goAlbum(index.byId.get(id));
  else if (act === 'goto-artist') goArtistName(index.byId.get(id)?.artist || '');
  else if (act === 'np-album' && player.currentId) goAlbum(index.byId.get(player.currentId));
  else if (act === 'np-artist' && player.currentId) goArtistName(index.byId.get(player.currentId)?.artist || '');
  else if (act === 'open-album') navigate({ name: 'album', key: decodeURIComponent(button.dataset.key || '') });
  else if (act === 'open-artist') navigate({ name: 'artist', id: decodeURIComponent(button.dataset.artist || '') });
  else if (act === 'open-playlist') navigate({ name: 'playlist', id: button.dataset.pl });
  else if (act === 'new-playlist') openCreatePlaylist();
  else if (act === 'playlist-menu') openPlaylistMenu(button.dataset.pl);
  else if (act === 'pl-toggle') togglePlaylist(button.dataset.pl, id);
  else if (act === 'remove-from-pl') removeFromCurrentPlaylist(id);
  else if (act === 'ask-delete') {
    const song = index.byId.get(id);
    openSheet(`<h3 class="sheet-title">Delete from library?</h3><p class="sheet-note">“${esc(song?.title || 'This song')}” is removed from this app, including every playlist. The original file outside the app is left alone.</p>
      <div class="sheet-actions"><button class="pill" data-act="close-sheet">Cancel</button><button class="pill danger" data-act="confirm-delete" data-id="${id}">Delete</button></div>`);
  } else if (act === 'confirm-delete') deleteSong(id);
  else if (act === 'ask-rename') {
    const pl = playlists.find((p) => p.id === button.dataset.pl);
    if (!pl) return;
    openSheet(`<h3 class="sheet-title">Rename playlist</h3><form data-act="rename-pl" data-pl="${pl.id}">
      <input name="name" type="text" maxlength="80" value="${esc(pl.name)}" aria-label="Playlist name" required>
      <div class="sheet-actions"><button class="pill" type="button" data-act="close-sheet">Cancel</button><button class="pill solid sm" type="submit">Save</button></div></form>`);
  } else if (act === 'ask-delete-pl') {
    const pl = playlists.find((p) => p.id === button.dataset.pl);
    openSheet(`<h3 class="sheet-title">Delete playlist?</h3><p class="sheet-note">“${esc(pl?.name || '')}” goes away. The songs stay in your library.</p>
      <div class="sheet-actions"><button class="pill" data-act="close-sheet">Cancel</button><button class="pill danger" data-act="confirm-delete-pl" data-pl="${button.dataset.pl}">Delete</button></div>`);
  } else if (act === 'confirm-delete-pl') deletePlaylist(button.dataset.pl);
  else if (act === 'sort') {
    S.songSort = button.dataset.sort;
    db.setKV('sort', S.songSort).catch(() => {});
    showView({ scroll: true });
  } else if (act === 'persist') {
    db.persistStorage().then(async (ok) => {
      S.persisted = ok || await db.isPersisted();
      renderBody();
      toast(S.persisted ? 'Music will stay on this device' : 'The browser did not allow persistent storage');
    });
  } else if (act === 'wipe') {
    openSheet(`<h3 class="sheet-title">Remove all music?</h3><p class="sheet-note">This deletes every song and playlist stored in the app.</p>
      <div class="sheet-actions"><button class="pill" data-act="close-sheet">Cancel</button><button class="pill danger" data-act="confirm-wipe">Remove all</button></div>`);
  } else if (act === 'confirm-wipe') wipeLibrary();
  else if (act === 'q-jump') player.jump(Number(button.dataset.q));
  else if (act === 'q-remove') { player.removeAt(Number(button.dataset.q)); toast('Removed from queue'); }
});

document.body.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = new FormData(form);
  const name = String(data.get('name') || '');
  if (form.dataset.act === 'create-pl') createPlaylist(name, form.dataset.id || '');
  else if (form.dataset.act === 'rename-pl') renamePlaylist(form.dataset.pl, name);
});

document.addEventListener('keydown', (event) => {
  const typing = event.target.closest('input, textarea');
  if (event.key === 'Escape') {
    if (!$('sheet').hidden) { closeSheet(); return; }
    if (!$('overlay').hidden) return;
    if (S.npOpen) { closePlayer(); return; }
    if (S.stack.length) back();
    return;
  }
  if (typing || !player) return;
  if (event.code === 'Space') { event.preventDefault(); player.toggle(); }
  else if (event.key === 'n' || event.key === 'N') player.next();
  else if (event.key === 'p' || event.key === 'P') player.prev();
  else if (S.npOpen && event.key === 'ArrowRight') { event.preventDefault(); player.seek((audio.currentTime || 0) + 5); }
  else if (S.npOpen && event.key === 'ArrowLeft') { event.preventDefault(); player.seek((audio.currentTime || 0) - 5); }
});

const seek = $('np-seek');
seek.addEventListener('pointerdown', () => { seek.dataset.drag = '1'; });
const endDrag = () => { delete seek.dataset.drag; };
seek.addEventListener('pointerup', endDrag);
seek.addEventListener('pointercancel', endDrag);
seek.addEventListener('input', () => {
  const d = audio.duration || 0;
  const t = (Number(seek.value) / 1000) * d;
  seek.style.setProperty('--pct', `${Number(seek.value) / 10}%`);
  $('np-cur').textContent = fmt(t);
  if (d) player?.seek(t);
});
$('np-vol').addEventListener('input', (event) => {
  player?.setVolume(Number(event.target.value) / 100);
  maybeSave(true);
});

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (files.length) importFiles(files);
});
dirInput.addEventListener('change', () => {
  const files = [...dirInput.files];
  dirInput.value = '';
  if (files.length) importFiles(files);
});

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  $('drop').hidden = false;
});
document.addEventListener('dragover', (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  dragDepth -= 1;
  if (dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; }
});
document.addEventListener('drop', async (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const files = await collectDropped(event.dataTransfer);
  if (files.length) importFiles(files);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && player) db.setKV('player', player.snapshot()).catch(() => {});
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const now = window.matchMedia('(min-width: 720px)').matches;
    S.virtual?.paint();
    if (now !== wide) {
      wide = now;
      if (S.npOpen) bindQueue();
    }
  }, 80);
});

async function init() {
  try {
    await db.openDb();
    songs = await db.getAll('songs');
    playlists = await db.getAll('playlists');
    await ensureLiked();
    reindex();
  } catch (err) {
    console.error(err);
    $('boot').hidden = true;
    view.innerHTML = `<div class="empty"><h2>Storage unavailable</h2><p>Music saves your library with IndexedDB. Private windows sometimes block that.</p></div>`;
    return;
  }
  const savedSort = await db.getKV('sort');
  if (savedSort === 'artist' || savedSort === 'recent' || savedSort === 'title') S.songSort = savedSort;
  player = createPlayer({
    audio,
    getSong: (id) => index.byId.get(id),
    getAudio: (id) => db.getAudio(id),
    getArt: (key) => db.getArt(key),
    onChange: onPlayer,
    onDuration: (id, dur) => {
      const song = index.byId.get(id);
      if (!song || !Number.isFinite(dur) || dur <= 0) return;
      if (song.duration && Math.abs(song.duration - dur) < 0.4) return;
      song.duration = dur;
      db.putSong(song).catch(() => {});
    },
    onError: (id) => {
      const song = index.byId.get(id);
      toast(`Can’t play ${song ? song.title : 'that file'}`);
    },
  });
  const saved = await db.getKV('player');
  player.restore(saved, (id) => index.byId.has(id));
  S.storage = await db.storageEstimate();
  S.persisted = await db.isPersisted();
  db.persistStorage().then(async (ok) => { S.persisted = ok || await db.isPersisted(); });
  showView({ scroll: true });
  paintMini();
  $('boot').hidden = true;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => {});
  }
  window.__music = {
    version: APP_VERSION,
    get songs() { return songs; },
    get playlists() { return playlists; },
    get player() { return player; },
  };
}

init();
