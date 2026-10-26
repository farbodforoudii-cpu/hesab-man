// Optional two-way sync with the ecosystem's Supabase project (shared with «زندگی من»), joined by a sync code.
// Every transaction and the settings/rules/history values travel as whole JSON records;
// the copy with the newest updatedAt wins on both sides. Off until the user signs in.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { db, raw, changes } from './db.js';

const APP = 'hesab';
const KV_KEYS = ['settings', 'rules', 'history'];
const recId = (kind, id) => `h:${kind}:${id}`;

const state = { key: null, status: 'off', error: '', lastSync: null, cursor: null, busy: false };
// at: record → updatedAt of the local copy; dirty: records waiting to be sent; gone: deleted locally.
let meta = { at: {}, dirty: {}, gone: {} };
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(state); };
const set = patch => { Object.assign(state, patch); emit(); };
const saveMeta = () => raw.set('syncMeta', meta);

// The sync code is the only secret: whoever has it shares this space. The server keeps only its hash.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(25));
  const s = [...bytes].map(b => ALPHABET[b % 32]).join('');
  return s.match(/.{5}/g).join('-');
}
// Accepts the code however it was pasted (spaces, lower case, Persian digits are not used).
export function normalizeCode(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 25 ? s.match(/.{5}/g).join('-') : null;
}

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) throw Object.assign(new Error((data && (data.message || data.error)) || res.statusText), { status: res.status });
  return data;
}

const PERSIAN_ERRORS = [
  [/unknown sync key/i, 'این کد پیدا نشد. کد را دوباره از دستگاه اول کپی کنید.'],
  [/failed to fetch|network|load failed/i, 'اتصال به سرور برقرار نشد. اینترنت یا VPN را بررسی کنید.'],
];
const persian = e => (PERSIAN_ERRORS.find(([re]) => re.test(e.message)) || [0, e.message])[1];

// Local writes (through db.js) become records to send.
function track(kind, ids, deleted) {
  const now = new Date().toISOString();
  for (const id of ids) {
    const r = recId(kind, id);
    meta.at[r] = now;
    meta.dirty[r] = true;
    if (deleted) meta.gone[r] = true; else delete meta.gone[r];
  }
  saveMeta();
  clearTimeout(timer);
  timer = setTimeout(() => sync.run(), 2500);
}
let timer;

// Bring the server's copies in. Returns true when anything on this device changed.
async function pull() {
  let changed = false, more = true;
  while (more) {
    const rows = await rpc('eco_pull', { p_key: state.key, p_app: APP, p_after: state.cursor, p_limit: 500 });
    const putTx = [], delTx = [];
    for (const { data: d } of rows) {
      if (meta.at[d.id] && meta.at[d.id] >= d.updatedAt) continue;
      if (d.kind === 'tx') (d.deleted ? delTx.push(d.key) : putTx.push(d.value));
      else if (d.kind === 'kv' && KV_KEYS.includes(d.key)) await raw.set(d.key, d.value);
      meta.at[d.id] = d.updatedAt;
      delete meta.dirty[d.id];
      if (d.deleted) meta.gone[d.id] = true; else delete meta.gone[d.id];
      changed = true;
    }
    if (putTx.length) await raw.putManyTx(putTx);
    if (delTx.length) await raw.deleteManyTx(delTx);
    if (rows.length) { state.cursor = rows[rows.length - 1].server_updated_at; await raw.set('syncCursor', state.cursor); }
    await saveMeta();
    more = rows.length === 500;
  }
  return changed;
}

async function push() {
  const ids = Object.keys(meta.dirty);
  if (!ids.length) return;
  const txById = new Map((await db.allTx()).map(t => [t.id, t]));
  const records = [];
  for (const r of ids) {
    const [, kind, key] = r.match(/^h:([^:]+):(.*)$/s);
    const base = { id: r, kind, key, app: APP, updatedAt: meta.at[r] };
    if (meta.gone[r]) records.push({ ...base, deleted: true });
    else if (kind === 'tx' && txById.has(key)) records.push({ ...base, value: txById.get(key) });
    else if (kind === 'kv') records.push({ ...base, value: (await db.get(key)) ?? null });
    else delete meta.dirty[r];
  }
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    await rpc('eco_push', { p_key: state.key, p_app: APP, p_rows: chunk });
    // Only forget what did not change again while it was being sent.
    for (const d of chunk) if (meta.at[d.id] === d.updatedAt) delete meta.dirty[d.id];
    await saveMeta();
  }
}

// First sign-in on a device: after the server's copies are in, everything that exists only here is sent.
async function seed() {
  const now = new Date().toISOString();
  const mark = r => { if (!meta.at[r]) { meta.at[r] = now; meta.dirty[r] = true; } };
  for (const t of await db.allTx()) mark(recId('tx', t.id));
  for (const k of KV_KEYS) if ((await db.get(k)) != null) mark(recId('kv', k));
  await saveMeta();
}

export const sync = {
  state,
  onChange: fn => listeners.add(fn),
  onRemote: null,

  async init() {
    state.key = (await db.get('syncKey')) || null;
    state.cursor = (await db.get('syncCursor')) || null;
    state.lastSync = (await db.get('syncLast')) || null;
    meta = (await db.get('syncMeta')) || meta;
    changes.onWrite = state.key ? track : null;
    set({ status: state.key ? 'idle' : 'off' });
    addEventListener('online', () => sync.run());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync.run(); });
  },

  // First device: make a new code and a space for it on the server.
  async create() {
    const key = newCode();
    await rpc('eco_create_space', { p_key: key }).catch(e => { throw new Error(persian(e)); });
    await sync.start(key);
    return key;
  },

  // Any other device (or the other app): join with the code copied from the first one.
  async join(input) {
    const key = normalizeCode(input);
    if (!key) throw new Error('کد کامل نیست؛ باید ۲۵ نویسه باشد.');
    await rpc('eco_pull', { p_key: key, p_app: APP, p_limit: 1 }).catch(e => { throw new Error(persian(e)); });
    await sync.start(key);
  },

  async start(key) {
    state.key = key;
    await raw.set('syncKey', key);
    state.cursor = null;
    await raw.set('syncCursor', null);
    changes.onWrite = track;
    set({ status: 'idle', error: '' });
    await sync.run({ first: true });
  },

  // Switching off keeps the data on this device; it just stops travelling.
  async signOut() {
    changes.onWrite = null;
    state.key = null;
    await raw.set('syncKey', null);
    meta = { at: {}, dirty: {}, gone: {} };
    await saveMeta();
    await raw.set('syncCursor', null);
    set({ status: 'off', error: '', cursor: null });
  },

  pending: () => Object.keys(meta.dirty).length,

  async run({ first = false } = {}) {
    if (!state.key || state.busy) return;
    if (!navigator.onLine) { set({ status: 'offline' }); return; }
    state.busy = true;
    set({ status: 'syncing', error: '' });
    try {
      // Pull first so a newer copy on the server is never overwritten by an older one here.
      const changed = await pull();
      if (first) await seed();
      await push();
      state.lastSync = new Date().toISOString();
      await raw.set('syncLast', state.lastSync);
      set({ status: 'idle' });
      if (changed && sync.onRemote) await sync.onRemote();
    } catch (e) {
      set({ status: navigator.onLine ? 'error' : 'offline', error: persian(e) });
    } finally {
      state.busy = false;
    }
  },
};
