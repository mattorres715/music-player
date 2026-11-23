function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

async function artworkDataUrl(blob) {
  const bmp = await createImageBitmap(blob);
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, size, size);
  const scale = Math.max(size / bmp.width, size / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
  if (bmp.close) bmp.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}

function setHandler(name, fn) {
  try {
    navigator.mediaSession.setActionHandler(name, fn);
  } catch {
    /* this action isn't supported here */
  }
}

export function createPlayer({ audio, getSong, getAudio, getArt, onChange, onDuration, onError }) {
  const player = {
    queue: [],
    order: [],
    index: 0,
    currentId: null,
    shuffle: false,
    repeat: 'off',
    playing: false,
    pendingSeek: 0,
    gen: 0,
    failCount: 0,
    url: null,
    sessionToken: 0,
  };

  audio.preload = 'auto';
  audio.playsInline = true;

  function emit(kind) {
    onChange(kind);
  }

  function clampTime(t) {
    const d = audio.duration;
    if (!Number.isFinite(t) || t < 0) return 0;
    if (Number.isFinite(d) && d > 0) return Math.min(t, Math.max(0, d - 0.05));
    return t;
  }

  function syncPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(Math.max(0, audio.currentTime || 0), d),
      });
    } catch {
      /* ignore racey position updates */
    }
  }

  function syncPlaybackState() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
    } catch { /* ignore */ }
  }

  async function updateSession() {
    if (!('mediaSession' in navigator)) return;
    const song = player.currentId ? getSong(player.currentId) : null;
    const token = ++player.sessionToken;
    if (!song) {
      try { navigator.mediaSession.metadata = null; } catch { /* ignore */ }
      return;
    }
    const base = { title: song.title || 'Unknown', artist: song.artist || '', album: song.album || '' };
    try {
      navigator.mediaSession.metadata = new MediaMetadata(base);
    } catch { /* ignore */ }
    syncPlaybackState();
    if (!song.artKey) return;
    try {
      const rec = await getArt(song.artKey);
      if (!rec?.blob || token !== player.sessionToken) return;
      const src = await artworkDataUrl(rec.blob);
      if (token !== player.sessionToken) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        ...base,
        artwork: [{ src, sizes: '512x512', type: 'image/jpeg' }],
      });
      syncPosition();
    } catch {
      /* art is optional for the notification */
    }
  }

  async function playIndex(i, autoplay = true) {
    if (!player.queue.length) return;
    if (i < 0) i = 0;
    if (i >= player.queue.length) i = player.queue.length - 1;
    player.index = i;
    const id = player.queue[i];
    const my = ++player.gen;
    player.currentId = id;
    emit('track');
    let blob;
    try {
      blob = await getAudio(id);
    } catch (err) {
      if (my !== player.gen) return;
      fail(id, err);
      return;
    }
    if (my !== player.gen) return;
    if (!blob) {
      fail(id, new Error('missing audio'));
      return;
    }
    if (player.url) URL.revokeObjectURL(player.url);
    player.url = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const ok = () => { if (settled) return; settled = true; cleanup(); resolve(); };
        const bad = () => { if (settled) return; settled = true; cleanup(); reject(audio.error || new Error('audio error')); };
        const cleanup = () => {
          audio.removeEventListener('loadedmetadata', ok);
          audio.removeEventListener('error', bad);
        };
        audio.addEventListener('loadedmetadata', ok);
        audio.addEventListener('error', bad);
        audio.src = player.url;
        if (audio.readyState >= 1) ok();
      });
    } catch (err) {
      if (my !== player.gen) return;
      fail(id, err);
      return;
    }
    if (my !== player.gen) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) onDuration(id, audio.duration);
    if (player.pendingSeek) {
      try { audio.currentTime = clampTime(player.pendingSeek); } catch { /* ignore */ }
      player.pendingSeek = 0;
    }
    updateSession();
    if (!autoplay) {
      player.playing = false;
      emit('state');
      return;
    }
    try {
      await audio.play();
      player.failCount = 0;
    } catch (err) {
      if (my !== player.gen) return;
      if (err && err.name === 'NotAllowedError') {
        player.playing = false;
        emit('state');
        return;
      }
      fail(id, err);
    }
  }

  function fail(id, err) {
    onError(id, err);
    player.failCount += 1;
    if (player.failCount <= 6 && player.index < player.queue.length - 1) {
      playIndex(player.index + 1);
    } else {
      player.playing = false;
      emit('state');
    }
  }

  function rebuildQueue(startId) {
    const ids = player.order.slice();
    if (player.shuffle) {
      const rest = ids.filter((id) => id !== startId);
      shuffleInPlace(rest);
      player.queue = startId ? [startId, ...rest] : rest;
    } else {
      player.queue = ids;
    }
    player.index = Math.max(0, player.queue.indexOf(startId));
    player.currentId = startId || player.queue[0] || null;
  }

  player.playIds = (ids, startId, opts = {}) => {
    const clean = [];
    const seen = new Set();
    for (const id of ids) {
      if (!id || seen.has(id) || !getSong(id)) continue;
      seen.add(id);
      clean.push(id);
    }
    if (!clean.length) return;
    if (opts.shuffle != null) player.shuffle = !!opts.shuffle;
    player.order = clean;
    const start = startId && clean.includes(startId) ? startId : clean[0];
    player.failCount = 0;
    rebuildQueue(start);
    playIndex(Math.max(0, player.queue.indexOf(start)));
  };

  player.toggle = async () => {
    if (!player.currentId) return;
    if (!audio.src) {
      await playIndex(player.index);
      return;
    }
    if (audio.paused) {
      try { await audio.play(); } catch { /* gesture or decode */ }
    } else {
      audio.pause();
    }
  };

  player.next = () => {
    if (!player.queue.length) return;
    if (player.index < player.queue.length - 1) playIndex(player.index + 1);
    else if (player.repeat === 'all') playIndex(0);
    else {
      audio.pause();
      try { audio.currentTime = 0; } catch { /* ignore */ }
    }
  };

  player.prev = () => {
    if (!player.queue.length) return;
    if ((audio.currentTime || 0) > 3) {
      audio.currentTime = 0;
      return;
    }
    if (player.index > 0) playIndex(player.index - 1);
    else if (player.repeat === 'all') playIndex(player.queue.length - 1);
    else audio.currentTime = 0;
  };

  player.seek = (t) => {
    if (!audio.src && player.currentId) {
      player.pendingSeek = t;
      playIndex(player.index);
      return;
    }
    try { audio.currentTime = clampTime(t); } catch { /* ignore */ }
    syncPosition();
    emit('time');
  };

  player.toggleShuffle = () => {
    player.shuffle = !player.shuffle;
    const cur = player.currentId;
    if (!player.order.length) {
      emit('state');
      return;
    }
    rebuildQueue(cur);
    emit('queue');
  };

  player.cycleRepeat = () => {
    player.repeat = player.repeat === 'off' ? 'all' : player.repeat === 'all' ? 'one' : 'off';
    audio.loop = player.repeat === 'one';
    emit('state');
  };

  player.playNext = (id) => {
    if (!getSong(id)) return;
    if (!player.currentId) {
      player.playIds([id], id);
      return;
    }
    player.queue = player.queue.filter((x, idx) => x !== id || idx === player.index);
    player.order = player.order.filter((x) => x !== id);
    player.queue.splice(player.index + 1, 0, id);
    const oi = player.order.indexOf(player.currentId);
    player.order.splice(oi < 0 ? player.order.length : oi + 1, 0, id);
    emit('queue');
  };

  player.enqueue = (id) => {
    if (!getSong(id)) return;
    if (!player.currentId) {
      player.playIds([id], id);
      return;
    }
    if (!player.queue.includes(id)) player.queue.push(id);
    if (!player.order.includes(id)) player.order.push(id);
    emit('queue');
  };

  player.removeAt = (index) => {
    if (index < 0 || index >= player.queue.length || index === player.index) return;
    const id = player.queue[index];
    player.queue.splice(index, 1);
    if (index < player.index) player.index--;
    const oi = player.order.indexOf(id);
    if (oi >= 0) player.order.splice(oi, 1);
    emit('queue');
  };

  player.jump = (index) => {
    if (index < 0 || index >= player.queue.length) return;
    player.failCount = 0;
    playIndex(index);
  };

  player.removeSong = (id) => {
    const wasCurrent = player.currentId === id;
    const wasPlaying = player.playing;
    player.queue = player.queue.filter((x) => x !== id);
    player.order = player.order.filter((x) => x !== id);
    if (!player.queue.length) {
      player.clear();
      return Promise.resolve();
    }
    if (wasCurrent) {
      player.index = Math.min(player.index, player.queue.length - 1);
      return playIndex(player.index, wasPlaying);
    }
    player.index = Math.max(0, player.queue.indexOf(player.currentId));
    emit('queue');
    return Promise.resolve();
  };

  player.clear = () => {
    player.gen += 1;
    audio.pause();
    audio.removeAttribute('src');
    if (player.url) URL.revokeObjectURL(player.url);
    player.url = null;
    player.queue = [];
    player.order = [];
    player.currentId = null;
    player.index = 0;
    player.playing = false;
    updateSession();
    emit('track');
  };

  player.setVolume = (v) => {
    audio.volume = Math.min(1, Math.max(0, v));
    emit('state');
  };

  player.snapshot = () => ({
    queue: player.queue,
    order: player.order,
    index: player.index,
    shuffle: player.shuffle,
    repeat: player.repeat,
    time: audio.currentTime || 0,
    volume: audio.volume,
    currentId: player.currentId,
  });

  player.restore = (data, has) => {
    if (!data || !data.currentId || !has(data.currentId)) return;
    const queue = (data.queue || []).filter(has);
    const order = (data.order && data.order.length ? data.order : queue).filter(has);
    if (!queue.includes(data.currentId)) queue.unshift(data.currentId);
    player.queue = queue;
    player.order = order.length ? order : queue.slice();
    player.currentId = data.currentId;
    player.index = Math.max(0, player.queue.indexOf(data.currentId));
    player.shuffle = !!data.shuffle;
    player.repeat = data.repeat === 'all' || data.repeat === 'one' ? data.repeat : 'off';
    audio.loop = player.repeat === 'one';
    audio.volume = typeof data.volume === 'number' ? data.volume : 1;
    player.pendingSeek = data.time || 0;
    player.playing = false;
    emit('track');
  };

  audio.addEventListener('play', () => {
    player.playing = true;
    syncPlaybackState();
    emit('state');
  });
  audio.addEventListener('pause', () => {
    player.playing = false;
    syncPlaybackState();
    emit('state');
  });
  audio.addEventListener('timeupdate', () => {
    syncPosition();
    emit('time');
  });
  audio.addEventListener('ended', () => {
    if (player.repeat === 'one') return;
    if (player.index < player.queue.length - 1) playIndex(player.index + 1);
    else if (player.repeat === 'all' && player.queue.length) playIndex(0);
    else {
      player.playing = false;
      emit('state');
    }
  });

  if ('mediaSession' in navigator) {
    setHandler('play', () => player.toggle());
    setHandler('pause', () => audio.pause());
    setHandler('stop', () => audio.pause());
    setHandler('previoustrack', () => player.prev());
    setHandler('nexttrack', () => player.next());
    setHandler('seekto', (d) => {
      if (d && typeof d.seekTime === 'number') player.seek(d.seekTime);
    });
    setHandler('seekbackward', (d) => {
      const off = d && d.seekOffset ? d.seekOffset : 10;
      player.seek((audio.currentTime || 0) - off);
    });
    setHandler('seekforward', (d) => {
      const off = d && d.seekOffset ? d.seekOffset : 10;
      player.seek((audio.currentTime || 0) + off);
    });
  }

  return player;
}
