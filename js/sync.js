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

// «زندگی من»: bills for finished packages (read here) and the answers given here (payments).
// Kept on this device apart from transactions; only payment records are ever written to the life side.
let life = { bills: {}, pays: {}, months: {}, money: {}, status: null, cursor: null, out: [] };
const saveLife = () => raw.set('lifeMirror', life);
async function pullLife() {
  let changed = false, more = true;
  while (more) {
    const rows = await rpc('eco_pull', { p_key: state.key, p_app: 'life', p_after: life.cursor, p_limit: 1000 });
    for (const { data: d } of rows) {
      if (d.kind === 'bill') { if (d.deleted) delete life.bills[d.seriesId]; else life.bills[d.seriesId] = d; changed = true; }
      else if (d.kind === 'payment' && (!life.pays[d.seriesId] || life.pays[d.seriesId].updatedAt <= d.updatedAt)) { life.pays[d.seriesId] = d; changed = true; }
      else if (d.kind === 'monthsum') { life.months[d.month] = d; changed = true; }
      else if (d.kind === 'lifestatus') { life.status = d; changed = true; }
      else if (d.kind === 'moneysum' && (!life.money[d.month] || life.money[d.month].updatedAt <= d.updatedAt)) life.money[d.month] = d;
    }
    if (rows.length) life.cursor = rows[rows.length - 1].server_updated_at;
    more = rows.length === 1000;
  }
  await saveLife();
  return changed;
}
async function pushLife() {
  if (!life.out.length) return;
  const out = life.out;
  await rpc('eco_push', { p_key: state.key, p_app: 'life', p_rows: out });
  life.out = life.out.filter(x => !out.includes(x));
  await saveLife();
}

// «فربد کوچینگ»: sales Farbod approved on the coach page (read here) and the answers given here (receipts).
// Same rule as «زندگی من»: kept apart from transactions, and income is recorded only on a tap.
let coach = { sales: {}, rcv: {}, cursor: null, out: [] };
const saveCoach = () => raw.set('coachMirror', coach);
async function pullCoach() {
  let changed = false, more = true;
  while (more) {
    const rows = await rpc('eco_pull', { p_key: state.key, p_app: 'coach', p_after: coach.cursor, p_limit: 1000 });
    for (const { data: d } of rows) {
      if (d.kind === 'sale') { if (d.deleted) delete coach.sales[d.saleId]; else coach.sales[d.saleId] = d; changed = true; }
      else if (d.kind === 'receipt' && (!coach.rcv[d.saleId] || coach.rcv[d.saleId].updatedAt <= d.updatedAt)) { coach.rcv[d.saleId] = d; changed = true; }
    }
    if (rows.length) coach.cursor = rows[rows.length - 1].server_updated_at;
    more = rows.length === 1000;
  }
  await saveCoach();
  return changed;
}
async function pushCoach() {
  if (!coach.out.length) return;
  const out = coach.out;
  await rpc('eco_push', { p_key: state.key, p_app: 'coach', p_rows: out });
  coach.out = coach.out.filter(x => !out.includes(x));
  await saveCoach();
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
    life = { ...life, ...((await db.get('lifeMirror')) || {}) };
    coach = { ...coach, ...((await db.get('coachMirror')) || {}) };
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
    life = { bills: {}, pays: {}, months: {}, money: {}, status: null, cursor: null, out: [] };
    await saveLife();
    coach = { sales: {}, rcv: {}, cursor: null, out: [] };
    await saveCoach();
    await raw.set('syncCursor', null);
    set({ status: 'off', error: '', cursor: null });
  },

  pending: () => Object.keys(meta.dirty).length,

  // Finished packages from «زندگی من» still waiting for an answer here, oldest first.
  lifeInbox() {
    if (!state.key) return [];
    return Object.values(life.bills).filter(b => {
      const p = life.pays[b.seriesId];
      return (!p || p.how === 'undo') && (b.total > 0 || b.count > 0);
    }).sort((a, b) => a.to.localeCompare(b.to));
  },
  lifeBill: id => life.bills[id],
  // Approved «فربد کوچینگ» sales still waiting for an answer here, oldest first.
  coachInbox() {
    if (!state.key) return [];
    return Object.values(coach.sales).filter(x => { const r = coach.rcv[x.saleId]; return !r || r.how === 'undo'; })
      .sort((a, b) => String(a.approvedAt).localeCompare(String(b.approvedAt)));
  },
  coachSale: id => coach.sales[id],
  // how: 'tx' (recorded here now), 'existing' (already recorded), 'skip', 'undo'.
  async answerSale(saleId, how, txId = null) {
    const now = new Date().toISOString();
    const r = { id: `rcv_${saleId}`, kind: 'receipt', saleId, how, txId, at: now, createdAt: coach.rcv[saleId]?.createdAt || now, updatedAt: now };
    coach.rcv[saleId] = r;
    coach.out = coach.out.filter(x => x.saleId !== saleId).concat(r);
    await saveCoach();
    clearTimeout(timer); timer = setTimeout(() => sync.run(), 800);
  },
  // The shared monthly report: hours and sessions from «زندگی من», per month (YYYY-MM), and its open receivables.
  lifeMonth: k => life.months[k] || null,
  lifeStatus: () => life.status,
  // This app's half of the report: work income per month, sent only when it changed.
  async publishMoney(rows) {
    if (!state.key) return;
    const now = new Date().toISOString(), out = [];
    for (const r of rows) {
      const old = life.money[r.month];
      if (old && old.work === r.work && old.expense === r.expense) continue;
      const rec = { id: `money_${r.month}`, kind: 'moneysum', month: r.month, work: r.work, expense: r.expense, createdAt: old?.createdAt || now, updatedAt: now };
      life.money[r.month] = rec; out.push(rec);
    }
    if (!out.length) return;
    life.out = life.out.filter(x => !out.some(o => o.id === x.id)).concat(out);
    await saveLife();
    clearTimeout(timer); timer = setTimeout(() => sync.run(), 1500);
  },
  // how: 'tx' (recorded here now), 'existing' (already recorded), 'skip' (not to be collected), 'undo'.
  async answerBill(seriesId, how, txId = null) {
    const now = new Date().toISOString();
    const p = { id: `pay_${seriesId}`, kind: 'payment', seriesId, how, txId, at: now, createdAt: life.pays[seriesId]?.createdAt || now, updatedAt: now };
    life.pays[seriesId] = p;
    life.out = life.out.filter(x => x.seriesId !== seriesId).concat(p);
    await saveLife();
    clearTimeout(timer); timer = setTimeout(() => sync.run(), 800);
  },

  async run({ first = false } = {}) {
    if (!state.key || state.busy) return;
    if (!navigator.onLine) { set({ status: 'offline' }); return; }
    state.busy = true;
    set({ status: 'syncing', error: '' });
    try {
      // Pull first so a newer copy on the server is never overwritten by an older one here.
      let changed = await pull();
      if (first) await seed();
      await push();
      await pushLife();
      changed = (await pullLife()) || changed;
      await pushCoach();
      changed = (await pullCoach()) || changed;
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
