-- 0047: Inteligência do Estoque — fase 3 (diagnóstico automático, recomendações e alertas).
--
-- Aditiva e consultiva: nada aqui altera saldos, curvas, notas, movimentações ou o Omie.
-- - O motor (versão intel-1.1) passa a gravar, em cada produto da execução, os diagnósticos, as
--   recomendações e os alertas que as suas regras encontraram (biomie_intel/diagnosis.py), sempre com as
--   evidências que os sustentam. Textos nunca trazem custo; valores de custo vão em evidências marcadas
--   "cost" e itens que dependem de custo ficam marcados "requiresCost": a máscara esconde os dois de quem
--   não vê custo.
-- - Alertas ficam guardados entre execuções (private.intel_alerts): o mesmo problema não vira um aviso
--   novo a cada dia; "mudou" só quando a gravidade muda; a ciência ("estou ciente") vale até a gravidade
--   aumentar; o que deixou de aparecer é resolvido. Dar ciência exige o perfil que classifica curvas e
--   fica na auditoria.
-- - A extração entrega também: início da janela da curva, custo da análise anterior e entradas de compra
--   em 30/90 dias (desconhecidas, não zero, quando as movimentações não cobrem o período).
-- - Lista de produtos: diagnóstico e ação principais, número de alertas e filtros por recomendação e
--   "com alerta". Detalhe do produto: alertas e movimentações por dia (só quantidades).
-- Retorno: as funções voltam ao corpo da 0044/0045 reaplicando esses arquivos; a tabela nova pode ficar
-- (nada a lê sem esta migração).

-- ===================================================================== alertas

create table if not exists private.intel_alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  omie_product_id text not null,
  kind text not null check (kind ~ '^[a-z_]{3,40}$'),
  rule text not null default '',
  severity text not null check (severity in ('alta', 'media', 'baixa', 'info')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  reason text not null default '',
  evidence jsonb not null default '[]'::jsonb,
  requires_cost boolean not null default false,
  first_run uuid,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_run uuid,
  last_seen_at timestamptz not null default clock_timestamp(),
  changed_at timestamptz not null default clock_timestamp(),
  resolved_run uuid,
  resolved_at timestamptz,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledged_note text
);
-- No máximo um alerta aberto por produto e tipo; os resolvidos ficam como histórico.
create unique index if not exists intel_alerts_open on private.intel_alerts (company_id, omie_product_id, kind)
  where status = 'open';
create index if not exists intel_alerts_company on private.intel_alerts (company_id, status, severity, changed_at desc);
revoke all on private.intel_alerts from public, anon, authenticated, service_role;

-- alta = 1 (mais grave) … info = 4
create or replace function stock_internal.intel_severity_rank(p_severity text) returns integer
language sql immutable set search_path = pg_catalog as $$
  select case p_severity when 'alta' then 1 when 'media' then 2 when 'baixa' then 3 when 'info' then 4 else 5 end
$$;

-- Lista de diagnósticos/recomendações/alertas sem o que depende de custo: tira os itens "requiresCost" e,
-- dos que ficam, as evidências "cost".
create or replace function stock_internal.intel_mask_items(p_items jsonb) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(x.i || jsonb_build_object('evidence', coalesce((
      select jsonb_agg(e order by eo)
      from jsonb_array_elements(case when jsonb_typeof(x.i->'evidence') = 'array' then x.i->'evidence'
                                     else '[]'::jsonb end) with ordinality as ee(e, eo)
      where not coalesce((e->>'cost')::boolean, false)), '[]'::jsonb)) order by x.ord), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end)
    with ordinality as x(i, ord)
  where jsonb_typeof(x.i) = 'object' and not coalesce((x.i->>'requiresCost')::boolean, false)
$$;

-- Máscara dos indicadores (0044) + diagnósticos, recomendações e alertas sem custo.
create or replace function stock_internal.intel_mask(p_metrics jsonb, p_cost boolean) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select case when p_cost then p_metrics else
    (p_metrics - array['capital', 'cost', 'avgPrice', 'marginEstPct', 'salePrice'])
    || jsonb_build_object(
      'stock', coalesce(p_metrics->'stock', '{}'::jsonb) - 'negativeValue',
      'curve', coalesce(p_metrics->'curve', '{}'::jsonb) - 'revenue12m',
      'sales', coalesce((select jsonb_object_agg(e.key, e.value - 'revenue') from jsonb_each(p_metrics->'sales') e),
                        '{}'::jsonb),
      'salesMonthly', coalesce((select jsonb_agg(jsonb_build_array(x->0, x->1))
                                from jsonb_array_elements(p_metrics->'salesMonthly') x), '[]'::jsonb),
      'diagnoses', stock_internal.intel_mask_items(p_metrics->'diagnoses'),
      'recommendations', stock_internal.intel_mask_items(p_metrics->'recommendations'),
      'alerts', stock_internal.intel_mask_items(p_metrics->'alerts'))
  end
$$;

-- Um alerta como a tela recebe: novo = aberto nesta execução; mudou = gravidade mudou nesta execução.
create or replace function stock_internal.intel_alert_json(t private.intel_alerts, p_cost boolean, p_run uuid,
  p_run_started timestamptz) returns jsonb
language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'id', t.id, 'companyId', t.company_id, 'omieProductId', t.omie_product_id, 'kind', t.kind, 'rule', t.rule,
    'severity', t.severity, 'status', t.status, 'reason', t.reason,
    'evidence', case when p_cost then t.evidence else coalesce((
      select jsonb_agg(e) from jsonb_array_elements(t.evidence) e where not coalesce((e->>'cost')::boolean, false)),
      '[]'::jsonb) end,
    'firstSeenAt', t.first_seen_at, 'lastSeenAt', t.last_seen_at, 'changedAt', t.changed_at, 'resolvedAt', t.resolved_at,
    'isNew', t.status = 'open' and t.first_run is not distinct from p_run,
    'changed', t.status = 'open' and t.first_run is distinct from p_run and p_run_started is not null
               and t.changed_at >= p_run_started,
    'acknowledged', case when t.acknowledged_at is not null then jsonb_build_object(
      'at', t.acknowledged_at, 'note', t.acknowledged_note,
      'by', (select coalesce(nullif(p.full_name, ''), 'Usuário') from public.profiles p where p.id = t.acknowledged_by)) end)
$$;


-- ===================================================================== funções da 0044/0045 com a fase 3

create or replace function stock_internal.intel_extract(p_run uuid, p_company uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
  v_as_of date := v_run.as_of;
  v_capture jsonb;
  v_mov_from date;
  v jsonb;
begin
  if not exists (select 1 from public.companies c where c.id = p_company and not c.is_demo) then
    raise exception 'Empresa inválida para a inteligência do estoque.' using errcode = 'P0001';
  end if;
  v_capture := stock_internal.intel_capture(p_company);
  v_mov_from := stock_internal.movements_from(p_company);
  with x as (select * from stock_internal.current_rows(array[p_company], '12m')),
  p as (
    select x.omie_product_id, min(x.product_id::text) as product_id, max(x.sku) as sku, max(x.name) as name,
      max(x.family) as family, sum(x.physical_qty) as qty, sum(x.reserved_qty) as reserved,
      sum(x.pending_qty) as pending, sum(x.min_qty) as min_qty,
      max(x.unit_cost) filter (where x.unit_cost > 0) as cost_max, min(x.unit_cost) filter (where x.unit_cost > 0) as cost_min,
      sum(x.physical_qty) filter (where x.physical_qty > 0) as qty_positive,
      round(sum(x.physical_qty * x.unit_cost) filter (where x.physical_qty > 0 and x.unit_cost > 0), 2) as capital,
      round(sum(x.physical_qty * x.unit_cost) filter (where x.physical_qty < 0), 2) as negative_value,
      count(*) filter (where x.physical_qty < 0) as negative_positions, count(*) as locations,
      max(x.sale_price) filter (where x.sale_price > 0) as sale_price,
      min(x.curve) as curve, min(x.curve_source) as curve_source,
      min(x.window_revenue) as revenue_12m, min(x.window_share) as share_12m,
      min(x.last_sale) as last_sale, min(x.days_without_sale) as days_without_sale, min(x.idle_since) as idle_since,
      min(x.last_entry) as last_entry, min(x.last_entry_operation) as last_entry_op, min(x.first_entry) as first_entry,
      min(x.last_exit) as last_exit, min(x.last_exit_operation) as last_exit_op, bool_or(x.last_exit_group) as last_exit_group,
      bool_or(x.recent_exit) as recent_exit, min(x.arrived_on) as arrived_on, min(x.registered_at) as registered_at,
      bool_or(x.is_new) as is_new, min(x.incomplete_reason) as incomplete_reason,
      min(x.elsewhere_company) as elsewhere_company, min(x.elsewhere_last_sale) as elsewhere_last_sale,
      min(x.sales_from) as sales_from, min(x.window_start) as window_start
    from x group by x.omie_product_id),
  s as (
    select pr.external_id as omie_product_id, f.competence_date as day, sum(f.qty) as qty,
      round(sum(f.amount), 2) as revenue, count(distinct f.invoice_id) as invoices
    from public.fact_sales(p_company, v_as_of - 364, v_as_of) f
    join public.products pr on pr.id = f.product_id and pr.source = 'omie'
    group by 1, 2),
  rt as (
    select m.omie_product_id, m.moved_on as day, sum(abs(m.qty)) as qty
    from private.stock_movements m
    where m.company_id = p_company and m.kind = 'entrada' and m.operation = '13' and not m.canceled
      and m.moved_on between v_as_of - 364 and v_as_of
    group by 1, 2),
  -- Fase 3: entradas de compra/produção (sem devolução, estorno ou transferência entre locais) em 30 e
  -- 90 dias, só quando as movimentações cobrem o período (senão o valor é desconhecido, não zero).
  rc as (
    select m.omie_product_id,
      sum(abs(m.qty)) filter (where m.moved_on >= v_as_of - 29) as r30, sum(abs(m.qty)) as r90
    from private.stock_movements m
    where m.company_id = p_company and m.kind = 'entrada' and not m.canceled and m.operation <> '13'
      and stock_internal.is_receipt(m.operation) and m.moved_on between v_as_of - 89 and v_as_of
      and not exists (select 1 from private.stock_movements r
        where r.company_id = m.company_id and r.omie_product_id = m.omie_product_id and r.kind = 'saida'
          and r.canceled and r.operation = m.operation and r.document = m.document)
      and not (m.operation = '00' and exists (select 1 from private.stock_movements r
        where r.company_id = m.company_id and r.omie_product_id = m.omie_product_id and r.kind = 'saida'
          and r.operation = '00' and not r.canceled and r.moved_on = m.moved_on and abs(r.qty) = abs(m.qty)))
    group by 1),
  -- Custo da análise publicada anterior (para o alerta de custo que mudou).
  pc as (
    select pm.omie_product_id, (pm.metrics->'cost'->>'unitCost')::numeric as unit_cost
    from private.intel_current ic
    join private.intel_product_metrics pm on pm.run_id = ic.run_id and pm.company_id = ic.company_id
    where ic.company_id = p_company),
  h as (
    select hh.omie_product_id, hh.curve, hh.day
    from (select c.*, row_number() over (partition by c.omie_product_id order by c.day desc) as rn
          from private.stock_curve_history c where c.company_id = p_company) hh
    where hh.rn <= 2)
  select jsonb_build_object(
    'companyId', p_company, 'asOf', v_as_of,
    'salesFrom', stock_internal.sales_from(p_company, v_as_of),
    'movementsFrom', v_mov_from,
    'capture', v_capture,
    -- Só o que importa à análise: com saldo (positivo ou negativo) ou com venda em 12 meses.
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'omieProductId', p.omie_product_id, 'productId', p.product_id, 'sku', p.sku, 'name', p.name,
        'family', p.family, 'qty', p.qty, 'reserved', p.reserved, 'pending', p.pending, 'minQty', p.min_qty,
        'costMax', p.cost_max, 'costMin', p.cost_min, 'qtyPositive', p.qty_positive, 'capital', p.capital,
        'negativeValue', p.negative_value, 'negativePositions', p.negative_positions, 'locations', p.locations,
        'salePrice', p.sale_price, 'curve', p.curve, 'curveSource', p.curve_source,
        'revenue12m', p.revenue_12m, 'share12m', p.share_12m, 'lastSale', p.last_sale,
        'daysWithoutSale', p.days_without_sale, 'idleSince', p.idle_since, 'lastEntry', p.last_entry,
        'lastEntryOperation', p.last_entry_op, 'firstEntry', p.first_entry, 'lastExit', p.last_exit,
        'lastExitOperation', p.last_exit_op, 'lastExitGroup', p.last_exit_group, 'recentExit', p.recent_exit,
        'arrivedOn', p.arrived_on, 'registeredAt', p.registered_at, 'isNew', p.is_new,
        'incompleteReason', p.incomplete_reason, 'elsewhereCompany', p.elsewhere_company,
        'elsewhereLastSale', p.elsewhere_last_sale)
        || jsonb_build_object('curveWindowStart', p.window_start,
             'prevUnitCost', (select pc.unit_cost from pc where pc.omie_product_id = p.omie_product_id),
             'received30', case when v_mov_from <= v_as_of - 29 then
               coalesce((select rc.r30 from rc where rc.omie_product_id = p.omie_product_id), 0) end,
             'received90', case when v_mov_from <= v_as_of - 89 then
               coalesce((select rc.r90 from rc where rc.omie_product_id = p.omie_product_id), 0) end)
        order by p.omie_product_id)
      from p where p.qty <> 0 or coalesce(p.revenue_12m, 0) > 0
        or exists (select 1 from s where s.omie_product_id = p.omie_product_id)), '[]'::jsonb),
    'sales', coalesce((select jsonb_agg(jsonb_build_array(s.omie_product_id, s.day, s.qty, s.revenue, s.invoices)
        order by s.omie_product_id, s.day) from s), '[]'::jsonb),
    'returns', coalesce((select jsonb_agg(jsonb_build_array(rt.omie_product_id, rt.day, rt.qty)
        order by rt.omie_product_id, rt.day) from rt), '[]'::jsonb),
    'curveHistory', coalesce((select jsonb_agg(jsonb_build_array(h.omie_product_id, h.curve, h.day)
        order by h.omie_product_id, h.day desc) from h), '[]'::jsonb))
  into v;
  return v;
end $$;

create or replace function stock_internal.intel_finish(p_run uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
  v_companies integer;
  v_keep integer := coalesce((stock_internal.intel_params()->>'runsKeptDays')::integer, 14);
  v_alerts_keep integer := coalesce((stock_internal.intel_params()->>'alertsKeptDays')::integer, 180);
  v_opened integer;
  v_resolved integer;
begin
  insert into private.intel_current (company_id, run_id, published_at)
  select distinct m.company_id, v_run.id, now() from private.intel_product_metrics m where m.run_id = v_run.id
  on conflict (company_id) do update set run_id = excluded.run_id, published_at = excluded.published_at;
  get diagnostics v_companies = row_count;
  update private.intel_runs set status = 'published', finished_at = clock_timestamp(), stats = p_stats where id = v_run.id;
  -- Fase 3: alertas. Abre os novos, atualiza os que continuam (sem repetir o aviso: "mudou" só quando a
  -- gravidade muda; a ciência vale até a gravidade aumentar) e resolve os que não apareceram nesta
  -- execução, só nas empresas que ela analisou.
  with det as (
    select distinct on (m.company_id, m.omie_product_id, a->>'kind')
      m.company_id, m.omie_product_id, a->>'kind' as kind, left(coalesce(a->>'rule', ''), 10) as rule,
      a->>'severity' as severity, left(coalesce(a->>'reason', ''), 500) as reason,
      case when jsonb_typeof(a->'evidence') = 'array' then a->'evidence' else '[]'::jsonb end as evidence,
      coalesce((a->>'requiresCost')::boolean, false) as requires_cost
    from private.intel_product_metrics m
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(m.metrics->'alerts') = 'array' then m.metrics->'alerts' else '[]'::jsonb end) a
    where m.run_id = v_run.id and a->>'kind' ~ '^[a-z_]{3,40}$' and a->>'severity' in ('alta', 'media', 'baixa', 'info')
    order by m.company_id, m.omie_product_id, a->>'kind', stock_internal.intel_severity_rank(a->>'severity'))
  insert into private.intel_alerts as t (company_id, omie_product_id, kind, rule, severity, reason, evidence,
    requires_cost, first_run, last_run)
  select d.company_id, d.omie_product_id, d.kind, d.rule, d.severity, d.reason, d.evidence, d.requires_cost, v_run.id, v_run.id
  from det d
  on conflict (company_id, omie_product_id, kind) where status = 'open' do update set
    rule = excluded.rule, reason = excluded.reason, evidence = excluded.evidence, requires_cost = excluded.requires_cost,
    last_run = excluded.last_run, last_seen_at = clock_timestamp(),
    changed_at = case when t.severity <> excluded.severity then clock_timestamp() else t.changed_at end,
    acknowledged_at = case when stock_internal.intel_severity_rank(excluded.severity)
                                < stock_internal.intel_severity_rank(t.severity) then null else t.acknowledged_at end,
    acknowledged_by = case when stock_internal.intel_severity_rank(excluded.severity)
                                < stock_internal.intel_severity_rank(t.severity) then null else t.acknowledged_by end,
    acknowledged_note = case when stock_internal.intel_severity_rank(excluded.severity)
                                  < stock_internal.intel_severity_rank(t.severity) then null else t.acknowledged_note end,
    severity = excluded.severity;
  get diagnostics v_opened = row_count;
  update private.intel_alerts t set status = 'resolved', resolved_at = clock_timestamp(), resolved_run = v_run.id
   where t.status = 'open' and t.last_run is distinct from v_run.id
     and t.company_id in (select distinct m.company_id from private.intel_product_metrics m where m.run_id = v_run.id);
  get diagnostics v_resolved = row_count;
  delete from private.intel_alerts t where t.status = 'resolved' and t.resolved_at < now() - make_interval(days => v_alerts_keep);
  delete from private.intel_runs r
   where r.started_at < now() - make_interval(days => v_keep)
     and not exists (select 1 from private.intel_current c where c.run_id = r.id);
  return jsonb_build_object('published', true, 'companies', v_companies, 'alertsSeen', v_opened,
                            'alertsResolved', v_resolved);
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
  v_rec text := nullif(p_query->>'rec', '');
  v_with_alerts boolean := coalesce((p_query->>'withAlerts')::boolean, false);
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
     or (v_min_idle is not null and v_min_idle not in (30, 60, 90, 180, 365))
     or (v_rec is not null and v_rec !~ '^[a-z_]{3,40}$') then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  -- Sinais de custo (CMC até R$ 1, sem custo, custo diferente entre locais) revelam custo: só para
  -- quem vê custo, também como filtro.
  if v_flag in ('custo_desconhecido', 'custo_provisorio', 'custo_divergente') and not v_cost then
    perform stock_internal.require('viewCost');
  end if;
  -- Recomendação que depende de custo (conferir custo) também só para quem vê custo.
  if v_rec = 'conferir_custo' and not v_cost then
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
      and (v_search is null or mm.sku ilike '%' || v_search || '%' or mm.name ilike '%' || v_search || '%')
      and (v_rec is null or exists (select 1 from jsonb_array_elements(
            case when jsonb_typeof(mm.metrics->'recommendations') = 'array' then mm.metrics->'recommendations'
                 else '[]'::jsonb end) r
          where r->>'type' = v_rec and (v_cost or not coalesce((r->>'requiresCost')::boolean, false))))
      and (not v_with_alerts or exists (select 1 from private.intel_alerts t
          where t.company_id = mm.company_id and t.omie_product_id = mm.omie_product_id and t.status = 'open'
            and (v_cost or not t.requires_cost)))),
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
      'priorityParts', case when v_cost then o.priority_parts end,
      'diagnosis', (select jsonb_build_object('code', d->>'code', 'title', d->>'title', 'severity', d->>'severity', 'text', d->>'text')
                    from jsonb_array_elements(case when v_cost and jsonb_typeof(o.metrics->'diagnoses') = 'array'
                      then o.metrics->'diagnoses' else stock_internal.intel_mask_items(o.metrics->'diagnoses') end) d limit 1),
      'action', (select jsonb_build_object('type', r->>'type', 'action', r->>'action')
                 from jsonb_array_elements(case when v_cost and jsonb_typeof(o.metrics->'recommendations') = 'array'
                   then o.metrics->'recommendations' else stock_internal.intel_mask_items(o.metrics->'recommendations') end) r
                 limit 1),
      'alerts', (select count(*) from private.intel_alerts t
                 where t.company_id = o.company_id and t.omie_product_id = o.omie_product_id and t.status = 'open'
                   and (v_cost or not t.requires_cost)),
      -- fase 4: previsão de 30 dias (só quando o modelo passou no teste histórico) e a qualidade dela
      'forecast', jsonb_build_object('status', o.metrics->'forecast'->>'status',
        'units30', o.metrics->'forecast'->'horizons'->'30'->'units',
        'quality', o.metrics->'forecast'->'backtest'->>'quality')) order by o.rn)
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
                     where h.company_id = x.company_id and h.omie_product_id = x.omie_product_id),
    -- Fase 3: alertas do produto (abertos e resolvidos nos últimos 90 dias), sem custo para quem não vê.
    'alerts', (select coalesce(jsonb_agg(stock_internal.intel_alert_json(t, v_cost, ic.run_id, r.started_at)
                 order by t.status, stock_internal.intel_severity_rank(t.severity), t.changed_at desc), '[]')
               from private.intel_alerts t
               where t.company_id = x.company_id and t.omie_product_id = x.omie_product_id
                 and (t.status = 'open' or t.resolved_at > now() - interval '90 days')
                 and (v_cost or not t.requires_cost)),
    -- Movimentações por dia (só quantidades), para o gráfico e para estimar o saldo de cada dia a partir
    -- do saldo atual: inclui estornos (que se anulam) e transferências entre locais (somam zero).
    'movements', jsonb_build_object('from', stock_internal.movements_from(x.company_id),
      'days', (select coalesce(jsonb_agg(jsonb_build_array(d.day, d.in_qty, d.out_qty, d.purchase_qty, d.sale_qty)
                 order by d.day), '[]')
               from (select m.moved_on as day,
                       sum(abs(m.qty)) filter (where m.kind = 'entrada') as in_qty,
                       sum(abs(m.qty)) filter (where m.kind = 'saida') as out_qty,
                       sum(abs(m.qty)) filter (where m.kind = 'entrada' and not m.canceled and m.operation <> '13'
                                                 and stock_internal.is_receipt(m.operation)) as purchase_qty,
                       sum(abs(m.qty)) filter (where m.kind = 'saida' and not m.canceled and m.operation in ('11', '12')) as sale_qty
                     from private.stock_movements m
                     where m.company_id = x.company_id and m.omie_product_id = x.omie_product_id
                       and m.moved_on > r.as_of - 365 and m.moved_on <= r.as_of
                     group by m.moved_on) d)))
  into v
  from private.intel_current ic
  join private.intel_runs r on r.id = ic.run_id
  join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
  join public.companies c on c.id = x.company_id
  where ic.company_id = v_companies[1] and x.omie_product_id = p_omie;
  return v;
end $$;

create or replace function stock_internal.intel_params() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'minHistoryDays', 120, 'lowTurnoverAnnual', 1.0, 'excessCoverageDays', 180, 'obsolescenceDays', 365,
    -- execuções guardadas: 7 dias (eram 14) — com diagnósticos e previsão cada produto ocupa ~4 KB, e só a
    -- execução publicada é lida (o custo anterior para os alertas vem dela)
    'ruptureCoverageDays', 15, 'trendDeclinePct', -30, 'costSuspectMax', 1.00, 'runsKeptDays', 7,
    'priorityWeights', jsonb_build_object('capital', 0.4, 'idle', 0.3, 'coverage', 0.15, 'trend', 0.15),
    -- fase 3 (alertas): volume mínimo para queda abrupta, quedas e variações que disparam aviso, notas
    -- mínimas para "parou de vender", devoluções que pedem atenção e dias que um alerta resolvido fica
    'anomalyMinUnits', 5, 'abruptDropPct', -50, 'costChangePct', 30, 'costDivergencePct', 20,
    'stoppedSellingMinInvoices', 3, 'returnsAttentionPct', 10, 'alertsKeptDays', 180)
    || coalesce((select s.params from private.intel_settings s where s.id), '{}'::jsonb)
$$;

-- ===================================================================== alertas na tela

-- Lista de alertas (abertos por padrão), mais graves e mais recentes primeiro, com o resumo dos abertos.
-- Quem não vê custo não recebe alertas de custo nem evidências de custo.
create or replace function stock_internal.intel_alerts(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_companies uuid[] := stock_internal.scope(p_query->>'companyId');
  v_status text := coalesce(nullif(p_query->>'status', ''), 'open');
  v_severity text := nullif(p_query->>'severity', '');
  v_kind text := nullif(p_query->>'kind', '');
  v_only_new boolean := coalesce((p_query->>'onlyNew')::boolean, false);
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_omie text := nullif(p_query->>'omieProductId', '');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_rows jsonb;
  v_total integer;
  v_summary jsonb;
begin
  if v_status not in ('open', 'resolved', 'all') or v_page < -1 or v_page > 1000
     or (v_severity is not null and v_severity not in ('alta', 'media', 'baixa', 'info'))
     or (v_kind is not null and v_kind !~ '^[a-z_]{3,40}$') or length(coalesce(v_search, '')) > 120
     or (v_omie is not null and v_omie !~ '^[^:]{1,40}$') then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  if v_page = -1 and not (v_caps->>'export')::boolean then
    raise exception 'Você não pode exportar o estoque.' using errcode = '42501';
  end if;
  with cur as (
    select ic.company_id, ic.run_id, r.started_at from private.intel_current ic
    join private.intel_runs r on r.id = ic.run_id where ic.company_id = any(v_companies)),
  a as (
    select t, c.name as company_name, cur.run_id, cur.started_at,
      coalesce(pm.sku, pr.sku) as sku, coalesce(pm.name, pr.name) as name, pm.metrics->'curve'->>'current' as curve
    from private.intel_alerts t
    join public.companies c on c.id = t.company_id
    left join cur on cur.company_id = t.company_id
    left join private.intel_product_metrics pm
      on pm.run_id = cur.run_id and pm.company_id = t.company_id and pm.omie_product_id = t.omie_product_id
    left join lateral (select p.sku, p.name from public.products p
                       where p.company_id = t.company_id and p.source = 'omie' and p.external_id = t.omie_product_id
                       limit 1) pr on true
    where t.company_id = any(v_companies) and (v_cost or not t.requires_cost)
      and (v_status = 'all' or t.status = v_status)
      and (v_severity is null or t.severity = v_severity) and (v_kind is null or t.kind = v_kind)
      and (v_omie is null or t.omie_product_id = v_omie)
      and (not v_only_new or (t.status = 'open' and (t.first_run is not distinct from cur.run_id
                                                     or t.changed_at >= cur.started_at)))
      and (v_search is null or coalesce(pm.sku, pr.sku) ilike '%' || v_search || '%'
           or coalesce(pm.name, pr.name) ilike '%' || v_search || '%')),
  o as (
    select a.*, count(*) over () as total_count,
      row_number() over (order by stock_internal.intel_severity_rank((a.t).severity), (a.t).changed_at desc,
                         a.company_name, a.sku, (a.t).kind) as rn
    from a)
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(stock_internal.intel_alert_json(o.t, v_cost, o.run_id, o.started_at)
      || jsonb_build_object('companyName', o.company_name, 'sku', o.sku, 'name', o.name, 'curve', o.curve) order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 50 and o.rn <= (v_page + 1) * 50)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  if v_page = -1 and v_total > 20000 then
    raise exception 'A exportação vai até 20.000 linhas. Refine os filtros.' using errcode = 'P0001';
  end if;
  select jsonb_build_object(
    'open', count(*), 'alta', count(*) filter (where t.severity = 'alta'),
    'media', count(*) filter (where t.severity = 'media'), 'baixa', count(*) filter (where t.severity = 'baixa'),
    'info', count(*) filter (where t.severity = 'info'),
    'new', count(*) filter (where t.first_run is not distinct from ic.run_id),
    'changed', count(*) filter (where t.first_run is distinct from ic.run_id and t.changed_at >= r.started_at),
    'acknowledged', count(*) filter (where t.acknowledged_at is not null))
  into v_summary
  from private.intel_alerts t
  left join private.intel_current ic on ic.company_id = t.company_id
  left join private.intel_runs r on r.id = ic.run_id
  where t.company_id = any(v_companies) and t.status = 'open' and (v_cost or not t.requires_cost);
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'summary', v_summary);
end $$;

-- "Estou ciente": quem classifica curvas registra a ciência (com observação opcional), na auditoria.
-- Não muda o alerta; ele continua aberto até a regra deixar de encontrar o problema.
create or replace function stock_internal.intel_alert_ack(p_alert uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('classify');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_alert private.intel_alerts;
begin
  if v_note is not null and length(v_note) > 300 then
    raise exception 'A observação vai até 300 caracteres.' using errcode = 'P0001';
  end if;
  select * into v_alert from private.intel_alerts t where t.id = p_alert and t.status = 'open' for update;
  if not found or not (v_alert.company_id = any(stock_internal.scope('all')))
     or (v_alert.requires_cost and not v_cost) then
    raise exception 'Alerta inexistente ou já resolvido.' using errcode = 'P0001';
  end if;
  update private.intel_alerts set acknowledged_by = auth.uid(), acknowledged_at = clock_timestamp(), acknowledged_note = v_note
   where id = p_alert;
  perform stock_internal.log('stock.intel.alert_ack', v_alert.company_id, jsonb_build_object(
    'alertId', p_alert, 'kind', v_alert.kind, 'omieProductId', v_alert.omie_product_id,
    'severity', v_alert.severity, 'note', v_note));
  return jsonb_build_object('acknowledged', true, 'alertId', p_alert);
end $$;

create or replace function public.stock_intel_alerts(p_query jsonb)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_alerts(p_query) $$;
create or replace function public.stock_intel_alert_ack(p_alert uuid, p_note text default null)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_alert_ack(p_alert, p_note) $$;

revoke all on function stock_internal.intel_severity_rank(text), stock_internal.intel_mask_items(jsonb),
  stock_internal.intel_alert_json(private.intel_alerts, boolean, uuid, timestamptz),
  stock_internal.intel_alerts(jsonb), stock_internal.intel_alert_ack(uuid, text) from public, anon, authenticated;
grant execute on function stock_internal.intel_alerts(jsonb), stock_internal.intel_alert_ack(uuid, text) to authenticated;
revoke all on function public.stock_intel_alerts(jsonb), public.stock_intel_alert_ack(uuid, text)
  from public, anon, authenticated;
grant execute on function public.stock_intel_alerts(jsonb), public.stock_intel_alert_ack(uuid, text) to authenticated;
notify pgrst, 'reload schema';
