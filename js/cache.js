// Downloaded audio is kept in IndexedDB so a project opens instantly (and
// offline) the next time.

const DB = 'loop-cache';
const STORE = 'files';
let dbPromise = null;

function open() {
  if (!('indexedDB' in self)) return Promise.reject(new Error('no indexedDB'));
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const get = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
export const put = (key, value) => tx('readwrite', (s) => s.put(value, key)).catch(() => undefined);
export const clear = () => tx('readwrite', (s) => s.clear()).catch(() => undefined);
