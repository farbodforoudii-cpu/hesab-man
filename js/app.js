import { db, requestPersistence } from './db.js';
import { TYPES, MAIN_TYPES, typesFor, CATEGORIES, PICKABLE_CATS, inferFromText, newId } from './model.js';
import { buildTemplates, suggest, complete, bestTemplateForText } from './suggest.js';
import { parseStatement, importRows, learnRule, classify } from './bank.js';
import { monthSummary, balanceAt, bankCheck, balances, trend, claudePack } from './stats.js';
import { toJalali, fromJalali, monthKey, monthLabel, shiftMonth, monthRange, monthLength, formatJalali, dayLabel, faDigits } from './jalali.js';
import { fmt, fmtShort, tomanWords, esc, norm } from './format.js';

const S = {
  tx: [], settings: {}, rules: { parties: {}, overrides: [] }, history: null, tpl: [],
  view: 'entry', amount: '', dayBack: 0,
  month: monthKey(new Date()), listFilter: 'all', listQuery: '', listLimit: 60, chartMode: 'month',
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
  render();
  requestPersistence();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function refresh() { S.tpl = buildTemplates(S.tx); }

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
function render() {
  const n = pendingList().length;
  const tabs = [['entry', 'add', 'ثبت'], ['list', 'list', 'تراکنش‌ها'], ['dash', 'chart', 'خلاصه'], ['settings', 'gear', 'تنظیمات']];
  $tabs.innerHTML = `<div class="inner">${tabs.map(([v, ic, l]) =>
    `<button data-act="tab" data-v="${v}" class="${S.view === v ? 'on' : ''}">${ICON[ic]}<span>${l}</span>${v === 'list' && n ? `<i class="badge">${faDigits(n)}</i>` : ''}</button>`).join('')}</div>`;
  const views = { entry: viewEntry, list: viewList, dash: viewDash, settings: viewSettings };
  $app.innerHTML = views[S.view]();
  if (S.view === 'list') bindList();
}

// ----- Entry -----
function viewEntry() {
  if (!S.settings.startDate) {
    return `<div class="view">
      <h1 class="large">شروع</h1>
      <div class="group"><div class="cell col">
        <p class="foot" style="margin:0 0 10px">موجودی فعلی حساب بلو را وارد کن. از همین لحظه، هر چیزی ثبت کنی حساب می‌شود.</p>
        <input class="field" id="start-bal" inputmode="numeric" placeholder="مبلغ به تومان">
      </div></div>
      <button class="btn-primary" data-act="start">شروع</button>
      ${S.tx.length ? '' : '<button class="btn-plain" data-act="go-settings">وارد کردن فایل قبلی</button>'}
    </div>`;
  }
  const amt = Number(S.amount || 0);
  const dayTxt = S.dayBack === 0 ? 'امروز' : S.dayBack === 1 ? 'دیروز' : dayLabel(entryDate());
  const sugs = amt && S.settings.showSuggestions ? suggest(S.tpl, amt, entryDate(), { limit: 3 }) : [];
  return `<div class="view entry">
    <div class="entry-top"><button class="link" data-act="day">${esc(dayTxt)}</button></div>
    <div class="amount-box" data-act="clear">
      <div class="amount ${amt ? '' : 'empty'}">${amt ? fmt(amt) : '۰'}</div>
      <div class="words">${amt ? esc(tomanWords(amt)) : 'تومان'}</div>
    </div>
    <div class="sugs">${sugs.map(r => `<button class="sug" data-act="use" data-key="${esc(r.t.key)}"><span>${esc(r.t.desc)}</span><small>${esc(subtitle(r.t))}</small></button>`).join('')}</div>
    <div class="dir-btns">
      <button class="cap in" data-act="manual" data-dir="in">دریافت</button>
      <button class="cap out" data-act="manual" data-dir="out">پرداخت</button>
    </div>
    <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', 'del'].map(k =>
      `<button data-k="${k}">${k === 'del' ? ICON.del : faDigits(k)}</button>`).join('')}</div>
  </div>`;
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
    <h1 class="large">تراکنش‌ها</h1>
    <input class="search" id="q" placeholder="جستجو" value="${esc(S.listQuery)}">
    ${n || pend ? `<div class="group"><button class="cell" data-act="lf" data-v="${pend ? 'all' : 'pending'}"><span>${pend ? 'نمایش همه' : 'نیاز به بررسی'}</span><span class="row">${pend ? '' : `<b class="count">${faDigits(n)}</b>`}${ICON.chevL}</span></button></div>` : ''}
    ${pend ? '' : `<div class="segmented">${[['all', 'همه'], ['in', 'دریافت'], ['out', 'پرداخت']].map(([k, l]) =>
      `<button data-act="lf" data-v="${k}" class="${S.listFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>`}
    <div id="list-body">${listBody()}</div>
  </div>`;
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
function viewDash() {
  const T = scoped();
  const key = S.month;
  const s = monthSummary(T, key);
  const prev = monthSummary(T, shiftMonth(key, -1));
  const bal = balanceAt(S.tx, S.settings);
  const chk = bankCheck(S.tx, S.settings);
  const b = balances(T);
  const left = s.work + s.family + s.sale + s.otherIn - s.expense - s.inventory;
  const cmp = (cur, p) => {
    if (!p) return '';
    const pct = Math.round((cur - p) / p * 100);
    return pct ? `${faDigits(Math.abs(pct))}٪ ${pct > 0 ? 'بیشتر' : 'کمتر'} از ماه قبل` : 'مثل ماه قبل';
  };
  const cats = Object.entries(s.byCat).sort((x, y) => y[1] - x[1]);
  const sources = Object.entries(s.bySource).sort((x, y) => y[1] - x[1]);
  if (s.sale) sources.push(['فروش', s.sale]);
  const extras = [
    ['پس‌انداز این ماه', s.asset], ['قسط', s.loanPay], ['صندوق', s.fundIn], ['پرداخت برای دیگران', s.onBehalf], ['پس گرفته', s.reimburse],
  ].filter(r => r[1]);
  const held = [
    ...(b.seenzhin > 0 ? [['طلب از Seenzhin', b.seenzhin]] : []),
    ...(b.fund ? [['صندوق مریم', b.fund]] : []),
    ...(b.loan ? [['بدهی وام', b.loan]] : []),
    ...Object.entries(b.assets),
  ];
  return `<div class="view wide">
    <div class="dash-head"><h1 class="large">خلاصه</h1>
      <div class="month"><button data-act="mon" data-v="-1">${ICON.chevR}</button><span>${monthLabel(key)}</span><button data-act="mon" data-v="1">${ICON.chevL}</button></div></div>
    <div class="dash">
      <div class="tile span-6">
        <div class="tile-label">موجودی</div>
        <div class="big">${fmt(bal)} <small>تومان</small></div>
        <div class="foot">${chk ? (Math.abs(chk.diff) <= 1000 ? 'با حساب بلو یکی است' : `${fmtShort(Math.abs(chk.diff))} اختلاف با بانک`) : 'حساب بلو'}</div>
      </div>
      <div class="tile span-6 trio">
        <div><div class="tile-label">درآمد</div><div class="mid green">${fmtShort(s.work)}</div><div class="foot">${cmp(s.work, prev.work)}</div></div>
        <div><div class="tile-label">خرج</div><div class="mid">${fmtShort(s.expense)}</div><div class="foot">${cmp(s.expense, prev.expense)}</div></div>
        <div><div class="tile-label">باقی‌مانده</div><div class="mid ${left < 0 ? 'red' : ''}">${fmtShort(left)}</div><div class="foot">${s.family ? `با ${fmtShort(s.family)} از خانواده` : ''}</div></div>
      </div>
      <div class="tile span-12">
        <div class="row"><div class="tile-label">${S.chartMode === 'month' ? 'از اول ماه' : 'ماه‌های اخیر'}</div><span class="spacer"></span>
          <div class="segmented sm">${[['month', 'این ماه'], ['months', 'ماه‌ها']].map(([k, l]) => `<button data-act="cmode" data-v="${k}" class="${S.chartMode === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        ${S.chartMode === 'month' ? dailyChart(T, key) : monthlyChart(T, key)}
        <div class="legend"><span><i style="background:#34c759"></i>درآمد</span><span><i style="background:var(--tint)"></i>خرج</span></div>
      </div>
      <div class="span-6"><div class="section-title">خرج‌ها</div>
        <div class="group">${cats.length ? cats.map(([c, v]) => `<div class="cell"><i class="dot" style="background:${(CATEGORIES[c] || CATEGORIES.other).color}"></i><span class="grow">${(CATEGORIES[c] || CATEGORIES.other).label}</span><span class="sec">${faDigits(Math.round(v / (s.expense || 1) * 100))}٪</span><b>${fmtShort(v)}</b></div>`).join('') : '<div class="cell"><span class="sec">خرجی ثبت نشده</span></div>'}</div></div>
      <div class="span-6"><div class="section-title">درآمدها</div>
        <div class="group">${sources.length ? sources.map(([k, v]) => `<div class="cell"><span class="grow">${esc(k)}</span><b>${fmtShort(v)}</b></div>`).join('') : '<div class="cell"><span class="sec">درآمدی ثبت نشده</span></div>'}
        ${s.family ? `<div class="cell"><span class="grow sec">از خانواده</span><b class="sec">${fmtShort(s.family)}</b></div>` : ''}</div>
        ${extras.length ? `<div class="section-title">سایر جابه‌جایی‌ها</div><div class="group">${extras.map(([l, v]) => `<div class="cell"><span class="grow">${l}</span><b>${fmtShort(v)}</b></div>`).join('')}</div>` : ''}
        ${held.length ? `<div class="section-title">پس‌انداز و طلب</div><div class="group">${held.map(([l, v]) => `<div class="cell"><span class="grow">${esc(l)}</span><b>${fmtShort(v)}</b></div>`).join('')}</div>` : ''}
      </div>
    </div></div>`;
}

// Smooth path through points (Catmull-Rom converted to cubic Béziers).
function smooth(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    // Clamp control points between neighbours so the curve never overshoots (no dips below zero).
    const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(hi, Math.max(lo, p1[1] + (p2[1] - p0[1]) / 6))];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(hi, Math.max(lo, p2[1] - (p3[1] - p1[1]) / 6))];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function lineChart(series, labels) {
  const W = 700, H = 210, padL = 44, padB = 24, padT = 22;
  const max = Math.max(1, ...series.flatMap(s => s.values));
  const n = labels.length;
  const x = i => padL + (n === 1 ? 0 : i * (W - padL - 6) / (n - 1));
  const y = v => padT + (H - padB - padT) * (1 - v / max);
  const unit = max >= 1e6 ? 1e6 : 1e3;
  let out = `<svg viewBox="0 0 ${W} ${H}" width="100%" class="chart">`;
  for (let i = 0; i <= 2; i++) {
    const yy = y(max * i / 2), v = max * i / 2 / unit;
    out += `<line x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}" class="grid"/><text x="${padL - 6}" y="${yy + 4}" class="axis" text-anchor="end">${faDigits(v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1))}</text>`;
  }
  out += `<text x="${padL - 6}" y="${padT - 10}" class="axis" text-anchor="end">${unit === 1e6 ? 'میلیون' : 'هزار'}</text>`;
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    if (s.area) out += `<defs><linearGradient id="g${si}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".16"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${smooth(pts)} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#g${si})"/>`;
    out += `<path d="${smooth(pts)}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round"/>`;
  });
  const step = Math.ceil(n / 7);
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) out += `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${esc(l)}</text>`; });
  return out + '</svg>';
}

function dailyChart(T, key) {
  const { start, end } = monthRange(key);
  const [jy, jm] = key.split('-').map(Number);
  const now = new Date();
  const days = now >= start && now < end ? toJalali(now).jd : monthLength(jy, jm);
  const inc = Array(days).fill(0), exp = Array(days).fill(0);
  for (const t of T) {
    const d = new Date(t.ts);
    if (d < start || d >= end) continue;
    const i = toJalali(d).jd - 1;
    if (i >= days) continue;
    if (t.type === 'income_work') inc[i] += t.amount;
    if (t.type === 'expense') exp[i] += t.amount;
  }
  for (let i = 1; i < days; i++) { inc[i] += inc[i - 1]; exp[i] += exp[i - 1]; }
  return lineChart([{ values: exp, color: 'var(--tint)', area: true }, { values: inc, color: '#34c759' }], inc.map((_, i) => faDigits(i + 1)));
}

function monthlyChart(T, key) {
  let n = 6;
  if (!S.settings.showHistory && S.settings.startDate) {
    const start = monthKey(new Date(S.settings.startDate));
    n = 1;
    while (n < 6 && shiftMonth(key, -n) >= start) n++;
    n = Math.max(n, 3);
  }
  const tr = trend(T, key, n);
  return lineChart([{ values: tr.map(m => m.expense), color: 'var(--tint)', area: true }, { values: tr.map(m => m.work), color: '#34c759' }], tr.map(m => m.label));
}

// ----- Settings -----
function viewSettings() {
  const st = S.settings;
  const last = st.lastBackup ? formatJalali(new Date(st.lastBackup)) : 'هرگز';
  const stale = !st.lastBackup || Date.now() - new Date(st.lastBackup) > 7 * 864e5;
  const toggle = (k, label) => `<button class="cell" data-act="toggle" data-v="${k}"><span>${label}</span><i class="switch ${st[k] ? 'on' : ''}"></i></button>`;
  return `<div class="view">
    <h1 class="large">تنظیمات</h1>
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
      ${toggle('showSuggestions', 'پیشنهاد در صفحهٔ ثبت')}
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
  if (data.numbersHistory && !S.history) { S.history = data.numbersHistory; await db.set('history', S.history); }
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
  const k = e.target.closest('[data-k]');
  if (k && S.view === 'entry') return key(k.dataset.k);
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  try {
    if (a === 'tab') { S.view = b.dataset.v; render(); window.scrollTo(0, 0); }
    else if (a === 'go-settings') { S.view = 'settings'; render(); }
    else if (a === 'start') {
      const v = parseAmount(document.getElementById('start-bal').value);
      if (!v) return toast('موجودی فعلی را وارد کن');
      const now = new Date().toISOString();
      Object.assign(S.settings, { startDate: now, openingBalance: v, openingDate: now });
      await saveSettings();
      render();
    }
    else if (a === 'clear') { if (S.amount) { S.amount = ''; render(); } }
    else if (a === 'day') { S.dayBack = (S.dayBack + 1) % 4; render(); }
    else if (a === 'use') await useTemplate(b.dataset.key, Number(S.amount), entryDate());
    else if (a === 'manual') openTxSheet({ dir: b.dataset.dir, amount: Number(S.amount || 0) });
    else if (a === 'edit') { const t = S.tx.find(x => x.id === b.dataset.id); if (t) openTxSheet({ ...t }); }
    else if (a === 'lf') { S.listFilter = b.dataset.v; S.listLimit = 60; render(); }
    else if (a === 'more') { S.listLimit += 100; document.getElementById('list-body').innerHTML = listBody(); }
    else if (a === 'mon') { S.month = shiftMonth(S.month, +b.dataset.v); render(); }
    else if (a === 'cmode') { S.chartMode = b.dataset.v; render(); }
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
      toast(`${faDigits(n)} مورد وارد شد`);
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

function key(k) {
  let s = S.amount;
  if (k === 'del') s = s.slice(0, -1);
  else if (s.length < 13) s = (s + k).replace(/^0+/, '');
  S.amount = s;
  render();
}

document.addEventListener('keydown', e => {
  if (S.view !== 'entry' || $ov.innerHTML || e.target.matches('input, textarea')) return;
  const d = toAscii(e.key);
  if (/^\d$/.test(d)) key(d);
  else if (e.key === 'Backspace') key('del');
});

boot();
