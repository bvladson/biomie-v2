-- Financial settlements as Omie records them (real finance load, 19/10/2026).
-- 1. resumo.nValPago is the amount of each settlement. nValorMovCC is the whole bank
--    movement and repeats on every title of a batch receipt (Ergooffice counted one
--    deposit three times). Fixed in the adapter; amount keeps meaning "cash received".
-- 2. Discount, interest and fine are recorded on the settlement. A settlement can be
--    a discount only (no cash): it closes the title and must reach Gold.
-- 3. Public buyers withhold IR/PIS/COFINS/CSLL (retem_X = 'S'). The withheld part is
--    never received in cash and must not stay as an open balance.
-- 4. Reprocessing from RAW records its own run (mode REPROCESS), so readiness and
--    coverage reflect the reprocessed Canonical/Gold without calling Omie again.

alter table public.canonical_receivables add column if not exists tax_withheld_amount numeric not null default 0;
alter table public.financial_titles add column if not exists tax_withheld_amount numeric(14,2) not null default 0;
alter table public.canonical_settlements
  add column if not exists discount_amount numeric not null default 0,
  add column if not exists interest_amount numeric not null default 0,
  add column if not exists fine_amount numeric not null default 0;
alter table public.financial_settlements
  add column if not exists discount_amount numeric(14,2) not null default 0,
  add column if not exists interest_amount numeric(14,2) not null default 0,
  add column if not exists fine_amount numeric(14,2) not null default 0;

-- The old column check (amount > 0) rejects a discount-only settlement.
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.financial_settlements'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%(amount > %' loop
    execute format('alter table public.financial_settlements drop constraint %I', c);
  end loop;
end $$;
alter table public.financial_settlements drop constraint if exists financial_settlements_amounts_check;
alter table public.financial_settlements add constraint financial_settlements_amounts_check
  check (amount >= 0 and discount_amount >= 0 and interest_amount >= 0 and fine_amount >= 0 and amount + discount_amount > 0);
alter table public.canonical_settlements drop constraint if exists canonical_settlements_amounts_check;
alter table public.canonical_settlements add constraint canonical_settlements_amounts_check
  check (amount >= 0 and discount_amount >= 0 and interest_amount >= 0 and fine_amount >= 0 and amount + discount_amount > 0);
alter table public.canonical_receivables drop constraint if exists canonical_receivables_tax_withheld_check;
alter table public.canonical_receivables add constraint canonical_receivables_tax_withheld_check check (tax_withheld_amount >= 0);
alter table public.financial_titles drop constraint if exists financial_titles_tax_withheld_check;
alter table public.financial_titles add constraint financial_titles_tax_withheld_check check (tax_withheld_amount >= 0);

alter table public.integration_sync_runs drop constraint if exists integration_sync_runs_mode_check;
alter table public.integration_sync_runs add constraint integration_sync_runs_mode_check
  check (mode in ('FULL','INCREMENTAL','PERIOD','BACKFILL','REPROCESS'));

create or replace function public.promote_omie_gold(p_company uuid, p_entity text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_src text; n int := 0; v_unknown uuid;
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  select data_source into v_src from companies where id = p_company and not is_demo;
  if v_src is null or v_src = 'DEMO' then raise exception 'Promoção Gold exige empresa real em OMIE_SHADOW ou OMIE.'; end if;

  if p_entity = 'vendors' then
    insert into sellers (company_id, name, active, source, external_id)
      select company_id, name, is_active and not missing_in_source, 'omie', external_id from canonical_vendors where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, active = excluded.active;
    get diagnostics n = row_count;
  elsif p_entity = 'customers' then
    insert into customers (company_id, name, state, city, created_at, source, external_id)
      select company_id, name, coalesce(state,'—'), coalesce(city,'—'), canonicalized_at::date, 'omie', external_id
      from canonical_customers where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, state = excluded.state, city = excluded.city;
    get diagnostics n = row_count;
  elsif p_entity = 'products' then
    insert into products (company_id, name, category, base_price, sku, source, external_id)
      select company_id, description, coalesce(family,'Sem categoria'), 0, sku, 'omie', external_id
      from canonical_products where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, category = excluded.category, sku = excluded.sku;
    get diagnostics n = row_count;
  elsif p_entity in ('invoices','orders') then
    -- Facts without a known customer are kept under an explicit "Sem cliente" dimension, never dropped.
    insert into customers (company_id, name, state, city, created_at, source, external_id)
      values (p_company, 'Sem cliente identificado', '—', '—', current_date, 'omie', '__unknown__')
    on conflict (company_id, source, external_id) where external_id is not null do nothing;
    select id into v_unknown from customers where company_id = p_company and source = 'omie' and external_id = '__unknown__';
    insert into products (company_id, name, category, base_price, source, external_id)
      values (p_company, 'Produto não identificado', 'Sem categoria', 0, 'omie', '__unknown__')
    on conflict (company_id, source, external_id) where external_id is not null do nothing;

    if p_entity = 'invoices' then
      insert into invoices (company_id, seller_id, customer_id, number, status, competence_date, total, source, external_id,
        gross_amount, goods_amount, freight_amount, insurance_amount, other_expenses_amount, discount_amount,
        commercial_base_amount,operation_scope,business_channel,is_biomie_commercial_visible)
      select ci.company_id, s.id, coalesce(c.id, v_unknown), ci.number,
        case ci.status when 'cancelled' then 'cancelled'::invoice_status when 'denied' then 'denied'::invoice_status
          when 'not_authorized' then 'not_authorized'::invoice_status when 'authorized' then 'authorized'::invoice_status end,
        ci.competence_date, case when public.company_revenue_basis(p_company)='commercial_base'
          then coalesce(ci.commercial_base_amount,ci.gross_amount-ci.freight_amount-ci.other_expenses_amount-ci.insurance_amount)
          else ci.gross_amount end, 'omie', ci.external_id,
        ci.gross_amount, ci.goods_amount, ci.freight_amount, ci.insurance_amount, ci.other_expenses_amount, ci.discount_amount,
        coalesce(ci.commercial_base_amount,ci.gross_amount-ci.freight_amount-ci.other_expenses_amount-ci.insurance_amount),
        ci.operation_scope,ci.business_channel,ci.is_biomie_commercial_visible
      from canonical_invoices ci
      left join sellers s on s.company_id = ci.company_id and s.source = 'omie' and s.external_id = ci.seller_external_id
      left join customers c on c.company_id = ci.company_id and c.source = 'omie' and c.external_id = ci.customer_external_id
      where ci.company_id = p_company
      on conflict (company_id, source, external_id) where external_id is not null do update set
        seller_id = excluded.seller_id, customer_id = excluded.customer_id, number = excluded.number, status = excluded.status,
        competence_date = excluded.competence_date, total = excluded.total, gross_amount = excluded.gross_amount,
        goods_amount = excluded.goods_amount, freight_amount = excluded.freight_amount, insurance_amount = excluded.insurance_amount,
        other_expenses_amount = excluded.other_expenses_amount, discount_amount = excluded.discount_amount,
        commercial_base_amount=excluded.commercial_base_amount,operation_scope=excluded.operation_scope,
        business_channel=excluded.business_channel,is_biomie_commercial_visible=excluded.is_biomie_commercial_visible;
      get diagnostics n = row_count;
      delete from public.invoice_items gi using public.invoices gh
      where gi.invoice_id=gh.id and gh.company_id=p_company and gh.source='omie'
        and gi.item_sequence is not null
        and exists(select 1 from public.canonical_invoices ch where ch.company_id=p_company and ch.source='omie' and ch.external_id=gh.external_id)
        and not exists(select 1 from public.canonical_invoice_items ci where ci.company_id=p_company and ci.source='omie' and ci.invoice_external_id=gh.external_id and ci.item_sequence=gi.item_sequence);
      insert into invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence)
      select i.id, i.company_id, i.seller_id, coalesce(p.id, (select id from products where company_id = p_company and source='omie' and external_id='__unknown__')),
        it.quantity, it.total, it.item_sequence
      from canonical_invoice_items it
      join invoices i on i.company_id = it.company_id and i.source = 'omie' and i.external_id = it.invoice_external_id
      left join products p on p.company_id = it.company_id and p.source = 'omie' and p.external_id = it.product_external_id
      where it.company_id = p_company
      on conflict (invoice_id, item_sequence) where item_sequence is not null do update set
        product_id = excluded.product_id, quantity = excluded.quantity, total = excluded.total, seller_id = excluded.seller_id;
    else
      insert into sales_orders (company_id, seller_id, customer_id, number, status, order_date, expected_date, total, source, external_id)
      select co.company_id, s.id, coalesce(c.id, v_unknown), co.number,
        case co.status when 'cancelled' then 'cancelled'::order_status when 'invoiced' then 'invoiced'::order_status else 'open'::order_status end,
        co.order_date, co.expected_date, co.total, 'omie', co.external_id
      from canonical_orders co
      left join sellers s on s.company_id = co.company_id and s.source = 'omie' and s.external_id = co.seller_external_id
      left join customers c on c.company_id = co.company_id and c.source = 'omie' and c.external_id = co.customer_external_id
      where co.company_id = p_company
      on conflict (company_id, source, external_id) where external_id is not null do update set
        seller_id = excluded.seller_id, customer_id = excluded.customer_id, status = excluded.status,
        order_date = excluded.order_date, expected_date = excluded.expected_date, total = excluded.total;
      get diagnostics n = row_count;
      delete from public.sales_order_items gi using public.sales_orders gh
      where gi.order_id=gh.id and gh.company_id=p_company and gh.source='omie'
        and gi.item_sequence is not null
        and exists(select 1 from public.canonical_orders ch where ch.company_id=p_company and ch.source='omie' and ch.external_id=gh.external_id)
        and not exists(select 1 from public.canonical_order_items ci where ci.company_id=p_company and ci.source='omie' and ci.order_external_id=gh.external_id and ci.item_sequence=gi.item_sequence);
      insert into sales_order_items (order_id, company_id, seller_id, product_id, quantity, total, item_sequence)
      select o.id, o.company_id, o.seller_id, coalesce(p.id, (select id from products where company_id = p_company and source='omie' and external_id='__unknown__')),
        it.quantity, it.total, it.item_sequence
      from canonical_order_items it
      join sales_orders o on o.company_id = it.company_id and o.source = 'omie' and o.external_id = it.order_external_id
      left join products p on p.company_id = it.company_id and p.source = 'omie' and p.external_id = it.product_external_id
      where it.company_id = p_company
      on conflict (order_id, item_sequence) where item_sequence is not null do update set
        product_id = excluded.product_id, quantity = excluded.quantity, total = excluded.total, seller_id = excluded.seller_id;
    end if;
  elsif p_entity = 'receivables' then
    insert into financial_titles (company_id, customer_id, invoice_id, seller_id, document_number, installment, installments,
      issue_date, competence_date, due_date, expected_date, original_amount, interest, fine, discount, tax_withheld_amount, cancelled_at, source_status, source, external_id)
    select r.company_id, c.id, i.id, s.id, r.document_number, r.installment, r.installments,
      coalesce(r.issue_date, r.due_date), coalesce(r.competence_date, r.issue_date, r.due_date), r.due_date, r.expected_date,
      r.original_amount, r.interest, r.fine, r.discount, r.tax_withheld_amount, r.cancelled_at, r.source_status, 'omie', r.external_id
    from canonical_receivables r
    left join customers c on c.company_id = r.company_id and c.source = 'omie' and c.external_id = r.customer_external_id
    left join sellers s on s.company_id = r.company_id and s.source = 'omie' and s.external_id = r.seller_external_id
    left join invoices i on i.company_id = r.company_id and i.source = 'omie' and i.external_id = r.invoice_external_id
    where r.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      customer_id = excluded.customer_id, invoice_id = excluded.invoice_id, seller_id = excluded.seller_id,
      due_date = excluded.due_date, expected_date = excluded.expected_date, original_amount = excluded.original_amount,
      interest = excluded.interest, fine = excluded.fine, discount = excluded.discount,
      tax_withheld_amount = excluded.tax_withheld_amount,
      cancelled_at = excluded.cancelled_at, source_status = excluded.source_status;
    get diagnostics n = row_count;
    insert into financial_settlements (title_id, company_id, settlement_date, amount, discount_amount, interest_amount, fine_amount, source, external_id)
    select t.id, st.company_id, st.settlement_date, st.amount, st.discount_amount, st.interest_amount, st.fine_amount, 'omie', st.external_id
    from canonical_settlements st
    join financial_titles t on t.company_id = st.company_id and t.source = 'omie' and t.external_id = st.receivable_external_id
    where st.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      settlement_date = excluded.settlement_date, amount = excluded.amount, title_id = excluded.title_id,
      discount_amount = excluded.discount_amount, interest_amount = excluded.interest_amount, fine_amount = excluded.fine_amount;
  else
    raise exception 'Entidade inválida: %', p_entity;
  end if;
  return jsonb_build_object('entity', p_entity, 'rows', n);
end $$;

create or replace function public.finance_title_facts(
  p_company uuid, p_ref date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null)
returns table(
  title_id uuid, customer_id uuid, customer_name text, state text, city text,
  seller_id uuid, seller_name text, invoice_id uuid, invoice_number text,
  document_number text, installment int, installments int,
  issue_date date, competence_date date, due_date date, settled_date date,
  original numeric, adjustments numeric, paid numeric, open numeric,
  status text, days_late int, cancelled boolean)
language sql stable security definer set search_path = public as $$
  with t as (
    select ft.*, c.name cname, c.state cstate, c.city ccity, s.name sname, i.number inum,
      coalesce((select sum(st.amount) from public.financial_settlements st
                where st.title_id = ft.id and st.settlement_date <= p_ref), 0) paid_amt,
      -- Interest/fine raise and discount lowers the balance on the settlement date.
      coalesce((select sum(st.interest_amount + st.fine_amount - st.discount_amount) from public.financial_settlements st
                where st.title_id = ft.id and st.settlement_date <= p_ref), 0) settle_adj,
      (select max(st.settlement_date) from public.financial_settlements st
        where st.title_id = ft.id and st.settlement_date <= p_ref) last_settle,
      (ft.cancelled_at is not null and ft.cancelled_at <= p_ref) is_cancelled
    from public.financial_titles ft
    left join public.customers c on c.id = ft.customer_id
    left join public.sellers s on s.id = ft.seller_id
    left join public.invoices i on i.id = ft.invoice_id
    where ft.company_id = p_company and ft.issue_date <= p_ref
      and (p_channel is null or ft.business_channel = (select lower(ch.name) from public.channels ch where ch.id = p_channel)
           or (ft.business_channel = 'unconfirmed' and i.channel_id = p_channel))
      and (p_branch is null or i.branch_id = p_branch)
      and (p_seller is null or ft.seller_id = p_seller)
      and (p_state is null or c.state = p_state)
      and (p_city is null or c.city = p_city)
  ), b as (
    select t.*, case when is_cancelled then 0
      else greatest(original_amount + interest + fine - discount - tax_withheld_amount + settle_adj - paid_amt, 0) end bal
    from t
  )
  select id, customer_id, cname, cstate, ccity, seller_id, sname, invoice_id, inum,
    document_number, installment, installments, issue_date, competence_date, due_date, last_settle,
    original_amount, interest + fine - discount - tax_withheld_amount + settle_adj, paid_amt, bal,
    case when is_cancelled then 'CANCELLED'
         when bal = 0 then 'PAID'
         when due_date < p_ref then 'OVERDUE'
         when paid_amt > 0 then 'PARTIALLY_PAID'
         else 'OPEN' end,
    case when is_cancelled then 0
         when bal > 0 and due_date < p_ref then p_ref - due_date
         when bal = 0 and last_settle is not null then greatest(last_settle - due_date, 0)
         else 0 end,
    is_cancelled
  from b
$$;

create or replace function public.run_integrity_checks(p_company uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.is_service_request() or public.is_admin(auth.uid())) then raise exception 'Acesso negado' using errcode = '42501'; end if;
  if not public.is_service_request() then perform public.integration_admin_assert(p_company); end if;
  create temp table _iss (entity text, external_id text, check_key text, severity text, reason text) on commit drop;
  insert into _iss
    select 'invoices', ci.external_id, 'invoice_without_customer', 'HIGH', 'Nota sem cliente correspondente'
      from canonical_invoices ci where ci.company_id = p_company and not exists
        (select 1 from canonical_customers c where c.company_id = ci.company_id and c.external_id = ci.customer_external_id)
    union all
    select 'invoices', ci.external_id, 'invoice_without_seller', 'MEDIUM', 'Nota sem vendedor correspondente'
      from canonical_invoices ci where ci.company_id = p_company and ci.seller_external_id is not null and not exists
        (select 1 from canonical_vendors v where v.company_id = ci.company_id and v.external_id = ci.seller_external_id)
    union all
    select 'invoices', ci.external_id, 'invoice_without_items', 'HIGH', 'Nota sem itens'
      from canonical_invoices ci where ci.company_id = p_company and not exists
        (select 1 from canonical_invoice_items it where it.company_id = ci.company_id and it.invoice_external_id = ci.external_id)
    union all
    select 'invoices', ci.external_id, 'invoice_items_sum', 'HIGH', 'Soma dos itens difere do valor de mercadorias'
      from canonical_invoices ci join (select invoice_external_id, sum(total) s from canonical_invoice_items where company_id = p_company group by 1) x
        on x.invoice_external_id = ci.external_id where ci.company_id = p_company and abs(x.s - ci.goods_amount) > 0.01
    union all
    select 'invoices', ci.external_id, 'invoice_operation_pending', 'HIGH',
        'Nota com operação pendente: CFOP ausente, desconhecido ou misto; fica fora do faturamento até a decisão'
      from canonical_invoices ci where ci.company_id = p_company and not ci.missing_in_source
        and ci.status = 'authorized' and ci.operation_scope in ('unconfirmed','unknown')
    union all
    select 'invoices', ci.external_id, 'invoice_negative_base', 'HIGH', 'Base comercial negativa'
      from canonical_invoices ci where ci.company_id = p_company and coalesce(ci.commercial_base_amount,0) < 0
    union all
    select 'invoice_items', it.invoice_external_id || '#' || it.item_sequence, 'item_without_product', 'MEDIUM', 'Item sem produto correspondente'
      from canonical_invoice_items it where it.company_id = p_company and not exists
        (select 1 from canonical_products p where p.company_id = it.company_id and p.external_id = it.product_external_id)
    union all
    select 'orders', co.external_id, 'order_without_items', 'MEDIUM', 'Pedido sem itens'
      from canonical_orders co where co.company_id = p_company and not exists
        (select 1 from canonical_order_items it where it.company_id = co.company_id and it.order_external_id = co.external_id)
    union all
    select 'orders', co.external_id, 'order_operation_pending', 'HIGH',
        'Pedido com operação pendente: sem CFOP reconhecido nos itens; preservado, fora da carteira até a decisão'
      from canonical_orders co where co.company_id = p_company and not co.missing_in_source
        and co.status not in ('cancelled') and co.operation_scope in ('unconfirmed','unknown')
    union all
    select 'settlements', st.external_id, 'settlement_without_title', 'HIGH', 'Liquidação sem título'
      from canonical_settlements st where st.company_id = p_company and not exists
        (select 1 from canonical_receivables r where r.company_id = st.company_id and r.external_id = st.receivable_external_id)
    union all
    select 'receivables', r.external_id, 'overpaid_title', 'HIGH', 'Recebido maior que o valor do título'
      from canonical_receivables r join (select receivable_external_id, sum(amount) s,
          sum(interest_amount + fine_amount - discount_amount) adj
          from canonical_settlements where company_id = p_company group by 1) x
        on x.receivable_external_id = r.external_id where r.company_id = p_company
        and x.s > r.original_amount + r.interest + r.fine - r.discount - r.tax_withheld_amount + x.adj + 0.01
    union all
    select 'receivables', r.external_id, 'received_title_without_settlement', 'MEDIUM',
        'Título recebido no Omie sem baixa importada; o saldo segue em aberto até a baixa ser importada'
      from canonical_receivables r where r.company_id = p_company and not r.missing_in_source
        and upper(coalesce(r.source_status, '')) = 'RECEBIDO'
        and not exists (select 1 from canonical_settlements st
          where st.company_id = r.company_id and st.receivable_external_id = r.external_id);
  insert into integrity_issues (company_id, entity, external_id, check_key, severity, reason)
    select p_company, entity, external_id, check_key, severity, reason from _iss
  on conflict (company_id, entity, check_key, coalesce(external_id,'')) do update
    set last_seen_at = now(), occurrences = integrity_issues.occurrences + 1,
        status = case when integrity_issues.status = 'RESOLVED' then 'OPEN' else integrity_issues.status end;
  get diagnostics n = row_count;
  update integrity_issues i set status = 'RESOLVED', resolved_at = now(), justification = coalesce(justification, 'Não ocorre mais na última verificação.')
    where i.company_id = p_company and i.status in ('OPEN','ACKNOWLEDGED')
      and not exists (select 1 from _iss x where x.entity = i.entity and x.check_key = i.check_key and coalesce(x.external_id,'') = coalesce(i.external_id,''));
  return n;
end $$;

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
    and status = any(public.revenue_valid_statuses()) and public.invoice_revenue_eligible(company_id,operation_scope,business_channel,is_biomie_commercial_visible);
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

  select count(*), coalesce(sum(t.original_amount + t.interest + t.fine - t.discount - t.tax_withheld_amount), 0)
       - coalesce((select sum(s.amount - s.interest_amount - s.fine_amount + s.discount_amount)
                   from public.financial_settlements s join public.financial_titles t2 on t2.id = s.title_id
                   where t2.company_id = p_company and s.settlement_date <= v_ref and t2.issue_date <= v_ref
                     and not (t2.cancelled_at is not null and t2.cancelled_at <= v_ref)), 0)
    into v_ca, v_a
  from public.financial_titles t
  where t.company_id = p_company and t.issue_date <= v_ref and not (t.cancelled_at is not null and t.cancelled_at <= v_ref);
  select count(*), coalesce(sum(x.open), 0) into v_cb, v_b from public.finance_title_facts(p_company, v_ref) x where not x.cancelled;
  insert into _rec values ('finance', 'finance_balance', 'Saldo financeiro = original + ajustes − liquidações', v_ca, v_a, v_cb, v_b,
    'Σ(original + juros + multa − desconto − retenções) − Σ(liquidações − juros − multa + desconto da baixa) até a data de referência, títulos não cancelados, comparado a Σ saldo por título (saldo nunca negativo: pagamento a maior aparece como divergência).');

  select count(distinct t.invoice_id), coalesce(sum(t.original_amount), 0) into v_cb, v_b
  from public.financial_titles t join public.invoices i on i.id = t.invoice_id
  where t.company_id = p_company and i.competence_date between v_start and v_end
    and i.status = any(public.revenue_valid_statuses());
  select count(*), coalesce(sum(coalesce(gross_amount,total)), 0) into v_ca, v_a from public.invoices
  where company_id = p_company and competence_date between v_start and v_end and status = any(public.revenue_valid_statuses());
  insert into _rec values ('finance', 'titles_vs_invoices', 'Títulos gerados = NFs autorizadas', v_ca, v_a, v_cb, v_b,
    'Σ valor original dos títulos das NFs válidas comparado ao bruto fiscal (gross_amount; DEMO total).');

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

notify pgrst, 'reload schema';
