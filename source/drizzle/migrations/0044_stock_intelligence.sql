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
  insert into private.intel_runs (trigger, algorithm_version, as_of) values (p_trigger, p_version, v_as_of)
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
  update private.intel_runs set status = 'published', finished_at = now(), stats = p_stats where id = v_run.id;
  delete from private.intel_runs r
   where r.started_at < now() - make_interval(days => v_keep)
     and not exists (select 1 from private.intel_current c where c.run_id = r.id);
  return jsonb_build_object('published', true, 'companies', v_companies);
end $$;

create or replace function stock_internal.intel_fail(p_run uuid, p_error text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  -- Só uma execução ainda em andamento falha; uma já publicada nunca perde os resultados.
  update private.intel_runs set status = 'failed', finished_at = now(), error = left(coalesce(p_error, 'falha'), 300)
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

-- ===================================================================== wrappers e permissões

create or replace function public.stock_intel_begin(p_trigger text, p_version text, p_force boolean default false)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_begin(p_trigger, p_version, p_force) $$;
create or replace function public.stock_intel_extract(p_run uuid, p_company uuid)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_extract(p_run, p_company) $$;
create or replace function public.stock_intel_publish(p_run uuid, p_company uuid, p_chunk integer, p_rows jsonb)
returns integer language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_publish(p_run, p_company, p_chunk, p_rows) $$;
create or replace function public.stock_intel_finish(p_run uuid, p_stats jsonb)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_finish(p_run, p_stats) $$;
create or replace function public.stock_intel_fail(p_run uuid, p_error text)
returns void language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_fail(p_run, p_error) $$;
create or replace function public.stock_intel_status()
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_status() $$;

revoke all on function stock_internal.intel_params(), stock_internal.intel_capture(uuid),
  stock_internal.intel_begin(text, text, boolean), stock_internal.intel_running(uuid),
  stock_internal.intel_extract(uuid, uuid), stock_internal.intel_publish(uuid, uuid, integer, jsonb),
  stock_internal.intel_finish(uuid, jsonb), stock_internal.intel_fail(uuid, text),
  stock_internal.intel_set_enabled(boolean), stock_internal.intel_status() from public, anon, authenticated;
grant execute on function stock_internal.intel_params(), stock_internal.intel_capture(uuid),
  stock_internal.intel_begin(text, text, boolean), stock_internal.intel_running(uuid),
  stock_internal.intel_extract(uuid, uuid), stock_internal.intel_publish(uuid, uuid, integer, jsonb),
  stock_internal.intel_finish(uuid, jsonb), stock_internal.intel_fail(uuid, text),
  stock_internal.intel_set_enabled(boolean) to service_role;
grant execute on function stock_internal.intel_status() to authenticated;

revoke all on function public.stock_intel_begin(text, text, boolean), public.stock_intel_extract(uuid, uuid),
  public.stock_intel_publish(uuid, uuid, integer, jsonb), public.stock_intel_finish(uuid, jsonb),
  public.stock_intel_fail(uuid, text), public.stock_intel_status() from public, anon, authenticated;
grant execute on function public.stock_intel_begin(text, text, boolean), public.stock_intel_extract(uuid, uuid),
  public.stock_intel_publish(uuid, uuid, integer, jsonb), public.stock_intel_finish(uuid, jsonb),
  public.stock_intel_fail(uuid, text) to service_role;
grant execute on function public.stock_intel_status() to authenticated;
