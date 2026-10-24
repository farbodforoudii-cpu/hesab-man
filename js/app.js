import { db, requestPersistence } from './db.js';
import { TYPES, MAIN_TYPES, typesFor, CATEGORIES, PICKABLE_CATS, inferFromText, newId } from './model.js';
import { buildTemplates, suggest, complete, bestTemplateForText } from './suggest.js';
import { parseStatement, importRows, learnRule, classify } from './bank.js';
import { monthSummary, balanceAt, bankCheck, balances } from './stats.js';
import { toJalali, fromJalali, monthKey, monthLabel, shiftMonth, monthRange, monthLength, formatJalali, dayLabel, faDigits } from './jalali.js';
import { fmt, fmtShort, tomanWords, esc, norm } from './format.js';
import { monthsSeries, analyze, compare } from './analysis.js';

const S = {
  tx: [], settings: {}, rules: { parties: {}, overrides: [] }, history: null, tpl: [],
  view: 'entry', amount: '', dayBack: 0, step: 'amount', dir: 'out', what: '',
  month: monthKey(new Date()), listFilter: 'all', listQuery: '', listLimit: 60, tr: { field: 'expense', cmp: null, frame: 'all', hover: null, a: null, b: null, measure: false, picking: false },
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
  refresh();
  S.view = window.innerWidth >= 820 && S.settings.startDate ? 'dash' : 'entry';
  S.step = 'amount';
  render();
  requestPersistence();
  setupUpdates();
}

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

function refresh() { S.tpl = buildTemplates(S.tx.filter(t => !isRound(t))); }

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
  return c ? ` · رند ${esc(fmtShort(c.amount))}` : '';
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
    if (!to) return;
    const show = v => { el.textContent = f === 'int' ? faDigits(Math.round(v)) : f === 'full' ? fmt(v) : fmtShort(v); if (el.matches(NICE)) niceNum(el); };
    const t0 = performance.now(), dur = 700;
    const step = now => { const k = Math.min(1, (now - t0) / dur); show(to * easeOut(k)); if (k < 1) requestAnimationFrame(step); };
    show(0); requestAnimationFrame(step);
  });
  root.querySelectorAll('[data-odo]').forEach(el => {
    const text = fmt(Number(el.dataset.odo));
    const digits = '۰۱۲۳۴۵۶۷۸۹';
    const cut = text.lastIndexOf(',');
    el.innerHTML = [...text].map((ch, i) => digits.includes(ch)
      ? `<span class="odo${cut >= 0 && i > cut ? ' dim' : ''}"><span class="odo-strip" data-d="${digits.indexOf(ch)}">${[...digits].map(d => `<span>${d}</span>`).join('')}</span></span>`
      : `<span${cut >= 0 && i >= cut ? ' class="dim"' : ''}>${ch}</span>`).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.querySelectorAll('.odo-strip').forEach((st, i) => {
        st.style.transitionDelay = `${i * 45}ms`;
        st.style.transform = `translateY(${-st.dataset.d * 10}%)`;
      });
    }));
  });
}

// ---------- render ----------
const isWide = () => window.innerWidth >= 820;

function render() {
  const n = pendingList().length;
  const entry = S.view === 'entry' || !S.settings.startDate;
  document.body.classList.toggle('no-tabs', entry);
  const tabs = [['dash', 'chart', 'خلاصه'], ['an', 'spark', 'تحلیل'], ['list', 'list', 'تراکنش‌ها'], ['settings', 'gear', 'تنظیمات']];
  $tabs.innerHTML = entry ? '' : `<div class="inner">${tabs.map(([v, ic, l]) =>
    `<button data-act="tab" data-v="${v}" class="${S.view === v ? 'on' : ''}">${ICON[ic]}<span>${l}</span>${v === 'list' && n ? `<i class="badge">${faDigits(n)}</i>` : ''}</button>`).join('')}</div>`;
  const views = { entry: viewEntry, list: viewList, dash: viewDash, an: viewAnalysis, settings: viewSettings };
  const fresh = S.view !== S.shownView || S.month !== S.shownMonth;
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
  if (S.view === 'entry' && S.step === 'what') bindWhat();
  if (S.view === 'entry' && S.step === 'amount') bindAmount();
}

// Page header with a quick way back to entry (entry itself is not a tab).
function pageHead(title, extra = '') {
  return `<div class="page-head"><h1 class="large">${title}</h1><div class="row">${extra}<button class="add-pill" data-act="go-entry">${ICON.add}<span>ثبت</span></button></div></div>`;
}

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
      <button class="btn-plain" data-act="go-settings">وارد کردن فایل</button>
    </div>`;
  }
  const amt = Number(S.amount || 0);
  const top = `<div class="entry-top">
      <button class="today${S.dayBack ? ' back' : ''}" data-act="day">${S.dayBack ? ICON.back : ''}<span>${esc(dayLabel(entryDate()).replace('امروز · ', ''))}</span></button>
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
      <span class="b-pill">چقدر؟</span>
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
    <span>${g.dir === 'in' ? 'دریافت' : 'پرداخت'} · ${esc(what)}</span>
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
  S.dir = dir; S.step = 'what'; S.what = '';
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
  S.step = 'amount'; S.what = ''; S.amount = '';
  S.lastId = tx.id;
  render();
  flashSaved();
  await putTx(tx);
  toast(`ثبت شد · ${tx.desc}`, async () => { await delTx(tx.id); });
}

// A short tick over the amount card so it is obvious the entry was saved (keyboard stays open).
function flashSaved() {
  const hero = document.querySelector('.hero-amt');
  if (!hero) return;
  const b = document.createElement('div');
  b.className = 'saved-badge';
  b.innerHTML = '<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" pathLength="1"/><path d="M15 27l7 7 15-16" pathLength="1"/></svg><span>ثبت شد</span>';
  hero.appendChild(b);
  setTimeout(() => b.remove(), 1300);
}

async function commitNew(tx) {
  await putTx(tx);
  S.amount = '';
  S.dayBack = 0;
  render();
  toast(`ثبت شد · ${tx.desc}`, async () => { await delTx(tx.id); });
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
    touched: !!init.id, bank: init.bank || null, more: false,
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
    </div>
    ${edit ? '<div class="group"><button class="cell danger" data-f="delete">حذف تراکنش</button></div>' : ''}`;
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

// ----- List -----
function viewList() {
  const n = pendingList().length;
  const pend = S.listFilter === 'pending';
  return `<div class="view">
    ${pageHead('تراکنش‌ها')}
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
    <div class="group">${g.items.map(itemHtml).join('')}</div>`).join('')
    + (items.length > shown.length ? `<button class="btn-plain" data-act="more">بیشتر</button>` : '');
}

function itemHtml(t, withDay = false) {
  const d = new Date(t.ts);
  const time = (withDay ? dayLabel(d).replace(/^(امروز|دیروز) · /, '$1 ') + ' · ' : '') + faDigits(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
  return `<button class="cell tx ${t.id === S.lastId ? 'new' : ''}" data-act="edit" data-id="${t.id}">
    <i class="dot" style="background:${dotColor(t)}"></i>
    <span class="tx-main"><span class="t1">${esc(t.desc)}</span><span class="t2">${t.status === 'pending' ? '<b class="warn">نیاز به بررسی</b>' : esc(subtitle(t))} · ${time}${roundNote(t)}</span></span>
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
  const h = S.history.months[key];
  const ins = h.ins || [['درآمد کاری', h.work], ['از خانواده', h.family], ['فروش مکمل', h.sale], ['نامشخص', h.otherIn]].filter(x => x[1]);
  const outs = h.outs || [['دارایی', h.asset], ['قسط وام', h.loanPay], ['پرداخت برای دیگران', h.onBehalf]].filter(x => x[1]);
  const days = h.days || Object.entries(h.byCat).map(([c, v]) => [(CATEGORIES[c] || CATEGORIES.other).label, v]);
  return `<div class="view wide">
    ${pageHead('خلاصه', monthNav(key))}
    <p class="hist-note">قبل از شروع · ${S.history.source === 'numbers' ? 'از جدول Numbers · ' : ''}بدون نام</p>
    ${histUnlock()}
    ${storyHtml(key, { ins, outs, days, h, bank: h.bank })}
    <div class="dash">
      <div class="span-6" id="trend">${trendCard()}</div>
    </div></div>`;
}

const monthNav = key => `<div class="month"><button data-act="mon" data-v="-1">${ICON.chevR}</button><button class="month-btn" data-act="month-pick">${monthLabel(key)}<span>▾</span></button><button data-act="mon" data-v="1">${ICON.chevL}</button></div>`;

// Every month from the first history month to now, newest first, with what was left that month.
function openMonthPicker() {
  const series = monthsSeries(S.history, scoped(), S.settings.startDate).slice().reverse();
  openSheet(`<div class="sheet-nav"><span></span><b>کدام ماه؟</b><button class="link" data-close>بستن</button></div>
    <div class="group">${series.map(m => `<button class="cell" data-act="pick" data-v="${m.key}"><span class="grow">${monthLabel(m.key)}${m.running ? ' <small>· در جریان</small>' : ''}</span><small>خرج ${fmtShort(m.expense || 0)}</small>${m.key === S.month ? ICON.ok : ''}</button>`).join('')}</div>`,
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
function storyHtml(key, { ins, outs, days, h, bank, hero = true, live = false }) {
  const sum = arr => arr.reduce((a, x) => a + x[1], 0);
  const inT = sum(ins), outT = sum(outs) + sum(days || []), net = inT - outT;
  const name = monthLabel(key).split(' ')[0];
  // Money that only passed through (paid for others / Seenzhin, then paid back) and savings are told apart from spending.
  const passRe = /Seenzhin|برای دیگران/, assetRe = /دلار|نقره|طلا|دوچرخه|سکه|پس‌انداز|باکس|رند/;
  const pass = outs.filter(x => passRe.test(x[0])), assets = outs.filter(x => assetRe.test(x[0]));
  const back = ins.filter(x => /پس گرفتن/.test(x[0]));
  const big = [...outs.filter(x => !passRe.test(x[0]) && !assetRe.test(x[0])), ...(days || [])].sort((a, b) => b[1] - a[1]);
  const lines = [];
  if (!h.work) lines.push('این ماه درآمد کاری نداشتی.');
  else lines.push(`درآمد کاری‌ات ${fmtShort(h.work)} بود و خرج زندگی‌ات ${fmtShort(h.expense)}؛ ${h.work >= h.expense ? 'درآمد کاری خرج را پوشاند' : `درآمد کاری ${faDigits(Math.round(h.work / h.expense * 100))}٪ خرج را پوشاند`}.`);
  if (h.family) lines.push(`${fmtShort(h.family)} از خانواده گرفتی${h.work ? '' : '؛ خرج‌ها با همین و موجودی حساب گذشت'}.`);
  if (big.length) lines.push(`بزرگ‌ترین خرج‌ها: ${big.slice(0, 3).map(x => `${x[0]} (${fmtShort(x[1])})`).join('، ')}.`);
  if (assets.length) lines.push(`${fmtShort(sum(assets))} خرج نشد، دارایی شد: ${assets.map(x => x[0]).join('، ')}.`);
  if (pass.length) lines.push(`${fmtShort(sum(pass))} برای دیگران و Seenzhin پرداختی${back.length ? ` و ${fmtShort(sum(back))} پس گرفتی` : ''}؛ این‌ها خرج خودت نیستند.`);
  lines.push(net < 0 ? `در کل ${fmtShort(-net)} بیشتر از پولی که آمد، رفت.` : `در کل ${fmtShort(net)} بیشتر از پولی که رفت، آمد.`);
  if (bank) {
    lines.push(`موجودی بلو از ${fmtShort(bank[0])} به ${fmtShort(bank[1])} رسید.`);
    const gap = (bank[1] - bank[0]) - net;
    if (Math.abs(gap) >= 1e6) lines.push(gap < 0 ? `در بانک ${fmtShort(-gap)} بیشتر از جدولت کم شده؛ احتمالاً چند خرج ثبت نشده.` : `بانک ${fmtShort(gap)} از جدولت بهتر است؛ شاید ورودی‌ای جا افتاده یا خرجی در ماه دیگر ثبت شده.`);
  }
  const kindOf = { in: 'in', out: 'out', day: 'day' };
  const bars = (arr, cls) => { const mx = Math.max(1, ...arr.map(x => x[1])); return arr.map(([l, v]) => `<button class="cell bar-row" data-act="detail" data-k="${live ? kindOf[cls] : 'hist'}" data-v="${esc(l)}"><span class="grow">${esc(l)}</span><b>${fmtShort(v)}</b>${ICON.chevL}<i class="bar ${cls}" style="width:${(v / mx * 100).toFixed(1)}%"></i></button>`).join(''); };
  return `${hero ? `<section class="bento an-hero">
      <div class="b-primary tap" data-act="detail" data-k="net"><div class="stripes"></div>
        <div><span class="b-pill">${esc(name)} در یک نگاه</span><h3 class="b-hero">${net < 0 ? '−' : '+'}${fmtShort(Math.abs(net))}</h3></div>
        <p class="b-note story-io"><span class="green">${fmtShort(inT)} آمد</span> · <span class="red">${fmtShort(outT)} رفت</span></p></div>
    </section>` : ''}
    <div class="dash">
      <div class="span-6">
        <div class="section-title">چه اتفاقی افتاد</div>
        <div class="group story">${lines.map(l => `<div class="cell"><span>${esc(l)}</span></div>`).join('')}</div>
        <div class="section-title">از کجا آمد · ${fmtShort(inT)}</div>
        <div class="group">${ins.length ? bars(ins, 'in') : '<div class="cell"><span class="sec">پولی نیامد</span></div>'}</div>
      </div>
      <div class="span-6">
        ${outs.length ? `<div class="section-title">پرداخت‌های بزرگ · ${fmtShort(sum(outs))}</div><div class="group">${bars(outs, 'out')}</div>` : ''}
        ${days && days.length ? `<div class="section-title">${h.days ? 'خرج‌های روزانه' : 'خرج‌ها'} · ${fmtShort(sum(days))}</div><div class="group">${bars(days.slice().sort((a, b) => b[1] - a[1]), 'day')}</div>` : ''}
      </div>
    </div>`;
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
  const { start, end } = monthRange(key);
  return T.filter(t => { const d = new Date(t.ts); return d >= start && d < end; });
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
    <p class="foot">روی هر ردیف بزنی، ویرایش باز می‌شود.</p>`,
    { edit: (v, b) => { const t = S.tx.find(x => x.id === b.dataset.id); if (t) { closeSheet(); openTxSheet({ ...t }); } } });
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
    return infoSheet('درآمد کاری در برابر خرج', [['درآمد کاری', fmt(s.work), 'green'], ['خرج زندگی', fmt(s.expense), 'red'], ['نسبت', s.expense ? faDigits(Math.round(s.work / s.expense * 100)) + '٪' : '—']],
      'یعنی درآمد کاری این ماه چند درصدِ خرج زندگی را پوشش داده. بالای ۱۰۰٪ یعنی از کار خودت چیزی هم مانده. اول ماه این عدد بالاست چون هنوز خرج زیادی ثبت نشده.');
  }
  if (kind === 'bal') {
    const st = S.settings, all = S.tx.filter(t => t.ts >= (st.openingDate || ''));
    const inn = all.filter(t => t.dir === 'in').reduce((a, t) => a + t.amount, 0), out = all.filter(t => t.dir === 'out' && !isRound(t)).reduce((a, t) => a + t.amount, 0);
    const rnd = all.filter(isRound).reduce((a, t) => a + t.amount, 0);
    return infoSheet('موجودی بلو از کجا آمده', [
      [`موجودی شروع (${formatJalali(new Date(st.openingDate))})`, fmt(st.openingBalance || 0)],
      ['+ همهٔ پول‌هایی که آمد', fmt(inn), 'green'], ['− همهٔ پول‌هایی که رفت', fmt(out), 'red'],
      ...(rnd ? [['− رند بلو (رفت به باکس)', fmt(rnd), 'red']] : []), ['= موجودی الان', fmt(balanceAt(S.tx, st))]],
      'برای دیدن تک‌تک تراکنش‌ها، به «تراکنش‌ها» برو.');
  }
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
    return txSheet(`${trLabel(tr.field)} · ${p.full}`, 'جمع', list.filter(t => !isRound(t)));
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
    return infoSheet(`${mName} در یک نگاه`, [['پولی که آمد', fmt(inT), 'green'], ['پولی که رفت', fmt(outT), 'red'], ['نتیجه', (inT - outT < 0 ? '−' : '+') + fmt(Math.abs(inT - outT))],
      ...(h.bank ? [['موجودی بلو اول ماه', fmt(h.bank[0])], ['موجودی بلو آخر ماه', fmt(h.bank[1])]] : [])],
      '«آمد» و «رفت» همان جمع‌های جدول Numbers توست (بدون Opening). موجودی بلو از صورت‌حساب بانک است.');
  }
}

// ----- Analysis: the long view from the first month on -----
// Bump when the encrypted history bundle is rebuilt so devices offer to reload it.
const HIST_REV = 4;
function viewAnalysis() {
  const head = pageHead('تحلیل');
  const unlock = histUnlock();
  const series = monthsSeries(S.history, scoped(), S.settings.startDate);
  const A = analyze(series);
  if (!A) return `<div class="view wide">${head}${unlock}<p class="empty">هنوز ماه کاملی برای تحلیل نیست.</p></div>`;
  const key = series.some(m => m.key === S.anKey) ? S.anKey : A.last;
  const max = Math.max(...series.map(m => Math.max(m.work || 0, m.expense || 0)), 1);
  const card = m => {
    const tag = m.running ? 'در جریان' : m.asset > 0 ? `پس‌انداز ${fmtShort(m.asset)}` : m.expense > A.avgExp * 1.25 ? 'پرخرج' : m.self >= 0 ? 'از کار خودت ماند' : 'کم آوردی';
    return `<button class="tl-card${m.key === key ? ' on' : ''}" data-act="an-month" data-v="${m.key}">
      <span class="tl-go">${ICON.arrow}</span>
      <span class="tl-name">${esc(monthName(m.key))}</span>
      <span class="tl-self ${m.self >= 0 ? 'green' : 'red'}">${m.self >= 0 ? '+' : '−'}${fmtShort(Math.abs(m.self))}</span>
      <span class="tl-bar"><i style="width:${(m.work / max * 100).toFixed(0)}%;background:#34c759"></i></span>
      <span class="tl-bar"><i style="width:${(m.expense / max * 100).toFixed(0)}%;background:var(--tint)"></i></span>
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
    <section class="bento an-hero">
      <div class="b-primary"><div class="stripes"></div>
        <div><span class="b-pill">${esc(monthName(A.first))} تا ${esc(monthName(A.last))} · ${faDigits(A.n)} ماه</span>
          <h3 class="b-hero" data-cu="${Math.round(A.cov * 100)}" data-f="int">${faDigits(Math.round(A.cov * 100))}٪</h3></div>
        <p class="b-note" style="max-width:420px">${esc(A.verdict)}</p></div>
    </section>
    <div class="mini-bento an-tiles">
      <div class="mb-tile tap" data-act="detail" data-k="series" data-v="work"><p class="b-label"><span class="st g">${ICON.ok}</span>درآمد کاری در ماه</p><p class="mb-num">${fmtShort(A.avgWork)}</p></div>
      <div class="mb-tile tap" data-act="detail" data-k="series" data-v="expense"><p class="b-label"><span class="st ${A.cov < 1 ? 'r' : 'g'}">${A.cov < 1 ? '' : ICON.ok}</span>خرج در ماه</p><p class="mb-num">${fmtShort(A.avgExp)}</p></div>
      <div class="mb-tile muted tap" data-act="detail" data-k="series" data-v="family"><p class="b-label"><span class="st o"></span>سهم خانواده از پول ورودی</p><p class="mb-num">${faDigits(Math.round(A.famShare * 100))}٪</p></div>
      ${A.top ? `<div class="mb-tile muted tap" data-act="detail" data-k="series" data-v="${A.top.c}"><p class="b-label"><span class="st" style="background:${CATEGORIES[A.top.c].color}"></span>بزرگ‌ترین خرج</p><p class="mb-num">${esc(CATEGORIES[A.top.c].label)}</p><p class="b-sub">${faDigits(Math.round(A.top.share * 100))}٪ کل خرج</p></div>` : ''}
    </div>
    <div class="section-title">ماه به ماه</div>
    <div class="tl">${series.map(card).join('')}</div>
    <p class="foot legend-foot"><span><i style="background:#34c759"></i>درآمد کاری</span><span><i style="background:var(--tint)"></i>خرج</span><span>عدد بالا: باقی‌مانده بدون کمک خانواده (درآمد کاری و فروش منهای خرج)</span></p>
    <div class="dash">
      <div class="span-6">
        ${A.critiques.length ? `<div class="section-title">انتقاد</div><div class="group">${list(A.critiques, 'bad')}</div>` : ''}
        ${A.tips.length ? `<div class="section-title">پیشنهاد</div><div class="group">${list(A.tips, 'tip')}</div>` : ''}
        ${A.good.length ? `<div class="section-title">خوب‌ها</div><div class="group">${list(A.good, 'ok')}</div>` : ''}
      </div>
      <div class="span-6">
        ${C ? `<div class="section-title">${esc(monthLabel(key))} در برابر میانگین بقیهٔ ماه‌ها</div>
        <div class="group">
          <div class="cell"><span class="grow">درآمد کاری<small class="avg-line">میانگین ${fmtShort(C.work.a)}</small></span>${arrow(C.work.v - C.work.a, C.work.a, true)}<b>${fmtShort(C.work.v)}</b></div>
          <div class="cell"><span class="grow">کل خرج<small class="avg-line">میانگین ${fmtShort(C.expense.a)}</small></span>${arrow(C.expense.v - C.expense.a, C.expense.a)}<b>${fmtShort(C.expense.v)}</b></div>
        </div>
        <div class="group" style="margin-top:10px">${C.rows.map(r => `<div class="cell"><i class="dot" style="background:${CATEGORIES[r.c].color}"></i><span class="grow">${CATEGORIES[r.c].label}<small class="avg-line">میانگین ${fmtShort(r.a)}</small></span>${arrow(r.d, r.a)}<b>${fmtShort(r.v)}</b></div>`).join('')}</div>` : ''}
        ${dayStrip(sel)}
        <button class="btn-plain" data-act="an-open" data-v="${key}">جزئیات ${esc(monthLabel(key))}</button>
      </div>
    </div>
    <button class="btn-primary an-share" data-act="report">${ICON.share}<span>گزارش متنی (برای خودم یا Claude)</span></button>
    ${flagNote.length ? `<p class="foot an-flags">دقت داده: ${flagNote.map(esc).join(' · ')}.</p>` : ''}
  </div>`;
}

const monthName = k => monthLabel(k).split(' ')[0];

// Plain-text report anyone can read: summary, month by month, critique, suggestions.
function analysisReport() {
  const series = monthsSeries(S.history, scoped(), S.settings.startDate);
  const A = analyze(series);
  if (!A) return 'هنوز داده‌ای برای گزارش نیست.';
  const m = v => fmtShort(v || 0);
  const L = [`گزارش مالی — ${monthLabel(A.first)} تا ${monthLabel(A.last)} (${faDigits(A.n)} ماه، تومان)`, ''];
  L.push('خلاصه', `• ${A.verdict}`, `• میانگین ماهانه: درآمد کاری ${m(A.avgWork)} · خرج ${m(A.avgExp)}`,
    `• کمک خانواده در کل دوره: ${m(A.family)} (${faDigits(Math.round(A.famShare * 100))}٪ پول ورودی)`, `• دارایی خریده‌شده (دلار، نقره، دوچرخه): ${m(A.asset)}`, '');
  L.push('ماه به ماه (درآمد کاری / خرج / باقی‌مانده بدون کمک خانواده، با سود فروش مکمل)');
  for (const x of series) L.push(`• ${monthLabel(x.key)}${x.running ? ' (در جریان)' : ''}: ${m(x.work)} / ${m(x.expense)} / ${x.self >= 0 ? '+' : '−'}${m(Math.abs(x.self))}`);
  const top = Object.entries(A.cats).sort((a, b) => b[1] - a[1]).slice(0, 5);
  L.push('', 'بیشترین خرج‌ها در کل دوره');
  for (const [c, v] of top) L.push(`• ${(CATEGORIES[c] || CATEGORIES.other).label}: ${m(v)} (${faDigits(Math.round(v / A.expense * 100))}٪)`);
  const sec = (t, list) => list.length && L.push('', t, ...list.map(x => `• ${x.t}: ${x.d}`));
  sec('انتقاد', A.critiques); sec('پیشنهاد', A.tips); sec('خوب‌ها', A.good);
  const f = A.flags, notes = [f.unknown && `${m(f.unknown)} ورودی نامشخص جزو درآمد نیست`, f.assumed && `${m(f.assumed)} با حدس درآمد کاری حساب شده`, f.vague && `${m(f.vague)} خرج با عنوان نامعلوم شخصی حساب شده`].filter(Boolean);
  if (notes.length) L.push('', 'دقت داده: ' + notes.join(' · '));
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
  const b = balances(T);
  const cov = s.expense ? Math.round(s.work / s.expense * 100) : null;
  const held = [
    ...(b.seenzhin > 0 ? [['طلب از Seenzhin', b.seenzhin]] : []),
    ...(b.fund ? [['صندوق مریم', b.fund]] : []),
    ...(b.loan ? [['بدهی وام', b.loan]] : []),
    ...Object.entries(b.assets),
  ];
  return `<div class="view wide">
    ${pageHead('خلاصه', monthNav(key))}

    <section class="bento">
      <div class="b-primary tap" data-act="detail" data-k="bal">
        <div class="stripes"></div>
        <div><span class="b-pill"><span class="live-dot"></span>موجودی بلو</span><h3 class="b-hero" data-odo="${Math.round(bal)}">${fmt(bal)}</h3></div>
        <p class="b-note ticker" data-ticker>${liveLines(T, chk).map((m, i) => `<span class="${i ? '' : 'on'}">${m}</span>`).join('')}</p>
      </div>
      <div class="b-growth tap" data-act="detail" data-k="work">
        <div><p class="b-label">درآمد کاری ${monthLabel(key).split(' ')[0]}</p><p class="b-value" data-cu="${s.work}" data-f="short">${fmtShort(s.work)}</p>
          <p class="b-sub">${s.family ? `و ${fmtShort(s.family)} از خانواده` : '&nbsp;'}</p></div>
        <div class="b-bars">${incomeBars(T, key)}</div>
      </div>
      <div class="b-count tap" data-act="detail" data-k="count"><p class="b-num" data-cu="${s.count - s.rounds}" data-f="int">${faDigits(s.count - s.rounds)}</p><p class="b-label">تراکنش</p></div>
      <div class="b-rating tap" data-act="detail" data-k="cov">
        <div class="b-badge">٪</div>
        <div><p class="b-strong">${cov === null ? '—' : faDigits(cov) + '٪'}</p><p class="b-label">از خرج این ماه را درآمد کاری پوشش داده</p></div>
      </div>
    </section>

    ${liveStory(T, key)}
    <div class="dash">
      <div class="span-6" id="trend">${trendCard()}</div>
      <div class="span-6">
        ${held.length ? `<div class="section-title">پس‌انداز و طلب (از روز شروع)</div><div class="group">${held.map(([l, v]) => `<div class="cell"><span class="grow">${esc(l)}</span><b>${fmtShort(v)}</b></div>`).join('')}</div>` : ''}
      </div>
    </div></div>`;
}

// Rotating one-liners under the balance so the app feels alive.
function liveLines(T, chk) {
  const now = new Date(), j = toJalali(now), len = monthLength(j.jy, j.jm);
  const today = T.filter(t => t.type === 'expense' && new Date(t.ts).toDateString() === now.toDateString());
  const last = T.filter(t => t.src === 'manual').sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const ms = monthSummary(T, monthKey(now));
  const lines = [];
  lines.push(today.length ? `امروز ${faDigits(today.length)} خرج · ${fmtShort(today.reduce((a, t) => a + t.amount, 0))}` : 'امروز هنوز خرجی ثبت نشده');
  if (last) lines.push(`آخرین ثبت: <span data-ago="${last.ts}">${ago(last.ts)}</span> · ${esc(last.desc)}`);
  lines.push(`روز ${faDigits(j.jd)} از ${faDigits(len)} · ${faDigits(len - j.jd)} روز تا آخر ${monthLabel(monthKey(now)).split(' ')[0]}`);
  const proj = projectMonth(monthKey(now), ms.expense, baseline(monthsSeries(S.history, T, S.settings.startDate), m => m.expense || 0), now);
  if (ms.expense && proj) lines.push(`پیش‌بینی خرج این ماه: حدود ${fmtShort(proj)} (میانگین ۳ ماه اخیر در نظر گرفته شده)`);
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
const trLabel = f => (TR_FIELDS.find(x => x[0] === f) || [, ''])[1];
const trColor = f => f === 'work' ? '#30d158' : f === 'family' ? '#ff9f0a' : f === 'expense' ? '#f2f2f4' : CATEGORIES[f].color;
const upGood = f => f === 'work' || f === 'family';

// Money of one field inside a transaction (daily frames) or a month record (monthly frames).
const txValue = (t, f) => f === 'expense' ? (t.type === 'expense' ? t.amount : 0)
  : f === 'work' ? (t.type === 'income_work' ? t.amount : 0)
  : f === 'family' ? (t.type === 'family' ? t.amount : 0)
  : (t.type === 'expense' && t.cat === f ? t.amount : 0);
const monthValue = (m, f) => ['expense', 'work', 'family'].includes(f) ? (m[f] || 0) : ((m.byCat || {})[f] || 0);

function trendPoints(field, frame) {
  const T = scoped(), now = new Date();
  if (frame === '1w' || frame === '1m') {
    const n = frame === '1w' ? 7 : toJalali(now).jd;
    const pts = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      pts.push({ d, label: frame === '1w' ? WEEKDAY_SHORT[d.getDay()] : faDigits(toJalali(d).jd), full: formatJalali(d), value: 0, running: i === 0 });
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
    const p = { key: m.key, label: monthLabel(m.key).split(' ')[0], full: monthLabel(m.key), value: monthValue(m, field), running: !!m.running };
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

function trendCard() {
  const tr = S.tr;
  const pts = trendPoints(tr.field, tr.frame);
  const cmp = tr.cmp ? trendPoints(tr.cmp, tr.frame) : null;
  const n = pts.length;
  const W = Math.max(300, Math.round(S.trW || 340)), H = 300;
  const pad = { t: 28, b: 36, l: 8, r: 62 }, inset = 18;
  const PW = W - pad.l - pad.r, PH = H - pad.t - pad.b;
  const vals = [...pts.map(p => Math.max(p.value, p.proj || 0)), ...(cmp ? cmp.map(p => p.value) : [])];
  const { step, top } = niceScale(Math.max(1, ...vals));
  const unit = top >= 2e6 ? 1e6 : 1e3, unitName = unit === 1e6 ? 'میلیون تومان' : 'هزار تومان';
  const num = v => faDigits(String(Math.round(v / unit * 10) / 10).replace('.', '٫'));
  const X = i => pad.l + inset + (n === 1 ? (PW - 2 * inset) / 2 : i * (PW - 2 * inset) / (n - 1));
  const Y = v => pad.t + PH * (1 - v / top);
  const path = arr => arr.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
  const focus = pts.findIndex(p => p.key === S.month);
  const hi = tr.hover == null || tr.hover >= n ? (focus >= 0 ? focus : n - 1) : tr.hover;
  const cur = pts[hi], prev = pts[hi - 1], last = pts[n - 1];
  const daily = tr.frame === '1w' || tr.frame === '1m';
  const curV = cur.running && cur.proj ? cur.proj : cur.value;
  const delta = prev && prev.value && !(cur.running && !cur.proj && !daily) ? (curV - prev.value) / prev.value : null;
  const good = delta == null ? null : (delta > 0) === upGood(tr.field);
  const done = pts.filter(p => !p.running);
  const avg = done.length > 1 ? done.reduce((a, p) => a + p.value, 0) / done.length : 0;
  const col = trColor(tr.field);
  const A = tr.a != null && tr.a < n ? tr.a : null, B = tr.b != null && tr.b < n ? tr.b : null;
  let measure = '';
  tr.mText = '';
  if (A != null && B != null) {
    const [i, j] = A < B ? [A, B] : [B, A], va = pts[i].value, vb = pts[j].value, ch = va ? (vb - va) / va : null;
    tr.mGood = ch == null ? null : (ch > 0) === upGood(tr.field);
    measure = `<rect x="${X(i)}" y="${pad.t}" width="${X(j) - X(i)}" height="${PH}" class="tr-measure ${tr.mGood === null ? '' : tr.mGood ? 'up' : 'down'}"/>`;
    tr.mText = `از ${pts[i].label} تا ${pts[j].label}: ${ch == null ? '' : `${ch > 0 ? '▲' : '▼'} ${faDigits(Math.abs(Math.round(ch * 100)))}٪ · `}${vb >= va ? '+' : '−'}${fmtShort(Math.abs(vb - va))}`;
  } else if (A != null) tr.mText = `${pts[A].label} انتخاب شد. نقطهٔ دوم را بزن.`;
  const ticks = []; for (let v = 0; v <= top + 1; v += step) ticks.push(v);
  const showVal = i => n <= 8 || i % Math.ceil(n / 8) === 0 || i === n - 1 || i === hi;
  // Time labels: keep the newest, then walk back and drop any label that would touch its neighbour.
  const tw = i => pts[i].label.length * 6.4 + 8;
  const timeKeep = new Set();
  for (let i = n - 1, lastX = Infinity, lastW = 0; i >= 0; i--) {
    if (lastX - X(i) >= (tw(i) + lastW) / 2) { timeKeep.add(i); lastX = X(i); lastW = tw(i); }
  }
  const showTime = i => timeKeep.has(i) && Math.abs(X(i) - X(hi)) >= (tw(i) + 68) / 2;
  const tag = (y, text, fill, ink) => `<rect x="${W - pad.r + 2}" y="${(y - 10).toFixed(1)}" width="${pad.r - 4}" height="20" rx="4" fill="${fill}"/><text x="${W - pad.r / 2}" y="${(y + 4).toFixed(1)}" text-anchor="middle" class="tv-tag" fill="${ink}">${text}</text>`;
  const timeTag = `<rect x="${(X(hi) - 34).toFixed(1)}" y="${H - pad.b + 5}" width="68" height="20" rx="4" fill="#e9e9ee"/><text x="${X(hi).toFixed(1)}" y="${H - pad.b + 19}" text-anchor="middle" class="tv-tag" fill="#0b0c0e">${esc(cur.label)}</text>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="tv-svg" id="tr-svg">
    <defs><linearGradient id="tvA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <text x="${W - pad.r + 6}" y="14" class="tv-unit">${unitName}</text>
    ${ticks.map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="tv-grid"/><text x="${W - pad.r + 8}" y="${Y(v) + 4}" class="tv-scale">${num(v)}</text>`).join('')}
    ${pts.map((_, i) => `<line x1="${X(i)}" x2="${X(i)}" y1="${pad.t}" y2="${H - pad.b}" class="tv-grid v"/>`).join('')}
    <line x1="${W - pad.r}" x2="${W - pad.r}" y1="${pad.t - 8}" y2="${H - pad.b}" class="tv-axis"/>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" class="tv-axis"/>
    ${measure}
    ${avg ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(avg)}" y2="${Y(avg)}" class="tv-avg"/>` : ''}
    <path d="${path(pts)} L${X(n - 1)},${H - pad.b} L${X(0)},${H - pad.b} Z" fill="url(#tvA)"/>
    ${cmp ? `<path d="${path(cmp)}" fill="none" stroke="${trColor(tr.cmp)}" stroke-width="2" stroke-linejoin="round"/>${cmp.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.value)}" r="2.5" fill="${trColor(tr.cmp)}"/>`).join('')}` : ''}
    <path d="${path(pts)}" pathLength="1" class="draw" fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${last.proj ? `<line x1="${X(n - 1)}" y1="${Y(last.value)}" x2="${X(n - 1)}" y2="${Y(last.proj)}" stroke="${col}" stroke-width="1.6" stroke-dasharray="3 4"/><circle cx="${X(n - 1)}" cy="${Y(last.proj)}" r="4" fill="#0b0c0e" stroke="${col}" stroke-width="1.6"/><text x="${X(n - 1) - 8}" y="${Y(last.proj) + 4}" text-anchor="end" class="tv-note">پیش‌بینی ${num(last.proj)}</text>` : ''}
    ${pts.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.value)}" r="${i === hi ? 5 : 3}" fill="${i === hi ? '#fff' : col}" stroke="#0b0c0e" stroke-width="1.5"/>${showVal(i) ? `<text x="${X(i)}" y="${Y(p.value) - 10}" text-anchor="middle" class="tv-val${i === hi ? ' on' : ''}">${num(p.value)}</text>` : ''}`).join('')}
    ${last.running ? `<circle cx="${X(n - 1)}" cy="${Y(last.value)}" r="4" fill="${col}" class="tr-pulse"/>` : ''}
    ${[A, B].filter(x => x != null).map(i => `<circle cx="${X(i)}" cy="${Y(pts[i].value)}" r="7" fill="none" stroke="#fff" stroke-width="2"/>`).join('')}
    <line x1="${X(hi)}" x2="${X(hi)}" y1="${pad.t}" y2="${H - pad.b}" class="tv-cross"/>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(cur.value)}" y2="${Y(cur.value)}" class="tv-cross"/>
    ${pts.map((p, i) => showTime(i) ? `<text x="${X(i)}" y="${H - pad.b + 19}" text-anchor="middle" class="tv-time">${esc(p.label)}</text>` : '').join('')}
    ${hi !== n - 1 ? tag(Y(last.value), num(last.value), 'none', col).replace('fill="none"', `fill="#0b0c0e" stroke="${col}"`) : ''}
    ${tag(Y(cur.value), num(cur.value), col, '#0b0c0e')}
    ${timeTag}
  </svg>`;
  const frames = TR_FRAMES.map(([k, l]) => `<button data-act="tr-frame" data-v="${k}" class="${tr.frame === k ? 'on' : ''}">${l}</button>`).join('');
  return `<div class="tv">
    <div class="tv-bar">
      <button class="tv-field" data-act="tr-pick"><i style="background:${col}"></i>${esc(trLabel(tr.field))}<span class="sec">▾</span></button>
      <div class="tv-tools">
        <button class="tv-ico ${tr.cmp || tr.picking ? 'on' : ''}" data-act="tr-cmp" aria-label="مقایسه">${ICON.layers}</button>
        <button class="tv-ico ${tr.measure ? 'on' : ''}" data-act="tr-measure" aria-label="اندازه‌گیری">${ICON.ruler}</button>
      </div>
    </div>
    <div class="tv-frames">${frames}</div>
    <div class="tv-legend">
      <span class="sec">${esc(cur.full)}${cur.running ? ' · <span class="live-dot"></span>تا الان' : ''}</span>
      <button class="tv-num" data-act="detail" data-k="trend"><b>${fmtShort(cur.value)}</b>${ICON.chevL}</button>
      ${delta != null ? `<span class="tr-delta ${good ? 'good' : 'bad'}">${delta > 0 ? '▲' : '▼'} ${faDigits(Math.abs(Math.round(delta * 100)))}٪ ${cur.running && cur.proj ? 'پیش‌بینی ' : ''}نسبت به ${esc(daily ? 'روز قبل' : prev.label)}</span>` : ''}
      ${avg ? `<span class="tv-cmp"><i class="dash"></i>میانگین ${fmtShort(avg)}</span>` : ''}
      ${cmp ? `<span class="tv-cmp"><i style="background:${trColor(tr.cmp)}"></i>${esc(trLabel(tr.cmp))}: ${fmtShort(cmp[hi] ? cmp[hi].value : 0)}</span>` : ''}
    </div>
    <div class="tv-chart" id="tr-wrap">${svg}</div>
    ${tr.picking ? `<div class="tr-fields tr-cmp">${TR_FIELDS.filter(x => x[0] !== tr.field).map(([k, l]) => `<button data-act="tr-cmpf" data-v="${k}" class="${tr.cmp === k ? 'on' : ''}"><i style="background:${trColor(k)}"></i>${l}</button>`).join('')}</div>` : ''}
    ${tr.mText ? `<p class="tr-mtext ${tr.mGood === true ? 'good' : tr.mGood === false ? 'bad' : ''}">${esc(tr.mText)}</p>` : ''}
    <p class="tv-hint">${tr.measure ? 'اندازه‌گیری: روی دو نقطه بزن.' : 'انگشتت را روی نمودار بکش تا عدد هر نقطه را ببینی.'}${last.proj ? ' پیش‌بینی = خرج تا امروز + میانگین ۳ ماه اخیر برای روزهای باقی‌مانده.' : ''}</p>
  </div>`;
}

function redrawTrend() { const el = document.getElementById('trend'); if (el) el.innerHTML = trendCard(); }

function bindTrend() {
  const el = document.getElementById('trend');
  if (!el) return;
  const box = el.querySelector('.tv-chart');
  if (box && Math.abs(box.clientWidth - (S.trW || 0)) > 4) { S.trW = box.clientWidth; redrawTrend(); }
  const idxAt = e => {
    const svg = document.getElementById('tr-svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect(), n = trendPoints(S.tr.field, S.tr.frame).length;
    const W = Math.max(300, Math.round(S.trW || 340)), span = W - 8 - 62 - 36;
    const x = (e.clientX - r.left) / r.width * W - 8 - 18;
    return Math.max(0, Math.min(n - 1, Math.round(x / (span / Math.max(1, n - 1)))));
  };
  el.addEventListener('pointermove', e => {
    if (!e.target.closest('#tr-wrap')) return;
    const i = idxAt(e);
    if (i != null && i !== S.tr.hover) { S.tr.hover = i; redrawTrend(); }
  });
  el.addEventListener('pointerdown', e => {
    if (!e.target.closest('#tr-wrap')) return;
    const i = idxAt(e);
    if (i == null) return;
    S.tr.hover = i;
    if (S.tr.measure) { if (S.tr.a == null || S.tr.b != null) { S.tr.a = i; S.tr.b = null; } else S.tr.b = i; }
    redrawTrend();
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

// ----- Settings -----
function viewSettings() {
  const st = S.settings;
  const last = st.lastBackup ? formatJalali(new Date(st.lastBackup)) : 'هرگز';
  const stale = !st.lastBackup || Date.now() - new Date(st.lastBackup) > 7 * 864e5;
  const toggle = (k, label) => `<button class="cell" data-act="toggle" data-v="${k}"><span>${label}</span><i class="switch ${st[k] ? 'on' : ''}"></i></button>`;
  return `<div class="view">
    ${pageHead('تنظیمات')}
    <div class="section-title">پشتیبان</div>
    <div class="group">
      <button class="cell" data-act="export"><span class="tint">ذخیرهٔ پشتیبان</span><span class="sec ${stale ? 'red' : ''}">${esc(last)}</span></button>
      <button class="cell" data-act="pick-json"><span class="tint">وارد کردن فایل پشتیبان</span></button>
    </div>
    <p class="foot">برای آیپد: در آیفون پشتیبان بگیر، با AirDrop بفرست و در آیپد وارد کن. موارد تکراری دوباره اضافه نمی‌شوند.</p>

    <div class="section-title">بانک</div>
    <div class="group">
      <button class="cell" data-act="pick-xlsx"><span class="tint">وارد کردن صورت‌حساب بلو</span></button>
      <div class="cell"><span>موجودی واقعی بلو</span><input class="bare end" id="bank-bal" inputmode="numeric" placeholder="مبلغ"></div>
      <button class="cell" data-act="check"><span class="tint">مقایسه با موجودی اپ</span><span class="sec" id="check-res">${fmt(balanceAt(S.tx, S.settings))}</span></button>
      ${toggle('roundUp', 'رند بلو (تا ۱۰۰ هزار تومان)')}
    </div>
    <p class="foot">${st.roundUp ? `از ${esc(formatJalali(new Date(st.roundSince)))}، با هر خرج، فرقش تا ۱۰۰ هزار تومان بعدی خودکار «پس‌انداز باکس» حساب می‌شود؛ مثل خود بلو.` : 'اگر «رند» در بلو روشن است، این را روشن کن تا موجودی اپ با بلو یکی بماند.'}</p>

    <div class="section-title">نمایش</div>
    <div class="group">
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
    <p class="foot">اطلاعات فقط روی همین دستگاه ذخیره می‌شود و بدون اینترنت کار می‌کند.</p>
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
    for (const k of ['openingBalance', 'openingDate', 'startDate']) if (S.settings[k] == null && data.settings[k] != null) S.settings[k] = data.settings[k];
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
      if (pw) await importBackupData(await loadBundle(pw));
      Object.assign(S.settings, { startDate: d, openingBalance: v, openingDate: d });
      S.month = monthKey(new Date(Math.max(Date.now(), new Date(d))));
      await saveSettings();
      render();
    }
    else if (a === 'clear') { if (S.amount) { S.amount = ''; render(); } }
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
    else if (a === 'an-month') { S.anKey = b.dataset.v; render(); }
    else if (a === 'an-open') { S.month = b.dataset.v; S.view = 'dash'; render(); window.scrollTo(0, 0); }
    else if (a === 'an-load') {
      const pw = toAscii(document.getElementById('an-pw').value).toLowerCase().replace(/\s/g, '');
      if (!pw) return toast('رمز را بنویس');
      await importBackupData(await loadBundle(pw));
      toast('تاریخچه بارگذاری شد'); render();
    }
    else if (a === 'mon') { S.month = shiftMonth(S.month, +b.dataset.v); S.tr.hover = null; render(); }
    else if (a === 'tr-pick') openSheet(`<div class="sheet-nav"><span></span><b>نمودارِ چه چیزی؟</b><button class="link" data-close>بستن</button></div>
      <div class="group">${TR_FIELDS.map(([k, l]) => `<button class="cell" data-act="pick" data-v="${k}"><i class="dot" style="background:${trColor(k)}"></i><span class="grow">${l}</span>${S.tr.field === k ? ICON.ok : ''}</button>`).join('')}</div>`,
      { pick: v => { closeSheet(); Object.assign(S.tr, { field: v, hover: null, a: null, b: null, cmp: S.tr.cmp === v ? null : S.tr.cmp }); redrawTrend(); } });
    else if (a === 'month-pick') openMonthPicker();
    else if (a === 'detail') openDetail(b.dataset.k, b.dataset.v);
    else if (a === 'tr-field') { Object.assign(S.tr, { field: b.dataset.v, hover: null, a: null, b: null, cmp: S.tr.cmp === b.dataset.v ? null : S.tr.cmp }); redrawTrend(); }
    else if (a === 'tr-frame') { Object.assign(S.tr, { frame: b.dataset.v, hover: null, a: null, b: null }); redrawTrend(); }
    else if (a === 'tr-measure') { Object.assign(S.tr, { measure: !S.tr.measure, a: null, b: null }); redrawTrend(); }
    else if (a === 'tr-cmp') { if (S.tr.cmp) Object.assign(S.tr, { cmp: null, picking: false }); else S.tr.picking = !S.tr.picking; redrawTrend(); }
    else if (a === 'tr-cmpf') { Object.assign(S.tr, { cmp: b.dataset.v, picking: false }); redrawTrend(); }
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
    else if (a === 'pick-json') document.getElementById('file-json').click();
    else if (a === 'pick-xlsx') document.getElementById('file-xlsx').click();
    else if (a === 'check') {
      const v = parseAmount(document.getElementById('bank-bal').value);
      if (!v) return toast('موجودی واقعی بلو را وارد کن');
      const diff = balanceAt(S.tx, S.settings) - v;
      document.getElementById('check-res').textContent = Math.abs(diff) < 1000 ? 'یکی است' : `${fmt(Math.abs(diff))} ${diff > 0 ? 'کمتر در بانک' : 'بیشتر در بانک'}`;
    }
    else if (a === 'wipe') {
      if (!confirm('همهٔ اطلاعات از این دستگاه پاک شود؟')) return;
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
