select jsonb_pretty(jsonb_build_object(
  'feeds_field_types', (
    select jsonb_agg(distinct data_type)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'feeds' and column_name like 'field%'
  ),
  'feeds_device_id_nullable', (
    select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'feeds' and column_name = 'device_id'
  ),
  'channels_new_columns', (
    select jsonb_agg(column_name order by column_name)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'channels'
      and column_name in ('owner_id', 'retention_days', 'admin_key')
  ),
  'indexes', (
    select jsonb_agg(indexname order by indexname)
    from pg_indexes
    where schemaname = 'public' and tablename in ('feeds', 'devices', 'commands', 'channels', 'channel_daily_stats')
  ),
  'functions', (
    select jsonb_agg(proname order by proname)
    from pg_proc
    where pronamespace = 'public'::regnamespace
  ),
  'cron_jobs', (
    select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname), '[]'::jsonb)
    from cron.job
  ),
  'anon_or_authenticated_table_grants', (
    select count(*)
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
  ),
  'anon_or_authenticated_function_execute', (
    select count(*)
    from information_schema.routine_privileges
    where routine_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')
  ),
  'rls_disabled_tables', (
    select coalesce(jsonb_agg(relname), '[]'::jsonb)
    from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity
  ),
  'policies', (
    select coalesce(jsonb_agg(jsonb_build_object('table', tablename, 'name', policyname, 'roles', roles) order by tablename), '[]'::jsonb)
    from pg_policies
    where schemaname = 'public'
  ),
  'stats_rows', (select count(*) from public.channel_daily_stats),
  'constraints', (
    select jsonb_agg(conname order by conname)
    from pg_constraint
    where connamespace = 'public'::regnamespace and contype = 'c'
  )
)) as report;