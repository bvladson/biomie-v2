-- ===== Access helper (service_role = trusted server jobs) =====
create or replace function public.assert_company_access(p_company uuid)
returns void language plpgsql stable security invoker set search_path = public as $$
begin
  if current_user <> 'service_role' and not public.can_access_company(auth.uid(), p_company) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;
grant execute on function public.assert_company_access(uuid) to authenticated, service_role;

-- ===== data_as_of: real = today; demo = last date in the demo dataset =====
create or replace function public.data_as_of(p_company uuid)
returns date language sql stable security invoker set search_path = public as $$
  select case when coalesce((select is_demo from public.companies where id = p_company), false)
    then coalesce((select max(competence_date) from public.invoices
                   where company_id = p_company and source = 'demo'
                     and competence_date <= (now() at time zone 'America/Sao_Paulo')::date),
                  (now() at time zone 'America/Sao_Paulo')::date)
    else (now() at time zone 'America/Sao_Paulo')::date end
$$;
grant execute on function public.data_as_of(uuid) to authenticated, service_role;

-- ===== Products SKU, order items, expected billing date =====
alter table public.products add column if not exists sku text;
update public.products p set sku = 'SKU-' || lpad(x.rn::text, 4, '0')
from (select id, row_number() over (partition by company_id order by name) + 1000 rn from public.products) x
where x.id = p.id and p.sku is null;

alter table public.sales_orders add column if not exists expected_date date;
update public.sales_orders set expected_date = order_date + 20 + (abs(hashtext(id::text)) % 25) where expected_date is null;

create table public.sales_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  seller_id uuid references public.sellers(id),
  product_id uuid not null references public.products(id),
  quantity numeric(12,2) not null,
  total numeric(14,2) not null
);
create index on public.sales_order_items (order_id);
create index on public.sales_order_items (company_id);
grant select on public.sales_order_items to authenticated;
grant all on public.sales_order_items to service_role;
alter table public.sales_order_items enable row level security;
create policy "facts scoped" on public.sales_order_items for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id));

insert into public.sales_order_items (order_id, company_id, seller_id, product_id, quantity, total)
select o.id, o.company_id, o.seller_id, pr.id,
  greatest(1, round(o.total / g.n / greatest(pr.base_price, 1))), round(o.total / g.n, 2)
from public.sales_orders o
cross join lateral (select k, (1 + abs(hashtext(o.id::text)) % 3) n
                    from generate_series(1, 1 + abs(hashtext(o.id::text)) % 3) k) g
cross join lateral (select id, base_price from public.products
                    where company_id = o.company_id order by md5(id::text || o.id::text || g.k) limit 1) pr;
update public.sales_orders o set total = x.s
from (select order_id, sum(total) s from public.sales_order_items group by 1) x where x.order_id = o.id;

-- ===== fact_orders: item-level order facts honoring every global filter =====
create or replace function public.fact_orders(p_company uuid, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns table(order_id uuid, number text, status public.order_status, order_date date, expected_date date, seller_id uuid,
  customer_id uuid, product_id uuid, category text, qty numeric, amount numeric)
language sql stable security invoker set search_path = public as $$
  select o.id, o.number, o.status, o.order_date, o.expected_date, o.seller_id, o.customer_id, it.product_id, p.category, it.quantity, it.total
  from public.sales_orders o
  join public.sales_order_items it on it.order_id = o.id
  join public.products p on p.id = it.product_id
  join public.customers c on c.id = o.customer_id
  where o.company_id = p_company
    and (p_channel is null or o.channel_id = p_channel)
    and (p_branch is null or o.branch_id = p_branch)
    and (p_seller is null or o.seller_id = p_seller)
    and (p_state is null or c.state = p_state)
    and (p_city is null or c.city = p_city)
    and (p_category is null or p.category = p_category)
$$;
grant execute on function public.fact_orders(uuid, uuid, uuid, uuid, text, text, text) to authenticated, service_role;

-- ===== Flight plan dataset v2: as-of date, raw open orders, revenue cut at as-of =====
drop function if exists public.flight_plan_dataset(uuid, int, int, uuid, uuid, uuid, text, text, text);
create or replace function public.flight_plan_dataset(p_company uuid, p_year int, p_month int, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null, p_as_of date default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_start date := make_date(p_year, p_month, 1);
  v_end date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_today date;
  v_cut date; v_offset int; v_cfg jsonb;
  v_days jsonb; v_sellers jsonb; v_actions jsonb; v_cmp jsonb;
  v_pm_start date; v_py_start date; v_is_demo boolean;
begin
  perform public.assert_company_access(p_company);
  v_today := coalesce(p_as_of, public.data_as_of(p_company));
  select is_demo into v_is_demo from public.companies where id = p_company;
  select config into v_cfg from public.metric_config where metric_key = 'flight_plan';
  v_cut := least(v_end, v_today);
  v_offset := v_cut - v_start;
  v_pm_start := (v_start - interval '1 month')::date;
  v_py_start := (v_start - interval '1 year')::date;

  with days as (
    select d::date as day,
      (extract(isodow from d) < 6 and not exists (select 1 from public.holidays h where h.date = d::date and (h.company_id is null or h.company_id = p_company))) as wd
    from generate_series(v_start, v_end, interval '1 day') d
  ), rev as (
    select competence_date, sum(amount) amt from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  )
  select jsonb_agg(jsonb_build_object('date', day, 'working', wd, 'revenue', case when day <= v_today then coalesce(rev.amt, 0) else null end) order by day)
  into v_days from days left join rev on rev.competence_date = days.day;

  with vis as (
    select s.id, s.name from public.sellers s
    where s.company_id = p_company and s.active
      and (current_user = 'service_role' or public.can_view_seller(auth.uid(), s.id))
      and (p_channel is null or s.channel_id = p_channel)
      and (p_branch is null or s.branch_id = p_branch)
      and (p_seller is null or s.id = p_seller)
  ), r as (
    select seller_id, sum(amount) amt, count(distinct invoice_id) nfs
    from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), t as (
    select seller_id,
      sum(amount) filter (where level = 'BASE') b, sum(amount) filter (where level = 'ACTIVE') a, sum(amount) filter (where level = 'CHALLENGE') c
    from public.sales_targets where company_id = p_company and year = p_year and month = p_month and active group by 1
  ), oo as (
    select order_id, seller_id, order_date, expected_date, sum(amount) amt
    from public.fact_orders(p_company, p_channel, p_branch, p_seller, p_state, p_city, p_category)
    where status = 'open' and order_date <= v_today group by 1, 2, 3, 4
  ), o as (
    select seller_id, jsonb_agg(jsonb_build_object('id', order_id, 'ageDays', v_today - order_date, 'expectedDate', expected_date, 'total', amt)) list
    from oo group by 1
  ), cm as (
    select seller_id, amount, note, updated_at from public.flight_plan_commits where company_id = p_company and year = p_year and month = p_month
  ), pm as (
    select seller_id, sum(amount) amt from public.fact_sales(p_company, v_pm_start, least(v_start - 1, v_pm_start + v_offset), p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), py as (
    select seller_id, sum(amount) amt from public.fact_sales(p_company, v_py_start, least((v_py_start + interval '1 month - 1 day')::date, v_py_start + v_offset), p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), l3 as (
    select seller_id, sum(amount) / 3.0 amt from public.fact_sales(p_company, (v_start - interval '3 months')::date, v_start - 1, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', vis.id, 'name', vis.name,
    'revenue', coalesce(r.amt, 0), 'invoices', coalesce(r.nfs, 0),
    'targets', jsonb_build_object('BASE', coalesce(t.b, 0), 'ACTIVE', coalesce(t.a, 0), 'CHALLENGE', coalesce(t.c, 0)),
    'orders', coalesce(o.list, '[]'::jsonb),
    'commit', case when cm.seller_id is null then null else jsonb_build_object('amount', cm.amount, 'note', cm.note, 'updatedAt', cm.updated_at) end,
    'comparisons', jsonb_build_object('previousMonth', coalesce(pm.amt, 0), 'previousYear', coalesce(py.amt, 0), 'last3Avg', coalesce(l3.amt, 0))
  ) order by vis.name), '[]'::jsonb)
  into v_sellers
  from vis left join r on r.seller_id = vis.id left join t on t.seller_id = vis.id left join o on o.seller_id = vis.id
    left join cm on cm.seller_id = vis.id left join pm on pm.seller_id = vis.id left join py on py.seller_id = vis.id left join l3 on l3.seller_id = vis.id;

  select jsonb_build_object(
    'previousMonth', coalesce((select sum(amount) from public.fact_sales(p_company, v_pm_start, least(v_start - 1, v_pm_start + v_offset), p_channel, p_branch, p_seller, p_state, p_city, p_category)), 0),
    'previousYear', coalesce((select sum(amount) from public.fact_sales(p_company, v_py_start, least((v_py_start + interval '1 month - 1 day')::date, v_py_start + v_offset), p_channel, p_branch, p_seller, p_state, p_city, p_category)), 0),
    'last3Avg', coalesce((select sum(amount) / 3.0 from public.fact_sales(p_company, (v_start - interval '3 months')::date, v_start - 1, p_channel, p_branch, p_seller, p_state, p_city, p_category)), 0)
  ) into v_cmp;

  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'sellerId', a.seller_id, 'type', a.type, 'status', a.status, 'updatedAt', a.updated_at, 'resolvedAt', a.resolved_at, 'createdAt', a.created_at)), '[]'::jsonb)
  into v_actions from public.flight_plan_actions a where a.company_id = p_company and a.year = p_year and a.month = p_month;

  return jsonb_build_object(
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'today', v_today, 'cut', v_cut,
      'state', case when v_today < v_start then 'future' when v_today > v_end then 'closed' else 'current' end),
    'isDemo', coalesce(v_is_demo, false),
    'config', coalesce(v_cfg, '{}'::jsonb),
    'days', coalesce(v_days, '[]'::jsonb),
    'companyComparisons', v_cmp,
    'sellers', v_sellers,
    'actions', v_actions
  );
end $$;
grant execute on function public.flight_plan_dataset(uuid, int, int, uuid, uuid, uuid, text, text, text, date) to authenticated, service_role;

-- ===== Cockpit: as-of date, revenue cut at as-of, portfolio from item-level orders =====
create or replace function public.cockpit_summary(p_company uuid, p_year int, p_month int, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_start date := make_date(p_year, p_month, 1);
  v_end date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_today date;
  v_cut date; v_offset int;
  v_pm_start date; v_pm_end date; v_py_start date; v_py_end date;
  v_wd_total int; v_wd_elapsed int;
  v_cur jsonb; v_pm jsonb; v_py jsonb;
  v_target numeric; v_portfolio numeric; v_portfolio_count int;
  v_daily jsonb; v_sellers jsonb; v_products jsonb; v_customers jsonb; v_categories jsonb; v_states jsonb;
  v_is_demo boolean;
begin
  perform public.assert_company_access(p_company);
  v_today := public.data_as_of(p_company);
  select is_demo into v_is_demo from public.companies where id = p_company;

  v_cut := least(v_end, v_today);
  v_offset := v_cut - v_start;
  v_pm_start := (v_start - interval '1 month')::date;
  v_py_start := (v_start - interval '1 year')::date;
  if v_today between v_start and v_end then
    v_pm_end := least((v_start - 1), v_pm_start + v_offset);
    v_py_end := least((v_py_start + interval '1 month - 1 day')::date, v_py_start + v_offset);
  else
    v_pm_end := v_start - 1;
    v_py_end := (v_py_start + interval '1 month - 1 day')::date;
  end if;

  v_wd_total := public.working_days(p_company, v_start, v_end);
  v_wd_elapsed := case when v_today < v_start then 0 else public.working_days(p_company, v_start, v_cut) end;

  v_cur := public.sales_aggregate(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category);
  v_pm := public.sales_aggregate(p_company, v_pm_start, v_pm_end, p_channel, p_branch, p_seller, p_state, p_city, p_category);
  v_py := public.sales_aggregate(p_company, v_py_start, v_py_end, p_channel, p_branch, p_seller, p_state, p_city, p_category);

  select coalesce(sum(t.amount), 0) into v_target
  from public.sales_targets t join public.sellers s on s.id = t.seller_id
  where t.company_id = p_company and t.year = p_year and t.month = p_month and t.level = 'ACTIVE' and t.active
    and (p_channel is null or s.channel_id = p_channel)
    and (p_branch is null or s.branch_id = p_branch)
    and (p_seller is null or s.id = p_seller);

  select coalesce(sum(amount), 0), count(distinct order_id) into v_portfolio, v_portfolio_count
  from public.fact_orders(p_company, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  where status = 'open' and order_date <= v_today;

  with days as (
    select d::date as day,
      (extract(isodow from d) < 6 and not exists (select 1 from public.holidays h where h.date = d::date and (h.company_id is null or h.company_id = p_company))) as wd
    from generate_series(v_start, v_end, interval '1 day') d
  ), rev as (
    select competence_date, sum(amount) amt from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), joined as (
    select days.day, days.wd, coalesce(rev.amt, 0) amt,
      sum(coalesce(rev.amt,0)) over (order by days.day) cum,
      sum(case when days.wd then 1 else 0 end) over (order by days.day) wd_cum
    from days left join rev on rev.competence_date = days.day
  )
  select jsonb_agg(jsonb_build_object(
    'date', day, 'working', wd,
    'revenue', case when day <= v_today then amt else null end,
    'cumulative', case when day <= v_today then cum else null end,
    'targetCumulative', case when v_wd_total > 0 then round(v_target * wd_cum / v_wd_total, 2) else 0 end
  ) order by day) into v_daily from joined;

  with r as (
    select seller_id, sum(amount) amt, count(distinct invoice_id) nfs
    from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), t as (
    select seller_id, sum(amount) tgt from public.sales_targets
    where company_id = p_company and year = p_year and month = p_month and level = 'ACTIVE' and active group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'revenue', coalesce(r.amt,0), 'invoices', coalesce(r.nfs,0), 'target', coalesce(t.tgt,0)) order by coalesce(r.amt,0) desc), '[]'::jsonb)
  into v_sellers
  from public.sellers s left join r on r.seller_id = s.id left join t on t.seller_id = s.id
  where s.company_id = p_company and s.active
    and (p_channel is null or s.channel_id = p_channel)
    and (p_branch is null or s.branch_id = p_branch)
    and (p_seller is null or s.id = p_seller);

  select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') into v_products from (
    select jsonb_build_object('label', p.name, 'value', sum(f.amount)) x
    from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) f join public.products p on p.id = f.product_id
    group by p.name order by sum(f.amount) desc limit 6) q;
  select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') into v_customers from (
    select jsonb_build_object('label', c.name, 'value', sum(f.amount)) x
    from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) f join public.customers c on c.id = f.customer_id
    group by c.name order by sum(f.amount) desc limit 6) q;
  select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') into v_categories from (
    select jsonb_build_object('label', f.category, 'value', sum(f.amount)) x
    from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) f
    group by f.category order by sum(f.amount) desc limit 6) q;
  select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') into v_states from (
    select jsonb_build_object('label', f.state, 'value', sum(f.amount)) x
    from public.fact_sales(p_company, v_start, v_cut, p_channel, p_branch, p_seller, p_state, p_city, p_category) f
    group by f.state order by sum(f.amount) desc limit 6) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'cut', v_cut, 'asOf', v_today, 'isCurrent', v_today between v_start and v_end, 'isFuture', v_today < v_start),
    'comparison', jsonb_build_object('previousMonth', jsonb_build_object('start', v_pm_start, 'end', v_pm_end), 'previousYear', jsonb_build_object('start', v_py_start, 'end', v_py_end)),
    'isDemo', coalesce(v_is_demo, false),
    'current', v_cur, 'previousMonth', v_pm, 'previousYear', v_py,
    'target', v_target, 'portfolio', v_portfolio, 'portfolioOrders', v_portfolio_count,
    'workingDays', jsonb_build_object('total', v_wd_total, 'elapsed', v_wd_elapsed),
    'daily', coalesce(v_daily, '[]'::jsonb),
    'sellers', v_sellers,
    'drivers', jsonb_build_object('products', v_products, 'customers', v_customers, 'categories', v_categories, 'states', v_states)
  );
end $$;

-- ===== Sales read models =====
create or replace function public.sales_kpis(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  with f as (
    select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  ), fb as (
    select i.customer_id, min(i.competence_date) d from public.invoices i
    where i.company_id = p_company and i.status = any(public.revenue_valid_statuses()) group by 1
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

create or replace function public.sales_timeline(p_company uuid, p_start date, p_end date, p_grain text, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  if p_grain not in ('day', 'week', 'month') then raise exception 'invalid grain'; end if;
  with b as (
    select g::date bucket from generate_series(date_trunc(p_grain, p_start::timestamp), p_end::timestamp, ('1 ' || p_grain)::interval) g
  ), f as (
    select date_trunc(p_grain, competence_date::timestamp)::date bucket, sum(amount) rev, sum(qty) units, count(distinct invoice_id) nfs
    from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('bucket', b.bucket, 'revenue', coalesce(f.rev, 0), 'units', coalesce(f.units, 0), 'invoices', coalesce(f.nfs, 0)) order by b.bucket), '[]'::jsonb)
  into v from b left join f using (bucket);
  return v;
end $$;

create or replace function public.sales_breakdown(p_company uuid, p_start date, p_end date, p_dim text, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  if p_dim not in ('seller', 'customer', 'product', 'category', 'state', 'city') then raise exception 'invalid dimension'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.revenue desc), '[]'::jsonb) into v from (
    select
      case p_dim when 'seller' then f.seller_id::text when 'customer' then f.customer_id::text when 'product' then f.product_id::text
        when 'category' then f.category when 'state' then f.state else f.state || '|' || f.city end as key,
      max(case p_dim when 'seller' then s.name when 'customer' then c.name when 'product' then p.name
        when 'category' then f.category when 'state' then f.state else f.city end) as label,
      max(case p_dim when 'product' then p.sku when 'city' then f.state when 'customer' then c.city || '/' || c.state else null end) as sub,
      max(case p_dim when 'product' then p.category else null end) as category,
      sum(f.amount) as revenue, sum(f.qty) as units, count(distinct f.invoice_id) as invoices,
      count(distinct f.customer_id) as customers, max(f.competence_date) as "lastDate"
    from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) f
    left join public.sellers s on s.id = f.seller_id
    left join public.customers c on c.id = f.customer_id
    left join public.products p on p.id = f.product_id
    group by 1) x;
  return v;
end $$;

create or replace function public.sales_invoices(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null, p_limit int default 5000)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (
    select jsonb_build_object('id', i.id, 'number', i.number, 'date', i.competence_date, 'competence', to_char(i.competence_date, 'YYYY-MM'),
      'customer', c.name, 'seller', s.name, 'sellerId', i.seller_id, 'city', c.city, 'state', c.state, 'status', i.status,
      'total', it.amt, 'items', it.n, 'counted', i.status = any(public.revenue_valid_statuses())) x
    from public.invoices i
    join public.customers c on c.id = i.customer_id
    left join public.sellers s on s.id = i.seller_id
    join lateral (select sum(ii.total) amt, count(*) n from public.invoice_items ii join public.products p on p.id = ii.product_id
                  where ii.invoice_id = i.id and (p_category is null or p.category = p_category)) it on it.n > 0
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

create or replace function public.sales_orders_list(p_company uuid, p_as_of date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.date desc, x.number desc), '[]'::jsonb) into v from (
    select f.order_id as id, f.number, f.status, f.order_date as date, f.expected_date as "expectedDate",
      c.name as customer, s.name as seller, f.seller_id as "sellerId", sum(f.amount) as total, count(*) as items,
      (p_as_of - f.order_date) as "ageDays"
    from public.fact_orders(p_company, p_channel, p_branch, p_seller, p_state, p_city, p_category) f
    join public.customers c on c.id = f.customer_id
    left join public.sellers s on s.id = f.seller_id
    where f.order_date <= p_as_of
    group by f.order_id, f.number, f.status, f.order_date, f.expected_date, c.name, s.name, f.seller_id) x;
  return v;
end $$;

create or replace function public.sales_items(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null, p_limit int default 10000)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (
    select jsonb_build_object('invoice', i.number, 'invoiceId', i.id, 'date', f.competence_date, 'sku', p.sku, 'product', p.name, 'category', f.category,
      'qty', f.qty, 'unitPrice', case when f.qty > 0 then round(f.amount / f.qty, 2) else null end, 'total', f.amount,
      'customer', c.name, 'seller', s.name) x
    from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) f
    join public.invoices i on i.id = f.invoice_id
    join public.products p on p.id = f.product_id
    join public.customers c on c.id = f.customer_id
    left join public.sellers s on s.id = f.seller_id
    order by f.competence_date desc, i.number desc
    limit p_limit) q;
  return v;
end $$;

create or replace function public.seller_history(p_company uuid, p_seller uuid, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb; v_first date := (date_trunc('month', p_end) - interval '11 months')::date;
begin
  perform public.assert_company_access(p_company);
  with m as (
    select g::date ms from generate_series(v_first, date_trunc('month', p_end)::date, interval '1 month') g
  ), r as (
    select date_trunc('month', competence_date)::date ms, sum(amount) amt
    from public.fact_sales(p_company, v_first, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), t as (
    select make_date(year, month, 1) ms,
      sum(amount) filter (where level = 'BASE') b, sum(amount) filter (where level = 'ACTIVE') a, sum(amount) filter (where level = 'CHALLENGE') c
    from public.sales_targets where company_id = p_company and seller_id = p_seller and active group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('month', m.ms, 'revenue', coalesce(r.amt, 0),
    'targets', jsonb_build_object('BASE', coalesce(t.b, 0), 'ACTIVE', coalesce(t.a, 0), 'CHALLENGE', coalesce(t.c, 0))) order by m.ms), '[]'::jsonb)
  into v from m left join r using (ms) left join t using (ms);
  return v;
end $$;

grant execute on function public.sales_kpis(uuid, date, date, uuid, uuid, uuid, text, text, text),
  public.sales_timeline(uuid, date, date, text, uuid, uuid, uuid, text, text, text),
  public.sales_breakdown(uuid, date, date, text, uuid, uuid, uuid, text, text, text),
  public.sales_invoices(uuid, date, date, uuid, uuid, uuid, text, text, text, int),
  public.sales_orders_list(uuid, date, uuid, uuid, uuid, text, text, text),
  public.sales_items(uuid, date, date, uuid, uuid, uuid, text, text, text, int),
  public.seller_history(uuid, uuid, date, uuid, uuid, text, text, text) to authenticated, service_role;
grant execute on function public.fact_sales(uuid, date, date, uuid, uuid, uuid, text, text, text),
  public.sales_aggregate(uuid, date, date, uuid, uuid, uuid, text, text, text),
  public.cockpit_summary(uuid, int, int, uuid, uuid, uuid, text, text, text),
  public.working_days(uuid, date, date), public.revenue_valid_statuses() to service_role;

-- ===== Job registry =====
create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null check (status in ('running', 'success', 'failed')),
  trigger text not null default 'cron' check (trigger in ('cron', 'manual')),
  triggered_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_written int not null default 0,
  error text
);
create index on public.job_runs (job_name, started_at desc);
grant select on public.job_runs to authenticated;
grant all on public.job_runs to service_role;
alter table public.job_runs enable row level security;
create policy "admins read jobs" on public.job_runs for select to authenticated using (public.is_admin(auth.uid()));

-- Snapshots are now written only by the server job (not on page reads).
drop policy if exists "snapshots insert" on public.flight_plan_snapshots;
drop policy if exists "snapshots update" on public.flight_plan_snapshots;
revoke insert, update on public.flight_plan_snapshots from authenticated;
alter table public.flight_plan_snapshots add column if not exists job_run_id uuid references public.job_runs(id) on delete set null;