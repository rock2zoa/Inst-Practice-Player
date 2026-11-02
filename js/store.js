const FAV_KEY = "ytp_favorites_v1";
const SETTINGS_KEY = "ytp_settings_v1";
const DB_NAME = "ytp_audio_files";
const DB_STORE = "files";

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function getSettings() {
  return readJson(SETTINGS_KEY, {});
}

export function saveSettings(patch) {
  writeJson(SETTINGS_KEY, { ...getSettings(), ...patch });
}

export function listFavorites() {
  const list = readJson(FAV_KEY, []);
  return Array.isArray(list) ? list.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)) : [];
}

function favoriteKey(fav) {
  return fav.type === "youtube" ? `yt:${fav.videoId}` : `local:${fav.fileName}:${fav.fileSize}`;
}

export function findFavorite(identity) {
  const key = favoriteKey(identity);
  return listFavorites().find((f) => favoriteKey(f) === key) || null;
}

export function upsertFavorite(fav) {
  const list = readJson(FAV_KEY, []);
  const key = favoriteKey(fav);
  const existing = list.find((f) => favoriteKey(f) === key);
  const record = {
    ...fav,
    id: existing ? existing.id : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    savedAt: Date.now(),
  };
  const next = list.filter((f) => favoriteKey(f) !== key);
  next.push(record);
  writeJson(FAV_KEY, next);
  return record;
}

export async function removeFavorite(id) {
  const list = readJson(FAV_KEY, []);
  writeJson(
    FAV_KEY,
    list.filter((f) => f.id !== id)
  );
  try {
    await deleteAudio(id);
  } catch (e) {
    /* nothing stored for this one */
  }
}

export function exportFavoritesJson() {
  const items = listFavorites().map(({ hasAudio, ...rest }) => rest);
  return JSON.stringify({ app: "ytpractice-web", version: 1, favorites: items }, null, 2);
}

export function importFavoritesJson(text) {
  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : parsed.favorites;
  if (!Array.isArray(items)) throw new Error("즐겨찾기 형식이 아닙니다");
  let count = 0;
  for (const raw of items) {
    if (!raw || (raw.type !== "youtube" && raw.type !== "local")) continue;
    if (raw.type === "youtube" && !raw.videoId) continue;
    if (raw.type === "local" && !raw.fileName) continue;
    const existing = findFavorite(raw);
    upsertFavorite({ ...raw, hasAudio: existing ? existing.hasAudio : false });
    count += 1;
  }
  return count;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const result = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function saveAudio(id, arrayBuffer) {
  return withStore("readwrite", (store) => store.put(arrayBuffer, id));
}

export function loadAudio(id) {
  return withStore("readonly", (store) => store.get(id));
}

export function deleteAudio(id) {
  return withStore("readwrite", (store) => store.delete(id));
}
