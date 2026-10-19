\set ON_ERROR_STOP on
-- Run after migrations, as database owner. Every fixture is rolled back.
begin;
do $$
declare u uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  seller_a uuid := gen_random_uuid(); seller_b uuid := gen_random_uuid(); customer_a uuid := gen_random_uuid();
  owner_a uuid := gen_random_uuid(); owner_b uuid := gen_random_uuid(); rejected boolean := false; summary jsonb; sync_id uuid := gen_random_uuid();
begin
  if has_function_privilege('anon','public.ensure_app_profile()','execute') then raise exception 'Anon profile RPC exposed'; end if;
  if has_function_privilege('authenticated','public.acquire_omie_worker_lease(text,uuid,integer)','execute') then raise exception 'Lease RPC exposed'; end if;
  if has_function_privilege('anon','public.get_integration_credentials(uuid,text)','execute') then raise exception 'Credentials RPC exposed'; end if;
  if has_function_privilege('anon','public.resolve_legacy_login(text)','execute') or has_function_privilege('authenticated','public.resolve_legacy_login(text)','execute') then
    raise exception 'Legacy alias lookup exposed';
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','email','migration-test@invalid.example')::text,true);
  perform public.ensure_app_profile();
  perform public.ensure_app_profile();
  if not exists(select 1 from public.user_roles where user_id=u and role='VIEWER')
    or exists(select 1 from public.user_roles where user_id=u and role='SUPER_ADMIN') then raise exception 'Unsafe bootstrap'; end if;
  if (select count(*) from public.profiles where id=u) <> 1 then raise exception 'Profile is not idempotent'; end if;
  insert into public.companies(id,name,slug,data_source) values(a,'Test A','security-test-'||a,'OMIE_SHADOW'),(b,'Test B','security-test-'||b,'OMIE_SHADOW');
  insert into public.sellers(id,company_id,name,user_id) values(seller_a,a,'A',u),(seller_b,b,'B',null);
  insert into public.customers(id,company_id,name,state,city) values(customer_a,a,'Test','SP','Test');
  begin
    insert into public.invoices(company_id,seller_id,customer_id,number,competence_date)
      values(a,seller_b,customer_a,'cross-tenant-test',current_date);
  exception when foreign_key_violation then rejected := true;
  end;
  if not rejected then raise exception 'Cross-company seller reference accepted'; end if;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if public.resolve_legacy_login('__migration_alias_missing__') is not null then raise exception 'Unknown legacy alias resolved'; end if;
  if not public.acquire_omie_worker_lease('migration-test',owner_a,900) then raise exception 'Lease not acquired'; end if;
  if public.acquire_omie_worker_lease('migration-test',owner_b,900) then raise exception 'Concurrent owner acquired lease'; end if;
  if public.release_omie_worker_lease('migration-test',owner_b) then raise exception 'Foreign owner released lease'; end if;
  if not public.release_omie_worker_lease('migration-test',owner_a) then raise exception 'Owner cannot release lease'; end if;
  insert into public.flight_plan_snapshots(company_id,snapshot_date,year,month,active_level,target,realized)
    values(a,current_date,extract(year from current_date)::int,extract(month from current_date)::int,'ACTIVE',1,0);
  rejected := false;
  begin
    perform public.replace_flight_plan_snapshot(a,current_date,jsonb_build_array(jsonb_build_object('company_id',a,'snapshot_date',current_date)));
  exception when not_null_violation then rejected := true;
  end;
  if not rejected or (select count(*) from public.flight_plan_snapshots where company_id=a and snapshot_date=current_date)<>1 then
    raise exception 'Snapshot replacement is not atomic';
  end if;
  insert into public.integration_sync_runs(id,company_id,entity,status) values(sync_id,a,'invoices','SUCCESS');
  insert into public.canonical_invoices(company_id,external_id,sync_run_id,number,status,competence_date,gross_amount,goods_amount)
    values(a,'atomic-items-test',sync_id,'TEST','authorized',current_date,10,10);
  perform public.replace_omie_canonical_items(a,'invoices',sync_id,'[{"external_id":"atomic-items-test","items":[{"item_sequence":1,"quantity":1,"unit_price":5,"total":5},{"item_sequence":2,"quantity":1,"unit_price":5,"total":5}]}]');
  perform public.promote_omie_gold(a,'invoices');
  perform public.replace_omie_canonical_items(a,'invoices',sync_id,'[{"external_id":"atomic-items-test","items":[{"item_sequence":1,"quantity":1,"unit_price":5,"total":5}]}]');
  perform public.promote_omie_gold(a,'invoices');
  if (select count(*) from public.invoice_items it join public.invoices i on i.id=it.invoice_id where i.company_id=a and i.external_id='atomic-items-test')<>1 then
    raise exception 'Removed item survived Gold promotion';
  end if;
  rejected:=false;
  begin
    perform public.replace_omie_canonical_items(a,'invoices',sync_id,'[{"external_id":"atomic-items-test","items":[{"item_sequence":1,"quantity":1,"unit_price":5,"total":5},{"item_sequence":1,"quantity":1,"unit_price":5,"total":5}]}]');
  exception when unique_violation then rejected:=true;
  end;
  if not rejected or (select count(*) from public.canonical_invoice_items where company_id=a and invoice_external_id='atomic-items-test')<>1 then
    raise exception 'Canonical item replacement is not atomic';
  end if;
  perform public.replace_omie_canonical_items(a,'invoices',sync_id,'[{"external_id":"atomic-items-test","items":[]}]');
  perform public.promote_omie_gold(a,'invoices');
  if exists(select 1 from public.invoice_items it join public.invoices i on i.id=it.invoice_id where i.company_id=a and i.external_id='atomic-items-test') then
    raise exception 'Empty canonical item list retained old Gold items';
  end if;
  insert into public.user_roles(user_id,role) values(u,'ANALISTA');
  insert into public.user_company_access(user_id,company_id) values(u,a);
  insert into public.financial_titles(company_id,customer_id,document_number,issue_date,competence_date,due_date,original_amount)
    values(a,customer_a,'overdue-test',current_date-20,current_date-20,current_date-10,100),
          (a,customer_a,'future-test',current_date-20,current_date-20,current_date+10,200);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  summary := public.finance_summary(a,current_date-30,current_date+30);
  if summary->>'open' is not null or summary->>'dueFuture' is not null or summary->>'overdue' is not null then
    raise exception 'Overdue balance can be inferred without capability';
  end if;
  if public.document_hash('12.345.678/0001-95') is distinct from public.document_hash('12345678000195') then raise exception 'Document normalization differs'; end if;
  raise notice 'PASS: bootstrap, tenant FKs, leases, RPC grants, documents, snapshots, Canonical/Gold item replacement, overdue capability';
end $$;
rollback;
