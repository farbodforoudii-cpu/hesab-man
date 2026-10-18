// Suggestion engine: learns "templates" (recurring transaction patterns) from confirmed
// history and ranks them for a typed amount and the current moment. Fully offline.
import { norm, fmtShort } from './format.js';
import { toJalali, faDigits } from './jalali.js';

const SKIP_TYPES = new Set(['transfer_in', 'transfer_out', 'other_in']);

function bucket(d) {
  const h = d.getHours();
  return h < 11 ? 0 : h < 16 ? 1 : h < 21 ? 2 : 3;
}
const isWeekend = d => d.getDay() === 4 || d.getDay() === 5; // Thursday, Friday

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function templateKey(t) {
  const label = (t.desc || t.cp || '').trim();
  return [t.dir, t.type, t.cat || '', t.ctx || '', norm(t.cp || ''), norm(label)].join('|');
}

export function buildTemplates(txs) {
  const map = new Map();
  for (const t of txs) {
    if (t.status !== 'ok' || SKIP_TYPES.has(t.type)) continue;
    if (t.cat === 'uncat' || t.cat === 'fees') continue;
    const label = (t.desc || t.cp || '').trim();
    if (!label) continue;
    const key = templateKey(t);
    let m = map.get(key);
    if (!m) {
      m = { key, dir: t.dir, type: t.type, cat: t.cat || null, ctx: t.ctx || 'personal', cp: t.cp || '', desc: label, amounts: [], dates: [] };
      map.set(key, m);
    }
    m.amounts.push(t.amount);
    m.dates.push(new Date(t.ts));
  }
  for (const m of map.values()) {
    m.count = m.amounts.length;
    m.median = median(m.amounts);
    m.min = Math.min(...m.amounts);
    m.max = Math.max(...m.amounts);
    m.last = new Date(Math.max(...m.dates));
    const lastIdx = m.dates.findIndex(d => +d === +m.last);
    m.lastAmount = m.amounts[lastIdx];
    m.hourFrac = [0, 0, 0, 0];
    let wk = 0;
    for (const d of m.dates) { m.hourFrac[bucket(d)] += 1 / m.count; if (isWeekend(d)) wk++; }
    m.weekendFrac = wk / m.count;
    // Monthly recurrence: seen in 3+ distinct months on a stable Jalali day.
    const months = new Set(), days = [];
    for (const d of m.dates) { const j = toJalali(d); months.add(`${j.jy}-${j.jm}`); days.push(j.jd); }
    m.recDay = null;
    if (months.size >= 3 && m.count <= months.size * 1.5) {
      const md = median(days);
      const spread = days.reduce((s, x) => s + Math.abs(x - md), 0) / days.length;
      if (spread <= 3) m.recDay = Math.round(md);
    }
  }
  return [...map.values()];
}

export function suggest(templates, amount, now = new Date(), opts = {}) {
  const jd = toJalali(now).jd;
  const res = [];
  for (const m of templates) {
    if (opts.dir && m.dir !== opts.dir) continue;
    let s = 0, why = '', matched = amount <= 0;
    if (amount > 0) {
      const tol = Math.max(1, amount * 0.004);
      const exact = m.amounts.filter(a => Math.abs(a - amount) <= tol).length;
      if (exact) {
        s += 4 + Math.min(exact, 6) * 0.5;
        matched = true;
        why = exact === 1 ? 'یک بار با همین مبلغ' : `${faDigits(exact)} بار با همین مبلغ`;
      } else {
        const r = amount / m.median;
        if (r > 0.8 && r < 1.25) { s += 2.4; matched = true; why = `معمولاً حدود ${fmtShort(m.median)}`; }
        else if (!(amount >= m.min * 0.6 && amount <= m.max * 1.5)) s -= 4;
      }
    }
    s += Math.log1p(m.count) * 0.7;
    const days = (now - m.last) / 864e5;
    s += 1.2 * Math.exp(-days / 45);
    s += 1.0 * m.hourFrac[bucket(now)];
    s += isWeekend(now) ? 0.9 * m.weekendFrac : 0.3 * (1 - m.weekendFrac);
    if (m.recDay && Math.abs(jd - m.recDay) <= 3) {
      s += 2;
      if (!why) why = `معمولاً حوالی ${faDigits(m.recDay)}ام ماه`;
    }
    if (!why) why = m.count > 1 ? `${faDigits(m.count)} بار ثبت شده` : 'یک بار ثبت شده';
    if (!matched) s -= 0.8;
    res.push({ t: m, score: s, why });
  }
  res.sort((a, b) => b.score - a.score);
  const min = amount > 0 ? 2.6 : 3;
  return res.filter(r => r.score >= min).slice(0, opts.limit || 4);
}

// Monthly items due around today that haven't been recorded this month yet.
export function reminders(templates, txs, now = new Date()) {
  const j = toJalali(now);
  const thisMonth = new Set();
  for (const t of txs) {
    const tj = toJalali(new Date(t.ts));
    if (tj.jy === j.jy && tj.jm === j.jm) thisMonth.add(templateKey(t));
  }
  return templates
    .filter(m => m.recDay && j.jd >= m.recDay - 2 && j.jd <= m.recDay + 6 && !thisMonth.has(m.key))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

// Autocomplete for the description field.
export function complete(templates, text, dir) {
  const q = norm(text);
  if (!q) return [];
  return templates
    .filter(m => m.dir === dir && (norm(m.desc).includes(q) || norm(m.cp).includes(q)))
    .sort((a, b) => (norm(b.desc).startsWith(q) - norm(a.desc).startsWith(q)) || b.count - a.count)
    .slice(0, 5);
}

export function bestTemplateForText(templates, text, dir) {
  const q = norm(text);
  if (!q) return null;
  let best = null;
  for (const m of templates) {
    if (m.dir !== dir) continue;
    if (norm(m.desc) === q || norm(m.cp) === q) if (!best || m.count > best.count) best = m;
  }
  return best;
}
