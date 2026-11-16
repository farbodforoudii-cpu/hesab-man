// Blu SMS drop box. An iPhone Shortcut posts each Blu SMS here as {k: drop key, t: message text}.
// The drop key only adds SMS: the app stores its SHA-256 as a 'dropkey' record in its own sync space,
// and this function finds the space by that hash. Only direction, amount, balance, date and time are
// kept (amounts in toman); the message text itself is never stored.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
const digits = (s: string) => s.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٬/g, ',');
const num = (s?: string) => (s == null ? null : Number(s.replace(/,/g, '')));

export function parse(text: string) {
  const t = digits(text);
  const dir = /واریز/.test(t) ? 'in' : /برداشت/.test(t) ? 'out' : null;
  const a = t.match(/([0-9][0-9,]*)\s*ریال/);
  if (!dir || !a) return null;
  const b = t.match(/موجودی\s*:?\s*(-?[0-9][0-9,]*)/);
  const tm = t.match(/([0-9]{1,2}):([0-9]{2})/);
  const dt = t.match(/(1[34][0-9]{2})[./-]([0-9]{1,2})[./-]([0-9]{1,2})/);
  return {
    dir,
    amount: num(a[1])! / 10,
    bal: b ? num(b[1])! / 10 : null,
    time: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null,
    date: dt ? `${dt[1]}-${dt[2].padStart(2, '0')}-${dt[3].padStart(2, '0')}` : null,
  };
}

const out = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  if (req.method !== 'POST') return out(405, { error: 'POST only' });
  let k = '', t = '';
  try { const j = await req.json(); k = String(j.k || ''); t = String(j.t || ''); } catch { return out(400, { error: 'bad body' }); }
  if (k.length < 24 || !t || t.length > 2000) return out(400, { error: 'bad input' });
  const h = await hex(k);
  const q = await fetch(`${URL_}/rest/v1/eco_items?kind=eq.dropkey&data->value->>hash=eq.${h}&select=space_id,app&limit=1`, { headers: H });
  const rows = await q.json();
  if (!q.ok || !rows.length) return out(403, { error: 'unknown key' });
  const { space_id, app } = rows[0];
  const p = parse(t);
  if (!p) return out(200, { ok: true, skipped: true });
  const id = (await hex(`${p.dir}|${p.amount}|${p.bal}|${p.date}|${p.time}`)).slice(0, 20);
  const now = new Date().toISOString();
  const rec = { id: `h:sms:${id}`, kind: 'sms', key: id, app, updatedAt: now, value: { id, ...p, got: now } };
  const ins = await fetch(`${URL_}/rest/v1/eco_items?on_conflict=space_id,id`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ space_id, id: rec.id, app, kind: 'sms', data: rec }),
  });
  if (!ins.ok) return out(500, { error: 'store failed' });
  return out(200, { ok: true, amount: p.amount, dir: p.dir });
});
