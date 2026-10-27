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
except Exception as e:
    out['err'] = str(e)

for k, key in KEYS.items():
    try:
        d = json.loads(get(f'https://api.tgju.org/v1/market/indicator/summary-table-data/{key}?lang=fa&order_dir=desc&draw=1&start=0&length=400', 60))['data']
        # row: open, low, high, close, change, change %, gregorian date, jalali date
        out['hist'][k] = [[r[6].replace('/', '-'), round(num(r[3]))] for r in reversed(d)]
    except Exception as e:
        out.setdefault('histErr', {})[k] = str(e)

# Keep the previous file's values for anything that failed this time.
try:
    old = json.load(open('data/prices.json'))
    for k in KEYS:
        out['now'].setdefault(k, old.get('now', {}).get(k))
        out['hist'].setdefault(k, old.get('hist', {}).get(k, []))
except Exception:
    pass
if not any(out['now'].values()):
    raise SystemExit('no prices')
json.dump(out, open('data/prices.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print({k: v and v['p'] for k, v in out['now'].items()}, {k: len(v) for k, v in out['hist'].items()})
