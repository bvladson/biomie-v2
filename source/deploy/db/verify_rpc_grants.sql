\set ON_ERROR_STOP on
-- RPC grant audit: anon executes nothing; server-only functions are not callable
-- by signed-in users; read models stay callable by signed-in users.
begin;
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'pg_catalog.trigger'::regtype
      and has_function_privilege('anon', p.oid, 'EXECUTE');
  if bad is not null then raise exception 'anon can execute: %', bad; end if;

  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path%';
  if bad is not null then raise exception 'SECURITY DEFINER without search_path: %', bad; end if;

  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proname in ('get_integration_credentials','ingest_omie_raw','promote_omie_gold','mark_raw_processed',
        'replace_omie_canonical_items','get_legacy_classification_config','record_integration_test',
        'report_worker_status','get_worker_control','set_demo_visibility','resolve_legacy_login',
        'replace_integration_credentials_ciphertext','finance_title_facts','verify_job_token',
        'can_manage_seller_target');
  if bad is not null then raise exception 'authenticated can execute server-only: %', bad; end if;

  select string_agg(x, ', ') into bad from unnest(array['fact_sales','sales_kpis','cockpit_summary',
      'customers_overview','flight_plan_dataset','data_coverage','finance_summary','customer_document',
      'sales_targets_grid','save_sales_targets']) x
    where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = x and has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then raise exception 'authenticated lost read models: %', bad; end if;
  raise notice 'PASS RPC grants: anon none, definers pinned, server-only closed, read models open';
end $$;
rollback;
