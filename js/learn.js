// Learning from Farbod's own records: word → category, typo-tolerant matching, the usual part of the day
// for a purchase, the Blu card-to-card fee, and descriptions filed under more than one category.
// Pure functions, no browser.
import { norm } from './format.js';

const STOP = new Set(['و', 'از', 'به', 'برای', 'با', 'در', 'تا', 'یک', 'دو']);

// Words of a description: «قهوه(پودر قهوه)» → ['قهوه', 'پودر'].
export function words(text) {
  const out = [];
  for (const w of norm(text).split(/[^\p{L}\p{N}]+/u)) if (w.length >= 2 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out;
}
const compact = s => norm(s).replace(/[^\p{L}\p{N}]+/gu, '');

export function lev(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Same word, allowing one wrong letter in words of four letters or more («اسنب» = «اسنپ»).
export const near = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && lev(a, b) <= 1);
// Same description written a little differently: spaces, brackets or one or two wrong letters.
export function sameText(a, b) {
  const x = compact(a), y = compact(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const n = Math.min(x.length, y.length);
  return n >= 4 && lev(x, y) <= (n >= 8 ? 2 : 1);
}

// Part of the day: 0 morning (before 11), 1 noon (11–16), 2 afternoon (16–20), 3 night.
export const PARTS = ['صبح', 'ظهر', 'عصر', 'شب'];
export const PART_HOUR = [[9, 0], [13, 30], [18, 0], [21, 30]];
export const partOf = d => { const h = d.getHours(); return h < 11 ? 0 : h < 16 ? 1 : h < 20 ? 2 : 3; };

const usable = t => t.status === 'ok' && t.dir === 'out' && t.type === 'expense' && t.cat && t.cat !== 'fees' && t.cat !== 'uncat' && t.src !== 'roundup';

// What each word has meant so far: categories, and parts of the day from records whose time can be trusted.
// A record typed at night may be a whole day typed at once, so only times before 20:00 (or ones set by hand)
// count as evidence of when something is usually bought.
export function buildWords(txs) {
  const W = new Map();
  for (const t of txs) {
    if (t.status !== 'ok' || t.dir !== 'out' || t.cat === 'fees' || t.src === 'roundup' || t.feeOf) continue;
    const exp = usable(t), d = new Date(t.ts), trusted = partOf(d) < 3 || t.timeSet;
    for (const w of words(t.desc)) {
      let m = W.get(w);
      if (!m) W.set(w, m = { cats: {}, parts: [0, 0, 0, 0], n: 0, out: 0, c2c: 0, sample: t.desc });
      m.out++;
      if (t.c2c) m.c2c++;
      if (!exp) continue;
      m.cats[t.cat] = (m.cats[t.cat] || 0) + 1;
      m.n++;
      if (trusted) m.parts[partOf(d)]++;
    }
  }
  return W;
}

function votes(W, text) {
  const tw = words(text), hits = [];
  for (const w of tw) {
    let best = null;
    for (const [k, m] of W) {
      if (k === w) { best = { m, wt: 1 }; break; }
      if (!best && near(k, w)) best = { m, wt: 0.7 };
    }
    if (best) hits.push(best);
  }
  return hits;
}

// Category from the words, when one category clearly wins (at least 60% of the votes).
export function catFromWords(W, text) {
  const hits = votes(W, text).filter(h => h.m.n);
  if (!hits.length) return null;
  const sum = {};
  let total = 0, sample = '';
  for (const { m, wt } of hits) {
    for (const [c, n] of Object.entries(m.cats)) { sum[c] = (sum[c] || 0) + n * wt; total += n * wt; }
    if (!sample) sample = m.sample;
  }
  const [cat, v] = Object.entries(sum).sort((a, b) => b[1] - a[1])[0];
  // full: every word of the text is known, so this wins over the built-in keyword list.
  return v / total >= 0.6 ? { cat, sample, full: hits.length === words(text).length } : null;
}

// Usual part of the day for these words, or null when there is too little evidence.
export function usualPart(W, text) {
  const p = [0, 0, 0, 0];
  for (const { m } of votes(W, text)) m.parts.forEach((n, i) => { p[i] += n; });
  const total = p.reduce((s, n) => s + n, 0);
  if (total < 2) return null;
  const i = p.indexOf(Math.max(...p));
  return p[i] / total >= 0.6 ? i : null;
}

// Was this kind of payment a card-to-card transfer before? (more than half of the times)
export function usuallyC2c(W, text) {
  const hits = votes(W, text).filter(h => h.wt === 1);
  const n = hits.reduce((s, h) => s + h.m.out, 0), c = hits.reduce((s, h) => s + h.m.c2c, 0);
  return n >= 1 && c / n > 0.5;
}

// Blu's card-to-card fee, read from every transfer on the statements since 20 Shahrivar 1405:
// up to 1,000,000 toman → 1,100; every further million (or part of one) → +350.
export function c2cFee(amount) {
  if (!(amount > 0)) return 0;
  return amount <= 1e6 ? 1100 : 1100 + 350 * Math.ceil((amount - 1e6) / 1e6);
}

// Descriptions recorded under more than one category, with the counts, for «یکدست کردن».
// `done` holds descriptions already settled (picked once, or marked as really different).
export function mixedDescs(txs, done = {}) {
  const G = new Map();
  for (const t of txs) {
    if (!usable(t)) continue;
    const k = compact(t.desc);
    if (!k || done[k]) continue;
    let g = G.get(k);
    if (!g) G.set(k, g = { key: k, desc: t.desc, cats: {}, n: 0 });
    g.cats[t.cat] = (g.cats[t.cat] || 0) + 1;
    g.n++;
  }
  return [...G.values()].filter(g => Object.keys(g.cats).length > 1)
    .map(g => ({ ...g, order: Object.entries(g.cats).sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.n - a.n);
}
export const descKey = compact;
