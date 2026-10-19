-- Deployment hardening. No demo data is deleted or converted.
-- Bootstrap privileges are provisioned explicitly by the deployment operator.
grant usage, select on all sequences in schema public to service_role;
create or replace function public.ensure_app_profile()
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); v_new boolean; v_claims jsonb := auth.jwt();
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('biomie.profile:' || v_user::text, 0));
  v_new := not exists (select 1 from public.profiles where id = v_user);
  insert into public.profiles (id, email, full_name, default_company_id)
  values (v_user, v_claims->>'email', coalesce(v_claims#>>'{user_metadata,full_name}', v_claims#>>'{user_metadata,name}'),
    (select id from public.companies where is_demo order by name limit 1))
  on conflict (id) do nothing;
  if not exists (select 1 from public.user_roles where user_id = v_user) then
    insert into public.user_roles (user_id, role) values (v_user, 'VIEWER') on conflict do nothing;
  end if;
  if v_new then
    insert into public.user_company_access (user_id, company_id)
      select v_user, id from public.companies where is_demo on conflict do nothing;
    insert into public.audit_log (actor_id, action, entity, entity_id, payload)
      values (v_user, 'profile.provision', 'profiles', v_user::text, '{"automaticRole":"VIEWER"}'::jsonb);
  end if;
end $$;
revoke all on function public.ensure_app_profile() from public, anon;
grant execute on function public.ensure_app_profile() to authenticated;

-- A lease survives separate HTTP requests and processes; only its owner releases it.
create table private.omie_worker_leases (
  lease_key text primary key, owner uuid not null,
  acquired_at timestamptz not null default now(), expires_at timestamptz not null
);
revoke all on private.omie_worker_leases from public, anon, authenticated, service_role;
create or replace function public.acquire_omie_worker_lease(p_key text, p_owner uuid, p_ttl_seconds integer default 900)
returns boolean language plpgsql security definer set search_path = private, public as $$
declare v_owner uuid;
begin
  if not public.is_service_request() then raise exception 'Server only' using errcode = '42501'; end if;
  if p_owner is null or length(coalesce(p_key,'')) not between 1 and 200
    or p_ttl_seconds is null or p_ttl_seconds not between 30 and 3600 then
    raise exception 'Invalid lease parameters';
  end if;
  insert into private.omie_worker_leases (lease_key, owner, acquired_at, expires_at)
  values (p_key, p_owner, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (lease_key) do update set owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
    where omie_worker_leases.expires_at < now() or omie_worker_leases.owner = excluded.owner
  returning owner into v_owner;
  return coalesce(v_owner = p_owner, false);
end $$;
create or replace function public.release_omie_worker_lease(p_key text, p_owner uuid)
returns boolean language plpgsql security definer set search_path = private, public as $$
declare n integer;
begin
  if not public.is_service_request() then raise exception 'Server only' using errcode = '42501'; end if;
  delete from private.omie_worker_leases where lease_key = p_key and owner = p_owner;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.acquire_omie_worker_lease(text,uuid,integer), public.release_omie_worker_lease(text,uuid) from public, anon, authenticated;
grant execute on function public.acquire_omie_worker_lease(text,uuid,integer), public.release_omie_worker_lease(text,uuid) to service_role;

-- Privileged document readers must enforce the same seller scope as customer RLS.
create or replace function public.customer_document(p_customer uuid)
returns text language sql stable security definer set search_path = public as $$
  select public.mask_document(c.document) from public.customers c
  where c.id = p_customer and (
    public.is_service_request() or (
      public.can_access_company(auth.uid(), c.company_id)
      and (not public.is_seller_restricted(auth.uid()) or c.id = any(public.visible_customer_ids(auth.uid())))
    ))
$$;
create or replace function public.reveal_customer_document(p_customer uuid, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare v_doc text; v_company uuid;
begin
  if not public.can_view_full_document() then raise exception 'Forbidden' using errcode = '42501'; end if;
  if length(coalesce(trim(p_reason),'')) < 5 then raise exception 'Reason required'; end if;
  select document, company_id into v_doc, v_company from public.customers where id = p_customer;
  if not found or not public.can_access_company(auth.uid(), v_company)
    or (public.is_seller_restricted(auth.uid()) and not p_customer = any(public.visible_customer_ids(auth.uid()))) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
    values (auth.uid(), 'document.reveal', 'customers', p_customer::text, jsonb_build_object('reason', p_reason, 'company', v_company));
  return v_doc;
end $$;
revoke all on function public.customer_document(uuid), public.reveal_customer_document(uuid,text) from public, anon;
grant execute on function public.customer_document(uuid) to authenticated, service_role;
grant execute on function public.reveal_customer_document(uuid,text) to authenticated;

-- Preserve quantities used by the existing ERP (four decimal places).
alter table public.invoice_items alter column quantity type numeric(20,4);
alter table public.sales_order_items alter column quantity type numeric(20,4);

-- Database-enforced tenant integrity, in addition to read policies.
do $$
declare t text; spec text[];
begin
  foreach t in array array['channels','branches','sellers','customers','products','invoices','sales_orders','financial_titles','financial_accounts','financial_categories'] loop
    execute format('alter table public.%I add constraint %I unique (company_id,id)', t, t || '_company_identity_uq');
  end loop;
  foreach spec slice 1 in array array[
    ['sellers','channel_id','channels'],['sellers','branch_id','branches'],
    ['invoices','channel_id','channels'],['invoices','branch_id','branches'],['invoices','seller_id','sellers'],['invoices','customer_id','customers'],
    ['invoice_items','invoice_id','invoices'],['invoice_items','seller_id','sellers'],['invoice_items','product_id','products'],
    ['sales_orders','channel_id','channels'],['sales_orders','branch_id','branches'],['sales_orders','seller_id','sellers'],['sales_orders','customer_id','customers'],
    ['sales_order_items','order_id','sales_orders'],['sales_order_items','seller_id','sellers'],['sales_order_items','product_id','products'],
    ['financial_titles','customer_id','customers'],['financial_titles','invoice_id','invoices'],['financial_titles','sales_order_id','sales_orders'],['financial_titles','seller_id','sellers'],
    ['financial_titles','account_id','financial_accounts'],['financial_titles','category_id','financial_categories'],
    ['financial_settlements','title_id','financial_titles'],['financial_settlements','account_id','financial_accounts']
  ] loop
    execute format('alter table public.%I add constraint %I foreign key (company_id,%I) references public.%I(company_id,id)',
      spec[1], spec[1] || '_' || spec[2] || '_tenant_fk', spec[2], spec[3]);
  end loop;
end $$;

-- Readiness is the single activation gate; the old migration-status RPC is display-only.
create or replace function public.set_company_data_source(p_company uuid, p_source text, p_confirmation text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text; v_demo boolean; v_blocked integer;
begin
  perform public.integration_admin_assert(p_company);
  if p_source not in ('DEMO','OMIE_SHADOW','OMIE') then raise exception 'Invalid data source'; end if;
  select data_source, is_demo into v_old, v_demo from public.companies where id = p_company for update;
  if not found then raise exception 'Company not found'; end if;
  if v_demo and p_source <> 'DEMO' then raise exception 'Demo companies cannot be converted'; end if;
  if not v_demo and p_source = 'DEMO' then raise exception 'Real companies cannot be labelled as demo'; end if;
  if p_source = 'OMIE' then
    if not public.has_role(auth.uid(),'SUPER_ADMIN') or p_confirmation is distinct from 'ATIVAR OMIE' then
      raise exception 'Super Admin confirmation required' using errcode = '42501';
    end if;
    select count(*) into v_blocked from jsonb_array_elements(public.omie_readiness(p_company)) x
      where x->>'state' is distinct from 'READY' or coalesce((x->>'failed')::int,0) > 0;
    if v_blocked > 0 then raise exception 'Readiness incomplete: % entities', v_blocked; end if;
    if exists (select 1 from public.integration_backfill_jobs where company_id = p_company and status in ('PENDING','RUNNING')) then
      raise exception 'Backfill still pending';
    end if;
  end if;
  update public.companies set data_source = p_source where id = p_company;
  insert into public.audit_log(actor_id,action,entity,entity_id,payload)
    values(auth.uid(),'company.data_source_changed','companies',p_company::text,jsonb_build_object('from',v_old,'to',p_source));
end $$;
revoke all on function public.set_company_data_source(uuid,text,text) from public, anon;
grant execute on function public.set_company_data_source(uuid,text,text) to authenticated, service_role;

notify pgrst, 'reload schema';
