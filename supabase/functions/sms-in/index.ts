// Blu SMS drop box. An iPhone Shortcut posts each Blu SMS here as {k: drop key, t: message text}.
// The drop key only adds SMS: the app stores its SHA-256 as a 'dropkey' record in its own sync space,
// and this function finds the space by that hash. Only direction, amount, balance, date and time are
// kept (amounts in toman); the message text itself is never stored.
// Talks to Postgres directly (the API roles have no table rights here; access is through functions).
import postgres from 'npm:postgres@3.4.5';
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1 });

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
  if (k.length < 24 || t.length > 2000) return out(400, { error: 'bad input' });
  const h = await hex(k);
  const rows = await sql`select space_id, app from public.eco_items where kind = 'dropkey' and data->'value'->>'hash' = ${h} limit 1`;
  if (!rows.length) return out(403, { error: 'unknown key' });
  const { space_id, app } = rows[0];
  // Run by hand from the Shortcuts editor there is no message: just confirm the key works.
  if (!t.trim()) return out(200, { ok: true, test: true });
  const p = parse(t);
  if (!p) return out(200, { ok: true, skipped: true });
  const id = (await hex(`${p.dir}|${p.amount}|${p.bal}|${p.date}|${p.time}`)).slice(0, 20);
  const now = new Date().toISOString();
  const rec = { id: `h:sms:${id}`, kind: 'sms', key: id, app, updatedAt: now, value: { id, ...p, got: now } };
  await sql`insert into public.eco_items (space_id, id, app, kind, data) values (${space_id}, ${rec.id}, ${app}, 'sms', ${sql.json(rec)}) on conflict (space_id, id) do nothing`;
  return out(200, { ok: true, amount: p.amount, dir: p.dir });
});
