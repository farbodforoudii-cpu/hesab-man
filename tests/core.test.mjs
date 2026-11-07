// Checks for the parts of the app that compute money and dates. Run: TZ=Asia/Tehran node --test tests/*.test.mjs
// Pure modules only (no browser): calendar, number formatting, monthly sums, balance, market maths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toJalali, fromJalali, monthKey, monthRange, shiftMonth } from '../js/jalali.js';
import { fmtShort } from '../js/format.js';
import { summarize, balanceAt, monthSummary } from '../js/stats.js';
import { emaSeries, rsiSeries, liveHist, stats, signal } from '../js/market.js';

const strip = s => s.replace(/[⁦-⁩]/g, '');

test('calendar: every day of 1400–1410 survives Jalali → date → Jalali', () => {
  for (let y = 1400; y <= 1410; y++) for (let m = 1; m <= 12; m++) {
    const days = (new Date(fromJalali(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1)) - new Date(fromJalali(y, m, 1))) / 864e5;
    assert.ok(Math.round(days) >= 29 && Math.round(days) <= 31, `${y}/${m} has ${days} days`);
    for (let d = 1; d <= Math.round(days); d++) {
      const j = toJalali(fromJalali(y, m, d, 12));
      assert.deepEqual([j.jy, j.jm, j.jd], [y, m, d]);
    }
  }
});

test('calendar: known dates and month keys', () => {
  const j = toJalali(new Date('2026-10-23T08:00:00Z'));
  assert.deepEqual([j.jy, j.jm, j.jd], [1405, 8, 1]);
  assert.equal(monthKey(new Date('2026-10-23T08:00:00Z')), '1405-08');
  assert.equal(shiftMonth('1405-12', 1), '1406-01');
  assert.equal(shiftMonth('1405-01', -1), '1404-12');
  const { start, end } = monthRange('1405-08');
  assert.ok(start < end);
});

test('format: short amounts keep the number in one isolate', () => {
  const s = fmtShort(48300000);
  assert.match(strip(s), /۴۸٫۳ میلیون/);
  assert.equal((s.match(/⁦/g) || []).length, (s.match(/⁩/g) || []).length);
});

const T = (type, dir, amount, ts, extra = {}) => ({ id: Math.random().toString(36).slice(2), type, dir, amount, ts, status: 'ok', ...extra });

test('sums: only «expense» is living cost; moves, assets and help to others are not', () => {
  const s = summarize([
    T('income_work', 'in', 74e6, '2026-10-24T10:00:00Z'), T('family', 'in', 50e6, '2026-10-25T10:00:00Z'),
    T('transfer_in', 'in', 80e6, '2026-10-27T10:00:00Z'), T('transfer_out', 'out', 80e6, '2026-10-28T10:00:00Z'),
    T('expense', 'out', 22e6, '2026-10-25T10:00:00Z', { cat: 'gift' }), T('expense', 'out', 6100, '2026-10-25T10:00:00Z', { cat: 'fees' }),
    T('asset', 'out', 48.3e6, '2026-10-25T10:00:00Z'), T('on_behalf', 'out', 7.666e6, '2026-10-25T10:00:00Z'),
  ]);
  assert.equal(s.work, 74e6); assert.equal(s.family, 50e6);
  assert.equal(s.expense, 22006100); assert.equal(s.asset, 48.3e6); assert.equal(s.onBehalf, 7.666e6);
  assert.equal(s.in, 204e6); assert.equal(s.out, 22006100 + 48.3e6 + 7.666e6 + 80e6);
});

test('sums: a payment with an earlier period counts for that month', () => {
  const late = T('income_work', 'in', 36.5e6, '2026-10-24T16:00:00Z', { period: '1405-07' });
  assert.equal(monthSummary([late], '1405-07').work, 36.5e6);
  assert.equal(monthSummary([late], '1405-08').work, 0);
});

test('balance: opening balance plus everything after the opening date', () => {
  const st = { openingBalance: 51738748.5, openingDate: '2026-10-22T20:30:00.000Z' };
  const txs = [T('expense', 'out', 1e6, '2026-10-20T10:00:00Z'), T('family', 'in', 10e6, '2026-10-25T10:00:00Z'), T('expense', 'out', 2.5e6, '2026-10-26T10:00:00Z')];
  assert.equal(balanceAt(txs, st), 51738748.5 + 10e6 - 2.5e6);
});

const hist = (n, f) => Array.from({ length: n }, (_, i) => [new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10), f(i)]);

test('market: EMA of a flat price is the price; RSI of a rising price is 100', () => {
  assert.ok(emaSeries(hist(50, () => 100), 20).every(r => Math.abs(r[1] - 100) < 1e-9));
  const r = rsiSeries(hist(40, i => 100 + i));
  assert.equal(r.at(-1)[1], 100);
});

test('market: today\'s live price is the last point of the history', () => {
  const M = { hist: { usd: [['2026-11-03', 260000], ['2026-11-04', 265000]] }, now: { usd: { p: 266900, ts: '2026-11-05 14:00:00' } } };
  assert.deepEqual(liveHist(M, 'usd').at(-1), ['2026-11-05', 266900]);
  M.now.usd.ts = '2026-11-04 18:00:00';
  assert.deepEqual(liveHist(M, 'usd').at(-1), ['2026-11-04', 266900]);
});

test('market: premium of gold and silver over the world price', () => {
  const base = hist(120, () => 1);
  const M = { world: { ons: 4125.54, silver: 52.89 }, now: { usd: { p: 266900, ts: '2026-05-01' }, gold: { p: 26166500, ts: '2026-05-01' }, silver: { p: 487540, ts: '2026-05-01' } },
    hist: { usd: base.map(([d]) => [d, 266900]), gold: base.map(([d]) => [d, 26166500]), silver: base.map(([d]) => [d, 487540]) } };
  const g = stats(M, 'gold').prem, s = stats(M, 'silver').prem;
  assert.ok(Math.abs(g - (26166500 / (4125.54 / 31.1035 * 0.75 * 266900) - 1)) < 1e-12);
  assert.ok(g < 0 && g > -0.03, `gold premium ${g}`);
  assert.ok(s > 0.07 && s < 0.08, `silver premium ${s}`);
  assert.equal(stats(M, 'usd').prem, null);
});

test('market: a signal always gives a trend word and a buying word', () => {
  const M = { now: {}, hist: { usd: hist(300, i => 100000 + i * 300 + Math.sin(i / 3) * 2000) } };
  const sg = signal(stats(M, 'usd'), null);
  assert.ok(['صعودی', 'خنثی', 'نزولی'].includes(sg.trendW));
  assert.ok(['مناسب', 'معمولی', 'گران'].includes(sg.buyW));
  assert.ok(sg.checks.length >= 6);
});
