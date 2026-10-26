import { db, requestPersistence } from './db.js';
import { sync } from './sync.js';
import { TYPES, MAIN_TYPES, typesFor, CATEGORIES, PICKABLE_CATS, inferFromText, newId } from './model.js';
import { buildTemplates, suggest, complete, bestTemplateForText } from './suggest.js';
import { parseStatement, importRows, learnRule, classify } from './bank.js';
import { monthSummary, balanceAt, bankCheck, balances, txMonth } from './stats.js';
import { toJalali, fromJalali, monthKey, monthLabel, shiftMonth, monthRange, monthLength, formatJalali, dayLabel, faDigits } from './jalali.js';
import { fmt, fmtShort, iso, tomanWords, esc, norm } from './format.js';
import { monthsSeries, analyze, compare, kpis } from './analysis.js';
import { MK, TARGET, fetchMarket, stats as mstats, signal as msignal, plan as mplan } from './market.js';
import { createChart, createSeriesMarkers, AreaSeries, LineSeries, LineStyle, CrosshairMode, LastPriceAnimationMode } from '../vendor/lightweight-charts.mjs';

const S = {
  tx: [], settings: {}, rules: { parties: {}, overrides: [] }, history: null, tpl: [],
  view: 'entry', amount: '', dayBack: 0, step: 'amount', dir: 'out', what: '',
  month: monthKey(new Date()), listFilter: 'all', listQuery: '', listLimit: 60, mk: { k: 'usd', f: '6m', all: false }, tr: { field: 'expense', cmps: [], pct: false, frame: 'all', hover: null, picking: false },
};
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $ov = document.getElementById('overlay');

// ---------- icons (simple line glyphs) ----------
const ICON = {
  add: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
  ruler: '<svg viewBox="0 0 24 24"><path d="M4 16L16 4l4 4L8 20z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M3 17l5-5 4 3 8-8"/><path d="M15 7h5v5"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  chevL: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  chevR: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M9 6h11v12H9l-6-6z"/><path d="M13 10l4 4M17 10l-4 4"/></svg>',
};

// ---------- data ----------
async function boot() {
  const [tx, settings, rules, history] = await Promise.all([db.allTx(), db.get('settings'), db.get('rules'), db.get('history')]);
  S.tx = tx || [];
  S.settings = settings || {};
  S.rules = rules || { parties: {}, overrides: [] };
  S.history = history || null;
  if (S.settings.startDate && new Date(S.settings.startDate) > new Date()) {
    const firsts = S.tx.filter(t => t.src === 'manual').map(t => +new Date(t.ts));
    const d = new Date(firsts.length ? Math.min(...firsts) - 60000 : Date.now()).toISOString();
    Object.assign(S.settings, { startDate: d, openingDate: d });
    await saveSettings();
  }
  await fixAban1();
  await fixLateMehr();
  await fixBlu0803();
  await fixBox0805();
  await forgiveSeenzhin();
  S.market = (await db.get('market')) || null;
  refresh();
  S.view = (isTablet() || window.innerWidth >= 820) && S.settings.startDate ? 'dash' : 'entry';
  S.step = 'amount';
  openLink();
  render();
  requestPersistence();
  setupUpdates();
  loadMarket(); setInterval(loadMarket, 30 * 60e3);
  // Sync starts after the one-time fixes above, so they never overwrite another device's copy.
  await sync.init();
  sync.onRemote = reload;
  await fixLifeDup0804();
  // What «زندگی من» sent earlier (bills, monthly hours) is on this device already; show it before the next pull.
  if (sync.state.key) render();
  sync.onChange(() => { if (S.view === 'settings' && !document.querySelector('#sync-code:focus')) render(); });
  sync.run();
}

// Live prices: keep the last copy for offline use; redraw the screens that show money in assets.
async function loadMarket() {
  try {
    const M = await fetchMarket();
    if (!M || !M.now || (S.market && S.market.at === M.at)) return;
    S.market = M; await db.set('market', M);
    if (['dash', 'an', 'assets'].includes(S.view) && !document.querySelector('.sheet')) render();
  } catch { /* offline: keep the cached copy */ }
}
const MARKET_KINDS = ['usd', 'eur', 'gold', 'silver'];
// Price used for an asset: the live market price when there is one, otherwise the one typed in.
const livePrice = k => (MARKET_KINDS.includes(k) && S.market && S.market.now && S.market.now[k] && S.market.now[k].p) || assetsState().prices[k] || 0;
const marketAge = () => S.market ? ago(S.market.at) : '';
function heldByKind() {
  const o = { usd: 0, eur: 0, gold: 0, silver: 0 };
  for (const it of assetsState().items) if (o[it.kind] != null) o[it.kind] += (it.qty || 0) * livePrice(it.kind);
  return o;
}
function currentPlan() {
  const T = scoped(), series = monthsSeries(S.history, T, S.settings.startDate), key = monthKey(new Date());
  const done = series.filter(m => !m.running && (m.expense || m.work)).slice(-3);
  const avgExp = done.length ? done.reduce((a, m) => a + (m.expense || 0), 0) / done.length : 0;
  return mplan({ series, held: heldByKind(), M: S.market, workNow: monthSummary(T, key).work || 0, cash: balanceAt(S.tx, S.settings), avgExp });
}

// A newer copy arrived from another device: read it in and redraw what is on screen.
async function reload() {
  const [tx, settings, rules, history] = await Promise.all([db.allTx(), db.get('settings'), db.get('rules'), db.get('history')]);
  S.tx = tx || [];
  S.settings = settings || {};
  S.rules = rules || { parties: {}, overrides: [] };
  S.history = history || null;
  refresh();
  render();
}

// Links from other apps (e.g. Life OS after a coaching session):
//   …/hesab-man/#add?amount=3500000&what=جلسه پویان&dir=in&period=1405-08
// opens «برای چی؟» prefilled; nothing is saved until the user taps «ثبت».
function openLink() {
  const m = location.hash.match(/^#\/?add\?(.*)$/);
  if (!m || !S.settings.startDate) return;
  const q = new URLSearchParams(m[1]), amount = parseAmount(q.get('amount') || '');
  history.replaceState(null, '', location.pathname);
  const dir = q.get('dir') === 'in' ? 'in' : 'out', what = q.get('what') || '';
  // Without an amount, ask «چقدر؟» first and keep the description for the next step.
  if (!amount) Object.assign(S, { view: 'entry', step: 'amount', amount: '', dir, linkWhat: what });
  else Object.assign(S, { view: 'entry', step: 'what', amount: String(amount), dir, what });
  S.linkPeriod = /^\d{4}-\d{2}$/.test(q.get('period') || '') ? q.get('period') : null;
}
window.addEventListener('hashchange', () => { if (/^#\/?add\?/.test(location.hash)) { openLink(); render(); } });

// One-off (1405/08/02): eight purchases from 1 Aban were typed on the evening of 2 Aban.
// Move them back to their bank times. Matches by amount, runs once per device.
async function fixAban1() {
  if (S.settings.fixAban1) return;
  const times = { 1363000: [11, 41], 495000: [12, 15], 1200000: [12, 17], 300000: [13, 26], 20000: [14, 3], 5335000: [15, 38], 420000: [15, 50], 230000: [17, 56] };
  const moved = [];
  for (const t of S.tx) {
    const d = new Date(t.ts), j = toJalali(d);
    const hm = times[t.amount];
    if (!hm || t.src !== 'manual' || t.dir !== 'out' || j.jy !== 1405 || j.jm !== 8 || j.jd !== 2 || d.getHours() < 20) continue;
    t.ts = fromJalali(1405, 8, 1, hm[0], hm[1]).toISOString();
    t.updated = new Date().toISOString();
    delete times[t.amount];
    moved.push(t);
  }
  if (moved.length) await db.putManyTx(moved);
  S.settings.fixAban1 = true;
  await saveSettings();
}

// One-off reconciliation with the Blu statement of 1405/08/01–03 (confirmed by Farbod):
// the 7.666M to Seenzhin was a loan out, not money back; the start balance is the bank's; a missed VPN
// purchase and three card-transfer fees are added. Afterwards the app equals the bank to the toman.
async function fixBlu0803() {
  if (S.settings.fixBlu0803) return;
  const sz = S.tx.find(t => t.ctx === 'seenzhin' && t.type === 'reimburse' && t.amount === 7666000 && txMonth(t) === '1405-08');
  if (!sz) return;
  const now = new Date().toISOString(), at = (h, m) => fromJalali(1405, 8, 3, h, m).toISOString();
  Object.assign(sz, { dir: 'out', type: 'on_behalf', desc: 'قرض به Seenzhin', cp: 'Seenzhin', ts: at(12, 17), updated: now });
  const add = [
    { id: 'blu0803-vpn', ts: at(20, 4), dir: 'out', amount: 1162000, desc: 'VPN', cp: '', type: 'expense', cat: 'digital', ctx: 'personal', src: 'manual', created: now, updated: now, status: 'ok' },
    { id: 'blu0803-fee', ts: at(20, 11), dir: 'out', amount: 6100, desc: 'کارمزد کارت‌به‌کارت (۳ مورد)', cp: '', type: 'expense', cat: 'fees', ctx: 'personal', src: 'manual', created: now, updated: now, status: 'ok' },
  ].filter(t => !S.tx.some(x => x.id === t.id));
  S.tx.push(...add);
  await db.putManyTx([sz, ...add]);
  if (S.settings.openingBalance === 52615249) S.settings.openingBalance = 54274098.5;
  S.settings.fixBlu0803 = true;
  await saveSettings();
}

// One-off (1405/08/05): Blu's home balance leaves the Box out; the statement balance includes it.
// On 1 Aban the Box already held 2,535,350 (today 2,733,255 = that + the three round-ups of 4 Aban).
// So the start balance drops by that amount and the Box becomes its own asset, growing with round-ups.
async function fixBox0805() {
  if (S.settings.fixBox0805 || S.settings.openingBalance !== 54274098.5) return;
  const BOX0 = 2535350;
  S.settings.openingBalance -= BOX0;
  const A = assetsState();
  if (!A.items.some(it => it.kind === 'box')) A.items.push({ id: newId(), kind: 'box', label: 'باکس بلو', qty: BOX0, since: S.settings.roundSince || new Date().toISOString() });
  S.settings.fixBox0805 = true;
  await saveSettings();
}

// One-off (1405/08/04): five finished packages from «زندگی من» were received here although the money was
// already counted: three in the Numbers months (bank deposits of 31 Mordad, 29 Shahrivar, 27 Mehr) and two
// as the 2 Aban deposits recorded by hand. Remove the duplicates and tell «زندگی من» they were paid.
async function fixLifeDup0804() {
  if (S.settings.fixLifeDup0804) return;
  const links = { impv2_2: null, impv2_3: null, impv2_4: null, impv4_4: 37500000, impv1_4: 36500000 };
  const dup = S.tx.filter(t => t.src === 'life' && t.life in links);
  for (const t of dup) {
    await delTx(t.id);
    const same = links[t.life] && S.tx.find(x => x.src === 'manual' && x.type === 'income_work' && x.amount === links[t.life] && x.period === '1405-07' && !x.life);
    if (same) await putTx({ ...same, life: t.life });
    if (sync.state.key) await sync.answerBill(t.life, 'existing', same ? same.id : null);
  }
  // Same day, two card amounts typed rounded: the bank has 665,070 and 824,025.
  for (const [was, is] of [[665000, 665070], [824000, 824025]]) {
    const t = S.tx.find(x => x.src === 'manual' && x.amount === was && monthKey(new Date(x.ts)) === '1405-08' && toJalali(new Date(x.ts)).jd === 4);
    if (t) await putTx({ ...t, amount: is });
  }
  S.settings.fixLifeDup0804 = true;
  await saveSettings();
  if (dup.length) render();
}

// One-off (1405/08/03): what Seenzhin still owed at the end of Mehr was let go as help.
// Needs the history bundle that separates Seenzhin money (rev 5+), so it also runs after loading it.
async function forgiveSeenzhin() {
  if (S.settings.szForgive || !S.history || (S.history.rev || 1) < 5 || !S.history.months['1405-07']) return;
  const left = Math.round(seenzhinOwed('1405-07'));
  if (left > 0) { S.settings.szForgive = { '1405-07': left }; await saveSettings(); }
}

// One-off (1405/08/02): two coaching payments that arrived on 2 Aban belong to Mehr.
async function fixLateMehr() {
  if (S.settings.fixLateMehr) return;
  const moved = [];
  for (const amt of [36500000, 37500000]) {
    const t = S.tx.find(x => x.dir === 'in' && x.amount === amt && !x.period && txMonth(x) === '1405-08');
    if (!t) continue;
    Object.assign(t, { period: '1405-07', type: 'income_work', ctx: 'coaching', status: 'ok', updated: new Date().toISOString() });
    moved.push(t);
  }
  if (moved.length) await db.putManyTx(moved);
  S.settings.fixLateMehr = true;
  await saveSettings();
}

function refresh() { S.tpl = buildTemplates(S.tx.filter(t => !isRound(t))); clearTimeout(moneyTimer); moneyTimer = setTimeout(publishMoney, 2000); }
// This app's half of the shared monthly report with «زندگی من»: work income and living cost per month.
let moneyTimer;
function publishMoney() {
  const rows = monthsSeries(S.history, scoped(), S.settings.startDate).map(m => ({ month: m.key, work: Math.round(m.work || 0), expense: Math.round(m.expense || 0) }));
  sync.publishMoney(rows).catch(() => {});
}

// Self-updating: whenever the app is opened or comes back online, look for a new version and
// switch to it automatically (only while nothing is being typed).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.dayBack) { S.dayBack = 0; if (S.view === 'entry') render(); }
});

function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  const idle = () => !$ov.innerHTML && !Number(S.amount) && !(S.what || '').trim();
  const swap = () => { if (reloading) return; if (idle()) { reloading = true; location.reload(); } else setTimeout(swap, 4000); };
  if (navigator.serviceWorker.controller) navigator.serviceWorker.addEventListener('controllerchange', swap);
  navigator.serviceWorker.register('sw.js').then(reg => {
    const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    check();
  }).catch(() => {});
}

async function putTx(list) {
  list = [].concat(list);
  const now = new Date().toISOString();
  for (const t of list) {
    t.updated = now;
    const i = S.tx.findIndex(x => x.id === t.id);
    if (i >= 0) S.tx[i] = t; else S.tx.push(t);
  }
  const { put, drop } = syncRoundUps(list, now);
  await db.putManyTx([...list, ...put]);
  for (const id of drop) await db.deleteTx(id);
  refresh();
}

async function delTx(id) {
  const gone = S.tx.filter(t => t.id === id || t.ru === id).map(t => t.id);
  S.tx = S.tx.filter(t => !gone.includes(t.id));
  for (const x of gone) await db.deleteTx(x);
  refresh();
}

// Blu «رند»: every card purchase is rounded up to the next step and the difference goes to the Box.
// Each expense gets a hidden companion «رند بلو» saving so the balance stays equal to Blu's.
const isRound = t => t.src === 'roundup';
function roundFor(t) {
  const st = S.settings;
  if (!st.roundUp || t.type !== 'expense' || t.src !== 'manual' || !st.roundSince || t.created < st.roundSince) return null;
  const step = st.roundStep || 100000, r = (step - t.amount % step) % step;
  return r;
}
function syncRoundUps(list, now) {
  const put = [], drop = [];
  for (const t of list) {
    if (isRound(t)) continue;
    const want = roundFor(t);
    const c = S.tx.find(x => x.ru === t.id);
    if (want == null) { if (c && t.type !== 'expense') drop.push(c.id); continue; }
    if (!want) { if (c) drop.push(c.id); continue; }
    const comp = { ...(c || { id: newId(), created: now }), ru: t.id, src: 'roundup', dir: 'out', type: 'asset', cat: null, ctx: 'personal',
      amount: want, desc: 'رند بلو', cp: 'باکس بلو', ts: new Date(new Date(t.ts).getTime() + 1000).toISOString(), status: 'ok', updated: now };
    const i = S.tx.findIndex(x => x.id === comp.id);
    if (i >= 0) S.tx[i] = comp; else S.tx.push(comp);
    put.push(comp);
  }
  if (drop.length) S.tx = S.tx.filter(x => !drop.includes(x.id));
  return { put, drop };
}

const saveSettings = () => db.set('settings', S.settings);
const saveRules = () => db.set('rules', S.rules);

// From the start date on, only new data counts; older history is kept only as memory for suggestions.
const live = t => S.settings.showHistory || !S.settings.startDate || t.ts >= S.settings.startDate;
const scoped = () => S.tx.filter(live);
const pendingList = () => S.tx.filter(t => t.status === 'pending' && live(t));

// ---------- helpers ----------
const toAscii = s => String(s || '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const parseAmount = s => Number(toAscii(s).replace(/[^\d.]/g, '')) || 0;

function entryDate() {
  const d = new Date();
  d.setDate(d.getDate() - S.dayBack);
  return d;
}

function roundNote(t) {
  const c = S.tx.find(x => x.ru === t.id);
  return c ? `، رند ${esc(fmtShort(c.amount))}` : '';
}

function subtitle(t) {
  if (!t.type) return 'نیاز به بررسی';
  if (t.type === 'expense') return t.cat ? CATEGORIES[t.cat].label : 'خرج';
  return TYPES[t.type].label;
}

const dotColor = t => t.type === 'expense' ? (CATEGORIES[t.cat] || CATEGORIES.other).color
  : t.dir === 'in' ? '#34c759' : '#8e8e93';

const isTransfer = t => t.type === 'transfer_in' || t.type === 'transfer_out';
function amountHtml(t) {
  const cls = isTransfer(t) ? 'neutral' : t.dir === 'in' ? 'in' : '';
  return `<span class="amt ${cls}">${t.dir === 'in' ? '+' : ''}${fmt(t.amount)}</span>`;
}

function fromTemplate(m, amount, ts) {
  return {
    id: newId(), ts: ts.toISOString(), dir: m.dir, amount,
    desc: m.desc, cp: m.cp || '', type: m.type, cat: m.type === 'expense' ? m.cat : null, ctx: m.ctx || 'personal',
    status: m.type === 'expense' && !m.cat ? 'pending' : 'ok', src: 'manual', created: new Date().toISOString(),
  };
}

let toastTimer = null;
function toast(text, undo) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button>واگرد</button>' : ''}`;
  document.body.appendChild(el);
  if (undo) el.querySelector('button').onclick = async () => { el.remove(); await undo(); render(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), undo ? 5000 : 2500);
}

// ---------- motion ----------
const REDUCED = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
let animTimer = null;
const easeOut = t => 1 - Math.pow(1 - t, 3);

// Count numbers up from zero; roll the balance digits like an odometer.
// Big numbers read like the reference: the whole part bright, decimals and units faded.
const NICE = '.b-hero, .b-value, .bc-total, .mb-num, .tl-self';
function niceNum(el) {
  el.innerHTML = esc(el.textContent)
    .replace(/(٫[۰-۹]+)/, '<span class="dim">$1</span>')
    .replace(/\s?(میلیون|میلیارد|هزار|٪)/, '<span class="unit">$1</span>');
}

function animateNumbers(root) {
  root.querySelectorAll('[data-cu]').forEach(el => {
    const to = Number(el.dataset.cu), f = el.dataset.f;
    if (!to || el.dataset.raw) return;
    const show = v => { el.textContent = f === 'int' ? faDigits(Math.round(v)) : f === 'full' ? fmt(v) : f === 'ring' ? ringNum(v, +el.dataset.div) : fmtShort(v); if (el.matches(NICE)) niceNum(el); };
    const t0 = performance.now(), dur = 700;
    const step = now => { const k = Math.min(1, (now - t0) / dur); show(to * easeOut(k)); if (k < 1) requestAnimationFrame(step); };
    show(0); requestAnimationFrame(step);
  });
  root.querySelectorAll('[data-odo]').forEach(odometer);
}

// Odometer: every digit rolls from the value you saw last time to the value now, so a change is
// visible the moment the screen opens. Unchanged digits stay still; a chip shows the difference.
const DIG = '۰۱۲۳۴۵۶۷۸۹';
// «+۵۶٫۲ میلیون» as plain text: the sign sits inside the number's isolate, so it never drifts to the unit's side.
const sgnShort = v => v < 0 ? fmtShort(v) : fmtShort(v).replace('\u2066', '\u2066+');
// «−۲۵۰ هزار»: sign glued to the digits in their own LTR island, the unit after them.
const signedShort = (v, plus = v > 0) => { const [n, ...u] = fmtShort(Math.abs(v)).split(' '); return `<bdi dir="ltr">${plus ? '+' : '−'}${n}</bdi> ${u.join(' ')}`; };
function odometer(el) {
  const to = Number(el.dataset.odo), key = 'odo:' + (el.dataset.odoKey || 'bal');
  const prev = Number(LS(key) ?? NaN);
  try { localStorage.setItem(key, String(to)); } catch {}
  // Same value as last time: roll in from zero like before. Changed: roll from the old value.
  const changed = Number.isFinite(prev) && prev !== to, from = changed ? prev : 0;
  const text = fmt(to), old = [...fmt(Math.abs(from))].filter(c => DIG.includes(c));
  const cut = text.lastIndexOf(',');
  const nd = [...text].filter(c => DIG.includes(c)).length;
  let di = 0;
  el.innerHTML = [...text].map((ch, i) => {
    if (!DIG.includes(ch)) return `<span${cut >= 0 && i >= cut ? ' class="dim"' : ''}>${ch}</span>`;
    const back = nd - 1 - di++, o = old[old.length - 1 - back];
    const fromD = o ? DIG.indexOf(o) : 0, toD = DIG.indexOf(ch);
    return `<span class="odo${cut >= 0 && i > cut ? ' dim' : ''}"><span class="odo-w">${ch}</span><span class="odo-strip" data-f="${fromD}" data-d="${toD}" style="transform:translateY(${-fromD * 10}%)">${[...DIG].map(d => `<span>${d}</span>`).join('')}</span></span>`;
  }).join('');
  const diff = to - from;
  if (changed && Math.abs(diff) >= 1 && !REDUCED() && !el.dataset.noChip) {
    const chip = document.createElement('span');
    chip.className = 'odo-chip ' + (diff > 0 ? 'up' : 'down');
    chip.innerHTML = signedShort(diff);
    el.parentElement.appendChild(chip);
    el.closest('.b-primary')?.classList.add(diff > 0 ? 'glow-up' : 'glow-down');
    setTimeout(() => chip.remove(), 3200);
  }
  if (REDUCED()) { el.querySelectorAll('.odo-strip').forEach(st => { st.style.transform = `translateY(${-st.dataset.d * 10}%)`; }); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    let k = 0;
    el.querySelectorAll('.odo-strip').forEach(st => {
      if (st.dataset.f === st.dataset.d && changed) return;
      st.style.transitionDelay = `${120 + k++ * 55}ms`;
      st.style.transform = `translateY(${-st.dataset.d * 10}%)`;
    });
  }));
}

// ---------- render ----------
const isWide = () => window.innerWidth >= 820;

function render() {
  const n = pendingList().length + sync.lifeInbox().length;
  const entry = S.view === 'entry' || !S.settings.startDate;
  document.body.classList.toggle('no-tabs', entry);
  const tabs = [['dash', 'chart', 'خلاصه'], ['an', 'spark', 'تحلیل'], ['list', 'list', 'تراکنش‌ها'], ['settings', 'gear', 'تنظیمات']];
  $tabs.innerHTML = entry ? '' : `<div class="inner">${tabs.map(([v, ic, l]) =>
    `<button data-act="tab" data-v="${v}" class="${S.view === v || (v === 'dash' && S.view === 'assets') ? 'on' : ''}">${ICON[ic]}<span>${l}</span>${v === 'list' && n ? `<i class="badge">${faDigits(n)}</i>` : ''}</button>`).join('')}</div>`;
  const views = { entry: viewEntry, list: viewList, dash: viewDash, an: viewAnalysis, settings: viewSettings, assets: viewAssets };
  const fresh = S.view !== S.shownView || S.month !== S.shownMonth;
  $tabs.classList.toggle('pop', S.view !== S.shownView);
  S.shownView = S.view; S.shownMonth = S.month;
  $app.innerHTML = views[S.view]();
  $app.querySelectorAll(NICE).forEach(niceNum);
  if (fresh && !REDUCED()) {
    $app.classList.remove('anim'); void $app.offsetWidth; $app.classList.add('anim');
    clearTimeout(animTimer); animTimer = setTimeout(() => $app.classList.remove('anim'), 1400);
    animateNumbers($app);
  }
  if (S.view === 'list') setTimeout(() => { S.lastId = null; }, 1500);
  if (S.view === 'list') bindList();
  if (S.view === 'dash') bindTrend();
  if (S.view === 'an') bindCarousel();
  if (S.view === 'assets') bindMarketChart();
  if (S.view === 'entry' && S.step === 'what') bindWhat();
  if (S.view === 'entry' && S.step === 'amount') bindAmount();
}

// Page header with a quick way back to entry (entry itself is not a tab).
function pageHead(title, extra = '') {
  return `<div class="page-head"><h1 class="large">${title}</h1><div class="row">${extra}${canEdit() ? `<button class="add-pill" data-act="go-entry">${ICON.add}<span>ثبت</span></button>` : ''}</div></div>`;
}

// iPad is for reading: analysis and reports only. Recording happens on the phone, unless editing is
// switched on for this device in Settings. Kept in localStorage so a backup from the phone never changes it.
const LS = k => { try { return localStorage.getItem(k); } catch { return null; } };
const isTablet = () => LS('deviceRole') ? LS('deviceRole') === 'tablet' : Math.min(screen.width, screen.height) >= 700;
const canEdit = () => !isTablet() || LS('editHere') === '1';
const readOnlyToast = () => toast('روی آیپد فقط نمایشه؛ برای تغییر، تنظیمات ← «ویرایش روی این دستگاه»');

// ----- Entry: «چقدر؟» then «برای چی؟» -----
function viewEntry() {
  if (!S.settings.startDate) {
    return `<div class="view">
      <h1 class="large">شروع</h1>
      <div class="group"><div class="cell col">
        <p class="foot" style="margin:0 0 10px">موجودی بلو را در لحظهٔ شروع بنویس. برای روزی قبل از امروز، موجودی آخر شب قبلش.</p>
        <input class="field" id="start-bal" inputmode="numeric" placeholder="موجودی بلو (تومان)">
      </div><div class="cell col">
        <div class="cell" style="padding:0 0 10px"><span>از تاریخ</span><input class="bare end" id="start-date" inputmode="numeric" value="${formatJalali(new Date())}"></div>
        <input class="field" id="start-pw" dir="ltr" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="رمز اطلاعات قبلی (اختیاری)">
      </div></div>
      <button class="btn-primary" data-act="start">شروع</button>
      <button class="btn-plain" data-act="go-settings">اتصال با کد همگام‌سازی یا وارد کردن فایل</button>
    </div>`;
  }
  const amt = Number(S.amount || 0);
  const top = `<div class="entry-top">
      <button class="today${S.dayBack ? ' back' : ''}" data-act="day">${S.dayBack ? ICON.back : ''}<span>${esc(dayLabel(entryDate()).replace('امروز، ', ''))}</span></button>
      <button class="icon-round" data-act="tab" data-v="${isWide() ? 'dash' : 'dash'}" aria-label="خلاصه">${ICON.chart}</button>
    </div>`;
  if (S.step === 'what') {
    return `<div class="view entry">${top}
      <div class="hero-amt small" data-act="back"><div class="stripes"></div><span class="b-pill" id="what-dir">${guess(S.what, S.dir).dir === 'in' ? 'دریافت' : 'پرداخت'}</span><div class="hero-num">${fmt(amt)}</div></div>
      <h2 class="ask">برای چی؟</h2>
      <div class="what-box ${S.what ? 'has' : ''}"><span class="rot" aria-hidden="true"><span id="rot-word">سوپرمارکت</span></span><input id="what" class="what-input" aria-label="برای چی؟" autocomplete="off" enterkeyhint="done" value="${esc(S.what)}"></div>
      <div id="what-guess">${guessHtml()}</div>
      <button class="btn-big what-save" data-act="save-what">ثبت</button>
      <div id="what-ac"></div>
    </div>`;
  }
  return `<div class="view entry">${top}
    <label class="hero-amt" for="amt">
      <div class="stripes"></div>
      <span class="b-pill">${S.linkWhat ? `چقدر؟، ${esc(S.linkWhat)}` : 'چقدر؟'}</span>
      <input id="amt" class="amt-input" inputmode="numeric" enterkeyhint="next" autocomplete="off" placeholder="۰" value="${amt ? fmt(amt) : ''}">
      <div class="hero-words" id="amt-words">${amt ? esc(tomanWords(amt)) : 'تومان'}</div>
    </label>
    <div class="entry-actions">
      <button class="btn-side" data-act="next" data-dir="in">دریافت</button>
      <button class="btn-big" data-act="next" data-dir="out">ادامه</button>
    </div>
  </div>`;
}

// Work out what a short description means, using learned patterns first, then keywords.
function guess(text, dirHint) {
  const t = text.trim();
  if (!t) return { dir: dirHint, type: dirHint === 'out' ? 'expense' : null, cat: null, ctx: 'personal', cp: '', desc: '', sure: false };
  for (const dir of [dirHint, dirHint === 'out' ? 'in' : 'out']) {
    const m = bestTemplateForText(S.tpl, t, dir);
    if (m) return { dir, type: m.type, cat: m.cat, ctx: m.ctx, cp: m.cp, desc: m.desc, sure: true };
  }
  const ac = complete(S.tpl, t, dirHint).concat(complete(S.tpl, t, dirHint === 'out' ? 'in' : 'out'));
  if (ac.length === 1 || (ac.length && norm(ac[0].desc).startsWith(norm(t)) && t.length >= 3)) {
    const m = ac[0];
    return { dir: m.dir, type: m.type, cat: m.cat, ctx: m.ctx, cp: m.cp, desc: m.desc, sure: true };
  }
  const rIn = inferFromText(t, 'in'), rOut = inferFromText(t, 'out');
  if (dirHint === 'in' || (rIn.type && !(rOut.type === 'expense' && rOut.cat))) {
    return { dir: 'in', type: rIn.type, cat: null, ctx: rIn.ctx, cp: rIn.type ? t : '', desc: t, sure: !!rIn.type };
  }
  return { dir: 'out', type: rOut.type || 'expense', cat: rOut.cat, ctx: rOut.ctx, cp: '', desc: t, sure: rOut.type !== 'expense' || !!rOut.cat };
}

function guessHtml() {
  const g = guess(S.what, S.dir);
  if (!S.what.trim()) return '<p class="hint-line">بنویس و «ثبت» را بزن. اپ خودش دسته را پیدا می‌کند.</p>';
  const what = g.type === 'expense' ? (g.cat ? CATEGORIES[g.cat].label : 'بعداً دسته‌بندی می‌شود') : g.type ? TYPES[g.type].label : 'بعداً بررسی می‌شود';
  return `<div class="guess ${g.sure ? '' : 'unsure'}"><i class="dot" style="background:${g.type === 'expense' && g.cat ? CATEGORIES[g.cat].color : g.dir === 'in' ? '#34c759' : '#c7c7cc'}"></i>
    <span>${g.dir === 'in' ? 'دریافت' : 'پرداخت'}، ${esc(what)}</span>
    <button class="link small" data-act="flip-dir">${g.dir === 'in' ? 'پرداخت بود؟' : 'دریافت بود؟'}</button></div>`;
}

// The account starts the moment the balance is entered.
function startDay() { return new Date(); }

function bindAmount() {
  const input = document.getElementById('amt');
  if (!input) return;
  input.focus();
  input.addEventListener('input', () => {
    const v = parseAmount(input.value);
    S.amount = v ? String(Math.min(v, 9e12)) : '';
    input.value = v ? fmt(v) : '';
    input.setSelectionRange(input.value.length, input.value.length);
    document.getElementById('amt-words').textContent = v ? tomanWords(v) : 'تومان';
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); goWhat('out'); } });
}

// Called from a tap or key press, so iOS keeps the keyboard open while focus moves.
function goWhat(dir) {
  if (!Number(S.amount)) { document.getElementById('amt')?.focus(); return; }
  S.dir = S.linkWhat ? (S.dir || dir) : dir; S.step = 'what'; S.what = S.linkWhat || ''; S.linkWhat = null;
  render();
}

const EXAMPLES = ['سوپرمارکت', 'بنزین', 'ناهار', 'کلاس', 'اجاره', 'قهوه', 'هدیه'];
let rotTimer = null;
function startRotate() {
  clearInterval(rotTimer);
  let i = 0;
  rotTimer = setInterval(() => {
    const el = document.getElementById('rot-word');
    if (!el) return clearInterval(rotTimer);
    i = (i + 1) % EXAMPLES.length;
    el.classList.remove('in');
    void el.offsetWidth;
    el.textContent = EXAMPLES[i];
    el.classList.add('in');
  }, 1800);
}

function bindWhat() {
  const input = document.getElementById('what');
  if (!input) return;
  input.focus();
  startRotate();
  input.addEventListener('input', () => {
    S.what = input.value;
    input.parentElement.classList.toggle('has', !!S.what);
    document.getElementById('what-guess').innerHTML = guessHtml();
    document.getElementById('what-dir').textContent = guess(S.what, S.dir).dir === 'in' ? 'دریافت' : 'پرداخت';
    const ac = S.what.trim() ? complete(S.tpl, S.what, S.dir).concat(complete(S.tpl, S.what, S.dir === 'out' ? 'in' : 'out')).slice(0, 4) : [];
    document.getElementById('what-ac').innerHTML = ac.length ? `<div class="group">${ac.map(m =>
      `<button class="cell" data-act="pick-what" data-key="${esc(m.key)}"><span>${esc(m.desc)}</span><small>${esc(subtitle(m))}</small></button>`).join('')}</div>` : '';
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveWhat(); } });
}

async function saveWhat(m) {
  const amount = Number(S.amount || 0);
  if (!amount) return;
  const g = m ? { dir: m.dir, type: m.type, cat: m.cat, ctx: m.ctx, cp: m.cp, desc: m.desc } : guess(S.what, S.dir);
  const ts = entryDate();
  if (g.dir === 'in' && g.ctx === 'seenzhin') { S.step = 'amount'; S.what = ''; return seenzhinChoice(amount, ts); }
  const desc = g.desc || (g.type === 'expense' && g.cat ? CATEGORIES[g.cat].label : 'بدون توضیح');
  const tx = {
    id: newId(), ts: ts.toISOString(), dir: g.dir, amount, desc, cp: g.cp || '', type: g.type,
    cat: g.type === 'expense' ? g.cat : null, ctx: g.ctx || 'personal', src: 'manual', created: new Date().toISOString(),
  };
  tx.status = !tx.type || (tx.type === 'expense' && !tx.cat) ? 'pending' : 'ok';
  if (S.linkPeriod && S.linkPeriod !== monthKey(ts)) tx.period = S.linkPeriod;
  S.linkPeriod = null;
  S.step = 'amount'; S.what = ''; S.amount = '';
  S.lastId = tx.id;
  render();
  const before = balanceAt(S.tx, S.settings);
  await putTx(tx);
  island(tx, before, balanceAt(S.tx, S.settings));
  toast(`ثبت شد، ${tx.desc}`, async () => { await delTx(tx.id); });
}

// Saved: a black pill grows out of the top of the screen (where the iPhone's island sits),
// draws a tick, names what was saved, then rolls the balance from old to new and folds back.
function island(tx, before, after) {
  document.querySelector('.island')?.remove();
  const isIn = tx.dir === 'in';
  const what = tx.type === 'expense' && tx.cat ? CATEGORIES[tx.cat].label : TYPES[tx.type]?.label || 'بدون دسته';
  const el = document.createElement('div');
  el.className = 'island';
  el.innerHTML = `<svg class="is-tick ${isIn ? 'in' : ''}" viewBox="0 0 52 52"><circle cx="26" cy="26" r="23" pathLength="1"/><path d="M16 27l7 7 14-15" pathLength="1"/></svg>
    <div class="is-txt"><div class="is-a"><b>${esc(tx.desc)}</b><small>${esc(what)}</small></div><div class="is-b"><small>موجودی</small><b class="is-bal" data-odo="${Math.round(after)}" data-odo-key="island" data-no-chip="1"></b></div></div>
    <b class="is-amt ${isIn ? 'in' : ''}">${signedShort(tx.amount, isIn)}</b>`;
  document.body.appendChild(el);
  try { localStorage.setItem('odo:island', String(Math.round(before))); } catch {}
  if (REDUCED()) { el.classList.add('open', 'two'); el.querySelector('.is-bal').textContent = fmt(after); setTimeout(() => el.remove(), 2200); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  setTimeout(() => { el.classList.add('two'); odometer(el.querySelector('.is-bal')); }, 1250);
  setTimeout(() => el.classList.add('close'), 3300);
  setTimeout(() => el.remove(), 3900);
  el.onclick = () => el.classList.add('close');
}

async function commitNew(tx) {
  const before = balanceAt(S.tx, S.settings);
  await putTx(tx);
  S.amount = '';
  S.dayBack = 0;
  render();
  island(tx, before, balanceAt(S.tx, S.settings));
  toast(`ثبت شد، ${tx.desc}`, async () => { await delTx(tx.id); });
}

async function useTemplate(key, amount, ts) {
  const m = S.tpl.find(t => t.key === key);
  if (!m) return;
  if (m.dir === 'in' && m.ctx === 'seenzhin') return seenzhinChoice(amount, ts);
  await commitNew(fromTemplate(m, amount, ts));
}

function seenzhinChoice(amount, ts) {
  openSheet(`<div class="sheet-nav"><span></span><b>Seenzhin</b><button class="link" data-close>لغو</button></div>
    <p class="foot">${fmt(amount)} تومان</p>
    <div class="group">
      <button class="cell" data-act="sz" data-v="reimburse"><span>پس گرفتن پولی که داده بودم</span>${ICON.chevL}</button>
      <button class="cell" data-act="sz" data-v="share"><span>سهم من از فروش</span>${ICON.chevL}</button>
    </div>`, {
    sz: async v => {
      const t = v === 'reimburse'
        ? { dir: 'in', cp: 'Seenzhin', ctx: 'seenzhin', type: 'reimburse', desc: 'Seenzhin' }
        : { dir: 'in', cp: 'Seenzhin', ctx: 'jewelry', type: 'income_work', desc: 'Seenzhin — سهم فروش' };
      closeSheet();
      await commitNew(fromTemplate({ ...t, cat: null }, amount, ts));
    },
  });
}

// ----- Transaction sheet -----
let F = null;
function openTxSheet(init) {
  const d = init.ts ? new Date(init.ts) : entryDate();
  const j = toJalali(d);
  F = {
    id: init.id || null, dir: init.dir, amount: init.amount || 0, desc: init.desc || '', cp: init.cp || '',
    type: init.type ?? (init.dir === 'out' ? 'expense' : 'income_work'), cat: init.cat || null, ctx: init.ctx || 'personal',
    date: `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    touched: !!init.id, bank: init.bank || null, more: false, period: init.period || '',
  };
  F.initTs = init.ts || null; F.initDate = F.date; F.initTime = F.time;
  // Quietly prefill from the best matching pattern instead of showing suggestions.
  if (!F.id && F.amount) {
    const best = suggest(S.tpl, F.amount, d, { dir: F.dir, limit: 1 })[0];
    if (best && best.score >= 5) Object.assign(F, { desc: best.t.desc, type: best.t.type, cat: best.t.cat, ctx: best.t.ctx, cp: best.t.cp });
  }
  F.more = !MAIN_TYPES[F.dir].includes(F.type);
  openSheet(txSheetHtml(), {}, bindTxSheet);
}

function txSheetHtml() {
  const edit = !!F.id;
  return `<div class="sheet-nav"><button class="link" data-close>لغو</button><b>${edit ? 'ویرایش' : F.dir === 'in' ? 'دریافت' : 'پرداخت'}</b><button class="link strong" data-f="save">${edit ? 'ذخیره' : 'ثبت'}</button></div>
    <div class="sheet-amount"><input id="f-amt" inputmode="numeric" value="${F.amount ? fmt(F.amount) : ''}" placeholder="۰"><div class="words" id="f-words">${esc(tomanWords(F.amount))}</div></div>
    <div class="group">
      <div class="cell"><input class="bare" id="f-desc" value="${esc(F.desc)}" placeholder="توضیح" autocomplete="off"></div>
    </div>
    <div id="f-ac"></div>
    <div id="f-type">${typeSeg()}</div>
    <div id="f-catbox">${catGrid()}</div>
    <div class="group">
      <div class="cell"><span>تاریخ</span><input class="bare end" id="f-date" value="${faDigits(F.date)}" inputmode="numeric"></div>
      <div class="cell"><span>ساعت</span><input class="bare end" id="f-time" value="${faDigits(F.time)}" inputmode="numeric"></div>
      <div class="cell"><span>حساب ماهِ</span><select class="bare end" id="f-period">${periodOptions()}</select></div>
    </div>
    <p class="foot" style="margin-bottom:14px">اگر پولی دیر رسید (مثلاً حق کلاس مهر که آبان واریز شد)، ماهِ واقعی‌اش را انتخاب کن تا در همان ماه حساب شود.</p>
    ${edit ? '<div class="group"><button class="cell danger" data-f="delete">حذف تراکنش</button></div>' : ''}`;
}

function periodOptions() {
  const now = monthKey(new Date()), opts = [['', 'همان ماهِ تاریخ']];
  for (let i = 0; i < 12; i++) { const k = shiftMonth(now, -i); opts.push([k, monthLabel(k)]); }
  return opts.map(([k, l]) => `<option value="${k}"${F.period === k ? ' selected' : ''}>${l}</option>`).join('');
}

function typeSeg() {
  const main = MAIN_TYPES[F.dir];
  const segs = `<div class="segmented">${main.map(k => `<button data-f="type" data-v="${k}" class="${F.type === k && !F.more ? 'on' : ''}">${TYPES[k].label}</button>`).join('')}
    <button data-f="more" class="${F.more ? 'on' : ''}">بیشتر</button></div>`;
  if (!F.more) return segs;
  const rest = typesFor(F.dir).filter(k => !main.includes(k));
  return segs + `<div class="group">${rest.map(k => `<button class="cell" data-f="type" data-v="${k}"><span>${TYPES[k].label}</span>${F.type === k ? '<b class="check">✓</b>' : ''}</button>`).join('')}</div>`;
}

const catGrid = () => F.type === 'expense' ? `<div class="cats">${PICKABLE_CATS.map(k =>
  `<button data-f="cat" data-v="${k}" class="${F.cat === k ? 'on' : ''}"><i style="background:${CATEGORIES[k].color}"></i>${CATEGORIES[k].label}</button>`).join('')}</div>` : '';

function bindTxSheet(root) {
  const amt = root.querySelector('#f-amt');
  amt.addEventListener('input', () => {
    F.amount = parseAmount(amt.value);
    amt.value = F.amount ? fmt(F.amount) : '';
    amt.setSelectionRange(amt.value.length, amt.value.length);
    root.querySelector('#f-words').textContent = tomanWords(F.amount);
  });
  amt.addEventListener('blur', () => { if (F.amount) amt.value = fmt(F.amount); });
  root.querySelector('#f-period').addEventListener('change', e => { F.period = e.target.value; });
  const desc = root.querySelector('#f-desc');
  desc.addEventListener('input', () => {
    F.desc = desc.value;
    const ac = complete(S.tpl, F.desc, F.dir);
    root.querySelector('#f-ac').innerHTML = ac.length && !(ac.length === 1 && norm(ac[0].desc) === norm(F.desc))
      ? `<div class="group">${ac.map(m => `<button class="cell" data-f="ac" data-key="${esc(m.key)}"><span>${esc(m.desc)}</span><small>${esc(subtitle(m))}</small></button>`).join('')}</div>` : '';
    if (!F.touched) {
      const best = bestTemplateForText(S.tpl, F.desc, F.dir);
      if (best) Object.assign(F, { type: best.type, cat: best.cat, ctx: best.ctx, cp: best.cp });
      else {
        const r = inferFromText(F.desc, F.dir);
        Object.assign(F, { type: r.type || F.type, cat: r.cat, ctx: r.ctx, cp: '' });
      }
      F.more = !MAIN_TYPES[F.dir].includes(F.type);
      redraw(root);
    }
  });
  root.querySelector('#f-date').addEventListener('input', e => { F.date = toAscii(e.target.value); });
  root.querySelector('#f-time').addEventListener('input', e => { F.time = toAscii(e.target.value); });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    const f = b.dataset.f, v = b.dataset.v;
    if (f === 'type') { F.type = v; F.touched = true; F.more = !MAIN_TYPES[F.dir].includes(v); if (v !== 'expense') F.cat = null; redraw(root); }
    else if (f === 'more') { F.more = !F.more; if (!F.more && !MAIN_TYPES[F.dir].includes(F.type)) F.type = MAIN_TYPES[F.dir][0]; redraw(root); }
    else if (f === 'cat') { F.cat = v; F.touched = true; redraw(root); }
    else if (f === 'ac') {
      const m = S.tpl.find(t => t.key === b.dataset.key);
      Object.assign(F, { desc: m.desc, type: m.type, cat: m.cat, ctx: m.ctx, cp: m.cp, touched: true });
      F.more = !MAIN_TYPES[F.dir].includes(F.type);
      if (!F.amount) F.amount = m.lastAmount;
      desc.value = m.desc;
      amt.value = fmt(F.amount);
      root.querySelector('#f-words').textContent = tomanWords(F.amount);
      root.querySelector('#f-ac').innerHTML = '';
      redraw(root);
    }
    else if (f === 'save') await saveSheet();
    else if (f === 'delete') {
      const orig = S.tx.find(t => t.id === F.id);
      closeSheet();
      await delTx(F.id);
      render();
      toast('حذف شد', async () => { await putTx(orig); });
    }
  });
}

function redraw(root) {
  root.querySelector('#f-type').innerHTML = typeSeg();
  root.querySelector('#f-catbox').innerHTML = catGrid();
}

async function saveSheet() {
  if (!F.amount) return toast('مبلغ را وارد کن');
  const dm = F.date.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/), tm = F.time.match(/(\d{1,2})\D(\d{2})/);
  if (!dm) return toast('تاریخ را مثل ۱۴۰۵/۰۷/۲۶ بنویس');
  // Keep the precise moment unless the user actually changed date or time.
  const ts = F.date === F.initDate && F.time === F.initTime
    ? (F.initTs ? new Date(F.initTs) : entryDate())
    : fromJalali(+dm[1], +dm[2], +dm[3], tm ? +tm[1] : 12, tm ? +tm[2] : 0);
  if (!F.id && F.dir === 'in' && F.ctx === 'seenzhin') { closeSheet(); return seenzhinChoice(F.amount, ts); }
  const desc = F.desc.trim() || (F.type === 'expense' && F.cat ? CATEGORIES[F.cat].label : TYPES[F.type]?.label || 'بدون توضیح');
  const base = F.id ? S.tx.find(t => t.id === F.id) : { id: newId(), src: 'manual', created: new Date().toISOString() };
  const tx = {
    ...base, ts: ts.toISOString(), dir: F.dir, amount: F.amount, desc, cp: F.cp || (F.type !== 'expense' ? desc : ''),
    type: F.type, cat: F.type === 'expense' ? F.cat : null, ctx: F.ctx,
  };
  if (F.period && F.period !== monthKey(ts)) tx.period = F.period; else delete tx.period;
  tx.status = !tx.type || (tx.type === 'expense' && !tx.cat) ? 'pending' : 'ok';
  closeSheet();
  const extra = tx.status === 'ok' ? await learnAndSpread(tx) : [];
  if (F.id) {
    await putTx([tx, ...extra]);
    render();
    toast('ذخیره شد');
  } else {
    await commitNew(tx);
  }
}

// When a bank counterparty gets labelled, remember it and label its other pending rows.
async function learnAndSpread(tx) {
  if (!learnRule(S.rules, tx)) return [];
  await saveRules();
  const out = [];
  for (const t of S.tx) {
    if (t.id === tx.id || t.status !== 'pending' || !t.bank || t.bank.party !== tx.bank.party || t.dir !== tx.dir) continue;
    const c = classify({ ...t.bank, dir: t.dir, key: t.bank.key }, S.rules, 'new');
    if (c.status === 'ok') out.push({ ...t, type: c.type, cat: c.type === 'expense' ? c.cat : null, ctx: c.ctx, cp: c.cp, desc: c.desc, status: 'ok' });
  }
  return out;
}

// ----- Sheet infra -----
function openSheet(html, actions = {}, bind) {
  $ov.innerHTML = `<div class="backdrop" data-close></div><div class="sheet"><div class="grab"></div>${html}</div>`;
  const sheet = $ov.querySelector('.sheet');
  $ov.querySelectorAll('[data-close]').forEach(el => { el.onclick = closeSheet; });
  sheet.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && actions[b.dataset.act]) { e.stopPropagation(); actions[b.dataset.act](b.dataset.v, b); }
  });
  if (bind) bind(sheet);
}
function closeSheet() { $ov.innerHTML = ''; }

// ----- «زندگی من»: finished packages waiting to be received -----
// One tap records the income (coaching) and tells «زندگی من» the package is paid. Nothing is recorded without a tap.
function lifeInbox() {
  const L = sync.lifeInbox();
  if (!L.length) return '';
  const open = L.filter(b => !b.paid), sum = open.reduce((s, b) => s + b.total, 0);
  return `<div class="section-title">از «زندگی من»</div>
    <div class="group life-inbox">${L.map(b => `<div class="cell li-row">
      <span class="li-txt"><b>${esc(b.name)}</b><small>${b.paid ? 'در «زندگی من» پرداخت شده؛ این‌جا ثبت نشده' : `${esc(b.period)}، ${faDigits(b.count)} جلسه`}${b.missing ? `، ${faDigits(b.missing)} بدون قیمت` : ''}</small></span>
      <span class="li-end"><b class="li-amt">${fmtShort(b.total)}</b><span class="row li-acts"><button class="li-more" data-act="bill-more" data-v="${esc(b.seriesId)}" aria-label="گزینه‌ها">•••</button><button class="li-pay" data-act="bill-pay" data-v="${esc(b.seriesId)}">${ICON.ok}<span>رسید</span></button></span></span></div>`).join('')}</div>
    ${open.length ? `<p class="foot">طلب باز: ${fmtShort(sum)} تومان، جمع ${faDigits(open.length)} دورهٔ تمام‌شده که هنوز پرداخت نشده است. «رسید» دریافت را در کوچینگ ثبت می‌کند.</p>` : ''}`;
}

// ----- shared monthly report: hours from «زندگی من», income from here -----
const hrs = min => iso(faDigits(Math.round(min / 6) / 10).replace('.', '٫'));
function workMoneyCard(key) {
  const L = sync.lifeMonth(key);
  if (!L) return '';
  const work = monthsSeries(S.history, scoped(), S.settings.startDate).reduce((m, x) => (m[x.key] = x.work || 0, m), {});
  // A month counts once it has 20 work hours; a month that has only begun would give a misleading rate.
  const rate = k => { const l = sync.lifeMonth(k); return l && l.workMin >= 20 * 60 && work[k] != null ? work[k] / (l.workMin / 60) : null; };
  const r = rate(key), st = sync.lifeStatus();
  const pts = Array.from({ length: 6 }, (_, i) => shiftMonth(key, i - 5)).map(k => ({ k, v: rate(k) }));
  const top = Math.max(1, ...pts.map(p => p.v || 0));
  return `<div class="section-title">کار و درآمد ${esc(monthLabel(key))}، با «زندگی من»</div>
    <div class="group wm"><div class="wm-grid">
      <div><span>ساعت کار</span><b>${L.estMin ? '≈' : ''}${hrs(L.workMin)} ساعت</b><em>جلسه ${hrs(L.clientMin)} + شیفت ${hrs(L.shiftMin)}</em></div>
      <div><span>جلسه و شیفت</span><b>${faDigits(L.sessions)} جلسه، ${faDigits(L.shifts)} شیفت</b><em>برگزارشده</em></div>
      <div><span>ارزش جلسه‌ها</span><b>${fmtShort(L.earned)}</b><em>مجموع مبلغ جلسه‌های برگزارشده${L.unpriced ? `؛ ${faDigits(L.unpriced)} جلسه بدون قیمت` : ''}</em></div>
      <div><span>دریافتی کاری</span><b>${fmtShort(work[key] || 0)}</b><em>با پول دیررسیدهٔ همین ماه</em></div>
      <div class="wm-rate"><span>درآمد هر ساعت کار</span><b>${r != null ? fmtShort(r) : '—'}</b><em>${r != null ? `= دریافتی کاری ÷ ${hrs(L.workMin)} ساعت کار` : 'دریافتی کاری ÷ ساعت کار؛ پس از ۲۰ ساعت کار در ماه حساب می‌شود'}</em></div>
      <div><span>طلب باز</span><b>${st ? fmtShort(st.open) : '—'}</b><em>${st ? `${faDigits(st.openSessions)} جلسهٔ برگزارشده که هنوز پرداخت نشده` : ''}</em></div>
    </div>
    <div class="wm-trend" role="img" aria-label="درآمد هر ساعت کار در شش ماه اخیر">${pts.map(p => `<div class="wm-bar ${p.k === key ? 'on' : ''}"><small>${p.v ? fmtShort(p.v) : '—'}</small><i style="height:${p.v ? Math.max(6, p.v / top * 100).toFixed(0) : 0}%"></i><span>${esc(monthLabel(p.k).split(' ')[0])}</span></div>`).join('')}</div></div>
    <p class="foot">ستون‌ها: درآمد هر ساعت کار در شش ماه اخیر (دریافتی کاری همان ماه ÷ ساعت جلسه و شیفت همان ماه در «زندگی من»).${L.estMin ? ' ساعت‌های تخمینی سوابق قدیمی با «≈» آمده‌اند.' : ''}</p>`;
}

const billDesc = b => `جلسه‌های ${b.name}، ${b.period}`;
async function receiveBill(id) {
  const b = sync.lifeBill(id);
  if (!b) return;
  const now = new Date();
  // Packages that ended before this app's start date are inside the Numbers totals already.
  const pk0 = monthKey(new Date(b.to)), startKey = S.settings.startDate ? monthKey(new Date(S.settings.startDate)) : '';
  if (startKey && pk0 < startKey) {
    await sync.answerBill(id, 'existing'); render();
    return toast(`مبلغ ${b.period} در جدول Numbers همان ماه حساب شده است؛ دوباره ثبت نشد`);
  }
  // The same deposit typed in by hand already? Link to it instead of counting it twice.
  const same = S.tx.find(t => t.dir === 'in' && t.type === 'income_work' && !t.life && Math.abs(t.amount - b.total) < 1000 && new Date(t.ts) >= new Date(b.from));
  if (same) {
    await putTx({ ...same, life: id }); await sync.answerBill(id, 'existing', same.id); render();
    return toast(`همان دریافت «${same.desc}» قبلاً ثبت شده بود؛ به آن وصل شد`);
  }
  const tx = { id: newId(), ts: now.toISOString(), dir: 'in', amount: b.total, desc: billDesc(b), cp: b.name, type: 'income_work', cat: null,
    ctx: 'coaching', src: 'life', life: id, created: now.toISOString(), status: 'ok' };
  // Money for sessions of an earlier month belongs to that month.
  const pk = monthKey(new Date(b.to));
  if (pk < monthKey(now)) tx.period = pk;
  const before = balanceAt(S.tx, S.settings);
  await putTx(tx);
  await sync.answerBill(id, 'tx', tx.id);
  render();
  island(tx, before, balanceAt(S.tx, S.settings));
  toast(`ثبت شد، ${tx.desc}`, async () => { await delTx(tx.id); await sync.answerBill(id, 'undo'); render(); });
}

// Other answers: link a receipt already recorded here, mark it received elsewhere, or set it aside.
function billOptions(id) {
  const b = sync.lifeBill(id);
  if (!b) return;
  const from = new Date(b.from);
  const same = S.tx.filter(t => t.dir === 'in' && !t.life && Math.abs(t.amount - b.total) < 1000 && new Date(t.ts) >= from)
    .sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, 4);
  openSheet(`<div class="sheet-nav"><span></span><b>${esc(b.name)}</b><button class="link" data-close>بستن</button></div>
    <p class="foot" style="margin:0 4px 12px">${esc(billDesc(b))}، ${iso(fmt(b.total))} تومان</p>
    ${same.length ? `<div class="section-title" style="margin-top:0">همین دریافت قبلاً ثبت شده؟</div><div class="group">${same.map(t =>
      `<button class="cell" data-act="link" data-v="${esc(t.id)}"><span>${esc(t.desc)}<small> ، ${esc(dayLabel(new Date(t.ts)))}</small></span><b>${iso(fmt(t.amount))}</b></button>`).join('')}</div>` : ''}
    <div class="group" style="margin-top:14px">
      <button class="cell" data-act="elsewhere"><span>جای دیگری ثبت شده است</span></button>
      <button class="cell danger" data-act="skip">این طلب دریافت نمی‌شود</button></div>`, {
    link: async v => { const t = S.tx.find(x => x.id === v); if (!t) return; await putTx({ ...t, life: id }); await sync.answerBill(id, 'existing', v); closeSheet(); render(); toast('به همان دریافت وصل شد'); },
    elsewhere: async () => { await sync.answerBill(id, 'existing'); closeSheet(); render(); toast('در «زندگی من» پرداخت‌شده ثبت می‌شود'); },
    skip: async () => { await sync.answerBill(id, 'skip'); closeSheet(); render(); toast('کنار گذاشته شد'); },
  });
}

// ----- List -----
function viewList() {
  const n = pendingList().length;
  const pend = S.listFilter === 'pending';
  return `<div class="view">
    ${pageHead('تراکنش‌ها')}
    ${lifeInbox()}
    ${listBento()}
    <input class="search" id="q" placeholder="جستجو" value="${esc(S.listQuery)}">
    ${pend ? '' : `<div class="segmented">${[['all', 'همه'], ['in', 'دریافت'], ['out', 'پرداخت']].map(([k, l]) =>
      `<button data-act="lf" data-v="${k}" class="${S.listFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>`}
    <div id="list-body">${listBody()}</div>
  </div>`;
}

function listBento() {
  const now = new Date(), day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week0 = new Date(day0); week0.setDate(week0.getDate() - 6);
  let today = 0, week = 0;
  for (const t of scoped()) {
    if (t.type !== 'expense') continue;
    const d = new Date(t.ts);
    if (d >= day0) today += t.amount;
    if (d >= week0) week += t.amount;
  }
  const n = pendingList().length;
  return `<section class="mini-bento">
    <div class="mb-tile dark"><div class="stripes"></div><p class="b-label">خرج امروز</p><p class="mb-num">${fmtShort(today)}</p></div>
    <div class="mb-tile"><p class="b-label">۷ روز اخیر</p><p class="mb-num">${fmtShort(week)}</p></div>
    <button class="mb-tile muted" data-act="lf" data-v="${S.listFilter === 'pending' ? 'all' : 'pending'}"><p class="b-label">${S.listFilter === 'pending' ? 'نمایش همه' : 'نیاز به بررسی'}</p><p class="mb-num">${faDigits(n)}</p></button>
  </section>`;
}

function listBody() {
  const q = norm(S.listQuery), qn = parseAmount(S.listQuery);
  const items = scoped().filter(t => !isRound(t) &&
    (S.listFilter === 'all' || (S.listFilter === 'pending' ? t.status === 'pending' : t.dir === S.listFilter)) &&
    (!q || norm(t.desc).includes(q) || norm(t.cp).includes(q) || norm(t.bank?.name).includes(q) || (qn && Math.abs(t.amount - qn) < 1)));
  items.sort((a, b) => b.ts.localeCompare(a.ts));
  if (!items.length) return `<p class="empty">${S.listFilter === 'pending' ? 'چیزی برای بررسی نیست' : 'تراکنشی نیست'}</p>`;
  const shown = items.slice(0, S.listLimit);
  const groups = [];
  for (const t of shown) {
    const d = new Date(t.ts), k = d.toDateString();
    if (!groups.length || groups.at(-1).k !== k) groups.push({ k, d, items: [] });
    groups.at(-1).items.push(t);
  }
  return groups.map(g => `<div class="section-title">${esc(dayLabel(g.d))}</div>
    <div class="group">${g.items.map(t => itemHtml(t)).join('')}</div>`).join('')
    + (items.length > shown.length ? `<button class="btn-plain" data-act="more">بیشتر</button>` : '');
}

function itemHtml(t, withDay = false) {
  const d = new Date(t.ts);
  const time = (withDay ? dayLabel(d).replace(/^(امروز|دیروز)، /, '$1 ') + '، ' : '') + faDigits(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
  return `<button class="cell tx ${t.id === S.lastId ? 'new' : ''}" data-act="edit" data-id="${t.id}">
    <i class="dot" style="background:${dotColor(t)}"></i>
    <span class="tx-main"><span class="t1">${esc(t.desc)}</span><span class="t2">${t.status === 'pending' ? '<b class="warn">نیاز به بررسی</b>' : esc(subtitle(t))}، ${time}${roundNote(t)}</span></span>
    ${amountHtml(t)}</button>`;
}

function bindList() {
  const q = document.getElementById('q');
  q.addEventListener('input', () => { S.listQuery = q.value; S.listLimit = 60; document.getElementById('list-body').innerHTML = listBody(); });
}

// ----- Summary -----
// Layout follows the "StatsBento" + "BudgetCard" references, rebuilt without React/Tailwind.
const WEEKDAY_SHORT = ['ی', 'د', 'س', 'چ', 'پ', 'ج', 'ش'];

// Months before the start date come from an anonymised monthly summary file (no names, no transactions).

function viewHistory(key) {
  const h = monthsSeries(S.history, scoped(), S.settings.startDate).find(m => m.key === key) || S.history.months[key];
  const ins = (h.ins || [['درآمد کاری', h.work], ['از خانواده', h.family], ['فروش مکمل', h.sale], ['نامشخص', h.otherIn]].filter(x => x[1])).slice();
  // Late payments recorded in the app but counted for this month.
  const lateIn = (h.late || []).filter(t => t.dir === 'in').reduce((a, t) => a + t.amount, 0);
  if (lateIn) ins.push([LATE_LABEL, lateIn]);
  const outs = h.outs || [['دارایی', h.asset], ['قسط وام', h.loanPay], ['پرداخت برای دیگران', h.onBehalf]].filter(x => x[1]);
  const days = h.days || Object.entries(h.byCat).map(([c, v]) => [(CATEGORIES[c] || CATEGORIES.other).label, v]);
  return `<div class="view wide">
    ${pageHead('خلاصه', monthNav(key))}
    ${histUnlock()}
    ${storyHtml(key, { ins: ins.sort((a, b) => b[1] - a[1]), outs, days, h, bank: h.bank, lateNet: lateIn })}
    <div id="trend">${trendCard()}</div>
  </div>`;
}

const LATE_LABEL = 'دیر رسید (در آبان واریز شد)';

const monthNav = key => `<div class="month"><button data-act="mon" data-v="-1">${ICON.chevR}</button><button class="month-btn" data-act="month-pick">${monthLabel(key)}<span>▾</span></button><button data-act="mon" data-v="1">${ICON.chevL}</button></div>`;

// Every month from the first history month to now, newest first, with what was left that month.
function openMonthPicker() {
  const series = monthsSeries(S.history, scoped(), S.settings.startDate).slice().reverse();
  openSheet(`<div class="sheet-nav"><span></span><b>کدام ماه؟</b><button class="link" data-close>بستن</button></div>
    <div class="group">${series.map(m => `<button class="cell" data-act="pick" data-v="${m.key}"><span class="grow">${monthLabel(m.key)}${m.running ? ' <small>، در جریان</small>' : ''}</span><small>خرج ${fmtShort(m.expense || 0)}</small>${m.key === S.month ? ICON.ok : ''}</button>`).join('')}</div>`,
    { pick: v => { closeSheet(); S.month = v; S.tr.hover = null; S.view = 'dash'; render(); window.scrollTo(0, 0); } });
}

// Asks once for the password when the shipped history is newer than the one on this device.
function histUnlock() {
  if (S.history && S.history.source === 'numbers' && (S.history.rev || 1) >= HIST_REV) return '';
  return `<div class="group"><div class="cell col">
      <p class="foot" style="margin:0 0 10px">${S.history ? 'نسخهٔ کامل‌تر تاریخچه آماده است (با جزئیات هر ماه).' : 'تاریخچهٔ ماه‌های قبل هنوز وارد نشده.'} رمز را بزن تا بارگذاری شود.</p>
      <input class="field" id="an-pw" dir="ltr" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="رمز اطلاعات قبلی">
      <button class="btn-primary" data-act="an-load" style="margin-top:12px">بارگذاری</button></div></div>`;
}

// «… در یک نگاه»: what came in, what went out, the biggest items, and a few plain sentences.
// What Seenzhin still owes at the end of a month: everything paid for it minus everything it paid back.
function seenzhinOwed(key) {
  let owed = 0;
  const H = (S.history && S.history.months) || {};
  for (const k of Object.keys(H)) {
    if (k > key) continue;
    for (const [l, v] of H[k].outs || []) if (/Seenzhin/.test(l)) owed += v;
    for (const [l, v] of H[k].ins || []) if (/Seenzhin/.test(l)) owed -= v;
  }
  for (const t of scoped()) if (t.ctx === 'seenzhin' && txMonth(t) <= key) {
    if (t.type === 'on_behalf') owed += t.amount;
    if (t.type === 'reimburse') owed -= t.amount;
  }
  // Amounts you chose to let go of (counted as help to Seenzhin, not as a debt).
  for (const [k, v] of Object.entries(S.settings.szForgive || {})) if (k <= key) owed -= v;
  return owed;
}

function storyHtml(key, args) {
  S.storyArgs = { key, args };
  return storyFull(key, { ...args, compact: true });
}

function storyFull(key, { ins, outs, days, h, bank, hero = true, live = false, lateNet = 0, compact = false }) {
  const sum = arr => arr.reduce((a, x) => a + x[1], 0);
  const inT = sum(ins), outT = sum(outs) + sum(days || []), net = inT - outT;
  const name = monthLabel(key).split(' ')[0];
  // Money that only passed through (paid for others / Seenzhin, then paid back) and savings are told apart from spending.
  const passRe = /Seenzhin|برای دیگران|اشخاص/, assetRe = /دلار|نقره|طلا|دوچرخه|سکه|پس‌انداز|باکس|رند/;
  const pass = outs.filter(x => passRe.test(x[0])), assets = outs.filter(x => assetRe.test(x[0]));
  const back = ins.filter(x => /Seenzhin|اشخاص|پس گرفتن/.test(x[0]));
  const big = [...outs.filter(x => !passRe.test(x[0]) && !assetRe.test(x[0])), ...(days || [])].sort((a, b) => b[1] - a[1]);
  const lines = [];
  if (!h.work) lines.push('این ماه درآمد کاری ثبت نشده.');
  else lines.push(`درآمد کاری ${fmtShort(h.work)} و هزینهٔ زندگی ${fmtShort(h.expense)} بود؛ ${h.work >= h.expense ? 'درآمد کاری همهٔ هزینه‌ها را پوشش داد' : `درآمد کاری ${faDigits(Math.round(h.work / h.expense * 100))}٪ هزینه‌ها را پوشش داد`}.`);
  if (h.family) lines.push(`${fmtShort(h.family)} حمایت خانواده${h.work ? '' : '؛ هزینه‌ها از همین و موجودی تأمین شد'}.`);
  if (big.length) lines.push(`بیشترین خرج‌ها: ${big.slice(0, 3).map(x => `${x[0]} (${fmtShort(x[1])})`).join('، ')}.`);
  if (assets.length) lines.push(`${fmtShort(sum(assets))} خرج نشد، تبدیل شد به دارایی: ${assets.map(x => x[0]).join('، ')}.`);
  // Seenzhin is a running account: money paid for it comes back later, often the next month.
  const szOut = sum(pass.filter(x => /Seenzhin/.test(x[0]))), szIn = sum(back.filter(x => /Seenzhin/.test(x[0])));
  if (szOut || szIn) {
    const owed = seenzhinOwed(key);
    const forgiven = (S.settings.szForgive || {})[key];
    lines.push(`Seenzhin: این ماه ${szOut ? `${fmtShort(szOut)} پرداخت` : 'پرداختی نبود'}${szIn ? ` و ${fmtShort(szIn)} دریافت` : ''}${szIn > szOut ? ' (شامل تسویهٔ ماه قبل)' : ''}. ${forgiven ? `${fmtShort(forgiven)} باقی‌مانده به‌عنوان کمک بخشیده شد؛ حساب تسویه است.` : Math.abs(owed) < 5e5 ? 'حساب تسویه است.' : owed > 0 ? `تا پایان ماه حدود ${fmtShort(owed)} طلب باقی است.` : `تا پایان ماه حدود ${fmtShort(-owed)} بیش از پرداخت‌ها دریافت شده.`} این مبالغ جزو هزینه و درآمد زندگی حساب نمی‌شوند.`);
  }
  const prOut = sum(pass.filter(x => !/Seenzhin/.test(x[0]))), prIn = sum(back.filter(x => !/Seenzhin/.test(x[0])));
  if (prOut || prIn) lines.push(`پول‌های رفت‌وبرگشتی با اشخاص: ${prOut ? `${fmtShort(prOut)} پرداخت` : ''}${prOut && prIn ? ' و ' : ''}${prIn ? `${fmtShort(prIn)} دریافت` : ''}؛ جدا از هزینه و درآمد حساب می‌شوند.`);
  lines.push((net < 0 ? `تراز ماه: ${fmtShort(-net)} منفی.` : `تراز ماه: ${fmtShort(net)} مثبت.`)
    + (lateNet ? ` (${fmtShort(lateNet)} از آن دیرتر، در ماه بعد واریز شد؛ بدون آن: ${sgnShort(net - lateNet)}.)` : ''));
  if (bank) {
    lines.push(`موجودی اول ماه ${fmtShort(bank[0])} بود؛ با ${fmtShort(inT)} ورودی، در مجموع ${fmtShort(bank[0] + inT)} در دسترس بود.`);
    lines.push(`موجودی بلو از ${fmtShort(bank[0])} رسید به ${fmtShort(bank[1])}.`);
    const gap = (bank[1] - bank[0]) - (net - lateNet);
    if (Math.abs(gap) >= 1e6) lines.push(gap < 0 ? `طبق جدولت باید ${fmtShort(bank[1] - gap)} می‌موند، ولی بانک ${fmtShort(bank[1])} نشون می‌ده؛ یعنی ${fmtShort(-gap)} خرج هست که تو جدول ننوشتی.` : `طبق جدولت باید ${fmtShort(bank[1] - gap)} می‌موند، ولی بانک ${fmtShort(bank[1])} نشون می‌ده؛ یعنی ${fmtShort(gap)} پول بیشتر از جدولت تو حسابه (احتمالاً یه واریزی که ننوشتی).`);
  }
  const kindOf = { in: 'in', out: 'out', day: 'day' };
  const bars = (arr, cls) => { const mx = Math.max(1, ...arr.map(x => x[1])); return arr.map(([l, v]) => `<button class="cell bar-row" data-act="detail" data-k="${l === LATE_LABEL ? 'late' : live ? kindOf[cls] : 'hist'}" data-v="${esc(l)}"><span class="grow">${esc(l)}</span><b>${fmtShort(v)}</b>${ICON.chevL}<i class="bar ${cls}" style="width:${(v / mx * 100).toFixed(1)}%"></i></button>`).join(''); };
  if (compact) return insightHtml(key, { outs, days, h, inT, outT, net, name, passRe, assetRe });
  return `${hero ? `<section class="bento an-hero">
      <div class="b-primary tap" data-act="detail" data-k="net"><div class="stripes"></div>
        <div><span class="b-pill">${esc(name)} در یک نگاه</span><h3 class="b-hero">${sgnShort(net)}</h3></div>
        <p class="b-note story-io"><span class="green">${fmtShort(inT)} ورودی</span>، <span class="red">${fmtShort(outT)} خروجی</span></p></div>
    </section>` : ''}
    ${compact ? `<div class="section-title">چه اتفاقی افتاد</div>
      <div class="group story">${lines.slice(0, 3).map(l => `<div class="cell"><span>${esc(l)}</span></div>`).join('')}
        <button class="cell more-row" data-act="story-more"><span class="grow tint">همهٔ جزئیات ${esc(name)}</span>${ICON.chevL}</button></div>` : `
      <div class="group story">${lines.map(l => `<div class="cell"><span>${esc(l)}</span></div>`).join('')}</div>
      <div class="section-title">ورودی‌ها، ${fmtShort(inT)}</div>
      <div class="group">${ins.length ? bars(ins, 'in') : '<div class="cell"><span class="sec">ورودی‌ای ثبت نشده</span></div>'}</div>
      ${outs.length ? `<div class="section-title">پرداخت‌های بزرگ، ${fmtShort(sum(outs))}</div><div class="group">${bars(outs, 'out')}</div>` : ''}
      ${days && days.length ? `<div class="section-title">${h.days ? 'خرج‌های روزانه' : 'خرج‌ها'}، ${fmtShort(sum(days))}</div><div class="group">${bars(days.slice().sort((a, b) => b[1] - a[1]), 'day')}</div>` : ''}`}`;
}

// ----- Month at a glance: first the logic (what happened), then the numbers, then the trend -----
function insightHtml(key, { outs, days, h, inT, outT, net, name, passRe, assetRe }) {
  const sum = a => a.reduce((x, y) => x + y[1], 0);
  const series = monthsSeries(S.history, scoped(), S.settings.startDate);
  const m = series.find(x => x.key === key) || {};
  const running = !!m.running;
  const rest = series.filter(x => x.key !== key && !x.running && (x.expense || x.work));
  const usual = f => rest.length ? rest.reduce((a, x) => a + (f(x) || 0), 0) / rest.length : null;
  const asset = sum(outs.filter(x => assetRe.test(x[0])));
  const loan = sum(outs.filter(x => /قسط|صندوق/.test(x[0])));
  const exp = h.expense || 0, work = h.work || 0, fam = h.family || 0;
  const uExp = usual(x => x.expense);
  const span = rest.length ? `${faDigits(rest.length)} ماه دیگر (${monthName(rest[0].key)} تا ${monthName(rest.at(-1).key)})` : '';

  // 1) Logic: a few short sentences, biggest first.
  const L = [];
  if (asset >= 5e6) L.push(`${fmtShort(asset)} به دارایی تبدیل شد.`);
  if (running) L.push(`تا امروز ${fmtShort(exp)} هزینهٔ زندگی ثبت شده.`);
  else if (uExp) { const d = (exp - uExp) / uExp; L.push(`هزینهٔ زندگی ${fmtShort(exp)} بود؛ ${Math.abs(d) < .08 ? 'در حد میانگین' : `${faDigits(Math.round(Math.abs(d) * 100))}٪ ${d > 0 ? 'بالاتر' : 'پایین‌تر'} از میانگین`}.`); }
  if (!running && (work || fam)) L.push(work >= exp ? `درآمد کاری (${fmtShort(work)}) همهٔ هزینه‌ها را پوشش داد.` : work ? `درآمد کاری ${fmtShort(work)} بود و باقی هزینه‌ها را حمایت خانواده پوشش داد.` : 'درآمد کاری نداشتی؛ هزینه‌ها از حمایت خانواده و موجودی تأمین شد.');
  if (!running) L.push(net >= 0 ? `در پایان ماه ${fmtShort(net)} به موجودی اضافه شد.` : `در پایان ماه ${fmtShort(-net)} از موجودی کم شد.`);

  // 2) Numbers: this month, the average of the other months, and the change.
  const rows = [
    { g: 'جریان نقدی' },
    { l: 'ورودی', v: inT, u: usual(x => x.inT), dir: 1 },
    { l: 'خروجی', v: outT, u: usual(x => x.outT), dir: -1 },
    { l: 'تراز ماه', v: net, u: usual(x => (x.inT || 0) - (x.outT || 0)), dir: 1, signed: true, strong: true },
    { g: 'اجزا' },
    { l: 'درآمد کاری', v: work, u: usual(x => x.work), dir: 1, k: 'work' },
    { l: 'حمایت خانواده', v: fam, u: usual(x => x.family), dir: 0, k: 'family' },
    { l: 'هزینهٔ زندگی', v: exp, u: uExp, dir: -1, k: 'expense' },
    { l: 'سرمایه‌گذاری', v: asset, u: usual(x => x.asset), dir: 1 },
    { l: 'اقساط', v: loan, u: usual(x => x.loanPay), dir: 0 },
  ];
  const num = (v, signed) => {
    if (!signed || !v) return fmtShort(v);
    const [n, ...u] = fmtShort(Math.abs(v)).split(' ');
    return `<bdi dir="ltr">${v < 0 ? '−' : '+'}${n}</bdi> ${u.join(' ')}`;
  };
  const delta = r => {
    if (running || r.u == null || !r.u || r.signed) return '';
    const d = (r.v - r.u) / Math.abs(r.u);
    if (Math.abs(d) < .05) return '<span class="dl">—</span>';
    const tone = !r.dir ? '' : (d > 0) === (r.dir > 0) ? 'green' : 'red';
    return `<span class="dl ${tone}"><bdi dir="ltr">${d > 0 ? '▲' : '▼'} ${faDigits(Math.min(999, Math.round(Math.abs(d) * 100)))}٪</bdi></span>`;
  };
  const body = rows.map((r, i) => r.g ? `<div class="nt-g">${r.g}</div>` : `<${r.k ? `button data-act="detail" data-k="series" data-v="${r.k}"` : 'div'} class="nt-row${r.strong ? ' strong' : ''}" style="animation-delay:${(i * .04).toFixed(2)}s">
      <span class="nt-l">${r.l}</span><b data-cu="${Math.abs(Math.round(r.v))}" data-f="short"${r.signed ? ' data-raw="1"' : ''}>${num(r.v, r.signed)}</b>${running ? '' : `<span class="nt-u">${r.u == null ? '' : num(r.u, r.signed)}</span>${delta(r)}`}</${r.k ? 'button' : 'div'}>`).join('');

  return `<div class="ins-card">
      <p class="eyebrow-s">${running ? '<span class="live-dot"></span>' : ''}${esc(name)}${running ? '، در جریان' : ''}</p>
      <ul class="logic">${L.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    </div>
    ${flowCard({ work, fam, inT, outT, exp, asset, loan, net, running })}
    <div class="ins-card nt${running ? ' run' : ''}">
      <div class="nt-row nt-head"><span></span><span>${running ? 'تا امروز' : 'این ماه'}</span>${running ? '' : '<span>میانگین</span><span>تغییر</span>'}</div>
      ${body}
      ${running || !span ? '' : `<p class="nt-foot">میانگین = ${span}. تغییر = (این ماه − میانگین) ÷ میانگین.</p>`}
    </div>
    <button class="cell more-row ins-more" data-act="story-more"><span class="grow tint">همهٔ جزئیات ${esc(name)}</span>${ICON.chevL}</button>`;
}

// Money flow: where the month's money came from (right), through the month (centre), to where it went
// (left). Line thickness is the amount; dots keep moving along the lines so the month reads as a stream.
function flowCard({ work, fam, inT, outT, exp, asset, loan, net, running }) {
  const pos = v => Math.max(0, v || 0);
  const src = [['درآمد کاری', pos(work)], ['حمایت خانواده', pos(fam)], ['سایر ورودی‌ها', pos(inT - work - fam)]].filter(x => x[1] >= 1e5);
  const dst = [['هزینهٔ زندگی', pos(exp)], ['سرمایه‌گذاری', pos(asset)], ['اقساط', pos(loan)], ['سایر خروجی‌ها', pos(outT - exp - asset - loan)]].filter(x => x[1] >= 1e5);
  if (!src.length && !dst.length) return '';
  const rows = Math.max(src.length, dst.length, 2), H = rows * 46 + 16, hy = H / 2, mx = Math.max(...src.map(x => x[1]), ...dst.map(x => x[1]), 1);
  const w = v => Math.max(1.5, v / mx * 12), ys = (n, i) => (H - n * 46) / 2 + 23 + i * 46;
  const side = (list, out) => list.map(([l, v], i) => {
    const y = ys(list.length, i), hyO = hy + (i - (list.length - 1) / 2) * 7;
    const d = out ? `M140,${hyO.toFixed(1)} C118,${hyO.toFixed(1)} 122,${y} 100,${y}` : `M240,${y} C218,${y} 222,${hyO.toFixed(1)} 200,${hyO.toFixed(1)}`;
    const n = Math.max(1, Math.round(v / mx * 3)), dur = (2.6 - v / mx).toFixed(2);
    const pk = REDUCED() ? '' : Array.from({ length: n }, (_, k) => `<circle r="2.2" class="fl-pkt"><animateMotion dur="${dur}s" begin="${(k * dur / n + i * .3).toFixed(2)}s" repeatCount="indefinite" path="${d}"/></circle>`).join('');
    const tx = out ? 8 : 332, an = out ? 'start' : 'end';
    return `<path d="${d}" class="fl-line ${out ? 'out' : 'in'}" stroke-width="${w(v).toFixed(1)}" style="--i:${i}"/>${pk}
      <text x="${tx}" y="${y - 3}" text-anchor="${an}" class="fl-l">${esc(l)}</text><text x="${tx}" y="${y + 13}" text-anchor="${an}" class="fl-v">${esc(fmtShort(v))}</text>`;
  }).join('');
  const [nn, ...nu] = fmtShort(Math.abs(net)).split(' ');
  return `<div class="ins-card flow"><span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br br2"></span>
    <p class="eyebrow-s">${running ? '<span class="live-dot"></span>' : ''}جریان پول</p>
    <svg viewBox="0 0 340 ${H}" class="fl-svg" role="img" aria-label="جریان پول ماه">${side(src, false)}${side(dst, true)}
      <rect x="140" y="${(hy - 26).toFixed(1)}" width="60" height="52" rx="12" class="fl-hub"/>
      <text x="170" y="${(hy + 1).toFixed(1)}" text-anchor="middle" class="fl-v ${net >= 0 ? 'up' : 'down'}" direction="ltr">${net >= 0 ? '+' : '−'}${esc(nn)}</text>
      <text x="170" y="${(hy + 15).toFixed(1)}" text-anchor="middle" class="fl-l">${esc(nu.join(' ') || 'تومان')}</text>
      <text x="170" y="${(hy - 33).toFixed(1)}" text-anchor="middle" class="fl-l">تراز</text></svg>
    <p class="nt-foot">ضخامت هر خط = سهم آن از بزرگ‌ترین رقم ماه. عدد وسط: ورودی − خروجی${running ? ' تا امروز' : ''}.</p></div>`;
}

// The same story for months recorded in the app, built from transactions.
const inLabel = t => t.type ? TYPES[t.type].label : 'بررسی نشده';
const outLabel = t => isRound(t) ? 'رند بلو (باکس)' : TYPES[t.type] ? TYPES[t.type].label : 'بررسی نشده';
const dayLabelOf = t => (CATEGORIES[t.cat] || CATEGORIES.uncat).label;
const STORY_GROUPS = {
  in: [t => t.dir === 'in', inLabel],
  out: [t => t.dir === 'out' && t.type !== 'expense', outLabel],
  day: [t => t.type === 'expense', dayLabelOf],
};
function monthTx(T, key) {
  return T.filter(t => txMonth(t) === key);
}
function liveStory(T, key) {
  const M = monthTx(T, key);
  const group = g => { const [keep, f] = STORY_GROUPS[g], o = {}; for (const t of M.filter(keep)) { const k = f(t); o[k] = (o[k] || 0) + t.amount; } return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  return storyHtml(key, { ins: group('in'), outs: group('out'), days: group('day'), h: monthSummary(T, key), bank: null, hero: false, live: true });
}

// ----- Details: tap any big number to see what it is made of -----
function txSheet(title, sub, list, note = '') {
  list = list.slice().sort((a, b) => b.ts.localeCompare(a.ts));
  const total = list.reduce((a, t) => a + (t.dir === 'in' ? t.amount : -t.amount), 0);
  openSheet(`<div class="sheet-nav"><span></span><b>${esc(title)}</b><button class="link" data-close>بستن</button></div>
    <div class="det-head"><span class="sec">${esc(sub)}</span><b>${fmt(Math.abs(total))} <small>تومان</small></b><span class="sec">${faDigits(list.length)} تراکنش</span></div>
    ${note ? `<p class="foot det-note">${note}</p>` : ''}
    <div class="group">${list.length ? list.map(t => itemHtml(t, true)).join('') : '<div class="cell"><span class="sec">چیزی نیست</span></div>'}</div>
    <p class="foot">با زدن روی هر ردیف، ویرایش باز می‌شود.</p>`,
    { edit: (v, b) => { if (!canEdit()) return readOnlyToast(); const t = S.tx.find(x => x.id === b.dataset.id); if (t) { closeSheet(); openTxSheet({ ...t }); } } });
}

function infoSheet(title, rows, note = '') {
  openSheet(`<div class="sheet-nav"><span></span><b>${esc(title)}</b><button class="link" data-close>بستن</button></div>
    ${note ? `<p class="foot det-note">${note}</p>` : ''}
    <div class="group">${rows.map(([l, v, cls]) => `<div class="cell"><span class="grow ${cls || ''}">${esc(l)}</span><b class="${cls || ''}">${v}</b></div>`).join('')}</div>`);
}

function openDetail(kind, v) {
  const T = scoped(), key = S.month, mName = monthLabel(key);
  const M = monthTx(T, key).filter(t => !isRound(t));
  if (kind === 'work') return txSheet(`درآمد کاری ${mName}`, 'جمع درآمد کاری', M.filter(t => t.type === 'income_work'));
  if (kind === 'count') return txSheet(`تراکنش‌های ${mName}`, 'خالص (آمد منهای رفت)', M);
  if (kind === 'cov') {
    const s = monthSummary(T, key);
    return infoSheet('درآمد کاری در برابر هزینه', [['درآمد کاری', fmt(s.work), 'green'], ['هزینهٔ زندگی', fmt(s.expense), 'red'], ['نسبت', s.expense ? faDigits(Math.round(s.work / s.expense * 100)) + '٪' : '—']],
      'یعنی درآمد کاری این ماه چند درصد هزینهٔ زندگی را پوشش داده. بالای ۱۰۰٪ یعنی از کار خودت چیزی هم مانده. اول ماه این عدد بالاست چون هنوز خرج زیادی ثبت نشده.');
  }
  if (kind === 'bal') {
    const st = S.settings, all = S.tx.filter(t => t.ts >= (st.openingDate || ''));
    const inn = all.filter(t => t.dir === 'in').reduce((a, t) => a + t.amount, 0), out = all.filter(t => t.dir === 'out' && !isRound(t)).reduce((a, t) => a + t.amount, 0);
    const rnd = all.filter(isRound).reduce((a, t) => a + t.amount, 0);
    return infoSheet('ترکیب موجودی بلو', [
      [`موجودی شروع (${formatJalali(new Date(st.openingDate))})`, fmt(st.openingBalance || 0)],
      ['+ همهٔ ورودی‌ها', fmt(inn), 'green'], ['− همهٔ خروجی‌ها', fmt(out), 'red'],
      ...(rnd ? [['− رند بلو (رفت به باکس)', fmt(rnd), 'red']] : []), ['= موجودی الان', fmt(balanceAt(S.tx, st))]],
      'برای دیدن تک‌تک تراکنش‌ها، به «تراکنش‌ها» برو.');
  }
  if (kind === 'late') return txSheet(`حساب ${mName}، دیر رسیده`, 'جمع', S.tx.filter(t => t.period === key), 'این پول‌ها بعداً به حساب آمدند ولی مال این ماه‌اند. در موجودی، روز واریز حساب شده‌اند.');
  if (kind === 'day' && v === '__all') return txSheet(`هزینهٔ زندگی ${mName}`, 'جمع', M.filter(t => t.type === 'expense'));
  if (kind === 'in' || kind === 'out' || kind === 'day') {
    const [keep, f] = STORY_GROUPS[kind];
    return txSheet(v, mName, monthTx(T, key).filter(t => keep(t) && f(t) === v));
  }
  if (kind === 'hist') {
    // History months only have monthly totals: show the same item across all months.
    const H = S.history.months, rows = Object.keys(H).sort().map(k => {
      const h = H[k], hit = [...(h.ins || []), ...(h.outs || []), ...(h.days || [])].find(x => x[0] === v);
      return [monthLabel(k), hit ? fmt(hit[1]) : '—', k === key ? 'tint' : ''];
    });
    return infoSheet(v, rows, 'ماه‌های قبل از آبان فقط جمع ماهانه دارند (از جدول Numbers)، برای همین تک‌تک تراکنش‌ها نیست. این‌جا همین مورد را در همهٔ ماه‌ها می‌بینی.');
  }
  if (kind === 'trend') {
    const tr = S.tr, pts = trendPoints(tr.field, tr.frame), i = tr.hover == null || tr.hover >= pts.length ? (pts.findIndex(p => p.key === S.month) >= 0 ? pts.findIndex(p => p.key === S.month) : pts.length - 1) : tr.hover, p = pts[i];
    const match = t => txValue(t, tr.field) > 0;
    let list;
    if (p.d) { const d0 = p.d, d1 = new Date(d0); d1.setDate(d1.getDate() + 1); list = T.filter(t => { const d = new Date(t.ts); return d >= d0 && d < d1 && match(t); }); }
    else if (S.history && S.history.months[p.key] && (!S.settings.startDate || p.key < monthKey(new Date(S.settings.startDate)))) return openDetail('series', tr.field);
    else list = monthTx(T, p.key).filter(match);
    return txSheet(`${trLabel(tr.field)}، ${p.full}`, 'جمع', list.filter(t => !isRound(t)));
  }
  if (kind === 'series') {
    // One field month by month (history months have totals only).
    const pts = trendPoints(v, 'all'), avg = pts.filter(p => !p.running).reduce((a, p, _, arr) => a + p.value / arr.length, 0);
    return infoSheet(`${trLabel(v)} ماه به ماه`, [...pts.map(p => [p.full + (p.running ? ' (تا الان)' : ''), fmt(p.value), p.key === key ? 'tint' : '']), ['میانگین ماه‌های کامل', fmt(avg)]],
      'ماه‌های قبل از آبان از جدول Numbers هستند و فقط جمع ماه را دارند. برای ماه‌های داخل اپ، روی عدد نمودار بزن تا تک‌تک تراکنش‌ها را ببینی.');
  }
  if (kind === 'net') {
    const h = S.history.months[key], sum = a => (a || []).reduce((x, y) => x + y[1], 0);
    const inT = sum(h.ins), outT = sum(h.outs) + sum(h.days);
    return infoSheet(`${mName} در یک نگاه`, [['ورودی', fmt(inT), 'green'], ['خروجی', fmt(outT), 'red'], ['تراز ماه', (inT - outT < 0 ? '−' : '+') + fmt(Math.abs(inT - outT))],
      ...(h.bank ? [['موجودی بلو اول ماه', fmt(h.bank[0])], ['موجودی بلو آخر ماه', fmt(h.bank[1])]] : [])],
      'ورودی و خروجی همان جمع‌های جدول Numbers است (بدون Opening). موجودی بلو از صورت‌حساب بانک است.');
  }
}

// ----- Analysis: the long view from the first month on -----
// Bump when the encrypted history bundle is rebuilt so devices offer to reload it.
const HIST_REV = 7;
function viewAnalysis() {
  const head = pageHead('تحلیل');
  const unlock = histUnlock();
  const series = monthsSeries(S.history, scoped(), S.settings.startDate);
  const A = analyze(series);
  if (!A) return `<div class="view wide">${head}${unlock}<p class="empty">هنوز ماه کاملی برای تحلیل نیست.</p></div>`;
  const key = series.some(m => m.key === S.anKey) ? S.anKey : A.last;
  const K = kpis(series, balanceAt(S.tx, S.settings), assetsTotal().held);
  const N = newsItems(series, A);
  const max = Math.max(...series.map(m => Math.max(m.inT || 0, m.outT || 0)), 1);
  // Month cards: what came in, what went out and the net, the same totals as the Numbers sheets.
  const card = m => {
    const net = (m.inT || 0) - (m.outT || 0);
    const tag = m.running ? 'در جریان' : m.asset > 0 ? `سرمایه‌گذاری ${fmtShort(m.asset)}` : m.expense > A.avgExp * 1.25 ? 'پرهزینه' : net >= 0 ? 'تراز مثبت' : 'تراز منفی';
    return `<button class="tl-card${m.key === key ? ' on' : ''}" data-act="an-month" data-v="${m.key}">
      <span class="tl-go">${ICON.arrow}</span>
      <span class="tl-name">${esc(monthName(m.key))}</span>
      <span class="tl-self ${net >= 0 ? 'green' : 'red'}">${sgnShort(net)}</span>
      <span class="tl-bar"><i style="width:${((m.inT || 0) / max * 100).toFixed(0)}%;background:#34c759"></i></span>
      <span class="tl-bar"><i style="width:${((m.outT || 0) / max * 100).toFixed(0)}%;background:var(--tint)"></i></span>
      <span class="tl-tag">${tag}</span></button>`;
  };
  const C = compare(series, key);
  // Up arrow means more than average; colour says whether that is good (income) or bad (spending).
  const arrow = (d, a, upGood = false) => !a || !Math.round(d / a * 100) ? '' : `<span class="${(d > 0) === upGood ? 'green' : 'red'} sec">${d > 0 ? '▲' : '▼'} ${faDigits(Math.abs(Math.round(d / a * 100)))}٪</span>`;
  const list = (items, cls) => items.map(x => `<div class="cell col an-item ${cls}"><b>${esc(x.t)}</b><span class="sec">${esc(x.d)}</span></div>`).join('');
  const sel = series.find(m => m.key === key);
  const flagNote = [
    A.flags.unknown ? `${fmtShort(A.flags.unknown)} ورودی نامشخص جزو درآمد حساب نشده` : '',
    A.flags.assumed ? `${fmtShort(A.flags.assumed)} با حدس درآمد کاری حساب شده` : '',
    A.flags.vague ? `${fmtShort(A.flags.vague)} خرج با عنوان نامعلوم (مثل W و C) شخصی حساب شده` : '',
  ].filter(Boolean);
  return `<div class="view wide">
    ${head}${unlock}
    ${newsHero(N)}
    <div class="section-title">ماه به ماه</div>
    <div class="tl">${series.map(card).join('')}</div>
    <p class="foot legend-foot"><span><i style="background:#34c759"></i>ورودی</span><span><i style="background:var(--tint)"></i>خروجی</span><span>عدد بالا: تراز ماه</span></p>
    <div class="section-title">خبرها و نکته‌ها</div>
    <div class="feed">${N.slice(4).map(newsCard).join('')}</div>
    <button class="btn-primary an-share" data-act="report">${ICON.share}<span>گزارش متنی (برای خودم یا Claude)</span></button>
    ${flagNote.length ? `<p class="foot an-flags">دقت داده: ${flagNote.map(esc).join('، ')}.</p>` : ''}
  </div>`;
}

const monthName = k => monthLabel(k).split(' ')[0];

// Tapping a month card: that month against the average of the others.
function monthCompareSheet(key) {
  const series = monthsSeries(S.history, scoped(), S.settings.startDate), C = compare(series, key), m = series.find(x => x.key === key);
  const arrow = (d, a, upGood = false) => !a || !Math.round(d / a * 100) ? '' : `<span class="${(d > 0) === upGood ? 'green' : 'red'} sec">${d > 0 ? '▲' : '▼'} ${faDigits(Math.abs(Math.round(d / a * 100)))}٪</span>`;
  const net = (m.inT || 0) - (m.outT || 0);
  openSheet(`<div class="sheet-nav"><span></span><b>${esc(monthLabel(key))}</b><button class="link" data-close>بستن</button></div>
    <div class="det-head"><span class="sec">تراز ماه</span><b class="${net >= 0 ? 'green' : 'red'}">${sgnShort(net)}</b></div>
    ${C ? `<div class="section-title">در برابر یک ماه معمول</div>
    <div class="group">
      <div class="cell"><span class="grow">درآمد کاری<small class="avg-line">معمولاً ${fmtShort(C.work.a)}</small></span>${arrow(C.work.v - C.work.a, C.work.a, true)}<b>${fmtShort(C.work.v)}</b></div>
      <div class="cell"><span class="grow">هزینهٔ زندگی<small class="avg-line">معمولاً ${fmtShort(C.expense.a)}</small></span>${arrow(C.expense.v - C.expense.a, C.expense.a)}<b>${fmtShort(C.expense.v)}</b></div>
      ${C.rows.map(r => `<div class="cell"><i class="dot" style="background:${CATEGORIES[r.c].color}"></i><span class="grow">${CATEGORIES[r.c].label}<small class="avg-line">معمولاً ${fmtShort(r.a)}</small></span>${arrow(r.d, r.a)}<b>${fmtShort(r.v)}</b></div>`).join('')}
    </div>` : ''}
    ${dayStrip(m)}
    <button class="btn-primary" data-act="open">دیدن کامل ${esc(monthLabel(key))}</button>`,
    { open: () => { closeSheet(); S.month = key; S.view = 'dash'; S.tr.hover = null; render(); window.scrollTo(0, 0); } });
}

// Monthly goals with their arithmetic in plain view.
// spend: ceiling for living costs، disc: share of that ceiling for optional spending، asset: amount to invest.
const GOAL_DEF = { spend: 160e6, disc: .35, asset: 10e6 };
const goals = () => ({ ...GOAL_DEF, ...(S.settings.goals || {}) });
const DISC = ['weekend', 'gift', 'habits', 'personal'];
function goalRows(T, key) {
  const g = goals(), s = monthSummary(T, key), now = new Date();
  const series = monthsSeries(S.history, T, S.settings.startDate);
  const base = baseline(series, m => m.expense || 0);
  const proj = projectMonth(key, s.expense, base, now) || s.expense;
  const { start, end } = monthRange(key);
  const daysAll = Math.round((end - start) / 864e5), dayNow = Math.min(daysAll, Math.floor((now - start) / 864e5) + 1), left = Math.max(1, daysAll - dayNow + 1);
  const disc = DISC.reduce((a, c) => a + (s.byCat[c] || 0), 0), discCap = g.spend * g.disc;
  const asset = s.asset || 0, P = currentPlan();
  const CH = challengeFor(key);
  g.asset = (CH && CH.invest) || P.total || g.asset;
  const pace = (g.spend - s.expense) / left, tf = dayNow / daysAll;
  return [
    { id: 'spend', t: 'هزینهٔ زندگی', tf, v: s.expense, cap: g.spend, p: s.expense / g.spend,
      st: proj <= g.spend ? 'g' : proj <= g.spend * 1.1 ? 'o' : 'r',
      note: pace > 0 ? `برای ماندن در سقف: روزی تا ${fmtShort(pace)} در ${faDigits(left)} روز باقی‌مانده` : `سقف رد شده؛ ${fmtShort(-pace * left)} بالاتر`,
      why: `پیش‌بینی پایان ماه ${fmtShort(proj)} است: ${fmtShort(s.expense)} تا امروز + میانگین روزانهٔ سه ماه اخیر (${fmtShort((base || 0) / 30)}) × ${faDigits(left)} روز.` },
    { id: 'disc', t: 'هزینه‌های اختیاری', tf, v: disc, cap: discCap, p: disc / discCap,
      st: disc <= discCap * (dayNow / daysAll) * 1.1 ? 'g' : disc <= discCap ? 'o' : 'r',
      note: `${faDigits(Math.round(g.disc * 100))}٪ از سقف هزینه، تفریح، هدیه، شخصی، دخانیات`,
      why: `سقف این بخش = ${faDigits(Math.round(g.disc * 100))}٪ × ${fmtShort(g.spend)} = ${fmtShort(discCap)}. تا امروز ${fmtShort(disc)} از آن مصرف شده.` },
    // Cash reserve: the weakest point in the analysis. Target = one month of living cost (average of the
    // last three months), then three months; investing is tracked by the challenge card above.
    (() => { const cash = balanceAt(S.tx, S.settings), done3 = series.filter(m => !m.running && (m.expense || m.work)).slice(-3);
      const mexp = done3.length ? done3.reduce((x, m) => x + (m.expense || 0), 0) / done3.length : g.spend;
      const cap = r5(cash >= mexp ? mexp * 3 : mexp), months = cap / mexp;
      return { id: 'cash', t: 'ذخیرهٔ نقدی', tf, v: cash, cap, p: cash / cap, st: cash >= cap ? 'g' : cash >= cap / 2 ? 'o' : 'r',
        note: cash >= cap ? 'ذخیره کامل است' : `${fmtShort(cap - cash)} مانده تا ذخیرهٔ ${faDigits(Math.round(months))} ماهه`,
        why: `ذخیرهٔ نقدی = موجودی بلو (${fmtShort(cash)}). هدف = هزینهٔ ${faDigits(Math.round(months))} ماه زندگی (میانگین ۳ ماه اخیر ${fmtShort(mexp)} × ${faDigits(Math.round(months))}). اول یک ماه، بعد سه ماه؛ تا وقتی این حلقه کامل نشده، هر خرج غیرمنتظره از سرمایه‌گذاری‌ها برداشته می‌شود.` }; })(),
  ];
}
// Three rings: the arc is what is used or saved; the details and arithmetic live in the goals sheet.
// Ring centre: the number on one line, its unit under it (both in the unit of the final value).
const ringNum = (v, div) => { const x = v / div; return iso(faDigits(x >= 100 || div === 1 ? Math.round(x) : Math.round(x * 10) / 10).replace('.', '٫')); };
function ring(r, i) {
  const p = Math.min(1, r.p || 0), R = 34, div = r.v >= 1e6 ? 1e6 : r.v >= 1e3 ? 1e3 : 1, unit = div === 1e6 ? 'میلیون' : div === 1e3 ? 'هزار' : 'تومان';
  return `<div class="ring ${r.st}" style="--d:${(i * .12).toFixed(2)}s">
    <div class="ring-box"><svg viewBox="0 0 80 80"><circle class="ring-track" cx="40" cy="40" r="${R}"/>
      ${p > 0 ? `<circle class="ring-arc" cx="40" cy="40" r="${R}" pathLength="100" style="--p:${(p * 100).toFixed(1)}"/>` : ''}
      ${r.p > 1 ? `<circle class="ring-over" cx="40" cy="40" r="${R}" pathLength="100" style="--p:${(Math.min(1, r.p - 1) * 100).toFixed(1)}"/>` : ''}
      <b class="ring-num"><span data-cu="${Math.round(r.v)}" data-f="ring" data-div="${div}">${ringNum(r.v, div)}</span><small>${unit}</small></b></div>
    <span class="ring-t">${esc(r.t)}</span><small class="ring-c">${r.id === 'cash' ? 'هدف' : 'سقف'} ${esc(fmtShort(r.cap))}</small></div>`;
}
// ----- Monthly challenge: stretch targets that climb when you hit them -----
// Set once at the start of each month and then fixed, so the bar does not move under you.
//  income: first month = the higher of 110% of your best month and 130% of your average (last 6 months);
//          after a month you beat: +10%; after a miss: same target again (never under 110% of average).
//  invest: a share of the income target; 30% to start, +2.5 points after every won month, up to 45%.
// A month is won when both are reached. Won months in a row are your streak and your level.
const r5 = v => Math.round(v / 5e6) * 5e6;
function challengeFor(key) {
  const C = (S.settings.challenge ||= {});
  if (C[key]) return C[key];
  const series = monthsSeries(S.history, scoped(), S.settings.startDate);
  const done = series.filter(m => !m.running && m.key < key && (m.expense || m.work)).slice(-6);
  if (!done.length) return null;
  const avg = done.reduce((a, m) => a + (m.work || 0), 0) / done.length, best = Math.max(...done.map(m => m.work || 0));
  const prevKey = shiftMonth(key, -1), prev = C[prevKey], pm = series.find(m => m.key === prevKey);
  let income = r5(Math.max(best * 1.1, avg * 1.3)), rate = .3, streak = 0;
  if (prev) {
    const won = pm && (pm.work || 0) >= prev.income && (pm.asset || 0) >= prev.invest;
    income = r5(Math.max(avg * 1.1, won ? prev.income * 1.1 : prev.income));
    rate = won ? Math.min(.45, prev.rate + .025) : prev.rate;
    streak = won ? (prev.streak || 0) + 1 : 0;
  }
  C[key] = { income, invest: r5(income * rate), rate, streak, avg: Math.round(avg), best: Math.round(best), set: new Date().toISOString() };
  saveSettings();
  return C[key];
}
const LEVELS = ['شروع', 'گرم شدن', 'در مسیر', 'پرقدرت', 'حرفه‌ای', 'استاد'];
function challengeCard(T, key) {
  const c = challengeFor(key);
  if (!c) return '';
  const s = monthSummary(T, key), work = s.work || 0, inv = s.asset || 0;
  const { start, end } = monthRange(key), daysAll = Math.round((end - start) / 864e5);
  const left = Math.max(1, Math.ceil((end - new Date()) / 864e5));
  const gapW = Math.max(0, c.income - work), gapI = Math.max(0, c.invest - inv);
  // Hours behind the money gap, at last month's income per hour from «زندگی من» (when it is known).
  const pk = shiftMonth(key, -1), L = sync.lifeMonth(pk), pm = monthsSeries(S.history, T, S.settings.startDate).find(m => m.key === pk);
  const perH = L && L.workMin >= 20 * 60 && pm ? (pm.work || 0) / (L.workMin / 60) : null;
  const bar = (v, t, id) => { const p = Math.min(1, v / t), pace = Math.min(1, 1 - left / daysAll);
    return `<div class="ch-row"><div class="ch-top"><span>${id === 'w' ? 'درآمد کاری' : 'سرمایه‌گذاری'}</span><b>${fmtShort(v)} <small>از ${fmtShort(t)}</small></b></div>
      <div class="ch-bar"><i class="${p >= 1 ? 'done' : p >= pace ? 'ok' : ''}" style="width:${(p * 100).toFixed(1)}%"></i><em style="right:${(pace * 100).toFixed(1)}%"></em></div></div>`; };
  const lvl = LEVELS[Math.min(LEVELS.length - 1, c.streak)];
  return `<button class="challenge" data-act="challenge">
    <div class="ch-head"><span class="b-label"><span class="live-dot"></span>چالش ${esc(monthName(key))}</span><span class="ch-lvl">سطح ${faDigits(c.streak + 1)}، ${lvl}</span></div>
    ${bar(work, c.income, 'w')}${bar(inv, c.invest, 'i')}
    <p class="ch-note">${gapW ? `برای بردن این ماه: ${fmtShort(gapW)} درآمد دیگر، یعنی روزی ${fmtShort(gapW / left)} در ${faDigits(left)} روز${perH ? `؛ حدود ${faDigits(Math.ceil(gapW / perH))} ساعت کار با نرخ ماه قبل` : ''}.` : 'هدف درآمد این ماه زده شد. '}${gapI ? ` و ${fmtShort(gapI)} سرمایه‌گذاری.` : ' سرمایه‌گذاری کامل شد.'}</p>
  </button>`;
}
function challengeSheet() {
  const key = monthKey(new Date()), c = challengeFor(key);
  if (!c) return;
  const C = S.settings.challenge, hist = Object.keys(C).filter(k => k < key).sort().slice(-6);
  const series = monthsSeries(S.history, scoped(), S.settings.startDate);
  openSheet(`<div class="sheet-nav"><span></span><b>چالش ماه</b><button class="link" data-close>بستن</button></div>
    <div class="group"><div class="cell col"><small class="sec why">
      <b>هدف درآمد ${fmtShort(c.income)}</b>: ${c.streak || hist.length ? 'ماه قبل را بردی؟ ۱۰٪ بالاتر؛ نبردی؟ همان هدف دوباره' : `بالاتر از ۱۱۰٪ بهترین ماهت (${fmtShort(c.best)}) و ۱۳۰٪ میانگین ۶ ماه (${fmtShort(c.avg)})`}. هیچ‌وقت کمتر از ۱۱۰٪ میانگین نمی‌شود.<br>
      <b>هدف سرمایه‌گذاری ${fmtShort(c.invest)}</b> = ${faDigits(Math.round(c.rate * 100))}٪ هدف درآمد. با هر ماهِ برده ۲٫۵ واحد بالا می‌رود، تا ۴۵٪.<br>
      <b>بردن ماه</b> = رسیدن به هر دو هدف. ماه‌های بردهٔ پشت سر هم، سطح تو را بالا می‌برد. خط کوچک روی نوار: جایی که با سرعت یکنواخت امروز باید باشی.</small></div></div>
    ${hist.length ? `<div class="section-title">ماه‌های قبل</div><div class="group">${hist.map(k => { const h = C[k], m = series.find(x => x.key === k) || {}, won = (m.work || 0) >= h.income && (m.asset || 0) >= h.invest;
      return `<div class="cell"><span class="grow">${esc(monthLabel(k))}<small class="avg-line">درآمد ${fmtShort(m.work || 0)} از ${fmtShort(h.income)}، سرمایه‌گذاری ${fmtShort(m.asset || 0)} از ${fmtShort(h.invest)}</small></span><b class="${won ? 'green' : 'red'}">${won ? 'برد' : 'باخت'}</b></div>`; }).join('')}</div>` : ''}`);
}

function goalsCard(T, key) {
  const R = goalRows(T, key), ok = R.filter(r => r.st === 'g').length;
  return `<button class="goals" data-act="goals">
    <div class="goals-head"><span class="b-label"><span class="live-dot"></span>هدف‌های ${esc(monthName(key))}</span><span class="sec">${faDigits(ok)} از ${faDigits(R.length)} در مسیر</span></div>
    <div class="rings">${R.map(ring).join('')}</div>
  </button>`;
}
// Suggested targets from your own last three months: 10% under the usual spend, optional share as it is now (max 40%), invest 10% of work income.
function goalSuggest(T) {
  const series = monthsSeries(S.history, T, S.settings.startDate).filter(m => !m.running && (m.expense || m.work)).slice(-3);
  if (!series.length) return null;
  const avg = f => series.reduce((a, m) => a + f(m), 0) / series.length;
  const exp = avg(m => m.expense || 0), work = avg(m => m.work || 0), disc = avg(m => DISC.reduce((a, c) => a + ((m.byCat || {})[c] || 0), 0));
  const r5 = v => Math.round(v / 5e6) * 5e6;
  return { spend: r5(exp * .9), disc: Math.min(.4, Math.round(disc / exp * 20) / 20 || .35), asset: Math.max(5e6, r5(work * .1)), exp, work };
}
function goalsSheet() {
  const T = scoped(), key = monthKey(new Date()), R = goalRows(T, key), g = goals(), sg = goalSuggest(T);
  openSheet(`<div class="sheet-nav"><button class="link" data-close>بستن</button><b>هدف‌های ماه</b><button class="link strong" data-act="save">ذخیره</button></div>
    <div class="group">${R.map(r => `<div class="cell col"><div class="goal-top"><span><i class="kdot ${r.st}"></i>${esc(r.t)}</span><b>${esc(fmtShort(r.v))} <small>از ${esc(fmtShort(r.cap))}</small></b></div><small class="sec why">${esc(r.why)}</small></div>`).join('')}</div>
    ${sg ? `<div class="section-title">پیشنهاد بر اساس سه ماه اخیر</div>
    <div class="group"><div class="cell col"><small class="sec why">میانگین هزینه ${fmtShort(sg.exp)} و درآمد کاری ${fmtShort(sg.work)}. سقف هزینه ۱۰٪ زیر میانگین و سهم اختیاری همان سهم فعلی (حداکثر ۴۰٪). سرمایه‌گذاری خودکار است؛ جزئیاتش در «دارایی‌ها».</small>
      <div class="goal-top" style="margin-top:8px"><span>سقف ${fmtShort(sg.spend)}، سهم اختیاری ${faDigits(Math.round(sg.disc * 100))}٪</span><button class="link strong" data-act="use">استفاده</button></div></div></div>` : ''}
    <div class="section-title">تنظیم دستی</div>
    <div class="group">
      <div class="cell"><span>سقف هزینهٔ زندگی (تومان)</span><input class="bare end" id="g-spend" inputmode="numeric" value="${fmt(g.spend)}"></div>
      <div class="cell"><span>سهم اختیاری از سقف (٪)</span><input class="bare end" id="g-disc" inputmode="numeric" value="${faDigits(Math.round(g.disc * 100))}"></div>
      <div class="cell"><span>سرمایه‌گذاری ماهانه</span><span class="sec">خودکار، بر اساس درآمد این ماه</span></div>
    </div>`, {
    use: () => { document.getElementById('g-spend').value = fmt(sg.spend); document.getElementById('g-disc').value = faDigits(Math.round(sg.disc * 100)); },
    save: async () => {
      const sp = parseAmount(document.getElementById('g-spend').value), d = parseAmount(document.getElementById('g-disc').value), as = (S.settings.goals || {}).asset;
      S.settings.goals = { spend: sp || GOAL_DEF.spend, disc: d ? Math.min(.9, d / 100) : GOAL_DEF.disc, asset: as || GOAL_DEF.asset };
      await saveSettings(); closeSheet(); render(); toast('هدف‌ها ذخیره شد');
    } }, root => ['g-spend'].forEach(id => { const i = root.querySelector('#' + id); i.addEventListener('input', () => { const v = parseAmount(i.value); i.value = v ? fmt(v) : ''; }); }));
}

function assetTile() {
  const A = assetsState(), { cash, held } = assetsTotal();
  return `<button class="asset-tile" data-act="go-assets"><span class="grow"><span class="b-label">همهٔ دارایی‌ات</span><b>${fmtShort(cash + held)}</b><small>${A.items.length ? `نقد ${fmtShort(cash)}، دلار، طلا و بقیه ${fmtShort(held)}` : 'دلار، طلا، نقره و باکس را اضافه کن'}</small></span>${ICON.chevL}</button>`;
}

// ----- Analysis as a news feed: totals so far, averages, records, events, critiques and suggestions -----
function newsItems(series, A) {
  const done = series.filter(m => !m.running && (m.expense || m.work)), n = done.length;
  if (!n) return [];
  const sum = f => done.reduce((a, m) => a + (f(m) || 0), 0), pts = f => series.map(m => ({ key: m.key, running: m.running, v: f(m) || 0 }));
  const span = `${monthName(done[0].key)} تا ${monthName(done.at(-1).key)}`;
  const max = f => done.reduce((x, m) => (f(m) > f(x) ? m : x), done[0]), min = f => done.reduce((x, m) => (f(m) < f(x) ? m : x), done[0]);
  const work = sum(m => m.work), exp = sum(m => m.expense), fam = sum(m => m.family), inv = sum(m => m.asset);
  const invMonths = done.filter(m => m.asset > 0), lastInv = invMonths.at(-1);
  const bal = balanceAt(S.tx, S.settings), runway = exp ? bal / (exp / n) : 0;
  const N = [];
  N.push({ k: 'پیشرفت', t: `تا امروز ${fmtShort(inv)} سرمایه‌گذاری`, d: `در ${faDigits(invMonths.length)} ماه از ${faDigits(n)} ماه${lastInv ? `؛ آخرین بار ${monthName(lastInv.key)} (${fmtShort(lastInv.asset)})` : ''}.`, c: pts(m => m.asset) });
  N.push({ k: 'درآمد', t: `میانگین درآمد کاری: ماهانه ${fmtShort(work / n)}`, d: `جمعاً ${fmtShort(work)} از ${span}؛ بهترین ماه ${monthName(max(m => m.work).key)} با ${fmtShort(max(m => m.work).work)}.`, c: pts(m => m.work) });
  N.push({ k: 'هزینه', t: `میانگین هزینهٔ زندگی: ماهانه ${fmtShort(exp / n)}`, d: `کمترین ${monthName(min(m => m.expense).key)} (${fmtShort(min(m => m.expense).expense)})، بیشترین ${monthName(max(m => m.expense).key)} (${fmtShort(max(m => m.expense).expense)}).`, c: pts(m => m.expense) });
  N.push({ k: 'پوشش', t: `درآمد کاری ${faDigits(Math.round(work / exp * 100))}٪ هزینه‌ها را پوشش داده`, d: `${fmtShort(work)} درآمد ÷ ${fmtShort(exp)} هزینه. از هر ۱۰۰ تومان هزینه، ${faDigits(Math.round(work / exp * 100))} تومان از کار بوده.`, c: pts(m => m.expense ? m.work / m.expense : 0), pct: true });
  N.push({ k: 'حمایت', t: `${fmtShort(fam)} حمایت خانواده`, d: `${faDigits(Math.round(fam / (work + fam) * 100))}٪ ورودیِ زندگی؛ ماهانه حدود ${fmtShort(fam / n)}.` });
  N.push({ k: 'ذخیره', t: `موجودی نقد برای ${iso(faDigits(runway.toFixed(1).replace('.', '٫')))} ماه هزینه`, d: `موجودی ${fmtShort(bal)} ÷ میانگین هزینهٔ ماهانه ${fmtShort(exp / n)}. هدف معمول: سه ماه.`, tone: runway < 1 ? 'r' : runway < 3 ? 'o' : 'g' });
  const last = done.at(-1), lastOut = (last.outs || []).slice().sort((a, b) => b[1] - a[1])[0];
  if (lastOut) N.push({ k: 'رویداد', t: `${monthName(last.key)}: ${lastOut[0]}`, d: `${fmtShort(lastOut[1])}؛ بزرگ‌ترین پرداخت ماه.` });
  // Market: price moves this week, what they did to your holdings, and this month's plan.
  if (S.market) {
    const H = heldByKind(), V = Object.values(H).reduce((a, b) => a + b, 0);
    const st = MARKET_KINDS.map(k => mstats(S.market, k)).filter(Boolean);
    const eff = st.reduce((a, t) => a + (t.m != null ? H[t.k] - H[t.k] / (1 + t.m) : 0), 0);
    if (V && Math.abs(eff) > 1e6) N.push({ k: 'بازار', t: `دارایی‌هایت در ۳۰ روز ${eff >= 0 ? 'بالا رفت' : 'پایین آمد'}: ${sgnShort(eff)}`, d: `فقط اثر قیمت روی همین مقدارها (دلار، یورو، طلا، نقره)؛ ارزش فعلی ${fmtShort(V)}.`, tone: eff >= 0 ? 'g' : 'r' });
    const big = st.slice().sort((a, b) => Math.abs(b.w || 0) - Math.abs(a.w || 0))[0];
    if (big && big.w != null) N.push({ k: 'بازار', t: `${MK[big.k].label} این هفته ${pctS(big.w)}`, d: `${MK[big.k].per} ${fmt(big.last)} تومان؛ ${msignal(big).note}` });
    const c = challengeFor(monthKey(new Date())), cs = monthSummary(scoped(), monthKey(new Date()));
    if (c) N.push({ k: 'چالش', t: `چالش ${monthName(monthKey(new Date()))}: ${fmtShort(cs.work || 0)} از ${fmtShort(c.income)} درآمد`, d: `سرمایه‌گذاری ${fmtShort(cs.asset || 0)} از ${fmtShort(c.invest)}. سطح ${faDigits(c.streak + 1)}؛ با بردن این ماه، هدف ماه بعد ۱۰٪ بالاتر می‌رود.`, tone: (cs.work || 0) >= c.income ? 'g' : '' });
    const P = currentPlan(), top = P.rows.slice().sort((a, b) => b.amt - a.amt)[0];
    if (P.total && top) N.push({ k: 'پیشنهاد', t: `سرمایه‌گذاری این ماه: ${fmtShort(P.total)}`, d: `بیشترش ${MK[top.k].label} (${fmtShort(top.amt)})، چون از سهم هدفش عقب‌تر است. جزئیات در «دارایی‌ها».` });
  }
  for (const x of A.critiques) N.push({ k: 'نقد', t: x.t, d: x.d, tone: 'r' });
  for (const x of A.tips) N.push({ k: 'پیشنهاد', t: x.t, d: x.d });
  for (const x of A.good) N.push({ k: 'خبر خوب', t: x.t, d: x.d, tone: 'g' });
  return N;
}

// Frosted-glass bars: one per month, the running month faint. Labels all in millions so they compare.
const mil = v => faDigits(String(Math.round(v / 1e6 * (v < 1e7 ? 10 : 1)) / (v < 1e7 ? 10 : 1)).replace('.', '٫'));
function glassBars(pts, pct) {
  const W = 320, H = 86, bw = W / pts.length, mx = Math.max(...pts.map(p => p.v), 1e-9);
  return `<svg viewBox="0 0 ${W} ${H}" class="glass-chart"><defs><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient></defs>
    ${pts.map((p, i) => { const h = Math.max(3, p.v / mx * (H - 26)), x = i * bw + bw * .16, w = bw * .68;
      return `<rect class="gbar${p.running ? ' run' : ''}" x="${x.toFixed(1)}" y="${(H - 16 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="5" style="animation-delay:${(i * .05).toFixed(2)}s"/>
        <text x="${(x + w / 2).toFixed(1)}" y="${(H - 19 - h).toFixed(1)}" text-anchor="middle" class="g-val">${p.v ? (pct ? faDigits(Math.round(p.v * 100)) + '٪' : mil(p.v)) : ''}</text>
        <text x="${(x + w / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" class="spark-lbl">${esc(monthName(p.key))}</text>`; }).join('')}</svg>`;
}

// Headlines like stories: segments fill while a slide is shown, the kicker pill reshapes to the next
// word, the headline arrives word by word. Tap or swipe for next, hold to pause.
const words = t => esc(t).split(' ').map((w, i) => `<span class="w" style="--i:${i}">${w}</span>`).join(' ');
function newsHero(N) {
  const top = N.slice(0, 4);
  if (!top.length) return '';
  return `<section class="car b-primary news" data-carousel><div class="stripes"></div>
    <div class="car-segs">${top.map((_, i) => `<i class="${i ? '' : 'on'}"><b></b></i>`).join('')}</div>
    <div class="car-head"><span><span class="live-dot"></span>سرخط‌ها</span><span class="car-kick"><span>${esc(top[0].k)}</span></span></div>
    <div class="car-stage">${top.map((x, i) => `<div class="car-slide${i ? '' : ' on'}" data-k="${esc(x.k)}">
      <h3 class="news-t">${words(x.t)}</h3><p class="car-mean">${esc(x.d)}</p>${x.c ? glassBars(x.c, x.pct) : ''}</div>`).join('')}</div></section>`;
}

const newsCard = x => `<div class="news-card"><span class="news-k ${x.tone || ''}">${esc(x.k)}</span><b>${esc(x.t)}</b><p>${esc(x.d)}</p></div>`;

const TIER = { 1: 'اولویت ۱، پایه‌ای', 2: 'اولویت ۲، مهم', 3: 'اولویت ۳، برای بهتر شدن' };
const kpiNum = (k, v) => k.unit === 'pct' ? faDigits(Math.round(v * 100)) + '٪' : fmtShort(v);

function kpiList(K) {
  return [1, 2].map(t => `<div class="section-title">${TIER[t]}</div><div class="group">${K.filter(k => k.tier === t).map(k =>
    `<button class="cell kpi" data-act="kpi" data-v="${k.id}"><i class="kdot ${k.status}"></i><span class="grow"><b>${esc(k.title)}</b><small>${esc(k.target)}</small></span><b class="kpi-val">${esc(k.value)}</b>${ICON.chevL}</button>`).join('')}</div>`).join('');
}

function kpiSheet(id) {
  const K = kpis(monthsSeries(S.history, scoped(), S.settings.startDate), balanceAt(S.tx, S.settings), assetsTotal().held), k = K.find(x => x.id === id);
  if (!k) return;
  infoSheet(k.title, [['الان', k.value], ...k.points.map(p => [monthLabel(p.key) + (p.running ? ' (تا الان)' : ''), kpiNum(k, p.v)])], `${esc(k.mean)}<br><b>${esc(k.target)}</b>`);
}

function advanceCarousel(el, step = 1) {
  const slides = [...el.querySelectorAll('.car-slide')], segs = [...el.querySelectorAll('.car-segs i')];
  if (slides.length < 2) return;
  const i = slides.findIndex(x => x.classList.contains('on')), j = (i + step + slides.length) % slides.length;
  slides[i].classList.remove('on'); slides[j].classList.add('on');
  segs.forEach((d, n) => { d.classList.remove('on'); d.classList.toggle('done', n < j); });
  void el.offsetWidth; segs[j].classList.add('on');
  const kick = el.querySelector('.car-kick'), inner = kick.firstElementChild;
  kick.style.width = kick.offsetWidth + 'px';
  inner.classList.add('out');
  setTimeout(() => {
    inner.textContent = slides[j].dataset.k; inner.classList.remove('out');
    kick.style.width = (inner.offsetWidth + 24) + 'px';
  }, 180);
}

function bindCarousel() {
  document.querySelectorAll('[data-carousel]').forEach(el => {
    el.addEventListener('animationend', e => { if (e.target.matches('.car-segs i.on b')) advanceCarousel(el); });
    let x0 = 0, y0 = 0, t0 = 0, holdT = null;
    el.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); holdT = setTimeout(() => el.classList.add('hold'), 220); });
    const end = e => {
      clearTimeout(holdT);
      const held = el.classList.contains('hold'); el.classList.remove('hold');
      if (e.type !== 'pointerup' || held) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) advanceCarousel(el, dx > 0 ? 1 : -1);
      else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - t0 < 400) advanceCarousel(el);
    };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, end));
  });
}

// Plain-text report anyone can read: summary, month by month, critique, suggestions.
function analysisReport() {
  const series = monthsSeries(S.history, scoped(), S.settings.startDate);
  const A = analyze(series);
  if (!A) return 'هنوز داده‌ای برای گزارش نیست.';
  const m = v => fmtShort(v || 0);
  const L = [`گزارش مالی — ${monthLabel(A.first)} تا ${monthLabel(A.last)} (${faDigits(A.n)} ماه، تومان)`, ''];
  L.push('خلاصه', `• ${A.verdict}`, `• میانگین ماهانه: درآمد کاری ${m(A.avgWork)}، خرج ${m(A.avgExp)}`,
    `• کمک خانواده در کل دوره: ${m(A.family)} (${faDigits(Math.round(A.famShare * 100))}٪ پول ورودی)`, `• دارایی خریده‌شده (دلار، نقره، دوچرخه): ${m(A.asset)}`, '');
  L.push('ماه به ماه (ورودی / خروجی / تراز، درآمد کاری، هزینهٔ زندگی)');
  for (const x of series) { const net = (x.inT || 0) - (x.outT || 0); L.push(`• ${monthLabel(x.key)}${x.running ? ' (در جریان)' : ''}: ${m(x.inT)} / ${m(x.outT)} / ${net >= 0 ? '+' : '−'}${m(Math.abs(net))}، کار ${m(x.work)}، خرج ${m(x.expense)}`); }
  const K = kpis(series, balanceAt(S.tx, S.settings), assetsTotal().held);
  L.push('', 'شاخص‌های مهم');
  for (const k of K) L.push(`• ${k.title}: ${k.value} (${k.status === 'g' ? 'خوب' : k.status === 'o' ? 'متوسط' : 'ضعیف'}) — ${k.target}`);
  const top = Object.entries(A.cats).sort((a, b) => b[1] - a[1]).slice(0, 5);
  L.push('', 'بیشترین خرج‌ها در کل دوره');
  for (const [c, v] of top) L.push(`• ${(CATEGORIES[c] || CATEGORIES.other).label}: ${m(v)} (${faDigits(Math.round(v / A.expense * 100))}٪)`);
  const sec = (t, list) => list.length && L.push('', t, ...list.map(x => `• ${x.t}: ${x.d}`));
  sec('انتقاد', A.critiques); sec('پیشنهاد', A.tips); sec('خوب‌ها', A.good);
  const f = A.flags, notes = [f.unknown && `${m(f.unknown)} ورودی نامشخص جزو درآمد نیست`, f.assumed && `${m(f.assumed)} با حدس درآمد کاری حساب شده`, f.vague && `${m(f.vague)} خرج با عنوان نامعلوم شخصی حساب شده`].filter(Boolean);
  if (notes.length) L.push('', 'دقت داده: ' + notes.join('، '));
  L.push('', 'منبع: جدول Numbers تا مهر، ثبت‌های اپ از آبان. فقط جمع‌ها، بدون نام.');
  return L.join('\n');
}

// Day-by-day spending inside one month (only months recorded in the app have days).
function dayStrip(m) {
  if (!m) return '';
  if (!m.live) return `<p class="foot an-flags">روزبه‌روز فقط برای ماه‌هایی هست که در خود اپ ثبت شده‌اند (از آبان).</p>`;
  const { start, end } = monthRange(m.key);
  const days = Math.round((end - start) / 864e5);
  const v = new Array(days).fill(0);
  for (const t of scoped()) {
    if (t.type !== 'expense') continue;
    const d = new Date(t.ts);
    if (d >= start && d < end) v[Math.floor((d - start) / 864e5)] += t.amount;
  }
  const mx = Math.max(...v, 1);
  const today = Math.floor((Date.now() - start) / 864e5);
  const past = v.slice(0, Math.min(days, today + 1)).filter(x => x > 0);
  const avg = past.length ? past.reduce((a, b) => a + b, 0) / past.length : 0;
  const lo = past.length > 2 ? v.indexOf(Math.min(...past)) : -1;
  return `<div class="section-title">روز به روز</div><div class="group"><div class="cell col">
    <div class="days">${v.map((x, i) => `<i title="${faDigits(i + 1)}" class="${i > today ? 'future' : i === lo ? 'low' : avg && x > avg ? 'over' : ''}" style="height:${x ? Math.max(6, x / mx * 100).toFixed(0) : 3}%"></i>`).join('')}${avg ? `<span class="avg" style="bottom:${(avg / mx * 100).toFixed(1)}%"></span>` : ''}</div>
    <div class="days-axis"><span>${faDigits(1)}</span><span>${faDigits(Math.ceil(days / 2))}</span><span>${faDigits(days)}</span></div>
  </div></div>`;
}

function viewDash() {
  const T = scoped();
  const key = S.month;
  const startKey = S.settings.startDate ? monthKey(new Date(S.settings.startDate)) : '';
  if (S.history && S.history.months && S.history.months[key] && (!startKey || key < startKey || !T.some(t => monthKey(new Date(t.ts)) === key))) return viewHistory(key);
  const s = monthSummary(T, key);
  const bal = balanceAt(S.tx, S.settings);
  const chk = bankCheck(S.tx, S.settings);
  return `<div class="view wide">
    ${pageHead('خلاصه', monthNav(key))}

    <section class="bento one">
      <div class="b-primary tap" data-act="detail" data-k="bal">
        <div class="stripes"></div>
        <div><span class="b-pill"><span class="live-dot"></span>موجودی بلو</span><h3 class="b-hero" data-odo="${Math.round(bal)}">${fmt(bal)}</h3></div>
        <p class="b-note ticker" data-ticker>${liveLines(T, chk).map((m, i) => `<span class="${i ? '' : 'on'}">${m}</span>`).join('')}</p>
      </div>
    </section>
    ${key === monthKey(new Date()) ? lifeInbox() : ''}
    ${workMoneyCard(key)}
    ${key === monthKey(new Date()) ? challengeCard(T, key) : ''}
    ${key === monthKey(new Date()) ? goalsCard(T, key) : ''}
    ${liveStory(T, key)}
    ${assetTile()}
    <div id="trend">${trendCard()}</div>
  </div>`;
}

// Rotating one-liners under the balance so the app feels alive.
function liveLines(T, chk) {
  const now = new Date(), j = toJalali(now), len = monthLength(j.jy, j.jm);
  const today = T.filter(t => t.type === 'expense' && new Date(t.ts).toDateString() === now.toDateString());
  const last = T.filter(t => t.src === 'manual').sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const ms = monthSummary(T, monthKey(now));
  const lines = [];
  lines.push(today.length ? `امروز ${faDigits(today.length)} خرج، ${fmtShort(today.reduce((a, t) => a + t.amount, 0))}` : 'امروز هنوز خرجی ثبت نشده');
  if (last) lines.push(`آخرین ثبت: <span data-ago="${last.ts}">${ago(last.ts)}</span>، ${esc(last.desc)}`);
  lines.push(`روز ${faDigits(j.jd)} از ${faDigits(len)}، ${faDigits(len - j.jd)} روز تا آخر ${monthLabel(monthKey(now)).split(' ')[0]}`);
  const proj = projectMonth(monthKey(now), ms.expense, baseline(monthsSeries(S.history, T, S.settings.startDate), m => m.expense || 0), now);
  if (ms.expense && proj) lines.push(`پیش‌بینی خرج این ماه: حدود ${fmtShort(proj)} (میانگین ۳ ماه اخیر در نظر گرفته شده)`);
  const lb = S.settings.lastBackup;
  if (!isTablet() && (!lb || Date.now() - new Date(lb) > 7 * 864e5)) lines.push(`${lb ? 'یک هفته از آخرین پشتیبان گذشته' : 'هنوز پشتیبانی گرفته نشده'}؛ تنظیمات ← ذخیرهٔ پشتیبان`);
  if (chk) lines.push(Math.abs(chk.diff) <= 1000 ? 'با حساب بانکی یکی است' : `${fmtShort(Math.abs(chk.diff))} اختلاف با حساب بانکی`);
  return lines;
}

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (m < 1) return 'همین حالا';
  if (m < 60) return `${faDigits(m)} دقیقه پیش`;
  if (m < 60 * 24) return `${faDigits(Math.round(m / 60))} ساعت پیش`;
  const d = Math.round(m / 1440);
  return d === 1 ? 'دیروز' : `${faDigits(d)} روز پیش`;
}

// One clock for all live bits: rotate tickers, refresh «… ago» labels.
let liveTick = 0;
setInterval(() => {
  liveTick++;
  if (liveTick % 4 === 0) document.querySelectorAll('[data-ticker]').forEach(el => {
    const items = [...el.children];
    if (items.length < 2) return;
    const i = items.findIndex(x => x.classList.contains('on'));
    items[i].classList.remove('on'); items[(i + 1) % items.length].classList.add('on');
  });
  if (liveTick % 30 === 0) document.querySelectorAll('[data-ago]').forEach(el => { el.textContent = ago(el.dataset.ago); });
}, 1000);

// Eleven bars of cumulative income through the month, like the bento "growth" tile.
function incomeBars(T, key) {
  const { start, end } = monthRange(key);
  const [jy, jm] = key.split('-').map(Number);
  const len = monthLength(jy, jm), daily = Array(len).fill(0);
  for (const t of T) {
    const d = new Date(t.ts);
    if (t.type === 'income_work' && d >= start && d < end) daily[toJalali(d).jd - 1] += t.amount;
  }
  for (let i = 1; i < len; i++) daily[i] += daily[i - 1];
  const pts = Array.from({ length: 11 }, (_, i) => daily[Math.round(i * (len - 1) / 10)]);
  const max = Math.max(1, ...pts);
  return pts.map(v => `<i class="${v ? '' : 'zero'}" style="height:${Math.max(8, v / max * 100).toFixed(0)}%"></i>`).join('');
}

// ----- Trend chart (TradingView-like): one field over time, crosshair, compare, measure -----
const TR_FIELDS = [['expense', 'کل خرج'], ['work', 'درآمد کاری'], ['family', 'از خانواده'],
  ...PICKABLE_CATS.map(c => [c, CATEGORIES[c].label])];
const TR_FRAMES = [['1w', '۷ روز'], ['1m', 'این ماه'], ['3m', '۳ ماه'], ['6m', '۶ ماه'], ['all', 'همه']];
const isGlass = () => document.documentElement.classList.contains('glass');
const trLabel = f => (TR_FIELDS.find(x => x[0] === f) || [, ''])[1];
const trColor = f => f === 'work' ? '#30d158' : f === 'family' ? '#ff9f0a' : f === 'expense' ? (isGlass() ? '#e0603a' : '#2962ff') : CATEGORIES[f].color;
const upGood = f => f === 'work' || f === 'family';

// Money of one field inside a transaction (daily frames) or a month record (monthly frames).
const txValue = (t, f) => f === 'expense' ? (t.type === 'expense' ? t.amount : 0)
  : f === 'work' ? (t.type === 'income_work' ? t.amount : 0)
  : f === 'family' ? (t.type === 'family' ? t.amount : 0)
  : (t.type === 'expense' && t.cat === f ? t.amount : 0);
const monthValue = (m, f) => ['expense', 'work', 'family'].includes(f) ? (m[f] || 0) : ((m.byCat || {})[f] || 0);

const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function trendPoints(field, frame) {
  const T = scoped(), now = new Date();
  if (frame === '1w' || frame === '1m') {
    const n = frame === '1w' ? 7 : toJalali(now).jd;
    const pts = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      pts.push({ d, time: isoDay(d), label: frame === '1w' ? WEEKDAY_SHORT[d.getDay()] : faDigits(toJalali(d).jd), full: formatJalali(d), value: 0, running: i === 0 });
    }
    for (const t of T) {
      const d = new Date(t.ts), idx = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - pts[0].d) / 864e5);
      if (idx >= 0 && idx < n) pts[idx].value += txValue(t, field);
    }
    return pts;
  }
  const series = monthsSeries(S.history, T, S.settings.startDate);
  const keep = frame === '3m' ? 3 : frame === '6m' ? 6 : series.length;
  const base = baseline(series, m => monthValue(m, field));
  return series.slice(-keep).map(m => {
    const p = { key: m.key, time: isoDay(monthRange(m.key).start), label: monthLabel(m.key).split(' ')[0], full: monthLabel(m.key), value: monthValue(m, field), running: !!m.running };
    if (m.running && !upGood(field)) p.proj = projectMonth(m.key, p.value, base, now);
    return p;
  });
}

// Typical month: average of the last three finished months.
function baseline(series, get) {
  const done = series.filter(m => !m.running && (m.expense || m.work)).slice(-3);
  return done.length ? done.reduce((a, m) => a + get(m), 0) / done.length : null;
}

// End-of-month estimate: what is already spent plus a typical month's pace for the days left.
// Early in the month a straight line from 2–3 days wildly overshoots, so the rest comes from history.
function projectMonth(key, sofar, base, now = new Date()) {
  const { start, end } = monthRange(key);
  const k = Math.min(1, Math.max(0, (now - start) / (end - start)));
  if (base == null) return k >= .25 ? sofar / k : null;
  return sofar + (1 - k) * base;
}

// Price-scale style ticks: a round step (1, 2, 2.5, 5 × 10^k) and a top that is a multiple of it.
function niceScale(max) {
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw);
  return { step, top: Math.ceil(max / step) * step };
}

// The chart itself is TradingView's own open-source engine (Lightweight Charts, Apache-2.0), vendored so it
// works offline: same price scale, crosshair, pinch-zoom, pan and pulsing last price as on tradingview.com.
// Around it: field picker, timeframes, compare, and a legend that follows the crosshair.
let trChart = null;
function trendCard() {
  const tr = S.tr, pts = trendPoints(tr.field, tr.frame), col = trColor(tr.field);
  const frames = TR_FRAMES.map(([k, l]) => `<button data-act="tr-frame" data-v="${k}" class="${tr.frame === k ? 'on' : ''}">${l}</button>`).join('');
  const last = pts[pts.length - 1];
  return `<div class="tv">
    <div class="tv-bar">
      <button class="tv-field" data-act="tr-pick"><i style="background:${col}"></i>${esc(trLabel(tr.field))}<span class="sec">▾</span></button>
    </div>
    <div class="tv-frames">${frames}</div>
    <div class="tv-legend" id="tr-legend"></div>
    <div class="tv-stage"><div class="tv-chart lw" id="tr-wrap"></div><div class="tv-ov" id="tr-ov"></div></div>
    ${tr.picking ? `<div class="tr-fields tr-cmp">${TR_FIELDS.filter(x => x[0] !== tr.field).map(([k, l]) => `<button data-act="tr-cmpf" data-v="${k}" class="${tr.cmps.includes(k) ? 'on' : ''}"><i style="background:${trColor(k)}"></i>${l}</button>`).join('')}</div>` : ''}
    ${tr.cmps.length ? `<p class="tv-hint">${tr.pct ? 'حالت ٪: هر خط از اولین ماهی که عدد داشته صفر شروع می‌شود؛ عدد = (این ماه ÷ همان ماه − ۱) × ۱۰۰.' : 'حالت تومان: همهٔ خط‌ها روی یک مقیاس. «٪» را بزن تا رشدها مقایسه شوند، نه مبلغ‌ها.'}</p>` : ''}
    <p class="tv-hint">بکش تا جابه‌جا شود، با دو انگشت بزرگ و کوچک کن، انگشتت را نگه دار تا عدد هر نقطه را ببینی.${last && last.proj ? ' خط‌چین «پیش‌بینی» = خرج تا امروز + میانگین ۳ ماه اخیر برای روزهای باقی‌مانده.' : ''}</p>
  </div>`;
}

function redrawTrend() { const el = document.getElementById('trend'); if (el) { el.innerHTML = trendCard(); bindTrend(); } }

function bindTrend() {
  const wrap = document.getElementById('tr-wrap');
  if (trChart) { try { trChart.remove(); } catch {} trChart = null; }
  if (!wrap) return;
  const tr = S.tr, pts = trendPoints(tr.field, tr.frame), cmps = tr.cmps.map(f => ({ f, pts: trendPoints(f, tr.frame) }));
  if (!pts.length) return;
  const daily = tr.frame === '1w' || tr.frame === '1m', col = trColor(tr.field);
  const top = Math.max(1, ...pts.map(p => Math.max(p.value, p.proj || 0)), ...cmps.flatMap(c => c.pts.map(p => p.value)));
  const unit = top >= 2e6 ? 1e6 : 1e3;
  // ٪ mode: each line becomes its change from its own first non-zero value, so growth compares, not size.
  const pctOn = tr.pct && cmps.length;
  const num = pctOn ? v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${faDigits(Math.abs(Math.round(v)))}٪` : v => faDigits(String(Math.round(v / unit * 10) / 10).replace('.', '٫'));
  const rel = arr => { const k = arr.findIndex(p => p.value > 0), b = k >= 0 ? arr[k].value : 0; return arr.map((p, i) => !pctOn ? { time: p.time, value: p.value } : i < k || !b ? { time: p.time } : { time: p.time, value: (p.value / b - 1) * 100 }); };
  const toDate = t => typeof t === 'string' ? new Date(t + 'T12:00') : t.year ? new Date(t.year, t.month - 1, t.day, 12) : new Date(t * 1000);
  const tick = t => { const d = toDate(t), j = toJalali(d); return daily ? faDigits(j.jd) : monthLabel(monthKey(d)).split(' ')[0]; };
  const full = t => { const d = toDate(t); return daily ? formatJalali(d) : monthLabel(monthKey(d)); };
  const ink = a => isGlass() ? `rgba(29,27,25,${a})` : `rgba(235,235,245,${a})`;
  trChart = createChart(wrap, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: ink(.6), fontFamily: 'Estedad, system-ui, sans-serif', fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: ink(.04) }, horzLines: { color: ink(.07) } },
    rightPriceScale: { borderColor: ink(.14), scaleMargins: { top: cmps.length ? .42 : .24, bottom: .08 } },
    timeScale: { borderColor: ink(.14), tickMarkFormatter: tick, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
    crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: ink(.45), labelBackgroundColor: isGlass() ? '#1d1b19' : '#e9e9ee' }, horzLine: { color: ink(.45), labelBackgroundColor: col } },
    localization: { priceFormatter: num, timeFormatter: full },
    handleScroll: { vertTouchDrag: false },
  });
  const main = trChart.addSeries(AreaSeries, {
    lineColor: col, topColor: col + '55', bottomColor: col + '00', lineWidth: 2,
    priceFormat: { type: 'custom', formatter: num, minMove: unit / 10 },
    lastPriceAnimation: pts[pts.length - 1].running ? LastPriceAnimationMode.Continuous : LastPriceAnimationMode.Disabled,
    crosshairMarkerRadius: 5, crosshairMarkerBorderColor: isGlass() ? '#fff' : '#0b0c0e', pointMarkersVisible: true, pointMarkersRadius: 2.5,
  });
  main.setData(rel(pts));
  // Small value labels over the points; on busy frames only every few days plus the latest.
  const vals = rel(pts), every = Math.ceil(pts.length / 8);
  createSeriesMarkers(main, vals.map((d, i) => d.value == null || (i % every && i !== pts.length - 1) ? null
    : { time: d.time, position: 'atPriceTop', price: d.value, shape: 'circle', size: 0, color: ink(.75), text: pctOn || Math.abs(d.value) < unit * 10 ? num(d.value) : faDigits(Math.round(d.value / unit)) }).filter(Boolean));
  const done = pts.filter(p => !p.running), avg = done.length > 1 ? done.reduce((a, p) => a + p.value, 0) / done.length : 0;
  if (avg && !pctOn) main.createPriceLine({ price: avg, color: ink(.45), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'میانگین' });
  const last = pts[pts.length - 1];
  if (last.proj && !pctOn) main.createPriceLine({ price: last.proj, color: col, lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: true, title: 'پیش‌بینی' });
  for (const c of cmps) trChart.addSeries(LineSeries, { color: trColor(c.f), lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 2, priceFormat: { type: 'custom', formatter: num, minMove: unit / 10 } }).setData(rel(c.pts));
  trChart.timeScale().fitContent();

  // Legend above the chart follows the crosshair, like TradingView's top-left OHLC line.
  const legend = document.getElementById('tr-legend');
  const show = i => {
    const p = pts[i], prev = pts[i - 1]; S.tr.hover = i;
    const v = p.running && p.proj ? p.proj : p.value, d = prev && prev.value && !(p.running && !p.proj && !daily) ? (v - prev.value) / prev.value : null;
    const good = d == null ? null : (d > 0) === upGood(tr.field);
    legend.innerHTML = `<span class="sec">${esc(p.full)}${p.running ? '، <span class="live-dot"></span>تا الان' : ''}</span>
      <button class="tv-num" data-act="detail" data-k="trend"><b>${fmtShort(p.value)}</b>${ICON.chevL}</button>
      ${d != null ? `<span class="tr-delta ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${faDigits(Math.abs(Math.round(d * 100)))}٪ ${p.running && p.proj ? 'پیش‌بینی ' : ''}نسبت به ${esc(daily ? 'روز قبل' : prev.label)}</span>` : ''}
      ${avg ? `<span class="tv-cmp"><i class="dash"></i>میانگین ${fmtShort(avg)}</span>` : ''}
`;
    // On the chart itself, like TradingView's top-left legend: one row per line, + to add, × to remove.
    const ov = document.getElementById('tr-ov');
    if (ov) ov.innerHTML = `<div class="ov-row"><i style="background:${col}"></i><span>${esc(trLabel(tr.field))}</span><b>${fmtShort(p.value)}</b></div>
      ${cmps.map(c => `<div class="ov-row"><i style="background:${trColor(c.f)}"></i><span>${esc(trLabel(c.f))}</span><b>${fmtShort(c.pts[i] ? c.pts[i].value : 0)}</b><button data-act="tr-cmpx" data-v="${c.f}" aria-label="حذف">×</button></div>`).join('')}
      <div class="ov-tools"><button data-act="tr-cmp" class="${tr.picking ? 'on' : ''}">+ مقایسه</button>${cmps.length ? `<button data-act="tr-pct" class="${tr.pct ? 'on' : ''}">٪</button>` : ''}</div>`;
  };
  const focus = pts.findIndex(p => p.key === S.month), home = focus >= 0 ? focus : pts.length - 1;
  show(home);
  trChart.subscribeCrosshairMove(param => {
    const i = param && param.time ? pts.findIndex(p => p.time === (typeof param.time === 'string' ? param.time : isoDay(toDate(param.time)))) : -1;
    show(i >= 0 ? i : home);
  });
}

// Smooth path through points (Catmull-Rom converted to cubic Béziers).
function smooth(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    // Clamp control points between neighbours so the curve never overshoots.
    const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(hi, Math.max(lo, p1[1] + (p2[1] - p0[1]) / 6))];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(hi, Math.max(lo, p2[1] - (p3[1] - p1[1]) / 6))];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// ----- Assets: what you own besides Blu cash, valued at prices you enter -----
const ASSET_KINDS = {
  usd: { label: 'دلار', unit: 'دلار', price: 'usd' },
  eur: { label: 'یورو', unit: 'یورو', price: 'eur' },
  gold: { label: 'طلا', unit: 'گرم', price: 'gold' },
  coin: { label: 'سکه', unit: 'عدد', price: 'coin' },
  silver: { label: 'نقره', unit: 'گرم', price: 'silver' },
  crypto: { label: 'کریپتو', unit: 'دلار', price: 'usd' },
  box: { label: 'باکس بلو', unit: 'تومان', price: null },
  toman: { label: 'سایر (به تومان)', unit: 'تومان', price: null },
};
const PRICE_LABELS = { usd: 'هر دلار', eur: 'هر یورو', gold: 'هر گرم طلای ۱۸ عیار', coin: 'هر واحد سکه', silver: 'هر گرم نقره' };
const assetsState = () => (S.settings.assets ||= { items: [], prices: {}, pricesAt: null });

// Box grows on its own with every round-up recorded after the amount was entered.
function assetValue(it) {
  const A = assetsState(), k = ASSET_KINDS[it.kind];
  let v = k.price ? (it.qty || 0) * livePrice(k.price) : (it.qty || 0);
  if (it.kind === 'box' && it.since) v += S.tx.filter(t => isRound(t) && t.ts > it.since).reduce((a, t) => a + t.amount, 0);
  return v;
}
function assetsTotal() {
  const items = assetsState().items, owed = Math.max(0, seenzhinOwed(monthKey(new Date())));
  return { cash: balanceAt(S.tx, S.settings), held: items.reduce((a, it) => a + assetValue(it), 0) + (owed > 5e5 ? owed : 0) };
}
const missingPrice = it => ASSET_KINDS[it.kind].price && !livePrice(ASSET_KINDS[it.kind].price);

const pctS = v => v == null ? '—' : `${v >= 0 ? '▲' : '▼'} ${iso(faDigits(Math.abs(v * 100).toFixed(1).replace('.', '٫')) + '٪')}`;
const unitsTxt = (k, u) => k === 'usd' || k === 'eur' ? faDigits(Math.round(u).toLocaleString('en-US')) : faDigits((u >= 10 ? Math.round(u) : Math.round(u * 10) / 10).toString().replace('.', '٫'));

function viewAssets() {
  const A = assetsState(), { cash, held } = assetsTotal(), total = cash + held, usd = livePrice('usd');
  const owed = seenzhinOwed(monthKey(new Date()));
  const rows = [['نقد در بلو', cash, 'خودکار از ثبت‌هایت', null], ...(owed > 5e5 ? [['طلب از Seenzhin', owed, 'خودکار: پرداخت‌ها منهای بازپرداخت‌ها', null]] : []), ...A.items.map(it => [it.label || ASSET_KINDS[it.kind].label, assetValue(it),
    `${ASSET_KINDS[it.kind].unit === 'تومان' ? fmt(it.qty) : faDigits(String(it.qty).replace('.', '٫'))} ${ASSET_KINDS[it.kind].unit}${it.kind === 'box' ? ' در ابتدا، به‌علاوهٔ رندهای بعد از آن' : ''}${!ASSET_KINDS[it.kind].price ? '' : MARKET_KINDS.includes(it.kind) && S.market ? '، قیمت زنده' : missingPrice(it) ? '، قیمت وارد نشده' : '، قیمت دستی'}`, it.id])];
  const mx = Math.max(1, ...rows.map(r => r[1]));
  const manual = [...new Set(A.items.map(it => ASSET_KINDS[it.kind].price).filter(k => k && !(S.market && MARKET_KINDS.includes(k))))];
  const P = currentPlan(), H = heldByKind(), V = P.V || 1;
  const M = S.market, ST = Object.fromEntries(MARKET_KINDS.map(k => [k, mstats(M, k)]));
  // Price effect over 30 days on what you hold now (same quantities, old vs new price).
  const old30 = MARKET_KINDS.reduce((a, k) => a + (ST[k] && ST[k].m != null ? H[k] / (1 + ST[k].m) : H[k]), 0), eff = V - old30;
  const over = MARKET_KINDS.filter(k => H[k] / V - TARGET[k] > .12).sort((x, y) => H[y] / V - TARGET[y] - (H[x] / V - TARGET[x]));
  const yrs = n => { const add = P.base * n; return MARKET_KINDS.map(k => [k, ST[k] ? add * TARGET[k] / ST[k].last : 0]); };
  return `<div class="view wide">
    <div class="page-head"><h1 class="large">دارایی‌ها</h1><div class="row"><button class="chip-btn" data-act="tab" data-v="dash">بازگشت</button></div></div>
    <section class="bento an-hero"><div class="b-primary"><div class="stripes"></div>
      <div><span class="b-pill">${M ? '<span class="live-dot"></span>' : ''}همهٔ دارایی‌ات</span><h3 class="b-hero">${fmtShort(total)}</h3></div>
      <p class="b-note">${usd ? `≈ ${faDigits(Math.round(total / usd).toLocaleString('en-US'))} دلار، ` : ''}نقد ${fmtShort(cash)}، بقیه ${fmtShort(held)}${M && Math.abs(eff) > 1e6 ? `<br>اثر قیمت در ۳۰ روز: <b class="${eff >= 0 ? 'green' : 'red'}">${sgnShort(eff)}</b>` : ''}</p></div></section>

    ${M ? `<div class="section-title"><span class="live-dot"></span>نرخ بازار، ${esc(marketAge())}</div>
    <div class="mk-grid">${MARKET_KINDS.map(k => { const t = ST[k]; if (!t) return ''; const sg = msignal(t);
      return `<button class="mk ${S.mk.k === k ? 'on' : ''}" data-act="mk-pick" data-v="${k}"><span class="mk-l">${MK[k].label}<small>${MK[k].per}</small></span><b>${fmt(t.last)}</b>
        <span class="mk-ch ${t.day > 0 ? 'green' : t.day < 0 ? 'red' : ''}">امروز ${pctS(t.day)}</span><span class="mk-sub">۳۰ روز ${pctS(t.m)}، سال ${pctS(t.y)}</span>${sg.tag ? `<span class="news-k ${sg.tone || ''}">${sg.tag}</span>` : ''}</button>`; }).join('')}</div>
    <div class="tv mk-tv" id="mk-chart-box"><div class="tv-frames">${[['3m', '۳ ماه'], ['6m', '۶ ماه'], ['1y', 'یک سال']].map(([f, l]) => `<button data-act="mk-frame" data-v="${f}" class="${S.mk.f === f ? 'on' : ''}">${l}</button>`).join('')}<button data-act="mk-all" class="${S.mk.all ? 'on' : ''}">مقایسه ٪</button></div>
      <div class="tv-legend" id="mk-legend"></div><div class="tv-chart lw" id="mk-chart"></div>
      <p class="tv-hint">${S.mk.all ? '' : `محور قیمت به ${(S.market.hist[S.mk.k] || []).some(r => r[1] >= 1e7) ? 'میلیون' : 'هزار'} تومان. `}${S.mk.all ? 'هر خط از اول بازه صفر شروع می‌شود؛ عدد = (قیمت ÷ قیمت اول بازه − ۱) × ۱۰۰.' : 'خط‌چین: میانگین ۹۰ روزه. زیر آن یعنی ارزان‌تر از معمول اخیر.'} منبع: tgju.org، هر دو ساعت.</p></div>` : `<p class="foot">نرخ زنده هنوز نرسیده؛ با اینترنت خودکار می‌آید.</p>`}

    <div class="section-title">برنامهٔ سرمایه‌گذاری این ماه</div>
    <div class="ins-card plan">
      <div class="plan-top"><span>پیشنهاد این ماه</span><b>${fmtShort(P.total)}</b></div>
      <p class="why">میانگین سرمایه‌گذاری ماهانهٔ ${faDigits(P.months)} ماه اخیر ${fmtShort(P.base)} است. درآمد کاری این ماه تا امروز ${fmtShort(P.workNow)} در برابر میانگین ${fmtShort(P.avgWork)}؛ ضریب ${iso(faDigits(P.pace.toFixed(2).replace('.', '٫')))} (بین ۰٫۵ و ۱٫۵). هرچه درآمد این ماه بیشتر شود، این عدد زنده بالا می‌رود.</p>
      ${P.rows.map(r => `<div class="plan-row"><span class="pl-k">${MK[r.k].label}</span><span class="pl-u">${r.price && r.amt ? `${unitsTxt(r.k, r.units)} ${MK[r.k].unit}` : '—'}</span><b>${r.amt ? fmtShort(r.amt) : '۰'}</b>
        <div class="pl-bar"><i style="width:${Math.min(100, r.share * 100).toFixed(0)}%"></i><em style="right:${(r.target * 100).toFixed(0)}%"></em></div>
        <small class="pl-why">سهم فعلی ${faDigits(Math.round(r.share * 100))}٪، هدف ${faDigits(Math.round(r.target * 100))}٪${r.sig.note ? `؛ ${esc(r.sig.note)}` : ''}</small></div>`).join('')}
      <p class="nt-foot">تقسیم: پول این ماه به دارایی‌هایی می‌رود که از سهم هدفشان عقب‌اند (نوار = سهم فعلی، خط = هدف)؛ هرچه زیر میانگین ۹۰ روزه باشد، کمی بیشتر. سکه و نقد در این محاسبه نیستند.</p>
      ${P.lowCash ? '<p class="warn-line">نقد بلو کمتر از نصف هزینهٔ یک ماه است؛ بهتر است اول کمی نقد کنار بگذاری و بعد بخری.</p>' : ''}
      ${over.length ? `<p class="why">اگر پول نقد لازم شد، فروش از <b>${over.map(k => MK[k].label).join(' و ')}</b> منطقی‌تر است؛ سهمش ${faDigits(Math.round(H[over[0]] / V * 100))}٪ است در برابر هدف ${faDigits(Math.round(TARGET[over[0]] * 100))}٪.</p>` : ''}
    </div>

    ${M && P.base ? `<div class="section-title">مسیر ۶ ماه، یک سال و ۳ سال</div>
    <div class="ins-card plan">
      <p class="why">با همان عادت فعلی (ماهانه حدود ${fmtShort(P.base)}) و همین تقسیم، به قیمت امروز (دلار و یورو به عدد، طلا و نقره به گرم):</p>
      <div class="nt-row nt-head lt"><span></span><span>۶ ماه</span><span>یک سال</span><span>۳ سال</span></div>
      ${MARKET_KINDS.map((k, i) => `<div class="nt-row lt"><span class="nt-l">${MK[k].label}</span>${[6, 12, 36].map(n => `<b>+${unitsTxt(k, yrs(n)[i][1])}</b>`).join('')}</div>`).join('')}
      <div class="nt-row lt strong"><span class="nt-l">پول تازه</span>${[6, 12, 36].map(n => `<b>${fmtShort(P.base * n)}</b>`).join('')}</div>
      ${(() => { const c = challengeFor(monthKey(new Date())); return c && usd ? `<div class="nt-row lt strong ch-lt"><span class="nt-l">با بردن چالش</span>${[6, 12, 36].map(n => `<b>${fmtShort(c.invest * n)}</b>`).join('')}</div>
      <p class="why">با چالش، سبد سرمایه‌گذاری‌ات (دلار، یورو، طلا، نقره) از حدود ${faDigits(Math.round(V / usd).toLocaleString('en-US'))} دلار امروز، در ۶ ماه به حدود <b>${faDigits(Math.round((V + c.invest * 6) / usd).toLocaleString('en-US'))}</b>، در یک سال به <b>${faDigits(Math.round((V + c.invest * 12) / usd).toLocaleString('en-US'))}</b> و در ۳ سال به <b>${faDigits(Math.round((V + c.invest * 36) / usd).toLocaleString('en-US'))} دلار</b> می‌رسد؛ با قیمت امروز و بدون حساب کردن بالا رفتن هدف‌ها.</p>` : ''; })()}
      <p class="nt-foot">رشد قیمت حساب نشده؛ اگر ریال مثل یک سال گذشته (دلار ${pctS(ST.usd && ST.usd.y)}) ارزش از دست بدهد، ارزش تومانی این سبد چند برابر می‌شود. این برنامه قاعده‌محور است، نه پیش‌بینی بازار.</p>
    </div>` : ''}

    <div class="dash">
      <div class="span-6">
        <div class="section-title">چه چیزهایی داری</div>
        <div class="group">${rows.map(([l, v, sub, id]) => `<${id ? `button data-act="as-edit" data-v="${id}"` : 'div'} class="cell bar-row"><span class="grow">${esc(l)}<small class="avg-line">${esc(sub)}</small></span><b>${fmtShort(v)}</b>${id ? ICON.chevL : ''}<i class="bar in" style="width:${(v / mx * 100).toFixed(1)}%"></i></${id ? 'button' : 'div'}>`).join('')}</div>
        <button class="btn-plain" data-act="as-add">+ افزودن دارایی</button>
      </div>
      ${manual.length ? `<div class="span-6">
        <div class="section-title">قیمت‌های دستی (تومان)</div>
        <div class="group">${manual.map(p => `<button class="cell" data-act="as-prices"><span class="grow">${PRICE_LABELS[p]}</span><b>${A.prices[p] ? fmt(A.prices[p]) : '—'}</b>${ICON.chevL}</button>`).join('')}</div>
        <p class="foot">این‌ها نرخ زنده ندارند و همان عددی است که خودت وارد کرده‌ای.</p>
      </div>` : ''}
    </div></div>`;
}

let mkChart = null;
function bindMarketChart() {
  const wrap = document.getElementById('mk-chart');
  if (mkChart) { try { mkChart.remove(); } catch {} mkChart = null; }
  if (!wrap || !S.market) return;
  const days = { '3m': 92, '6m': 183, '1y': 366 }[S.mk.f], H = S.market.hist, k = S.mk.k, all = S.mk.all;
  const cut = arr => (arr || []).slice(-days);
  const ink = a => isGlass() ? `rgba(29,27,25,${a})` : `rgba(235,235,245,${a})`;
  const COL = { usd: '#2e7d4f', eur: '#3d5afe', gold: '#d4a017', silver: '#8a8f98' };
  // Canvas text has no bidi isolation, so the axis shows bare numbers (thousands or millions); units live in the legend.
  const big = !all && (H[k] || []).some(r => r[1] >= 1e7), div = big ? 1e6 : 1e3;
  const fmtP = all ? v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${faDigits(Math.abs(Math.round(v)))}٪` : v => faDigits(String(Math.round(v / div * 10) / 10).replace('.', '٫'));
  mkChart = createChart(wrap, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: ink(.6), fontFamily: 'Estedad, system-ui, sans-serif', fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: ink(.04) }, horzLines: { color: ink(.07) } },
    rightPriceScale: { borderColor: ink(.14), scaleMargins: { top: .2, bottom: .08 } },
    timeScale: { borderColor: ink(.14), fixLeftEdge: true, fixRightEdge: true, tickMarkFormatter: t => { const d = typeof t === 'string' ? new Date(t + 'T12:00') : t.year ? new Date(t.year, t.month - 1, t.day, 12) : new Date(t * 1000); return monthLabel(monthKey(d)).split(' ')[0]; } },
    crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: ink(.45), labelBackgroundColor: isGlass() ? '#1d1b19' : '#e9e9ee' }, horzLine: { color: ink(.45) } },
    localization: { priceFormatter: fmtP, timeFormatter: t => formatJalali(typeof t === 'string' ? new Date(t + 'T12:00') : new Date(t.year, t.month - 1, t.day, 12)) },
    handleScroll: { vertTouchDrag: false },
  });
  const legend = document.getElementById('mk-legend');
  const kinds = all ? MARKET_KINDS : [k];
  const series = kinds.map(kk => {
    const pts = cut(H[kk]), b = pts.length ? pts[0][1] : 1;
    const data = pts.map(([d, v]) => ({ time: d, value: all ? (v / b - 1) * 100 : v }));
    const se = all ? mkChart.addSeries(LineSeries, { color: COL[kk], lineWidth: 2, priceFormat: { type: 'custom', formatter: fmtP } })
      : mkChart.addSeries(AreaSeries, { lineColor: COL[kk], topColor: COL[kk] + '55', bottomColor: COL[kk] + '00', lineWidth: 2, priceFormat: { type: 'custom', formatter: fmtP }, lastPriceAnimation: LastPriceAnimationMode.Continuous });
    se.setData(data);
    if (!all) { const t = mstats(S.market, kk); if (t && t.ma90) se.createPriceLine({ price: t.ma90, color: ink(.45), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'میانگین ۹۰ روزه' }); }
    return { kk, data };
  });
  mkChart.timeScale().fitContent();
  const show = i => {
    legend.innerHTML = series.map(({ kk, data }) => { const d = data[i == null ? data.length - 1 : Math.min(i, data.length - 1)]; return d ? `<span class="tv-cmp"><i style="background:${COL[kk]}"></i>${MK[kk].label}: <b>${all ? iso(fmtP(d.value)) : fmt(d.value) + ' تومان'}</b></span>` : ''; }).join('') +
      `<span class="sec">${(() => { const d = series[0].data[i == null ? series[0].data.length - 1 : i]; return d ? formatJalali(new Date(d.time + 'T12:00')) : ''; })()}</span>`;
  };
  show(null);
  mkChart.subscribeCrosshairMove(p => { if (!p || !p.time) return show(null); const t = typeof p.time === 'string' ? p.time : `${p.time.year}-${String(p.time.month).padStart(2, '0')}-${String(p.time.day).padStart(2, '0')}`; const i = series[0].data.findIndex(d => d.time === t); show(i >= 0 ? i : null); });
}

function assetSheet(id) {
  const A = assetsState(), it = id ? A.items.find(x => x.id === id) : { id: newId(), kind: 'usd', label: '', qty: 0 };
  let kind = it.kind;
  const html = () => `<div class="sheet-nav"><button class="link" data-close>لغو</button><b>${id ? 'ویرایش دارایی' : 'دارایی جدید'}</b><button class="link strong" data-act="save">ذخیره</button></div>
    <div class="cats">${Object.entries(ASSET_KINDS).map(([k, v]) => `<button data-act="kind" data-v="${k}" class="${kind === k ? 'on' : ''}">${v.label}</button>`).join('')}</div>
    <div class="group">
      <div class="cell"><span>اسم</span><input class="bare end" id="as-label" value="${esc(it.label || '')}" placeholder="${ASSET_KINDS[kind].label}"></div>
      <div class="cell"><span>مقدار (${ASSET_KINDS[kind].unit})</span><input class="bare end" id="as-qty" inputmode="decimal" value="${it.qty ? faDigits(String(it.qty).replace('.', '٫')) : ''}" placeholder="۰"></div>
    </div>
    ${kind === 'box' ? '<p class="foot">موجودی الان باکس را بنویس. از این به بعد رندها خودشان اضافه می‌شوند.</p>' : ''}
    ${id ? '<div class="group"><button class="cell danger" data-act="del">حذف</button></div>' : ''}`;
  const qtyOf = () => Number(toAscii(document.getElementById('as-qty').value).replace(/[٫,]/g, m => m === '٫' ? '.' : '').replace(/[^\d.]/g, '')) || 0;
  const actions = {
    kind: v => { it.label = document.getElementById('as-label').value; it.qty = qtyOf(); kind = v; document.querySelector('.sheet').innerHTML = '<div class="grab"></div>' + html(); document.querySelectorAll('.sheet [data-close]').forEach(el => { el.onclick = closeSheet; }); },
    save: async () => {
      Object.assign(it, { kind, label: document.getElementById('as-label').value.trim(), qty: qtyOf() });
      if (kind === 'box') it.since = new Date().toISOString();
      if (!A.items.includes(it)) A.items.push(it);
      await saveSettings(); closeSheet(); render(); toast('ذخیره شد');
    },
    del: async () => { A.items = A.items.filter(x => x.id !== it.id); await saveSettings(); closeSheet(); render(); },
  };
  openSheet(html(), actions);
}

function pricesSheet() {
  const A = assetsState(), used = [...new Set(['usd', ...A.items.map(it => ASSET_KINDS[it.kind].price).filter(Boolean)])];
  openSheet(`<div class="sheet-nav"><button class="link" data-close>لغو</button><b>قیمت‌های امروز</b><button class="link strong" data-act="save">ذخیره</button></div>
    <p class="foot det-note">به تومان. از همان جایی که همیشه قیمت را می‌بینی.</p>
    <div class="group">${used.map(p => `<div class="cell"><span>${PRICE_LABELS[p]}</span><input class="bare end" data-p="${p}" inputmode="numeric" value="${A.prices[p] ? fmt(A.prices[p]) : ''}" placeholder="تومان"></div>`).join('')}</div>`,
    { save: async () => {
      document.querySelectorAll('.sheet [data-p]').forEach(i => { const v = parseAmount(i.value); if (v) A.prices[i.dataset.p] = v; });
      A.pricesAt = new Date().toISOString(); await saveSettings(); closeSheet(); render(); toast('قیمت‌ها به‌روز شد');
    } }, root => root.querySelectorAll('[data-p]').forEach(i => i.addEventListener('input', () => { const v = parseAmount(i.value); i.value = v ? fmt(v) : ''; })));
}

// ----- Settings -----
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { prompt('کد را کپی کنید:', text); }
}

function syncSection() {
  const s = sync.state, pending = sync.pending();
  const when = s.lastSync ? new Date(s.lastSync).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '';
  const status = { off: 'خاموش', idle: when ? `به‌روز، ${when}` : 'آماده', syncing: 'در حال همگام‌سازی…', error: 'خطا', offline: 'بدون اینترنت؛ بعداً ارسال می‌شود' }[s.status];
  const err = s.error ? `<span class="red">${esc(s.error)}</span><br>` : '';
  if (!s.key) return `<div class="section-title">همگام‌سازی آیفون، آیپد و «زندگی من»</div>
    <div class="group">
      <button class="cell" data-act="sync-new"><span class="tint">روشن کردن همگام‌سازی</span><span class="sec">نخستین دستگاه</span></button>
    </div>
    <div class="group">
      <div class="cell"><input class="bare" id="sync-code" dir="ltr" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="کدِ دستگاه دیگر"></div>
      <button class="cell" data-act="sync-paste"><span class="tint">چسباندن کد و اتصال</span></button>
    </div>
    <p class="foot">${err}روی نخستین دستگاه «روشن کردن» را بزنید؛ یک کد ساخته و کپی می‌شود. روی آیپد یا در «زندگی من» فقط «چسباندن کد» را بزنید. بدون ایمیل و رمز.</p>`;
  return `<div class="section-title">همگام‌سازی آیفون، آیپد و «زندگی من»</div>
    <div class="group">
      <div class="cell"><span>وضعیت</span><span class="sec ${s.status === 'error' ? 'red' : ''}">${status}</span></div>
      <button class="cell" data-act="sync-copy"><span class="tint">کپی کد برای دستگاه دیگر</span><span class="sec" dir="ltr">${esc(s.key.slice(0, 5))}-•••••</span></button>
      <button class="cell" data-act="sync-now"><span class="tint">همگام‌سازی اکنون</span>${pending ? `<span class="sec">${faDigits(pending)} مورد در انتظار</span>` : ''}</button>
      <button class="cell" data-act="sync-out"><span class="tint">خاموش کردن روی این دستگاه</span></button>
    </div>
    <p class="foot">${err}برای افزودن آیپد یا «زندگی من»: «کپی کد» را بزنید و آن‌جا «چسباندن کد» را. کد را مانند رمز نگه دارید؛ هر کس آن را داشته باشد به داده‌ها دسترسی دارد.</p>`;
}

function viewSettings() {
  const st = S.settings;
  const last = st.lastBackup ? formatJalali(new Date(st.lastBackup)) : 'هرگز';
  const stale = !st.lastBackup || Date.now() - new Date(st.lastBackup) > 7 * 864e5;
  const toggle = (k, label) => `<button class="cell" data-act="toggle" data-v="${k}"><span>${label}</span><i class="switch ${st[k] ? 'on' : ''}"></i></button>`;
  return `<div class="view">
    ${pageHead('تنظیمات')}
    ${syncSection()}
    <div class="section-title">پشتیبان</div>
    <div class="group">
${canEdit() ? `      <button class="cell" data-act="export"><span class="tint">ذخیرهٔ پشتیبان</span><span class="sec ${stale ? 'red' : ''}">${esc(last)}</span></button>` : ''}
      <button class="cell" data-act="pick-json"><span class="tint">وارد کردن فایل پشتیبان</span></button>
    </div>
    <p class="foot">${sync.state.key ? 'با همگام‌سازی، پشتیبان فقط برای احتیاط است؛ هفته‌ای یک بار در iCloud نگهش دار.' : 'برای آیپد: در آیفون پشتیبان بگیر، با AirDrop بفرست و در آیپد وارد کن. موارد تکراری دوباره اضافه نمی‌شوند.'}</p>

    ${canEdit() ? `    <div class="section-title">بانک</div>
    <div class="group">
      <button class="cell" data-act="pick-xlsx"><span class="tint">وارد کردن صورت‌حساب بلو</span></button>
      <div class="cell"><span>موجودی واقعی بلو</span><input class="bare end" id="bank-bal" inputmode="numeric" placeholder="مبلغ"></div>
      <button class="cell" data-act="check"><span class="tint">مقایسه با موجودی اپ</span><span class="sec" id="check-res">${fmt(balanceAt(S.tx, S.settings))}</span></button>
      ${toggle('roundUp', 'رند بلو (تا ۱۰۰ هزار تومان)')}
    </div>
    <p class="foot">${st.roundUp ? `از ${esc(formatJalali(new Date(st.roundSince)))}، با هر خرج، فرقش تا ۱۰۰ هزار تومان بعدی خودکار «پس‌انداز باکس» حساب می‌شود؛ مثل خود بلو.` : 'اگر «رند» در بلو روشن است، این را روشن کن تا موجودی اپ با بلو یکی بماند.'}</p>` : ''}

    <div class="section-title">این دستگاه</div>
    <div class="group">
      <button class="cell" data-act="device" data-v="role"><span>نقش این دستگاه</span><span class="sec">${isTablet() ? 'آیپد: فقط تحلیل و گزارش' : 'گوشی: ثبت و همه‌چیز'}</span></button>
      ${isTablet() ? `<button class="cell" data-act="device" data-v="edit"><span>ویرایش روی این دستگاه</span><i class="switch ${canEdit() ? 'on' : ''}"></i></button>` : ''}
    </div>
    <p class="foot">${isTablet() ? `روی آیپد ثبت و ویرایش خاموش است. ${sync.state.key ? 'داده‌ها، دارایی‌ها و هدف‌ها خودکار از گوشی می‌رسند.' : 'داده‌ها با «وارد کردن فایل پشتیبان» از گوشی می‌آیند؛ دارایی‌ها و هدف‌ها هم همراهش.'}` : 'اگر این دستگاه آیپد است و فقط تحلیل می‌خواهی، نقش را عوض کن.'}</p>

    <div class="section-title">نمایش</div>
    <div class="group">
      <div class="cell"><span class="grow">ظاهر</span><div class="segmented sm">${[['glass', 'شیشه‌ای'], ['dark', 'تیره']].map(([k, l]) => `<button data-act="theme" data-v="${k}" class="${(LS('theme') === 'dark' ? 'dark' : 'glass') === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      ${toggle('showHistory', 'نشان دادن ثبت‌های آزمایشی قبل از شروع')}
    </div>

    <div class="section-title">تحلیل</div>
    <div class="group"><button class="cell" data-act="pack"><span class="tint">گزارش متنی (برای خودم یا Claude)</span></button></div>

    <div class="section-title">حساب</div>
    <div class="group">
      <div class="cell"><span>شروع</span><span class="sec">${st.startDate ? formatJalali(new Date(st.startDate)) : '—'}</span></div>
      <div class="cell"><span>تعداد تراکنش‌ها</span><span class="sec">${faDigits(scoped().length)}</span></div>
      <button class="cell danger" data-act="wipe">پاک کردن همهٔ اطلاعات</button>
    </div>
    <p class="foot">${sync.state.key ? 'اطلاعات روی این دستگاه و در فضای همگام‌سازی شما ذخیره است و بدون اینترنت هم کار می‌کند.' : 'اطلاعات فقط روی همین دستگاه ذخیره می‌شود و بدون اینترنت کار می‌کند.'}</p>
    <input type="file" id="file-json" accept="application/json,.json" hidden>
    <input type="file" id="file-xlsx" accept=".xlsx,.xls" hidden>
  </div>`;
}

async function exportBackup() {
  const data = { app: 'finance-os', version: 1, exported: new Date().toISOString(), settings: S.settings, rules: S.rules, history: S.history, tx: S.tx };
  const j = toJalali(new Date());
  const name = `hesab-${j.jy}-${String(j.jm).padStart(2, '0')}-${String(j.jd).padStart(2, '0')}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  let done = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); done = true; } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  S.settings.lastBackup = new Date().toISOString();
  await saveSettings();
  render();
  toast('پشتیبان ذخیره شد');
}

async function importBackup(file) {
  return importBackupData(JSON.parse(await file.text()));
}

// Encrypted bundle of past monthly totals shipped with the app (AES-GCM, PBKDF2 key).
async function loadBundle(pw) {
  const b = await (await fetch('data/hesab.enc.json', { cache: 'no-cache' })).json();
  const bin = x => Uint8Array.from(atob(x), ch => ch.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: bin(b.salt), iterations: b.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bin(b.iv) }, key, bin(b.ct)); }
  catch { throw new Error('رمز درست نیست'); }
  return JSON.parse(new TextDecoder().decode(plain));
}

async function importBackupData(data) {
  if (data.app !== 'finance-os' || !Array.isArray(data.tx)) throw new Error('این فایل پشتیبان این اپ نیست');
  const byId = new Map(S.tx.map(t => [t.id, t]));
  const bankKeys = new Set(S.tx.filter(t => t.bank).map(t => t.bank.key));
  const add = [];
  for (const t of data.tx) {
    const cur = byId.get(t.id);
    if (cur) { if ((t.updated || '') > (cur.updated || '')) add.push(t); continue; }
    if (t.bank && bankKeys.has(t.bank.key)) continue;
    add.push(t);
  }
  if (data.settings) {
    if (isTablet() && !canEdit()) {
      // A read-only tablet mirrors the phone: balance, start, assets, goals, round-up, one-off fixes.
      const keep = { lastBackup: S.settings.lastBackup };
      S.settings = { ...data.settings, ...keep };
    } else {
      for (const k of ['openingBalance', 'openingDate', 'startDate']) if (S.settings[k] == null && data.settings[k] != null) S.settings[k] = data.settings[k];
      for (const k of ['assets', 'goals', 'roundUp', 'roundSince', 'szForgive']) if (S.settings[k] == null && data.settings[k] != null) S.settings[k] = data.settings[k];
    }
    await saveSettings();
  }
  if (data.rules) {
    S.rules.parties = { ...(data.rules.parties || {}), ...(S.rules.parties || {}) };
    const keys = new Set((S.rules.overrides || []).map(o => o.key));
    S.rules.overrides = [...(S.rules.overrides || []), ...(data.rules.overrides || []).filter(o => !keys.has(o.key))];
    await saveRules();
  }
  if (data.history && data.history.months) { S.history = data.history; await db.set('history', S.history); }
  if (add.length) {
    for (const t of add) { const i = S.tx.findIndex(x => x.id === t.id); if (i >= 0) S.tx[i] = t; else S.tx.push(t); }
    await db.putManyTx(add);
    refresh();
  }
  return add.length;
}

async function importXlsx(file) {
  if (!window.XLSX) throw new Error('لحظه‌ای صبر کن و دوباره امتحان کن');
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const st = parseStatement(rows);
  const newRows = st.rows.filter(r => r.ts >= (S.settings.startDate || ''));
  const { linked, created } = importRows(newRows, S.tx, S.rules, 'new');
  await putTx([...linked, ...created]);
  S.settings.lastBankImport = new Date().toISOString();
  await saveSettings();
  return { linked: linked.length, created: created.length, pending: created.filter(t => t.status === 'pending').length };
}

// ---------- events ----------
document.addEventListener('click', async e => {
  if (e.target.closest('#overlay')) return;
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  try {
    if (a === 'tab') { S.view = b.dataset.v; render(); window.scrollTo(0, 0); }
    else if (a === 'go-settings') { S.view = 'settings'; render(); }
    else if (a === 'start') {
      const v = parseAmount(document.getElementById('start-bal').value);
      if (!v) return toast('موجودی بلو را وارد کن');
      const dm = toAscii(document.getElementById('start-date').value).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
      if (!dm) return toast('تاریخ را مثل ۱۴۰۵/۰۸/۰۱ بنویس');
      // Today means "from this moment"; an earlier day starts at its first minute.
      const day = fromJalali(+dm[1], +dm[2], +dm[3]);
      if (day > new Date()) return toast('تاریخ شروع نمی‌تواند در آینده باشد');
      const d = (formatJalali(day) === formatJalali(new Date()) ? startDay() : day).toISOString();
      const pw = toAscii(document.getElementById('start-pw').value).toLowerCase().replace(/\s/g, '');
      if (pw) { await importBackupData(await loadBundle(pw)); await forgiveSeenzhin(); }
      Object.assign(S.settings, { startDate: d, openingBalance: v, openingDate: d });
      S.month = monthKey(new Date(Math.max(Date.now(), new Date(d))));
      await saveSettings();
      render();
    }
    else if (a === 'clear') { if (S.amount) { S.amount = ''; render(); } }
    else if (!canEdit() && ['go-entry', 'edit', 'as-add', 'as-edit', 'as-prices', 'goals', 'pick-xlsx', 'bill-pay', 'bill-more'].includes(a)) readOnlyToast();
    else if (a === 'bill-pay') { b.disabled = true; await receiveBill(b.dataset.v); }
    else if (a === 'bill-more') billOptions(b.dataset.v);
    else if (a === 'device') {
      try {
        if (b.dataset.v === 'role') localStorage.setItem('deviceRole', isTablet() ? 'phone' : 'tablet');
        else localStorage.setItem('editHere', canEdit() ? '0' : '1');
      } catch {}
      if (!canEdit() && S.view === 'entry') S.view = 'dash';
      render();
    }
    else if (a === 'go-entry') { S.view = 'entry'; S.step = 'amount'; render(); window.scrollTo(0, 0); }
    else if (a === 'next') goWhat(b.dataset.dir);
    else if (a === 'back') { S.step = 'amount'; render(); }
    else if (a === 'flip-dir') { S.dir = guess(S.what, S.dir).dir === 'in' ? 'out' : 'in'; render(); }
    else if (a === 'save-what') await saveWhat();
    else if (a === 'pick-what') { const m = S.tpl.find(t => t.key === b.dataset.key); if (m) await saveWhat(m); }
    else if (a === 'day') { S.dayBack = (S.dayBack + 1) % 7; render(); }
    else if (a === 'use') await useTemplate(b.dataset.key, Number(S.amount), entryDate());
    else if (a === 'manual') openTxSheet({ dir: b.dataset.dir, amount: Number(S.amount || 0) });
    else if (a === 'edit') { const t = S.tx.find(x => x.id === b.dataset.id); if (t) openTxSheet({ ...t }); }
    else if (a === 'lf') { S.listFilter = b.dataset.v; S.listLimit = 60; render(); }
    else if (a === 'more') { S.listLimit += 100; document.getElementById('list-body').innerHTML = listBody(); }
    else if (a === 'an-month') monthCompareSheet(b.dataset.v);
    else if (a === 'an-tab') { S.anTab = b.dataset.v; render(); }
    else if (a === 'an-open') { S.month = b.dataset.v; S.view = 'dash'; render(); window.scrollTo(0, 0); }
    else if (a === 'an-load') {
      const pw = toAscii(document.getElementById('an-pw').value).toLowerCase().replace(/\s/g, '');
      if (!pw) return toast('رمز را بنویس');
      await importBackupData(await loadBundle(pw));
      await forgiveSeenzhin();
      toast('تاریخچه بارگذاری شد'); render();
    }
    else if (a === 'mon') { S.month = shiftMonth(S.month, +b.dataset.v); S.tr.hover = null; render(); }
    else if (a === 'tr-pick') openSheet(`<div class="sheet-nav"><span></span><b>نمودارِ چه چیزی؟</b><button class="link" data-close>بستن</button></div>
      <div class="group">${TR_FIELDS.map(([k, l]) => `<button class="cell" data-act="pick" data-v="${k}"><i class="dot" style="background:${trColor(k)}"></i><span class="grow">${l}</span>${S.tr.field === k ? ICON.ok : ''}</button>`).join('')}</div>`,
      { pick: v => { closeSheet(); Object.assign(S.tr, { field: v, hover: null, cmps: S.tr.cmps.filter(x => x !== v) }); redrawTrend(); } });
    else if (a === 'month-pick') openMonthPicker();
    else if (a === 'story-more' && S.storyArgs) {
      const { key: k, args } = S.storyArgs;
      openSheet(`<div class="sheet-nav"><span></span><b>${esc(monthLabel(k))}</b><button class="link" data-close>بستن</button></div>${storyFull(k, { ...args, hero: false })}`,
        { detail: (v, el) => { closeSheet(); openDetail(el.dataset.k, v); } });
    }
    else if (a === 'goals') goalsSheet();
    else if (a === 'go-assets') { S.view = 'assets'; render(); window.scrollTo(0, 0); }
    else if (a === 'as-add') assetSheet(null);
    else if (a === 'as-edit') assetSheet(b.dataset.v);
    else if (a === 'as-prices') pricesSheet();
    else if (a === 'detail') openDetail(b.dataset.k, b.dataset.v);
    else if (a === 'kpi') kpiSheet(b.dataset.v);
    else if (a === 'kpi-all') openSheet(`<div class="sheet-nav"><span></span><b>شاخص‌ها</b><button class="link" data-close>بستن</button></div>${kpiList(kpis(monthsSeries(S.history, scoped(), S.settings.startDate), balanceAt(S.tx, S.settings), assetsTotal().held))}`, { kpi: v => { closeSheet(); kpiSheet(v); } });
    else if (a === 'tr-field') { Object.assign(S.tr, { field: b.dataset.v, hover: null, cmps: S.tr.cmps.filter(x => x !== b.dataset.v) }); redrawTrend(); }
    else if (a === 'tr-frame') { Object.assign(S.tr, { frame: b.dataset.v, hover: null }); redrawTrend(); }
    else if (a === 'tr-cmp') { S.tr.picking = !S.tr.picking; redrawTrend(); }
    else if (a === 'tr-cmpf') { const v = b.dataset.v, c = S.tr.cmps; S.tr.cmps = c.includes(v) ? c.filter(x => x !== v) : [...c, v].slice(-3); S.tr.picking = false; redrawTrend(); }
    else if (a === 'tr-cmpx') { S.tr.cmps = S.tr.cmps.filter(x => x !== b.dataset.v); if (!S.tr.cmps.length) S.tr.pct = false; redrawTrend(); }
    else if (a === 'challenge') challengeSheet();
    else if (a === 'mk-pick') { S.mk.k = b.dataset.v; S.mk.all = false; render(); }
    else if (a === 'mk-frame') { S.mk.f = b.dataset.v; bindMarketChart(); document.querySelectorAll('[data-act="mk-frame"]').forEach(x => x.classList.toggle('on', x === b)); }
    else if (a === 'mk-all') { S.mk.all = !S.mk.all; render(); }
    else if (a === 'theme') { try { localStorage.setItem('theme', b.dataset.v); } catch {} document.documentElement.classList.toggle('glass', b.dataset.v !== 'dark'); render(); }
    else if (a === 'tr-pct') { S.tr.pct = !S.tr.pct; redrawTrend(); }
    else if (a === 'toggle') {
      const k = b.dataset.v;
      S.settings[k] = !S.settings[k];
      if (k === 'roundUp' && S.settings.roundUp) S.settings.roundSince = new Date().toISOString();
      await saveSettings(); render();
    }
    else if (a === 'pack' || a === 'report') {
      const text = analysisReport();
      if (navigator.share) { try { await navigator.share({ text }); return; } catch (err) { if (err.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(text); toast('کپی شد'); }
      catch { openSheet(`<div class="sheet-nav"><span></span><b>گزارش</b><button class="link" data-close>بستن</button></div><textarea class="field" rows="14" readonly>${esc(text)}</textarea>`); }
    }
    else if (a === 'export') await exportBackup();
    else if (a === 'sync-new') {
      b.disabled = true;
      try { const code = await sync.create(); await copyText(code); toast('همگام‌سازی روشن شد و کد کپی شد'); }
      catch (err) { sync.state.error = err.message; } finally { b.disabled = false; render(); }
    }
    else if (a === 'sync-paste') {
      const box = document.getElementById('sync-code');
      // An empty box reads the clipboard (iOS shows its «Paste» bubble); a typed code is used as is.
      if (!box.value.trim()) { try { box.value = await navigator.clipboard.readText(); } catch { return toast('کد را در کادر بچسبانید و دوباره بزنید'); } }
      b.disabled = true;
      try { await sync.join(box.value); toast('به همگام‌سازی وصل شد'); }
      catch (err) { sync.state.error = err.message; } finally { b.disabled = false; render(); }
    }
    else if (a === 'sync-copy') { await copyText(sync.state.key); toast('کد کپی شد'); }
    else if (a === 'sync-now') { await sync.run(); render(); }
    else if (a === 'sync-out') { if (!confirm('همگام‌سازی روی این دستگاه خاموش شود؟ داده‌های این دستگاه می‌مانند.')) return; await sync.signOut(); render(); }
    else if (a === 'pick-json') document.getElementById('file-json').click();
    else if (a === 'pick-xlsx') document.getElementById('file-xlsx').click();
    else if (a === 'check') {
      const v = parseAmount(document.getElementById('bank-bal').value);
      if (!v) return toast('موجودی واقعی بلو را وارد کن');
      const diff = balanceAt(S.tx, S.settings) - v;
      document.getElementById('check-res').textContent = Math.abs(diff) < 1000 ? 'یکی است' : `${fmt(Math.abs(diff))} ${diff > 0 ? 'کمتر در بانک' : 'بیشتر در بانک'}`;
    }
    else if (a === 'wipe') {
      if (!confirm('همهٔ اطلاعات از این دستگاه پاک شود؟ نسخهٔ روی سرور و دستگاه‌های دیگر دست نمی‌خورد.')) return;
      // Leave sync first so the wipe stays on this device.
      await sync.signOut();
      await db.clearTx();
      await db.set('settings', {}); await db.set('rules', { parties: {}, overrides: [] }); await db.set('history', null);
      Object.assign(S, { tx: [], settings: {}, rules: { parties: {}, overrides: [] }, history: null });
      refresh();
      render();
    }
  } catch (err) {
    toast(err.message || String(err));
  }
});

document.addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    if (e.target.id === 'file-json') {
      const n = await importBackup(f);
      render();
      toast(n ? `${faDigits(n)} مورد وارد شد` : S.history ? 'خلاصهٔ ماه‌های قبل وارد شد' : 'چیز جدیدی نبود');
    } else if (e.target.id === 'file-xlsx') {
      const r = await importXlsx(f);
      if (r.pending) { S.view = 'list'; S.listFilter = 'pending'; }
      render();
      toast(r.created || r.linked ? `${faDigits(r.linked + r.created)} ردیف بانک بررسی شد` : 'مورد جدیدی نبود');
    }
  } catch (err) {
    toast(err.message || String(err));
  }
  e.target.value = '';
});

boot();
