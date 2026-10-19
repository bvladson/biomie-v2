-- Run AFTER migration 0021 in staging: psql -v ON_ERROR_STOP=1 -f this-file.
-- All fixture rows, config changes and promotions are rolled back.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare
  real_company uuid:=gen_random_uuid(); demo_company uuid:=gen_random_uuid();
  buyer uuid:=gen_random_uuid(); demo_buyer uuid:=gen_random_uuid();
  p1 uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); p3 uuid:=gen_random_uuid(); dp uuid:=gen_random_uuid();
  demo_invoice uuid:=gen_random_uuid(); v numeric; original_items numeric; unit_qty numeric; x jsonb;
begin
  update public.metric_config set config=jsonb_set(config,'{valid_statuses}','["authorized"]'::jsonb) where metric_key='revenue';
  insert into public.companies(id,name,slug,is_demo,data_source,revenue_basis) values
    (real_company,'Contract fixture','contract-'||real_company,false,'OMIE_SHADOW','commercial_base'),
    (demo_company,'DEMO fixture','contract-'||demo_company,true,'DEMO','commercial_base');
  insert into public.customers(id,company_id,name,state,city,source,external_id) values
    (buyer,real_company,'Buyer','CE','Fortaleza','omie','customer'),
    (demo_buyer,demo_company,'DEMO buyer','CE','Fortaleza','demo',null);
  insert into public.products(id,company_id,name,category,base_price,source,external_id) values
    (p1,real_company,'P1','A',1,'omie','p1'),(p2,real_company,'P2','B',1,'omie','p2'),
    (p3,real_company,'P3','B',1,'omie','p3'),(dp,demo_company,'DEMO product','A',1,'demo',null);
  insert into public.canonical_invoices(company_id,external_id,number,status,competence_date,customer_external_id,
    gross_amount,goods_amount,freight_amount,insurance_amount,other_expenses_amount,
    operation_scope,business_channel,is_biomie_commercial_visible) values
    (real_company,'rounding','1','authorized','2026-10-01','customer',130,3,20,5,5,'commercial','varejo',true),
    (real_company,'remittance','2','authorized','2026-10-01','customer',100,1,0,0,0,'remittance','varejo',true),
    (real_company,'bid','3','authorized','2026-10-01','customer',50,1,0,0,0,'commercial','licitacao',false),
    (real_company,'unconfirmed','4','authorized','2026-10-01','customer',80,1,0,0,0,'unconfirmed','unconfirmed',false),
    (real_company,'cancelled','5','cancelled','2026-10-01','customer',20,1,0,0,0,'commercial','varejo',true);
  insert into public.canonical_invoice_items(company_id,invoice_external_id,item_sequence,product_external_id,quantity,unit_price,total) values
    (real_company,'rounding',1,'p1',0.1234,1,1),(real_company,'rounding',2,'p2',1,1,1),
    (real_company,'rounding',3,'p3',1,1,1),(real_company,'remittance',1,'p1',1,1,1),
    (real_company,'bid',1,'p1',1,1,1),(real_company,'unconfirmed',1,'p1',1,1,1),
    (real_company,'cancelled',1,'p1',1,1,1);
  perform public.promote_omie_gold(real_company,'invoices');
  select sum(amount) into v from public.fact_sales(real_company,'2026-10-01','2026-10-31');
  if v is distinct from 150::numeric then raise exception 'Expected commercial 150, got %',v; end if;
  select sum(amount) into v from public.fact_sales(real_company,'2026-10-01','2026-10-31',null,null,null,null,null,'B');
  if v is distinct from 66.67::numeric then raise exception 'Category filter recomputed allocation: expected 66.67, got %',v; end if;
  select a.amount into v from public.invoice_item_amounts(real_company,'2026-10-01','2026-10-31') a
    join public.invoice_items it on it.id=a.item_id join public.invoices i on i.id=it.invoice_id
    where i.external_id='rounding' and it.item_sequence=3;
  if v is distinct from 33.34::numeric then raise exception 'Final cent residue: expected 33.34, got %',v; end if;
  select sum(it.total),min(it.quantity) into original_items,unit_qty from public.invoice_items it join public.invoices i on i.id=it.invoice_id
    where i.company_id=real_company and i.external_id='rounding';
  if original_items is distinct from 3::numeric or unit_qty is distinct from 0.1234::numeric then raise exception 'Fiscal item total or quantity changed'; end if;
  select sum(total) into v from public.invoices where company_id=real_company and external_id='rounding';
  if v is distinct from 100::numeric then raise exception 'Commercial header formula failed: %',v; end if;
  select public.sales_invoices(real_company,'2026-10-01','2026-10-31') into x;
  if exists(select 1 from jsonb_array_elements(x) r where r->>'number' in ('2','4','5') and (r->>'counted')::boolean)
    then raise exception 'Excluded document is marked counted'; end if;
  select public.customers_overview(real_company,'2026-10-01','2026-10-31','2026-10-31') into x;
  if (x#>>'{rows,0,lifetimeRevenue}')::numeric is distinct from 150::numeric then raise exception 'Customer lifetime uses another basis'; end if;
  select public.customer_360(real_company,buyer,'2026-10-01','2026-10-31','2026-10-31') into x;
  if (x#>>'{lifetime,revenue}')::numeric is distinct from 150::numeric then raise exception 'Customer 360 uses another basis'; end if;
  -- A source-precomputed commercial base takes priority over recalculating the header.
  update public.canonical_invoices set commercial_base_amount=90.04 where company_id=real_company and external_id='rounding';
  perform public.promote_omie_gold(real_company,'invoices');
  perform public.promote_omie_gold(real_company,'invoices');
  select sum(amount) into v from public.fact_sales(real_company,'2026-10-01','2026-10-31');
  if v is distinct from 140.04::numeric then raise exception 'Source base/reprocessing failed: %',v; end if;
  if (select count(*) from public.invoices where company_id=real_company)<>5 then raise exception 'Reprocessing duplicated invoices'; end if;
  if (select count(*) from public.invoice_items where company_id=real_company)<>7 then raise exception 'Reprocessing duplicated items'; end if;
  insert into public.invoices(id,company_id,customer_id,number,competence_date,total,gross_amount,source)
    values(demo_invoice,demo_company,demo_buyer,'DEMO','2026-10-01',1000,1000,'demo');
  insert into public.invoice_items(invoice_id,company_id,product_id,quantity,total) values(demo_invoice,demo_company,dp,1,5);
  select sum(amount) into v from public.fact_sales(demo_company,'2026-10-01','2026-10-31');
  if v is distinct from 5::numeric then raise exception 'DEMO changed: %',v; end if;
  -- Invalid allocation must fail explicitly, rather than silently returning zero revenue.
  update public.invoice_items set total=0 where invoice_id in(select id from public.invoices where company_id=real_company and external_id='rounding');
  begin
    perform sum(amount) from public.fact_sales(real_company,'2026-10-01','2026-10-31');
    raise exception 'Zero source item sum did not fail';
  exception when division_by_zero then null;
  end;
  raise notice 'Commercial contract fixture passed (all writes rolled back).';
end $$;
rollback;
