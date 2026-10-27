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
  const M = await res.json();
  // Iran's economic and political picture, written by hand after reading the news (no sources shown in the app).
  try { const r = await fetch('data/macro.json', { cache: 'no-store' }); if (r.ok) M.macro = await r.json(); } catch {}
  return M;
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

export function emaSeries(h, n) {
  const k = 2 / (n + 1), out = [];
  h.forEach(([d, v], i) => out.push([d, i ? v * k + out[i - 1][1] * (1 - k) : v]));
  return out;
}
const mid = (c, n, off = 0) => { const a = c.slice(Math.max(0, c.length - n - off), c.length - off); return (Math.max(...a) + Math.min(...a)) / 2; };

// Turning points of the last 120 days: a day that is the highest (or lowest) of the 11 days around it.
function levels(c, last) {
  const w = c.slice(-120), hi = [], lo = [];
  for (let i = 5; i < w.length - 5; i++) {
    const win = w.slice(i - 5, i + 6);
    if (w[i] === Math.max(...win)) hi.push(w[i]);
    if (w[i] === Math.min(...win)) lo.push(w[i]);
  }
  const piv = [...hi, ...lo];
  return { sup: piv.filter(p => p < last).sort((a, b) => b - a).slice(0, 2), res: piv.filter(p => p > last).sort((a, b) => a - b).slice(0, 2), top: Math.max(...w) };
}

// Everything the signal reads, from daily closing prices.
export function stats(M, k) {
  const h = (M && M.hist && M.hist[k]) || [], now = M && M.now && M.now[k];
  const last = now ? now.p : h.length ? h[h.length - 1][1] : null;
  if (!last) return null;
  const c = h.map(r => r[1]);
  if (now && h.length && now.ts.slice(0, 10) > h[h.length - 1][0]) c.push(last); else if (c.length) c[c.length - 1] = last;
  const back = n => (c.length > n ? c[c.length - 1 - n] : null);
  const ma = n => avgOf(c.slice(-n));
  const ma20 = ma(20), ma90 = ma(90), r = rsiSeries(h);
  const e = n => { let v = c[0]; const q = 2 / (n + 1); for (const x of c) v = x * q + v * (1 - q); return v; };
  const e12 = emaSeries(c.map((v, i) => [i, v]), 12), e26 = emaSeries(c.map((v, i) => [i, v]), 26);
  const macdL = e12.map((x, i) => [i, x[1] - e26[i][1]]), sigL = emaSeries(macdL, 9), hist = macdL.map((x, i) => x[1] - sigL[i][1]);
  const enough = c.length >= 80;
  // Ichimoku (9, 26, 52) on closes: today's cloud was drawn 26 days ago.
  const ichi = enough ? { ten: mid(c, 9), kij: mid(c, 26), a: (mid(c, 9, 26) + mid(c, 26, 26)) / 2, b: mid(c, 52, 26), lag: c[c.length - 27] } : null;
  return { k, last, day: now ? now.dp / 100 : null, w: pctOf(last, back(7)), m: pctOf(last, back(30)), y: pctOf(last, back(250)),
    ma20, ma90, pos: pctOf(last, ma90), trend: ma20 && ma90 ? (ma20 > ma90 * 1.01 ? 1 : ma20 < ma90 * 0.99 ? -1 : 0) : 0, rsi: r.length ? r[r.length - 1][1] : null,
    e20: e(20), e50: e(50), e200: e(200), macd: { m: macdL[macdL.length - 1][1], s: sigL[sigL.length - 1][1], h: hist[hist.length - 1], hPrev: hist[hist.length - 4] },
    ichi, lv: levels(c, last) };
}

// Six readings, each −1, 0 or +1; Iran's conditions count double.
//  Ichimoku  above the cloud with Tenkan over Kijun = +1, below the cloud with Tenkan under Kijun = −1;
//  EMA       price over EMA 50 over EMA 200 = +1, price under EMA 20 under EMA 50 = −1;
//  levels    within 3% over a support = +1, within 3% under a resistance or at the 120-day top = −1;
//  RSI 14    under 40 = +1, over 68 = −1;
//  MACD      over its signal line and widening = +1, under it and widening = −1;
//  Iran      the hand-written outlook in data/macro.json (×2; ignored after 30 days).
// Trend (Ichimoku, EMA, Iran) decides whether to buy at all; timing (levels, RSI, MACD) decides when.
export const MACRO_DAYS = 30;
export function signal(s, macro) {
  if (!s || !s.ichi) return { tilt: 1, tag: '', note: '', score: 0, checks: [] };
  const { last, ichi: I, e20, e50, e200, rsi, macd, lv } = s, top = Math.max(I.a, I.b), bot = Math.min(I.a, I.b);
  const ck = [];
  ck.push({ n: 'ایچیموکو', v: last > top && I.ten > I.kij ? 1 : last < bot && I.ten < I.kij ? -1 : 0,
    r: last > top ? (I.ten > I.kij ? 'بالای ابر، صعودی' : 'بالای ابر، کند شده') : last < bot ? 'زیر ابر، نزولی' : 'داخل ابر، بی‌جهت' });
  ck.push({ n: 'EMA ۲۰، ۵۰، ۲۰۰', v: last > e50 && e50 > e200 ? 1 : last < e20 && e20 < e50 ? -1 : 0,
    r: last > e20 && e20 > e50 && e50 > e200 ? 'بالای هر سه' : last > e50 && e50 > e200 ? 'بالای ۵۰ و ۲۰۰' : last < e20 && e20 < e50 ? 'زیر ۲۰ و ۵۰' : 'درهم' });
  // Within 3% of a level counts as near it; with both near, the closer one wins.
  const sup = lv.sup[0], res = lv.res[0], dS = sup ? last / sup - 1 : 1, dR = res ? res / last - 1 : last >= lv.top * .98 ? 0 : 1;
  const nearS = dS <= .03 && dS <= dR, nearR = dR <= .03 && dR < dS;
  ck.push({ n: 'حمایت و مقاومت', v: nearS ? 1 : nearR ? -1 : 0,
    r: !res && last >= lv.top * .98 ? 'نزدیک سقف تاریخی' : nearR ? 'نزدیک مقاومت' : nearS ? 'نزدیک حمایت' : 'میان دو سطح' });
  ck.push({ n: 'RSI ۱۴', v: rsi < 40 ? 1 : rsi > 68 ? -1 : 0, r: `${fa(Math.round(rsi))}؛ ${rsi > 68 ? 'داغ' : rsi > 60 ? 'نزدیک داغ' : rsi < 35 ? 'فروش زیاد' : rsi < 45 ? 'ضعیف' : 'عادی'}` });
  const wid = Math.abs(macd.h) > Math.abs(macd.hPrev);
  ck.push({ n: 'MACD', v: macd.h > 0 && wid ? 1 : macd.h < 0 && wid ? -1 : 0,
    r: macd.h > 0 ? (wid ? 'شتاب رو به بالا' : 'مثبت، کند شده') : wid ? (macd.m > 0 ? 'مثبت، شتاب کم می‌شود' : 'منفی، رو به پایین') : (macd.m > 0 ? 'مثبت، شتاب کم می‌شود' : 'منفی، کند شده') });
  const fresh = macro && macro.at && (Date.now() - new Date(macro.at)) / 864e5 <= MACRO_DAYS, mv = fresh && macro.bias ? macro.bias[s.k] || 0 : 0;
  ck.push({ n: 'شرایط ایران', v: mv, w: 2, r: fresh ? (macro.why && macro.why[s.k]) || '' : 'به‌روز نیست' });
  const trend = ck[0].v + ck[1].v + mv * 2, timing = ck[2].v + ck[3].v + ck[4].v, score = trend + timing;
  // Where to buy: in an uptrend between the first support under EMA 20 and EMA 20; otherwise the level to wait for.
  const zLo = [...lv.sup].find(x => x < e20) || e20 * .98, zone = [zLo, e20];
  // mode: what the card says next — 'now', 'dip' (buy zone), 'in' (already in the zone), 'sup' (near support), 'wait'.
  let tag, tone, tilt, mode;
  if (trend >= 2 && timing >= 1) { tag = 'خرید'; tone = 'g'; tilt = 1.3; mode = 'now'; }
  else if (trend >= 2) { tag = 'صعودی؛ روی اصلاح'; tone = 'g'; tilt = 1; mode = last > zone[1] ? 'dip' : 'in'; }
  else if (trend >= 0 && timing >= 1) { tag = 'خرید نزدیک حمایت'; tone = ''; tilt = 1; mode = 'sup'; }
  else if (trend >= 0) { tag = 'خنثی'; tone = ''; tilt = .85; mode = 'sup'; }
  else { tag = 'صبر'; tone = 'r'; tilt = .5; mode = 'wait'; }
  return { tag, tone, tilt, score, trend, timing, mode, zone, sup: lv.sup, wait: [bot, e50], checks: ck,
    note: `${tag}؛ ${ck.filter(x => x.v).map(x => `${x.n} ${x.v > 0 ? '+' : '−'}`).join('، ') || 'نشانه‌ها خنثی'}.` };
}
const fa = n => n.toLocaleString('fa-IR');

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
    sig[k] = signal(S[k], M && M.macro);
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
