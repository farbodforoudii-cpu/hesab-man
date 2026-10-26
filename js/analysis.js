// Long-view analysis: one record per month (history aggregates before the start, live
// transactions after) plus plain-language findings computed from them.
import { monthSummary, summarize, txMonth } from './stats.js';
import { monthKey, shiftMonth, monthLabel, faDigits } from './jalali.js';
import { CATEGORIES } from './model.js';
import { fmtShort, iso } from './format.js';

export function monthsSeries(history, txs, startDate, now = new Date()) {
  const H = (history && history.months) || {};
  const startKey = startDate ? monthKey(new Date(startDate)) : null;
  const out = [];
  const sumArr = a => (a || []).reduce((x, y) => x + y[1], 0);
  for (const k of Object.keys(H).sort()) {
    if (startKey && k >= startKey) continue;
    const m = { key: k, live: false, ...H[k], byCat: { ...(H[k].byCat || {}) } };
    m.inT = sumArr(m.ins) || (m.work + m.family + m.sale + m.otherIn + m.reimburse + m.loanIn);
    m.outT = sumArr(m.outs) + sumArr(m.days) || (m.expense + m.asset + m.inventory + m.onBehalf + m.loanPay + m.fundIn);
    // Payments that arrived after the start but belong to this month (e.g. a client paying late).
    const late = txs.filter(t => t.period === k);
    if (late.length) {
      const s = summarize(late);
      for (const f of ['work', 'family', 'sale', 'otherIn', 'reimburse', 'loanIn', 'expense', 'asset', 'inventory', 'onBehalf', 'loanPay', 'fundIn']) m[f] = (m[f] || 0) + (s[f] || 0);
      for (const [c, v] of Object.entries(s.byCat)) m.byCat[c] = (m.byCat[c] || 0) + v;
      m.inT += s.in; m.outT += s.out; m.late = late;
    }
    out.push(m);
  }
  if (startKey) {
    const cur = monthKey(now);
    for (let k = startKey; k <= cur; k = shiftMonth(k, 1)) { const sm = monthSummary(txs, k); out.push({ key: k, live: true, running: k === cur, ...sm, inT: sm.in, outT: sm.out }); }
  }
  for (const m of out) m.self = (m.work || 0) + (m.sale || 0) + (m.otherIn || 0) - (m.expense || 0) - (m.inventory || 0);
  return out;
}

const name = k => monthLabel(k).split(' ')[0];
const label = c => (CATEGORIES[c] || CATEGORIES.other).label;
const pct = x => faDigits(Math.round(x * 100)) + '٪';

export function analyze(series) {
  const done = series.filter(m => !m.running && (m.expense || m.work));
  const n = done.length;
  if (!n) return null;
  const sum = f => done.reduce((a, m) => a + (m[f] || 0), 0);
  const work = sum('work'), family = sum('family'), expense = sum('expense'), asset = sum('asset');
  const inflow = work + family + sum('sale') + sum('otherIn');
  const avgWork = work / n, avgExp = expense / n;
  const cov = expense ? work / expense : 0;
  const cats = {};
  for (const m of done) for (const [c, v] of Object.entries(m.byCat || {})) cats[c] = (cats[c] || 0) + v;
  const top = Object.entries(cats).filter(([c]) => CATEGORIES[c] && c !== 'other').sort((a, b) => b[1] - a[1])[0];

  let verdict;
  if (cov < 0.95) verdict = `درآمد کاری ${pct(cov)} هزینه‌ها را پوشش داد؛ باقی از خانواده.`;
  else if (cov <= 1.1) verdict = 'درآمد کاری و هزینه تقریباً برابرند.';
  else verdict = `درآمد کاری از هزینه بیشتر است؛ ماهانه ${fmtShort(avgWork - avgExp)} باقی می‌ماند.`;

  const critiques = [], tips = [], good = [];
  const short = done.filter(m => m.work < m.expense).length;
  if (cov < 1 && family) {
    critiques.push({ w: expense - work, t: 'هزینه‌ها از درآمد کاری جلوترند', d: `${faDigits(short)} از ${faDigits(n)} ماه؛ ${fmtShort(family)} از خانواده.` });
    tips.push({ w: expense - work, t: 'فاصله تا استقلال مالی', d: `ماهانه ${fmtShort(avgExp - avgWork)}؛ با درآمد بیشتر یا هزینهٔ کمتر بسته می‌شود.` });
  }
  if (n >= 4) {
    const h = Math.floor(n / 2);
    const first = done.slice(0, h), last = done.slice(-h);
    let best = null;
    for (const c of Object.keys(CATEGORIES)) {
      if (['other', 'fees', 'uncat'].includes(c)) continue;
      const a = first.reduce((s, m) => s + ((m.byCat || {})[c] || 0), 0) / h;
      const b = last.reduce((s, m) => s + ((m.byCat || {})[c] || 0), 0) / h;
      if (a >= 3e6 && b / a >= 1.4 && (!best || b - a > best.b - best.a)) best = { c, a, b };
    }
    if (best) {
      const avg = cats[best.c] / n;
      critiques.push({ w: (best.b - best.a) * h, t: `${label(best.c)} رو به افزایش است`, d: `از ${fmtShort(best.a)} به ${fmtShort(best.b)} در ماه.` });
      if (best.b > avg) tips.push({ w: (best.b - avg) * 12, t: `بازگشت ${label(best.c)} به میانگین`, d: `میانگین ماهانه ${fmtShort(avg)} است؛ برگشت به آن، ماهانه ${fmtShort(best.b - avg)} و سالانه ${fmtShort((best.b - avg) * 12)} آزاد می‌شود.` });
    }
  }
  const spike = done.reduce((x, m) => (m.expense > x.expense ? m : x), done[0]);
  if (n >= 3 && spike.expense > avgExp * 1.25) {
    const c = Object.keys(spike.byCat || {}).filter(c => c !== 'other').sort((a, b) => (spike.byCat[b] - (cats[b] || 0) / n) - (spike.byCat[a] - (cats[a] || 0) / n))[0];
    critiques.push({ w: spike.expense - avgExp, t: `${name(spike.key)}، پرهزینه‌ترین ماه`, d: `${fmtShort(spike.expense - avgExp)} بالاتر از میانگین${c ? `، بیشترش ${label(c)}` : ''}.` });
  }
  if ((cats.habits || 0) >= 5e6) {
    critiques.push({ w: cats.habits, t: 'دخانیات و نوشیدنی', d: `${fmtShort(cats.habits)} در ${faDigits(n)} ماه؛ ماهانه حدود ${fmtShort(cats.habits / n)}.` });
    tips.push({ w: cats.habits / 2, t: 'نصف کردن دخانیات', d: `سالانه حدود ${fmtShort(cats.habits / n * 6)} صرفه‌جویی.` });
  }
  if (asset) {
    const k = done.filter(m => m.asset > 0);
    good.push({ t: 'سرمایه‌گذاری', d: `${fmtShort(asset)} دارایی شد، نه هزینه.` });
    if (k.length <= n / 2) tips.push({ w: asset / 2, t: 'پس‌انداز منظم ماهانه', d: `سرمایه‌گذاری فقط در ${faDigits(k.length)} ماه؛ هر ماه مبلغی ثابت، مثلاً ${fmtShort(asset / n)}، بهتر است.` });
  }
  const best = done.reduce((x, m) => (m.self > x.self ? m : x), done[0]);
  if (best.self > 0) good.push({ t: `${name(best.key)}، بهترین ماه`, d: `${fmtShort(best.self)} از درآمد کاری ماند.` });

  const by = (a, b) => b.w - a.w;
  const flags = {};
  for (const m of done) for (const [f, v] of Object.entries(m.flags || {})) flags[f] = (flags[f] || 0) + v;
  return {
    n, first: done[0].key, last: done[n - 1].key, work, family, expense, asset, avgWork, avgExp, cov, verdict,
    famShare: inflow ? family / inflow : 0, top: top && { c: top[0], v: top[1], share: top[1] / expense },
    critiques: critiques.sort(by).slice(0, 3), tips: tips.sort(by).slice(0, 3), good: good.slice(0, 3), cats, flags,
  };
}

// How a month compares with the average of the other finished months.
export function compare(series, key) {
  const m = series.find(x => x.key === key);
  const rest = series.filter(x => x.key !== key && !x.running && (x.expense || x.work));
  if (!m || !rest.length) return null;
  const avg = f => rest.reduce((s, x) => s + f(x), 0) / rest.length;
  const rows = [];
  for (const c of Object.keys(CATEGORIES)) {
    const v = (m.byCat || {})[c] || 0, a = avg(x => (x.byCat || {})[c] || 0);
    if (v || a >= 1e6) rows.push({ c, v, a, d: v - a });
  }
  rows.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  return { m, work: { v: m.work || 0, a: avg(x => x.work || 0) }, expense: { v: m.expense || 0, a: avg(x => x.expense || 0) }, rows: rows.slice(0, 6) };
}

// Key metrics for reading money behaviour, grouped by how much they matter.
// Each has a monthly series (for the mini chart), a status and a plain explanation.
const DISCRETIONARY = ['weekend', 'gift', 'habits', 'personal'];
export function kpis(series, balance, held = 0) {
  const done = series.filter(m => !m.running && (m.expense || m.work));
  if (!done.length) return [];
  const n = done.length, sum = f => done.reduce((a, m) => a + f(m), 0);
  const work = sum(m => m.work || 0), exp = sum(m => m.expense || 0), fam = sum(m => m.family || 0);
  const own = sum(m => (m.work || 0) + (m.sale || 0) + (m.otherIn || 0)), ownLeft = sum(m => m.self || 0);
  const disc = sum(m => DISCRETIONARY.reduce((a, c) => a + ((m.byCat || {})[c] || 0), 0));
  const asset = sum(m => m.asset || 0), loan = sum(m => m.loanPay || 0);
  const avgExp = exp / n, months = series.map(m => ({ key: m.key, running: m.running }));
  const st = (v, good, ok, up = true) => (up ? v >= good : v <= good) ? 'g' : (up ? v >= ok : v <= ok) ? 'o' : 'r';
  const mk = (id, tier, title, value, status, mean, get, unit = 'money', target = '') =>
    ({ id, tier, title, value, status, mean, target, unit, points: series.map(m => ({ key: m.key, running: m.running, v: get(m) })) });
  const P = x => (x < 0 ? '−' : '') + faDigits(Math.abs(Math.round(x * 100))) + '٪';
  const out = [];
  out.push(mk('self', 1, 'پوشش هزینه با درآمد کاری', P(work / exp), st(work / exp, 1, .8),
    `درآمد کاری چند درصد هزینهٔ زندگی را پوشش می‌دهد. ${work >= exp ? 'همهٔ هزینه‌ها از درآمد کاری تأمین شده است.' : `یعنی از هر ۱۰۰ تومان هزینه، ${faDigits(Math.round(work / exp * 100))} تومان از کار بوده است.`}`,
    m => m.expense ? (m.work || 0) / m.expense : 0, 'pct', 'هدف: ۱۰۰٪ یا بیشتر'));
  out.push(mk('save', 1, 'نرخ پس‌انداز از درآمد', P(own ? ownLeft / own : 0), st(own ? ownLeft / own : 0, .2, 0),
    'سهم باقی‌مانده از درآمد خودت پس از هزینه.',
    m => m.self || 0, 'money', 'هدف: حداقل ۲۰٪'));
  out.push(mk('spend', 1, 'میانگین هزینهٔ ماهانه', fmtShort(avgExp), 'o',
    `هزینهٔ زندگی ماهانه ${fmtShort(avgExp)} است .`,
    m => m.expense || 0, 'money', 'بهتر است ثابت بماند یا کم‌کم پایین بیاید'));
  out.push(mk('family', 1, 'وابستگی به خانواده', P(fam / ((own + fam) || 1)), st(fam / ((own + fam) || 1), .1, .3, false),
    `سهم حمایت خانواده از کل ورودیِ زندگی؛ ماهانه حدود ${fmtShort(fam / n)}.`,
    m => m.family || 0, 'money', 'هدف: زیر ۱۰٪'));
  const runway = avgExp ? balance / avgExp : 0;
  out.push(mk('runway', 2, 'ذخیرهٔ نقدی', `${iso(faDigits(runway.toFixed(1).replace('.', '٫')))} ماه`, st(runway, 3, 1),
    `موجودی بلو (${fmtShort(balance)}) چند ماه هزینه را پوشش می‌دهد.${held && avgExp ? ` با احتساب دلار، طلا و بقیهٔ دارایی‌ها: ${iso(faDigits(((balance + held) / avgExp).toFixed(1).replace('.', '٫')))} ماه.` : ' دلار و نقره در این عدد نیست.'}`,
    m => m.bank ? m.bank[1] : (m.running ? balance : 0), 'money', 'هدف: حداقل ۳ ماه'));
  out.push(mk('disc', 2, 'هزینه‌های اختیاری', P(disc / (exp || 1)), st(disc / (exp || 1), .25, .4, false),
    'تفریح، هدیه، شخصی و دخانیات.',
    m => DISCRETIONARY.reduce((a, c) => a + ((m.byCat || {})[c] || 0), 0), 'money', 'هدف: زیر ۲۵٪ کل خرج'));
  const assetMonths = done.filter(m => (m.asset || 0) > 0).length;
  out.push(mk('asset', 2, 'سرمایه‌گذاری', fmtShort(asset), assetMonths >= n * .6 ? 'g' : assetMonths ? 'o' : 'r',
    `${fmtShort(asset)} به دلار، نقره و دیگر دارایی‌ها تبدیل شد؛ در ${faDigits(assetMonths)} ماه از ${faDigits(n)} ماه.`,
    m => m.asset || 0, 'money', 'هدف: هر ماه کمی، نه یک‌باره'));
  out.push(mk('debt', 2, 'قسط نسبت به درآمد', P(work ? loan / work : 0), st(work ? loan / work : 0, .15, .3, false),
    `ماهانه حدود ${fmtShort(loan / n)} قسط پرداخت می‌شود.`, m => (m.loanPay || 0), 'money', 'هدف: زیر ۱۵٪ درآمد'));
  return out;
}
