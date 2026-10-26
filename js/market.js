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

const avgOf = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export const maSeries = (h, n) => h.map((r, i) => (i + 1 >= n ? [r[0], avgOf(h.slice(i + 1 - n, i + 1).map(x => x[1]))] : null)).filter(Boolean);
// RSI over 14 days (Wilder): 100 − 100 / (1 + average gain ÷ average loss). Under 35 = sold off, over 70 = overheated.
export function rsiSeries(h, n = 14) {
  const out = []; let g = 0, l = 0;
  for (let i = 1; i < h.length; i++) {
    const d = h[i][1] - h[i - 1][1], up = Math.max(0, d), dn = Math.max(0, -d);
    if (i <= n) { g += up / n; l += dn / n; if (i < n) continue; }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    out.push([h[i][0], l ? 100 - 100 / (1 + g / l) : 100]);
  }
  return out;
}

// Last price, change over 7 / 30 / 365 days, 20- and 90-day averages, trend and RSI.
export function stats(M, k) {
  const h = (M && M.hist && M.hist[k]) || [], now = M && M.now && M.now[k];
  const last = now ? now.p : h.length ? h[h.length - 1][1] : null;
  if (!last) return null;
  const back = n => (h.length > n ? h[h.length - 1 - n][1] : null);
  const ma = n => avgOf(h.slice(-n).map(r => r[1]));
  const ma20 = ma(20), ma90 = ma(90), r = rsiSeries(h);
  return { k, last, day: now ? now.dp / 100 : null, w: pctOf(last, back(7)), m: pctOf(last, back(30)), y: pctOf(last, back(365)),
    ma20, ma90, pos: pctOf(last, ma90), trend: ma20 && ma90 ? (ma20 > ma90 * 1.01 ? 1 : ma20 < ma90 * 0.99 ? -1 : 0) : 0, rsi: r.length ? r[r.length - 1][1] : null };
}

// One signal from three readings, each explained:
//  trend   = 20-day average vs 90-day average (up, flat, down);
//  RSI(14) = how stretched the last two weeks are (under 35 sold off, over 70 overheated);
//  gap     = distance of today's price from the 90-day average.
export function signal(s) {
  if (!s || s.pos == null) return { tilt: 1, tag: '', note: '', score: 0 };
  const r = s.rsi ?? 50, gap = s.pos;
  let score = 0;
  if (r < 35) score += 2; else if (r < 45) score += 1; else if (r > 70) score -= 2; else if (r > 62) score -= 1;
  if (gap < -0.05) score += 1; else if (gap > 0.12) score -= 1;
  if (s.trend > 0 && r < 55) score += 1; // a pause inside an uptrend
  if (s.trend < 0 && r > 50) score -= 1;
  const rr = Math.round(r).toLocaleString('fa-IR');
  const why = `روند ${s.trend > 0 ? 'صعودی' : s.trend < 0 ? 'نزولی' : 'بی‌جهت'}، RSI ${rr}، ${gap >= 0 ? '' : '−'}${pctTxt(Math.abs(gap))} ${gap >= 0 ? 'بالای' : 'زیر'} میانگین ۹۰ روزه.`;
  if (score >= 3) return { tilt: 1.4, tag: 'خرید قوی', tone: 'g', score, note: why };
  if (score >= 1) return { tilt: 1.2, tag: 'خرید', tone: 'g', score, note: why };
  if (score <= -2) return { tilt: 0.7, tag: 'داغ؛ صبر', tone: 'r', score, note: why };
  if (score <= -1) return { tilt: 0.85, tag: 'گران‌تر از معمول', tone: 'o', score, note: why };
  return { tilt: 1, tag: 'عادی', tone: '', score, note: why };
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
