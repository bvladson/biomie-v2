-- Inside SECURITY DEFINER functions current_user is the owner; detect trusted server jobs via the JWT role.
create or replace function public.is_service_request() returns boolean
language sql stable set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role'
$$;
grant execute on function public.is_service_request() to authenticated, service_role;

create or replace function public.has_finance_capability(_cap text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_service_request() or _cap = any(public.finance_capabilities(auth.uid()))
$$;

create or replace function public.finance_assert(p_company uuid, p_cap text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_service_request() and not public.can_access_company(auth.uid(), p_company) then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  if not public.has_finance_capability(p_cap) then
    raise exception 'Sem permissão financeira (%).', p_cap using errcode = '42501';
  end if;
end $$;

create or replace function public.quality_assert(p_company uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if public.is_service_request() then return; end if;
  if not public.can_access_company(auth.uid(), p_company) then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  if not public.has_broad_scope(auth.uid()) then
    raise exception 'Qualidade dos dados restrita a perfis com visão da empresa inteira.' using errcode = '42501';
  end if;
end $$;

create or replace function public.scheduler_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_service_request() and not public.has_broad_scope(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  begin
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'schedule', j.schedule, 'active', j.active,
        'lastRun', d.start_time, 'lastStatus', d.status) order by j.jobname), '[]'::jsonb)
      from cron.job j
      left join lateral (select start_time, status from cron.job_run_details x
                         where x.jobid = j.jobid order by start_time desc limit 1) d on true$q$ into r;
  exception when others then
    return jsonb_build_object('available', false);
  end;
  return jsonb_build_object('available', true, 'jobs', r);
end $$;