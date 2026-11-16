-- Bank SMS drop box: an iPhone Shortcut posts each Blu SMS here with a write-only key.
-- Only amount, direction, balance, date and time are kept; the raw text is never stored.
create table if not exists public.eco_drop_keys (
  key_hash text primary key,
  space_id uuid not null references public.eco_spaces(id) on delete cascade,
  app text not null,
  created_at timestamptz not null default now()
);
alter table public.eco_drop_keys enable row level security;
revoke all on public.eco_drop_keys from anon, authenticated;

create or replace function public.eco_drop_key(p_key text, p_drop text, p_app text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare s uuid := public.eco_space(p_key);
begin
  if s is null then raise exception 'unknown sync key'; end if;
  if p_drop is null or length(p_drop) < 24 then raise exception 'drop key too short'; end if;
  delete from public.eco_drop_keys where space_id = s and app = p_app;
  insert into public.eco_drop_keys (key_hash, space_id, app)
  values (encode(sha256(convert_to(p_drop, 'UTF8')), 'hex'), s, p_app);
  return true;
end $$;

create or replace function public.eco_drop_sms(p_drop text, p_text text)
returns text language plpgsql security definer set search_path = '' as $$
declare k record; t text; dir text; amt numeric; bal numeric; tm text; dt text; m text[]; rid text; now_s text;
begin
  select d.space_id, d.app into k from public.eco_drop_keys d
  where d.key_hash = encode(sha256(convert_to(coalesce(p_drop, ''), 'UTF8')), 'hex');
  if k.space_id is null then raise exception 'unknown drop key'; end if;
  if p_text is null or length(p_text) > 2000 then raise exception 'bad text'; end if;
  t := translate(p_text, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩٬', '01234567890123456789,');
  if t ~ 'واریز' then dir := 'in'; elsif t ~ 'برداشت' then dir := 'out'; else return 'skip'; end if;
  m := regexp_match(t, '([0-9][0-9,]*)\s*ریال');
  if m is null then return 'skip'; end if;
  amt := replace(m[1], ',', '')::numeric;
  m := regexp_match(t, 'موجودی\s*:?\s*(-?[0-9][0-9,]*)');
  bal := case when m is null then null else replace(m[1], ',', '')::numeric end;
  m := regexp_match(t, '([0-9]{1,2}):([0-9]{2})');
  tm := case when m is null then null else lpad(m[1], 2, '0') || ':' || m[2] end;
  m := regexp_match(t, '(1[34][0-9]{2})[./-]([0-9]{1,2})[./-]([0-9]{1,2})');
  dt := case when m is null then null else m[1] || '-' || lpad(m[2], 2, '0') || '-' || lpad(m[3], 2, '0') end;
  rid := 'h:sms:' || substr(encode(sha256(convert_to(dir || amt || coalesce(bal::text, '') || coalesce(dt, '') || coalesce(tm, ''), 'UTF8')), 'hex'), 1, 20);
  now_s := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  insert into public.eco_items (space_id, id, app, kind, data)
  values (k.space_id, rid, k.app, 'sms', jsonb_build_object('id', rid, 'kind', 'sms', 'key', substr(rid, 7), 'app', k.app, 'updatedAt', now_s,
    'value', jsonb_build_object('id', substr(rid, 7), 'dir', dir, 'amount', amt / 10, 'bal', bal / 10, 'date', dt, 'time', tm, 'got', now_s)))
  on conflict (space_id, id) do nothing;
  return 'ok';
end $$;

revoke all on function public.eco_drop_key(text, text, text) from public;
revoke all on function public.eco_drop_sms(text, text) from public;
grant execute on function public.eco_drop_key(text, text, text) to anon, authenticated;
grant execute on function public.eco_drop_sms(text, text) to anon, authenticated;
