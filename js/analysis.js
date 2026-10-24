// Long-view analysis: one record per month (history aggregates before the start, live
// transactions after) plus plain-language findings computed from them.
import { monthSummary } from './stats.js';
import { monthKey, shiftMonth, monthLabel, faDigits } from './jalali.js';
import { CATEGORIES } from './model.js';
import { fmtShort } from './format.js';

export function monthsSeries(history, txs, startDate, now = new Date()) {
  const H = (history && history.months) || {};
  const startKey = startDate ? monthKey(new Date(startDate)) : null;
  const out = [];
  for (const k of Object.keys(H).sort()) if (!startKey || k < startKey) out.push({ key: k, live: false, ...H[k] });
  if (startKey) {
    const cur = monthKey(now);
    for (let k = startKey; k <= cur; k = shiftMonth(k, 1)) out.push({ key: k, live: true, running: k === cur, ...monthSummary(txs, k) });
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
  if (cov < 0.95) verdict = `درآمد کاری‌ات حدود ${pct(cov)} خرجت را پوشش داده. بقیه از کمک خانواده آمده.`;
  else if (cov <= 1.1) verdict = 'درآمد کاری و خرجت تقریباً سر به سرند. چیزی از کار خودت نمی‌ماند.';
  else verdict = `درآمد کاری‌ات از خرجت بیشتر است. ماهی حدود ${fmtShort(avgWork - avgExp)} از کار خودت می‌ماند.`;

  const critiques = [], tips = [], good = [];
  const short = done.filter(m => m.work < m.expense).length;
  if (cov < 1 && family) {
    critiques.push({ w: expense - work, t: 'خرجت از درآمد کاری‌ات بیشتر است', d: `${faDigits(short)} ماه از ${faDigits(n)} ماه کم آوردی. کمک خانواده (${fmtShort(family)}) این فاصله را پر کرد.` });
    tips.push({ w: expense - work, t: 'فاصلهٔ تا استقلال', d: `یا ماهی ${fmtShort(avgExp - avgWork)} درآمد کاری بیشتر، یا همین‌قدر خرج کمتر.` });
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
      critiques.push({ w: (best.b - best.a) * h, t: `${label(best.c)} مدام بالا رفته`, d: `از ماهی ${fmtShort(best.a)} در ماه‌های اول به ${fmtShort(best.b)} در ماه‌های آخر (${faDigits((best.b / best.a).toFixed(1))} برابر).` });
      if (best.b > avg) tips.push({ w: (best.b - avg) * 12, t: `${label(best.c)} را به میانگین خودت برگردان`, d: `میانگین تو ماهی ${fmtShort(avg)} است. یعنی ماهی ${fmtShort(best.b - avg)} و سالی ${fmtShort((best.b - avg) * 12)} آزاد می‌شود.` });
    }
  }
  const spike = done.reduce((x, m) => (m.expense > x.expense ? m : x), done[0]);
  if (n >= 3 && spike.expense > avgExp * 1.25) {
    const c = Object.keys(spike.byCat || {}).filter(c => c !== 'other').sort((a, b) => (spike.byCat[b] - (cats[b] || 0) / n) - (spike.byCat[a] - (cats[a] || 0) / n))[0];
    critiques.push({ w: spike.expense - avgExp, t: `${name(spike.key)} گران‌ترین ماه بود`, d: `${fmtShort(spike.expense - avgExp)} بیشتر از میانگین${c ? `، بیشترش از «${label(c)}»` : ''}.` });
  }
  if ((cats.habits || 0) >= 5e6) {
    critiques.push({ w: cats.habits, t: 'دخانیات و نوشیدنی', d: `${fmtShort(cats.habits)} در ${faDigits(n)} ماه، یعنی ماهی حدود ${fmtShort(cats.habits / n)}.` });
    tips.push({ w: cats.habits / 2, t: 'نصف کردن دخانیات', d: `سالی حدود ${fmtShort(cats.habits / n * 6)} برایت می‌ماند.` });
  }
  if (asset) {
    const k = done.filter(m => m.asset > 0);
    good.push({ t: 'پس‌انداز کردی', d: `${fmtShort(asset)} پول به دلار، نقره و دارایی تبدیل شد.` });
    if (k.length <= n / 2) tips.push({ w: asset / 2, t: 'پس‌انداز ماهانهٔ ثابت', d: `پس‌اندازت یک‌جا و فقط در ${faDigits(k.length)} ماه بود. اول هر ماه مبلغ ثابتی کنار بگذار، مثلاً ${fmtShort(asset / n)}.` });
  }
  const best = done.reduce((x, m) => (m.self > x.self ? m : x), done[0]);
  if (best.self > 0) good.push({ t: `${name(best.key)} بهترین ماهت بود`, d: `بدون کمک خانواده ${fmtShort(best.self)} از کار خودت ماند.` });
  if (avgWork) good.push({ t: 'درآمد کاری', d: `میانگین ماهی ${fmtShort(avgWork)}${done.some(m => m.sourceCount) ? ` از حدود ${faDigits(Math.round(sum('sourceCount') / n))} منبع` : ''}.` });

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
