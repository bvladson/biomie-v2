\set ON_ERROR_STOP on
-- Company = authorization, channel = filter (migrations 0031-0033).
-- Synthetic users/companies only; everything is rolled back. Run on the TEST database.
begin;
-- The fixture dates use current_date and the functions use data_as_of (São Paulo date). With the server in
-- UTC the two differ from 21:00 to 24:00 (São Paulo) and the finance check saw 0 open titles at any release.
set local time zone 'America/Sao_Paulo';
do $$
declare
  hist uuid:=gen_random_uuid(); sa uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); adm uuid:=gen_random_uuid();
  c uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); p uuid:=gen_random_uuid();
  cv uuid:=gen_random_uuid(); cl uuid:=gen_random_uuid(); cg uuid:=gen_random_uuid();
  iv uuid:=gen_random_uuid(); il uuid:=gen_random_uuid(); ig uuid:=gen_random_uuid(); ir uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values
    (hist,'hist-'||hist||'@invalid.example'),(sa,'sa-'||sa||'@invalid.example'),
    (outsider,'out-'||outsider||'@invalid.example'),(adm,'adm-'||adm||'@invalid.example');
  insert into public.profiles(id) values(hist),(sa),(outsider),(adm);
  insert into public.user_roles(user_id,role) values(hist,'FINANCEIRO'),(sa,'SUPER_ADMIN'),(outsider,'FINANCEIRO'),(adm,'ADMIN');
  insert into public.companies(id,name,slug,data_source,revenue_basis) values(c,'Channel filter fixture','chf-'||c,'OMIE_SHADOW','commercial_base');
  insert into public.channels(company_id,name) values(c,'varejo'),(c,'licitacao'),(c,'outros');
  insert into public.user_company_access(user_id,company_id) values(hist,c),(adm,c);
  -- Historical legacy restrictions that must NOT hide data anymore.
  insert into private.legacy_company_access(user_id,company_id,allowed_channels,legacy_role) values
    (hist,c,array['varejo'],'fixture'),(sa,c,array['licitacao'],'fixture');
  insert into public.sellers(id,company_id,name) values(s,c,'Synthetic seller');
  insert into public.products(id,company_id,name,category,base_price) values(p,c,'Synthetic product','Test',1);
  insert into public.customers(id,company_id,name,state,city,document) values
    (cv,c,'Retail','CE','Fortaleza','12345678000195'),(cl,c,'Public body','CE','Fortaleza','12345678000195'),
    (cg,c,'Group company','CE','Fortaleza','12345678000195');
  insert into public.invoices(id,company_id,seller_id,customer_id,number,competence_date,total,source,external_id,
    gross_amount,goods_amount,commercial_base_amount,operation_scope,business_channel,is_biomie_commercial_visible) values
    (iv,c,s,cv,'V',current_date,100,'omie','chf-v',100,100,100,'commercial','varejo',true),
    (il,c,s,cl,'L',current_date,200,'omie','chf-l',200,200,200,'commercial','licitacao',false),
    (ig,c,s,cg,'G',current_date,300,'omie','chf-g',300,300,300,'commercial','outros',false),
    (ir,c,s,cv,'R',current_date,400,'omie','chf-r',400,400,400,'remittance','varejo',true);
  insert into public.invoice_items(invoice_id,company_id,seller_id,product_id,quantity,total,item_sequence) values
    (iv,c,s,p,1,100,1),(il,c,s,p,1,200,1),(ig,c,s,p,1,300,1),(ir,c,s,p,1,400,1);
  insert into public.financial_titles(company_id,customer_id,invoice_id,seller_id,document_number,issue_date,competence_date,due_date,original_amount,business_channel) values
    (c,cv,iv,s,'V',current_date,current_date,current_date+10,100,'varejo'),
    (c,cl,il,s,'L',current_date,current_date,current_date+10,200,'licitacao'),
    (c,cv,null,s,'NOINV',current_date,current_date,current_date+10,50,'licitacao');
  perform set_config('chf.company',c::text,true);
  perform set_config('chf.hist',hist::text,true);
  perform set_config('chf.sa',sa::text,true);
  perform set_config('chf.outsider',outsider::text,true);
  perform set_config('chf.adm',adm::text,true);
  perform set_config('chf.customer_bid',cl::text,true);
end $$;

-- channel_id is derived from business_channel (the global Canal filter depends on it)
do $$
declare c uuid:=current_setting('chf.company')::uuid;
begin
  if exists(select 1 from public.invoices i left join public.channels ch on ch.id=i.channel_id
            where i.company_id=c and (ch.id is null or lower(ch.name)<>i.business_channel)) then
    raise exception 'channel_id not derived from business_channel';
  end if;
end $$;

-- 1. User with a historical single-channel grant sees every authorized row.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('chf.hist'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('chf.company')::uuid; v numeric; vch uuid; lch uuid; summary jsonb;
begin
  if (select count(*) from public.invoices where company_id=c)<>4 then raise exception 'Channel still restricts invoices'; end if;
  if (select count(*) from public.financial_titles where company_id=c)<>3 then raise exception 'Channel still restricts titles'; end if;
  if public.customer_document(current_setting('chf.customer_bid')::uuid) is null then raise exception 'Channel still hides documents'; end if;
  select sum(amount) into v from public.fact_sales(c,current_date,current_date);
  if v is distinct from 300::numeric then raise exception 'Revenue must be varejo+licitacao (300), got %',v; end if;
  select id into vch from public.channels where company_id=c and name='varejo';
  select id into lch from public.channels where company_id=c and name='licitacao';
  select sum(amount) into v from public.fact_sales(c,current_date,current_date,vch);
  if v is distinct from 100::numeric then raise exception 'Varejo filter expected 100, got %',v; end if;
  select sum(amount) into v from public.fact_sales(c,current_date,current_date,lch);
  if v is distinct from 200::numeric then raise exception 'Licitacao filter expected 200, got %',v; end if;
  summary:=public.finance_summary(c,current_date,current_date+30);
  if (summary->>'open')::numeric is distinct from 350::numeric then raise exception 'Finance must not be channel-restricted: %',summary->>'open'; end if;
  raise notice 'PASS historical grant: all channels visible, filter works, revenue 300';
end $$;
reset role;

-- 2. SUPER_ADMIN with a partial legacy grant sees all channels.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('chf.sa'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('chf.company')::uuid; v numeric;
begin
  select sum(amount) into v from public.fact_sales(c,current_date,current_date);
  if v is distinct from 300::numeric then raise exception 'SUPER_ADMIN revenue expected 300, got %',v; end if;
  raise notice 'PASS super admin sees all channels';
end $$;
reset role;

-- 3. Company remains the authorization boundary.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('chf.outsider'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('chf.company')::uuid; denied boolean:=false;
begin
  if (select count(*) from public.invoices where company_id=c)<>0 then raise exception 'Outsider sees another company'; end if;
  begin
    perform public.fact_sales(c,current_date,current_date);
    perform public.sales_kpis(c,current_date,current_date);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Outsider reached company read model'; end if;
  raise notice 'PASS company authorization enforced';
end $$;
reset role;

-- 4. Plaintext credentials and worker control are refused to an ADMIN.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('chf.adm'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c uuid:=current_setting('chf.company')::uuid; refused boolean:=false;
begin
  begin
    perform public.set_integration_credentials_encrypted(c,'omie','plain-key','plain-secret','••••1234');
  exception when others then refused:=true; end;
  if not refused then raise exception 'Plaintext credentials accepted'; end if;
  refused:=false;
  begin perform public.set_worker_control(true,null,'x'); exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'ADMIN controlled the worker'; end if;
  refused:=false;
  begin perform public.record_integration_test(c,'omie','CONNECTED',true,'x'); exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Client recorded an integration test'; end if;
  raise notice 'PASS credentials only encrypted, worker/test status server-only';
end $$;
reset role;

-- 5. Direct plaintext writes violate the table constraint.
do $$
declare c uuid:=current_setting('chf.company')::uuid; refused boolean:=false;
begin
  begin
    insert into private.integration_credentials(company_id,provider,app_key,app_secret) values(c,'omie','plain','plain');
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Plaintext row stored'; end if;
  raise notice 'PASS plaintext rows rejected by constraint';
end $$;

-- 6. DEMO companies disappear for everyone when production hides them.
do $$
declare d uuid:=gen_random_uuid(); sa uuid:=current_setting('chf.sa')::uuid;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.companies(id,name,slug,is_demo,data_source) values(d,'Demo fixture','demo-'||d,true,'DEMO');
  perform public.set_demo_visibility(false);
  if public.can_access_company(sa,d) or (public.accessible_company_ids(sa) @> array[d]) then
    raise exception 'Hidden DEMO still visible to SUPER_ADMIN';
  end if;
  if not public.can_access_company(sa,current_setting('chf.company')::uuid) then raise exception 'Real company hidden'; end if;
  perform public.set_demo_visibility(true);
  if not public.can_access_company(sa,d) then raise exception 'DEMO visibility not restored'; end if;
  raise notice 'PASS DEMO visibility switch';
end $$;
rollback;
