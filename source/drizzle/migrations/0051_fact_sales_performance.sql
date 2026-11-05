-- Desempenho do faturamento. Nenhum número muda: mesmas regras, menos trabalho por linha.
-- 1. invoice_item_amounts e fact_sales chamavam as regras da empresa (company_revenue_basis, revenue_valid_statuses,
--    invoice_revenue_eligible) uma vez POR ITEM de nota (cada chamada lê companies/metric_config com RLS). Agora as
--    mesmas funções são chamadas uma vez por combinação distinta de (status, escopo, canal, visível): continuam sendo
--    a única fonte da regra. Assinaturas, colunas e permissões iguais (create or replace mantém os grants).
-- 2. Plano de Voo, "clientes novos": em vez de ler todo o histórico dos clientes do mês, para no 1º achado (EXISTS)
--    pelo índice novo invoices(company_id, customer_id, competence_date).
-- Provas: suíte deploy/db/verify_fact_sales_equivalence.sql (nova × 0021/0050, linha a linha, por perfil e filtro) e a
-- foto dos números antes/depois na cópia e na produção. Retorno: deploy/db/rollback/0051_fact_sales_performance.down.sql.

create index if not exists invoices_company_customer_date_idx on public.invoices(company_id, customer_id, competence_date);

create or replace function public.invoice_item_amounts(p_company uuid,p_start date,p_end date)
returns table(item_id uuid,invoice_id uuid,amount numeric)
language sql stable security invoker set search_path=public as $$
  with inv as materialized (
    select i.id,i.total,i.status,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible
    from public.invoices i
    where i.company_id=p_company and i.competence_date between p_start and p_end
  ), flags as materialized (
    -- Regra da empresa: as mesmas funções de sempre, uma vez por combinação (e não uma vez por item).
    select k.status,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible,
      public.company_revenue_basis(p_company)='commercial_base'
        and k.status=any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(p_company,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible) use_commercial
    from (select distinct status,operation_scope,business_channel,is_biomie_commercial_visible from inv) k
  ), original as (
    select it.id item_id,i.id invoice_id,it.total original_amount,i.total header_amount,f.use_commercial,
      sum(it.total) over(partition by i.id) original_sum,
      row_number() over(partition by i.id order by it.item_sequence nulls last,it.id) item_position,
      count(*) over(partition by i.id) item_count
    from inv i
    join flags f on f.status=i.status and f.operation_scope=i.operation_scope and f.business_channel=i.business_channel
      and f.is_biomie_commercial_visible=i.is_biomie_commercial_visible
    join public.invoice_items it on it.invoice_id=i.id and it.company_id=p_company
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
  with base as materialized (
    select i.id,i.competence_date,i.seller_id,i.customer_id,i.status,i.operation_scope,i.business_channel,
      i.is_biomie_commercial_visible,a.item_id,a.amount
    from public.invoice_item_amounts(p_company,p_start,p_end) a
    join public.invoices i on i.id=a.invoice_id
    where i.company_id=p_company
      and (p_channel is null or i.channel_id=p_channel)
      and (p_branch is null or i.branch_id=p_branch)
      and (p_seller is null or i.seller_id=p_seller)
  ), ok as materialized (
    -- Nota válida e elegível: as mesmas funções de sempre, uma vez por combinação.
    select k.status,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible
    from (select distinct status,operation_scope,business_channel,is_biomie_commercial_visible from base) k
    where k.status=any(public.revenue_valid_statuses())
      and public.invoice_revenue_eligible(p_company,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible)
  )
  select b.id,b.competence_date,b.seller_id,b.customer_id,it.product_id,p.category,c.state,c.city,it.quantity,b.amount
  from base b
  join ok on ok.status=b.status and ok.operation_scope=b.operation_scope and ok.business_channel=b.business_channel
    and ok.is_biomie_commercial_visible=b.is_biomie_commercial_visible
  join public.invoice_items it on it.id=b.item_id
  join public.products p on p.id=it.product_id
  join public.customers c on c.id=b.customer_id
  where (p_state is null or c.state=p_state)
    and (p_city is null or c.city=p_city)
    and (p_category is null or p.category=p_category)
$$;

create or replace function public.flight_plan_v2_dataset(p_company uuid, p_year int, p_month int, p_windows jsonb,
  p_channel text default null, p_seller uuid default null, p_as_of date default null, p_channel_id uuid default null,
  p_branch uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_start date; v_end date; v_today date; v_cut date; v_state text;
  v_year_start date; v_year_end date; v_win_from date; v_win_to date; v_pmm_start date;
  v_pm_start date; v_pm_end date; v_pm_cut date; v_py_start date; v_py_cut date;
  v_l3_start date; v_l3_end date; v_l3_div numeric;
  v_lm date; v_chan uuid; v_cfg jsonb; v_out jsonb; v_conv jsonb;
begin
  perform public.assert_company_access(p_company);
  if p_year is null or p_month is null or p_month not between 1 and 12 or p_year not between 2000 and 2100 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_channel is not null and p_channel not in ('varejo', 'licitacao') then
    raise exception 'Canal inválido.' using errcode = '22023';
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'object'
     or jsonb_typeof(p_windows->'previous') is distinct from 'object'
     or jsonb_typeof(p_windows->'lastYear') is distinct from 'object'
     or jsonb_typeof(p_windows->'trailing3') is distinct from 'object' then
    raise exception 'Janelas de comparação ausentes.' using errcode = '22023';
  end if;
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + interval '1 month - 1 day')::date;
  v_today := coalesce(p_as_of, public.data_as_of(p_company));
  v_cut := least(v_end, v_today);
  v_state := case when v_today < v_start then 'future' when v_today > v_end then 'closed' else 'current' end;
  v_year_start := make_date(p_year, 1, 1);
  v_year_end := make_date(p_year, 12, 31);
  v_pmm_start := (v_start - interval '1 month')::date;
  v_pm_end := v_start - 1;
  v_pm_start := (p_windows->'previous'->>'start')::date;
  v_pm_cut := (p_windows->'previous'->>'end')::date;
  v_py_start := (p_windows->'lastYear'->>'start')::date;
  v_py_cut := (p_windows->'lastYear'->>'end')::date;
  v_l3_start := (p_windows->'trailing3'->>'start')::date;
  v_l3_end := (p_windows->'trailing3'->>'end')::date;
  v_l3_div := coalesce((p_windows->'trailing3'->>'divisor')::numeric, 3);
  if v_pm_start is null or v_pm_cut is null or v_py_start is null or v_py_cut is null or v_l3_start is null
     or v_l3_end is null or v_l3_div <= 0 or v_pm_cut - v_pm_start > 400 or v_py_cut - v_py_start > 400
     or v_l3_end - v_l3_start > 400 or v_pm_start > v_start or v_l3_end >= v_start then
    raise exception 'Janelas de comparação inválidas.' using errcode = '22023';
  end if;
  v_win_from := least(v_year_start, v_l3_start, v_pmm_start, v_pm_start);
  v_win_to := least(v_year_end, v_today);
  v_lm := case when extract(isodow from v_today) = 1 then v_today - 7 else date_trunc('week', v_today)::date end;
  if p_channel_id is not null then
    v_chan := coalesce((select id from public.channels where id = p_channel_id and company_id = p_company),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  elsif p_channel is not null then
    v_chan := coalesce((select id from public.channels where company_id = p_company and lower(name) = p_channel order by id limit 1),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  end if;
  select config into v_cfg from public.metric_config where metric_key = 'flight_plan';
  v_conv := flight_plan_internal.conversion(p_company,
    coalesce(nullif(v_cfg->'conversion'->>'since', '')::date, date '2026-11-04'), v_chan, p_seller);

  with s as materialized (
    select f.competence_date d, f.seller_id, f.customer_id, f.invoice_id, sum(f.amount) amt
    from public.fact_sales(p_company, v_win_from, greatest(v_win_to, v_win_from), v_chan, p_branch, p_seller,
      p_state, p_city, p_category) f
    where f.competence_date <= v_win_to
    group by 1, 2, 3, 4
  ), py as materialized (
    select f.seller_id, sum(f.amount) amt
    from public.fact_sales(p_company, v_py_start, v_py_cut, v_chan, p_branch, p_seller, p_state, p_city, p_category) f
    group by 1
  ), cur as (
    select * from s where d between v_start and v_cut
  ), sc as (
    select se.id, se.name, se.active, se.user_id, coalesce(lower(ch.name), 'varejo') channel
    from public.sellers se left join public.channels ch on ch.id = se.channel_id
    where se.company_id = p_company and (p_seller is null or se.id = p_seller)
      and (v_chan is null or se.channel_id = v_chan) and (p_branch is null or se.branch_id = p_branch)
  ), tg as (
    select t.seller_id, t.month, t.level::text lvl, t.amount, lower(ch.name) channel
    from public.sales_targets t left join public.channels ch on ch.id = t.channel_id
    where t.company_id = p_company and t.year = p_year and t.active
  ), ord as (
    select o.order_id, o.number, o.seller_id, o.order_date, o.expected_date, sum(o.amount) amt
    from public.fact_orders(p_company, v_chan, p_branch, p_seller, p_state, p_city, p_category) o
    where o.status = 'open' and o.order_date <= v_today
    group by 1, 2, 3, 4, 5
  ), qt as (
    select o.id, o.number, o.seller_id, o.order_date,
      coalesce((select sum(it.total) from public.sales_order_items it join public.products pr on pr.id = it.product_id
                where it.order_id = o.id and (p_category is null or pr.category = p_category)),
               case when p_category is null then o.total end) amt
    from public.sales_orders o
    where o.company_id = p_company and o.source = 'omie' and o.operation_scope = 'commercial'
      and o.stage_code = '10' and o.status = 'open' and o.order_date <= v_today
      and (v_chan is null or o.channel_id = v_chan) and (p_seller is null or o.seller_id = p_seller)
      and (p_branch is null or o.branch_id = p_branch)
      and (p_state is null and p_city is null or exists (select 1 from public.customers cu where cu.id = o.customer_id
           and (p_state is null or cu.state = p_state) and (p_city is null or cu.city = p_city)))
      and (p_category is null or exists (select 1 from public.sales_order_items it join public.products pr on pr.id = it.product_id
           where it.order_id = o.id and pr.category = p_category))
  ), cur_customers as materialized (
    select distinct customer_id from cur where customer_id is not null
  ), prior_buyers as (
    -- Cliente já comprou antes do mês? Para no 1º achado (índice invoices_company_customer_date_idx).
    select cc.customer_id from cur_customers cc
    where exists (select 1 from public.invoices i
      where i.company_id = p_company and i.customer_id = cc.customer_id and i.competence_date < v_start
        and i.status = any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible))
  ), sr as (
    select seller_id, sum(amt) rev, count(distinct invoice_id) nfs, count(distinct customer_id) cust from cur group by 1
  ), slast as (
    select seller_id, max(d) last_d from s where d <= v_today group by 1
  ), spm as (
    select seller_id, sum(amt) amt from s where d between v_pm_start and v_pm_cut group by 1
  ), sl3 as (
    select seller_id, sum(amt) / v_l3_div amt from s where d between v_l3_start and v_l3_end group by 1
  ), st as (
    select seller_id, jsonb_object_agg(lvl, amount) v from tg where month = p_month and seller_id is not null group by 1
  ), so as (
    select seller_id, count(*) n from ord group by 1
  ), sq as (
    select seller_id, count(*) n from qt group by 1
  ), cm as (
    select c.seller_id, c.amount, c.note, c.updated_at from public.flight_plan_commits c
    where c.company_id = p_company and c.year = p_year and c.month = p_month
  ), snapd as (
    select max(x.snapshot_date) d from public.flight_plan_snapshots x
    where x.company_id = p_company and x.snapshot_date between v_lm - 6 and v_lm
  ), snap as (
    select f.seller_id, f.status from public.flight_plan_snapshots f, snapd
    where f.company_id = p_company and f.snapshot_date = snapd.d
  ), srows as (
    select sc.*, sr.rev, sr.nfs, sr.cust, slast.last_d, spm.amt pm, py.amt pyv, sl3.amt l3, st.v targets,
      coalesce(so.n, 0) n_orders, coalesce(sq.n, 0) n_quotes, cm.amount c_amount, cm.note c_note, cm.updated_at c_at
    from sc left join sr on sr.seller_id = sc.id left join slast on slast.seller_id = sc.id
      left join spm on spm.seller_id = sc.id left join py on py.seller_id = sc.id left join sl3 on sl3.seller_id = sc.id
      left join st on st.seller_id = sc.id left join so on so.seller_id = sc.id left join sq on sq.seller_id = sc.id
      left join cm on cm.seller_id = sc.id
  )
  select jsonb_build_object(
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'today', v_today, 'state', v_state,
      'lastMonday', v_lm, 'yearEnd', v_year_end),
    'config', coalesce(v_cfg, '{}'::jsonb),
    'company', (select jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'isDemo', c.is_demo)
                from public.companies c where c.id = p_company),
    'channel', (select lower(ch.name) from public.channels ch where ch.id = v_chan),
    'restricted', public.is_seller_restricted(auth.uid()),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'amount', round(a, 2)) order by d)
      from (select d, sum(amt) a from cur group by d) x), '[]'::jsonb),
    'previousDaily', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'amount', round(a, 2)) order by d)
      from (select d, sum(amt) a from s where d between v_pmm_start and v_pm_end group by d) x), '[]'::jsonb),
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'amount', round(a, 2)) order by m)
      from (select extract(month from d)::int m, sum(amt) a from s where d between v_year_start and v_win_to group by 1) x),
      '[]'::jsonb),
    'totals', jsonb_build_object(
      'invoices', (select count(distinct invoice_id) from cur),
      'customers', (select count(distinct customer_id) from cur),
      'newCustomers', (select count(distinct customer_id) from cur where customer_id not in (select customer_id from prior_buyers)),
      'unassigned', coalesce((select round(sum(amt), 2) from cur where seller_id is null), 0),
      'previousMonthSameCut', coalesce((select round(sum(amt), 2) from s where d between v_pm_start and v_pm_cut), 0),
      'previousYearSameCut', coalesce((select round(sum(amt), 2) from py), 0),
      'last3MonthsAvg', coalesce((select round(sum(amt) / v_l3_div, 2) from s where d between v_l3_start and v_l3_end), 0)),
    'sellers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'active', r.active, 'channel', r.channel, 'hasLogin', r.user_id is not null,
        'revenue', coalesce(round(r.rev, 2), 0), 'invoices', coalesce(r.nfs, 0), 'customers', coalesce(r.cust, 0),
        'lastInvoice', r.last_d,
        'previousMonthSameCut', coalesce(round(r.pm, 2), 0), 'previousYearSameCut', coalesce(round(r.pyv, 2), 0),
        'last3MonthsAvg', coalesce(round(r.l3, 2), 0),
        'targets', coalesce(r.targets, '{}'::jsonb), 'openOrders', r.n_orders, 'openQuotes', r.n_quotes,
        'commit', case when r.c_amount is null then null
                  else jsonb_build_object('amount', r.c_amount, 'note', r.c_note, 'updatedAt', r.c_at) end,
        'statusLastMonday', (select snap.status from snap where snap.seller_id = r.id)) order by r.name)
      from srows r
      where r.active or r.rev is not null or r.targets is not null or r.n_orders > 0 or r.n_quotes > 0
         or r.c_amount is not null), '[]'::jsonb),
    'companyTargets', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'channel', channel, 'level', lvl,
        'amount', amount)) from tg where seller_id is null), '[]'::jsonb),
    'sellerTargets', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'level', lvl, 'amount', a))
      from (select month, lvl, sum(amount) a from tg where seller_id in (select id from sc) group by 1, 2) x), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', order_id, 'number', number, 'sellerId', seller_id,
        'amount', round(amt, 2), 'openedAt', order_date, 'expectedDate', expected_date)) from ord), '[]'::jsonb),
    'quotes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'number', number, 'sellerId', seller_id,
        'amount', round(amt, 2), 'openedAt', order_date)) from qt), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('date', h.date, 'name', h.name) order by h.date)
      from public.holidays h where (h.company_id is null or h.company_id = p_company)
        and h.date between least(v_pmm_start, v_year_start) and v_year_end), '[]'::jsonb),
    'holidayYears', jsonb_build_object(
      p_year::text, (select count(*) from public.holidays h where (h.company_id is null or h.company_id = p_company)
        and extract(year from h.date) = p_year),
      (p_year + 1)::text, (select count(*) from public.holidays h where (h.company_id is null or h.company_id = p_company)
        and extract(year from h.date) = p_year + 1)),
    'lastMonday', jsonb_build_object('date', (select d from snapd),
      'companyStatus', (select snap.status from snap where snap.seller_id is null)),
    'conversion', v_conv
  ) into v_out;
  return v_out;
end $$;
