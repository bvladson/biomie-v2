\set ON_ERROR_STOP on
-- Targets editor (migration 0039): scope of every role, all-or-nothing batches,
-- direct writes denied, validation, audit and the Cockpit reading the saved value.
-- Synthetic users/companies only; everything is rolled back. Run on the TEST database.
begin;
do $$
declare
  c uuid:=gen_random_uuid(); c2 uuid:=gen_random_uuid();
  s1 uuid:=gen_random_uuid(); s2 uuid:=gen_random_uuid(); s3 uuid:=gen_random_uuid();
  t1 uuid:=gen_random_uuid(); t2 uuid:=gen_random_uuid();
  sa uuid:=gen_random_uuid(); adm uuid:=gen_random_uuid(); g1 uuid:=gen_random_uuid(); g2 uuid:=gen_random_uuid();
  viewer uuid:=gen_random_uuid(); other uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) select u, 'st-'||u||'@invalid.example' from unnest(array[sa,adm,g1,g2,viewer,other]) u;
  insert into public.profiles(id) select u from unnest(array[sa,adm,g1,g2,viewer,other]) u;
  insert into public.user_roles(user_id,role) values
    (sa,'SUPER_ADMIN'),(adm,'ADMIN'),(g1,'GESTOR'),(g2,'GESTOR'),(viewer,'VIEWER'),(other,'ADMIN');
  insert into public.companies(id,name,slug,data_source,revenue_basis) values
    (c,'Targets fixture','tgt-'||c,'OMIE_SHADOW','commercial_base'),
    (c2,'Other company','tgo-'||c2,'OMIE_SHADOW','commercial_base');
  insert into public.user_company_access(user_id,company_id) values
    (sa,c),(adm,c),(g1,c),(g2,c),(viewer,c),(other,c2);
  insert into public.sellers(id,company_id,name) values(s1,c,'Seller in team 1'),(s2,c,'Seller in team 2'),(s3,c2,'Seller elsewhere');
  insert into public.sales_teams(id,company_id,name) values(t1,c,'Team 1'),(t2,c,'Team 2');
  insert into public.sales_team_members(team_id,seller_id) values(t1,s1),(t2,s2);
  insert into public.sales_team_managers(team_id,user_id) values(t1,g1);
  insert into public.sales_targets(company_id,seller_id,year,month,level,amount) values(c,s1,2026,10,'ACTIVE',100);
  perform set_config('st.c',c::text,true); perform set_config('st.c2',c2::text,true);
  perform set_config('st.s1',s1::text,true); perform set_config('st.s2',s2::text,true); perform set_config('st.s3',s3::text,true);
  perform set_config('st.sa',sa::text,true); perform set_config('st.adm',adm::text,true);
  perform set_config('st.g1',g1::text,true); perform set_config('st.g2',g2::text,true);
  perform set_config('st.viewer',viewer::text,true); perform set_config('st.other',other::text,true);
  -- One active value per seller, month and level.
  begin
    insert into public.sales_targets(company_id,seller_id,year,month,level,amount) values(c,s1,2026,10,'ACTIVE',1);
    raise exception 'duplicate active target accepted';
  exception when unique_violation then null;
  end;
end $$;

-- 1. SUPER_ADMIN: sees both sellers as editable, saves an update, an insert and a no-op.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('st.sa'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('st.c')::uuid; s1 text:=current_setting('st.s1'); s2 text:=current_setting('st.s2');
  g jsonb; res jsonb; v numeric;
begin
  g := public.sales_targets_grid(c,2026,10);
  if not (g->>'canEdit')::boolean then raise exception 'SUPER_ADMIN must edit'; end if;
  if jsonb_array_length(g->'sellers') <> 2 then raise exception 'SUPER_ADMIN must see 2 sellers: %', g; end if;
  if exists (select 1 from jsonb_array_elements(g->'sellers') e where not (e->>'editable')::boolean) then
    raise exception 'every row must be editable for SUPER_ADMIN'; end if;
  if (select (e->'targets'->>'ACTIVE')::numeric from jsonb_array_elements(g->'sellers') e where e->>'id' = s1) <> 100 then
    raise exception 'grid must show the existing ACTIVE target'; end if;
  res := public.save_sales_targets(c,2026,10,jsonb_build_array(
    jsonb_build_object('seller',s1,'level','ACTIVE','amount',150),
    jsonb_build_object('seller',s2,'level','BASE','amount',50.555),
    jsonb_build_object('seller',s1,'level','CHALLENGE','amount',null)));
  if res <> '{"saved": 2, "deleted": 0, "unchanged": 1}'::jsonb then raise exception 'unexpected save result %', res; end if;
  select amount into v from public.sales_targets where company_id=c and seller_id=s1::uuid and year=2026 and month=10 and level='ACTIVE';
  if v <> 150 then raise exception 'update not applied: %', v; end if;
  select amount into v from public.sales_targets where company_id=c and seller_id=s2::uuid and year=2026 and month=10 and level='BASE';
  if v <> 50.56 then raise exception 'insert must round to cents: %', v; end if;
  if (public.cockpit_summary(c,2026,10)->>'target')::numeric <> 150 then
    raise exception 'Cockpit must read the saved ACTIVE target: %', public.cockpit_summary(c,2026,10)->>'target'; end if;
  -- Direct writes stay denied even to SUPER_ADMIN.
  begin
    insert into public.sales_targets(company_id,seller_id,year,month,level,amount) values(c,s2::uuid,2026,11,'ACTIVE',1);
    raise exception 'direct insert accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sales_targets set amount = 1 where company_id = c;
    raise exception 'direct update accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.sales_targets where company_id = c;
    raise exception 'direct delete accepted';
  exception when insufficient_privilege then null;
  end;
  -- Validation.
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',s1,'level','ACTIVE','amount',-1)));
    raise exception 'negative accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',s1,'level','GOLD','amount',1)));
    raise exception 'bad level accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',s1,'level','ACTIVE','amount','10')));
    raise exception 'text amount accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('level','ACTIVE','amount',10)));
    raise exception 'missing seller accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_sales_targets(c,2026,13,jsonb_build_array(jsonb_build_object('seller',s1,'level','ACTIVE','amount',1)));
    raise exception 'month 13 accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_sales_targets(c,2026,10,'[]'::jsonb);
    raise exception 'empty batch accepted'; exception when invalid_parameter_value then null; end;
  -- A seller of another company is outside every scope.
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',current_setting('st.s3'),'level','ACTIVE','amount',1)));
    raise exception 'foreign seller accepted'; exception when insufficient_privilege then null; end;
  -- Clearing a cell deletes the value.
  res := public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',s2,'level','BASE','amount',null)));
  if res <> '{"saved": 0, "deleted": 1, "unchanged": 0}'::jsonb then raise exception 'clear result %', res; end if;
  raise notice 'PASS SUPER_ADMIN: update, insert, no-op, rounding, Cockpit, direct writes denied, validation, clear';
end $$;
reset role;

-- 2. GESTOR of team 1: sees and edits only seller 1; a batch touching seller 2 changes nothing.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('st.g1'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('st.c')::uuid; s1 text:=current_setting('st.s1'); s2 text:=current_setting('st.s2');
  g jsonb; res jsonb; v numeric;
begin
  g := public.sales_targets_grid(c,2026,10);
  if jsonb_array_length(g->'sellers') <> 1 or g->'sellers'->0->>'id' <> s1 or not (g->'sellers'->0->>'editable')::boolean then
    raise exception 'GESTOR must see only the managed seller as editable: %', g; end if;
  res := public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',s1,'level','BASE','amount',80)));
  if (res->>'saved')::int <> 1 then raise exception 'GESTOR save in scope failed %', res; end if;
  begin
    perform public.save_sales_targets(c,2026,10,jsonb_build_array(
      jsonb_build_object('seller',s1,'level','CHALLENGE','amount',999),
      jsonb_build_object('seller',s2,'level','ACTIVE','amount',10)));
    raise exception 'GESTOR changed a seller outside the team';
  exception when insufficient_privilege then null;
  end;
  select amount into v from public.sales_targets where company_id=c and seller_id=s1::uuid and year=2026 and month=10 and level='CHALLENGE';
  if v is not null then raise exception 'a rejected batch must not save any row'; end if;
  raise notice 'PASS GESTOR: own team only, rejected batch saves nothing';
end $$;
reset role;

-- 3. GESTOR without a team, VIEWER and an ADMIN of another company cannot write.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('st.g2'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('st.c')::uuid; g jsonb;
begin
  g := public.sales_targets_grid(c,2026,10);
  if jsonb_array_length(g->'sellers') <> 0 or (g->>'canEdit')::boolean then raise exception 'GESTOR without team must see nothing: %', g; end if;
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',current_setting('st.s1'),'level','ACTIVE','amount',1)));
    raise exception 'GESTOR without team saved'; exception when insufficient_privilege then null; end;
  raise notice 'PASS GESTOR without team: nothing visible or writable';
end $$;
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('st.viewer'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('st.c')::uuid; g jsonb;
begin
  g := public.sales_targets_grid(c,2026,10);
  if jsonb_array_length(g->'sellers') <> 2 or (g->>'canEdit')::boolean then raise exception 'VIEWER must read but not edit: %', g; end if;
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',current_setting('st.s1'),'level','ACTIVE','amount',1)));
    raise exception 'VIEWER saved'; exception when insufficient_privilege then null; end;
  raise notice 'PASS VIEWER: read only';
end $$;
reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('st.other'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('st.c')::uuid;
begin
  begin perform public.sales_targets_grid(c,2026,10);
    raise exception 'ADMIN of another company read the grid'; exception when insufficient_privilege then null; end;
  begin perform public.save_sales_targets(c,2026,10,jsonb_build_array(jsonb_build_object('seller',current_setting('st.s1'),'level','ACTIVE','amount',1)));
    raise exception 'ADMIN of another company saved'; exception when insufficient_privilege then null; end;
  raise notice 'PASS ADMIN of another company: no access';
end $$;
reset role;

-- 4. Audit trail and grants.
do $$
declare c uuid:=current_setting('st.c')::uuid;
begin
  if (select count(*) from public.audit_log where action='sales_targets.saved' and entity_id=c::text) <> 3 then
    raise exception 'expected 3 audited saves, got %', (select count(*) from public.audit_log where action='sales_targets.saved' and entity_id=c::text); end if;
  if not exists (select 1 from public.audit_log where action='sales_targets.saved' and actor_id=current_setting('st.g1')::uuid) then
    raise exception 'GESTOR save not audited'; end if;
  if has_function_privilege('anon','public.save_sales_targets(uuid,int,int,jsonb)','EXECUTE')
     or has_function_privilege('anon','public.sales_targets_grid(uuid,int,int)','EXECUTE')
     or has_function_privilege('authenticated','public.can_manage_seller_target(uuid,uuid,uuid)','EXECUTE') then
    raise exception 'targets functions have wrong grants'; end if;
  if has_table_privilege('authenticated','public.sales_targets','INSERT')
     or has_table_privilege('authenticated','public.sales_targets','UPDATE')
     or has_table_privilege('authenticated','public.sales_targets','DELETE') then
    raise exception 'signed-in users must not write sales_targets directly'; end if;
  raise notice 'PASS audit and grants';
end $$;
rollback;
select 'verify_sales_targets: OK';
