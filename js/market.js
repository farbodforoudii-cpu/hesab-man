// Live market prices (from data/prices.json, refreshed every 2 hours by a GitHub Action), simple trend
// statistics, and a monthly investment plan built from Farbod's own income and investing habits.
// Nothing here predicts the market: every number is a rule written out next to it.

export const MK = {
  usd: { label: 'دلار', unit: 'دلار', per: 'هر دلار' },
  eur: { label: 'یورو', unit: 'یورو', per: 'هر یورو' },
  gold: { label: 'طلای ۱۸ عیار', unit: 'گرم', per: 'هر گرم' },
  silver: { label: 'نقرهٔ ۹۹۹', unit: 'گرم', per: 'هر گرم' },
};
// Long-term mix of new money: gold and dollar carry the hedge against the rial, euro diversifies the
// currency side, silver adds upside with more swing.
export const TARGET = { gold: .35, usd: .30, eur: .15, silver: .20 };

export async function fetchMarket() {
  const res = await fetch('data/prices.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('prices ' + res.status);
  return res.json();
}

const pctOf = (a, b) => (b ? a / b - 1 : null);

// Last price, change over 7 / 30 / 365 days and distance from the 90-day average.
export function stats(M, k) {
  const h = (M && M.hist && M.hist[k]) || [], now = M && M.now && M.now[k];
  const last = now ? now.p : h.length ? h[h.length - 1][1] : null;
  if (!last) return null;
  const back = n => (h.length > n ? h[h.length - 1 - n][1] : null);
  const tail = h.slice(-90), ma90 = tail.length ? tail.reduce((a, r) => a + r[1], 0) / tail.length : null;
  return { k, last, day: now ? now.dp / 100 : null, w: pctOf(last, back(7)), m: pctOf(last, back(30)), y: pctOf(last, back(365)), ma90, pos: pctOf(last, ma90) };
}

// Buy signal from the distance to the 90-day average: below it buys a little more, far above a little less.
export function signal(s) {
  if (!s || s.pos == null) return { tilt: 1, tag: '', note: '' };
  if (s.pos < -0.05) return { tilt: 1.25, tag: 'فرصت خرید', tone: 'g', note: `${pctTxt(-s.pos)} زیر میانگین ۹۰ روزه؛ سهم این ماه کمی بیشتر.` };
  if (s.pos > 0.12) return { tilt: 0.8, tag: 'گران‌تر از معمول', tone: 'o', note: `${pctTxt(s.pos)} بالای میانگین ۹۰ روزه؛ فقط سهم عادی، نه بیشتر.` };
  return { tilt: 1, tag: 'عادی', tone: '', note: `نزدیک میانگین ۹۰ روزه (${s.pos >= 0 ? '+' : '−'}${pctTxt(Math.abs(s.pos))}).` };
}
const pctTxt = v => `${Math.round(v * 100).toLocaleString('fa-IR')}٪`;

// Monthly plan.
//  base  = average monthly investment of the last six finished months (your own habit);
//  pace  = this month's work income ÷ your average work income, kept between 0.5 and 1.5;
//  total = base × pace, rounded to a million.
// The total is split to move the mix towards TARGET (the gap after adding this month's money),
// leaning a little towards anything trading below its 90-day average.
export function plan({ series, held, M, workNow, cash, avgExp, fixed = null }) {
  const done = series.filter(m => !m.running && (m.expense || m.work)).slice(-6);
  const avg = f => (done.length ? done.reduce((a, m) => a + (f(m) || 0), 0) / done.length : 0);
  const avgInv = avg(m => m.asset), avgWork = avg(m => m.work);
  const base = avgInv || avgWork * 0.15;
  const pace = avgWork ? Math.min(1.5, Math.max(0.5, workNow / avgWork)) : 1;
  // A fixed amount (what is left of this month's challenge) replaces the habit-based estimate.
  const total = fixed != null ? Math.max(0, Math.round(fixed / 1e5) * 1e5) : Math.max(0, Math.round((base * pace) / 1e6) * 1e6);
  const S = Object.fromEntries(Object.keys(TARGET).map(k => [k, stats(M, k)]));
  const V = Object.values(held).reduce((a, b) => a + b, 0);
  const need = {}, sig = {};
  for (const k of Object.keys(TARGET)) {
    sig[k] = signal(S[k]);
    need[k] = Math.max(0, TARGET[k] * (V + total) - (held[k] || 0)) * sig[k].tilt;
  }
  let sum = Object.values(need).reduce((a, b) => a + b, 0);
  if (!sum) { for (const k of Object.keys(TARGET)) need[k] = TARGET[k] * sig[k].tilt; sum = Object.values(need).reduce((a, b) => a + b, 0); }
  const rows = Object.keys(TARGET).map(k => {
    const amt = Math.round((total * need[k]) / sum / 1e5) * 1e5, price = S[k] && S[k].last;
    return { k, amt, units: price ? amt / price : 0, price, share: V ? (held[k] || 0) / V : 0, target: TARGET[k], sig: sig[k] };
  });
  return { total, base, pace, avgInv, avgWork, workNow, rows, V, months: done.length, lowCash: avgExp && cash < avgExp * 0.5 };
}
