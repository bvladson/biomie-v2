\set ON_ERROR_STOP on
-- Isolated synthetic Auth user and business data. Nothing survives ROLLBACK.
begin;
do $$
declare u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); p uuid:=gen_random_uuid();
  cv uuid:=gen_random_uuid(); cl uuid:=gen_random_uuid(); cu uuid:=gen_random_uuid(); iv uuid:=gen_random_uuid(); il uuid:=gen_random_uuid(); iu uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(u,'channel-fixture-'||u||'@invalid.example');
  insert into public.profiles(id) values(u);
  insert into public.user_roles(user_id,role) values(u,'FINANCEIRO');
  insert into public.companies(id,name,slug,data_source,revenue_basis) values(c,'Channel fixture','channel-'||c,'OMIE_SHADOW','commercial_base');
  insert into public.user_company_access(user_id,company_id) values(u,c);
  insert into private.legacy_company_access(user_id,company_id,allowed_channels,legacy_role) values(u,c,array['varejo'],'fixture');
  insert into public.sellers(id,company_id,name,user_id) values(s,c,'Synthetic seller',u);
  insert into public.products(id,company_id,name,category,base_price) values(p,c,'Synthetic product','Test',1);
  insert into public.customers(id,company_id,name,state,city,document) values
    (cv,c,'Retail fixture','SP','Test','12345678000195'),(cl,c,'Bidding fixture','SP','Test','12345678000195'),(cu,c,'Unknown fixture','SP','Test','12345678000195');
  insert into public.invoices(id,company_id,seller_id,customer_id,number,competence_date,total,source,external_id,
    gross_amount,goods_amount,commercial_base_amount,operation_scope,business_channel,is_biomie_commercial_visible) values
    (iv,c,s,cv,'V',current_date,100,'omie','channel-v',100,100,100,'commercial','varejo',true),
    (il,c,s,cl,'L',current_date,200,'omie','channel-l',200,200,200,'commercial','licitacao',true),
    (iu,c,s,cu,'U',current_date,300,'omie','channel-u',300,300,300,'commercial','unconfirmed',true);
  insert into public.invoice_items(invoice_id,company_id,seller_id,product_id,quantity,total,item_sequence) values
    (iv,c,s,p,1,100,1),(il,c,s,p,1,200,1),(iu,c,s,p,1,300,1);
  insert into public.sales_orders(company_id,seller_id,customer_id,number,order_date,total,business_channel) values
    (c,s,cv,'V',current_date,30,'varejo'),(c,s,cl,'L',current_date,70,'licitacao');
  insert into public.financial_titles(company_id,customer_id,invoice_id,seller_id,document_number,issue_date,competence_date,due_date,original_amount,business_channel) values
    (c,cv,iv,s,'V',current_date,current_date,current_date+10,100,'varejo'),
    (c,cl,il,s,'L',current_date,current_date,current_date+10,200,'licitacao'),
    (c,cu,iu,s,'U',current_date,current_date,current_date+10,300,'unconfirmed');
  perform set_config('biomie.test_company',c::text,true);
  perform set_config('biomie.test_customer_forbidden',cl::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
end $$;

set local role authenticated;
do $$
declare c uuid:=current_setting('biomie.test_company')::uuid; forbidden_customer uuid:=current_setting('biomie.test_customer_forbidden')::uuid;
  summary jsonb; titles jsonb; revenue numeric;
begin
  if not public.legacy_channel_allowed(c,'varejo') or public.legacy_channel_allowed(c,'licitacao')
    or public.legacy_channel_allowed(c,'unconfirmed') or public.legacy_channel_allowed(c,null) then raise exception 'Channel grant mismatch'; end if;
  if (select count(*) from public.invoices where company_id=c)<>1 then raise exception 'Invoice RLS leaked channel'; end if;
  if (select count(*) from public.invoice_items where company_id=c)<>1 then raise exception 'Item RLS leaked channel'; end if;
  if (select count(*) from public.sales_orders where company_id=c)<>1 then raise exception 'Order RLS leaked channel'; end if;
  if (select count(*) from public.financial_titles where company_id=c)<>1 then raise exception 'Finance table RLS leaked channel'; end if;
  if public.customer_document(forbidden_customer) is not null then raise exception 'Document RPC leaked channel'; end if;
  select sum(amount) into revenue from public.fact_sales(c,current_date,current_date);
  if revenue is distinct from 100::numeric then raise exception 'Revenue RPC leaked channel: %',revenue; end if;
  summary:=public.finance_summary(c,current_date,current_date+30);
  if (summary->>'open')::numeric is distinct from 100::numeric or (summary->>'receivable')::numeric is distinct from 100::numeric then
    raise exception 'SECURITY DEFINER finance summary leaked channel'; end if;
  titles:=public.finance_titles_list(c,current_date,current_date+30);
  if jsonb_array_length(titles->'rows')<>1 then raise exception 'Finance titles RPC leaked channel'; end if;
  raise notice 'PASS: restrictive channel RLS, unknown denial, document RPC, revenue and privileged finance RPC';
end $$;
reset role;
do $$
declare c uuid:=current_setting('biomie.test_company')::uuid; summary jsonb;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  summary:=public.finance_summary(c,current_date,current_date+30);
  if (summary->>'open')::numeric is distinct from 600::numeric then raise exception 'Trusted job cannot see full financial dataset'; end if;
end $$;
rollback;
