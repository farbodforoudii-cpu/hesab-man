import { db, requestPersistence } from './db.js';
import { TYPES, MAIN_TYPES, typesFor, CATEGORIES, PICKABLE_CATS, inferFromText, newId } from './model.js';
import { buildTemplates, suggest, complete, bestTemplateForText } from './suggest.js';
import { parseStatement, importRows, learnRule, classify } from './bank.js';
import { monthSummary, balanceAt, bankCheck, balances, claudePack } from './stats.js';
import { toJalali, fromJalali, monthKey, monthLabel, shiftMonth, monthRange, monthLength, formatJalali, dayLabel, faDigits } from './jalali.js';
import { fmt, fmtShort, tomanWords, esc, norm } from './format.js';

const S = {
  tx: [], settings: {}, rules: { parties: {}, overrides: [] }, history: null, tpl: [],
  view: 'entry', amount: '', dayBack: 0, step: 'amount', dir: 'out', what: '',
  month: monthKey(new Date()), listFilter: 'all', listQuery: '', listLimit: 60, budgetMode: 'week', budgetHover: null,
};
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $ov = document.getElementById('overlay');

// ---------- icons (simple line glyphs) ----------
const ICON = {
  add: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
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
  refresh();
  S.view = window.innerWidth >= 820 && S.settings.startDate ? 'dash' : 'entry';
  S.step = 'amount';
  render();
  requestPersistence();
  setupUpdates();
}

function refresh() { S.tpl = buildTemplates(S.tx); }

// Self-updating: whenever the app is opened or comes back online, look for a new version and
// switch to it automatically (only while nothing is being typed).
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
  await db.putManyTx(list);
  refresh();
}

async function delTx(id) {
  S.tx = S.tx.filter(t => t.id !== id);
  await db.deleteTx(id);
  refresh();
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

// ---------- render ----------
const isWide = () => window.innerWidth >= 820;

function render() {
  const n = pendingList().length;
  const entry = S.view === 'entry' || !S.settings.startDate;
  document.body.classList.toggle('no-tabs', entry);
  const tabs = [['dash', 'chart', 'خلاصه'], ['list', 'list', 'تراکنش‌ها'], ['settings', 'gear', 'تنظیمات']];
  $tabs.innerHTML = entry ? '' : `<div class="inner">${tabs.map(([v, ic, l]) =>
    `<button data-act="tab" data-v="${v}" class="${S.view === v ? 'on' : ''}">${ICON[ic]}<span>${l}</span>${v === 'list' && n ? `<i class="badge">${faDigits(n)}</i>` : ''}</button>`).join('')}</div>`;
  const views = { entry: viewEntry, list: viewList, dash: viewDash, settings: viewSettings };
  $app.innerHTML = views[S.view]();
  if (S.view === 'list') bindList();
  if (S.view === 'dash') bindBudget();
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
        <p class="foot" style="margin:0 0 10px">حساب از ${new Date() < startDay() ? 'اول آبان' : 'همین حالا'} شروع می‌شود. فقط موجودی فعلی بلو را بنویس.</p>
        <input class="field" id="start-bal" inputmode="numeric" placeholder="موجودی بلو (تومان)">
      </div></div>
      <button class="btn-primary" data-act="start">شروع</button>
      <button class="btn-plain" data-act="go-settings">وارد کردن فایل</button>
    </div>`;
  }
  const amt = Number(S.amount || 0);
  const top = `<div class="entry-top">
      <span class="today">${esc(dayLabel(new Date()).replace('امروز · ', ''))}</span>
      <button class="icon-round" data-act="tab" data-v="${isWide() ? 'dash' : 'dash'}" aria-label="خلاصه">${ICON.chart}</button>
    </div>`;
  if (S.step === 'what') {
    return `<div class="view entry">${top}
      <div class="hero-amt small" data-act="back"><div class="stripes"></div><span class="b-pill" id="what-dir">${guess(S.what, S.dir).dir === 'in' ? 'دریافت' : 'پرداخت'}</span><div class="hero-num">${fmt(amt)}</div></div>
      <h2 class="ask">برای چی؟</h2>
      <div class="what-box"><input id="what" class="what-input" placeholder="مثلاً سوپرمارکت، Pouyan، بنزین" autocomplete="off" enterkeyhint="done" value="${esc(S.what)}"></div>
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
    ${new Date() < new Date(S.settings.startDate) ? `<p class="hint-line">حساب از ${formatJalali(new Date(S.settings.startDate))} شروع می‌شود.</p>` : ''}
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

// The account starts on 1 Aban 1405, or right now if that day has passed.
function startDay() {
  const aban = fromJalali(1405, 8, 1);
  return new Date() < aban ? aban : new Date();
}

function bindAmount() {
  const input = document.getElementById('amt');
  if (!input) return;
  input.focus();
  input.addEventListener('input', () => {
    const v = parseAmount(input.value);
    S.amount = v ? String(Math.min(v, 9e12)) : '';
    input.value = v ? fmt(v) : '';
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

function bindWhat() {
  const input = document.getElementById('what');
  if (!input) return;
  input.focus();
  input.addEventListener('input', () => {
    S.what = input.value;
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
  S.step = 'amount'; S.what = ''; S.amount = ''; S.dayBack = 0;
  render();
  await putTx(tx);
  toast(`ثبت شد · ${tx.desc}`, async () => { await delTx(tx.id); });
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
  amt.addEventListener('input', () => { F.amount = parseAmount(amt.value); root.querySelector('#f-words').textContent = tomanWords(F.amount); });
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
  const items = scoped().filter(t =>
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

function itemHtml(t) {
  const d = new Date(t.ts);
  const time = faDigits(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
  return `<button class="cell tx" data-act="edit" data-id="${t.id}">
    <i class="dot" style="background:${dotColor(t)}"></i>
    <span class="tx-main"><span class="t1">${esc(t.desc)}</span><span class="t2">${t.status === 'pending' ? '<b class="warn">نیاز به بررسی</b>' : esc(subtitle(t))} · ${time}</span></span>
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
const HIST_LABELS = { people: 'کارت‌به‌کارت بدون توضیح' };

function viewHistory(key) {
  const H = S.history.months;
  const h = H[key];
  const keys = Object.keys(H).sort();
  const left = h.work + h.family + h.sale + h.otherIn - h.expense - h.inventory;
  const cov = h.expense ? Math.round(h.work / h.expense * 100) : 0;
  const upto = keys.filter(k => k <= key);
  const bars = upto.slice(-11);
  const maxW = Math.max(1, ...bars.map(k => H[k].work));
  const cats = Object.entries(h.byCat).sort((x, y) => y[1] - x[1]);
  const flows = [['پس‌انداز (دلار، نقره، …)', h.asset], ['دریافت وام', h.loanIn], ['قسط', h.loanPay], ['صندوق', h.fundIn], ['پرداخت برای دیگران', h.onBehalf], ['پس گرفته', h.reimburse]].filter(r => r[1]);
  const W = 360, Hh = 150, pad = 20, n = keys.length;
  const max = Math.max(...keys.map(k => Math.max(H[k].expense, H[k].work + H[k].family)));
  const X = i => pad + (n === 1 ? 0 : i * (W - 2 * pad) / (n - 1));
  const Y = v => 14 + (Hh - 40) * (1 - v / max);
  const line = f => smooth(keys.map((k, i) => [X(i), Y(f(H[k]))]));
  const cur = keys.indexOf(key);
  return `<div class="view wide">
    ${pageHead('خلاصه', `<div class="month"><button data-act="mon" data-v="-1">${ICON.chevR}</button><span>${monthLabel(key)}</span><button data-act="mon" data-v="1">${ICON.chevL}</button></div>`)}
    <p class="hist-note">قبل از شروع · فقط خلاصهٔ ماه، بدون نام و جزئیات${h.partial ? ' · تا ۲۶ام ماه' : ''}</p>
    <section class="bento">
      <div class="b-primary"><div class="stripes"></div>
        <div><span class="b-pill">باقی‌مانده بعد از خرج</span><h3 class="b-hero">${fmtShort(left)}</h3></div>
        <p class="b-note">${h.family ? `بدون ${fmtShort(h.family)} کمک خانواده: ${fmtShort(left - h.family)}` : ''}</p></div>
      <div class="b-growth"><div><p class="b-label">درآمد کاری</p><p class="b-value">${fmtShort(h.work)}</p><p class="b-sub">خرج: ${fmtShort(h.expense)}</p></div>
        <div class="b-bars">${bars.map(k => `<i style="height:${Math.max(8, H[k].work / maxW * 100).toFixed(0)}%;${k === key ? '' : 'opacity:.35'}"></i>`).join('')}</div></div>
      <div class="b-count"><p class="b-num">${faDigits(h.sourceCount)}</p><p class="b-label">منبع درآمد</p></div>
      <div class="b-rating"><div class="b-badge">٪</div><div><p class="b-strong">${faDigits(cov)}٪</p><p class="b-label">از خرج با درآمد کاری پوشش داده شد</p></div></div>
    </section>
    <div class="dash">
      <div class="span-6"><div class="bc-shell"><div class="bc">
        <p class="bc-label">${faDigits(n)} ماه</p>
        <svg viewBox="0 0 ${W} ${Hh}" class="bc-chart">
          <defs><linearGradient id="hA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--tint)" stop-opacity=".25"/><stop offset="1" stop-color="var(--tint)" stop-opacity="0"/></linearGradient></defs>
          <path d="${line(m => m.expense)} L${X(n - 1)},${Hh - 26} L${X(0)},${Hh - 26} Z" fill="url(#hA)"/>
          <path d="${line(m => m.expense)}" fill="none" stroke="var(--tint)" stroke-width="2.5" stroke-linecap="round"/>
          <path d="${line(m => m.work)}" fill="none" stroke="#34c759" stroke-width="2.5" stroke-linecap="round"/>
          <path d="${line(m => m.work + m.family)}" fill="none" stroke="#34c759" stroke-width="1.5" stroke-dasharray="4 5" opacity=".7"/>
          ${cur >= 0 ? `<line x1="${X(cur)}" x2="${X(cur)}" y1="10" y2="${Hh - 26}" class="bc-grid"/>` : ''}
          ${keys.map((k, i) => `<text x="${X(i)}" y="${Hh - 6}" text-anchor="middle" class="bc-day">${esc(monthLabel(k).split(' ')[0])}</text>`).join('')}
        </svg>
        <div class="legend"><span><i style="background:#34c759"></i>درآمد کاری</span><span><i style="background:#34c759;opacity:.5"></i>با کمک خانواده</span><span><i style="background:var(--tint)"></i>خرج</span></div>
      </div></div></div>
      <div class="span-6">
        <div class="section-title">خرج‌ها</div>
        <div class="group">${cats.map(([c, v]) => `<div class="cell"><i class="dot" style="background:${CATEGORIES[c] ? CATEGORIES[c].color : '#c7c7cc'}"></i><span class="grow">${HIST_LABELS[c] || (CATEGORIES[c] || CATEGORIES.other).label}</span><span class="sec">${faDigits(Math.round(v / (h.expense || 1) * 100))}٪</span><b>${fmtShort(v)}</b></div>`).join('')}</div>
        <div class="section-title">ورودی‌ها</div>
        <div class="group">
          <div class="cell"><span class="grow">درآمد کاری</span><b>${fmtShort(h.work)}</b></div>
          ${h.sale ? `<div class="cell"><span class="grow">فروش مکمل</span><b>${fmtShort(h.sale)}</b></div>` : ''}
          <div class="cell"><span class="grow sec">از خانواده</span><b class="sec">${fmtShort(h.family)}</b></div>
        </div>
        ${flows.length ? `<div class="section-title">پس‌انداز و جابه‌جایی</div><div class="group">${flows.map(([l, v]) => `<div class="cell"><span class="grow">${l}</span><b>${fmtShort(v)}</b></div>`).join('')}</div>` : ''}
      </div>
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
  const cats = Object.entries(s.byCat).sort((x, y) => y[1] - x[1]);
  const sources = Object.entries(s.bySource).sort((x, y) => y[1] - x[1]);
  if (s.sale) sources.push(['فروش', s.sale]);
  const held = [
    ...(b.seenzhin > 0 ? [['طلب از Seenzhin', b.seenzhin]] : []),
    ...(b.fund ? [['صندوق مریم', b.fund]] : []),
    ...(b.loan ? [['بدهی وام', b.loan]] : []),
    ...Object.entries(b.assets),
  ];
  return `<div class="view wide">
    ${pageHead('خلاصه', `<div class="month"><button data-act="mon" data-v="-1">${ICON.chevR}</button><span>${monthLabel(key)}</span><button data-act="mon" data-v="1">${ICON.chevL}</button></div>`)}

    <section class="bento">
      <div class="b-primary">
        <div class="stripes"></div>
        <div><span class="b-pill">موجودی بلو</span><h3 class="b-hero">${fmt(bal)}</h3></div>
        <p class="b-note">${chk ? (Math.abs(chk.diff) <= 1000 ? 'با حساب بانکی یکی است.' : `${fmtShort(Math.abs(chk.diff))} اختلاف با حساب بانکی.`) : 'تومان، بر اساس ثبت‌های تو از روز شروع.'}</p>
      </div>
      <div class="b-growth">
        <div><p class="b-label">درآمد ${monthLabel(key).split(' ')[0]}</p><p class="b-value">${fmtShort(s.work)}</p>
          <p class="b-sub">${s.family ? `و ${fmtShort(s.family)} از خانواده` : '&nbsp;'}</p></div>
        <div class="b-bars">${incomeBars(T, key)}</div>
      </div>
      <div class="b-count"><p class="b-num">${faDigits(s.count)}</p><p class="b-label">تراکنش</p></div>
      <div class="b-rating">
        <div class="b-badge">٪</div>
        <div><p class="b-strong">${cov === null ? '—' : faDigits(cov) + '٪'}</p><p class="b-label">از خرج با درآمد پوشش داده شد</p></div>
      </div>
    </section>

    <div class="dash">
      <div class="span-6" id="budget">${budgetCard(T)}</div>
      <div class="span-6">
        <div class="section-title">خرج‌ها</div>
        <div class="group">${cats.length ? cats.map(([c, v]) => `<div class="cell"><i class="dot" style="background:${(CATEGORIES[c] || CATEGORIES.other).color}"></i><span class="grow">${(CATEGORIES[c] || CATEGORIES.other).label}</span><span class="sec">${faDigits(Math.round(v / (s.expense || 1) * 100))}٪</span><b>${fmtShort(v)}</b></div>`).join('') : '<div class="cell"><span class="sec">خرجی ثبت نشده</span></div>'}</div>
        <div class="section-title">درآمدها</div>
        <div class="group">${sources.length ? sources.map(([k, v]) => `<div class="cell"><span class="grow">${esc(k)}</span><b>${fmtShort(v)}</b></div>`).join('') : '<div class="cell"><span class="sec">درآمدی ثبت نشده</span></div>'}</div>
        ${held.length ? `<div class="section-title">پس‌انداز و طلب</div><div class="group">${held.map(([l, v]) => `<div class="cell"><span class="grow">${esc(l)}</span><b>${fmtShort(v)}</b></div>`).join('')}</div>` : ''}
      </div>
    </div></div>`;
}

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
  return pts.map(v => `<i style="height:${Math.max(8, v / max * 100).toFixed(0)}%"></i>`).join('');
}

// Spending per day for the last 7 days (week) or this month (month).
function spendSeries(T) {
  const today = new Date();
  const days = S.budgetMode === 'month' ? toJalali(today).jd : 7;
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push({ d, label: S.budgetMode === 'month' ? faDigits(toJalali(d).jd) : WEEKDAY_SHORT[d.getDay()], value: 0 });
  }
  const first = out[0].d;
  for (const t of T) {
    if (t.type !== 'expense') continue;
    const d = new Date(t.ts);
    if (d < first) continue;
    const idx = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - first) / 864e5);
    if (idx >= 0 && idx < out.length) out[idx].value += t.amount;
  }
  return out;
}

function budgetCard(T) {
  const data = spendSeries(T);
  const total = data.reduce((x, y) => x + y.value, 0);
  const prevStart = new Date(data[0].d); prevStart.setDate(prevStart.getDate() - data.length);
  let prev = 0;
  for (const t of T) { const d = new Date(t.ts); if (t.type === 'expense' && d >= prevStart && d < data[0].d) prev += t.amount; }
  const diff = total - prev;
  const W = 360, H = 160, pad = { top: 40, bottom: 35, left: 12, right: 12 };
  const max = Math.max(...data.map(d => d.value)), min = Math.min(...data.map(d => d.value));
  const range = max - min || 1;
  const n = data.length;
  const X = i => pad.left + (n === 1 ? 0 : i / (n - 1)) * (W - pad.left - pad.right);
  const Y = v => H - pad.bottom - (v - min) / range * (H - pad.top - pad.bottom);
  const pts = data.map((d, i) => [X(i), Y(d.value)]);
  const line = smooth(pts);
  const hi = S.budgetHover == null || S.budgetHover >= n ? n - 1 : S.budgetHover;
  const step = Math.ceil(n / 8);
  const tipX = X(hi) / W * 100;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="bc-chart" id="bc-svg">
    <defs><linearGradient id="bcArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--tint)" stop-opacity=".32"/><stop offset="55%" stop-color="var(--tint)" stop-opacity=".12"/><stop offset="100%" stop-color="var(--tint)" stop-opacity=".02"/></linearGradient></defs>
    ${data.map((_, i) => (n <= 8 || i % step === 0) ? `<line x1="${X(i)}" y1="${pad.top}" x2="${X(i)}" y2="${H - pad.bottom}" class="bc-grid" opacity="${i === hi ? .9 : .5}"/>` : '').join('')}
    <path d="${line} L ${X(n - 1)} ${H - pad.bottom} L ${X(0)} ${H - pad.bottom} Z" fill="url(#bcArea)"/>
    <path d="${line}" fill="none" stroke="var(--tint)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${X(hi)}" cy="${Y(data[hi].value)}" r="12" fill="#fff" opacity=".6"/>
    <circle cx="${X(hi)}" cy="${Y(data[hi].value)}" r="7" fill="#fff" stroke="var(--tint)" stroke-width="3"/>
    ${data.map((d, i) => (i % step === 0 || i === n - 1) ? `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" class="bc-day">${d.label}</text>` : '').join('')}
  </svg>`;
  return `<div class="bc-shell"><div class="bc">
    <div class="bc-head">
      <div>
        <div class="row"><p class="bc-label">${S.budgetMode === 'month' ? 'خرج این ماه' : 'خرج ۷ روز اخیر'}</p></div>
        <h2 class="bc-total">${fmtShort(total)}</h2>
        <div class="bc-pill"><span>${diff > 0 ? '+' : diff < 0 ? '−' : ''} ${fmtShort(Math.abs(diff))}</span>
          <svg viewBox="0 0 16 16" class="${diff > 0 ? '' : 'down'}"><path d="M2 11L6 7L9 10L14 4"/><path d="M10 4H14V8"/></svg></div>
      </div>
      <div class="bc-money">${moneyIllustration()}</div>
    </div>
    <div class="bc-wrap">${svg}
      <div class="bc-tip" style="left:${tipX.toFixed(2)}%;top:${(Y(data[hi].value) / H * 100).toFixed(2)}%;--tx:${tipX > 80 ? -86 : tipX < 20 ? -14 : -50}%;--ax:${tipX > 80 ? 86 : tipX < 20 ? 14 : 50}%"><span>${fmtShort(data[hi].value)}</span><i></i></div>
    </div>
    <div class="segmented sm bc-seg">${[['week', 'هفته'], ['month', 'ماه']].map(([k, l]) => `<button data-act="bmode" data-v="${k}" class="${(S.budgetMode || 'week') === k ? 'on' : ''}">${l}</button>`).join('')}</div>

  </div></div>`;
}

function moneyIllustration() {
  const bill = (tx, ty, rot, fill, sh) => `<g transform="translate(${tx}, ${ty}) rotate(${rot}, 40, 25)" filter="url(#${sh})">
      <rect width="80" height="48" rx="6" fill="${fill}"/><circle cx="62" cy="14" r="7" fill="#d9d9de"/><circle cx="62" cy="34" r="5" fill="#d9d9de"/></g>`;
  return `<svg viewBox="0 0 130 110">
    <defs>
      <linearGradient id="bl1" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e5e5ea"/></linearGradient>
      <linearGradient id="bl2" x1="0" y1="0" x2=".2" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#ececf0"/></linearGradient>
      <linearGradient id="bl3" x1="0" y1="0" x2=".1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#f2f2f5"/></linearGradient>
      <filter id="bs1" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="6" stdDeviation="4" flood-opacity=".06"/></filter>
      <filter id="bs2" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="3" flood-opacity=".1"/></filter>
      <filter id="bs3" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity=".09"/></filter>
    </defs>
    ${bill(8, 12, -20, 'url(#bl1)', 'bs1')}${bill(22, 28, -10, 'url(#bl2)', 'bs2')}${bill(38, 44, -2, 'url(#bl3)', 'bs3')}
  </svg>`;
}

function bindBudget() {
  const el = document.getElementById('budget');
  if (!el) return;
  const onMove = e => {
    const svg = document.getElementById('bc-svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const n = spendSeries(scoped()).length;
    const rel = (e.clientX - r.left) / r.width;
    const idx = Math.max(0, Math.min(n - 1, Math.round(((rel * 360) - 12) / (336 / Math.max(1, n - 1)))));
    if (idx !== S.budgetHover) { S.budgetHover = idx; el.innerHTML = budgetCard(scoped()); }
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerdown', onMove);
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
    </div>

    <div class="section-title">نمایش</div>
    <div class="group">
      ${toggle('showHistory', 'نمایش اطلاعات قبل از شروع')}
    </div>

    <div class="section-title">تحلیل</div>
    <div class="group"><button class="cell" data-act="pack"><span class="tint">کپی خلاصهٔ ماه برای Claude</span></button></div>

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
  const data = { app: 'finance-os', version: 1, exported: new Date().toISOString(), settings: S.settings, rules: S.rules, numbersHistory: S.history, tx: S.tx };
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
  const data = JSON.parse(await file.text());
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
      const d = startDay().toISOString();
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
    else if (a === 'day') { S.dayBack = (S.dayBack + 1) % 4; render(); }
    else if (a === 'use') await useTemplate(b.dataset.key, Number(S.amount), entryDate());
    else if (a === 'manual') openTxSheet({ dir: b.dataset.dir, amount: Number(S.amount || 0) });
    else if (a === 'edit') { const t = S.tx.find(x => x.id === b.dataset.id); if (t) openTxSheet({ ...t }); }
    else if (a === 'lf') { S.listFilter = b.dataset.v; S.listLimit = 60; render(); }
    else if (a === 'more') { S.listLimit += 100; document.getElementById('list-body').innerHTML = listBody(); }
    else if (a === 'mon') { S.month = shiftMonth(S.month, +b.dataset.v); render(); }
    else if (a === 'bmode') { S.budgetMode = b.dataset.v; S.budgetHover = null; render(); }
    else if (a === 'toggle') { S.settings[b.dataset.v] = !S.settings[b.dataset.v]; await saveSettings(); render(); }
    else if (a === 'pack') {
      const text = claudePack(scoped(), S.settings, S.month);
      try { await navigator.clipboard.writeText(text); toast('کپی شد'); }
      catch { openSheet(`<div class="sheet-nav"><span></span><b>خلاصهٔ ماه</b><button class="link" data-close>بستن</button></div><textarea class="field" rows="14" readonly>${esc(text)}</textarea>`); }
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
