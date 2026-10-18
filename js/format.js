import { faDigits } from './jalali.js';

const ONES = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
const TEENS = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
const TENS = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
const HUNDREDS = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
const SCALES = ['', 'هزار', 'میلیون', 'میلیارد', 'هزار میلیارد'];

function threeDigits(n) {
  const parts = [];
  const h = Math.floor(n / 100), rest = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rest >= 10 && rest < 20) parts.push(TEENS[rest - 10]);
  else {
    const t = Math.floor(rest / 10), o = rest % 10;
    if (t) parts.push(TENS[t]);
    if (o) parts.push(ONES[o]);
  }
  return parts.join(' و ');
}

export function numberToWords(n) {
  n = Math.round(Math.abs(n));
  if (n === 0) return 'صفر';
  const groups = [];
  let i = 0;
  while (n > 0 && i < SCALES.length) {
    const g = n % 1000;
    if (g) groups.unshift(threeDigits(g) + (SCALES[i] ? ' ' + SCALES[i] : ''));
    n = Math.floor(n / 1000);
    i++;
  }
  return groups.join(' و ');
}

export function tomanWords(n) {
  return n ? `${numberToWords(n)} تومان` : '';
}

export function fmt(n) {
  return faDigits(Math.round(n).toLocaleString('en-US'));
}

// Compact: 28,000,000 -> "۲۸ م" ; 1,250,000 -> "۱٫۳ م" ; 850,000 -> "۸۵۰ ه"
export function fmtShort(n) {
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  if (a >= 1e9) return sign + faDigits(trim(a / 1e9)) + ' میلیارد';
  if (a >= 1e6) return sign + faDigits(trim(a / 1e6)) + ' میلیون';
  if (a >= 1e3) return sign + faDigits(Math.round(a / 1e3)) + ' هزار';
  return sign + faDigits(Math.round(a));
}

function trim(x) {
  return x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10).replace('.', '٫');
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Normalize Persian/Arabic text for matching
export function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[‌‏‎]/g, ' ')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
