// Optional two-way sync with the ecosystem's Supabase project (shared with «زندگی من»).
// Every transaction and the settings/rules/history values travel as whole JSON records;
// the copy with the newest updatedAt wins on both sides. Off until the user signs in.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { db, raw, changes } from './db.js';

const APP = 'hesab';
const KV_KEYS = ['settings', 'rules', 'history'];
const recId = (kind, id) => `h:${kind}:${id}`;

const state = { session: null, status: 'off', error: '', lastSync: null, cursor: null, busy: false };
// at: record → updatedAt of the local copy; dirty: records waiting to be sent; gone: deleted locally.
let meta = { at: {}, dirty: {}, gone: {} };
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(state); };
const set = patch => { Object.assign(state, patch); emit(); };
const saveMeta = () => raw.set('syncMeta', meta);

async function call(path, { method = 'GET', body, auth = true, prefer } = {}) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (auth && state.session) headers.Authorization = `Bearer ${state.session.access_token}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(SUPABASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    const msg = (data && (data.msg || data.message || data.error_description || data.error)) || res.statusText;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

async function saveSession(s) {
  state.session = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (s.expires_in - 60) * 1000, user: { id: s.user.id, email: s.user.email } } : null;
  await raw.set('syncSession', state.session);
}

async function fresh() {
  if (Date.now() < state.session.expires_at) return;
  await saveSession(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: state.session.refresh_token } }));
}

const PERSIAN_ERRORS = [
  [/invalid login credentials/i, 'ایمیل یا رمز درست نیست.'],
  [/email not confirmed/i, 'نخست ایمیل را تأیید کنید (پیوند داخل ایمیل)، سپس دوباره وارد شوید.'],
  [/already registered/i, 'این ایمیل پیش‌تر ثبت شده است؛ «ورود» را بزنید.'],
  [/password should be at least/i, 'رمز باید دست‌کم ۶ نویسه باشد.'],
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
    const q = `/rest/v1/life_items?select=data,server_updated_at&app=eq.${APP}&order=server_updated_at.asc&limit=500${state.cursor ? `&server_updated_at=gt.${encodeURIComponent(state.cursor)}` : ''}`;
    const rows = await call(q);
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
    await call('/rest/v1/life_items?on_conflict=user_id,id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: chunk.map(d => ({ user_id: state.session.user.id, id: d.id, kind: d.kind, app: APP, data: d })),
    });
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
    state.session = (await db.get('syncSession')) || null;
    state.cursor = (await db.get('syncCursor')) || null;
    state.lastSync = (await db.get('syncLast')) || null;
    meta = (await db.get('syncMeta')) || meta;
    changes.onWrite = state.session ? track : null;
    set({ status: state.session ? 'idle' : 'off' });
    addEventListener('online', () => sync.run());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync.run(); });
  },

  async signUp(email, password) {
    const s = await call('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password } }).catch(e => { throw new Error(persian(e)); });
    if (s && s.access_token) { await sync.start(s); return 'in'; }
    return 'confirm';
  },

  async signIn(email, password) {
    const s = await call('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } }).catch(e => { throw new Error(persian(e)); });
    await sync.start(s);
  },

  async start(s) {
    await saveSession(s);
    state.cursor = null;
    await raw.set('syncCursor', null);
    changes.onWrite = track;
    set({ status: 'idle', error: '' });
    await sync.run({ first: true });
  },

  // Signing out keeps the data on this device; it just stops travelling.
  async signOut() {
    changes.onWrite = null;
    await saveSession(null);
    meta = { at: {}, dirty: {}, gone: {} };
    await saveMeta();
    await raw.set('syncCursor', null);
    set({ status: 'off', error: '', cursor: null });
  },

  pending: () => Object.keys(meta.dirty).length,

  async run({ first = false } = {}) {
    if (!state.session || state.busy) return;
    if (!navigator.onLine) { set({ status: 'offline' }); return; }
    state.busy = true;
    set({ status: 'syncing', error: '' });
    try {
      await fresh();
      // Pull first so a newer copy on the server is never overwritten by an older one here.
      const changed = await pull();
      if (first) await seed();
      await push();
      state.lastSync = new Date().toISOString();
      await raw.set('syncLast', state.lastSync);
      set({ status: 'idle' });
      if (changed && sync.onRemote) await sync.onRemote();
    } catch (e) {
      if (e.status === 401) { await saveSession(null); changes.onWrite = null; set({ status: 'off', error: 'نشست به پایان رسید؛ دوباره وارد شوید.' }); }
      else set({ status: navigator.onLine ? 'error' : 'offline', error: persian(e) });
    } finally {
      state.busy = false;
    }
  },
};
