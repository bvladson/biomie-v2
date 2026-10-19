-- Own legacy rules and validated classifications, including original customer
-- documents when required by a server-side rule. Never exposed to app roles.
create table private.legacy_classification_config (
  company_id uuid primary key references public.companies(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings)='object'),
  updated_at timestamptz not null default now()
);
revoke all on private.legacy_classification_config from public,anon,authenticated,service_role;

create or replace function public.get_legacy_classification_config(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path=private,public as $$
declare result jsonb;
begin
  if not public.is_service_request() then raise exception 'Server only' using errcode='42501'; end if;
  if not exists(select 1 from public.companies where id=p_company) then raise exception 'Company not found'; end if;
  select settings into result from private.legacy_classification_config where company_id=p_company;
  return coalesce(result,'{}'::jsonb);
end $$;
revoke all on function public.get_legacy_classification_config(uuid) from public,anon,authenticated;
grant execute on function public.get_legacy_classification_config(uuid) to service_role;
notify pgrst, 'reload schema';
