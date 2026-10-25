// Jalali (Shamsi) calendar conversion, based on the jalaali-js algorithm.
const div = (a, b) => ~~(a / b);
const mod = (a, b) => a - ~~(a / b) * b;
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

function jalCal(jy) {
  const gy = jy + 621;
  let leapJ = -14, jp = BREAKS[0], jump = 0;
  for (let i = 1; i < BREAKS.length; i++) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  return d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn) {
  const g = d2g(jdn);
  let jy = g.gy - 621;
  const r = jalCal(jy);
  let k = jdn - g2d(g.gy, 3, r.march);
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function toJalali(date) {
  return d2j(g2d(date.getFullYear(), date.getMonth() + 1, date.getDate()));
}

export function fromJalali(jy, jm, jd, h = 0, mi = 0, s = 0) {
  const g = d2g(j2d(jy, jm, jd));
  return new Date(g.gy, g.gm - 1, g.gd, h, mi, s);
}

export function monthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return jalCal(jy).leap === 0 ? 30 : 29;
}

export const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
export const WEEKDAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

// "1405/07/26 22:15:14" -> Date
export function parseJalaliString(str) {
  const m = String(str).trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return fromJalali(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

// Key of the Jalali month a date falls in, e.g. "1405-07"
export function monthKey(date) {
  const j = toJalali(date);
  return `${j.jy}-${String(j.jm).padStart(2, '0')}`;
}

export function monthRange(key) {
  const [jy, jm] = key.split('-').map(Number);
  const start = fromJalali(jy, jm, 1);
  const next = jm === 12 ? fromJalali(jy + 1, 1, 1) : fromJalali(jy, jm + 1, 1);
  return { start, end: next };
}

export function shiftMonth(key, delta) {
  let [jy, jm] = key.split('-').map(Number);
  jm += delta;
  while (jm > 12) { jm -= 12; jy++; }
  while (jm < 1) { jm += 12; jy--; }
  return `${jy}-${String(jm).padStart(2, '0')}`;
}

export function monthLabel(key) {
  const [jy, jm] = key.split('-').map(Number);
  return `${MONTHS[jm - 1]} ${faDigits(jy)}`;
}

export function faDigits(v) {
  return String(v).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

export function formatJalali(date, withTime = false) {
  const j = toJalali(date);
  let s = `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`;
  if (withTime) s += ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return faDigits(s);
}

export function dayLabel(date, now = new Date()) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((b - a) / 86400000);
  const j = toJalali(date);
  const base = `${WEEKDAYS[date.getDay()]} ${faDigits(j.jd)} ${MONTHS[j.jm - 1]}`;
  if (diff === 0) return `امروز، ${base}`;
  if (diff === 1) return `دیروز، ${base}`;
  return base;
}
