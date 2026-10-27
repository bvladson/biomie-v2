-- 0049: Inteligência do Estoque — fase 5 (Reposição Inteligente, oportunidades entre empresas e base de
-- preço para o simulador), revista em 27/10/2026 com a decisão de fornecedores e prazos (0048). Aditiva e
-- consultiva: o BIOMIE não cria pedido de compra, não transfere estoque e não muda preço; nada escreve no Omie.
-- - O prazo de entrega é o da 0048: por empresa, fornecedor e produto (ou o padrão do fornecedor), informado
--   por Compras ou pelo Super admin. O motor (intel-1.3) recebe, por empresa, os vínculos produto ×
--   fornecedor, os prazos confirmados e o fornecedor principal (stock_intel_planning) e escolhe o fornecedor
--   da reposição: o principal; senão o único vinculado; senão o único com prazo. Vários com prazo e nenhum
--   principal = "fornecedor a definir". Sem fornecedor ou sem prazo confiável: a quantidade de reposição
--   fica indisponível (nunca inventa prazo).
-- - Prazo de teste (homologação) só chega ao motor com o ajuste stock.test_lead_times = on e sai rotulado
--   ("prazo configurado na simulação"), com o aviso de que Compras precisa confirmar.
-- - Política de reposição por empresa (ciclo de revisão, nível de serviço POR CURVA A/B/C/D e para produto
--   sem curva, cobertura máxima), também de Compras e do Super admin, com histórico e Auditoria; sem
--   política, os padrões do BIOMIE (30 dias; A 95%, B 90%, C 85%, D 80%, sem curva 90%; sem cobertura
--   máxima), sempre mostrados como padrão. Níveis por curva aprovados pelo usuário em 27/10/2026.
-- - O Comercial (quem não vê custo nem é Compras) consulta previsões e reposições sem o fornecedor (nome,
--   código e alternativas saem da reposição); a área de fornecedores e prazos é de quem vê custo ou Compras.
-- - Filtro por fornecedor na Reposição, no Radar de Capital Parado (painel) e na lista da Inteligência
--   (uma empresa por vez). No radar filtrado, a evolução diária some (as fotos são por empresa).
-- - Oportunidades entre empresas e base de preço: como antes (só para quem acessa as duas empresas; valor a
--   custo e base de preço só para quem vê custo).
-- Retorno: nenhuma tela da produção usa estas funções; a release anterior as ignora.

-- ===================================================================== tabelas

create table if not exists private.stock_replenishment_policy (
  company_id uuid primary key references public.companies(id) on delete cascade,
  review_days integer not null default 30 check (review_days between 1 and 180),
  -- nível de serviço por curva (A/B/C/D, a curva de 12 meses da análise) e para produto sem curva
  service_level_a numeric not null default 0.95 check (service_level_a in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99)),
  service_level_b numeric not null default 0.90 check (service_level_b in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99)),
  service_level_c numeric not null default 0.85 check (service_level_c in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99)),
  service_level_d numeric not null default 0.80 check (service_level_d in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99)),
  service_level_u numeric not null default 0.90 check (service_level_u in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99)),
  max_coverage_days integer check (max_coverage_days is null or max_coverage_days between 7 and 730),
  note text not null check (char_length(note) between 10 and 300),
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp()
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
revoke all on private.stock_replenishment_policy, private.intel_opportunities
  from public, anon, authenticated, service_role;

-- ===================================================================== apoio

-- Níveis de serviço por curva de uma política (ou os padrões do BIOMIE com a política nula).
create or replace function stock_internal.service_levels(p private.stock_replenishment_policy) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select case when p.company_id is null
    then jsonb_build_object('A', 0.95, 'B', 0.90, 'C', 0.85, 'D', 0.80, 'U', 0.90)
    else jsonb_build_object('A', p.service_level_a, 'B', p.service_level_b, 'C', p.service_level_c,
                            'D', p.service_level_d, 'U', p.service_level_u) end
$$;

-- Níveis por curva em campos próprios (a Auditoria compara campo a campo).
create or replace function stock_internal.levels_flat(p_levels jsonb) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object('serviceLevelA', p_levels->'A', 'serviceLevelB', p_levels->'B', 'serviceLevelC', p_levels->'C',
                            'serviceLevelD', p_levels->'D', 'serviceLevelU', p_levels->'U')
$$;

-- ===================================================================== motor (service_role)

-- O que a reposição de UMA empresa precisa: política, nomes dos fornecedores, vínculos, prazos
-- confirmados (os de teste só com o ajuste da homologação) e fornecedor principal.
create or replace function stock_internal.intel_planning(p_run uuid, p_company uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run private.intel_runs := stock_internal.intel_running(p_run);
  v_test boolean := stock_internal.test_lead_times_on();
begin
  if not exists (select 1 from public.companies c where c.id = p_company and not c.is_demo) then
    raise exception 'Empresa inválida para a execução.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('runId', v_run.id, 'companyId', p_company, 'testLeadTimes', v_test,
    'policy', (select jsonb_build_object('reviewDays', p.review_days, 'serviceLevels', stock_internal.service_levels(p),
                 'maxCoverageDays', p.max_coverage_days)
               from private.stock_replenishment_policy p where p.company_id = p_company),
    'suppliers', coalesce((select jsonb_object_agg(s.supplier_id, stock_internal.supplier_display(s.company_id, s.supplier_id))
                 from private.stock_suppliers s
                 where s.company_id = p_company and exists (select 1 from private.stock_product_suppliers ps
                   where ps.company_id = s.company_id and ps.supplier_id = s.supplier_id)), '{}'::jsonb),
    'links', coalesce((select jsonb_agg(jsonb_build_array(ps.omie_product_id, ps.supplier_id)
                 order by ps.omie_product_id, ps.supplier_id)
               from private.stock_product_suppliers ps where ps.company_id = p_company), '[]'::jsonb),
    'leadTimes', coalesce((select jsonb_agg(jsonb_build_object('supplierId', t.supplier_id, 'omie', t.omie_product_id,
                 'days', t.lead_time_days, 'minLot', t.min_lot, 'status', t.status) order by t.supplier_id, t.omie_product_id)
               from private.stock_lead_times t
               where t.company_id = p_company and (t.status = 'confirmado' or (v_test and t.status = 'teste'))), '[]'::jsonb),
    'preferred', coalesce((select jsonb_object_agg(p.omie_product_id, p.supplier_id)
               from private.stock_preferred_suppliers p where p.company_id = p_company), '{}'::jsonb));
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

-- 0047 + reposição sem o custo estimado para quem não vê custo e sem o fornecedor para quem não consulta
-- fornecedores (o Comercial): por isso lê as capacidades de quem pede (stable, não immutable).
create or replace function stock_internal.intel_mask(p_metrics jsonb, p_cost boolean) returns jsonb
language sql stable set search_path = pg_catalog as $$
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
      'replenishment', coalesce(p_metrics->'replenishment', '{}'::jsonb) - 'costEstimate'
        - (case when coalesce((stock_internal.caps()->>'suppliers')::boolean, false) then '{}'::text[]
                else array['supplier', 'suppliers', 'notes'] end))
  end
$$;

-- ===================================================================== telas

-- Política de reposição das empresas do usuário (e se ele pode editar).
create or replace function stock_internal.replenishment_policy(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_edit boolean := coalesce((v_caps->>'purchasing')::boolean, false);
  v_companies uuid[] := stock_internal.scope(p_company);
begin
  return jsonb_build_object('canEdit', v_edit,
    'serviceLevels', jsonb_build_array(0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99),
    'defaults', jsonb_build_object('reviewDays', 30, 'serviceLevels', stock_internal.service_levels(null),
                                   'maxCoverageDays', null),
    'testLeadTimesOn', stock_internal.test_lead_times_on(),
    'companies', coalesce((select jsonb_agg(jsonb_build_object('companyId', c.id, 'companyName', c.name,
        'policy', case when p.company_id is not null then jsonb_build_object('reviewDays', p.review_days,
            'serviceLevels', stock_internal.service_levels(p), 'maxCoverageDays', p.max_coverage_days, 'note', p.note,
            'updatedAt', p.updated_at,
            'updatedBy', case when v_edit then (select coalesce(nullif(u.full_name, ''), 'Usuário') from public.profiles u
                                                where u.id = p.updated_by) end) end,
        'confirmedLeadTimes', (select count(*) from private.stock_lead_times t
                               where t.company_id = c.id and t.status = 'confirmado'),
        'testLeadTimes', (select count(*) from private.stock_lead_times t where t.company_id = c.id and t.status = 'teste'))
      order by c.name)
      from unnest(v_companies) x(id) join public.companies c on c.id = x.id
      left join private.stock_replenishment_policy p on p.company_id = c.id), '[]'::jsonb));
end $$;

-- Define (ou remove, com p_values nulo: volta aos padrões) a política de uma empresa.
create or replace function stock_internal.replenishment_policy_set(p_company text, p_values jsonb, p_note text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('purchasing');
  v_company uuid := stock_internal.write_company(p_company,
    'Escolha uma empresa: a política de reposição é de cada empresa.');
  v_note text := stock_internal.valid_note(p_note);
  v_before private.stock_replenishment_policy;
  v_before_json jsonb;
  v_review integer; v_max integer;
  v_levels jsonb := stock_internal.service_levels(null);
  v_in jsonb;
  v_k text;
begin
  select * into v_before from private.stock_replenishment_policy p where p.company_id = v_company for update;
  if v_before.company_id is not null then
    v_before_json := jsonb_build_object('reviewDays', v_before.review_days)
      || stock_internal.levels_flat(stock_internal.service_levels(v_before))
      || jsonb_build_object('maxCoverageDays', v_before.max_coverage_days, 'note', v_before.note);
  end if;
  if p_values is null or jsonb_typeof(p_values) = 'null' then
    if v_before.company_id is null then return jsonb_build_object('removed', false); end if;
    delete from private.stock_replenishment_policy p where p.company_id = v_company;
    perform stock_internal.supplier_change(v_company, null, '', 'politica', 'remove', v_before_json, null, v_note);
    return jsonb_build_object('removed', true);
  end if;
  v_in := case when jsonb_typeof(p_values->'serviceLevels') = 'object' then p_values->'serviceLevels' else '{}'::jsonb end;
  begin
    v_review := coalesce(nullif(p_values->>'reviewDays', '')::integer, 30);
    v_max := nullif(p_values->>'maxCoverageDays', '')::integer;
    foreach v_k in array array['A', 'B', 'C', 'D', 'U'] loop
      if nullif(v_in->>v_k, '') is not null then
        v_levels := v_levels || jsonb_build_object(v_k, (v_in->>v_k)::numeric);
      end if;
    end loop;
  exception when others then
    raise exception 'Política de reposição inválida.' using errcode = 'P0001';
  end;
  if v_review not between 1 and 180 or (v_max is not null and v_max not between 7 and 730)
     or exists (select 1 from jsonb_each_text(v_levels) e where e.value::numeric not in (0.80, 0.85, 0.90, 0.95, 0.97, 0.98, 0.99))
     or exists (select 1 from jsonb_object_keys(v_in) k where k not in ('A', 'B', 'C', 'D', 'U')) then
    raise exception 'Revisão de 1 a 180 dias, nível de serviço da lista para cada curva e cobertura máxima de 7 a 730 dias.'
      using errcode = 'P0001';
  end if;
  insert into private.stock_replenishment_policy as t (company_id, review_days, service_level_a, service_level_b,
    service_level_c, service_level_d, service_level_u, max_coverage_days, note, updated_by)
  values (v_company, v_review, (v_levels->>'A')::numeric, (v_levels->>'B')::numeric, (v_levels->>'C')::numeric,
    (v_levels->>'D')::numeric, (v_levels->>'U')::numeric, v_max, v_note, auth.uid())
  on conflict (company_id) do update set review_days = excluded.review_days,
    service_level_a = excluded.service_level_a, service_level_b = excluded.service_level_b,
    service_level_c = excluded.service_level_c, service_level_d = excluded.service_level_d,
    service_level_u = excluded.service_level_u, max_coverage_days = excluded.max_coverage_days, note = excluded.note,
    updated_by = excluded.updated_by, updated_at = clock_timestamp();
  perform stock_internal.supplier_change(v_company, null, '', 'politica',
    case when v_before.company_id is null then 'create' else 'update' end, v_before_json,
    jsonb_build_object('reviewDays', v_review) || stock_internal.levels_flat(v_levels)
      || jsonb_build_object('maxCoverageDays', v_max, 'note', v_note), v_note);
  return jsonb_build_object('saved', true);
end $$;

-- Reposição da última análise: comprar (padrão, mais urgentes primeiro), aguardar, não comprar, sem
-- fornecedor, fornecedor a definir, sem prazo, sem previsão, sem demanda ou tudo; por fornecedor (uma
-- empresa). Custo estimado só para quem vê custo.
create or replace function stock_internal.intel_replenishment(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_sup boolean := coalesce((v_caps->>'suppliers')::boolean, false);
  v_companies uuid[] := stock_internal.scope(p_query->>'companyId');
  v_supplier text := stock_internal.supplier_filter(v_companies, p_query->>'supplier');
  v_status text := coalesce(nullif(p_query->>'status', ''), 'comprar');
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_rows jsonb;
  v_total integer;
  v_summary jsonb;
begin
  if v_status not in ('comprar', 'nao_comprar', 'aguardar', 'sem_fornecedor', 'fornecedor_indefinido', 'sem_prazo',
                      'sem_previsao', 'sem_demanda', 'all')
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
    where ic.company_id = any(v_companies) and jsonb_typeof(x.metrics->'replenishment') = 'object'
      and (v_supplier is null or exists (select 1 from private.stock_product_suppliers ps
        where ps.company_id = x.company_id and ps.omie_product_id = x.omie_product_id and ps.supplier_id = v_supplier))),
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
      || ((case when v_cost then o.r else o.r - 'costEstimate' end)
          - (case when v_sup then '{}'::text[] else array['supplier', 'suppliers', 'notes'] end)) order by o.rn)
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
    'semFornecedor', count(*) filter (where x.metrics->'replenishment'->>'status' = 'sem_fornecedor'),
    'fornecedorIndefinido', count(*) filter (where x.metrics->'replenishment'->>'status' = 'fornecedor_indefinido'),
    'semPrazo', count(*) filter (where x.metrics->'replenishment'->>'status' = 'sem_prazo'),
    'semPrevisao', count(*) filter (where x.metrics->'replenishment'->>'status' = 'sem_previsao'),
    'semDemanda', count(*) filter (where x.metrics->'replenishment'->>'status' = 'sem_demanda'),
    'testLeadTime', count(*) filter (where x.metrics->'replenishment'->>'leadTimeStatus' = 'teste'),
    'costEstimate', case when v_cost then coalesce(sum((x.metrics->'replenishment'->>'costEstimate')::numeric)
                      filter (where x.metrics->'replenishment'->>'status' = 'comprar'), 0) end,
    'costEstimateMissing', count(*) filter (where x.metrics->'replenishment'->>'status' = 'comprar'
                                             and x.metrics->'replenishment'->>'costEstimate' is null))
  into v_summary
  from private.intel_current ic
  join private.intel_product_metrics x on x.run_id = ic.run_id and x.company_id = ic.company_id
  where ic.company_id = any(v_companies) and (v_supplier is null or exists (select 1 from private.stock_product_suppliers ps
        where ps.company_id = x.company_id and ps.omie_product_id = x.omie_product_id and ps.supplier_id = v_supplier));
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'summary', v_summary,
    'supplier', case when v_supplier is not null then stock_internal.supplier_json(v_companies[1], v_supplier) end);
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

-- ===================================================================== filtro por fornecedor

drop function if exists public.stock_intel_overview(text, text);
drop function if exists stock_internal.intel_overview(text, text);

-- Radar de Capital Parado (painel da 0045) com o filtro por fornecedor (uma empresa).
create or replace function stock_internal.intel_overview(p_company text, p_window text, p_supplier text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_companies uuid[] := stock_internal.scope(p_company);
  v_window text := stock_internal.pick_window(p_window);
  v_supplier text := stock_internal.supplier_filter(v_companies, p_supplier);
  v jsonb;
begin
  with pos as (
    select p.company_id, p.omie_product_id, sum(p.physical_qty) as qty, count(*) as positions,
      sum(p.physical_qty * p.unit_cost) filter (where p.physical_qty > 0 and p.unit_cost > 0) as capital,
      bool_or(p.physical_qty > 0 and not (p.unit_cost > 0)) as unknown_cost,
      sum(p.physical_qty * p.unit_cost) filter (where p.physical_qty < 0) as negative,
      count(*) filter (where p.physical_qty < 0) as negative_positions
    from private.stock_current sc join private.stock_positions p on p.reading_id = sc.reading_id
    where sc.company_id = any(v_companies) and (v_supplier is null or exists (select 1 from private.stock_product_suppliers ps
        where ps.company_id = p.company_id and ps.omie_product_id = p.omie_product_id and ps.supplier_id = v_supplier))
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
    where ic.company_id = any(v_companies) and (v_supplier is null or exists (select 1 from private.stock_product_suppliers ps
        where ps.company_id = x.company_id and ps.omie_product_id = x.omie_product_id and ps.supplier_id = v_supplier))),
  ev as (
    select s.day, sum(coalesce((s.totals->k.curve->>'capital')::numeric, 0)) as capital,
      sum(coalesce((s.totals->k.curve->>'products')::integer, 0)) as products, k.curve
    from private.stock_snapshots s cross join unnest(array['A', 'B', 'C', 'D']) k(curve)
    where s.company_id = any(v_companies) and v_supplier is null
    group by s.day, k.curve)
  select jsonb_build_object(
    'window', v_window, 'companies', to_jsonb(v_companies),
    'supplier', case when v_supplier is not null then stock_internal.supplier_json(v_companies[1], v_supplier) end,
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

-- Lista da Inteligência (0047) com o filtro por fornecedor (uma empresa).
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
  v_family text := nullif(btrim(coalesce(p_query->>'family', '')), '');
  v_supplier text := stock_internal.supplier_filter(v_companies, p_query->>'supplier');
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
     or (v_rec is not null and v_rec !~ '^[a-z_]{3,40}$') or length(coalesce(v_family, '')) > 120 then
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
      and (v_family is null or mm.family = v_family)
      and (v_supplier is null or exists (select 1 from private.stock_product_suppliers ps
        where ps.company_id = mm.company_id and ps.omie_product_id = mm.omie_product_id and ps.supplier_id = v_supplier))
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

-- ===================================================================== entradas

create or replace function public.stock_intel_planning(p_run uuid, p_company uuid)
returns jsonb language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_planning(p_run, p_company) $$;
create or replace function public.stock_intel_publish_opportunities(p_run uuid, p_chunk integer, p_rows jsonb)
returns integer language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.intel_publish_opportunities(p_run, p_chunk, p_rows) $$;
create or replace function public.stock_replenishment_policy(p_company text)
returns jsonb language sql stable security invoker set search_path = pg_catalog, public as $$
  select stock_internal.replenishment_policy(p_company) $$;
create or replace function public.stock_replenishment_policy_set(p_company text, p_values jsonb, p_note text)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.replenishment_policy_set(p_company, p_values, p_note) $$;
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
create or replace function public.stock_intel_overview(p_company text, p_window text default null,
  p_supplier text default null)
returns jsonb language sql security invoker set search_path = pg_catalog, public as $$
  select stock_internal.intel_overview(p_company, p_window, p_supplier) $$;

revoke all on function stock_internal.service_levels(private.stock_replenishment_policy),
  stock_internal.levels_flat(jsonb), stock_internal.intel_planning(uuid, uuid),
  stock_internal.intel_publish_opportunities(uuid, integer, jsonb), stock_internal.replenishment_policy(text),
  stock_internal.replenishment_policy_set(text, jsonb, text), stock_internal.intel_replenishment(jsonb),
  stock_internal.intel_opportunities(jsonb), stock_internal.intel_price_basis(text), stock_internal.intel_matrix(text),
  stock_internal.intel_overview(text, text, text)
from public, anon, authenticated;
grant execute on function stock_internal.intel_planning(uuid, uuid),
  stock_internal.intel_publish_opportunities(uuid, integer, jsonb) to service_role;
grant execute on function stock_internal.replenishment_policy(text), stock_internal.replenishment_policy_set(text, jsonb, text),
  stock_internal.intel_replenishment(jsonb), stock_internal.intel_opportunities(jsonb), stock_internal.intel_price_basis(text),
  stock_internal.intel_matrix(text), stock_internal.intel_overview(text, text, text)
to authenticated;
revoke all on function public.stock_intel_planning(uuid, uuid), public.stock_intel_publish_opportunities(uuid, integer, jsonb),
  public.stock_replenishment_policy(text), public.stock_replenishment_policy_set(text, jsonb, text),
  public.stock_intel_replenishment(jsonb), public.stock_intel_opportunities(jsonb), public.stock_intel_price_basis(text),
  public.stock_intel_matrix(text), public.stock_intel_overview(text, text, text)
from public, anon, authenticated;
grant execute on function public.stock_intel_planning(uuid, uuid), public.stock_intel_publish_opportunities(uuid, integer, jsonb)
  to service_role;
grant execute on function public.stock_replenishment_policy(text), public.stock_replenishment_policy_set(text, jsonb, text),
  public.stock_intel_replenishment(jsonb), public.stock_intel_opportunities(jsonb), public.stock_intel_price_basis(text),
  public.stock_intel_matrix(text), public.stock_intel_overview(text, text, text)
to authenticated;
notify pgrst, 'reload schema';
