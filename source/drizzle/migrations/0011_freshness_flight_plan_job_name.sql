create or replace function public.data_freshness(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_demo boolean; v_ref timestamptz; v_cfg jsonb; v_warn numeric; v_stale numeric; r jsonb;
begin
  perform public.quality_assert(p_company);
  select is_demo into v_demo from public.companies where id = p_company;
  v_ref := case when v_demo
    then least(now(), ((public.data_as_of(p_company) + 1)::timestamp) at time zone 'America/Sao_Paulo')
    else now() end;
  select config into v_cfg from public.metric_config where metric_key = 'quality';
  v_warn := coalesce((v_cfg->>'warningHours')::numeric, 26);
  v_stale := coalesce((v_cfg->>'staleHours')::numeric, 72);
  with ds(dataset, label, o) as (values
    ('customers','Clientes',1),('products','Produtos',2),('sellers','Vendedores',3),('orders','Pedidos',4),
    ('invoices','Notas fiscais',5),('finance','Financeiro',6),('targets','Metas',7),('flight_plan','Plano de Voo',8)
  ), cnt as (
    select 'customers' dataset, count(*) n from public.customers where company_id = p_company
    union all select 'products', count(*) from public.products where company_id = p_company
    union all select 'sellers', count(*) from public.sellers where company_id = p_company
    union all select 'orders', count(*) from public.sales_orders where company_id = p_company
    union all select 'invoices', count(*) from public.invoices where company_id = p_company
    union all select 'finance', count(*) from public.financial_titles where company_id = p_company
    union all select 'targets', count(*) from public.sales_targets where company_id = p_company
    union all select 'flight_plan', count(*) from public.flight_plan_snapshots where company_id = p_company
  ), st as (
    select dataset,
      max(last_success_at) filter (where layer in ('SOURCE','RAW')) sync_at,
      max(last_success_at) filter (where layer = 'CANONICAL') transform_at,
      max(last_success_at) filter (where layer in ('GOLD','MART')) mart_at,
      bool_or(status = 'failed') failed,
      string_agg(error, '; ') filter (where error is not null) err
    from public.dataset_sync_state where company_id = p_company group by dataset
  ), fp as (
    select max(finished_at) filter (where status = 'success') ok_at,
           (array_agg(status order by started_at desc))[1] last_status,
           (array_agg(error order by started_at desc))[1] last_error
    from public.job_runs where job_name in ('flight_plan_snapshots', 'flight-plan-snapshots')
  ), merged as (
    select ds.dataset, ds.label, ds.o, cnt.n records,
      case when ds.dataset = 'flight_plan' then (select ok_at from fp) else st.sync_at end sync_at,
      case when ds.dataset = 'flight_plan' then (select ok_at from fp) else st.transform_at end transform_at,
      case when ds.dataset = 'flight_plan' then (select ok_at from fp) else st.mart_at end mart_at,
      case when ds.dataset = 'flight_plan' then coalesce((select last_status from fp) = 'failed', false) else coalesce(st.failed, false) end failed,
      case when ds.dataset = 'flight_plan' then (select last_error from fp) else st.err end err
    from ds join cnt on cnt.dataset = ds.dataset left join st on st.dataset = ds.dataset
  )
  select jsonb_build_object('reference', v_ref, 'warningHours', v_warn, 'staleHours', v_stale, 'isDemo', v_demo,
    'datasets', coalesce(jsonb_agg(jsonb_build_object(
      'dataset', dataset, 'label', label, 'records', records,
      'lastSync', sync_at, 'lastTransform', transform_at, 'martUpdated', mart_at, 'error', err,
      'ageHours', round((extract(epoch from (v_ref - least(sync_at, transform_at, mart_at))) / 3600.0)::numeric, 1),
      'status', case when failed then 'FAILED'
        when sync_at is null or transform_at is null or mart_at is null then 'STALE'
        when v_ref - least(sync_at, transform_at, mart_at) > make_interval(hours => v_stale::int) then 'STALE'
        when v_ref - least(sync_at, transform_at, mart_at) > make_interval(hours => v_warn::int) then 'WARNING'
        else 'FRESH' end) order by o), '[]'::jsonb))
  into r from merged;
  return r;
end $$;