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

// Writes that sync should know about. Set by sync.js; null while sync is off.
export const changes = { onWrite: null };
const SYNCED_KEYS = ['settings', 'rules', 'history'];
const note = (kind, ids, deleted = false) => changes.onWrite && changes.onWrite(kind, ids, deleted);

// Plain writes without telling sync; used when applying copies that came from the server.
export const raw = {
  putManyTx: list => run('tx', 'readwrite', s => { for (const t of list) s.put(t); }),
  deleteManyTx: ids => run('tx', 'readwrite', s => { for (const id of ids) s.delete(id); }),
  set: (key, val) => run('kv', 'readwrite', s => { s.put(val, key); }),
};

export const db = {
  allTx: () => run('tx', 'readonly', s => s.getAll()),
  putTx: tx => run('tx', 'readwrite', s => { s.put(tx); }).then(() => note('tx', [tx.id])),
  putManyTx: list => run('tx', 'readwrite', s => { for (const t of list) s.put(t); }).then(() => note('tx', list.map(t => t.id))),
  deleteTx: id => run('tx', 'readwrite', s => { s.delete(id); }).then(() => note('tx', [id], true)),
  // Wiping this device is local only; sync is switched off by the caller.
  clearTx: () => run('tx', 'readwrite', s => { s.clear(); }),
  get: key => run('kv', 'readonly', s => s.get(key)),
  set: (key, val) => run('kv', 'readwrite', s => { s.put(val, key); }).then(() => { if (SYNCED_KEYS.includes(key)) note('kv', [key]); }),
};

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}
