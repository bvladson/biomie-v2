-- 0048: Inteligência do Estoque — fase 5 (Reposição Inteligente, oportunidades entre empresas e base de
-- preço para o simulador). Aditiva e consultiva: o BIOMIE não cria pedido de compra, não transfere
-- estoque e não muda preço nenhum; nada aqui escreve no Omie.
-- - Parâmetros de reposição (prazo do fornecedor, ciclo de revisão, nível de serviço, lote mínimo e
--   cobertura máxima) por empresa, família ou produto, definidos só por quem classifica curvas, com
--   justificativa e auditoria (valores anteriores e novos). Sem prazo informado, o motor não sugere
--   quantidade (nunca inventa o prazo).
-- - O motor (intel-1.2) lê os parâmetros no início (stock_intel_planning), calcula a reposição de cada
--   produto (biomie_intel/replenishment.py) e, numa execução com todas as empresas, grava as
--   oportunidades entre empresas (mesma SKU com sobra numa e falta noutra), que só valem enquanto aquela
--   execução é a publicada das duas empresas.
-- - Telas: lista da reposição (comprar / não comprar / aguardar / sem prazo / sem previsão), parâmetros,
--   oportunidades (só quando o usuário acessa as duas empresas) e preço médio vendido em 12 meses para o
--   simulador. Custo estimado e valor a custo só para quem vê custo.
-- Retorno: as funções novas ficam sem uso sem esta release; a máscara volta ao corpo da 0047.

-- ===================================================================== tabelas

create table if not exists private.intel_replenishment_params (
  company_id uuid not null references public.companies(id) on delete cascade,
  scope text not null check (scope in ('empresa', 'familia', 'produto')),
  scope_key text not null default '',
  lead_time_days integer not null check (lead_time_days between 1 and 365),
  review_days integer not null default 30 check (review_days between 1 and 180),
  service_level numeric not null default 0.90 check (service_level in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99)),
  min_lot numeric check (min_lot is null or (min_lot > 0 and min_lot <= 1000000)),
  max_coverage_days integer check (max_coverage_days is null or max_coverage_days between 7 and 730),
  reason text not null,
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (company_id, scope, scope_key),
  check ((scope = 'empresa') = (scope_key = ''))
);

create table if not exists private.intel_opportunities (
  run_id uuid not null references private.intel_runs(id) on delete cascade,
  sku text not null,
  from_company uuid not null references public.companies(id) on delete cascade,
  from_omie text not null,
  to_company uuid not null references public.companies(id) on delete cascade,
  to_omie text not null,
  qty numeric not null check (qty > 0),
  payload jsonb not null default '{}'::jsonb,
  primary key (run_id, from_company, from_omie, to_company, to_omie),
  check (from_company <> to_company)
);
revoke all on private.intel_replenishment_params, private.intel_opportunities from public, anon, authenticated, service_role;

-- ===================================================================== motor (service_role)

-- Parâmetros de reposição de todas as empresas reais, para a execução em andamento.
create or replace function stock_internal.intel_planning(p_run uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
begin
  return jsonb_build_object('runId', v_run.id, 'replenishment', coalesce((select jsonb_agg(jsonb_build_object(
      'companyId', p.company_id, 'scope', p.scope, 'key', p.scope_key, 'leadTimeDays', p.lead_time_days,
      'reviewDays', p.review_days, 'serviceLevel', p.service_level, 'minLot', p.min_lot,
      'maxCoverageDays', p.max_coverage_days) order by p.company_id, p.scope, p.scope_key)
    from private.intel_replenishment_params p
    join public.companies c on c.id = p.company_id and not c.is_demo), '[]'::jsonb));
end $$;

-- Grava um lote de oportunidades (lote 0 limpa o que a mesma execução gravou antes).
create or replace function stock_internal.intel_publish_opportunities(p_run uuid, p_chunk integer, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
  v_count integer;
begin
  if p_chunk is null or p_chunk < 0 or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Lote de oportunidades inválido.' using errcode = 'P0001';
  end if;
  if p_chunk = 0 then
    delete from private.intel_opportunities o where o.run_id = v_run.id;
  end if;
  insert into private.intel_opportunities (run_id, sku, from_company, from_omie, to_company, to_omie, qty, payload)
  select v_run.id, left(r->>'sku', 120), (r->>'fromCompanyId')::uuid, left(r->>'fromOmie', 40),
    (r->>'toCompanyId')::uuid, left(r->>'toOmie', 40), (r->>'qty')::numeric,
    r - array['sku', 'fromCompanyId', 'fromOmie', 'toCompanyId', 'toOmie', 'qty']
  from jsonb_array_elements(p_rows) r
  where exists (select 1 from public.companies c where c.id = (r->>'fromCompanyId')::uuid and not c.is_demo)
    and exists (select 1 from public.companies c where c.id = (r->>'toCompanyId')::uuid and not c.is_demo)
  on conflict (run_id, from_company, from_omie, to_company, to_omie) do update
    set sku = excluded.sku, qty = excluded.qty, payload = excluded.payload;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ===================================================================== máscara

-- 0047 + reposição sem o custo estimado para quem não vê custo.
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
      'alerts', stock_internal.intel_mask_items(p_metrics->'alerts'),
      'replenishment', coalesce(p_metrics->'replenishment', '{}'::jsonb) - 'costEstimate')
  end
$$;

-- ===================================================================== telas

-- Parâmetros de reposição das empresas do usuário (e se ele pode editar).
create or replace function stock_internal.intel_replenishment_params(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_companies uuid[] := stock_internal.scope(p_company);
begin
  return jsonb_build_object('canEdit', coalesce((v_caps->>'classify')::boolean, false),
    'serviceLevels', jsonb_build_array(0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'companyId', p.company_id, 'companyName', c.name, 'scope', p.scope, 'key', p.scope_key,
        'productName', pr.name, 'sku', pr.sku,
        'leadTimeDays', p.lead_time_days, 'reviewDays', p.review_days, 'serviceLevel', p.service_level,
        'minLot', p.min_lot, 'maxCoverageDays', p.max_coverage_days, 'reason', p.reason, 'updatedAt', p.updated_at,
        'updatedBy', (select coalesce(nullif(u.full_name, ''), 'Usuário') from public.profiles u where u.id = p.updated_by))
      order by c.name, case p.scope when 'empresa' then 1 when 'familia' then 2 else 3 end, p.scope_key)
      from private.intel_replenishment_params p
      join public.companies c on c.id = p.company_id
      left join lateral (select x.name, x.sku from public.products x
                         where p.scope = 'produto' and x.company_id = p.company_id and x.source = 'omie'
                           and x.external_id = p.scope_key limit 1) pr on true
      where p.company_id = any(v_companies)), '[]'::jsonb));
end $$;

-- Define (ou remove, com p_values nulo) o parâmetro de uma empresa, família ou produto.
create or replace function stock_internal.intel_set_replenishment(p_company text, p_scope text, p_key text,
  p_values jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('classify');
  v_companies uuid[] := stock_internal.scope(p_company);
  v_company uuid;
  v_key text := btrim(coalesce(p_key, ''));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_before private.intel_replenishment_params;
  v_lead integer; v_review integer; v_level numeric; v_lot numeric; v_max integer;
begin
  if array_length(v_companies, 1) is distinct from 1 then
    raise exception 'Escolha uma empresa: os parâmetros de reposição são por empresa.' using errcode = 'P0001';
  end if;
  v_company := v_companies[1];
  if p_scope is null or p_scope not in ('empresa', 'familia', 'produto')
     or (p_scope = 'empresa' and v_key <> '') or (p_scope <> 'empresa' and (v_key = '' or length(v_key) > 120)) then
    raise exception 'Parâmetro de reposição inválido.' using errcode = 'P0001';
  end if;
  if p_scope = 'produto' and not exists (
       select 1 from public.products x where x.company_id = v_company and x.source = 'omie' and x.external_id = v_key) then
    raise exception 'Produto não encontrado nesta empresa.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'Informe a justificativa (de 10 a 300 caracteres).' using errcode = 'P0001';
  end if;
  select * into v_before from private.intel_replenishment_params p
   where p.company_id = v_company and p.scope = p_scope and p.scope_key = v_key for update;
  if p_values is null or jsonb_typeof(p_values) = 'null' then
    delete from private.intel_replenishment_params p
     where p.company_id = v_company and p.scope = p_scope and p.scope_key = v_key;
    perform stock_internal.log('stock.intel.replenishment', v_company, jsonb_build_object(
      'change', 'remove', 'scope', p_scope, 'key', v_key, 'reason', v_reason,
      'before', case when v_before.company_id is not null then to_jsonb(v_before) - array['company_id', 'updated_by', 'updated_at'] end));
    return jsonb_build_object('removed', v_before.company_id is not null);
  end if;
  begin
    v_lead := (p_values->>'leadTimeDays')::integer;
    v_review := coalesce(nullif(p_values->>'reviewDays', '')::integer, 30);
    v_level := coalesce(nullif(p_values->>'serviceLevel', '')::numeric, 0.90);
    v_lot := nullif(p_values->>'minLot', '')::numeric;
    v_max := nullif(p_values->>'maxCoverageDays', '')::integer;
  exception when others then
    raise exception 'Parâmetro de reposição inválido.' using errcode = 'P0001';
  end;
  if v_lead is null or v_lead not between 1 and 365 or v_review not between 1 and 180
     or v_level not in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99)
     or (v_lot is not null and (v_lot <= 0 or v_lot > 1000000)) or (v_max is not null and v_max not between 7 and 730) then
    raise exception 'Prazo de 1 a 365 dias, revisão de 1 a 180, nível de serviço da lista, lote positivo e cobertura máxima de 7 a 730 dias.'
      using errcode = 'P0001';
  end if;
  insert into private.intel_replenishment_params as t (company_id, scope, scope_key, lead_time_days, review_days,
    service_level, min_lot, max_coverage_days, reason, updated_by, updated_at)
  values (v_company, p_scope, v_key, v_lead, v_review, v_level, v_lot, v_max, v_reason, auth.uid(), clock_timestamp())
  on conflict (company_id, scope, scope_key) do update set
    lead_time_days = excluded.lead_time_days, review_days = excluded.review_days, service_level = excluded.service_level,
    min_lot = excluded.min_lot, max_coverage_days = excluded.max_coverage_days, reason = excluded.reason,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform stock_internal.log('stock.intel.replenishment', v_company, jsonb_build_object(
    'change', case when v_before.company_id is null then 'create' else 'update' end, 'scope', p_scope, 'key', v_key,
    'reason', v_reason,
    'before', case when v_before.company_id is not null then to_jsonb(v_before) - array['company_id', 'updated_by', 'updated_at'] end,
    'after', jsonb_build_object('lead_time_days', v_lead, 'review_days', v_review, 'service_level', v_level,
                                'min_lot', v_lot, 'max_coverage_days', v_max)));
  return jsonb_build_object('saved', true);
end $$;

-- Reposição da última análise: comprar (padrão, mais urgentes primeiro), não comprar, aguardar, sem prazo,
-- sem previsão, sem demanda ou tudo. Custo estimado só para quem vê custo.
create or replace function stock_internal.intel_replenishment(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_companies uuid[] := stock_internal.scope(p_query->>'companyId');
  v_status text := coalesce(nullif(p_query->>'status', ''), 'comprar');
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_rows jsonb;
  v_total integer;
  v_summary jsonb;
begin
  if v_status not in ('comprar', 'nao_comprar', 'aguardar', 'sem_prazo', 'sem_previsao', 'sem_demanda', 'all')
     or v_page < -1 or v_page > 1000 or length(coalesce(v_search, '')) > 120 then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  if v_page = -1 and not (v_caps->>'export')::boolean then
    raise exception 'Você não pode exportar o estoque.' using errcode = '42501';
  end if;
  with mm as (
    select x.company_id, c.name as company_name, x.omie_product_id, x.sku, x.name, x.family, x.state,
      x.metrics->'curve'->>'current' as curve, x.metrics->'replenishment' as r, x.metrics->'stock' as st
    from private.intel_current ic
    join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
    join public.companies c on c.id = ic.company_id
    where ic.company_id = any(v_companies) and jsonb_typeof(x.metrics->'replenishment') = 'object'),
  f as (
    select mm.* from mm
    where (v_status = 'all' or mm.r->>'status' = v_status)
      and (v_search is null or mm.sku ilike '%' || v_search || '%' or mm.name ilike '%' || v_search || '%')),
  o as (
    select f.*, count(*) over () as total_count,
      row_number() over (order by case f.r->>'status' when 'comprar' then 1 when 'aguardar' then 2 when 'nao_comprar' then 3
                                    else 4 end,
                                  (f.r->>'coverageDays')::numeric - (f.r->>'leadTimeDays')::numeric asc nulls last,
                                  f.name, f.sku, f.company_name) as rn
    from f)
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'companyId', o.company_id, 'companyName', o.company_name, 'omieProductId', o.omie_product_id, 'sku', o.sku,
      'name', o.name, 'family', o.family, 'curve', o.curve, 'state', o.state,
      'available', o.st->'available', 'pending', o.st->'pending')
      || (case when v_cost then o.r else o.r - 'costEstimate' end) order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 50 and o.rn <= (v_page + 1) * 50)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  if v_page = -1 and v_total > 20000 then
    raise exception 'A exportação vai até 20.000 linhas. Refine os filtros.' using errcode = 'P0001';
  end if;
  select jsonb_build_object(
    'comprar', count(*) filter (where x.metrics->'replenishment'->>'status' = 'comprar'),
    'naoComprar', count(*) filter (where x.metrics->'replenishment'->>'status' = 'nao_comprar'),
    'aguardar', count(*) filter (where x.metrics->'replenishment'->>'status' = 'aguardar'),
    'semPrazo', count(*) filter (where x.metrics->'replenishment'->>'status' = 'sem_prazo'),
    'semPrevisao', count(*) filter (where x.metrics->'replenishment'->>'status' = 'sem_previsao'),
    'semDemanda', count(*) filter (where x.metrics->'replenishment'->>'status' = 'sem_demanda'),
    'costEstimate', case when v_cost then coalesce(sum((x.metrics->'replenishment'->>'costEstimate')::numeric)
                      filter (where x.metrics->'replenishment'->>'status' = 'comprar'), 0) end,
    'costEstimateMissing', count(*) filter (where x.metrics->'replenishment'->>'status' = 'comprar'
                                             and x.metrics->'replenishment'->>'costEstimate' is null))
  into v_summary
  from private.intel_current ic
  join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
  where ic.company_id = any(v_companies);
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'summary', v_summary);
end $$;

-- Oportunidades entre empresas da análise publicada das duas (só para quem acessa as duas empresas).
create or replace function stock_internal.intel_opportunities(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_all uuid[] := stock_internal.scope('all');
  v_company uuid;
  v_omie text := nullif(p_query->>'omieProductId', '');
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_rows jsonb;
  v_total integer;
begin
  if coalesce(nullif(p_query->>'companyId', ''), 'all') <> 'all' then
    v_company := (stock_internal.scope(p_query->>'companyId'))[1];
  end if;
  if v_page < -1 or v_page > 1000 or length(coalesce(v_search, '')) > 120
     or (v_omie is not null and (v_omie !~ '^[^:]{1,40}$' or v_company is null)) then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  if v_page = -1 and not (v_caps->>'export')::boolean then
    raise exception 'Você não pode exportar o estoque.' using errcode = '42501';
  end if;
  with o as (
    select op.*, cf.name as from_name, ct.name as to_name, count(*) over () as total_count,
      row_number() over (order by op.qty desc, op.sku, cf.name, ct.name) as rn
    from private.intel_opportunities op
    join private.intel_current icf on icf.company_id = op.from_company and icf.run_id = op.run_id
    join private.intel_current ict on ict.company_id = op.to_company and ict.run_id = op.run_id
    join public.companies cf on cf.id = op.from_company
    join public.companies ct on ct.id = op.to_company
    where op.from_company = any(v_all) and op.to_company = any(v_all)
      and (v_company is null or op.from_company = v_company or op.to_company = v_company)
      and (v_omie is null or (op.from_company = v_company and op.from_omie = v_omie)
           or (op.to_company = v_company and op.to_omie = v_omie))
      and (v_search is null or op.sku ilike '%' || v_search || '%' or op.payload->>'name' ilike '%' || v_search || '%'))
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object('sku', o.sku, 'qty', o.qty,
        'fromCompanyId', o.from_company, 'fromCompanyName', o.from_name, 'fromOmie', o.from_omie,
        'toCompanyId', o.to_company, 'toCompanyName', o.to_name, 'toOmie', o.to_omie)
      || (case when v_cost then o.payload else o.payload - 'valueAtCost' end) order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 50 and o.rn <= (v_page + 1) * 50)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  return jsonb_build_object('rows', v_rows, 'total', v_total,
    'note', 'Movimentação entre CNPJs pode exigir nota fiscal e processos fiscais e operacionais específicos. O BIOMIE não executa transferências.');
end $$;

-- Preço médio vendido em 12 meses (faturamento ÷ unidades da análise publicada), para o simulador usar
-- como base de preço explícita. Só para quem vê custo (a simulação inteira é de quem vê custo).
create or replace function stock_internal.intel_price_basis(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('viewCost');
  v_companies uuid[] := stock_internal.scope(p_company);
begin
  return jsonb_build_object(
    'asOf', (select max(r.as_of) from private.intel_current ic join private.intel_runs r on r.id = ic.run_id
             where ic.company_id = any(v_companies)),
    'prices', coalesce((select jsonb_agg(jsonb_build_array(x.company_id, x.omie_product_id, (x.metrics->>'avgPrice')::numeric,
                (x.metrics->'sales'->'d365'->>'units')::numeric) order by x.company_id, x.omie_product_id)
              from private.intel_current ic
              join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
              where ic.company_id = any(v_companies) and (x.metrics->>'avgPrice')::numeric > 0), '[]'::jsonb));
end $$;

-- Matriz risco × impacto: os 400 produtos de maior prioridade com capital (o eixo do impacto é o capital,
-- então só para quem vê custo). A prioridade é o índice documentado do motor, não probabilidade.
create or replace function stock_internal.intel_matrix(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('viewCost');
  v_companies uuid[] := stock_internal.scope(p_company);
begin
  return (select jsonb_build_object('total', count(*), 'points', coalesce(jsonb_agg(jsonb_build_array(
      t.company_id, t.omie_product_id, t.sku, t.name, t.capital, t.priority, t.state, t.curve)
      order by t.rn) filter (where t.rn <= 400), '[]'::jsonb))
    from (select x.company_id, x.omie_product_id, x.sku, x.name, (x.metrics->>'capital')::numeric as capital,
            x.priority, x.state, x.metrics->'curve'->>'current' as curve,
            row_number() over (order by x.priority desc, (x.metrics->>'capital')::numeric desc, x.omie_product_id) as rn
          from private.intel_current ic
          join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
          where ic.company_id = any(v_companies) and x.priority is not null
            and (x.metrics->>'capital')::numeric > 0) t);
end $$;

-- ===================================================================== entradas

create or replace function public.stock_intel_planning(p_run uuid)
returns jsonb language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_planning(p_run) $$;
create or replace function public.stock_intel_publish_opportunities(p_run uuid, p_chunk integer, p_rows jsonb)
returns integer language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_publish_opportunities(p_run, p_chunk, p_rows) $$;
create or replace function public.stock_intel_replenishment_params(p_company text)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_replenishment_params(p_company) $$;
create or replace function public.stock_intel_set_replenishment(p_company text, p_scope text, p_key text,
  p_values jsonb, p_reason text)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_set_replenishment(p_company, p_scope, p_key, p_values, p_reason) $$;
create or replace function public.stock_intel_replenishment(p_query jsonb)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_replenishment(p_query) $$;
create or replace function public.stock_intel_opportunities(p_query jsonb)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_opportunities(p_query) $$;
create or replace function public.stock_intel_price_basis(p_company text)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_price_basis(p_company) $$;
create or replace function public.stock_intel_matrix(p_company text)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_matrix(p_company) $$;

revoke all on function stock_internal.intel_planning(uuid), stock_internal.intel_publish_opportunities(uuid, integer, jsonb),
  stock_internal.intel_replenishment_params(text), stock_internal.intel_set_replenishment(text, text, text, jsonb, text),
  stock_internal.intel_replenishment(jsonb), stock_internal.intel_opportunities(jsonb), stock_internal.intel_price_basis(text),
  stock_internal.intel_matrix(text) from public, anon, authenticated;
grant execute on function stock_internal.intel_planning(uuid), stock_internal.intel_publish_opportunities(uuid, integer, jsonb)
  to service_role;
grant execute on function stock_internal.intel_replenishment_params(text),
  stock_internal.intel_set_replenishment(text, text, text, jsonb, text), stock_internal.intel_replenishment(jsonb),
  stock_internal.intel_opportunities(jsonb), stock_internal.intel_price_basis(text), stock_internal.intel_matrix(text)
  to authenticated;
revoke all on function public.stock_intel_planning(uuid), public.stock_intel_publish_opportunities(uuid, integer, jsonb),
  public.stock_intel_replenishment_params(text), public.stock_intel_set_replenishment(text, text, text, jsonb, text),
  public.stock_intel_replenishment(jsonb), public.stock_intel_opportunities(jsonb), public.stock_intel_price_basis(text),
  public.stock_intel_matrix(text) from public, anon, authenticated;
grant execute on function public.stock_intel_planning(uuid), public.stock_intel_publish_opportunities(uuid, integer, jsonb)
  to service_role;
grant execute on function public.stock_intel_replenishment_params(text),
  public.stock_intel_set_replenishment(text, text, text, jsonb, text), public.stock_intel_replenishment(jsonb),
  public.stock_intel_opportunities(jsonb), public.stock_intel_price_basis(text), public.stock_intel_matrix(text)
  to authenticated;
notify pgrst, 'reload schema';
