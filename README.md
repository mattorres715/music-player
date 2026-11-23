# Music

Offline music player for files you already own. It is a mobile-first PWA styled after the YouTube Music Android app: dark theme, bottom navigation, shelves, a mini player, and a full-screen now playing view. Nothing is streamed.

Add songs with **Add music** (files or a folder) or by dropping them on the page. Audio, tags, and album art are stored in this browser with IndexedDB and keep playing with no network, including with the screen off. The Media Session API drives the lock-screen controls.

Open Library → Settings to see storage use and the version (**Music v1**).

Install it from Chrome with **Install app** / **Add to Home screen**. The service worker cache is `music-v1`; the next release should move that name to `music-v2` in `sw.js` and `js/version.js`.

```bash
node --test
```
