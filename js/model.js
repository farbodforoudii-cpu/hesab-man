import { norm } from './format.js';

// Transaction types. `dir` is the money direction in the bank account.
export const TYPES = {
  income_work: { dir: 'in', label: 'درآمد' },
  family:      { dir: 'in', label: 'از خانواده' },
  sale:        { dir: 'in', label: 'فروش' },
  reimburse:   { dir: 'in', label: 'پس گرفتن پول' },
  loan_in:     { dir: 'in', label: 'وام' },
  fund_payout: { dir: 'in', label: 'از صندوق' },
  transfer_in: { dir: 'in', label: 'جابه‌جایی' },
  other_in:    { dir: 'in', label: 'سایر' },
  expense:     { dir: 'out', label: 'خرج' },
  asset:       { dir: 'out', label: 'پس‌انداز' },
  inventory:   { dir: 'out', label: 'خرید برای فروش' },
  on_behalf:   { dir: 'out', label: 'پرداخت برای دیگران' },
  loan_pay:    { dir: 'out', label: 'قسط' },
  fund_pay:    { dir: 'out', label: 'صندوق' },
  transfer_out:{ dir: 'out', label: 'جابه‌جایی' },
};

export const typesFor = dir => Object.keys(TYPES).filter(k => TYPES[k].dir === dir);
// The two everyday types per direction; the rest sit behind «بیشتر».
export const MAIN_TYPES = { in: ['income_work', 'family'], out: ['expense', 'asset'] };

export const CATEGORIES = {
  food:      { label: 'غذا', color: '#ff9500' },
  personal:  { label: 'شخصی', color: '#af52de' },
  home:      { label: 'خانه', color: '#34c759' },
  car:       { label: 'ماشین', color: '#007aff' },
  weekend:   { label: 'تفریح و سفر', color: '#ff2d55' },
  digital:   { label: 'اشتراک‌ها', color: '#5ac8fa' },
  health:    { label: 'سلامت و ورزش', color: '#30b0c7' },
  education: { label: 'آموزش', color: '#a2845e' },
  gift:      { label: 'هدیه', color: '#ff3b30' },
  habits:    { label: 'دخانیات', color: '#8e8e93' },
  other:     { label: 'سایر', color: '#c7c7cc' },
  fees:      { label: 'کارمزد', color: '#d1d1d6' },
  uncat:     { label: 'بدون دسته', color: '#e5e5ea' },
};
export const PICKABLE_CATS = ['food', 'personal', 'home', 'car', 'weekend', 'digital', 'health', 'education', 'gift', 'habits', 'other'];

export const CONTEXTS = {
  personal:   'شخصی',
  coaching:   'کوچینگ',
  jewelry:    'جواهرسازی',
  supplement: 'مکمل',
  seenzhin:   'Seenzhin',
};

// Keyword rules used when there is no history for a description.
const TYPE_RULES = [
  [/dollar|دلار|یورو|euro|silver|نقره|طلا|gold|سکه|coin|bike|دوچرخه|کریپتو|crypto/, { out: 'asset' }],
  [/وام|vam|قسط|loan/, { out: 'loan_pay', in: 'loan_in' }],
  [/صندوق/, { out: 'fund_pay', in: 'fund_payout' }],
  [/supp|مکمل|amino/, { out: 'inventory', in: 'sale', ctx: 'supplement' }],
  [/seenzhin|seen zhin|سینژین|سین ژین/, { out: 'on_behalf', in: 'reimburse', ctx: 'seenzhin' }],
  [/مامان|بابا|مادر|پدر|عیدی|eydi/, { in: 'family' }],
  [/جابجایی|جابه جایی|انتقال/, { out: 'transfer_out', in: 'transfer_in' }],
];

const CAT_RULES = [
  [/سوپر|نان|نانوایی|میوه|غذا|ناهار|نهار|شام|صبحانه|کافه|قهوه|رستوران|food|اسنپ ?فود|فست|پیتزا/, 'food'],
  [/بنزین|کارواش|تعمیر ماشین|ماشین|car|پارکینگ|عوارض/, 'car'],
  [/خانه|اجاره|قبض برق|قبض گاز|آب|home|لوازم خانه|شارژ ساختمان/, 'home'],
  [/vpn|chatgpt|gpt|ai |^ai$|ai plan|اینترنت|internet|اشتراک|قبض موبایل|شارژ موبایل|سیم ?کارت|apple|icloud/, 'digital'],
  [/دندان|dentis|فیزیو|physio|ماساژ|massage|دکتر|دارو|داروخانه|باشگاه|بوکس|box|ورزش|پزشک/, 'health'],
  [/کلاس|class|دانشگاه|university|نجاری|دوره|کتاب|آموزش/, 'education'],
  [/هدیه|gift|تولد|anniversary|سالگرد|گل|کادو/, 'gift'],
  [/سیگار|cigarette|ویپ|vape|weed|drink|نوشیدنی/, 'habits'],
  [/سفر|travel|هتل|اقامت|بلیط|weekend|تفریح|سینما/, 'weekend'],
  [/لباس|clothes|کفش|کیف|bag|آرایشگاه|personal|عطر/, 'personal'],
];

export function inferFromText(text, dir) {
  const t = norm(text);
  const out = { type: dir === 'in' ? null : 'expense', cat: null, ctx: 'personal' };
  if (!t) return out;
  for (const [re, r] of TYPE_RULES) {
    if (re.test(t) && r[dir]) {
      out.type = r[dir];
      if (r.ctx) out.ctx = r.ctx;
      break;
    }
  }
  if (out.type === 'expense') {
    for (const [re, c] of CAT_RULES) if (re.test(t)) { out.cat = c; break; }
  }
  return out;
}

export function isRealExpense(tx) { return tx.type === 'expense'; }

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
