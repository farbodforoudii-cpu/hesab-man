"""Fetch live Iranian market prices (toman) and a year of daily closes; write data/prices.json.
Runs in GitHub Actions (the phone cannot read tgju directly: no CORS). Sources: tgju.org, alanchand as fallback."""
import json, re, time, urllib.request, urllib.parse, datetime

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

# World drivers of Tehran's prices: last value, % move on the previous close, and 30 daily closes.
# Read by the Iran outlook; the app does not use them yet. Yahoo's chart data first, stooq's CSV as fallback
# (both keyless; gold, silver, dollar index and Brent are front-month futures on Yahoo).
DRIVERS = {'gold': ('GC=F', 'xauusd'), 'silver': ('SI=F', 'xagusd'), 'dxy': ('DX-Y.NYB', 'dx.f'),
           'brent': ('BZ=F', 'cb.f'), 'eurusd': ('EURUSD=X', 'eurusd'), 'us10y': ('^TNX', '10usy.b')}

def summary(rows, src):
    if len(rows) < 2:
        raise ValueError('no data')
    return {'p': rows[-1][1], 'dp': round((rows[-1][1] / rows[-2][1] - 1) * 100, 2), 'd': rows[-1][0], 'src': src, 'hist': rows[-30:]}

def yahoo(sym):
    r = json.loads(get(f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=2mo&interval=1d', 20))['chart']['result'][0]
    day = lambda t: datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')
    rows = [[day(t), round(c, 4)] for t, c in zip(r['timestamp'], r['indicators']['quote'][0]['close']) if c is not None]
    return summary(rows, 'yahoo')

def stooq(sym):
    text = get(f'https://stooq.com/q/d/l/?s={sym}&i=d', 20)
    rows = [r.split(',') for r in text.strip().splitlines()[1:]]
    rows = [[r[0], float(r[4])] for r in rows if len(r) >= 5 and r[4] not in ('', 'N/D')]
    if len(rows) < 2:
        raise ValueError('no data: ' + text[:60])
    return summary(rows, 'stooq')

out['drivers'] = {}
for k, (ysym, ssym) in DRIVERS.items():
    errs = []
    for fetch, sym in ((yahoo, ysym), (stooq, ssym)):
        try:
            out['drivers'][k] = fetch(sym)
            break
        except Exception as e:
            errs.append(f'{fetch.__name__}: {e}'[:120])
    else:
        out.setdefault('driversErr', {})[k] = errs
# tgju's world ounce prices stay first; the drivers fill them in when tgju fails.
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
