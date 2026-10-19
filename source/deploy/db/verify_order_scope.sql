\set ON_ERROR_STOP on
begin;
do $$
declare c uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); value numeric;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.companies(id,name,slug,data_source,revenue_basis) values(c,'Order fixture','orders-'||c,'OMIE_SHADOW','commercial_base');
  insert into public.integration_sync_runs(id,company_id,entity,status) values(r,c,'orders','SUCCESS');
  insert into public.canonical_orders(company_id,external_id,sync_run_id,number,status,order_date,total,business_channel,operation_scope,stage_code) values
    (c,'accepted',r,'A','open',current_date,100,'varejo','commercial','20'),
    (c,'quote',r,'Q','open',current_date,200,'varejo','commercial','10'),
    (c,'remittance',r,'R','open',current_date,300,'varejo','remittance','20'),
    (c,'unknown-scope',r,'U','open',current_date,400,'varejo','unconfirmed','20'),
    (c,'unknown-stage',r,'S','open',current_date,500,'varejo','commercial',null);
  perform public.replace_omie_canonical_items(c,'orders',r,'[
    {"external_id":"accepted","items":[{"item_sequence":1,"quantity":1,"unit_price":100,"total":100}]},
    {"external_id":"quote","items":[{"item_sequence":1,"quantity":1,"unit_price":200,"total":200}]},
    {"external_id":"remittance","items":[{"item_sequence":1,"quantity":1,"unit_price":300,"total":300}]},
    {"external_id":"unknown-scope","items":[{"item_sequence":1,"quantity":1,"unit_price":400,"total":400}]},
    {"external_id":"unknown-stage","items":[{"item_sequence":1,"quantity":1,"unit_price":500,"total":500}]}]');
  perform public.promote_omie_gold(c,'orders');
  select sum(amount) into value from public.fact_orders(c) where status='open';
  if value is distinct from 100::numeric then raise exception 'Quotation/remittance/unconfirmed inflated portfolio: %',value; end if;
  if (select count(*) from public.sales_orders where company_id=c)<>5 then raise exception 'Excluded orders were deleted'; end if;
  update public.canonical_orders set stage_code='20' where company_id=c and external_id='quote';
  perform public.promote_omie_gold(c,'orders');
  select sum(amount) into value from public.fact_orders(c) where status='open';
  if value is distinct from 300::numeric then raise exception 'Quotation acceptance did not propagate: %',value; end if;
  update public.canonical_orders set operation_scope='remittance' where company_id=c and external_id='accepted';
  perform public.promote_omie_gold(c,'orders');
  select sum(amount) into value from public.fact_orders(c) where status='open';
  if value is distinct from 200::numeric then raise exception 'Operation change did not propagate: %',value; end if;
  raise notice 'PASS: portfolio excludes quotations/remittances/unconfirmed, Gold retains records, stage/operation updates propagate';
end $$;
rollback;
