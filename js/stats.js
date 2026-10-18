// Aggregations for the dashboard. All amounts in toman.
import { monthKey, monthRange, shiftMonth, monthLabel, faDigits } from './jalali.js';
import { CATEGORIES } from './model.js';
import { fmtShort } from './format.js';

export function inRange(txs, start, end) {
  return txs.filter(t => { const d = new Date(t.ts); return d >= start && d < end; });
}

export function summarize(txs) {
  const s = {
    work: 0, family: 0, sale: 0, otherIn: 0, reimburse: 0, loanIn: 0, fundOut: 0, transferIn: 0,
    expense: 0, asset: 0, inventory: 0, onBehalf: 0, loanPay: 0, fundIn: 0, transferOut: 0,
    in: 0, out: 0, count: txs.length, byCat: {}, bySource: {}, byAsset: {}, pending: 0,
  };
  for (const t of txs) {
    const a = t.amount;
    if (t.dir === 'in') s.in += a; else s.out += a;
    if (t.status === 'pending') s.pending++;
    switch (t.type) {
      case 'income_work': s.work += a; add(s.bySource, t.cp || t.desc || 'نامشخص', a); break;
      case 'family': s.family += a; break;
      case 'sale': s.sale += a; break;
      case 'other_in': s.otherIn += a; break;
      case 'reimburse': s.reimburse += a; break;
      case 'loan_in': s.loanIn += a; break;
      case 'fund_payout': s.fundOut += a; break;
      case 'transfer_in': s.transferIn += a; break;
      case 'expense': s.expense += a; add(s.byCat, t.cat || 'other', a); break;
      case 'asset': s.asset += a; add(s.byAsset, t.cp || t.desc || 'دارایی', a); break;
      case 'inventory': s.inventory += a; break;
      case 'on_behalf': s.onBehalf += a; break;
      case 'loan_pay': s.loanPay += a; break;
      case 'fund_pay': s.fundIn += a; break;
      case 'transfer_out': s.transferOut += a; break;
    }
  }
  // Money left after living costs, counting supplement trading as operating income.
  s.surplus = s.work + s.family + s.sale + s.otherIn - s.expense - s.inventory;
  s.selfSurplus = s.surplus - s.family;
  s.coverage = s.expense ? s.work / s.expense : null;
  return s;
}

function add(o, k, v) { o[k] = (o[k] || 0) + v; }

export function monthSummary(txs, key) {
  const { start, end } = monthRange(key);
  return summarize(inRange(txs, start, end));
}

export function balanceAt(txs, settings, at = new Date(8.64e15)) {
  const from = settings.openingDate ? new Date(settings.openingDate) : new Date(0);
  let b = settings.openingBalance || 0;
  for (const t of txs) {
    const d = new Date(t.ts);
    if (d < from || d > at) continue;
    b += t.dir === 'in' ? t.amount : -t.amount;
  }
  return b;
}

// Compare our computed balance with the bank's balance on the latest imported bank row.
export function bankCheck(txs, settings) {
  let last = null;
  const from = settings.openingDate || '';
  for (const t of txs) if (t.ts >= from && t.bank && typeof t.bank.balance === 'number' && (!last || t.ts >= last.ts)) last = t;
  if (!last) return null;
  const sameMoment = txs.filter(t => t.ts === last.ts);
  const computed = balanceAt(txs, settings, new Date(last.ts));
  // Rows sharing a timestamp may be ordered differently; accept a match against any of them.
  const diffs = sameMoment.filter(t => t.bank).map(t => computed - t.bank.balance);
  const diff = diffs.reduce((m, d) => Math.abs(d) < Math.abs(m) ? d : m, diffs[0]);
  return { at: new Date(last.ts), bank: computed - diff, computed, diff };
}

export function balances(txs) {
  let seenzhin = 0, fund = 0, loan = 0, loanCost = 0;
  const assets = {};
  for (const t of txs) {
    if (t.ctx === 'seenzhin' && t.type === 'on_behalf') seenzhin += t.amount;
    if (t.ctx === 'seenzhin' && t.type === 'reimburse') seenzhin -= t.amount;
    if (t.type === 'fund_pay') fund += t.amount;
    if (t.type === 'fund_payout') fund -= t.amount;
    if (t.type === 'loan_in') loan += t.amount;
    if (t.type === 'loan_pay') loan -= t.amount;
    if (t.type === 'asset') add(assets, t.cp || t.desc || 'دارایی', t.amount);
  }
  if (loan < 0) { loanCost = -loan; loan = 0; }
  return { seenzhin, fund, loan, loanCost, assets };
}

export function trend(txs, endKey, n = 7) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = shiftMonth(endKey, -i);
    out.push({ key, label: monthLabel(key).split(' ')[0], ...monthSummary(txs, key) });
  }
  return out;
}

export function insights(txs, key, s, prev) {
  const list = [];
  if (s.expense && s.work) {
    const pct = Math.round(s.coverage * 100);
    list.push({ ic: pct >= 100 ? '✅' : '⚖️', text: `درآمد کاری ${faDigits(pct)}٪ خرج واقعی این ماه را پوشش داده.` });
  }
  if (s.family && s.expense) {
    list.push({ ic: '👪', text: `بدون حمایت خانواده، این ماه ${s.selfSurplus >= 0 ? 'مازاد' : 'کسری'} ${fmtShort(Math.abs(s.selfSurplus))} تومان بود.` });
  }
  if (prev && prev.expense) {
    let best = null;
    for (const [c, v] of Object.entries(s.byCat)) {
      if (c === 'uncat' || c === 'fees') continue;
      const p = prev.byCat[c] || 0;
      const d = v - p;
      if (p >= 2e6 && Math.abs(d) > 2e6 && (!best || Math.abs(d) > Math.abs(best.d))) best = { c, d, p };
    }
    if (best) {
      const pct = Math.round(best.d / best.p * 100);
      list.push({ ic: best.d > 0 ? '📈' : '📉', text: `«${CATEGORIES[best.c].label}» ${faDigits(Math.abs(pct))}٪ ${best.d > 0 ? 'بیشتر' : 'کمتر'} از ماه قبل (${fmtShort(Math.abs(best.d))}).` });
    }
  }
  const { start, end } = monthRange(key);
  const monthTx = inRange(txs, start, end).filter(t => t.type === 'expense' && t.cat !== 'fees');
  const byCat = {};
  for (const t of txs) if (t.type === 'expense' && t.cat && t.cat !== 'uncat') (byCat[t.cat] = byCat[t.cat] || []).push(t.amount);
  for (const t of monthTx) {
    const arr = byCat[t.cat];
    if (!arr || arr.length < 8) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    if (t.amount > Math.max(p90 * 2, 3e6)) list.push({ ic: '🔎', text: `خرج غیرعادی: «${t.desc}» ${fmtShort(t.amount)} در ${CATEGORIES[t.cat].label}.` });
  }
  const uncat = s.byCat.uncat || 0;
  if (uncat && s.expense && uncat / s.expense > 0.15) {
    list.push({ ic: '🏷', text: `${faDigits(Math.round(uncat / s.expense * 100))}٪ خرج این ماه هنوز دسته ندارد. از «بررسی» با چند لمس دسته‌بندی کن.` });
  }
  return list.slice(0, 6);
}

export function claudePack(txs, settings, key) {
  const s = monthSummary(txs, key);
  const tr = trend(txs, key, 6);
  const b = balances(txs);
  const L = [];
  L.push(`گزارش مالی شخصی — ${monthLabel(key)} (تومان)`);
  L.push(`درآمد کاری: ${Math.round(s.work)} | حمایت خانواده: ${Math.round(s.family)} | فروش مکمل: ${Math.round(s.sale)} | خرج واقعی: ${Math.round(s.expense)} | خرید کالای مکمل: ${Math.round(s.inventory)}`);
  L.push(`مازاد: ${Math.round(s.surplus)} | مازاد بدون حمایت خانواده: ${Math.round(s.selfSurplus)} | خرید دارایی: ${Math.round(s.asset)}`);
  L.push('خرج به تفکیک دسته: ' + Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${CATEGORIES[c]?.label || c}=${Math.round(v)}`).join('، '));
  L.push('درآمد به تفکیک منبع: ' + Object.entries(s.bySource).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c}=${Math.round(v)}`).join('، '));
  L.push('روند ۶ ماه (درآمد کاری / حمایت خانواده / خرج واقعی / خرید دارایی):');
  for (const m of tr) L.push(`  ${monthLabel(m.key)}: ${Math.round(m.work)} / ${Math.round(m.family)} / ${Math.round(m.expense)} / ${Math.round(m.asset)}`);
  L.push(`موجودی بلو: ${Math.round(balanceAt(txs, settings))} | طلب Seenzhin: ${Math.round(b.seenzhin)} | سهم پرداختی صندوق مریم: ${Math.round(b.fund)}`);
  L.push('دارایی‌های خریداری‌شده (بهای خرید): ' + Object.entries(b.assets).map(([k, v]) => `${k}=${Math.round(v)}`).join('، '));
  L.push('');
  L.push('لطفاً: ۱) رفتار مالی این ماه را تحلیل کن ۲) سه نکتهٔ مهم برای بهبود بگو ۳) با توجه به تورم ایران، برای مازاد و ترکیب دارایی‌ها پیشنهاد بده. واقعیت، فرض و پیشنهاد را جدا کن.');
  return L.join('\n');
}

export { monthKey };
