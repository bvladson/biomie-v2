-- 0044: Estoque — BIOMIE Intelligence, fase 1 (fundação).
--
-- O motor analítico em Python roda num contêiner avulso, fora das requisições da tela e com limite de
-- CPU e memória. Ele lê os dados já consolidados no BIOMIE por funções protegidas (só service_role) e
-- grava os indicadores de cada produto numa execução que só passa a valer quando termina inteira:
-- todas as empresas trocam juntas de execução, e uma falha mantém a anterior.
-- Fotos diárias do estoque por curva e o histórico de mudança de curva formam a série real a partir
-- desta migração; nada do passado é fabricado.
-- Somente acréscimos: nenhuma tabela, coluna ou função existente muda. Curvas oficiais, saldos,
-- vendas, documentos e movimentações são só lidos. O motor nunca chama o Omie.

-- ===================================================================== configuração

create table if not exists private.intel_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  params jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into private.intel_settings (id) values (true) on conflict (id) do nothing;

-- Parâmetros documentados (valores padrão + o que estiver gravado em intel_settings.params).
--   minHistoryDays       histórico mínimo de vendas para tendência e giro confiáveis
--   lowTurnoverAnnual    giro anual estimado abaixo disto = baixo giro
--   excessCoverageDays   cobertura acima disto = possível excesso
--   obsolescenceDays     sem venda há pelo menos isto, com histórico que cobre o período = possível obsolescência
--   ruptureCoverageDays  cobertura abaixo disto = risco de ruptura (prazo de fornecedor ainda não informado)
--   trendDeclinePct      variação dos últimos 60 dias contra os 60 anteriores abaixo disto = demanda em queda
--   costSuspectMax       custo médio unitário até este valor = custo provisório (sinalizado, não descartado)
--   runsKeptDays         execuções antigas guardadas para comparação
--   priorityWeights      pesos do índice de prioridade (soma 1; ordenação, não probabilidade)
create or replace function stock_internal.intel_params() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'minHistoryDays', 120, 'lowTurnoverAnnual', 1.0, 'excessCoverageDays', 180, 'obsolescenceDays', 365,
    'ruptureCoverageDays', 15, 'trendDeclinePct', -30, 'costSuspectMax', 1.00, 'runsKeptDays', 14,
    'priorityWeights', jsonb_build_object('capital', 0.4, 'idle', 0.3, 'coverage', 0.15, 'trend', 0.15))
    || coalesce((select s.params from private.intel_settings s where s.id), '{}'::jsonb)
$$;

-- ===================================================================== tabelas

-- Uma execução do motor: só é "published" quando todas as empresas foram gravadas.
create table if not exists private.intel_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('schedule', 'ops', 'test')),
  algorithm_version text not null,
  status text not null default 'running' check (status in ('running', 'published', 'failed', 'abandoned')),
  as_of date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb,
  error text
);
create index if not exists intel_runs_status on private.intel_runs (status, started_at desc);

-- Indicadores por produto e empresa numa execução (valores ausentes ficam null, nunca zero).
create table if not exists private.intel_product_metrics (
  run_id uuid not null references private.intel_runs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  omie_product_id text not null,
  product_id uuid,
  sku text,
  name text,
  family text,
  state text not null check (state in ('novo', 'historico_insuficiente', 'sem_venda_janela', 'baixo_giro',
    'possivel_excesso', 'possivel_obsolescencia', 'saudavel', 'risco_ruptura', 'sem_saldo')),
  flags text[] not null default '{}',
  priority numeric check (priority is null or (priority >= 0 and priority <= 100)),
  priority_parts jsonb,
  metrics jsonb not null,
  primary key (run_id, company_id, omie_product_id)
);
create index if not exists intel_product_metrics_priority
  on private.intel_product_metrics (run_id, company_id, priority desc nulls last);

-- Execução que vale hoje para cada empresa (trocada de uma vez no fim da execução).
create table if not exists private.intel_current (
  company_id uuid primary key references public.companies(id) on delete cascade,
  run_id uuid not null references private.intel_runs(id),
  published_at timestamptz not null default now()
);

-- Foto diária do estoque por curva de 12 meses (dia = data da posição publicada).
create table if not exists private.stock_snapshots (
  company_id uuid not null references public.companies(id) on delete cascade,
  day date not null,
  reading_id uuid,
  totals jsonb not null,
  captured_at timestamptz not null default now(),
  primary key (company_id, day)
);

-- Histórico da curva efetiva (12 meses) por produto: uma linha quando a curva muda (e a primeira).
create table if not exists private.stock_curve_history (
  company_id uuid not null references public.companies(id) on delete cascade,
  omie_product_id text not null,
  day date not null,
  curve text not null check (curve in ('A', 'B', 'C', 'D')),
  source text not null,
  primary key (company_id, omie_product_id, day)
);

revoke all on private.intel_settings, private.intel_runs, private.intel_product_metrics, private.intel_current,
  private.stock_snapshots, private.stock_curve_history from public, anon, authenticated;

-- ===================================================================== fotos e histórico

-- Foto do dia e mudanças de curva de uma empresa, a partir da posição publicada e das curvas atuais.
-- Idempotente no mesmo dia (a última chamada do dia vale).
create or replace function stock_internal.intel_capture(p_company uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_reading uuid;
  v_day date;
  v_totals jsonb;
  v_changed integer;
begin
  select sc.reading_id, r.position_date into v_reading, v_day
    from private.stock_current sc join private.stock_readings r on r.id = sc.reading_id
    where sc.company_id = p_company;
  if v_reading is null then
    return jsonb_build_object('captured', false);
  end if;
  create temporary table if not exists pg_temp.intel_cap (
    omie_product_id text primary key, curve text, source text, qty numeric, pos_value numeric,
    neg_value numeric, positions integer, revenue numeric) on commit drop;
  delete from pg_temp.intel_cap;
  insert into pg_temp.intel_cap
  select x.omie_product_id, min(x.curve), min(x.curve_source), sum(x.physical_qty),
    sum(x.physical_qty * x.unit_cost) filter (where x.physical_qty > 0),
    sum(x.physical_qty * x.unit_cost) filter (where x.physical_qty < 0), count(*)::integer, max(x.window_revenue)
  from stock_internal.current_rows(array[p_company], '12m') x
  group by x.omie_product_id;

  select jsonb_object_agg(k.curve, jsonb_build_object(
      'products', coalesce(a.products, 0), 'qty', coalesce(a.qty, 0),
      'capital', coalesce(a.capital, 0), 'negative', coalesce(a.negative, 0),
      'negativePositions', coalesce(a.neg_products, 0)))
    into v_totals
  from unnest(array['A', 'B', 'C', 'D', 'U']) k(curve)
  left join (select c.curve, count(*) filter (where c.qty > 0) as products,
               round(coalesce(sum(c.qty) filter (where c.qty > 0), 0), 3) as qty,
               round(coalesce(sum(c.pos_value), 0), 2) as capital, round(coalesce(sum(c.neg_value), 0), 2) as negative,
               count(*) filter (where c.qty < 0) as neg_products
             from pg_temp.intel_cap c group by c.curve) a on a.curve = k.curve;
  insert into private.stock_snapshots (company_id, day, reading_id, totals)
    values (p_company, v_day, v_reading, v_totals)
  on conflict (company_id, day) do update
    set reading_id = excluded.reading_id, totals = excluded.totals, captured_at = now();

  -- Mudanças de curva: relevantes = com saldo ou com venda em 12 meses (curva A a D).
  delete from private.stock_curve_history h where h.company_id = p_company and h.day = v_day;
  insert into private.stock_curve_history (company_id, omie_product_id, day, curve, source)
  select p_company, c.omie_product_id, v_day, c.curve, c.source
  from pg_temp.intel_cap c
  left join lateral (select h.curve from private.stock_curve_history h
                     where h.company_id = p_company and h.omie_product_id = c.omie_product_id and h.day < v_day
                     order by h.day desc limit 1) last on true
  where c.curve in ('A', 'B', 'C', 'D') and (c.qty <> 0 or coalesce(c.revenue, 0) > 0)
    and last.curve is distinct from c.curve;
  get diagnostics v_changed = row_count;
  return jsonb_build_object('captured', true, 'day', v_day, 'curveChanges', v_changed);
end $$;

-- ===================================================================== motor (service_role)

-- Começa uma execução: uma por vez; desligado não roda (a não ser forçado pela operação).
create or replace function stock_internal.intel_begin(p_trigger text, p_version text, p_force boolean)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run uuid;
  v_as_of date := stock_internal.as_of();
begin
  if p_trigger not in ('schedule', 'ops', 'test') or coalesce(p_version, '') !~ '^[0-9A-Za-z._-]{1,40}$' then
    raise exception 'Pedido de execução inválido.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('stock_intel'));
  if not coalesce((select s.enabled from private.intel_settings s where s.id), false)
     and not coalesce(p_force, false) then
    return jsonb_build_object('started', false, 'reason', 'Motor de inteligência desligado.');
  end if;
  update private.intel_runs set status = 'abandoned', finished_at = now(),
         error = 'Execução sem conclusão em 2 horas.'
   where status = 'running' and started_at < now() - interval '2 hours';
  if exists (select 1 from private.intel_runs r where r.status = 'running') then
    return jsonb_build_object('started', false, 'reason', 'Já existe uma execução em andamento.');
  end if;
  -- clock_timestamp: horário real do pedido (now() é o mesmo em toda a transação), para "a última
  -- execução" ser sempre uma só.
  insert into private.intel_runs (trigger, algorithm_version, as_of, started_at)
    values (p_trigger, p_version, v_as_of, clock_timestamp())
    returning id into v_run;
  return jsonb_build_object('started', true, 'runId', v_run, 'asOf', v_as_of,
    'params', stock_internal.intel_params(),
    'newProductDays', (select s.new_product_days from private.stock_settings s),
    'companies', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name)
                    order by c.name), '[]'::jsonb)
                  from public.companies c join private.stock_current sc on sc.company_id = c.id
                  where not c.is_demo));
end $$;

create or replace function stock_internal.intel_running(p_run uuid) returns private.intel_runs
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v private.intel_runs;
begin
  select * into v from private.intel_runs r where r.id = p_run;
  if v.id is null or v.status <> 'running' then
    raise exception 'Execução inexistente ou encerrada.' using errcode = 'P0001';
  end if;
  return v;
end $$;

-- Dados consolidados de uma empresa para o motor (fotografa o dia antes de ler).
create or replace function stock_internal.intel_extract(p_run uuid, p_company uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
  v_as_of date := v_run.as_of;
  v_capture jsonb;
  v jsonb;
begin
  if not exists (select 1 from public.companies c where c.id = p_company and not c.is_demo) then
    raise exception 'Empresa inválida para a inteligência do estoque.' using errcode = 'P0001';
  end if;
  v_capture := stock_internal.intel_capture(p_company);
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
  h as (
    select hh.omie_product_id, hh.curve, hh.day
    from (select c.*, row_number() over (partition by c.omie_product_id order by c.day desc) as rn
          from private.stock_curve_history c where c.company_id = p_company) hh
    where hh.rn <= 2)
  select jsonb_build_object(
    'companyId', p_company, 'asOf', v_as_of,
    'salesFrom', stock_internal.sales_from(p_company, v_as_of),
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
        'elsewhereLastSale', p.elsewhere_last_sale) order by p.omie_product_id)
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

-- Grava um lote de resultados de uma empresa (lote 0 limpa o que a mesma execução gravou antes).
create or replace function stock_internal.intel_publish(p_run uuid, p_company uuid, p_chunk integer, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
  v_count integer;
begin
  if p_chunk is null or p_chunk < 0 or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Lote de resultados inválido.' using errcode = 'P0001';
  end if;
  if p_chunk = 0 then
    delete from private.intel_product_metrics m where m.run_id = v_run.id and m.company_id = p_company;
  end if;
  insert into private.intel_product_metrics (run_id, company_id, omie_product_id, product_id, sku, name, family,
    state, flags, priority, priority_parts, metrics)
  select v_run.id, p_company, r->>'omieProductId',
    case when r->>'productId' ~ '^[0-9a-fA-F-]{36}$' then (r->>'productId')::uuid end,
    left(r->>'sku', 120), left(r->>'name', 300), left(r->>'family', 120), r->>'state',
    coalesce(array(select jsonb_array_elements_text(coalesce(r->'flags', '[]'::jsonb))), '{}'),
    (r->>'priority')::numeric, r->'priorityParts', coalesce(r->'metrics', '{}'::jsonb)
  from jsonb_array_elements(p_rows) r
  -- Repetir um lote (nova tentativa depois de uma falha de rede) substitui, não duplica.
  on conflict (run_id, company_id, omie_product_id) do update
    set product_id = excluded.product_id, sku = excluded.sku, name = excluded.name, family = excluded.family,
        state = excluded.state, flags = excluded.flags, priority = excluded.priority,
        priority_parts = excluded.priority_parts, metrics = excluded.metrics;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Encerra: só agora as empresas passam a ver esta execução (todas juntas); guarda as recentes.
create or replace function stock_internal.intel_finish(p_run uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
  v_companies integer;
  v_keep integer := coalesce((stock_internal.intel_params()->>'runsKeptDays')::integer, 14);
begin
  insert into private.intel_current (company_id, run_id, published_at)
  select distinct m.company_id, v_run.id, now() from private.intel_product_metrics m where m.run_id = v_run.id
  on conflict (company_id) do update set run_id = excluded.run_id, published_at = excluded.published_at;
  get diagnostics v_companies = row_count;
  update private.intel_runs set status = 'published', finished_at = clock_timestamp(), stats = p_stats where id = v_run.id;
  delete from private.intel_runs r
   where r.started_at < now() - make_interval(days => v_keep)
     and not exists (select 1 from private.intel_current c where c.run_id = r.id);
  return jsonb_build_object('published', true, 'companies', v_companies);
end $$;

create or replace function stock_internal.intel_fail(p_run uuid, p_error text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  -- Só uma execução ainda em andamento falha; uma já publicada nunca perde os resultados.
  update private.intel_runs set status = 'failed', finished_at = clock_timestamp(), error = left(coalesce(p_error, 'falha'), 300)
   where id = p_run and status = 'running';
  if found then
    delete from private.intel_product_metrics m where m.run_id = p_run;
  end if;
end $$;

-- Liga/desliga o motor (operação); fica na Auditoria.
create or replace function stock_internal.intel_set_enabled(p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_before boolean;
begin
  select s.enabled into v_before from private.intel_settings s where s.id;
  update private.intel_settings set enabled = coalesce(p_enabled, false), updated_at = now(), updated_by = auth.uid()
   where id;
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (auth.uid(), 'stock.intel.enabled', 'stock', null,
          jsonb_build_object('before', v_before, 'after', coalesce(p_enabled, false), 'origin', 'ops'));
  return jsonb_build_object('enabled', coalesce(p_enabled, false), 'before', v_before);
end $$;

-- ===================================================================== leitura pela tela

-- Situação do motor (quem pode ver o Estoque vê; detalhes de erro só para o Super admin).
create or replace function stock_internal.intel_status() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_super boolean := stock_internal.is_super();
begin
  return jsonb_build_object(
    'enabled', (select s.enabled from private.intel_settings s where s.id),
    'lastRun', (select jsonb_build_object('status', r.status, 'asOf', r.as_of, 'startedAt', r.started_at,
                  'finishedAt', r.finished_at, 'version', r.algorithm_version,
                  'error', case when v_super then r.error end)
                from private.intel_runs r order by r.started_at desc limit 1),
    'current', (select coalesce(jsonb_agg(jsonb_build_object('companyId', c.company_id, 'runId', c.run_id,
                  'publishedAt', c.published_at, 'asOf', r.as_of)), '[]'::jsonb)
                from private.intel_current c join private.intel_runs r on r.id = c.run_id
                where c.company_id = any(stock_internal.scope('all'))));
end $$;

-- Faixa de tempo sem venda (radar do capital parado), mutuamente exclusivas:
--   dias contados da última venda; produto sem venda no histórico conta desde o início do histórico
--   de vendas ou da chegada (o mais recente: é um piso, pode ser mais); "insuficiente" = produto novo,
--   sem a contagem, ou sem venda observado há menos de 30 dias.
create or replace function stock_internal.intel_band(p_days integer, p_last_sale date, p_state text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case
    when p_state = 'novo' or p_days is null or (p_last_sale is null and p_days < 30) then 'insuficiente'
    when p_days <= 30 then '0-30' when p_days <= 60 then '31-60' when p_days <= 90 then '61-90'
    when p_days <= 180 then '91-180' when p_days <= 365 then '181-365' else '365+' end
$$;

-- Custo e faturamento só para quem pode vê-los: tira esses campos dos indicadores gravados.
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
                                from jsonb_array_elements(p_metrics->'salesMonthly') x), '[]'::jsonb))
  end
$$;

-- Painel da inteligência: cards e distribuição ABCD da janela escolhida (posição publicada + curvas já
-- calculadas, sem recalcular nada), evolução das fotos diárias, radar, estados e prioridades da última
-- execução publicada. Capital = saldos positivos; negativos ficam à parte.
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
                    'capital', case when v_cost then round(b.capital, 2) end, 'unknownCost', b.unknown_cost))
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
              'state', t.state, 'flags', to_jsonb(t.flags), 'priority', t.priority,
              'capital', case when v_cost then t.capital end, 'daysWithoutSale', t.metrics->'daysWithoutSale',
              'coverageDays', t.metrics->'coverageDays') order by t.priority desc nulls last), '[]')
            from (select * from mm where mm.priority is not null order by mm.priority desc limit 10) t))
  into v;
  return v;
end $$;

-- Produtos analisados (tabela de oportunidades e riscos): filtros, ordenação e páginas de 50;
-- página -1 = todas as linhas do filtro para exportação (só com a permissão de exportar).
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
      'state', o.state, 'flags', to_jsonb(o.flags), 'band', o.band, 'priority', o.priority,
      'priorityParts', o.priority_parts) order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 50 and o.rn <= (v_page + 1) * 50)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  if v_page = -1 and v_total > 20000 then
    raise exception 'A exportação vai até 20.000 linhas. Refine os filtros.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('rows', v_rows, 'total', v_total);
end $$;

-- Inteligência de um produto: indicadores completos da última execução, histórico de curva e execução.
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
    'flags', to_jsonb(x.flags), 'priority', x.priority, 'priorityParts', x.priority_parts,
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

-- Pareto do faturamento da janela (curvas oficiais já calculadas) de UMA empresa, para quem vê custo.
create or replace function stock_internal.intel_pareto(p_company text, p_window text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('viewCost');
  v_companies uuid[] := stock_internal.scope(p_company);
  v_window text := stock_internal.pick_window(p_window);
begin
  if array_length(v_companies, 1) is distinct from 1 or p_company = 'all' then
    raise exception 'Escolha uma empresa: a curva é calculada por empresa.' using errcode = 'P0001';
  end if;
  return (select jsonb_build_object(
    'window', v_window, 'companyId', v_companies[1],
    'total', coalesce(round(sum(a.revenue), 2), 0), 'limits', jsonb_build_array(
      (select s.curve_a_limit from private.stock_settings s), (select s.curve_b_limit from private.stock_settings s)),
    'rows', coalesce(jsonb_agg(jsonb_build_array(a.rank, a.omie_product_id, a.sku, coalesce(p.name, a.sku),
              round(a.revenue, 2), round(a.share, 6), round(a.cumulative_before + a.share, 6), a.curve, m.curve)
              order by a.rank), '[]'::jsonb))
    from private.stock_auto_curves a
    left join public.products p on p.id = a.product_id
    left join private.stock_curves m on m.company_id = a.company_id and m.omie_product_id = a.omie_product_id
    where a.company_id = v_companies[1] and a.curve_window = v_window);
end $$;

-- ===================================================================== wrappers e permissões
-- Motor (service_role): SECURITY DEFINER no esquema public, como as funções do worker do estoque
-- (0041) — o service_role não tem acesso ao esquema stock_internal. Só o service_role executa.
-- Telas (authenticated): wrappers comuns; as regras ficam nas funções stock_internal.

create or replace function public.stock_intel_begin(p_trigger text, p_version text, p_force boolean default false)
returns jsonb language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_begin(p_trigger, p_version, p_force) $$;
create or replace function public.stock_intel_extract(p_run uuid, p_company uuid)
returns jsonb language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_extract(p_run, p_company) $$;
create or replace function public.stock_intel_publish(p_run uuid, p_company uuid, p_chunk integer, p_rows jsonb)
returns integer language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_publish(p_run, p_company, p_chunk, p_rows) $$;
create or replace function public.stock_intel_finish(p_run uuid, p_stats jsonb)
returns jsonb language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_finish(p_run, p_stats) $$;
create or replace function public.stock_intel_fail(p_run uuid, p_error text)
returns void language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_fail(p_run, p_error) $$;
create or replace function public.stock_intel_status()
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_status() $$;
create or replace function public.stock_intel_overview(p_company text, p_window text default null)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_overview(p_company, p_window) $$;
create or replace function public.stock_intel_products(p_query jsonb)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_products(p_query) $$;
create or replace function public.stock_intel_product(p_company text, p_omie text)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_product(p_company, p_omie) $$;
create or replace function public.stock_intel_pareto(p_company text, p_window text default null)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_pareto(p_company, p_window) $$;

revoke all on function stock_internal.intel_params(), stock_internal.intel_capture(uuid),
  stock_internal.intel_begin(text, text, boolean), stock_internal.intel_running(uuid),
  stock_internal.intel_extract(uuid, uuid), stock_internal.intel_publish(uuid, uuid, integer, jsonb),
  stock_internal.intel_finish(uuid, jsonb), stock_internal.intel_fail(uuid, text),
  stock_internal.intel_set_enabled(boolean), stock_internal.intel_status(),
  stock_internal.intel_band(integer, date, text), stock_internal.intel_mask(jsonb, boolean),
  stock_internal.intel_overview(text, text), stock_internal.intel_products(jsonb),
  stock_internal.intel_product(text, text), stock_internal.intel_pareto(text, text) from public, anon, authenticated;
grant execute on function stock_internal.intel_params(), stock_internal.intel_capture(uuid),
  stock_internal.intel_begin(text, text, boolean), stock_internal.intel_running(uuid),
  stock_internal.intel_extract(uuid, uuid), stock_internal.intel_publish(uuid, uuid, integer, jsonb),
  stock_internal.intel_finish(uuid, jsonb), stock_internal.intel_fail(uuid, text),
  stock_internal.intel_set_enabled(boolean) to service_role;
grant execute on function stock_internal.intel_status(), stock_internal.intel_overview(text, text),
  stock_internal.intel_products(jsonb), stock_internal.intel_product(text, text),
  stock_internal.intel_pareto(text, text) to authenticated;

revoke all on function public.stock_intel_begin(text, text, boolean), public.stock_intel_extract(uuid, uuid),
  public.stock_intel_publish(uuid, uuid, integer, jsonb), public.stock_intel_finish(uuid, jsonb),
  public.stock_intel_fail(uuid, text), public.stock_intel_status(), public.stock_intel_overview(text, text),
  public.stock_intel_products(jsonb), public.stock_intel_product(text, text), public.stock_intel_pareto(text, text)
  from public, anon, authenticated;
grant execute on function public.stock_intel_begin(text, text, boolean), public.stock_intel_extract(uuid, uuid),
  public.stock_intel_publish(uuid, uuid, integer, jsonb), public.stock_intel_finish(uuid, jsonb),
  public.stock_intel_fail(uuid, text) to service_role;
grant execute on function public.stock_intel_status(), public.stock_intel_overview(text, text),
  public.stock_intel_products(jsonb), public.stock_intel_product(text, text), public.stock_intel_pareto(text, text)
  to authenticated;
