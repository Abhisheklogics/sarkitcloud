begin;

create extension if not exists pgcrypto;

alter table public.channels add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.channels add column if not exists retention_days integer not null default 30;
alter table public.channels alter column admin_key drop not null;
alter table public.channels alter column min_interval_seconds set default 1;

do $$ begin
  alter table public.channels add constraint channels_retention_days_chk check (retention_days between 1 and 365);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.channels add constraint channels_min_interval_chk check (min_interval_seconds between 1 and 3600);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.channels add constraint channels_name_len_chk check (char_length(name) between 1 and 60);
exception when duplicate_object then null; end $$;

create index if not exists channels_owner_idx on public.channels(owner_id);

update public.feeds set device_id = 'default' where device_id is null;
alter table public.feeds alter column device_id set not null;
alter table public.feeds alter column device_id set default 'default';

do $$
declare i int;
begin
  for i in 1..20 loop
    execute format(
      'alter table public.feeds alter column field%s type double precision using field%s::double precision',
      i, i
    );
  end loop;
end $$;

drop index if exists public.feeds_channel_created_idx;
drop index if exists public.idx_feeds_channel_created;
drop index if exists public.idx_feeds_device;

create unique index if not exists feeds_dedupe_uq on public.feeds (channel_id, device_id, created_at desc);
create index if not exists feeds_created_brin on public.feeds using brin (created_at) with (pages_per_range = 32);

alter table public.devices add column if not exists expected_interval_seconds integer;

do $$ begin
  alter table public.devices add constraint devices_expected_interval_chk
    check (expected_interval_seconds is null or expected_interval_seconds between 1 and 86400);
exception when duplicate_object then null; end $$;

drop index if exists public.idx_devices_channel;
create index if not exists devices_channel_seen_idx on public.devices (channel_id, last_seen_at desc);

alter table public.commands add column if not exists attempts integer not null default 0;
alter table public.commands add column if not exists expires_at timestamptz not null default (now() + interval '1 hour');

do $$ begin
  alter table public.commands add constraint commands_status_chk
    check (status in ('pending', 'delivered', 'acked', 'expired'));
exception when duplicate_object then null; end $$;

drop index if exists public.idx_commands_channel_device_status;
create index if not exists commands_poll_idx on public.commands (channel_id, device_id, created_at)
  where status in ('pending', 'delivered');
create index if not exists commands_channel_created_idx on public.commands (channel_id, created_at desc);

create table if not exists public.channel_daily_stats (
  channel_id bigint not null references public.channels(id) on delete cascade,
  day date not null,
  entries bigint not null default 0,
  primary key (channel_id, day)
);

alter table public.channel_daily_stats enable row level security;

insert into public.channel_daily_stats (channel_id, day, entries)
select channel_id, (created_at at time zone 'utc')::date, count(*)
from public.feeds
group by 1, 2
on conflict (channel_id, day) do nothing;

create or replace function public.bump_daily_stats(p jsonb)
returns void
language sql
as $$
  insert into public.channel_daily_stats (channel_id, day, entries)
  select c.id, (x->>'day')::date, sum((x->>'n')::bigint)
  from jsonb_array_elements(p) as x
  join public.channels c on c.id = (x->>'channel_id')::bigint
  group by c.id, (x->>'day')::date
  on conflict (channel_id, day)
  do update set entries = public.channel_daily_stats.entries + excluded.entries;
$$;

create or replace function public.channel_overview(p_ids bigint[])
returns table (channel_id bigint, total_entries bigint, device_count bigint)
language sql
stable
as $$
  select c.id,
         coalesce((select sum(s.entries) from public.channel_daily_stats s where s.channel_id = c.id), 0)::bigint,
         (select count(*) from public.devices d where d.channel_id = c.id)::bigint
  from public.channels c
  where c.id = any(p_ids);
$$;

create or replace function public.recent_feeds_per_device(p_channel bigint, p_per integer)
returns setof public.feeds
language sql
stable
as $$
  select f.*
  from public.devices d
  cross join lateral (
    select *
    from public.feeds
    where channel_id = p_channel and device_id = d.device_id
    order by created_at desc
    limit p_per
  ) f
  where d.channel_id = p_channel;
$$;

create or replace function public.claim_commands(
  p_channel bigint,
  p_device text,
  p_limit integer,
  p_redeliver_seconds integer,
  p_max_attempts integer
)
returns setof public.commands
language plpgsql
as $$
begin
  return query
  with picked as (
    select c.id
    from public.commands c
    where c.channel_id = p_channel
      and c.device_id = p_device
      and c.expires_at > now()
      and (
        c.status = 'pending'
        or (
          c.status = 'delivered'
          and c.attempts < p_max_attempts
          and c.delivered_at < now() - make_interval(secs => p_redeliver_seconds)
        )
      )
    order by c.created_at, c.id
    limit p_limit
    for update skip locked
  )
  update public.commands cmd
  set status = 'delivered',
      delivered_at = now(),
      attempts = cmd.attempts + 1
  from picked
  where cmd.id = picked.id
  returning cmd.*;
end;
$$;

create or replace function public.expire_commands()
returns void
language sql
as $$
  update public.commands
  set status = 'expired'
  where status in ('pending', 'delivered')
    and (
      expires_at <= now()
      or (status = 'delivered' and attempts >= 5 and delivered_at < now() - interval '5 minutes')
    );
$$;

create or replace function public.purge_retention()
returns void
language plpgsql
as $$
declare
  r record;
begin
  for r in select id, retention_days from public.channels loop
    delete from public.feeds
    where channel_id = r.id
      and created_at < now() - make_interval(days => r.retention_days);
  end loop;
  delete from public.commands where created_at < now() - interval '14 days';
end;
$$;

do $$
declare j record;
begin
  for j in
    select jobid from cron.job
    where jobname in ('sarkited-feeds-retention', 'sarkit-purge-retention', 'sarkit-expire-commands')
  loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('sarkit-purge-retention', '30 3 * * *', 'select public.purge_retention()');
  perform cron.schedule('sarkit-expire-commands', '*/10 * * * *', 'select public.expire_commands()');
end $$;

drop policy if exists "service role full access stats" on public.channel_daily_stats;
create policy "service role full access stats" on public.channel_daily_stats
  for all to service_role using (true) with check (true);

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';