-- 0014 revoked PUBLIC privileges, including helpers required by RLS.
grant execute on function public.has_role(uuid,public.app_role), public.is_admin(uuid),
  public.can_access_company(uuid,uuid), public.is_seller_restricted(uuid),
  public.can_view_seller(uuid,uuid), public.has_broad_scope(uuid), public.manages_seller(uuid,uuid),
  public.accessible_company_ids(uuid), public.visible_seller_ids(uuid), public.visible_customer_ids(uuid),
  public.can_view_full_document()
  to authenticated, service_role;

-- Invalid source statuses must fail at Canonical, before promotion can default them.
alter table public.canonical_invoices add constraint canonical_invoice_status_known
  check (status in ('authorized','cancelled','denied'));
alter table public.canonical_orders add constraint canonical_order_status_known
  check (status in ('open','invoiced','cancelled'));

create or replace function public.omie_readiness(p_company uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare res jsonb := '[]'::jsonb; e text; r record; v_state text; v_open integer; v_stale boolean; v_pending boolean;
begin
  if not public.is_service_request() then perform public.integration_admin_assert(p_company); end if;
  foreach e in array array['vendors','customers','products','invoices','orders','receivables'] loop
    select * into r from public.integration_sync_runs where company_id=p_company and entity=e order by started_at desc limit 1;
    select count(*) into v_open from public.integrity_issues
      where company_id=p_company and entity in (e,case e when 'invoices' then 'invoice_items' when 'receivables' then 'settlements' else e end)
      and status in ('OPEN','ACKNOWLEDGED') and severity in ('HIGH','CRITICAL');
    select exists(select 1 from public.integration_backfill_jobs where company_id=p_company and entity=e
      and status not in ('DONE','CANCELLED')) into v_pending;
    v_stale := r.finished_at is null or r.finished_at < now()-interval '36 hours';
    v_state := case
      when r.id is null then 'PENDING'
      when r.status in ('RUNNING','PENDING') then 'SYNCING'
      when r.status='FAILED' then 'ERROR'
      when r.status not in ('SUCCESS','WARNING') or coalesce(r.failed,0)>0 then 'DEGRADED'
      when not coalesce(r.raw_complete,false) then 'DEGRADED'
      when not coalesce(r.canonical_complete,false) then 'RAW_COMPLETE'
      when not coalesce(r.gold_complete,false) then 'CANONICAL_COMPLETE'
      when v_open>0 or v_stale or v_pending then 'DEGRADED'
      when r.expected_records is not null and r.received<r.expected_records then 'DEGRADED'
      else 'READY' end;
    res := res || jsonb_build_object('entity',e,'state',v_state,'lastRunAt',r.started_at,'finishedAt',r.finished_at,
      'periodFrom',r.period_from,'periodTo',r.period_to,'expected',r.expected_records,'received',r.received,
      'failed',r.failed,'openIssues',v_open,'stale',v_stale,'backfillPending',v_pending,'runStatus',r.status,'message',r.message);
  end loop;
  return res;
end $$;
revoke all on function public.omie_readiness(uuid) from public, anon;
grant execute on function public.omie_readiness(uuid) to authenticated, service_role;

-- A failed insert rolls back the deletion; concurrent workers serialize per company/day.
create or replace function public.replace_flight_plan_snapshot(p_company uuid,p_date date,p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_service_request() then raise exception 'Server only' using errcode='42501'; end if;
  if p_company is null or p_date is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)=0 then
    raise exception 'Nonempty snapshot rows required';
  end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x where (x->>'company_id')::uuid is distinct from p_company
    or (x->>'snapshot_date')::date is distinct from p_date) then raise exception 'Snapshot scope mismatch'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x where x->>'seller_id' is not null
    and not exists(select 1 from public.sellers where company_id=p_company and id=(x->>'seller_id')::uuid)) then
    raise exception 'Snapshot seller belongs to another company';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('biomie.snapshot:'||p_company::text||':'||p_date::text,0));
  delete from public.flight_plan_snapshots where company_id=p_company and snapshot_date=p_date;
  insert into public.flight_plan_snapshots(company_id,seller_id,snapshot_date,year,month,active_level,target,realized,
    ideal,deviation,gap,current_pace,required_pace,run_rate,forecast_base,forecast_probable,forecast_commit,portfolio,
    coverage,status,working_days_elapsed,working_days_total,job_run_id)
  select company_id,seller_id,snapshot_date,year,month,active_level,target,realized,
    ideal,deviation,gap,current_pace,required_pace,run_rate,forecast_base,forecast_probable,forecast_commit,portfolio,
    coverage,status,working_days_elapsed,working_days_total,job_run_id
    from jsonb_populate_recordset(null::public.flight_plan_snapshots,p_rows);
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.replace_flight_plan_snapshot(uuid,date,jsonb) from public,anon,authenticated;
grant execute on function public.replace_flight_plan_snapshot(uuid,date,jsonb) to service_role;
notify pgrst, 'reload schema';
