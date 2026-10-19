-- ============ ENUMS ============
create type public.app_role as enum ('SUPER_ADMIN','ADMIN','DIRETORIA','GESTOR','VENDEDOR','FINANCEIRO','ANALISTA','VIEWER');
create type public.invoice_status as enum ('authorized','cancelled','denied');
create type public.order_status as enum ('open','invoiced','cancelled');
create type public.target_level as enum ('BASE','ACTIVE','CHALLENGE');

-- ============ CORE / TENANCY ============
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.profiles (
  id uuid primary key,
  email text,
  full_name text,
  default_company_id uuid references public.companies(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role public.app_role not null,
  unique (user_id, role)
);
create table public.user_company_access (
  user_id uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  primary key (user_id, company_id)
);
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- ============ DIMENSIONS ============
create table public.channels (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade, name text not null);
create table public.branches (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade, name text not null);
create table public.sellers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel_id uuid references public.channels(id),
  branch_id uuid references public.branches(id),
  user_id uuid,
  name text not null,
  active boolean not null default true
);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null, state text not null, city text not null,
  created_at date not null default current_date
);
create table public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null, category text not null, base_price numeric(14,2) not null
);
create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  date date not null, name text not null, scope text not null default 'national'
);

-- ============ FACTS ============
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel_id uuid references public.channels(id),
  branch_id uuid references public.branches(id),
  seller_id uuid references public.sellers(id),
  customer_id uuid not null references public.customers(id),
  number text not null,
  status public.invoice_status not null default 'authorized',
  competence_date date not null,
  total numeric(14,2) not null default 0,
  source text not null default 'demo'
);
create index on public.invoices (company_id, competence_date);
create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  seller_id uuid references public.sellers(id),
  product_id uuid not null references public.products(id),
  quantity numeric(12,2) not null,
  total numeric(14,2) not null
);
create index on public.invoice_items (invoice_id);
create index on public.invoice_items (company_id);
create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel_id uuid references public.channels(id),
  branch_id uuid references public.branches(id),
  seller_id uuid references public.sellers(id),
  customer_id uuid not null references public.customers(id),
  number text not null,
  status public.order_status not null default 'open',
  order_date date not null,
  total numeric(14,2) not null,
  source text not null default 'demo'
);
create index on public.sales_orders (company_id, status);
create table public.sales_targets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel_id uuid references public.channels(id),
  seller_id uuid references public.sellers(id),
  year int not null, month int not null,
  level public.target_level not null default 'ACTIVE',
  amount numeric(14,2) not null,
  active boolean not null default true
);
create index on public.sales_targets (company_id, year, month);

-- ============ METRIC CONFIG ============
create table public.metric_config (
  metric_key text primary key,
  config jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now()
);

-- ============ GRANTS ============
grant select on public.companies, public.channels, public.branches, public.sellers, public.customers, public.products,
  public.holidays, public.invoices, public.invoice_items, public.sales_orders, public.sales_targets, public.metric_config to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, delete on public.user_roles to authenticated;
grant select, insert, delete on public.user_company_access to authenticated;
grant select on public.audit_log to authenticated;
grant all on public.companies, public.profiles, public.user_roles, public.user_company_access, public.audit_log, public.channels,
  public.branches, public.sellers, public.customers, public.products, public.holidays, public.invoices, public.invoice_items,
  public.sales_orders, public.sales_targets, public.metric_config to service_role;

-- ============ SECURITY FUNCTIONS ============
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;
create or replace function public.is_admin(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role in ('SUPER_ADMIN','ADMIN'))
$$;
create or replace function public.can_access_company(_user_id uuid, _company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(_user_id,'SUPER_ADMIN')
      or exists (select 1 from public.user_company_access where user_id = _user_id and company_id = _company)
$$;
-- Seller-restricted users = only VENDEDOR role, without any broader role
create or replace function public.is_seller_restricted(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id=_user_id and role='VENDEDOR')
     and not exists (select 1 from public.user_roles where user_id=_user_id and role <> 'VENDEDOR')
$$;
create or replace function public.can_view_seller(_user_id uuid, _seller uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not public.is_seller_restricted(_user_id)
      or exists (select 1 from public.sellers where id = _seller and user_id = _user_id)
$$;

-- ============ RLS ============
alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.user_company_access enable row level security;
alter table public.audit_log enable row level security;
alter table public.channels enable row level security;
alter table public.branches enable row level security;
alter table public.sellers enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.holidays enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.sales_orders enable row level security;
alter table public.sales_targets enable row level security;
alter table public.metric_config enable row level security;

create policy "companies by access" on public.companies for select to authenticated using (public.can_access_company(auth.uid(), id));
create policy "own profile or admin" on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin(auth.uid()));
create policy "update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "own roles or admin" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.is_admin(auth.uid()));
create policy "admin grants roles" on public.user_roles for insert to authenticated
  with check (public.is_admin(auth.uid()) and (role <> 'SUPER_ADMIN' or public.has_role(auth.uid(),'SUPER_ADMIN')));
create policy "admin revokes roles" on public.user_roles for delete to authenticated
  using (public.is_admin(auth.uid()) and (role <> 'SUPER_ADMIN' or public.has_role(auth.uid(),'SUPER_ADMIN')) and user_id <> auth.uid());
create policy "own access or admin" on public.user_company_access for select to authenticated using (user_id = auth.uid() or public.is_admin(auth.uid()));
create policy "admin grants access" on public.user_company_access for insert to authenticated with check (public.is_admin(auth.uid()));
create policy "admin revokes access" on public.user_company_access for delete to authenticated using (public.is_admin(auth.uid()));
create policy "admin reads audit" on public.audit_log for select to authenticated using (public.is_admin(auth.uid()));

create policy "dim by company" on public.channels for select to authenticated using (public.can_access_company(auth.uid(), company_id));
create policy "dim by company" on public.branches for select to authenticated using (public.can_access_company(auth.uid(), company_id));
create policy "dim by company" on public.customers for select to authenticated using (public.can_access_company(auth.uid(), company_id));
create policy "dim by company" on public.products for select to authenticated using (public.can_access_company(auth.uid(), company_id));
create policy "sellers scoped" on public.sellers for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), id));
create policy "holidays" on public.holidays for select to authenticated using (company_id is null or public.can_access_company(auth.uid(), company_id));
create policy "facts scoped" on public.invoices for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id));
create policy "facts scoped" on public.invoice_items for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id));
create policy "facts scoped" on public.sales_orders for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id));
create policy "targets scoped" on public.sales_targets for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and (seller_id is null or public.can_view_seller(auth.uid(), seller_id)));
create policy "metric config readable" on public.metric_config for select to authenticated using (true);

-- ============ AUDIT TRIGGER ============
create or replace function public.audit_user_roles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log(actor_id, action, entity, entity_id, payload)
  values (auth.uid(), lower(tg_op), 'user_roles', coalesce(new.user_id, old.user_id)::text,
          jsonb_build_object('role', coalesce(new.role, old.role)));
  return coalesce(new, old);
end $$;
create trigger trg_audit_user_roles after insert or delete on public.user_roles for each row execute function public.audit_user_roles();

-- ============ CALENDAR / WORKING DAYS ============
create or replace view public.calendar_date with (security_invoker = true) as
select d::date as date, extract(year from d)::int as year, extract(quarter from d)::int as quarter,
  extract(month from d)::int as month, extract(week from d)::int as week, extract(day from d)::int as day,
  extract(isodow from d)::int as weekday,
  exists (select 1 from public.holidays h where h.date = d::date and h.company_id is null) as is_holiday,
  (extract(isodow from d) < 6 and not exists (select 1 from public.holidays h where h.date = d::date and h.company_id is null)) as is_working_day
from generate_series('2024-01-01'::date, '2028-12-31'::date, interval '1 day') d;
grant select on public.calendar_date to authenticated;

create or replace function public.working_days(p_company uuid, p_start date, p_end date)
returns int language sql stable security invoker set search_path = public as $$
  select count(*)::int from generate_series(p_start, p_end, interval '1 day') d
  where p_end >= p_start and extract(isodow from d) < 6
    and not exists (select 1 from public.holidays h where h.date = d::date and (h.company_id is null or h.company_id = p_company))
$$;

-- ============ SEMANTIC LAYER ============
create or replace function public.revenue_valid_statuses()
returns public.invoice_status[] language sql stable security invoker set search_path = public as $$
  select coalesce(
    (select array_agg(s::public.invoice_status) from public.metric_config mc, jsonb_array_elements_text(mc.config->'valid_statuses') s where mc.metric_key='revenue'),
    array['authorized']::public.invoice_status[])
$$;

create or replace function public.fact_sales(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns table(invoice_id uuid, competence_date date, seller_id uuid, customer_id uuid, product_id uuid, category text, state text, city text, qty numeric, amount numeric)
language sql stable security invoker set search_path = public as $$
  select i.id, i.competence_date, i.seller_id, i.customer_id, it.product_id, p.category, c.state, c.city, it.quantity, it.total
  from public.invoices i
  join public.invoice_items it on it.invoice_id = i.id
  join public.products p on p.id = it.product_id
  join public.customers c on c.id = i.customer_id
  where i.company_id = p_company and i.competence_date between p_start and p_end
    and i.status = any(public.revenue_valid_statuses())
    and (p_channel is null or i.channel_id = p_channel)
    and (p_branch is null or i.branch_id = p_branch)
    and (p_seller is null or i.seller_id = p_seller)
    and (p_state is null or c.state = p_state)
    and (p_city is null or c.city = p_city)
    and (p_category is null or p.category = p_category)
$$;

create or replace function public.sales_aggregate(p_company uuid, p_start date, p_end date, p_channel uuid, p_branch uuid,
  p_seller uuid, p_state text, p_city text, p_category text)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'revenue', coalesce(sum(amount),0),
    'invoices', count(distinct invoice_id),
    'customers', count(distinct customer_id),
    'units', coalesce(sum(qty),0))
  from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
$$;

create or replace function public.cockpit_summary(p_company uuid, p_year int, p_month int, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_start date := make_date(p_year, p_month, 1);
  v_end date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_cut date; v_offset int;
  v_pm_start date; v_pm_end date; v_py_start date; v_py_end date;
  v_wd_total int; v_wd_elapsed int;
  v_cur jsonb; v_pm jsonb; v_py jsonb;
  v_target numeric; v_portfolio numeric; v_portfolio_count int;
  v_daily jsonb; v_sellers jsonb; v_products jsonb; v_customers jsonb; v_categories jsonb; v_states jsonb;
  v_is_demo boolean;
begin
  if not public.can_access_company(auth.uid(), p_company) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
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

  v_cur := public.sales_aggregate(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category);
  v_pm := public.sales_aggregate(p_company, v_pm_start, v_pm_end, p_channel, p_branch, p_seller, p_state, p_city, p_category);
  v_py := public.sales_aggregate(p_company, v_py_start, v_py_end, p_channel, p_branch, p_seller, p_state, p_city, p_category);

  select coalesce(sum(t.amount), 0) into v_target
  from public.sales_targets t join public.sellers s on s.id = t.seller_id
  where t.company_id = p_company and t.year = p_year and t.month = p_month and t.level = 'ACTIVE' and t.active
    and (p_channel is null or s.channel_id = p_channel)
    and (p_branch is null or s.branch_id = p_branch)
    and (p_seller is null or s.id = p_seller);

  select coalesce(sum(o.total), 0), count(*) into v_portfolio, v_portfolio_count
  from public.sales_orders o join public.customers c on c.id = o.customer_id
  where o.company_id = p_company and o.status = 'open'
    and (p_channel is null or o.channel_id = p_channel)
    and (p_branch is null or o.branch_id = p_branch)
    and (p_seller is null or o.seller_id = p_seller)
    and (p_state is null or c.state = p_state)
    and (p_city is null or c.city = p_city);

  with days as (
    select d::date as day,
      (extract(isodow from d) < 6 and not exists (select 1 from public.holidays h where h.date = d::date and (h.company_id is null or h.company_id = p_company))) as wd
    from generate_series(v_start, v_end, interval '1 day') d
  ), rev as (
    select competence_date, sum(amount) amt from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
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
    from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
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
    from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) f join public.products p on p.id = f.product_id
    group by p.name order by sum(f.amount) desc limit 6) q;
  select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') into v_customers from (
    select jsonb_build_object('label', c.name, 'value', sum(f.amount)) x
    from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) f join public.customers c on c.id = f.customer_id
    group by c.name order by sum(f.amount) desc limit 6) q;
  select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') into v_categories from (
    select jsonb_build_object('label', f.category, 'value', sum(f.amount)) x
    from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) f
    group by f.category order by sum(f.amount) desc limit 6) q;
  select coalesce(jsonb_agg(x order by (x->>'value')::numeric desc), '[]') into v_states from (
    select jsonb_build_object('label', f.state, 'value', sum(f.amount)) x
    from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) f
    group by f.state order by sum(f.amount) desc limit 6) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'cut', v_cut, 'isCurrent', v_today between v_start and v_end, 'isFuture', v_today < v_start),
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

grant execute on function public.working_days(uuid, date, date), public.revenue_valid_statuses(),
  public.fact_sales(uuid, date, date, uuid, uuid, uuid, text, text, text),
  public.sales_aggregate(uuid, date, date, uuid, uuid, uuid, text, text, text),
  public.cockpit_summary(uuid, int, int, uuid, uuid, uuid, text, text, text) to authenticated;

-- ============ SEED: METRIC CONFIG + HOLIDAYS ============
insert into public.metric_config (metric_key, config) values
  ('revenue', '{"valid_statuses":["authorized"],"date_field":"competence_date","source":"invoices"}');

insert into public.holidays (date, name) values
 ('2025-01-01','Confraternização Universal'),('2025-03-03','Carnaval'),('2025-03-04','Carnaval'),('2025-04-18','Sexta-feira Santa'),
 ('2025-04-21','Tiradentes'),('2025-05-01','Dia do Trabalho'),('2025-06-19','Corpus Christi'),('2025-09-07','Independência'),
 ('2025-10-12','Nossa Senhora Aparecida'),('2025-11-02','Finados'),('2025-11-15','Proclamação da República'),('2025-11-20','Consciência Negra'),('2025-12-25','Natal'),
 ('2026-01-01','Confraternização Universal'),('2026-02-16','Carnaval'),('2026-02-17','Carnaval'),('2026-04-03','Sexta-feira Santa'),
 ('2026-04-21','Tiradentes'),('2026-05-01','Dia do Trabalho'),('2026-06-04','Corpus Christi'),('2026-09-07','Independência'),
 ('2026-10-12','Nossa Senhora Aparecida'),('2026-11-02','Finados'),('2026-11-15','Proclamação da República'),('2026-11-20','Consciência Negra'),('2026-12-25','Natal');

-- ============ SEED: DEMO DATA ============
insert into public.companies (name, slug, is_demo) values
  ('MAG Móveis Corporativos', 'mag-moveis', true),
  ('MAG Design Store', 'mag-design-store', true);

do $$
declare
  c record; ch uuid[]; br uuid[]; sl uuid[]; cu uuid[]; pr uuid[]; prices numeric[];
  d date; n int; k int; inv uuid; s_idx int; cust uuid; scale numeric;
  states text[] := array['SP','SP','SP','RJ','MG','PR','SC','RS','BA','DF','GO','PE'];
  cities text[] := array['São Paulo','Campinas','Santos','Rio de Janeiro','Belo Horizonte','Curitiba','Florianópolis','Porto Alegre','Salvador','Brasília','Goiânia','Recife'];
  first_names text[] := array['Ana','Bruno','Carla','Diego','Eduarda','Felipe','Gabriela','Henrique','Isabela','João'];
  last_names text[] := array['Souza','Lima','Ferreira','Almeida','Costa','Ribeiro','Martins','Barbosa','Rocha','Carvalho'];
  corp text[] := array['Grupo','Construtora','Escritório','Banco','Clínica','Colégio','Tech','Indústria','Logística','Advocacia'];
  corp2 text[] := array['Horizonte','Atlas','Vértice','Aurora','Prisma','Nobre','Delta','Sigma','Pioneira','Central','Integra','Nova Era'];
  cats text[] := array['Cadeiras','Mesas','Armários','Estações de Trabalho','Acessórios'];
  pnames text[] := array['Cadeira Presidente','Cadeira Diretor','Cadeira Operacional','Cadeira Ergonômica','Longarina','Mesa Reunião','Mesa Diretoria','Mesa Plataforma','Mesa Lateral','Mesa Auxiliar','Armário Alto','Armário Baixo','Gaveteiro Volante','Roupeiro','Arquivo de Aço','Estação 4 Lugares','Estação Bench','Estação em L','Estação Call Center','Estação Individual','Divisória Acústica','Apoio de Pés','Suporte Monitor','Calha Elétrica','Painel Organizador'];
  pr_idx int; qty int; amt numeric;
begin
  for c in select * from public.companies where is_demo loop
    scale := case when c.slug = 'mag-moveis' then 1 else 0.45 end;
    insert into public.channels (company_id, name) values (c.id,'Varejo'),(c.id,'Corporativo'),(c.id,'E-commerce');
    insert into public.branches (company_id, name) values (c.id,'Matriz São Paulo'),(c.id,'Filial Rio de Janeiro');
    select array_agg(id order by name) into ch from public.channels where company_id = c.id;
    select array_agg(id order by name) into br from public.branches where company_id = c.id;
    for k in 1..8 loop
      insert into public.sellers (company_id, channel_id, branch_id, name)
      values (c.id, ch[1 + (k % 3)], br[1 + (k % 2)], first_names[k] || ' ' || last_names[1 + ((k*3) % 10)]);
    end loop;
    select array_agg(id order by name) into sl from public.sellers where company_id = c.id;
    for k in 1..120 loop
      n := 1 + floor(random()*12)::int;
      insert into public.customers (company_id, name, state, city, created_at)
      values (c.id, corp[1 + (k % 10)] || ' ' || corp2[1 + ((k*7) % 12)] || ' ' || k, states[n], cities[n], date '2024-06-01' + floor(random()*800)::int);
    end loop;
    select array_agg(id) into cu from public.customers where company_id = c.id;
    for k in 1..25 loop
      insert into public.products (company_id, name, category, base_price)
      values (c.id, pnames[k], cats[1 + ((k-1)/5)], round((400 + random()*4200)::numeric, 2));
    end loop;
    select array_agg(id order by name), array_agg(base_price order by name) into pr, prices from public.products where company_id = c.id;

    d := date '2025-01-01';
    while d <= (now() at time zone 'America/Sao_Paulo')::date loop
      if extract(isodow from d) < 6 and not exists (select 1 from public.holidays h where h.date = d) then
        n := greatest(1, round((3 + random()*6) * scale * (1 + 0.15*sin(extract(month from d)::numeric))))::int;
        for k in 1..n loop
          s_idx := 1 + floor(power(random(), 1.4) * 8)::int;
          cust := cu[1 + floor(random()*array_length(cu,1))::int];
          insert into public.invoices (company_id, channel_id, branch_id, seller_id, customer_id, number, status, competence_date)
          select c.id, s.channel_id, s.branch_id, s.id, cust, 'NF-' || to_char(d,'YYMMDD') || '-' || k,
                 case when random() < 0.04 then 'cancelled'::public.invoice_status else 'authorized'::public.invoice_status end, d
          from public.sellers s where s.id = sl[s_idx]
          returning id into inv;
          for qty in 1..(1 + floor(random()*3)::int) loop
            pr_idx := 1 + floor(random()*25)::int;
            amt := prices[pr_idx] * (1 + floor(random()*6));
            insert into public.invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total)
            values (inv, c.id, sl[s_idx], pr[pr_idx], round(amt / prices[pr_idx]), round(amt, 2));
          end loop;
        end loop;
      end if;
      d := d + 1;
    end loop;

    for k in 1..(case when c.slug='mag-moveis' then 70 else 30 end) loop
      s_idx := 1 + floor(random()*8)::int;
      insert into public.sales_orders (company_id, channel_id, branch_id, seller_id, customer_id, number, status, order_date, total)
      select c.id, s.channel_id, s.branch_id, s.id, cu[1 + floor(random()*array_length(cu,1))::int], 'PV-' || lpad(k::text, 5, '0'),
             'open', (now() at time zone 'America/Sao_Paulo')::date - floor(random()*40)::int, round((2000 + random()*18000)::numeric, 2)
      from public.sellers s where s.id = sl[s_idx];
    end loop;
  end loop;
end $$;

update public.invoices i set total = x.t from (select invoice_id, sum(total) t from public.invoice_items group by 1) x where x.invoice_id = i.id;

-- Targets: per seller, avg monthly 2025 revenue * growth, for 2025..2026
insert into public.sales_targets (company_id, channel_id, seller_id, year, month, level, amount)
select s.company_id, s.channel_id, s.id, y, m, lvl.level,
  round(coalesce(avg_rev, 20000) * lvl.factor * (case when y = 2026 then 1.12 else 1 end), -2)
from public.sellers s
cross join generate_series(2025, 2026) y
cross join generate_series(1, 12) m
cross join (values ('BASE'::public.target_level, 0.95), ('ACTIVE'::public.target_level, 1.10), ('CHALLENGE'::public.target_level, 1.30)) lvl(level, factor)
left join (
  select seller_id, sum(total) / 12.0 avg_rev from public.invoices
  where status = 'authorized' and competence_date between '2025-01-01' and '2025-12-31' group by 1
) a on a.seller_id = s.id;