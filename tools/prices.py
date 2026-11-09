"""Fetch live Iranian market prices (toman) and a year of daily closes; write data/prices.json.
Runs in GitHub Actions (the phone cannot read tgju directly: no CORS). Sources: tgju.org, alanchand as fallback."""
import json, re, time, urllib.request, datetime

UA = {'User-Agent': 'Mozilla/5.0'}
KEYS = {'usd': 'price_dollar_rl', 'eur': 'price_eur', 'gold': 'geram18', 'silver': 'silver_999'}
num = lambda s: float(str(s).replace(',', '')) / 10  # rial -> toman

def get(url, timeout=40):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read().decode('utf-8')
        except Exception as e:
            err = e; time.sleep(3)
    raise err

out = {'at': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z', 'src': 'tgju.org', 'now': {}, 'hist': {}}
try:
    cur = json.loads(get('https://call1.tgju.org/ajax.json'))['current']
    for k, key in KEYS.items():
        c = cur[key]
        # dp is the size of today's move; dt gives its direction ('low' = down).
        out['now'][k] = {'p': round(num(c['p'])), 'dp': float(c.get('dp') or 0) * (-1 if c.get('dt') == 'low' else 1), 'ts': c.get('ts')}
    # World prices (US dollars per ounce) for the premium of Tehran's gold and silver over the global price.
    out['world'] = {w: float(str(cur[w]['p']).replace(',', '')) for w in ('ons', 'silver') if w in cur}
except Exception as e:
    out['err'] = str(e)

for k, key in KEYS.items():
    try:
        d = json.loads(get(f'https://api.tgju.org/v1/market/indicator/summary-table-data/{key}?lang=fa&order_dir=desc&draw=1&start=0&length=400', 60))['data']
        # row: open, low, high, close, change, change %, gregorian date, jalali date
        out['hist'][k] = [[r[6].replace('/', '-'), round(num(r[3]))] for r in reversed(d)]
    except Exception as e:
        out.setdefault('histErr', {})[k] = str(e)

# World drivers of Tehran's prices, from stooq daily closes (keyless CSV): last value, % move on the
# previous close, and 30 closes. Read by the Iran outlook; the app does not use them yet.
DRIVERS = {'gold': 'xauusd', 'silver': 'xagusd', 'dxy': 'dx.f', 'brent': 'cb.f', 'eurusd': 'eurusd', 'us10y': '10usy.b'}

def daily(sym):
    rows = [r.split(',') for r in get(f'https://stooq.com/q/d/l/?s={sym}&i=d', 20).strip().splitlines()[1:]]
    rows = [r for r in rows if len(r) >= 5 and r[4] not in ('', 'N/D')]
    if len(rows) < 2:
        raise ValueError('no data')
    c = [float(r[4]) for r in rows]
    return {'p': c[-1], 'dp': round((c[-1] / c[-2] - 1) * 100, 2), 'd': rows[-1][0], 'hist': [[r[0], float(r[4])] for r in rows[-30:]]}

out['drivers'] = {}
for k, sym in DRIVERS.items():
    try:
        out['drivers'][k] = daily(sym)
    except Exception as e:
        out.setdefault('driversErr', {})[k] = str(e)
# tgju's world ounce prices stay first; stooq fills them in when tgju fails.
for w, k in (('ons', 'gold'), ('silver', 'silver')):
    if w not in out.get('world', {}) and k in out['drivers']:
        out.setdefault('world', {})[w] = out['drivers'][k]['p']

# Keep the previous file's values for anything that failed this time.
try:
    old = json.load(open('data/prices.json'))
    for k in KEYS:
        out['now'].setdefault(k, old.get('now', {}).get(k))
        out['hist'].setdefault(k, old.get('hist', {}).get(k, []))
    if not out.get('world') and old.get('world'): out['world'] = old['world']
    for k in DRIVERS:
        if k not in out['drivers'] and k in old.get('drivers', {}): out['drivers'][k] = old['drivers'][k]
except Exception:
    pass
if not any(out['now'].values()):
    raise SystemExit('no prices')
json.dump(out, open('data/prices.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print({k: v and v['p'] for k, v in out['now'].items()}, {k: len(v) for k, v in out['hist'].items()},
      {k: (v['p'], v['dp']) for k, v in out['drivers'].items()}, out.get('driversErr', ''))
