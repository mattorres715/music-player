export function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function albumKeyOf(song) {
  const artist = (song.albumArtist || song.artist || '').trim();
  const album = (song.album || '').trim();
  return `${norm(artist)}\u0000${norm(album)}`;
}

function cmpTitle(a, b) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
    || a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' });
}

function cmpTrack(a, b) {
  const da = a.disc || 99;
  const db = b.disc || 99;
  if (da !== db) return da - db;
  const ta = a.track || 9999;
  const tb = b.track || 9999;
  if (ta !== tb) return ta - tb;
  return cmpTitle(a, b);
}

export function buildIndex(songs) {
  const byId = new Map();
  const albums = new Map();
  const artists = new Map();
  for (const song of songs) {
    byId.set(song.id, song);
    const key = albumKeyOf(song);
    let album = albums.get(key);
    if (!album) {
      album = {
        key,
        name: song.album || 'Unknown album',
        artist: song.albumArtist || song.artist || 'Unknown artist',
        songIds: [],
        artKey: song.artKey || '',
        year: song.year || '',
        addedAt: song.addedAt || 0,
      };
      albums.set(key, album);
    }
    album.songIds.push(song.id);
    if (!album.artKey && song.artKey) album.artKey = song.artKey;
    if (!album.year && song.year) album.year = song.year;
    if ((song.addedAt || 0) > album.addedAt) album.addedAt = song.addedAt;

    const artistName = song.artist || 'Unknown artist';
    const artistId = norm(artistName);
    let artist = artists.get(artistId);
    if (!artist) {
      artist = { id: artistId, name: artistName, songIds: [], albumKeys: [], artKey: song.artKey || '' };
      artists.set(artistId, artist);
    }
    artist.songIds.push(song.id);
    if (!artist.albumKeys.includes(key)) artist.albumKeys.push(key);
    if (!artist.artKey && song.artKey) artist.artKey = song.artKey;
  }

  for (const album of albums.values()) {
    album.songIds.sort((a, b) => cmpTrack(byId.get(a), byId.get(b)));
  }
  for (const artist of artists.values()) {
    artist.songIds.sort((a, b) => cmpTitle(byId.get(a), byId.get(b)));
  }

  const songList = songs.slice().sort(cmpTitle);
  const albumList = [...albums.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const artistList = [...artists.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const recent = songs.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || cmpTitle(a, b));

  return { byId, albums, artists, songList, albumList, artistList, recent };
}

export function searchLibrary(index, query) {
  const n = norm(query).trim();
  if (!n) return { songs: [], albums: [], artists: [], query: '' };
  const tokens = n.split(/\s+/);
  const has = (...parts) => {
    const hay = norm(parts.filter(Boolean).join(' '));
    return tokens.every((t) => hay.includes(t));
  };
  return {
    query,
    songs: index.songList.filter((s) => has(s.title, s.artist, s.album)),
    albums: index.albumList.filter((a) => has(a.name, a.artist)),
    artists: index.artistList.filter((a) => has(a.name)),
  };
}

export function fileIdentity(file) {
  const rel = file.webkitRelativePath || file.name || '';
  return `${rel}\u0000${file.size || 0}`;
}

export function isAudioFile(file) {
  const name = file.name || '';
  if (file.type && file.type.startsWith('audio/')) return true;
  return /\.(mp3|m4a|mp4|aac|ogg|oga|opus|wav|flac|webm|alac|aiff|aif)$/i.test(name);
}
