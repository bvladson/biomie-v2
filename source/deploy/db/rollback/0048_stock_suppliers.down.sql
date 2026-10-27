-- Retorno da 0048 (fornecedores e prazos de entrega). Rodar com psql -1 (uma transação).
-- Volta o painel, as posições, as opções de filtro e a agenda do worker às da 0043 e fecha as funções
-- novas de tela e do worker. FICAM: as tabelas (com os prazos e vínculos que Compras já informou), a
-- permissão stock.purchasing (caps/require/apply_access da 0048 são um superconjunto das da 0041 e não
-- mudam nada para quem não tem a permissão) e as funções de apoio usadas pela 0049. Reaplicar a 0048
-- depois reaproveita tudo (create ... if not exists).

drop function if exists public.stock_suppliers(jsonb);
drop function if exists public.stock_supplier(text, text);
drop function if exists public.stock_product_suppliers(text, text);
drop function if exists public.stock_lead_time_set(text, text, text, jsonb, text);
drop function if exists public.stock_preferred_supplier_set(text, text, text, text);
drop function if exists public.stock_supplier_link_set(text, text, text, boolean, text);
drop function if exists public.stock_supplier_search(text, text);
drop function if exists public.stock_supplier_request_import(text);
drop function if exists public.stock_worker_suppliers_enqueue(uuid, text);
drop function if exists public.stock_worker_suppliers_claim();
drop function if exists public.stock_worker_suppliers_save_page(uuid, integer, integer, integer, jsonb, integer);
drop function if exists public.stock_worker_suppliers_finish(uuid);
drop function if exists public.stock_worker_suppliers_fail(uuid, text, integer, boolean);
drop function if exists public.stock_overview(text, text, text);
drop function if exists stock_internal.overview(text, text, text);

create or replace function stock_internal.overview(p_company text, p_window text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_admin boolean := (v_caps->>'refresh')::boolean;
  v_scope uuid[] := stock_internal.scope(p_company);
  v_window text := stock_internal.pick_window(p_window);
  v_stale interval := make_interval(hours => (select s.stale_hours from private.stock_settings s));
  v jsonb;
begin
  with x as (select * from stock_internal.current_rows(v_scope, v_window)),
  t as (
    select count(*)::integer as positions,
      count(*) filter (where x.physical_qty <> 0 or x.reserved_qty <> 0 or x.pending_qty <> 0)::integer as with_stock,
      coalesce(sum(x.physical_qty), 0) as units,
      coalesce(sum(x.physical_qty * x.unit_cost), 0) as cost_value,
      coalesce(sum(x.reserved_qty), 0) as reserved,
      coalesce(sum(x.pending_qty), 0) as pending,
      count(*) filter (where x.physical_qty < 0)::integer as negative,
      count(*) filter (where x.curve = 'U')::integer as unclassified,
      coalesce(sum(x.physical_qty * x.unit_cost) filter (where x.curve = 'U'), 0) as unclassified_cost,
      count(*) filter (where x.min_qty > 0 and x.physical_qty < x.min_qty)::integer as below_min
    from x),
  c as (
    select k.curve, k.ord, count(x.company_id)::integer as positions,
      count(distinct (x.company_id, x.omie_product_id)) filter (where x.company_id is not null)::integer as products,
      coalesce(sum(x.physical_qty), 0) as units, coalesce(sum(x.physical_qty * x.unit_cost), 0) as cost_value
    from unnest(array['A', 'B', 'C', 'D', 'U']) with ordinality as k(curve, ord)
    left join x on x.curve = k.curve
    group by k.curve, k.ord),
  -- Por produto (todos os locais juntos): base da curva D e do tempo sem venda.
  pr as (
    select x.company_id, x.omie_product_id, min(x.curve) as curve, min(x.curve_source) as source,
      sum(x.physical_qty) as qty, sum(x.physical_qty * x.unit_cost) as value,
      bool_or(x.is_new) as is_new, min(x.incomplete_reason) as incomplete_reason,
      bool_or(x.elsewhere_company is not null) as elsewhere, bool_or(x.recent_exit) as moving,
      min(x.last_sale) as last_sale, min(x.curves_as_of) as as_of, min(x.sales_from) as sales_from,
      min(x.days_without_sale) as idle_days, min(x.arrived_on) as arrived_on
    from x group by x.company_id, x.omie_product_id),
  d as (
    select count(*)::integer as products, coalesce(sum(pr.value), 0) as value,
      count(*) filter (where pr.is_new)::integer as new_products,
      coalesce(sum(pr.value) filter (where pr.is_new), 0) as new_value,
      count(*) filter (where not pr.is_new and pr.incomplete_reason is not null)::integer as incomplete_products,
      coalesce(sum(pr.value) filter (where not pr.is_new and pr.incomplete_reason is not null), 0) as incomplete_value,
      count(*) filter (where not pr.is_new and pr.incomplete_reason is null)::integer as confirmed_products,
      coalesce(sum(pr.value) filter (where not pr.is_new and pr.incomplete_reason is null), 0) as confirmed_value,
      count(*) filter (where pr.elsewhere)::integer as elsewhere_products,
      coalesce(sum(pr.value) filter (where pr.elsewhere), 0) as elsewhere_value,
      count(*) filter (where pr.moving)::integer as moving_products,
      coalesce(sum(pr.value) filter (where pr.moving), 0) as moving_value
    from pr where pr.curve = 'D' and pr.qty > 0),
  -- Tempo sem venda (independente da janela): só produtos com saldo positivo e curva calculada.
  ag as (
    select pr.*, pr.idle_days as days, pr.last_sale is null as never
    from pr where pr.qty > 0 and pr.as_of is not null and pr.idle_days is not null),
  agb as (
    select case when ag.days >= 365 then '365' when ag.days >= 180 then '180'
                when ag.days >= 90 then '90' when ag.days >= 30 then '30' end as band, ag.*
    from ag),
  co as (
    select s.id as company_id, cmp.name as company_name, s.ord,
      (select count(*) from x where x.company_id = s.id)::integer as positions,
      (select coalesce(sum(x.physical_qty * x.unit_cost), 0) from x where x.company_id = s.id) as cost_value
    from unnest(v_scope) with ordinality as s(id, ord) join public.companies cmp on cmp.id = s.id),
  cr as (
    select s.id as company_id, s.ord, cmp.name as company_name, ok.as_of, ok.sales_from, ok.finished_at as computed_at,
      lastrun.status as last_status, lastrun.reason as last_reason, lastrun.finished_at as last_at
    from unnest(v_scope) with ordinality as s(id, ord)
    join public.companies cmp on cmp.id = s.id
    left join lateral (select r.as_of, r.sales_from, r.finished_at from private.stock_curve_runs r
      where r.company_id = s.id and r.status = 'ok' order by r.finished_at desc limit 1) ok on true
    left join lateral (select r.status, r.reason, r.finished_at from private.stock_curve_runs r
      where r.company_id = s.id order by r.finished_at desc limit 1) lastrun on true),
  rd as (
    select s.id as company_id, s.ord, cmp.name as company_name, cur.finished_at as read_at,
      cur.records_received as positions, last.status as last_status, last.error as last_error,
      last.finished_at as last_finished,
      exists (select 1 from private.stock_readings q
              where q.company_id = s.id and q.status in ('queued', 'running')) as in_progress
    from unnest(v_scope) with ordinality as s(id, ord)
    join public.companies cmp on cmp.id = s.id
    left join private.stock_current sc on sc.company_id = s.id
    left join private.stock_readings cur on cur.id = sc.reading_id
    left join lateral (
      select l.status, l.error, l.finished_at from private.stock_readings l
      where l.company_id = s.id and l.status in ('complete', 'failed')
      order by coalesce(l.finished_at, l.created_at) desc, l.created_at desc limit 1) last on true)
  select jsonb_build_object(
    'window', v_window,
    'readings', coalesce((select jsonb_agg(jsonb_build_object(
        'companyId', rd.company_id, 'companyName', rd.company_name, 'readAt', rd.read_at,
        'positions', coalesce(rd.positions, 0),
        'status', case
          when rd.last_status = 'failed' and (rd.read_at is null or rd.last_finished > rd.read_at) then 'failed'
          when rd.read_at is null then 'missing'
          when rd.read_at < now() - v_stale then 'stale'
          else 'ok' end,
        'inProgress', rd.in_progress,
        'lastError', case when v_admin and rd.last_status = 'failed' then rd.last_error end)
      order by rd.ord) from rd), '[]'::jsonb),
    'curves', coalesce((select jsonb_agg(jsonb_build_object(
        'companyId', cr.company_id, 'companyName', cr.company_name,
        'status', case when cr.computed_at is null then 'missing'
                       when cr.last_status in ('skipped', 'failed') and cr.last_at > cr.computed_at then cr.last_status
                       else 'ok' end,
        'computedAt', cr.computed_at, 'asOf', cr.as_of, 'salesFrom', cr.sales_from,
        'windowStart', cr.as_of - stock_internal.window_days(v_window) + 1,
        'incompleteHistory', cr.as_of is not null
          and (cr.sales_from is null or cr.as_of - stock_internal.window_days(v_window) + 1 < cr.sales_from),
        'reason', case when cr.last_status in ('skipped', 'failed') and cr.last_at > coalesce(cr.computed_at, '-infinity')
                       then cr.last_reason end)
      order by cr.ord) from cr), '[]'::jsonb),
    'totals', (select jsonb_build_object('positions', t.positions, 'positionsWithStock', t.with_stock,
        'units', t.units, 'costValue', case when v_cost then t.cost_value end,
        'reservedQty', t.reserved, 'pendingQty', t.pending, 'negativePositions', t.negative,
        'unclassifiedPositions', t.unclassified,
        'unclassifiedCostValue', case when v_cost then t.unclassified_cost end,
        'belowMinPositions', t.below_min,
        'manualCurves', (select count(*) from pr where pr.source = 'manual')::integer) from t),
    'byCurve', (select jsonb_agg(jsonb_build_object('curve', c.curve, 'positions', c.positions,
        'products', c.products, 'units', c.units,
        'costValue', case when v_cost then c.cost_value end,
        'share', case when v_cost and t.cost_value > 0 then round(c.cost_value / t.cost_value * 100, 4) end)
      order by c.ord) from c, t),
    'dAnalysis', (select jsonb_build_object('products', d.products,
        'costValue', case when v_cost then d.value end,
        'newProducts', d.new_products, 'newCostValue', case when v_cost then d.new_value end,
        'incompleteProducts', d.incomplete_products,
        'incompleteCostValue', case when v_cost then d.incomplete_value end,
        'confirmedProducts', d.confirmed_products,
        'confirmedCostValue', case when v_cost then d.confirmed_value end,
        'elsewhereProducts', d.elsewhere_products,
        'elsewhereCostValue', case when v_cost then d.elsewhere_value end,
        'movingProducts', d.moving_products,
        'movingCostValue', case when v_cost then d.moving_value end) from d),
    'aging', (select jsonb_agg(jsonb_build_object('band', k.band, 'products', coalesce(a.products, 0),
        'costValue', case when v_cost then coalesce(a.value, 0) end,
        'newProducts', coalesce(a.new_products, 0), 'incompleteProducts', coalesce(a.incomplete_products, 0))
      order by k.ord)
      from unnest(array['30', '90', '180', '365']) with ordinality as k(band, ord)
      left join (
        select agb.band, count(*)::integer as products, sum(agb.value) as value,
          count(*) filter (where agb.is_new)::integer as new_products,
          -- Nunca vendeu e já estava no estoque antes do histórico começar (mais curto que 12 meses):
          -- o tempo real sem venda pode ser maior do que o histórico mostra.
          count(*) filter (where not agb.is_new and agb.never and agb.days < 365
                           and (agb.arrived_on is null or agb.arrived_on < agb.sales_from))::integer
            as incomplete_products
        from agb where agb.band is not null group by agb.band) a on a.band = k.band),
    'byCompany', coalesce((select jsonb_agg(jsonb_build_object('companyId', co.company_id,
        'companyName', co.company_name, 'positions', co.positions,
        'costValue', case when v_cost then co.cost_value end) order by co.ord) from co), '[]'::jsonb))
  into v;
  return v;
end $$;

create or replace function stock_internal.positions(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_scope uuid[] := stock_internal.scope(p_query->>'companyId');
  v_window text := stock_internal.pick_window(nullif(p_query->>'window', ''));
  v_view text := coalesce(nullif(p_query->>'view', ''), 'position');
  v_search text := nullif(stock_internal.fold(btrim(coalesce(p_query->>'search', ''))), '');
  v_curve text := coalesce(nullif(p_query->>'curve', ''), 'all');
  v_location text := nullif(p_query->>'locationCode', '');
  v_family text := nullif(p_query->>'family', '');
  v_negative boolean := coalesce((p_query->>'onlyNegative')::boolean, false);
  v_hide_zero boolean := coalesce((p_query->>'hideZero')::boolean, false);
  v_below_min boolean := coalesce((p_query->>'belowMin')::boolean, false);
  v_new boolean := coalesce((p_query->>'onlyNew')::boolean, false);
  v_incomplete boolean := coalesce((p_query->>'onlyIncomplete')::boolean, false);
  v_elsewhere boolean := coalesce((p_query->>'soldElsewhere')::boolean, false);
  v_manual boolean := coalesce((p_query->>'onlyManual')::boolean, false);
  v_confirmed boolean := coalesce((p_query->>'onlyConfirmed')::boolean, false);
  v_moving boolean := coalesce((p_query->>'recentExit')::boolean, false);
  v_min_days integer := nullif(p_query->>'minDaysWithoutSale', '')::integer;
  v_product text := nullif(p_query->>'productId', '');
  v_sort text := coalesce(nullif(p_query->>'sortBy', ''), 'costValue');
  v_dir text := coalesce(nullif(p_query->>'sortDir', ''), 'desc');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_total integer;
  v_rows jsonb;
begin
  if v_curve not in ('all', 'A', 'B', 'C', 'D', 'U')
     or v_sort not in ('costValue', 'physicalQty', 'name', 'sku', 'lastSale', 'daysWithoutSale', 'windowRevenue')
     or v_dir not in ('asc', 'desc') or v_view not in ('position', 'product')
     or v_page < -1 or v_page > 1000
     or (v_min_days is not null and v_min_days not in (30, 90, 180, 365))
     or char_length(coalesce(v_search, '')) > 120 then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  -- page = -1: todas as linhas do filtro, só para exportação.
  if v_page = -1 then perform stock_internal.require('export'); end if;
  -- Sem acesso a custo, a ordem por valor (ou faturamento) vira nome em ordem alfabética.
  if v_sort in ('costValue', 'windowRevenue') and not v_cost then
    v_sort := 'name';
    v_dir := 'asc';
  end if;

  with x as (
    select r.*, r.physical_qty * r.unit_cost as cost_value,
      case when v_view = 'product' then '*' else r.location_code end as loc_key
    from stock_internal.current_rows(v_scope, v_window) r
    where (v_search is null or strpos(stock_internal.fold(r.name || ' ' || r.sku), v_search) > 0)
      and (v_curve = 'all' or r.curve = v_curve)
      and (v_location is null or r.location_code = v_location)
      and (v_family is null or r.family = v_family)
      and (not v_negative or r.physical_qty < 0)
      and (not v_hide_zero or r.physical_qty <> 0 or r.reserved_qty <> 0 or r.pending_qty <> 0)
      and (not v_below_min or (r.min_qty > 0 and r.physical_qty < r.min_qty))
      and (not v_new or r.is_new)
      and (not v_incomplete or r.incomplete_reason is not null)
      and (not v_elsewhere or r.elsewhere_company is not null)
      and (not v_manual or r.curve_source = 'manual')
      and (not v_moving or r.recent_exit)
      -- Sem venda confirmada: sem venda na janela, com histórico suficiente e não é produto novo.
      and (not v_confirmed or (r.product_qty > 0 and r.curves_as_of is not null and r.window_revenue = 0
           and not r.is_new and r.incomplete_reason is null))
      and (v_min_days is null or (r.product_qty > 0 and r.curves_as_of is not null
           and r.days_without_sale >= v_min_days))
      and (v_product is null or r.product_id::text = v_product)),
  -- Visão por produto: todos os locais somados (a curva é do produto na empresa).
  g as (
    select x.company_id::text || ':' || x.omie_product_id || ':' || x.loc_key as id,
      x.company_id, min(x.company_name) as company_name, min(x.product_id::text) as product_id,
      x.omie_product_id, min(x.sku) as sku, min(x.name) as name, min(x.family) as family,
      x.loc_key as location_code,
      case when v_view = 'product' then null else min(x.location_name) end as location_name,
      count(*)::integer as locations, min(x.curve) as curve, min(x.curve_source) as curve_source,
      min(x.curve_reason) as curve_reason, min(x.curve_set_at) as curve_set_at, min(x.curve_set_by) as curve_set_by,
      sum(x.physical_qty) as physical_qty, sum(x.reserved_qty) as reserved_qty, sum(x.pending_qty) as pending_qty,
      case when v_view = 'product' then null else min(x.min_qty) end as min_qty,
      case when sum(x.physical_qty) <> 0 then sum(x.cost_value) / sum(x.physical_qty) else max(x.unit_cost) end as unit_cost,
      sum(x.cost_value) as cost_value, max(x.sale_price) as sale_price,
      min(x.window_revenue) as window_revenue, min(x.window_share) as window_share, min(x.product_qty) as product_qty,
      min(x.last_sale) as last_sale, min(x.days_without_sale) as days_without_sale,
      min(x.last_entry) as last_entry, min(x.last_entry_operation) as last_entry_operation,
      min(x.first_entry) as first_entry, min(x.registered_at) as registered_at, min(x.arrived_on) as arrived_on,
      bool_or(x.is_new) as is_new, min(x.incomplete_reason) as incomplete_reason,
      min(x.elsewhere_company) as elsewhere_company, min(x.elsewhere_last_sale) as elsewhere_last_sale,
      min(x.sales_from) as sales_from, min(x.idle_since) as idle_since,
      min(x.last_exit) as last_exit, min(x.last_exit_operation) as last_exit_operation,
      bool_or(x.recent_exit) as recent_exit, bool_or(x.last_exit_group) as last_exit_group
    from x
    group by x.company_id, x.omie_product_id, x.loc_key),
  o as (
    select g.*, count(*) over () as total_count,
      row_number() over (order by
        case when v_dir = 'asc' then case v_sort when 'costValue' then g.cost_value
          when 'physicalQty' then g.physical_qty when 'windowRevenue' then g.window_revenue
          when 'daysWithoutSale' then coalesce(g.days_without_sale, 100000) end end asc nulls last,
        case when v_dir = 'desc' then case v_sort when 'costValue' then g.cost_value
          when 'physicalQty' then g.physical_qty when 'windowRevenue' then g.window_revenue
          when 'daysWithoutSale' then coalesce(g.days_without_sale, 100000) end end desc nulls last,
        case when v_dir = 'asc' and v_sort = 'lastSale' then g.last_sale end asc nulls first,
        case when v_dir = 'desc' and v_sort = 'lastSale' then g.last_sale end desc nulls last,
        case when v_dir = 'asc' then case v_sort when 'name' then g.name when 'sku' then g.sku end end asc,
        case when v_dir = 'desc' then case v_sort when 'name' then g.name when 'sku' then g.sku end end desc,
        g.name, g.sku, g.company_name, g.location_code) as rn
    from g)
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'companyId', o.company_id, 'companyName', o.company_name, 'productId', o.product_id,
      'omieProductId', o.omie_product_id, 'sku', o.sku, 'name', o.name, 'family', o.family,
      'locationCode', o.location_code, 'locationName', o.location_name, 'locations', o.locations,
      'curve', o.curve, 'curveSource', o.curve_source, 'curveReason', o.curve_reason,
      'curveSetAt', o.curve_set_at, 'curveSetBy', o.curve_set_by,
      'physicalQty', o.physical_qty, 'reservedQty', o.reserved_qty, 'pendingQty', o.pending_qty,
      'minQty', o.min_qty, 'productQty', o.product_qty,
      'unitCost', case when v_cost then o.unit_cost end,
      'costValue', case when v_cost then o.cost_value end,
      'salePrice', case when v_cost then o.sale_price end,
      'windowRevenue', case when v_cost then o.window_revenue end,
      'windowShare', case when v_cost then o.window_share end,
      'lastSale', o.last_sale, 'daysWithoutSale', o.days_without_sale, 'salesFrom', o.sales_from,
      'idleSince', o.idle_since, 'lastExit', o.last_exit, 'lastExitOperation', o.last_exit_operation,
      'recentExit', o.recent_exit, 'lastExitGroup', o.last_exit_group,
      'lastEntry', o.last_entry, 'lastEntryOperation', o.last_entry_operation, 'firstEntry', o.first_entry,
      'registeredAt', o.registered_at, 'arrivedOn', o.arrived_on, 'isNew', o.is_new,
      'incompleteHistory', o.incomplete_reason,
      'soldElsewhere', case when o.elsewhere_company is not null then
        jsonb_build_object('companyName', o.elsewhere_company, 'lastSale', o.elsewhere_last_sale) end)
      order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 100 and o.rn <= (v_page + 1) * 100)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  if v_page = -1 and v_total > 20000 then
    raise exception 'A exportação vai até 20.000 linhas. Refine os filtros.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'window', v_window, 'view', v_view);
end $$;

create or replace function stock_internal.filter_options(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_scope uuid[] := stock_internal.scope(p_company);
  v jsonb;
begin
  with x as (select * from stock_internal.current_rows(v_scope, stock_internal.pick_window(null))),
  l as (select x.location_code as code, max(x.location_name) as name from x group by x.location_code)
  select jsonb_build_object(
    'locations', coalesce((select jsonb_agg(jsonb_build_object('code', l.code, 'name', l.name)
      order by coalesce(l.name, l.code)) from l), '[]'::jsonb),
    'families', coalesce((select jsonb_agg(f.family order by f.family)
      from (select distinct x.family from x where x.family is not null) f), '[]'::jsonb),
    'defaultWindow', stock_internal.pick_window(null))
  into v;
  return v;
end $$;

create or replace function public.stock_worker_enqueue(p_slot text, p_kind text, p_position_date date)
returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_count integer := 0;
  v_company uuid;
  v_settings private.stock_settings;
  v_yesterday date := p_position_date - 1;
  v_covered date;
  v_from date;
begin
  if p_slot is null or p_kind not in ('intraday', 'close') or p_position_date is null then
    raise exception 'pedido de leitura inválido';
  end if;
  select * into v_settings from private.stock_settings;
  if not v_settings.reading_enabled then return 0; end if;
  for v_company in
    select ci.company_id from public.company_integrations ci join public.companies c on c.id = ci.company_id
    where ci.provider = 'omie' and ci.status = 'CONNECTED' and not c.is_demo
      and c.data_source in ('OMIE', 'OMIE_SHADOW')
    order by c.name
  loop
    if not exists (select 1 from private.stock_readings r
                   where r.company_id = v_company and r.status in ('queued', 'running')) then
      insert into private.stock_readings (company_id, kind, trigger, slot, status, position_date)
        values (v_company, p_kind, 'schedule', p_slot, 'queued', p_position_date)
        on conflict (company_id, slot) where slot is not null do nothing;
      if found then v_count := v_count + 1; end if;
    end if;
    continue when not v_settings.movements_enabled
      or exists (select 1 from private.stock_movement_jobs j
                 where j.company_id = v_company and j.status in ('queued', 'running'));
    select max(j.period_to) into v_covered from private.stock_movement_jobs j
      where j.company_id = v_company and j.status = 'complete';
    if not exists (select 1 from private.stock_movement_jobs j
                   where j.company_id = v_company and j.trigger = 'backfill') then
      -- Carga inicial: blocos de movements_chunk_days, do mais antigo para ontem.
      v_from := v_yesterday - v_settings.movements_days + 1;
      while v_from <= v_yesterday loop
        insert into private.stock_movement_jobs (company_id, trigger, period_from, period_to)
          values (v_company, 'backfill', v_from,
                  least(v_from + v_settings.movements_chunk_days - 1, v_yesterday));
        v_from := v_from + v_settings.movements_chunk_days;
      end loop;
    elsif v_covered < v_yesterday then
      -- Atualização: relê 3 dias para pegar cancelamentos e lançamentos atrasados.
      insert into private.stock_movement_jobs (company_id, trigger, period_from, period_to)
        values (v_company, 'delta', greatest(v_covered - 3, v_yesterday - 30), v_yesterday);
    end if;
  end loop;
  return v_count;
end $$;

create or replace function public.stock_overview(p_company text, p_window text default null) returns jsonb
language sql stable as $$ select stock_internal.overview(p_company, p_window) $$;
revoke all on function stock_internal.overview(text, text) from public, anon, authenticated;
grant execute on function stock_internal.overview(text, text) to authenticated;
revoke all on function public.stock_overview(text, text) from public, anon;
grant execute on function public.stock_overview(text, text) to authenticated;

delete from private.vps_schema_migrations where name = '0048_stock_suppliers';
do $$
begin
  if to_regprocedure('public.stock_overview(text,text)') is null
     or to_regprocedure('public.stock_overview(text,text,text)') is not null
     or to_regprocedure('public.stock_suppliers(jsonb)') is not null then
    raise exception 'retorno da 0048 incompleto';
  end if;
end $$;
notify pgrst, 'reload schema';
