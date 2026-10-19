create or replace function public.run_reconciliation(p_company uuid, p_period text)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_start date; v_end date; v_ref date; v_run uuid; v_job uuid;
  v_rev numeric; v_cnt bigint; v_a numeric; v_b numeric; v_ca bigint; v_cb bigint; v_failed int;
begin
  perform public.quality_assert(p_company);
  if p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  v_start := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end := (v_start + interval '1 month - 1 day')::date;
  v_ref := public.data_as_of(p_company);
  v_end := least(v_end, v_ref);

  insert into public.job_runs (job_name, params, status, trigger, triggered_by)
  values ('reconciliation', jsonb_build_object('company', p_company, 'period', p_period), 'running', 'manual', auth.uid())
  returning id into v_job;
  insert into public.reconciliation_runs (company_id, period, triggered_by, job_run_id)
  values (p_company, p_period, auth.uid(), v_job) returning id into v_run;

  create temporary table if not exists _rec (dataset text, check_key text, check_name text,
    sc bigint, sv numeric, tc bigint, tv numeric, rule text) on commit drop;
  delete from _rec where true;

  select count(distinct x.invoice_id), coalesce(sum(x.amount), 0) into v_cnt, v_rev
  from public.fact_sales(p_company, v_start, v_end) x;

  select count(*), coalesce(sum(total), 0) into v_ca, v_a from public.invoices
  where company_id = p_company and competence_date between v_start and v_end
    and status = any(public.revenue_valid_statuses());
  insert into _rec values ('invoices', 'invoices_vs_gold', 'NFs autorizadas = faturamento Gold', v_ca, v_a, v_cnt, v_rev,
    'Σ invoices.total (status válidos, competência no período) comparado a Σ invoice_items.total (fact_sales).');

  select coalesce(sum(v), 0) into v_b from (select x.seller_id, sum(x.amount) v from public.fact_sales(p_company, v_start, v_end) x group by 1) y;
  insert into _rec values ('sellers', 'sellers_vs_revenue', 'Soma dos vendedores = faturamento', null, v_rev, null, v_b,
    'Σ por vendedor (incluindo "Não atribuído") comparado ao faturamento da empresa.');
  select coalesce(sum(v), 0) into v_b from (select x.customer_id, sum(x.amount) v from public.fact_sales(p_company, v_start, v_end) x group by 1) y;
  insert into _rec values ('customers', 'customers_vs_revenue', 'Soma dos clientes = faturamento', null, v_rev, null, v_b,
    'Σ por cliente comparado ao faturamento da empresa.');
  select coalesce(sum(v), 0) into v_b from (select x.product_id, sum(x.amount) v from public.fact_sales(p_company, v_start, v_end) x group by 1) y;
  insert into _rec values ('products', 'products_vs_revenue', 'Soma dos produtos = faturamento', null, v_rev, null, v_b,
    'Σ por produto comparado ao faturamento da empresa.');

  select count(*), coalesce(sum(total), 0) into v_ca, v_a from public.sales_orders
  where company_id = p_company and status = 'open' and order_date <= v_ref;
  select count(distinct o.id), coalesce(sum(it.total), 0) into v_cb, v_b
  from public.sales_orders o join public.sales_order_items it on it.order_id = o.id
  where o.company_id = p_company and o.status = 'open' and o.order_date <= v_ref;
  insert into _rec values ('orders', 'portfolio_vs_items', 'Carteira agregada = soma dos itens elegíveis', v_ca, v_a, v_cb, v_b,
    'Σ sales_orders.total (abertos, emitidos até a data de referência) comparado a Σ sales_order_items.total.');

  select count(*), coalesce(sum(t.original_amount + t.interest + t.fine - t.discount), 0)
       - coalesce((select sum(s.amount) from public.financial_settlements s join public.financial_titles t2 on t2.id = s.title_id
                   where t2.company_id = p_company and s.settlement_date <= v_ref and t2.issue_date <= v_ref
                     and not (t2.cancelled_at is not null and t2.cancelled_at <= v_ref)), 0)
    into v_ca, v_a
  from public.financial_titles t
  where t.company_id = p_company and t.issue_date <= v_ref and not (t.cancelled_at is not null and t.cancelled_at <= v_ref);
  select count(*), coalesce(sum(x.open), 0) into v_cb, v_b from public.finance_title_facts(p_company, v_ref) x where not x.cancelled;
  insert into _rec values ('finance', 'finance_balance', 'Saldo financeiro = original + ajustes − liquidações', v_ca, v_a, v_cb, v_b,
    'Σ(original + juros + multa − desconto) − Σ liquidações até a data de referência, títulos não cancelados, comparado a Σ saldo por título (saldo nunca negativo: pagamento a maior aparece como divergência).');

  select count(distinct t.invoice_id), coalesce(sum(t.original_amount), 0) into v_cb, v_b
  from public.financial_titles t join public.invoices i on i.id = t.invoice_id
  where t.company_id = p_company and i.competence_date between v_start and v_end
    and i.status = any(public.revenue_valid_statuses());
  select count(*), coalesce(sum(total), 0) into v_ca, v_a from public.invoices
  where company_id = p_company and competence_date between v_start and v_end and status = any(public.revenue_valid_statuses());
  insert into _rec values ('finance', 'titles_vs_invoices', 'Títulos gerados = NFs autorizadas', v_ca, v_a, v_cb, v_b,
    'Σ valor original dos títulos das NFs válidas do período comparado a Σ invoices.total.');

  insert into public.reconciliation_results (run_id, company_id, dataset, check_key, check_name, period,
    source_count, source_value, target_count, target_value, abs_diff, pct_diff, status, rule)
  select v_run, p_company, r.dataset, r.check_key, r.check_name, p_period, r.sc, round(r.sv, 2), r.tc, round(r.tv, 2),
    round(abs(r.sv - r.tv), 2),
    case when r.sv = 0 then case when r.tv = 0 then 0 end else round(abs(r.sv - r.tv) / abs(r.sv), 6) end,
    case when abs(r.sv - r.tv) < 0.005 and (r.sc is null or r.tc is null or r.sc = r.tc) then 'OK'
         when abs(r.sv - r.tv) < 0.005 or (r.sv <> 0 and abs(r.sv - r.tv) / abs(r.sv) < 0.005) then 'WARNING'
         else 'FAILED' end,
    r.rule
  from _rec r;

  select count(*) into v_failed from public.reconciliation_results where run_id = v_run and status = 'FAILED';
  update public.reconciliation_runs set status = 'success', finished_at = now(),
    summary = (select jsonb_object_agg(z.status, z.n) from (select rr.status, count(*) n from public.reconciliation_results rr
               where rr.run_id = v_run group by rr.status) z)
  where id = v_run;
  update public.job_runs set status = 'success', finished_at = now(),
    rows_written = (select count(*) from public.reconciliation_results where run_id = v_run),
    error = case when v_failed > 0 then v_failed || ' verificação(ões) com divergência' end
  where id = v_job;
  return v_run;
end $$;