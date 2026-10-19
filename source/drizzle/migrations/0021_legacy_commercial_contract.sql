-- Explicit contract for real-company revenue. Existing DEMO amounts remain unchanged.
-- Original fiscal header components and invoice_items.total are never rewritten.
alter table public.companies add column revenue_basis text not null default 'goods'
  check (revenue_basis in ('goods','commercial_base'));
alter table public.canonical_invoices
  add column commercial_base_amount numeric,
  add column operation_scope text not null default 'unconfirmed',
  add column business_channel text not null default 'unconfirmed',
  add column is_biomie_commercial_visible boolean not null default false;
alter table public.invoices
  add column commercial_base_amount numeric,
  add column operation_scope text not null default 'unconfirmed',
  add column business_channel text not null default 'unconfirmed',
  add column is_biomie_commercial_visible boolean not null default false;

create or replace function public.company_revenue_basis(p_company uuid)
returns text language sql stable security invoker set search_path=public as $$
  select case when is_demo then 'goods' else revenue_basis end from public.companies where id=p_company
$$;
create or replace function public.invoice_revenue_eligible(p_company uuid,p_scope text,p_channel text,p_visible boolean)
returns boolean language sql stable security invoker set search_path=public as $$
  select is_demo or (p_scope='commercial' and (p_channel='licitacao' or coalesce(p_visible,false)))
    from public.companies where id=p_company
$$;

create or replace function public.round_commercial_item(p_base numeric,p_original numeric,p_sum_original numeric)
returns numeric language plpgsql immutable security invoker set search_path=public as $$
begin
  if p_sum_original=0 then
    if p_base=0 then return 0; end if;
    raise exception 'Base comercial sem distribuicao: soma dos itens igual a zero.' using errcode='22012';
  end if;
  return round(p_base*p_original/p_sum_original,2);
end $$;

-- Calculate against every item of each invoice BEFORE product/category filters.
-- The final item absorbs the exact cent difference; no fiscal item value is changed.
create or replace function public.invoice_item_amounts(p_company uuid,p_start date,p_end date)
returns table(item_id uuid,invoice_id uuid,amount numeric)
language sql stable security invoker set search_path=public as $$
  with original as (
    select it.id item_id,i.id invoice_id,it.total original_amount,i.total header_amount,
      public.company_revenue_basis(i.company_id)='commercial_base'
        and i.status=any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible) use_commercial,
      sum(it.total) over(partition by i.id) original_sum,
      row_number() over(partition by i.id order by it.item_sequence nulls last,it.id) item_position,
      count(*) over(partition by i.id) item_count
    from public.invoices i join public.invoice_items it on it.invoice_id=i.id and it.company_id=i.company_id
    where i.company_id=p_company and i.competence_date between p_start and p_end
  ), rounded as (
    select original.*,case when use_commercial
      then public.round_commercial_item(header_amount,original_amount,original_sum)
      else original_amount end provisional_amount from original
  )
  select item_id,invoice_id,provisional_amount+case
    when use_commercial and item_position=item_count
      then header_amount-sum(provisional_amount) over(partition by invoice_id)
    else 0 end from rounded
$$;

create or replace function public.fact_sales(p_company uuid,p_start date,p_end date,p_channel uuid default null,p_branch uuid default null,
  p_seller uuid default null,p_state text default null,p_city text default null,p_category text default null)
returns table(invoice_id uuid,competence_date date,seller_id uuid,customer_id uuid,product_id uuid,category text,state text,city text,qty numeric,amount numeric)
language sql stable security invoker set search_path=public as $$
  select i.id,i.competence_date,i.seller_id,i.customer_id,it.product_id,p.category,c.state,c.city,it.quantity,a.amount
  from public.invoice_item_amounts(p_company,p_start,p_end) a
  join public.invoices i on i.id=a.invoice_id
  join public.invoice_items it on it.id=a.item_id
  join public.products p on p.id=it.product_id
  join public.customers c on c.id=i.customer_id
  where i.company_id=p_company and i.status=any(public.revenue_valid_statuses())
    and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible)
    and (p_channel is null or i.channel_id=p_channel)
    and (p_branch is null or i.branch_id=p_branch)
    and (p_seller is null or i.seller_id=p_seller)
    and (p_state is null or c.state=p_state)
    and (p_city is null or c.city=p_city)
    and (p_category is null or p.category=p_category)
$$;
revoke all on function public.company_revenue_basis(uuid),public.invoice_revenue_eligible(uuid,text,text,boolean),
  public.round_commercial_item(numeric,numeric,numeric),public.invoice_item_amounts(uuid,date,date) from public,anon;
grant execute on function public.company_revenue_basis(uuid),public.invoice_revenue_eligible(uuid,text,text,boolean),
  public.round_commercial_item(numeric,numeric,numeric),public.invoice_item_amounts(uuid,date,date),
  public.fact_sales(uuid,date,date,uuid,uuid,uuid,text,text,text) to authenticated,service_role;


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
        case ci.status when 'cancelled' then 'cancelled'::invoice_status when 'denied' then 'denied'::invoice_status else 'authorized'::invoice_status end,
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
      issue_date, competence_date, due_date, expected_date, original_amount, interest, fine, discount, cancelled_at, source_status, source, external_id)
    select r.company_id, c.id, i.id, s.id, r.document_number, r.installment, r.installments,
      coalesce(r.issue_date, r.due_date), coalesce(r.competence_date, r.issue_date, r.due_date), r.due_date, r.expected_date,
      r.original_amount, r.interest, r.fine, r.discount, r.cancelled_at, r.source_status, 'omie', r.external_id
    from canonical_receivables r
    left join customers c on c.company_id = r.company_id and c.source = 'omie' and c.external_id = r.customer_external_id
    left join sellers s on s.company_id = r.company_id and s.source = 'omie' and s.external_id = r.seller_external_id
    left join invoices i on i.company_id = r.company_id and i.source = 'omie' and i.external_id = r.invoice_external_id
    where r.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      customer_id = excluded.customer_id, invoice_id = excluded.invoice_id, seller_id = excluded.seller_id,
      due_date = excluded.due_date, expected_date = excluded.expected_date, original_amount = excluded.original_amount,
      interest = excluded.interest, fine = excluded.fine, discount = excluded.discount,
      cancelled_at = excluded.cancelled_at, source_status = excluded.source_status;
    get diagnostics n = row_count;
    insert into financial_settlements (title_id, company_id, settlement_date, amount, source, external_id)
    select t.id, st.company_id, st.settlement_date, st.amount, 'omie', st.external_id
    from canonical_settlements st
    join financial_titles t on t.company_id = st.company_id and t.source = 'omie' and t.external_id = st.receivable_external_id
    where st.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      settlement_date = excluded.settlement_date, amount = excluded.amount, title_id = excluded.title_id;
  else
    raise exception 'Entidade inválida: %', p_entity;
  end if;
  return jsonb_build_object('entity', p_entity, 'rows', n);
end $$;

create or replace function public.sales_kpis(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  with f as (
    select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  ), fb as (
    select customer_id,min(competence_date) d from public.fact_sales(p_company,'-infinity'::date,'infinity'::date) group by 1
  )
  select jsonb_build_object(
    'revenue', coalesce(sum(f.amount), 0),
    'invoices', count(distinct f.invoice_id),
    'units', coalesce(sum(f.qty), 0),
    'customers', count(distinct f.customer_id),
    'newCustomers', (select count(distinct f2.customer_id) from f f2 join fb on fb.customer_id = f2.customer_id and fb.d between p_start and p_end),
    'orders', (select count(distinct order_id) from public.fact_orders(p_company, p_channel, p_branch, p_seller, p_state, p_city, p_category)
               where status <> 'cancelled' and order_date between p_start and p_end)
  ) into v from f;
  return v;
end $$;

create or replace function public.sales_invoices(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null, p_limit int default 5000)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  with item_totals as (
    select ii.invoice_id,sum(a.amount) amt,count(*) n
    from public.invoice_item_amounts(p_company,p_start,p_end) a
    join public.invoice_items ii on ii.id=a.item_id
    join public.products p on p.id=ii.product_id
    where p_category is null or p.category=p_category
    group by ii.invoice_id
  )
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (
    select jsonb_build_object('id', i.id, 'number', i.number, 'date', i.competence_date, 'competence', to_char(i.competence_date, 'YYYY-MM'),
      'customer', c.name, 'seller', s.name, 'sellerId', i.seller_id, 'city', c.city, 'state', c.state, 'status', i.status,
      'total', it.amt, 'items', it.n, 'counted', i.status=any(public.revenue_valid_statuses()) and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible)) x
    from public.invoices i
    join public.customers c on c.id = i.customer_id
    left join public.sellers s on s.id = i.seller_id
    join item_totals it on it.invoice_id=i.id and it.n>0
    where i.company_id = p_company and i.competence_date between p_start and p_end
      and (p_channel is null or i.channel_id = p_channel)
      and (p_branch is null or i.branch_id = p_branch)
      and (p_seller is null or i.seller_id = p_seller)
      and (p_state is null or c.state = p_state)
      and (p_city is null or c.city = p_city)
    order by i.competence_date desc, i.number desc
    limit p_limit) q;
  return v;
end $$;

create or replace function public.customers_overview(p_company uuid, p_start date, p_end date, p_as_of date, p_inactive_days int default 90,
  p_channel uuid default null, p_branch uuid default null, p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  with per as (
    select customer_id, sum(amount) rev, count(distinct invoice_id) nfs, sum(qty) units
    from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), hist as (
    select customer_id,min(competence_date) first_d,max(competence_date) last_d,count(distinct invoice_id) nfs_all,sum(amount) life_rev from public.fact_sales(p_company,'-infinity'::date,p_as_of) group by 1
  ), main as (
    select distinct on (customer_id) customer_id, seller_id from (
      select customer_id,seller_id,sum(amount) s from public.fact_sales(p_company,'-infinity'::date,p_as_of) group by 1,2) x
    order by customer_id, s desc
  ), r as (
    select c.id, c.name, public.customer_document(c.id) document, c.city, c.state, m.seller_id, s.name seller, h.first_d, h.last_d, h.nfs_all, h.life_rev,
      coalesce(p.rev, 0) rev, coalesce(p.nfs, 0) nfs, coalesce(p.units, 0) units
    from hist h join public.customers c on c.id = h.customer_id
    left join per p on p.customer_id = h.customer_id
    left join main m on m.customer_id = h.customer_id
    left join public.sellers s on s.id = m.seller_id
    where p.customer_id is not null or (
      (p_state is null or c.state = p_state) and (p_city is null or c.city = p_city) and (p_seller is null or m.seller_id = p_seller)
      and p_channel is null and p_branch is null and p_category is null)
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'active', count(*) filter (where rev > 0),
      'new', count(*) filter (where rev > 0 and first_d between p_start and p_end),
      'revenue', coalesce(sum(rev), 0),
      'invoices', coalesce(sum(nfs), 0),
      'inactive', count(*) filter (where p_as_of - last_d > p_inactive_days),
      'inactiveDays', p_inactive_days,
      'unassignedRevenue', (select coalesce(sum(rev), 0) from per where customer_id is null)),
    'rows', coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'document', document, 'city', city, 'state', state,
      'sellerId', seller_id, 'seller', seller, 'firstDate', first_d, 'lastDate', last_d, 'daysSince', p_as_of - last_d,
      'purchases', nfs, 'purchasesAll', nfs_all, 'lifetimeRevenue', life_rev, 'revenue', rev, 'units', units) order by rev desc, life_rev desc), '[]'::jsonb))
  into v from r;
  return v;
end $$;

create or replace function public.customer_360(p_company uuid, p_customer uuid, p_start date, p_end date, p_as_of date,
  p_channel uuid default null, p_branch uuid default null, p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb; v_c record;
begin
  perform public.assert_company_access(p_company);
  select id,name,city,state into v_c from public.customers where id = p_customer and company_id = p_company;
  if not found then return null; end if;
  with valid as (
    select fs.invoice_id id,i.number,fs.competence_date d,fs.seller_id,fs.amount total,fs.qty quantity,fs.product_id
    from public.fact_sales(p_company,'-infinity'::date,p_as_of) fs join public.invoices i on i.id=fs.invoice_id
    where fs.customer_id=p_customer
  ), f as (
    select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  ), months as (
    select g::date ms from generate_series(date_trunc('month', p_end::timestamp) - interval '23 months', date_trunc('month', p_end::timestamp), interval '1 month') g
  ), main as (
    select v2.seller_id, s.name, sum(v2.total) t from valid v2 left join public.sellers s on s.id = v2.seller_id group by 1, 2 order by 3 desc limit 1
  )
  select jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'document', public.customer_document(v_c.id), 'city', v_c.city, 'state', v_c.state,
      'sellerId', (select seller_id from main), 'seller', (select name from main),
      'firstDate', (select min(d) from valid), 'lastDate', (select max(d) from valid)),
    'lifetime', jsonb_build_object('revenue', (select coalesce(sum(total), 0) from valid), 'invoices', (select count(distinct id) from valid),
      'invoices12m', (select count(distinct id) from valid where d > p_as_of - 365), 'revenue12m', (select coalesce(sum(total), 0) from valid where d > p_as_of - 365)),
    'period', jsonb_build_object(
      'revenue', (select coalesce(sum(amount), 0) from f where customer_id = p_customer),
      'invoices', (select count(distinct invoice_id) from f where customer_id = p_customer),
      'units', (select coalesce(sum(qty), 0) from f where customer_id = p_customer),
      'products', (select count(distinct product_id) from f where customer_id = p_customer),
      'companyRevenue', (select coalesce(sum(amount), 0) from f),
      'orders', (select count(distinct order_id) from public.fact_orders(p_company, p_channel, p_branch, p_seller, p_state, p_city, p_category)
                 where customer_id = p_customer and status <> 'cancelled' and order_date between p_start and p_end)),
    'history', (select jsonb_agg(jsonb_build_object('month', to_char(m.ms, 'YYYY-MM'), 'revenue', coalesce(h.rev, 0), 'invoices', coalesce(h.nfs, 0)) order by m.ms)
      from months m left join (select date_trunc('month', d)::date ms, sum(total) rev, count(distinct id) nfs from valid group by 1) h using (ms)),
    'products', (select coalesce(jsonb_agg(to_jsonb(x) order by x.revenue desc), '[]'::jsonb) from (
      select f.product_id id, p.sku, p.name, p.category, sum(f.qty) units, sum(f.amount) revenue, max(f.competence_date) "lastDate", (select max(v4.d) from valid v4 where v4.product_id=f.product_id) "lastDateAll"
      from f join public.products p on p.id = f.product_id where f.customer_id = p_customer group by 1, 2, 3, 4) x),
    'invoices', (select coalesce(jsonb_agg(to_jsonb(x) order by x.date desc), '[]'::jsonb) from (
      select v3.id, v3.number, v3.d date, s.name seller, sum(v3.total) total from valid v3 left join public.sellers s on s.id = v3.seller_id
      group by 1, 2, 3, 4 order by 3 desc limit 50) x)
  ) into v;
  return v;
end $$;

create or replace function public.product_360(p_company uuid, p_product uuid, p_start date, p_end date, p_hist_start date, p_grain text,
  p_channel uuid default null, p_branch uuid default null, p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb; v_p record;
begin
  perform public.assert_company_access(p_company);
  if p_grain not in ('week', 'month') then raise exception 'invalid grain'; end if;
  select * into v_p from public.products where id = p_product and company_id = p_company;
  if not found then return null; end if;
  with f as (select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) where product_id = p_product),
  fh as (select * from public.fact_sales(p_company, p_hist_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) where product_id = p_product),
  b as (select g::date bucket from generate_series(date_trunc(p_grain, p_hist_start::timestamp), p_end::timestamp, ('1 ' || p_grain)::interval) g)
  select jsonb_build_object(
    'product', jsonb_build_object('id', v_p.id, 'sku', v_p.sku, 'name', v_p.name, 'category', v_p.category, 'basePrice', v_p.base_price,
      'lastSale', (select max(competence_date) from public.fact_sales(p_company,'-infinity'::date,'infinity'::date) where product_id=p_product)),
    'period', jsonb_build_object('revenue', (select coalesce(sum(amount), 0) from f), 'units', (select coalesce(sum(qty), 0) from f),
      'customers', (select count(distinct customer_id) from f), 'sellers', (select count(distinct seller_id) from f),
      'invoices', (select count(distinct invoice_id) from f)),
    'history', (select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'revenue', coalesce(h.rev, 0), 'units', coalesce(h.units, 0)) order by b.bucket)
      from b left join (select date_trunc(p_grain, competence_date::timestamp)::date bucket, sum(amount) rev, sum(qty) units from fh group by 1) h using (bucket)),
    'customers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.revenue desc), '[]'::jsonb) from (
      select f.customer_id id, c.name, c.city || '/' || c.state place, sum(f.qty) units, sum(f.amount) revenue, max(f.competence_date) "lastDate"
      from f join public.customers c on c.id = f.customer_id group by 1, 2, 3) x),
    'sellers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.revenue desc), '[]'::jsonb) from (
      select f.seller_id id, s.name, sum(f.qty) units, sum(f.amount) revenue, count(distinct f.customer_id) customers
      from f left join public.sellers s on s.id = f.seller_id group by 1, 2) x)
  ) into v;
  return v;
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

revoke all on function public.promote_omie_gold(uuid,text) from public,anon,authenticated;
grant execute on function public.promote_omie_gold(uuid,text) to service_role;
notify pgrst, 'reload schema';
