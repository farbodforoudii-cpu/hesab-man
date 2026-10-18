// Small IndexedDB wrapper. All data is also kept in memory; writes go through to disk.
const DB_NAME = 'finance-os';
const VERSION = 1;

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tx')) db.createObjectStore('tx', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

export const db = {
  allTx: () => run('tx', 'readonly', s => s.getAll()),
  putTx: tx => run('tx', 'readwrite', s => { s.put(tx); }),
  putManyTx: list => run('tx', 'readwrite', s => { for (const t of list) s.put(t); }),
  deleteTx: id => run('tx', 'readwrite', s => { s.delete(id); }),
  clearTx: () => run('tx', 'readwrite', s => { s.clear(); }),
  get: key => run('kv', 'readonly', s => s.get(key)),
  set: (key, val) => run('kv', 'readwrite', s => { s.put(val, key); }),
};

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}
