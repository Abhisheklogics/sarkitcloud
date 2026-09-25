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
  write_api_key text not null unique,
  read_api_key text not null unique,
  min_interval_seconds integer not null default 15,
  created_at timestamptz not null default now()
);

create table feeds (
  id bigserial primary key,
  channel_id bigint not null references channels(id) on delete cascade,
  field1 numeric,
  field2 numeric,
  field3 numeric,
  field4 numeric,
  field5 numeric,
  field6 numeric,
  field7 numeric,
  field8 numeric,
  created_at timestamptz not null default now()
);

create index feeds_channel_created_idx on feeds(channel_id, created_at desc);

alter table channels enable row level security;
alter table feeds enable row level security;

create policy "public read channels" on channels
  for select using (true);

create policy "public insert channels" on channels
  for insert with check (true);

create policy "public delete channels" on channels
  for delete using (true);

create policy "public read feeds" on feeds
  for select using (true);

create policy "public insert feeds" on feeds
  for insert with check (true);

create policy "public delete feeds" on feeds
  for delete using (true);
