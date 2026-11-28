// Screenshots of the summary and assets tabs: phone and iPad, glass and dark, with a fresh start (made-up balance).
// Run: python3 -m http.server 8781 (in the repo), then TAG=before|after node tests/e2e/shots.mjs
import { createRequire } from 'module'; const { chromium } = createRequire(import.meta.url)('playwright');
const TAG = process.env.TAG || 'now', OUT = process.env.OUT || '/tmp/hesab-shots/', URL = process.env.URL || 'http://localhost:8781/';
(await import('fs')).mkdirSync(OUT, { recursive: true });
const b = await chromium.launch(), errs = [];
for (const [dev, vp] of [['phone', { width: 390, height: 844 }], ['ipad', { width: 1024, height: 1366 }]]) for (const theme of ['glass', 'dark']) {
  const ctx = await b.newContext({ viewport: vp, serviceWorkers: 'block', deviceScaleFactor: 2 });
  await ctx.route('https://*.supabase.co/**', r => r.fulfill({ status: 404, body: '{}' }));
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text())); p.on('dialog', d => d.accept());
  await p.goto(URL); await p.evaluate(t => localStorage.setItem('theme', t), theme); await p.reload(); await p.waitForTimeout(800);
  await p.fill('#start-bal', '45000000'); await p.click('[data-act="start"]'); await p.waitForTimeout(1000);
  await p.click('[data-act="tab"][data-v="dash"]').catch(() => {}); await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}${TAG}-${dev}-${theme}-dash.png` });
  const cut = await p.evaluate(() => [...document.querySelectorAll('.ticker > span')].filter(e => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).length);
  await p.locator('#tabs button').nth(2).click(); await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}${TAG}-${dev}-${theme}-assets.png` });
  console.log(dev, theme, 'ticker lines cut:', cut);
  await ctx.close();
}
console.log('errors', errs); await b.close();
