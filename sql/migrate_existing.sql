alter table channels
  add column if not exists field9 text,
  add column if not exists field10 text,
  add column if not exists field11 text,
  add column if not exists field12 text,
  add column if not exists field13 text,
  add column if not exists field14 text,
  add column if not exists field15 text,
  add column if not exists field16 text,
  add column if not exists field17 text,
  add column if not exists field18 text,
  add column if not exists field19 text,
  add column if not exists field20 text;

alter table channels alter column min_interval_seconds set default 1;

alter table feeds
  add column if not exists device_id text default 'default',
  add column if not exists field9 numeric,
  add column if not exists field10 numeric,
  add column if not exists field11 numeric,
  add column if not exists field12 numeric,
  add column if not exists field13 numeric,
  add column if not exists field14 numeric,
  add column if not exists field15 numeric,
  add column if not exists field16 numeric,
  add column if not exists field17 numeric,
  add column if not exists field18 numeric,
  add column if not exists field19 numeric,
  add column if not exists field20 numeric;

create table if not exists devices (
  id bigint generated always as identity primary key,
  channel_id bigint not null references channels(id) on delete cascade,
  device_id text not null,
  name text,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  unique(channel_id, device_id)
);

create index if not exists idx_feeds_channel_created on feeds(channel_id, created_at desc);
create index if not exists idx_feeds_device on feeds(channel_id, device_id);
create index if not exists idx_devices_channel on devices(channel_id);

alter table devices enable row level security;

drop policy if exists "public read devices" on devices;
drop policy if exists "public insert devices" on devices;
drop policy if exists "public update devices" on devices;
drop policy if exists "public delete devices" on devices;

create policy "service role full access devices" on devices for all using (true) with check (true);

drop policy if exists "public update channels" on channels;
drop policy if exists "public read channels" on channels;
drop policy if exists "public insert channels" on channels;
drop policy if exists "public delete channels" on channels;

create policy "service role full access channels" on channels for all using (true) with check (true);

drop policy if exists "public read feeds" on feeds;
drop policy if exists "public insert feeds" on feeds;
drop policy if exists "public delete feeds" on feeds;

create policy "service role full access feeds" on feeds for all using (true) with check (true);

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('sarkited-feeds-retention');
exception when others then
  null;
end $$;

select cron.schedule(
  'sarkited-feeds-retention',
  '30 3 * * *',
  $$delete from public.feeds where created_at < now() - interval '180 days'$$
);
