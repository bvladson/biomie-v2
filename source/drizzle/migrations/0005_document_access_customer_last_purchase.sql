create table if not exists public.user_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  permission text not null check (permission in ('documents:view_full')),
  granted_by uuid,
  created_at timestamptz not null default now(),
  unique (user_id, permission)
);
grant select on public.user_permissions to authenticated;
grant all on public.user_permissions to service_role;
alter table public.user_permissions enable row level security;
create policy "own or admin read permissions" on public.user_permissions for select to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

create or replace function public.mask_document(p text) returns text language sql immutable set search_path = public as $$
  select case length(d)
    when 14 then substr(d,1,2) || '.***.***/' || substr(d,9,4) || '-**'
    when 11 then '***.' || substr(d,4,3) || '.***-**'
    else null end
  from (select regexp_replace(coalesce(p,''), '\D', '', 'g') d) x
$$;

create or replace function public.can_view_full_document() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_permissions where user_id = auth.uid() and permission = 'documents:view_full')
$$;

create or replace function public.customer_document(p_customer uuid) returns text language sql stable security definer set search_path = public as $$
  select public.mask_document(c.document) from public.customers c
  where c.id = p_customer and (auth.role() = 'service_role' or public.can_access_company(auth.uid(), c.company_id))
$$;

create or replace function public.reveal_customer_document(p_customer uuid, p_reason text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_doc text; v_company uuid;
begin
  if not public.can_view_full_document() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'reason required'; end if;
  select document, company_id into v_doc, v_company from public.customers where id = p_customer;
  if not found or not public.can_access_company(auth.uid(), v_company) then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.audit_log(actor_id, action, entity, entity_id, payload)
  values (auth.uid(), 'document.reveal', 'customers', p_customer, jsonb_build_object('reason', p_reason, 'company', v_company));
  return v_doc;
end $$;
revoke execute on function public.reveal_customer_document(uuid, text) from anon, public;
grant execute on function public.reveal_customer_document(uuid, text) to authenticated;

revoke select on public.customers from anon, authenticated;
grant select (id, company_id, name, state, city, created_at) on public.customers to authenticated;

do $$
declare v text;
begin
  select pg_get_functiondef(p.oid) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'customers_overview';
  execute replace(v, 'c.document', 'public.customer_document(c.id) document');

  select pg_get_functiondef(p.oid) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'customer_360';
  v := replace(v, 'select * into v_c from public.customers', 'select id, name, city, state into v_c from public.customers');
  v := replace(v, 'v_c.document', 'public.customer_document(v_c.id)');
  v := replace(v, 'max(f.competence_date) "lastDate"',
    'max(f.competence_date) "lastDate", (select max(v4.d) from valid v4 where v4.product_id = f.product_id) "lastDateAll"');
  execute v;
end $$;