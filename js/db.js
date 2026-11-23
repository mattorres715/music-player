const DB_NAME = 'music';
const DB_VERSION = 1;

let dbPromise;

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
        if (!db.objectStoreNames.contains('art')) db.createObjectStore('art', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function store(name, mode) {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  return { tx, os: tx.objectStore(name) };
}

export async function getAll(name) {
  const { tx, os } = await store(name, 'readonly');
  const all = await reqDone(os.getAll());
  await txDone(tx);
  return all;
}

export async function putSongAndAudio(song, blob) {
  const db = await openDb();
  const tx = db.transaction(['songs', 'audio'], 'readwrite');
  tx.objectStore('songs').put(song);
  tx.objectStore('audio').put(blob, song.id);
  await txDone(tx);
}

export async function putSong(song) {
  const { tx, os } = await store('songs', 'readwrite');
  os.put(song);
  await txDone(tx);
}

export async function getAudio(id) {
  const { tx, os } = await store('audio', 'readonly');
  const blob = await reqDone(os.get(id));
  await txDone(tx);
  return blob || null;
}

export async function deleteAudio(id) {
  const { tx, os } = await store('audio', 'readwrite');
  os.delete(id);
  await txDone(tx);
}

export async function deleteSong(id) {
  const { tx, os } = await store('songs', 'readwrite');
  os.delete(id);
  await txDone(tx);
}

export async function putArt(rec) {
  const { tx, os } = await store('art', 'readwrite');
  os.put(rec);
  await txDone(tx);
}

export async function getArt(key) {
  if (!key) return null;
  const { tx, os } = await store('art', 'readonly');
  const rec = await reqDone(os.get(key));
  await txDone(tx);
  return rec || null;
}

export async function deleteArt(key) {
  const { tx, os } = await store('art', 'readwrite');
  os.delete(key);
  await txDone(tx);
}

export async function putPlaylist(pl) {
  const { tx, os } = await store('playlists', 'readwrite');
  os.put(pl);
  await txDone(tx);
}

export async function deletePlaylist(id) {
  const { tx, os } = await store('playlists', 'readwrite');
  os.delete(id);
  await txDone(tx);
}

export async function getKV(key) {
  const { tx, os } = await store('kv', 'readonly');
  const v = await reqDone(os.get(key));
  await txDone(tx);
  return v;
}

export async function setKV(key, value) {
  const { tx, os } = await store('kv', 'readwrite');
  os.put(value, key);
  await txDone(tx);
}

export async function clearLibrary() {
  const db = await openDb();
  const tx = db.transaction(['songs', 'audio', 'art', 'playlists'], 'readwrite');
  tx.objectStore('songs').clear();
  tx.objectStore('audio').clear();
  tx.objectStore('art').clear();
  tx.objectStore('playlists').clear();
  await txDone(tx);
}

export async function storageEstimate() {
  try {
    if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

export async function persistStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isPersisted() {
  try {
    if (!navigator.storage?.persisted) return false;
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}
