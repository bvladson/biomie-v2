\set ON_ERROR_STOP on
-- Finance contract of the settlement rules found in the real load (19/10/2026):
-- taxes withheld by the customer, settlements made only by discount, interest paid
-- at settlement, batch receipts and titles received in Omie without a settlement.
-- Synthetic data only; everything is rolled back. Run on the TEST database.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$
declare c uuid:=gen_random_uuid(); r record; v numeric; n int; v_run uuid; v_status text; cov jsonb;
begin
  insert into public.companies(id,name,slug,data_source,revenue_basis) values(c,'Finance fixture','fin-'||c,'OMIE_SHADOW','commercial_base');
  insert into public.channels(company_id,name) values(c,'varejo'),(c,'licitacao'),(c,'outros');
  insert into public.sellers(company_id,name,source,external_id) values(c,'Vendedor','omie','100');
  insert into public.customers(company_id,name,state,city,source,external_id) values(c,'Orgao publico','CE','Fortaleza','omie','1');

  -- t1: 8,500 with 497.25 withheld (5.85%), its share of a batch deposit was 8,002.75.
  -- t2: 18,000 settled only by discount. t3: 1,000 paid late with 20 of interest.
  -- t4: 1,000 partially received (400). t5: received in Omie, no settlement imported.
  insert into public.canonical_receivables(company_id,source,external_id,document_number,installment,installments,customer_external_id,
      seller_external_id,issue_date,competence_date,due_date,original_amount,tax_withheld_amount,source_status,business_channel,channel_reason)
    values (c,'omie','t1','1',1,1,'1','100','2026-03-01','2026-03-01','2026-03-20',8500,497.25,'RECEBIDO','licitacao','licitacao_seller_code'),
           (c,'omie','t2','2',1,1,'1','100','2026-07-07','2026-07-07','2026-08-03',18000,0,'RECEBIDO','varejo','default_varejo'),
           (c,'omie','t3','3',1,1,'1','100','2026-01-05','2026-01-05','2026-01-10',1000,0,'RECEBIDO','varejo','default_varejo'),
           (c,'omie','t4','4',1,1,'1','100','2026-01-05','2026-01-05','2026-12-10',1000,0,'A VENCER','varejo','default_varejo'),
           (c,'omie','t5','5',1,1,'1','100','2026-02-01','2026-02-01','2026-02-10',529,0,'RECEBIDO','varejo','default_varejo');
  insert into public.canonical_settlements(company_id,source,external_id,receivable_external_id,settlement_date,amount,discount_amount,interest_amount,fine_amount)
    values (c,'omie','b1','t1','2026-03-20',8002.75,0,0,0),
           (c,'omie','b2','t2','2026-08-04',0,18000,0,0),
           (c,'omie','b3','t3','2026-01-20',1020,0,20,0),
           (c,'omie','b4','t4','2026-02-01',400,0,0,0);
  perform public.promote_omie_gold(c,'receivables');

  -- Gold carries the new columns.
  select tax_withheld_amount into v from public.financial_titles where company_id=c and external_id='t1';
  if v <> 497.25 then raise exception 'Gold withheld %', v; end if;
  select discount_amount into v from public.financial_settlements where company_id=c and external_id='b2';
  if v <> 18000 then raise exception 'Gold settlement discount %', v; end if;

  -- Position on 19/10/2026: t1, t2 and t3 closed; t4 has 600 open; t5 stays open (honest, flagged below).
  select count(*) into n from public.finance_title_facts(c,'2026-10-19');
  if n <> 5 then raise exception 'expected 5 titles, got %', n; end if;
  for r in select * from public.finance_title_facts(c,'2026-10-19') loop
    if r.document_number in ('1','2','3') and (r.open <> 0 or r.status <> 'PAID') then
      raise exception 'title % should be PAID with no balance: open=% status=%', r.document_number, r.open, r.status; end if;
    if r.document_number = '4' and r.open <> 600 then raise exception 't4 open %', r.open; end if;
    if r.document_number = '5' and r.open <> 529 then raise exception 't5 open %', r.open; end if;
  end loop;
  -- Adjustments only apply from the settlement date on.
  select open into v from public.finance_title_facts(c,'2026-08-03') where document_number='2';
  if v <> 18000 then raise exception 't2 open before the discount %', v; end if;
  select open into v from public.finance_title_facts(c,'2026-01-15') where document_number='3';
  if v <> 1000 then raise exception 't3 open before payment %', v; end if;
  -- Cash received is the deposit share; a discount is never cash.
  select sum(amount) into v from public.financial_settlements where company_id=c;
  if v <> 9422.75 then raise exception 'cash received %', v; end if;

  -- Integrity: nothing overpaid; t5 is flagged without blocking readiness (MEDIUM).
  perform public.run_integrity_checks(c);
  if exists(select 1 from public.integrity_issues where company_id=c and check_key='overpaid_title' and status='OPEN') then
    raise exception 'overpaid_title must not fire'; end if;
  if not exists(select 1 from public.integrity_issues where company_id=c and check_key='received_title_without_settlement'
      and external_id='t5' and severity='MEDIUM' and status='OPEN') then
    raise exception 'received_title_without_settlement missing'; end if;
  -- A real overpayment is still detected.
  insert into public.canonical_settlements(company_id,source,external_id,receivable_external_id,settlement_date,amount)
    values (c,'omie','b5','t4','2026-02-02',700);
  perform public.run_integrity_checks(c);
  if not exists(select 1 from public.integrity_issues where company_id=c and check_key='overpaid_title' and external_id='t4' and status='OPEN') then
    raise exception 'overpaid_title must fire for t4'; end if;
  delete from public.canonical_settlements where company_id=c and external_id='b5';

  -- A settlement with neither cash nor discount is rejected in Canonical and Gold.
  begin
    insert into public.canonical_settlements(company_id,source,external_id,receivable_external_id,settlement_date,amount)
      values (c,'omie','b6','t4','2026-02-03',0);
    raise exception 'zero canonical settlement accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.financial_settlements(title_id,company_id,settlement_date,amount,source,external_id)
      select id, c, '2026-02-03', 0, 'omie', 'b6' from public.financial_titles where company_id=c and external_id='t4';
    raise exception 'zero Gold settlement accepted';
  exception when check_violation then null;
  end;

  -- The Quality page reconciliation agrees with the per-title balance.
  v_run := public.run_reconciliation(c, '2026-10');
  select status into v_status from public.reconciliation_results where run_id=v_run and check_key='finance_balance';
  if v_status is distinct from 'OK' then raise exception 'finance_balance reconciliation %', v_status; end if;

  -- A REPROCESS run certifies Canonical/Gold for the proven period (coverage sees it).
  insert into public.integration_sync_runs(company_id,entity,mode,status,period_from,period_to,started_at,finished_at,raw_complete,canonical_complete,gold_complete)
    values (c,'settlements','REPROCESS','SUCCESS','2026-01-01','2026-10-19',now(),now(),true,true,true);
  cov := public.data_coverage(c);
  if cov->'entities'->'settlements'->0->>'from' is distinct from '2026-01-01' then raise exception 'coverage %', cov; end if;
end $$;
rollback;
select 'verify_finance_adjustments: OK';
