-- 1. DEMO companies are invisible to every user when the environment says so.
--    Production sets demo.visible=false; the isolated test database keeps them.
create or replace function public.demo_companies_visible()
returns boolean language sql stable security definer set search_path = private, public as $$
  select coalesce((select value from private.app_settings where key='demo.visible'),'true') = 'true'
$$;
revoke all on function public.demo_companies_visible() from public, anon;
grant execute on function public.demo_companies_visible() to authenticated, service_role;

create or replace function public.set_demo_visibility(p_visible boolean)
returns void language plpgsql security definer set search_path = private, public as $$
begin
  if not public.is_service_request() then raise exception 'Somente a implantação.' using errcode = '42501'; end if;
  insert into private.app_settings(key,value,updated_at) values('demo.visible', case when p_visible then 'true' else 'false' end, now())
    on conflict(key) do update set value=excluded.value, updated_at=now();
  insert into public.audit_log(actor_id,action,entity,entity_id,payload)
    values(null,'settings.demo_visibility','app_settings','demo.visible',jsonb_build_object('visible',p_visible));
end $$;
revoke all on function public.set_demo_visibility(boolean) from public, anon, authenticated;
grant execute on function public.set_demo_visibility(boolean) to service_role;

create or replace function public.can_access_company(_user_id uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (public.has_role(_user_id,'SUPER_ADMIN')
      or exists (select 1 from public.user_company_access where user_id = _user_id and company_id = _company))
    and (public.demo_companies_visible() or exists (select 1 from public.companies where id = _company and not is_demo))
$$;

create or replace function public.accessible_company_ids(_user_id uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when public.has_role(_user_id, 'SUPER_ADMIN')
    then (select coalesce(array_agg(c.id), '{}') from public.companies c
          where public.demo_companies_visible() or not c.is_demo)
    else (select coalesce(array_agg(a.company_id), '{}') from public.user_company_access a
          join public.companies c on c.id = a.company_id
          where a.user_id = _user_id and (public.demo_companies_visible() or not c.is_demo)) end
$$;

-- 2. Temporal coverage: periods proven loaded (RAW + Canonical + Gold) per entity.
--    Screens must say "not imported yet" instead of showing a zero.
create or replace function public.data_coverage(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_demo boolean;
begin
  if not public.is_service_request() and not public.can_access_company(auth.uid(), p_company) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select is_demo into v_demo from public.companies where id = p_company;
  with runs as (
    select entity, period_from, period_to from public.integration_sync_runs
    where company_id = p_company and entity in ('invoices','orders','receivables','settlements')
      and status in ('SUCCESS','WARNING') and raw_complete and canonical_complete and gold_complete
      and period_from is not null and period_to is not null
  ), ordered as (
    select entity, period_from, period_to,
      max(period_to) over (partition by entity order by period_from, period_to
        rows between unbounded preceding and 1 preceding) prev_max
    from runs
  ), grouped as (
    select entity, period_from, period_to,
      sum(case when prev_max is null or period_from > prev_max + 1 then 1 else 0 end)
        over (partition by entity order by period_from, period_to) grp
    from ordered
  ), ranges as (
    select entity, min(period_from) f, max(period_to) t from grouped group by entity, grp
  )
  select coalesce(jsonb_object_agg(entity, rs), '{}'::jsonb) into v from (
    select entity, jsonb_agg(jsonb_build_object('from', f, 'to', t) order by f) rs from ranges group by entity) x;
  return jsonb_build_object('demo', coalesce(v_demo,false), 'entities', v);
end $$;
revoke all on function public.data_coverage(uuid) from public, anon;
grant execute on function public.data_coverage(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
