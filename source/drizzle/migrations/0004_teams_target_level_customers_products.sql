-- ===== Central active target level (single definition, read by every SQL read model) =====
create or replace function public.active_target_level()
returns public.target_level language sql stable security invoker set search_path = public as $$
  select coalesce((select case when config->>'activeLevel' in ('BASE','ACTIVE','CHALLENGE')
                               then (config->>'activeLevel')::public.target_level end
                   from public.metric_config where metric_key = 'flight_plan'), 'ACTIVE'::public.target_level)
$$;
grant execute on function public.active_target_level() to authenticated, service_role;

do $$
declare d text;
begin
  select pg_get_functiondef('public.cockpit_summary(uuid,integer,integer,uuid,uuid,uuid,text,text,text)'::regprocedure) into d;
  d := replace(d, 'level = ''ACTIVE''', 'level = public.active_target_level()');
  d := replace(d, '''target'', v_target,', '''target'', v_target, ''targetLevel'', public.active_target_level(),');
  execute d;
end $$;

-- ===== Sales teams (membership history: closing valid_to never deletes the past) =====
create table public.sales_teams (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create table public.sales_team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.sales_teams(id) on delete cascade,
  seller_id uuid not null references public.sellers(id) on delete cascade,
  valid_from date not null default current_date,
  valid_to date,
  check (valid_to is null or valid_to >= valid_from)
);
create unique index sales_team_members_one_open on public.sales_team_members(seller_id) where valid_to is null;
create table public.sales_team_managers (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.sales_teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  valid_from date not null default current_date,
  valid_to date,
  check (valid_to is null or valid_to >= valid_from)
);
create unique index sales_team_managers_one_open on public.sales_team_managers(team_id, user_id) where valid_to is null;

grant select on public.sales_teams, public.sales_team_members, public.sales_team_managers to authenticated;
grant all on public.sales_teams, public.sales_team_members, public.sales_team_managers to service_role;
alter table public.sales_teams enable row level security;
alter table public.sales_team_members enable row level security;
alter table public.sales_team_managers enable row level security;
create policy "teams by company" on public.sales_teams for select to authenticated
  using (public.can_access_company(auth.uid(), company_id));
create policy "members by company" on public.sales_team_members for select to authenticated
  using (exists (select 1 from public.sales_teams t where t.id = team_id and public.can_access_company(auth.uid(), t.company_id)));
create policy "managers by company" on public.sales_team_managers for select to authenticated
  using (exists (select 1 from public.sales_teams t where t.id = team_id and public.can_access_company(auth.uid(), t.company_id)));

-- ===== Scope: broad roles see all sellers; GESTOR = own teams; VENDEDOR = self =====
create or replace function public.has_broad_scope(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id
                 and role in ('SUPER_ADMIN','ADMIN','DIRETORIA','FINANCEIRO','ANALISTA','VIEWER'))
$$;
create or replace function public.is_seller_restricted(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role in ('VENDEDOR','GESTOR'))
     and not public.has_broad_scope(_user_id)
$$;
create or replace function public.manages_seller(_user_id uuid, _seller uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(_user_id, 'GESTOR') and exists (
    select 1 from public.sales_team_members m
    join public.sales_team_managers g on g.team_id = m.team_id and g.valid_to is null
    join public.sales_teams t on t.id = m.team_id and t.active
    where m.seller_id = _seller and m.valid_to is null and g.user_id = _user_id)
$$;
create or replace function public.can_view_seller(_user_id uuid, _seller uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not public.is_seller_restricted(_user_id)
      or exists (select 1 from public.sellers where id = _seller and user_id = _user_id)
      or public.manages_seller(_user_id, _seller)
$$;
grant execute on function public.has_broad_scope(uuid), public.manages_seller(uuid, uuid) to authenticated, service_role;

-- Customers: restricted users only see customers served within their scope
drop policy "dim by company" on public.customers;
create policy "customers scoped" on public.customers for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and (
    not public.is_seller_restricted(auth.uid())
    or exists (select 1 from public.invoices i where i.customer_id = customers.id and public.can_view_seller(auth.uid(), i.seller_id))
    or exists (select 1 from public.sales_orders o where o.customer_id = customers.id and public.can_view_seller(auth.uid(), o.seller_id))));

-- ===== Customer document (CPF/CNPJ, masked in the UI) + demo seed =====
alter table public.customers add column document text;
update public.customers c set document =
  case when (get_byte(decode(md5(c.id::text), 'hex'), 0) % 5) = 0
    then lpad((('x' || substr(md5(c.id::text), 1, 12))::bit(48)::bigint % 100000000000)::text, 11, '0')
    else lpad((('x' || substr(md5(c.id::text), 1, 12))::bit(48)::bigint % 100000000)::text, 8, '0') || '0001'
         || lpad((('x' || substr(md5(c.id::text), 13, 4))::bit(16)::int % 100)::text, 2, '0') end
where c.company_id in (select id from public.companies where is_demo);

-- Demo teams: split each demo company's sellers into two teams
insert into public.sales_teams (company_id, name)
select c.id, n from public.companies c, unnest(array['Equipe Corporativo','Equipe Varejo']) n where c.is_demo;
insert into public.sales_team_members (team_id, seller_id, valid_from)
select t.id, s.id, date '2025-01-01'
from (select s.*, row_number() over (partition by company_id order by name) rn from public.sellers s) s
join public.companies c on c.id = s.company_id and c.is_demo
join public.sales_teams t on t.company_id = s.company_id
  and t.name = case when s.rn % 2 = 1 then 'Equipe Corporativo' else 'Equipe Varejo' end;

-- ===== Customers read models =====
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
    select i.customer_id, min(i.competence_date) first_d, max(i.competence_date) last_d, count(distinct i.id) nfs_all, sum(it.total) life_rev
    from public.invoices i join public.invoice_items it on it.invoice_id = i.id
    where i.company_id = p_company and i.status = any(public.revenue_valid_statuses()) and i.competence_date <= p_as_of group by 1
  ), main as (
    select distinct on (customer_id) customer_id, seller_id from (
      select i.customer_id, i.seller_id, sum(it.total) s from public.invoices i join public.invoice_items it on it.invoice_id = i.id
      where i.company_id = p_company and i.status = any(public.revenue_valid_statuses()) and i.competence_date <= p_as_of group by 1, 2) x
    order by customer_id, s desc
  ), r as (
    select c.id, c.name, c.document, c.city, c.state, m.seller_id, s.name seller, h.first_d, h.last_d, h.nfs_all, h.life_rev,
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
  select * into v_c from public.customers where id = p_customer and company_id = p_company;
  if not found then return null; end if;
  with valid as (
    select i.id, i.number, i.competence_date d, i.seller_id, it.total, it.quantity, it.product_id
    from public.invoices i join public.invoice_items it on it.invoice_id = i.id
    where i.company_id = p_company and i.customer_id = p_customer and i.status = any(public.revenue_valid_statuses()) and i.competence_date <= p_as_of
  ), f as (
    select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  ), months as (
    select g::date ms from generate_series(date_trunc('month', p_end::timestamp) - interval '23 months', date_trunc('month', p_end::timestamp), interval '1 month') g
  ), main as (
    select v2.seller_id, s.name, sum(v2.total) t from valid v2 left join public.sellers s on s.id = v2.seller_id group by 1, 2 order by 3 desc limit 1
  )
  select jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'document', v_c.document, 'city', v_c.city, 'state', v_c.state,
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
      select f.product_id id, p.sku, p.name, p.category, sum(f.qty) units, sum(f.amount) revenue, max(f.competence_date) "lastDate"
      from f join public.products p on p.id = f.product_id where f.customer_id = p_customer group by 1, 2, 3, 4) x),
    'invoices', (select coalesce(jsonb_agg(to_jsonb(x) order by x.date desc), '[]'::jsonb) from (
      select v3.id, v3.number, v3.d date, s.name seller, sum(v3.total) total from valid v3 left join public.sellers s on s.id = v3.seller_id
      group by 1, 2, 3, 4 order by 3 desc limit 50) x)
  ) into v;
  return v;
end $$;

-- ===== Products read models =====
create or replace function public.products_overview(p_company uuid, p_start date, p_end date,
  p_channel uuid default null, p_branch uuid default null, p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  with f as (select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)),
  r as (
    select f.product_id id, p.sku, p.name, p.category, sum(f.qty) units, sum(f.amount) revenue,
      count(distinct f.customer_id) customers, count(distinct f.seller_id) sellers, max(f.competence_date) "lastDate"
    from f join public.products p on p.id = f.product_id group by 1, 2, 3, 4)
  select jsonb_build_object(
    'summary', jsonb_build_object('products', (select count(*) from r), 'units', (select coalesce(sum(qty), 0) from f),
      'revenue', (select coalesce(sum(amount), 0) from f), 'customers', (select count(distinct customer_id) from f),
      'categories', (select count(distinct category) from f)),
    'rows', (select coalesce(jsonb_agg(to_jsonb(r) order by r.revenue desc), '[]'::jsonb) from r))
  into v;
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
      'lastSale', (select max(i.competence_date) from public.invoices i join public.invoice_items it on it.invoice_id = i.id
                   where it.product_id = p_product and i.company_id = p_company and i.status = any(public.revenue_valid_statuses()))),
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

grant execute on function public.customers_overview(uuid, date, date, date, int, uuid, uuid, uuid, text, text, text),
  public.customer_360(uuid, uuid, date, date, date, uuid, uuid, uuid, text, text, text),
  public.products_overview(uuid, date, date, uuid, uuid, uuid, text, text, text),
  public.product_360(uuid, uuid, date, date, date, text, uuid, uuid, uuid, text, text, text) to authenticated, service_role;