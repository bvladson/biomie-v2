
-- ===== FLIGHT PLAN: config =====
insert into public.metric_config (metric_key, config) values ('flight_plan', '{
  "activeLevel": "ACTIVE",
  "status": {"onTrack": 0.97, "attention": 0.90, "risk": 0.75},
  "ageBuckets": {"freshMaxDays": 15, "recentMaxDays": 45},
  "probableWeights": {"fresh": 0.9, "recent": 0.6, "aged": 0.3},
  "accelerationAlert": 0.2
}'::jsonb) on conflict (metric_key) do nothing;

create or replace function public.can_write_flight_plan(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role in ('SUPER_ADMIN','ADMIN','DIRETORIA','GESTOR','VENDEDOR'))
$$;

create type public.fp_action_status as enum ('OPEN','IN_PROGRESS','RESOLVED');

-- ===== COMMITS (manual forecast) =====
create table public.flight_plan_commits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  seller_id uuid not null references public.sellers(id) on delete cascade,
  year int not null, month int not null check (month between 1 and 12),
  amount numeric(14,2) not null check (amount >= 0),
  note text check (char_length(note) <= 500),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, seller_id, year, month)
);
grant select, insert, update, delete on public.flight_plan_commits to authenticated;
grant all on public.flight_plan_commits to service_role;
alter table public.flight_plan_commits enable row level security;
create policy "commits read" on public.flight_plan_commits for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id));
create policy "commits insert" on public.flight_plan_commits for insert to authenticated
  with check (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id) and public.can_write_flight_plan(auth.uid()));
create policy "commits update" on public.flight_plan_commits for update to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id) and public.can_write_flight_plan(auth.uid()))
  with check (public.can_access_company(auth.uid(), company_id) and public.can_view_seller(auth.uid(), seller_id) and public.can_write_flight_plan(auth.uid()));

-- ===== ACTIONS =====
create table public.flight_plan_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  seller_id uuid references public.sellers(id) on delete cascade,
  year int not null, month int not null check (month between 1 and 12),
  type text not null,
  priority int not null default 3,
  message text not null,
  status public.fp_action_status not null default 'OPEN',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index flight_plan_actions_key on public.flight_plan_actions
  (company_id, coalesce(seller_id, '00000000-0000-0000-0000-000000000000'::uuid), year, month, type);
grant select, insert, update on public.flight_plan_actions to authenticated;
grant all on public.flight_plan_actions to service_role;
alter table public.flight_plan_actions enable row level security;
create policy "actions read" on public.flight_plan_actions for select to authenticated
  using (public.can_access_company(auth.uid(), company_id)
    and (case when seller_id is null then not public.is_seller_restricted(auth.uid()) else public.can_view_seller(auth.uid(), seller_id) end));
create policy "actions insert" on public.flight_plan_actions for insert to authenticated
  with check (public.can_access_company(auth.uid(), company_id) and public.can_write_flight_plan(auth.uid())
    and (case when seller_id is null then not public.is_seller_restricted(auth.uid()) else public.can_view_seller(auth.uid(), seller_id) end));
create policy "actions update" on public.flight_plan_actions for update to authenticated
  using (public.can_access_company(auth.uid(), company_id) and public.can_write_flight_plan(auth.uid())
    and (case when seller_id is null then not public.is_seller_restricted(auth.uid()) else public.can_view_seller(auth.uid(), seller_id) end));

-- ===== DAILY SNAPSHOTS =====
create table public.flight_plan_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  seller_id uuid references public.sellers(id) on delete cascade,
  snapshot_date date not null,
  year int not null, month int not null,
  active_level public.target_level not null,
  target numeric(14,2) not null,
  realized numeric(14,2) not null,
  ideal numeric(14,2),
  deviation numeric(14,2),
  gap numeric(14,2),
  current_pace numeric(14,2),
  required_pace numeric(14,2),
  run_rate numeric(14,2),
  forecast_base numeric(14,2),
  forecast_probable numeric(14,2),
  forecast_commit numeric(14,2),
  portfolio numeric(14,2),
  coverage numeric(10,4),
  status text,
  working_days_elapsed int,
  working_days_total int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index flight_plan_snapshots_key on public.flight_plan_snapshots
  (company_id, coalesce(seller_id, '00000000-0000-0000-0000-000000000000'::uuid), snapshot_date);
grant select, insert, update on public.flight_plan_snapshots to authenticated;
grant all on public.flight_plan_snapshots to service_role;
alter table public.flight_plan_snapshots enable row level security;
create policy "snapshots read" on public.flight_plan_snapshots for select to authenticated
  using (public.can_access_company(auth.uid(), company_id)
    and (case when seller_id is null then not public.is_seller_restricted(auth.uid()) else public.can_view_seller(auth.uid(), seller_id) end));
create policy "snapshots insert" on public.flight_plan_snapshots for insert to authenticated
  with check (public.can_access_company(auth.uid(), company_id)
    and (case when seller_id is null then not public.is_seller_restricted(auth.uid()) else public.can_view_seller(auth.uid(), seller_id) end));
create policy "snapshots update" on public.flight_plan_snapshots for update to authenticated
  using (public.can_access_company(auth.uid(), company_id)
    and (case when seller_id is null then not public.is_seller_restricted(auth.uid()) else public.can_view_seller(auth.uid(), seller_id) end));

-- ===== READ MODEL =====
-- Returns raw facts only; all ratios are computed by the FlightPlanEngine (TS).
create or replace function public.flight_plan_dataset(p_company uuid, p_year int, p_month int, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_start date := make_date(p_year, p_month, 1);
  v_end date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_cut date; v_offset int;
  v_cfg jsonb; v_fresh int; v_recent int;
  v_days jsonb; v_sellers jsonb; v_actions jsonb; v_cmp jsonb;
  v_pm_start date; v_py_start date;
begin
  if not public.can_access_company(auth.uid(), p_company) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select config into v_cfg from public.metric_config where metric_key = 'flight_plan';
  v_fresh := coalesce((v_cfg->'ageBuckets'->>'freshMaxDays')::int, 15);
  v_recent := coalesce((v_cfg->'ageBuckets'->>'recentMaxDays')::int, 45);
  v_cut := least(v_end, v_today);
  v_offset := v_cut - v_start;
  v_pm_start := (v_start - interval '1 month')::date;
  v_py_start := (v_start - interval '1 year')::date;

  with days as (
    select d::date as day,
      (extract(isodow from d) < 6 and not exists (select 1 from public.holidays h where h.date = d::date and (h.company_id is null or h.company_id = p_company))) as wd
    from generate_series(v_start, v_end, interval '1 day') d
  ), rev as (
    select competence_date, sum(amount) amt from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  )
  select jsonb_agg(jsonb_build_object('date', day, 'working', wd, 'revenue', case when day <= v_today then coalesce(rev.amt, 0) else null end) order by day)
  into v_days from days left join rev on rev.competence_date = days.day;

  with vis as (
    select s.id, s.name from public.sellers s
    where s.company_id = p_company and s.active
      and public.can_view_seller(auth.uid(), s.id)
      and (p_channel is null or s.channel_id = p_channel)
      and (p_branch is null or s.branch_id = p_branch)
      and (p_seller is null or s.id = p_seller)
  ), r as (
    select seller_id, sum(amount) amt, count(distinct invoice_id) nfs
    from public.fact_sales(p_company, v_start, v_end, p_channel, p_branch, p_seller, p_state, p_city, p_category) group by 1
  ), t as (
    select seller_id,
      sum(amount) filter (where level = 'BASE') b, sum(amount) filter (where level = 'ACTIVE') a, sum(amount) filter (where level = 'CHALLENGE') c
    from public.sales_targets where company_id = p_company and year = p_year and month = p_month and active group by 1
  ), o as (
    select o.seller_id,
      sum(o.total) filter (where v_today - o.order_date <= v_fresh) fresh,
      sum(o.total) filter (where v_today - o.order_date > v_fresh and v_today - o.order_date <= v_recent) recent,
      sum(o.total) filter (where v_today - o.order_date > v_recent) aged,
      count(*) n
    from public.sales_orders o join public.customers c on c.id = o.customer_id
    where o.company_id = p_company and o.status = 'open'
      and (p_state is null or c.state = p_state) and (p_city is null or c.city = p_city)
    group by 1
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
    'portfolio', jsonb_build_object('fresh', coalesce(o.fresh, 0), 'recent', coalesce(o.recent, 0), 'aged', coalesce(o.aged, 0), 'orders', coalesce(o.n, 0)),
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
    'isDemo', coalesce((select is_demo from public.companies where id = p_company), false),
    'config', coalesce(v_cfg, '{}'::jsonb),
    'days', coalesce(v_days, '[]'::jsonb),
    'companyComparisons', v_cmp,
    'sellers', v_sellers,
    'actions', v_actions
  );
end $$;
grant execute on function public.flight_plan_dataset(uuid, int, int, uuid, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.can_write_flight_plan(uuid) to authenticated;

-- ===== DEMO: deterministic seller scenarios for the current month =====
-- Targets for the current month = avg of the seller's last 3 full months (rounded);
-- current-month invoices are rebuilt so each seller follows a fixed pace profile.
do $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_start date := date_trunc('month', v_today)::date;
  v_end date := (date_trunc('month', v_today) + interval '1 month - 1 day')::date;
  factors numeric[] := array[1.15, 1.00, 0.95, 0.86, 0.72, 1.05, 0.55, 0.92];
  comp record; s record; d record;
  v_total int; v_target numeric; v_daily numeric; v_inv uuid; v_cust uuid; v_prod uuid; v_amt numeric; k int; v_idx int;
begin
  for comp in select id from public.companies where is_demo loop
    delete from public.invoices where company_id = comp.id and source = 'demo' and competence_date between v_start and v_end;
    v_total := public.working_days(comp.id, v_start, v_end);
    v_idx := 0;
    for s in select id, channel_id, branch_id from public.sellers where company_id = comp.id order by name loop
      v_idx := v_idx + 1;
      select round(coalesce(sum(it.total), 0) / 3.0, -3) into v_target
      from public.invoice_items it join public.invoices i on i.id = it.invoice_id
      where i.seller_id = s.id and i.status = 'authorized' and i.competence_date between (v_start - interval '3 months')::date and v_start - 1;
      if v_target < 30000 then v_target := 30000; end if;
      delete from public.sales_targets where seller_id = s.id and year = extract(year from v_start) and month = extract(month from v_start);
      insert into public.sales_targets (company_id, channel_id, seller_id, year, month, level, amount) values
        (comp.id, s.channel_id, s.id, extract(year from v_start), extract(month from v_start), 'BASE', round(v_target * 0.90, -2)),
        (comp.id, s.channel_id, s.id, extract(year from v_start), extract(month from v_start), 'ACTIVE', v_target),
        (comp.id, s.channel_id, s.id, extract(year from v_start), extract(month from v_start), 'CHALLENGE', round(v_target * 1.15, -2));
      v_daily := v_target * factors[((v_idx - 1) % 8) + 1] / greatest(v_total, 1);
      for d in select g::date as day from generate_series(v_start, v_today, interval '1 day') g
               where extract(isodow from g) < 6 and not exists (select 1 from public.holidays h where h.date = g::date and (h.company_id is null or h.company_id = comp.id)) loop
        for k in 1..2 loop
          v_amt := round(v_daily * (case when k = 1 then 0.58 else 0.42 end) * (0.97 + (abs(hashtext(s.id::text || d.day::text || k)) % 7) / 100.0), 2);
          select id into v_cust from public.customers where company_id = comp.id order by md5(id::text || s.id::text || d.day::text || k) limit 1;
          select id into v_prod from public.products where company_id = comp.id order by md5(id::text || d.day::text || k::text || s.id::text) limit 1;
          insert into public.invoices (company_id, channel_id, branch_id, seller_id, customer_id, number, status, competence_date, total, source)
          values (comp.id, s.channel_id, s.branch_id, s.id, v_cust, 'FP-' || to_char(d.day, 'YYYYMMDD') || '-' || v_idx || '-' || k, 'authorized', d.day, v_amt, 'demo')
          returning id into v_inv;
          insert into public.invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total)
          values (v_inv, comp.id, s.id, v_prod, 1, v_amt);
        end loop;
      end loop;
    end loop;
  end loop;
end $$;
