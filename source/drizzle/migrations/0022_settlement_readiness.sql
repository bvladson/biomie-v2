-- Settlements are a separately proven entity; receivables alone cannot authorize financial activation.
create or replace function public.omie_readiness(p_company uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare res jsonb := '[]'::jsonb; e text; r record; v_state text; v_open integer; v_stale boolean; v_pending boolean;
  v_contract boolean;
begin
  if not public.is_service_request() then perform public.integration_admin_assert(p_company); end if;
  foreach e in array array['vendors','customers','products','invoices','orders','receivables','settlements'] loop
    v_contract := true;
    if e='invoices' and exists(select 1 from public.companies where id=p_company and not is_demo) then
      v_contract := exists(select 1 from public.companies where id=p_company and revenue_basis='commercial_base')
        and not exists(select 1 from public.canonical_invoices where company_id=p_company and source='omie' and not missing_in_source
          and (operation_scope='unconfirmed' or business_channel='unconfirmed'))
        and not exists(select 1 from public.invoices where company_id=p_company and source='omie'
          and (operation_scope='unconfirmed' or business_channel='unconfirmed'))
        and not exists(select 1 from public.invoices i where i.company_id=p_company and i.source='omie' and i.status='authorized'
          and i.operation_scope='commercial' and (i.business_channel='licitacao' or i.is_biomie_commercial_visible)
          and abs(i.total)>0.005
          and coalesce((select sum(it.total) from public.invoice_items it where it.invoice_id=i.id),0)=0);
    end if;
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
      when v_open>0 or v_stale or v_pending or not v_contract then 'DEGRADED'
      when r.expected_records is not null and r.received<r.expected_records then 'DEGRADED'
      else 'READY' end;
    res := res || jsonb_build_object('entity',e,'state',v_state,'lastRunAt',r.started_at,'finishedAt',r.finished_at,
      'periodFrom',r.period_from,'periodTo',r.period_to,'expected',r.expected_records,'received',r.received,
      'failed',r.failed,'openIssues',v_open,'stale',v_stale,'backfillPending',v_pending,
      'contractValid',v_contract,'contractError',case when not v_contract then 'Commercial basis, operation/channel evidence or item weights unresolved' end,
      'runStatus',r.status,'message',r.message);
  end loop;
  return res;
end $$;
revoke all on function public.omie_readiness(uuid) from public,anon;
grant execute on function public.omie_readiness(uuid) to authenticated,service_role;
notify pgrst, 'reload schema';
