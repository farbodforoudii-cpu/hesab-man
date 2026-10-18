// Blu Bank statement import: parsing, classification and matching against manual entries.
import { parseJalaliString } from './jalali.js';
import { norm } from './format.js';
import { newId } from './model.js';

const HEADERS = { balance: 'مانده', out: 'برداشت', in: 'واریز', ttype: 'نوع تراکنش', desc: 'شرح سند', doc: 'شماره سند', date: 'تاریخ' };

// rows: array of arrays (SheetJS sheet_to_json with header:1)
export function parseStatement(rows) {
  let hi = -1, cols = {};
  let opening = null;
  for (let i = 0; i < rows.length; i++) {
    const r = Array.from(rows[i] || [], c => String(c ?? '').trim());
    const op = r.find(c => c.startsWith('مانده از قبل'));
    if (op) opening = Number(op.replace(/[^\d]/g, '')) / 10;
    if (r.some(c => c.startsWith('تاریخ')) && r.some(c => c.startsWith('واریز'))) {
      hi = i;
      r.forEach((c, j) => {
        for (const [k, h] of Object.entries(HEADERS)) if (c.startsWith(h) && cols[k] === undefined) cols[k] = j;
      });
      break;
    }
  }
  if (hi < 0) throw new Error('ساختار فایل بلو شناخته نشد');
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const date = parseJalaliString(r[cols.date]);
    if (!date) continue;
    const inn = Number(r[cols.in] || 0), outv = Number(r[cols.out] || 0);
    if (!inn && !outv) continue;
    const desc = norm(r[cols.desc]);
    const row = {
      ts: date.toISOString(),
      dir: inn ? 'in' : 'out',
      amount: (inn || outv) / 10,
      ttype: norm(r[cols.ttype]),
      desc,
      doc: String(r[cols.doc] ?? ''),
      balance: Number(r[cols.balance] || 0) / 10,
      ...extractParty(desc),
    };
    row.key = `${String(r[cols.date]).trim()}|${row.doc}|${row.dir}|${inn || outv}`;
    out.push(row);
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return { rows: out, opening };
}

export function extractParty(desc) {
  const nm = desc.match(/بنام[:\s]+(.+?)(?:\s+از (?:درگاه|خودپرداز|کیوسک)|\s+-\s|$)/);
  const iban = desc.match(/IR\d{24}/i);
  const term = desc.match(/(?:پایانه فروش|از اینترنت)\s+(\d+)/);
  const name = nm ? nm[1].replace(/\s+/g, ' ').trim() : '';
  let party = null;
  if (name) party = 'N:' + norm(name).replace(/\s/g, '');
  else if (term) party = 'T:' + term[1];
  else if (iban) party = 'I:' + iban[0].toUpperCase();
  return { name, terminal: term ? term[1] : '', iban: iban ? iban[0].toUpperCase() : '', party };
}

function systemRule(row) {
  const t = row.ttype;
  if (t.includes('کارمزد') || t.includes('تمبر')) return { type: 'expense', cat: 'fees', desc: 'کارمزد بانکی' };
  if (t.includes('سود بانکی')) return { type: 'other_in', desc: 'سود بانکی' };
  if (t.includes('هدیه')) return { type: 'other_in', desc: 'جایزهٔ بلو' };
  if (t.includes('برگشت')) return { type: 'other_in', desc: 'برگشت وجه' };
  if (t.includes('اصلاح سند')) return { type: row.dir === 'in' ? 'other_in' : 'expense', cat: row.dir === 'in' ? null : 'fees', desc: 'اصلاح سند بانکی' };
  if (t.includes('تسهیلات')) return { type: row.dir === 'in' ? 'loan_in' : 'loan_pay', cp: 'وام بلو', desc: 'وام بلو' };
  if (t.includes('قبض')) return row.desc.includes('همراه')
    ? { type: 'expense', cat: 'digital', desc: 'قبض موبایل' }
    : { type: 'expense', cat: 'home', desc: 'قبض' };
  return null;
}

function defaultDesc(row) {
  if (row.name) return row.name;
  if (row.terminal) return (row.ttype.includes('اینترنت') ? 'خرید اینترنتی' : 'خرید از فروشگاه');
  return row.ttype || 'تراکنش بانکی';
}

// rules: { parties: { [partyKey]: { in?: {...}, out?: {...} } }, overrides: [{ key, set }] }
export function classify(row, rules, mode = 'new') {
  const base = { cat: null, ctx: 'personal', cp: '', desc: defaultDesc(row) };
  const ov = rules.overrides && rules.overrides.find(o => o.key === row.key);
  if (ov) return { ...base, ...ov.set, status: 'ok' };
  const sys = systemRule(row);
  if (sys) return { ...base, ...sys, status: 'ok' };
  const pr = row.party && rules.parties && rules.parties[row.party];
  const r = pr && pr[row.dir];
  if (r) return { ...base, ...r, status: 'ok' };
  if (row.dir === 'out') {
    return { ...base, type: 'expense', cat: mode === 'history' ? 'uncat' : null, status: mode === 'history' ? 'ok' : 'pending' };
  }
  return { ...base, type: null, status: 'pending' };
}

export function bankToTx(row, cls) {
  return {
    id: newId(),
    ts: row.ts,
    dir: row.dir,
    amount: row.amount,
    desc: cls.desc,
    cp: cls.cp || '',
    type: cls.type,
    cat: cls.type === 'expense' ? cls.cat : null,
    ctx: cls.ctx || 'personal',
    status: cls.type ? cls.status : 'pending',
    src: 'bank',
    bank: { key: row.key, name: row.name, party: row.party, terminal: row.terminal, ttype: row.ttype, desc: row.desc, balance: row.balance },
    created: new Date().toISOString(),
  };
}

// Import new statement rows: link to manual entries when possible, create the rest.
export function importRows(rows, txs, rules, mode = 'new') {
  const known = new Set(txs.filter(t => t.bank).map(t => t.bank.key));
  const free = txs.filter(t => !t.bank && t.src !== 'bank');
  const linked = [], created = [];
  for (const row of rows) {
    if (known.has(row.key)) continue;
    let best = null, bestGap = Infinity;
    for (const t of free) {
      if (t.dir !== row.dir || Math.abs(t.amount - row.amount) > 1) continue;
      const gap = Math.abs(new Date(t.ts) - new Date(row.ts));
      if (gap <= 3 * 864e5 && gap < bestGap) { best = t; bestGap = gap; }
    }
    if (best) {
      free.splice(free.indexOf(best), 1);
      best.bank = { key: row.key, name: row.name, party: row.party, terminal: row.terminal, ttype: row.ttype, desc: row.desc, balance: row.balance };
      linked.push(best);
    } else {
      created.push(bankToTx(row, classify(row, rules, mode)));
    }
  }
  return { linked, created };
}

// Remember how a bank counterparty was labelled so future imports are automatic.
export function learnRule(rules, tx) {
  const party = tx.bank && tx.bank.party;
  if (!party || !tx.type || tx.cat === 'uncat') return false;
  rules.parties = rules.parties || {};
  const p = rules.parties[party] || (rules.parties[party] = {});
  p[tx.dir] = { type: tx.type, cat: tx.cat || null, ctx: tx.ctx || 'personal', cp: tx.cp || '', desc: tx.desc };
  return true;
}
