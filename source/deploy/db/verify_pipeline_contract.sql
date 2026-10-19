\set ON_ERROR_STOP on
-- Database contract of the transactional Omie pipeline: the same calls the
-- TypeScript sync makes, for every entity, with the real column sets.
-- Synthetic data only; everything is rolled back. Run on the TEST database.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare
  c uuid:=gen_random_uuid(); run_inv uuid; run_ord uuid; run_rec uuid; run_set uuid;
  ing jsonb; v numeric; n int; cov jsonb;
begin
  insert into public.companies(id,name,slug,data_source,revenue_basis) values(c,'Pipeline fixture','pipe-'||c,'OMIE_SHADOW','commercial_base');
  insert into public.channels(company_id,name) values(c,'varejo'),(c,'licitacao'),(c,'outros');
  insert into public.sellers(company_id,name,source,external_id) values(c,'Licitação','omie','900'),(c,'Vendedor','omie','100');
  insert into public.customers(company_id,name,state,city,source,external_id) values(c,'Cliente','CE','Fortaleza','omie','1');
  insert into public.products(company_id,name,category,base_price,source,external_id) values(c,'Produto','A',1,'omie','p1');

  -- Runs exactly as the pipeline writes them (modes PERIOD/BACKFILL, all entities).
  insert into public.integration_sync_runs(company_id,entity,mode,status,period_from,period_to,checkpoint_start,checkpoint_end)
    values(c,'invoices','BACKFILL','RUNNING','2026-01-01','2026-01-31','{"partition":0,"page":1}','{"partition":0,"page":1}') returning id into run_inv;
  insert into public.integration_sync_runs(company_id,entity,mode,status,period_from,period_to)
    values(c,'orders','PERIOD','RUNNING','2026-01-01','2026-01-31') returning id into run_ord;
  insert into public.integration_sync_runs(company_id,entity,mode,status,period_from,period_to)
    values(c,'receivables','BACKFILL','RUNNING','2026-01-01','2026-01-31') returning id into run_rec;
  insert into public.integration_sync_runs(company_id,entity,mode,status,period_from,period_to)
    values(c,'settlements','PERIOD','RUNNING','2026-01-01','2026-01-31') returning id into run_set;

  -- RAW for every entity.
  ing:=public.ingest_omie_raw('invoices',c,run_inv,'[{"external_id":"nf1","payload":{"a":1},"method":"ListarNF","page":1,"requested_period":{"from":"2026-01-01","to":"2026-01-31"}},{"external_id":"nf2","payload":{"a":2},"method":"ListarNF","page":1}]');
  if (ing->>'created')::int<>2 then raise exception 'RAW invoices: %',ing; end if;
  perform public.ingest_omie_raw('orders',c,run_ord,'[{"external_id":"o1","payload":{"a":1},"method":"ListarPedidos","page":1}]');
  perform public.ingest_omie_raw('receivables',c,run_rec,'[{"external_id":"t1","payload":{"a":1},"method":"ListarContasReceber","page":1}]');
  perform public.ingest_omie_raw('settlements',c,run_set,'[{"external_id":"b1","payload":{"a":1},"method":"ListarMovimentos","page":1}]');
  perform public.mark_raw_processed('invoices',c,array[(ing->'ids'->>'nf1')::uuid],'CANONICAL');

  -- Canonical headers with every column the classifier writes.
  insert into public.canonical_invoices(company_id,source,external_id,sync_run_id,last_seen_run_id,number,status,issue_date,competence_date,
      customer_external_id,seller_external_id,gross_amount,goods_amount,freight_amount,insurance_amount,other_expenses_amount,discount_amount,
      operation_scope,business_channel,channel_reason,is_biomie_commercial_visible,commercial_base_amount)
    values(c,'omie','nf1',run_inv,run_inv,'1','authorized','2026-01-10','2026-01-10','1','100',1150,1000,100,20,40,0,'commercial','varejo','default_varejo',true,990),
          (c,'omie','nf2',run_inv,run_inv,'2','authorized','2026-01-11','2026-01-11','1','900',500,500,0,0,0,0,'commercial','licitacao','licitacao_seller_code',false,500);
  n:=public.replace_omie_canonical_items(c,'invoices',run_inv,
    '[{"external_id":"nf1","items":[{"item_sequence":1,"product_external_id":"p1","description":"x","quantity":1,"unit_price":1000,"total":1000}]},
      {"external_id":"nf2","items":[{"item_sequence":1,"product_external_id":"p1","description":"y","quantity":1,"unit_price":500,"total":500}]}]');
  insert into public.canonical_orders(company_id,source,external_id,sync_run_id,last_seen_run_id,number,status,order_date,expected_date,
      customer_external_id,seller_external_id,total,operation_scope,stage_code,business_channel,channel_reason)
    values(c,'omie','o1',run_ord,run_ord,'P1','open','2026-01-05',null,'1','100',300,'commercial','50','varejo','default_varejo');
  perform public.replace_omie_canonical_items(c,'orders',run_ord,
    '[{"external_id":"o1","items":[{"item_sequence":1,"product_external_id":"p1","description":"z","quantity":3,"unit_price":100,"total":300}]}]');
  insert into public.canonical_receivables(company_id,source,external_id,sync_run_id,last_seen_run_id,document_number,installment,installments,
      customer_external_id,seller_external_id,invoice_external_id,issue_date,competence_date,due_date,expected_date,original_amount,
      source_status,cancelled_at,category_code,account_external_id,business_channel,channel_reason)
    values(c,'omie','t1',run_rec,run_rec,'1',1,1,'1','100','nf1','2026-01-10','2026-01-10','2026-02-10',null,1150,'A VENCER',null,'1.01',null,'varejo','default_varejo');
  insert into public.canonical_settlements(company_id,source,external_id,sync_run_id,receivable_external_id,settlement_date,amount,account_external_id)
    values(c,'omie','b1',run_set,'t1','2026-01-20',400,null);

  -- Gold promotion and read models.
  perform public.promote_omie_gold(c,'invoices');
  perform public.promote_omie_gold(c,'orders');
  perform public.promote_omie_gold(c,'receivables');
  select sum(amount) into v from public.fact_sales(c,'2026-01-01','2026-01-31');
  if v is distinct from 1490::numeric then raise exception 'Revenue expected 990+500, got %',v; end if;
  if exists(select 1 from public.invoices where company_id=c and channel_id is null) then raise exception 'Gold invoice without channel_id'; end if;
  select count(*) into n from public.fact_orders(c) where order_date between '2026-01-01' and '2026-01-31';
  if n<>1 then raise exception 'Commercial order missing from portfolio: %',n; end if;
  select paid into v from public.finance_title_facts(c,'2026-01-31') limit 1;
  if v is distinct from 400::numeric then raise exception 'Settlement not linked to title: %',v; end if;
  perform public.run_integrity_checks(c);

  update public.integration_sync_runs set status='SUCCESS',finished_at=now(),raw_complete=true,canonical_complete=true,gold_complete=true
    where id in (run_inv,run_ord,run_rec,run_set);
  cov:=public.data_coverage(c);
  if cov#>>'{entities,invoices,0,from}'<>'2026-01-01' or cov#>>'{entities,settlements,0,to}'<>'2026-01-31' then
    raise exception 'Coverage wrong: %',cov;
  end if;
  raise notice 'PASS pipeline contract: runs, RAW, canonical, items, Gold, revenue 1490, portfolio, settlement, coverage';
end $$;
rollback;
