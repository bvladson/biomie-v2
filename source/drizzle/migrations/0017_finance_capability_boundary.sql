-- Restrict inference of overdue balances when finance.view_overdue is absent.
create or replace function public.finance_summary(
  p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ref date; v_overdue boolean; v_restricted boolean; v_vis uuid[]; r jsonb;
begin
  perform public.finance_assert(p_company, 'finance.view_summary');
  v_ref := least(p_end, public.data_as_of(p_company));
  v_overdue := public.has_finance_capability('finance.view_overdue');
  v_restricted := not public.is_service_request() and public.is_seller_restricted(auth.uid());
  v_vis := case when v_restricted then public.visible_seller_ids(auth.uid()) else null end;

  with f as (
    select * from public.finance_title_facts(p_company, v_ref, p_channel, p_branch, p_seller, p_state, p_city) x
    where not v_restricted or x.seller_id = any(v_vis)
  ), act as (select * from f where not cancelled),
  st as (
    select s.amount, s.settlement_date, a.issue_date, a.due_date, a.customer_id
    from public.financial_settlements s join act a on a.title_id = s.title_id
    where s.settlement_date between p_start and v_ref
  ), ag as (
    select case when v_ref - due_date <= 0 then 'future'
                when v_ref - due_date <= 30 then 'd1_30'
                when v_ref - due_date <= 60 then 'd31_60'
                when v_ref - due_date <= 90 then 'd61_90'
                when v_ref - due_date <= 180 then 'd91_180'
                else 'd180p' end bucket, open, customer_id, title_id
    from act where open > 0
  ), months as (
    select to_char(d, 'YYYY-MM') ym, d::date ms
    from generate_series(date_trunc('month', p_end) - interval '11 months', date_trunc('month', p_end), interval '1 month') d
  ), billed as (
    select to_char(fs.competence_date, 'YYYY-MM') ym, sum(fs.amount) v
    from public.fact_sales(p_company, (select min(ms) from months), v_ref, p_channel, p_branch, p_seller, p_state, p_city, null) fs
    where not v_restricted or fs.seller_id = any(v_vis)
    group by 1
  ), recv as (
    select to_char(s.settlement_date, 'YYYY-MM') ym, sum(s.amount) v
    from public.financial_settlements s join act a on a.title_id = s.title_id
    where s.settlement_date between (select min(ms) from months) and v_ref
    group by 1
  )
  select jsonb_build_object(
    'ref', v_ref,
    'capabilities', to_jsonb(public.finance_capabilities(auth.uid())),
    'overdueVisible', v_overdue,
    'receivable', coalesce((select sum(original + adjustments) from act where due_date between p_start and p_end), 0),
    'receivableCount', (select count(*) from act where due_date between p_start and p_end),
    'received', coalesce((select sum(amount) from st), 0),
    'receivedCount', (select count(*) from st),
    'receivedDaysWeighted', coalesce((select sum(amount * (settlement_date - issue_date)) from st), 0),
    'receivedDelayWeighted', case when v_overdue then coalesce((select sum(amount * greatest(settlement_date - due_date, 0)) from st), 0) end,
    'open', case when v_overdue then coalesce((select sum(open) from act), 0) end,
    'openCount', case when v_overdue then (select count(*) from act where open > 0) end,
    'overdue', case when v_overdue then coalesce((select sum(open) from act where status = 'OVERDUE'), 0) end,
    'overdueCount', case when v_overdue then (select count(*) from act where status = 'OVERDUE') end,
    'dueFuture', case when v_overdue then coalesce((select sum(open) from act where open > 0 and due_date >= v_ref), 0) end,
    'customersOverdue', case when v_overdue then (select count(distinct customer_id) from act where status = 'OVERDUE') end,
    'cancelledCount', (select count(*) from f where cancelled),
    'aging', (select coalesce(jsonb_agg(jsonb_build_object('bucket', b.k,
        'value', case when v_overdue then coalesce(x.v, 0) end,
        'titles', case when v_overdue then coalesce(x.n, 0) end,
        'customers', case when v_overdue then coalesce(x.c, 0) end) order by b.o), '[]'::jsonb)
      from (values ('future',0),('d1_30',1),('d31_60',2),('d61_90',3),('d91_180',4),('d180p',5)) b(k,o)
      left join (select bucket, sum(open) v, count(*) n, count(distinct customer_id) c from ag group by 1) x on x.bucket = b.k),
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object('month', m.ym,
        'billed', coalesce(bi.v, 0), 'received', coalesce(re.v, 0)) order by m.ym), '[]'::jsonb)
      from months m left join billed bi on bi.ym = m.ym left join recv re on re.ym = m.ym)
  ) into r;
  return r;
end $$;

create or replace function public.finance_titles_list(
  p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_customer uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ref date; v_overdue boolean; v_restricted boolean; v_vis uuid[]; r jsonb;
begin
  perform public.finance_assert(p_company, 'finance.view_titles');
  v_ref := least(p_end, public.data_as_of(p_company));
  v_overdue := public.has_finance_capability('finance.view_overdue');
  v_restricted := not public.is_service_request() and public.is_seller_restricted(auth.uid());
  v_vis := case when v_restricted then public.visible_seller_ids(auth.uid()) else null end;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.title_id, 'customerId', f.customer_id, 'customer', f.customer_name,
      'sellerId', f.seller_id, 'seller', f.seller_name, 'invoiceId', f.invoice_id,
      'document', f.document_number, 'installment', f.installment, 'installments', f.installments,
      'issueDate', f.issue_date, 'dueDate', f.due_date, 'settledDate', f.settled_date,
      'original', f.original, 'adjustments', f.adjustments, 'paid', f.paid, 'open', f.open,
      'status', case when not v_overdue and f.status = 'OVERDUE' then 'OPEN' else f.status end,
      'daysLate', case when v_overdue then f.days_late end
    ) order by f.due_date desc, f.document_number, f.installment), '[]'::jsonb)
  into r
  from public.finance_title_facts(p_company, v_ref, p_channel, p_branch, p_seller, p_state, p_city) f
  where (v_overdue or f.status <> 'OVERDUE') and (not v_restricted or f.seller_id = any(v_vis))
    and (p_customer is null or f.customer_id = p_customer)
    and (p_customer is not null or f.open > 0 or f.due_date between p_start and p_end
         or f.issue_date between p_start and p_end
         or exists (select 1 from public.financial_settlements s where s.title_id = f.title_id
                    and s.settlement_date between p_start and v_ref));
  return jsonb_build_object('ref', v_ref, 'overdueVisible', v_overdue, 'rows', r);
end $$;

create or replace function public.finance_customer(p_company uuid, p_customer uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ref date; v_overdue boolean; v_restricted boolean; v_vis uuid[]; r jsonb;
begin
  perform public.finance_assert(p_company, 'finance.view_customer_details');
  v_ref := public.data_as_of(p_company);
  v_overdue := public.has_finance_capability('finance.view_overdue');
  v_restricted := not public.is_service_request() and public.is_seller_restricted(auth.uid());
  v_vis := case when v_restricted then public.visible_seller_ids(auth.uid()) else null end;
  with f as (
    select * from public.finance_title_facts(p_company, v_ref) x
    where x.customer_id = p_customer and (not v_restricted or x.seller_id = any(v_vis))
  ), act as (select * from f where not cancelled),
  st as (
    select s.settlement_date, s.amount, a.document_number, a.installment, a.due_date
    from public.financial_settlements s join act a on a.title_id = s.title_id
    where s.settlement_date <= v_ref
  )
  select jsonb_build_object(
    'ref', v_ref, 'overdueVisible', v_overdue,
    'billed', coalesce((select sum(fs.amount) from public.fact_sales(p_company, '1900-01-01', v_ref) fs
                        where fs.customer_id = p_customer and (not v_restricted or fs.seller_id = any(v_vis))), 0),
    'titled', coalesce((select sum(original + adjustments) from act), 0),
    'received', coalesce((select sum(amount) from st), 0),
    'open', case when v_overdue then coalesce((select sum(open) from act), 0) end,
    'overdue', case when v_overdue then coalesce((select sum(open) from act where status = 'OVERDUE'), 0) end,
    'aging', (select coalesce(jsonb_agg(jsonb_build_object('bucket', b.k,
        'value', case when v_overdue then coalesce(x.v, 0) end,
        'titles', case when v_overdue then coalesce(x.n, 0) end,
        'customers', case when v_overdue then least(coalesce(x.n, 0), 1) end) order by b.o), '[]'::jsonb)
      from (values ('future',0),('d1_30',1),('d31_60',2),('d61_90',3),('d91_180',4),('d180p',5)) b(k,o)
      left join (select case when v_ref - due_date <= 0 then 'future'
                when v_ref - due_date <= 30 then 'd1_30' when v_ref - due_date <= 60 then 'd31_60'
                when v_ref - due_date <= 90 then 'd61_90' when v_ref - due_date <= 180 then 'd91_180'
                else 'd180p' end bucket, sum(open) v, count(*) n from act where open > 0 group by 1) x on x.bucket = b.k),
    'settlements', (select coalesce(jsonb_agg(jsonb_build_object('date', settlement_date, 'amount', amount,
        'document', document_number, 'installment', installment, 'dueDate', case when v_overdue then due_date end,
        'daysLate', case when v_overdue then greatest(settlement_date - due_date, 0) end) order by settlement_date desc), '[]'::jsonb)
      from (select * from st order by settlement_date desc limit 100) z),
    'titles', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', title_id, 'document', document_number, 'installment', installment, 'installments', installments,
        'issueDate', issue_date, 'dueDate', due_date, 'settledDate', settled_date, 'seller', seller_name,
        'original', original, 'adjustments', adjustments, 'paid', paid, 'open', open,
        'status', case when not v_overdue and status = 'OVERDUE' then 'OPEN' else status end,
        'daysLate', case when v_overdue then days_late end) order by due_date desc), '[]'::jsonb) from f where v_overdue or status <> 'OVERDUE')
  ) into r;
  return r;
end $$;
revoke all on function public.finance_summary(uuid,date,date,uuid,uuid,uuid,text,text), public.finance_titles_list(uuid,date,date,uuid,uuid,uuid,text,text,uuid), public.finance_customer(uuid,uuid) from public, anon;
grant execute on function public.finance_summary(uuid,date,date,uuid,uuid,uuid,text,text), public.finance_titles_list(uuid,date,date,uuid,uuid,uuid,text,text,uuid), public.finance_customer(uuid,uuid) to authenticated, service_role;
