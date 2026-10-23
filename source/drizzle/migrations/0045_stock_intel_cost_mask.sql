-- Estoque, BIOMIE Intelligence: o que revela custo fica só para quem vê custo (aditiva).
-- A 0044 já mascarava capital, CMC, faturamento e preço. Faltavam:
--   - os sinais de custo ("custo provisório (até R$ 1)", "custo desconhecido", "custo diferente entre
--     locais"), também como filtro da lista;
--   - a explicação da prioridade (o fator capital é a posição do capital do produto na empresa);
--   - a contagem de produtos sem custo por curva.
-- Achado no teste de navegador da homologação (vendedor), 23/10/2026. As funções são as da 0044
-- com essas três máscaras; permissões continuam as da 0044 (create or replace as preserva).

create or replace function stock_internal.intel_flags(p_flags text[], p_cost boolean) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select to_jsonb(case when p_cost then coalesce(p_flags, '{}'::text[]) else
    coalesce(array(select f from unnest(p_flags) f
                   where f not in ('custo_desconhecido', 'custo_provisorio', 'custo_divergente')), '{}'::text[]) end)
$$;
revoke all on function stock_internal.intel_flags(text[], boolean) from public, anon, authenticated;

create or replace function stock_internal.intel_overview(p_company text, p_window text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_companies uuid[] := stock_internal.scope(p_company);
  v_window text := stock_internal.pick_window(p_window);
  v jsonb;
begin
  with pos as (
    select p.company_id, p.omie_product_id, sum(p.physical_qty) as qty, count(*) as positions,
      sum(p.physical_qty * p.unit_cost) filter (where p.physical_qty > 0 and p.unit_cost > 0) as capital,
      bool_or(p.physical_qty > 0 and not (p.unit_cost > 0)) as unknown_cost,
      sum(p.physical_qty * p.unit_cost) filter (where p.physical_qty < 0) as negative,
      count(*) filter (where p.physical_qty < 0) as negative_positions
    from private.stock_current sc join private.stock_positions p on p.reading_id = sc.reading_id
    where sc.company_id = any(v_companies)
    group by 1, 2),
  cur as (
    select pos.*, case when m.curve is not null then m.curve when a.curve is not null then a.curve
                       when r.company_id is null then 'U' when pos.qty > 0 then 'D' else 'U' end as curve
    from pos
    left join private.stock_curves m on m.company_id = pos.company_id and m.omie_product_id = pos.omie_product_id
    left join private.stock_auto_curves a on a.company_id = pos.company_id and a.curve_window = v_window
      and a.omie_product_id = pos.omie_product_id
    left join (select distinct cr.company_id from private.stock_curve_runs cr where cr.status = 'ok') r
      on r.company_id = pos.company_id),
  byc as (
    select k.curve, coalesce(count(c.*) filter (where c.qty > 0), 0) as products,
      coalesce(sum(c.capital), 0) as capital, coalesce(count(c.*) filter (where c.unknown_cost), 0) as unknown_cost
    from unnest(array['A', 'B', 'C', 'D', 'U']) k(curve) left join cur c on c.curve = k.curve
    group by k.curve),
  mm as (
    select x.*, (x.metrics->'stock'->>'qty')::numeric as qty, (x.metrics->>'capital')::numeric as capital,
      stock_internal.intel_band((x.metrics->>'daysWithoutSale')::integer, (x.metrics->>'lastSale')::date, x.state) as band
    from private.intel_current ic
    join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
    where ic.company_id = any(v_companies)),
  ev as (
    select s.day, sum(coalesce((s.totals->k.curve->>'capital')::numeric, 0)) as capital,
      sum(coalesce((s.totals->k.curve->>'products')::integer, 0)) as products, k.curve
    from private.stock_snapshots s cross join unnest(array['A', 'B', 'C', 'D']) k(curve)
    where s.company_id = any(v_companies)
    group by s.day, k.curve)
  select jsonb_build_object(
    'window', v_window, 'companies', to_jsonb(v_companies),
    'status', jsonb_build_object(
      'enabled', (select s.enabled from private.intel_settings s where s.id),
      'runs', (select coalesce(jsonb_agg(jsonb_build_object('companyId', ic.company_id, 'companyName', c.name,
                 'asOf', r.as_of, 'publishedAt', ic.published_at, 'version', r.algorithm_version) order by c.name), '[]')
               from private.intel_current ic join private.intel_runs r on r.id = ic.run_id
               join public.companies c on c.id = ic.company_id where ic.company_id = any(v_companies)),
      'readings', (select coalesce(jsonb_agg(jsonb_build_object('companyId', sc.company_id,
                     'positionDate', rd.position_date, 'readAt', rd.finished_at)), '[]')
                   from private.stock_current sc join private.stock_readings rd on rd.id = sc.reading_id
                   where sc.company_id = any(v_companies)),
      'salesFrom', (select min(stock_internal.sales_from(c.id, stock_internal.as_of()))
                    from unnest(v_companies) c(id))),
    'capital', jsonb_build_object(
      'total', case when v_cost then (select round(sum(b.capital), 2) from byc b) end,
      'byCurve', (select jsonb_object_agg(b.curve, jsonb_build_object('products', b.products,
                    'capital', case when v_cost then round(b.capital, 2) end, 'unknownCost', case when v_cost then b.unknown_cost end))
                  from byc b),
      'cdShare', case when v_cost then (select round(sum(b.capital) filter (where b.curve in ('C', 'D'))
                   / nullif(sum(b.capital), 0), 4) from byc b) end,
      'negative', jsonb_build_object('positions', (select coalesce(sum(c.negative_positions), 0) from cur c),
                    'products', (select count(*) from cur c where c.negative_positions > 0),
                    'value', case when v_cost then (select round(coalesce(sum(c.negative), 0), 2) from cur c) end)),
    'states', (select coalesce(jsonb_agg(jsonb_build_object('state', t.state, 'products', t.n,
                 'capital', case when v_cost then t.capital end) order by t.n desc), '[]')
               from (select mm.state, count(*) as n, round(coalesce(sum(mm.capital), 0), 2) as capital
                     from mm group by mm.state) t),
    'radar', (select jsonb_agg(jsonb_build_object('band', k.band, 'products', coalesce(t.n, 0),
                'capital', case when v_cost then coalesce(t.capital, 0) end,
                'newProducts', coalesce(t.novos, 0)) order by k.ord)
              from (values ('0-30', 1), ('31-60', 2), ('61-90', 3), ('91-180', 4), ('181-365', 5), ('365+', 6),
                           ('insuficiente', 7)) k(band, ord)
              left join (select mm.band, count(*) as n, round(coalesce(sum(mm.capital), 0), 2) as capital,
                           count(*) filter (where mm.state = 'novo') as novos
                         from mm where mm.qty > 0 group by mm.band) t on t.band = k.band),
    'evolution', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day,
                    'capital', case when v_cost then d.capital end, 'products', d.products) order by d.day), '[]')
                  from (select ev.day, jsonb_object_agg(ev.curve, round(ev.capital, 2)) as capital,
                          jsonb_object_agg(ev.curve, ev.products) as products
                        from ev group by ev.day) d),
    'top', (select coalesce(jsonb_agg(jsonb_build_object('companyId', t.company_id, 'omieProductId', t.omie_product_id,
              'productId', t.product_id, 'sku', t.sku, 'name', t.name, 'curve', t.metrics->'curve'->>'current',
              'state', t.state, 'flags', stock_internal.intel_flags(t.flags, v_cost), 'priority', t.priority,
              'capital', case when v_cost then t.capital end, 'daysWithoutSale', t.metrics->'daysWithoutSale',
              'coverageDays', t.metrics->'coverageDays') order by t.priority desc nulls last), '[]')
            from (select * from mm where mm.priority is not null order by mm.priority desc limit 10) t))
  into v;
  return v;
end $$;

create or replace function stock_internal.intel_products(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_companies uuid[] := stock_internal.scope(p_query->>'companyId');
  v_state text := nullif(p_query->>'state', '');
  v_flag text := nullif(p_query->>'flag', '');
  v_curve text := nullif(p_query->>'curve', '');
  v_band text := nullif(p_query->>'band', '');
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_min_idle integer := nullif(p_query->>'minIdle', '')::integer;
  v_sort text := coalesce(nullif(p_query->>'sortBy', ''), 'priority');
  v_dir text := coalesce(nullif(p_query->>'sortDir', ''), 'desc');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_rows jsonb;
  v_total integer;
begin
  if v_sort not in ('priority', 'capital', 'daysWithoutSale', 'coverageDays', 'name')
     or v_dir not in ('asc', 'desc') or v_page < -1 or v_page > 1000
     or (v_curve is not null and v_curve not in ('A', 'B', 'C', 'D'))
     or (v_band is not null and v_band not in ('0-30', '31-60', '61-90', '91-180', '181-365', '365+', 'insuficiente'))
     or (v_state is not null and v_state not in ('novo', 'historico_insuficiente', 'sem_venda_janela', 'baixo_giro',
           'possivel_excesso', 'possivel_obsolescencia', 'saudavel', 'risco_ruptura', 'sem_saldo'))
     or (v_flag is not null and v_flag !~ '^[a-z_]{3,40}$') or length(coalesce(v_search, '')) > 120
     or (v_min_idle is not null and v_min_idle not in (30, 60, 90, 180, 365)) then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  -- Sinais de custo (CMC até R$ 1, sem custo, custo diferente entre locais) revelam custo: só para
  -- quem vê custo, também como filtro.
  if v_flag in ('custo_desconhecido', 'custo_provisorio', 'custo_divergente') and not v_cost then
    perform stock_internal.require('viewCost');
  end if;
  if (v_sort = 'capital') and not v_cost then
    v_sort := 'priority';
  end if;
  if v_page = -1 and not (v_caps->>'export')::boolean then
    raise exception 'Você não pode exportar o estoque.' using errcode = '42501';
  end if;
  with mm as (
    select x.*, c.name as company_name, (x.metrics->'stock'->>'qty')::numeric as qty,
      (x.metrics->>'capital')::numeric as capital, (x.metrics->>'daysWithoutSale')::integer as idle,
      (x.metrics->>'coverageDays')::numeric as coverage,
      stock_internal.intel_band((x.metrics->>'daysWithoutSale')::integer, (x.metrics->>'lastSale')::date, x.state) as band
    from private.intel_current ic
    join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
    join public.companies c on c.id = ic.company_id
    where ic.company_id = any(v_companies)),
  f as (
    select mm.* from mm
    where (v_state is null or mm.state = v_state) and (v_flag is null or v_flag = any(mm.flags))
      and (v_curve is null or mm.metrics->'curve'->>'current' = v_curve)
      and (v_band is null or (mm.band = v_band and mm.qty > 0))
      -- Sem venda há MAIS de N dias (as mesmas fronteiras do radar: 30, 60, 90, 180, 365), só com
      -- saldo e fora "produto novo" (que não é encalhe).
      and (v_min_idle is null or (mm.idle > v_min_idle and mm.qty > 0 and mm.state <> 'novo'))
      and (v_search is null or mm.sku ilike '%' || v_search || '%' or mm.name ilike '%' || v_search || '%')),
  o as (
    select f.*, count(*) over () as total_count,
      row_number() over (order by
        case when v_dir = 'desc' then case v_sort when 'priority' then f.priority when 'capital' then f.capital
          when 'daysWithoutSale' then f.idle when 'coverageDays' then f.coverage end end desc nulls last,
        case when v_dir = 'asc' then case v_sort when 'priority' then f.priority when 'capital' then f.capital
          when 'daysWithoutSale' then f.idle when 'coverageDays' then f.coverage end end asc nulls last,
        case when v_sort = 'name' and v_dir = 'asc' then f.name end asc,
        case when v_sort = 'name' and v_dir = 'desc' then f.name end desc,
        f.name, f.sku, f.company_name) as rn
    from f)
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'companyId', o.company_id, 'companyName', o.company_name, 'omieProductId', o.omie_product_id,
      'productId', o.product_id, 'sku', o.sku, 'name', o.name, 'family', o.family,
      'curve', o.metrics->'curve'->>'current', 'curveSource', o.metrics->'curve'->>'source',
      'curveWorsened', (o.metrics->'curve'->>'worsened')::boolean,
      'qty', o.qty, 'available', o.metrics->'stock'->'available',
      'capital', case when v_cost then o.capital end,
      'unitCost', case when v_cost then o.metrics->'cost'->'unitCost' end,
      'lastSale', o.metrics->'lastSale', 'daysWithoutSale', o.idle, 'coverageDays', o.coverage,
      'turnoverAnnual', o.metrics->'turnoverAnnual', 'trend60Pct', o.metrics->'trend60Pct',
      'units365', o.metrics->'sales'->'d365'->'units',
      'revenue365', case when v_cost then o.metrics->'sales'->'d365'->'revenue' end,
      'state', o.state, 'flags', stock_internal.intel_flags(o.flags, v_cost), 'band', o.band, 'priority', o.priority,
      'priorityParts', case when v_cost then o.priority_parts end) order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 50 and o.rn <= (v_page + 1) * 50)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  if v_page = -1 and v_total > 20000 then
    raise exception 'A exportação vai até 20.000 linhas. Refine os filtros.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('rows', v_rows, 'total', v_total);
end $$;

create or replace function stock_internal.intel_product(p_company text, p_omie text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_companies uuid[] := stock_internal.scope(p_company);
  v jsonb;
begin
  if array_length(v_companies, 1) is distinct from 1 or coalesce(p_omie, '') !~ '^[^:]{1,40}$' then
    raise exception 'Produto inválido.' using errcode = 'P0001';
  end if;
  select jsonb_build_object(
    'companyId', x.company_id, 'companyName', c.name, 'omieProductId', x.omie_product_id,
    'productId', x.product_id, 'sku', x.sku, 'name', x.name, 'family', x.family, 'state', x.state,
    'flags', stock_internal.intel_flags(x.flags, v_cost), 'priority', x.priority, 'priorityParts', case when v_cost then x.priority_parts end,
    'metrics', stock_internal.intel_mask(x.metrics, v_cost),
    'run', jsonb_build_object('asOf', r.as_of, 'publishedAt', ic.published_at, 'version', r.algorithm_version),
    'curveHistory', (select coalesce(jsonb_agg(jsonb_build_object('day', h.day, 'curve', h.curve, 'source', h.source)
                       order by h.day), '[]')
                     from private.stock_curve_history h
                     where h.company_id = x.company_id and h.omie_product_id = x.omie_product_id))
  into v
  from private.intel_current ic
  join private.intel_runs r on r.id = ic.run_id
  join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
  join public.companies c on c.id = x.company_id
  where ic.company_id = v_companies[1] and x.omie_product_id = p_omie;
  return v;
end $$;
