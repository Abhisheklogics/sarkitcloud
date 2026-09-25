create table channels (
  id bigserial primary key,
  name text not null,
  description text default '',
  field1 text,
  field2 text,
  field3 text,
  field4 text,
  field5 text,
  field6 text,
  field7 text,
  field8 text,
  field9 text,
  field10 text,
  field11 text,
  field12 text,
  field13 text,
  field14 text,
  field15 text,
  field16 text,
  field17 text,
  field18 text,
  field19 text,
  field20 text,
  write_api_key text not null unique,
  read_api_key text not null unique,
  min_interval_seconds integer not null default 1,
  created_at timestamptz not null default now()
);

create table feeds (
  id bigserial primary key,
  channel_id bigint not null references channels(id) on delete cascade,
  device_id text not null default 'default',
  field1 numeric,
  field2 numeric,
  field3 numeric,
  field4 numeric,
  field5 numeric,
  field6 numeric,
  field7 numeric,
  field8 numeric,
  field9 numeric,
  field10 numeric,
  field11 numeric,
  field12 numeric,
  field13 numeric,
  field14 numeric,
  field15 numeric,
  field16 numeric,
  field17 numeric,
  field18 numeric,
  field19 numeric,
  field20 numeric,
  created_at timestamptz not null default now()
);

create table devices (
  id bigint generated always as identity primary key,
  channel_id bigint not null references channels(id) on delete cascade,
  device_id text not null,
  name text,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  unique(channel_id, device_id)
);

create index feeds_channel_created_idx on feeds(channel_id, created_at desc);
create index feeds_device_idx on feeds(channel_id, device_id);
create index devices_channel_idx on devices(channel_id);

alter table channels enable row level security;
alter table feeds enable row level security;
alter table devices enable row level security;

create policy "service role full access channels" on channels for all using (true) with check (true);
create policy "service role full access feeds" on feeds for all using (true) with check (true);
create policy "service role full access devices" on devices for all using (true) with check (true);

create extension if not exists pg_cron;

select cron.schedule(
  'sarkited-feeds-retention',
  '30 3 * * *',
  $$delete from public.feeds where created_at < now() - interval '180 days'$$
);
