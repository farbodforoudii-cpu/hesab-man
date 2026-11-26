# Parse a Blu statement xlsx into rows (toman); names are masked.
import openpyxl, warnings, json, re, sys
warnings.filterwarnings('ignore')
ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
T = []
for r in ws.iter_rows(values_only=True):
    if not r or not isinstance(r[1], (int, float)) or not isinstance(r[17], str) or not re.match(r'\d{4}/', r[17]): continue
    d = str(r[10] or '')
    kind = 'NAME' if 'بنام' in d else None
    if not kind:
        m = re.search(r'(پایانه فروش|اینترنت)\s+\d+\s+(\S+\s+\S+)', d)
        kind = ('POS ' if m and 'پایانه' in m.group(1) else 'NET ') + m.group(2) if m else re.sub(r'\d{6,}', '#', d)[:70]
    T.append(dict(bal=r[1] / 10, out=(r[2] or 0) / 10, inn=(r[3] or 0) / 10, typ=r[6], kind=kind, dt=r[17]))
T.sort(key=lambda t: t['dt'])
json.dump(T, open(sys.argv[2], 'w'), ensure_ascii=False)
print(len(T), T[0]['dt'], T[-1]['dt'])
