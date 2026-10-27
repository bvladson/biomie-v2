\set ON_ERROR_STOP on
-- Estoque, migração 0049: Inteligência fase 5 (reposição por fornecedor, oportunidades entre empresas, base
-- de preço), revista com fornecedores e prazos da 0048. Política de reposição com nível de serviço por curva,
-- só de Compras e do Super admin (validação, observação, histórico e Auditoria antes/depois); Comercial vê a
-- reposição sem o fornecedor; o motor recebe, por empresa, vínculos, prazos
-- confirmados (os de teste só com o ajuste da homologação) e fornecedor principal; lista da reposição com
-- custo só para quem vê custo e filtro por fornecedor (uma empresa); Radar e lista da Inteligência por
-- fornecedor; oportunidades só para quem acessa as duas empresas e só da execução publicada das duas; lotes
-- inválidos recusados; base de preço só com custo; dados oficiais intocados.
-- Empresas, produtos e usuários sintéticos; tudo é desfeito no fim. Banco de TESTE.
begin;
do $$
declare
  t date := stock_internal.as_of();
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid(); cd uuid := gen_random_uuid();
  su uuid := gen_random_uuid(); co uuid := gen_random_uuid(); ve uuid := gen_random_uuid(); v2 uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'Fase 5 A (teste)', 'intel5a-' || ca, 'OMIE_SHADOW', 'commercial_base', false),
    (cb, 'Fase 5 B (teste)', 'intel5b-' || cb, 'OMIE_SHADOW', 'commercial_base', false),
    (cd, 'Fase 5 DEMO', 'intel5d-' || cd, 'OMIE_SHADOW', 'commercial_base', true);
  insert into auth.users (id, email, created_at) values
    (su, 'intel5-su-' || su || '@invalid.example', now()), (co, 'intel5-co-' || co || '@invalid.example', now()),
    (ve, 'intel5-ve-' || ve || '@invalid.example', now()), (v2, 'intel5-v2-' || v2 || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values (su, 'intel5-su@x', 'Super Fase5'),
    (co, 'intel5-co@x', 'Compras Fase5'), (ve, 'intel5-ve@x', 'Vendedor Fase5'), (v2, 'intel5-v2@x', 'Vendedor Duas Empresas');
  insert into public.user_roles (user_id, role) values (su, 'SUPER_ADMIN'), (co, 'VIEWER'), (ve, 'VENDEDOR'), (v2, 'VENDEDOR');
  insert into public.user_permissions (user_id, permission) values (co, 'stock.purchasing');
  insert into public.user_company_access (user_id, company_id) values (co, ca), (ve, ca), (v2, ca), (v2, cb);
  insert into public.products (company_id, name, category, base_price, sku, source, external_id) values
    (ca, 'Cadeira X', 'Cadeiras', 0, 'F5-X', 'omie', '501'), (ca, 'Mesa Y', 'Mesas', 0, 'F5-Y', 'omie', '502'),
    (cb, 'Cadeira X', 'Cadeiras', 0, 'F5-X', 'omie', '601');
  insert into public.customers (company_id, name, state, city, source, external_id) values
    (ca, 'Fornecedor Alfa', 'CE', 'Fortaleza', 'omie', '9001'), (ca, 'Fornecedor Beta', 'SP', 'Campinas', 'omie', '9002');
  insert into private.stock_readings (id, company_id, kind, trigger, status, position_date, pages_total, pages_done,
      records_expected, records_received, locations, attempts, finished_at) values
    (ra, ca, 'close', 'manual', 'complete', t, 1, 1, 2, 2, '{"1": {"name": "Depósito"}}', 1, now()),
    (rb, cb, 'close', 'manual', 'complete', t, 1, 1, 1, 1, '{"1": {"name": "Depósito"}}', 1, now());
  insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
      physical_qty, reserved_qty, pending_qty, unit_cost, sale_price) values
    (ra, ca, '501', '1', 'F5-X', 'Cadeira X', 100, 0, 0, 40, 90), (ra, ca, '502', '1', 'F5-Y', 'Mesa Y', 2, 0, 0, 200, 500),
    (rb, cb, '601', '1', 'F5-X', 'Cadeira X', 0, 0, 0, 40, 90);
  insert into private.stock_current (company_id, reading_id, published_at) values (ca, ra, now()), (cb, rb, now());
  -- Fornecedores da empresa A (como a importação da 0048 grava) e prazos: dois confirmados e um de teste.
  insert into private.stock_suppliers (company_id, supplier_id, in_omie) values (ca, '9001', true), (ca, '9002', true);
  insert into private.stock_product_suppliers (company_id, omie_product_id, supplier_id, in_omie) values
    (ca, '501', '9001', true), (ca, '502', '9001', true), (ca, '501', '9002', true);
  insert into private.stock_lead_times (company_id, supplier_id, omie_product_id, lead_time_days, min_lot, status, note) values
    (ca, '9001', '', 20, null, 'confirmado', 'Prazo padrão informado por Compras'),
    (ca, '9001', '502', 60, 5, 'confirmado', 'Mesa importada sob encomenda'),
    (ca, '9002', '', 30, null, 'teste', 'Teste de homologação: prazo hipotético de 30 dias');
  insert into private.stock_preferred_suppliers (company_id, omie_product_id, supplier_id, note)
    values (ca, '501', '9001', 'Alfa é o fornecedor habitual da cadeira');
  update private.feature_flags set mode = 'on' where key = 'stock';
  perform set_config('f5.ca', ca::text, true); perform set_config('f5.cb', cb::text, true);
  perform set_config('f5.cd', cd::text, true); perform set_config('f5.su', su::text, true);
  perform set_config('f5.co', co::text, true); perform set_config('f5.ve', ve::text, true);
  perform set_config('f5.v2', v2::text, true);
end $$;
select set_config('f5.official', (select json_build_object(
  'positions', (select count(*) from private.stock_positions), 'products', (select count(*) from public.products),
  'movements', (select count(*) from private.stock_movements), 'manual', (select count(*) from private.stock_curves),
  'leadTimes', (select count(*) from private.stock_lead_times))::text), true);

-- 1. Política de reposição: Compras define, com validação e observação; vendedor só lê.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.co'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('f5.ca');
begin
  v := public.stock_replenishment_policy(ca);
  if not (v->>'canEdit')::boolean or v->'companies'->0->'policy' <> 'null'::jsonb
     or (v->'defaults'->>'reviewDays')::integer <> 30 or (v->'companies'->0->>'confirmedLeadTimes')::integer <> 2
     or (v->'companies'->0->>'testLeadTimes')::integer <> 1
     or v->'defaults'->'serviceLevels' <> '{"A": 0.95, "B": 0.90, "C": 0.85, "D": 0.80, "U": 0.90}'::jsonb then
    raise exception 'FALHOU: política inicial (padrões do BIOMIE por curva): %', v;
  end if;
  v := public.stock_replenishment_policy_set(ca, '{"reviewDays": 15, "serviceLevels": {"A": 0.97, "B": 0.95}}',
    'Compras revisa a cada quinzena');
  if not (v->>'saved')::boolean then raise exception 'FALHOU: política salva'; end if;
  perform public.stock_replenishment_policy_set(ca,
    '{"reviewDays": 15, "serviceLevels": {"A": 0.99, "B": 0.95, "C": 0.90, "D": 0.80, "U": 0.85}, "maxCoverageDays": 120}',
    'Nível de serviço maior para a linha');
  begin perform public.stock_replenishment_policy_set(ca, '{"serviceLevels": {"A": 0.5}}', 'Nível fora da lista');
    raise exception 'FALHOU: nível de serviço fora da lista aceito';
  exception when others then if sqlerrm not like '%nível de serviço da lista%' then raise; end if; end;
  begin perform public.stock_replenishment_policy_set(ca, '{"serviceLevels": {"X": 0.9}}', 'Curva que não existe');
    raise exception 'FALHOU: curva desconhecida aceita';
  exception when others then if sqlerrm not like '%nível de serviço da lista%' then raise; end if; end;
  begin perform public.stock_replenishment_policy_set(ca, '{"reviewDays": 400}', 'Revisão longa demais');
    raise exception 'FALHOU: revisão acima de 180 aceita';
  exception when others then if sqlerrm not like '%Revisão de 1 a 180%' then raise; end if; end;
  begin perform public.stock_replenishment_policy_set(ca, '{"reviewDays": "quinze"}', 'Texto no lugar do número');
    raise exception 'FALHOU: valor não numérico aceito';
  exception when others then if sqlerrm not like '%inválida%' then raise; end if; end;
  begin perform public.stock_replenishment_policy_set(ca, '{"reviewDays": 10}', 'curto');
    raise exception 'FALHOU: observação curta aceita';
  exception when others then if sqlerrm not like '%observação%' then raise; end if; end;
  begin perform public.stock_replenishment_policy_set('all', '{"reviewDays": 10}', 'Todas as empresas de uma vez');
    raise exception 'FALHOU: política sem empresa aceita';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' then raise; end if; end;
  v := public.stock_replenishment_policy(ca);
  if v->'companies'->0->'policy'->'serviceLevels' <> '{"A": 0.99, "B": 0.95, "C": 0.90, "D": 0.80, "U": 0.85}'::jsonb
     or (v->'companies'->0->'policy'->>'maxCoverageDays')::integer <> 120
     or v->'companies'->0->'policy'->>'updatedBy' <> 'Compras Fase5' then
    raise exception 'FALHOU: política gravada: %', v;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.audit_log where action = 'stock.replenishment_policy.changed'
      and actor_id = current_setting('f5.co')::uuid) <> 2
     or not exists (select 1 from public.audit_log where action = 'stock.replenishment_policy.changed'
                    and payload->>'mudanca' = 'update' and (payload->'before'->>'serviceLevelA')::numeric = 0.97
                    and (payload->'after'->>'serviceLevelA')::numeric = 0.99
                    and (payload->'before'->>'serviceLevelC')::numeric = 0.85
                    and (payload->'after'->>'serviceLevelC')::numeric = 0.90
                    and payload->'after'->>'note' = 'Nível de serviço maior para a linha') then
    raise exception 'FALHOU: auditoria da política (antes, depois e observação)';
  end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; refused boolean := false;
begin
  begin
    perform public.stock_replenishment_policy_set(current_setting('f5.ca'), '{"reviewDays": 5}', 'Tentativa do vendedor');
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor definiu a política de reposição'; end if;
  v := public.stock_replenishment_policy('all');
  if (v->>'canEdit')::boolean or jsonb_array_length(v->'companies') <> 1
     or v->'companies'->0->'policy'->'updatedBy' <> 'null'::jsonb then
    raise exception 'FALHOU: vendedor vê a política da empresa dele, sem editar e sem nomes: %', v;
  end if;
end $$;
reset role;

-- 2. Motor: o que a reposição de cada empresa recebe; prazo de teste só com o ajuste; lotes inválidos.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; p jsonb; run uuid; ca uuid := current_setting('f5.ca')::uuid;
begin
  v := public.stock_intel_begin('ops', 'intel-test-f5', true);
  run := (v->>'runId')::uuid;
  perform set_config('f5.run', run::text, true);
  p := public.stock_intel_planning(run, ca);
  if (p->>'testLeadTimes')::boolean or (p->'policy'->'serviceLevels'->>'A')::numeric <> 0.99
     or (p->'policy'->'serviceLevels'->>'U')::numeric <> 0.85 or (p->'policy'->>'reviewDays')::integer <> 15
     or jsonb_array_length(p->'links') <> 3 or jsonb_array_length(p->'leadTimes') <> 2
     or p->'suppliers'->>'9001' <> 'Fornecedor Alfa' or p->'preferred'->>'501' <> '9001'
     or exists (select 1 from jsonb_array_elements(p->'leadTimes') x where x->>'status' = 'teste')
     or not exists (select 1 from jsonb_array_elements(p->'leadTimes') x where x->>'supplierId' = '9001'
                    and x->>'omie' = '502' and (x->>'days')::integer = 60 and (x->>'minLot')::numeric = 5) then
    raise exception 'FALHOU: entrada do motor (prazo de teste fora sem o ajuste): %', p;
  end if;
  p := public.stock_intel_planning(run, current_setting('f5.cb')::uuid);
  if p->'policy' <> 'null'::jsonb or p->'links' <> '[]'::jsonb or p->'leadTimes' <> '[]'::jsonb then
    raise exception 'FALHOU: empresa B sem fornecedores nem política: %', p;
  end if;
  begin perform public.stock_intel_planning(run, current_setting('f5.cd')::uuid);
    raise exception 'FALHOU: empresa DEMO no motor';
  exception when others then if sqlerrm not like '%Empresa inválida%' then raise; end if; end;
end $$;
reset role;
insert into private.app_settings (key, value) values ('stock.test_lead_times', 'on')
  on conflict (key) do update set value = excluded.value;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare p jsonb; run uuid := current_setting('f5.run')::uuid; ca uuid := current_setting('f5.ca')::uuid;
  cb uuid := current_setting('f5.cb')::uuid;
begin
  p := public.stock_intel_planning(run, ca);
  if not (p->>'testLeadTimes')::boolean or jsonb_array_length(p->'leadTimes') <> 3
     or not exists (select 1 from jsonb_array_elements(p->'leadTimes') x where x->>'supplierId' = '9002'
                    and x->>'status' = 'teste' and (x->>'days')::integer = 30) then
    raise exception 'FALHOU: prazo de teste com o ajuste da homologação: %', p;
  end if;
  perform public.stock_intel_publish(run, ca, 0, jsonb_build_array(
    jsonb_build_object('omieProductId', '501', 'sku', 'F5-X', 'name', 'Cadeira X', 'state', 'possivel_excesso', 'flags', '[]'::jsonb,
      'priority', 80, 'metrics', jsonb_build_object('stock', jsonb_build_object('qty', 100, 'available', 100),
        'capital', 4000, 'avgPrice', 85, 'sales', jsonb_build_object('d365', jsonb_build_object('units', 4)),
        'replenishment', jsonb_build_object('status', 'nao_comprar', 'qty', 0, 'leadTimeDays', 20, 'coverageDays', 900,
          'supplier', jsonb_build_object('id', '9001', 'name', 'Fornecedor Alfa', 'leadTimeStatus', 'confirmado')))),
    jsonb_build_object('omieProductId', '502', 'sku', 'F5-Y', 'name', 'Mesa Y', 'state', 'risco_ruptura', 'flags', '[]'::jsonb,
      'priority', 60, 'metrics', jsonb_build_object('stock', jsonb_build_object('qty', 2, 'available', 2),
        'replenishment', jsonb_build_object('status', 'comprar', 'qty', 15, 'leadTimeDays', 60, 'coverageDays', 10,
          'costEstimate', 3000, 'risk', 'Falta estimada.', 'explanation', 'Demanda prevista de 0,2 un./dia.',
          'leadTimeStatus', 'teste', 'suppliers', jsonb_build_array(jsonb_build_object('id', '9001')),
          'supplier', jsonb_build_object('id', '9001', 'name', 'Fornecedor Alfa', 'leadTimeStatus', 'teste'))))));
  perform public.stock_intel_publish(run, cb, 0, jsonb_build_array(
    jsonb_build_object('omieProductId', '601', 'sku', 'F5-X', 'name', 'Cadeira X', 'state', 'sem_saldo', 'flags', '[]'::jsonb,
      'metrics', jsonb_build_object('stock', jsonb_build_object('qty', 0, 'available', 0),
        'replenishment', jsonb_build_object('status', 'sem_fornecedor',
          'message', 'Nenhum fornecedor vinculado: a quantidade de reposição está indisponível.')))));
  if public.stock_intel_publish_opportunities(run, 0, jsonb_build_array(jsonb_build_object(
       'sku', 'F5-X', 'name', 'Cadeira X', 'qty', 90, 'fromCompanyId', ca, 'fromOmie', '501', 'toCompanyId', cb, 'toOmie', '601',
       'valueAtCost', 3600, 'reason', 'Sobra numa, falta noutra.', 'note', 'Pode exigir nota fiscal.'),
       jsonb_build_object('sku', 'F5-X', 'qty', 5, 'fromCompanyId', ca, 'fromOmie', '501',
         'toCompanyId', current_setting('f5.cd'), 'toOmie', '701'))) <> 1 then
    raise exception 'FALHOU: oportunidade gravada (a da empresa DEMO fica fora)';
  end if;
  begin
    perform public.stock_intel_publish_opportunities(run, 1, jsonb_build_array(jsonb_build_object(
      'sku', 'F5-X', 'qty', 1, 'fromCompanyId', ca, 'fromOmie', '501', 'toCompanyId', ca, 'toOmie', '502')));
    raise exception 'FALHOU: oportunidade dentro da mesma empresa aceita';
  exception when check_violation then null; end;
  begin
    perform public.stock_intel_publish_opportunities(run, 1, jsonb_build_array(jsonb_build_object(
      'sku', 'F5-X', 'qty', 0, 'fromCompanyId', ca, 'fromOmie', '501', 'toCompanyId', cb, 'toOmie', '601')));
    raise exception 'FALHOU: quantidade zero aceita';
  exception when check_violation then null; end;
  perform public.stock_intel_finish(run, '{}'::jsonb);
  begin
    perform public.stock_intel_planning(run, ca);
    raise exception 'FALHOU: entrada de execução já encerrada';
  exception when others then if sqlerrm not like '%encerrada%' then raise; end if; end;
end $$;
reset role;

-- 3. Telas: Super admin vê custo, a oportunidade e os filtros por fornecedor; vendedor (só a empresa A, sem
--    custo) não vê custo nem a oportunidade (que envolve a empresa B) e não recebe base de preço.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('f5.ca');
begin
  v := public.stock_intel_replenishment(jsonb_build_object('companyId', ca));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '502' or (v->'rows'->0->>'costEstimate')::numeric <> 3000
     or v->'rows'->0->'supplier'->>'name' <> 'Fornecedor Alfa'
     or (v->'summary'->>'comprar')::integer <> 1 or (v->'summary'->>'naoComprar')::integer <> 1
     or (v->'summary'->>'testLeadTime')::integer <> 1 or (v->'summary'->>'costEstimate')::numeric <> 3000 then
    raise exception 'FALHOU: reposição do super: %', v;
  end if;
  v := public.stock_intel_replenishment(jsonb_build_object('companyId', 'all', 'status', 'sem_fornecedor'));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '601' or (v->'summary'->>'semFornecedor')::integer <> 1 then
    raise exception 'FALHOU: sem fornecedor: %', v;
  end if;
  v := public.stock_intel_replenishment(jsonb_build_object('companyId', ca, 'supplier', '9002', 'status', 'all'));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '501' or v->'supplier'->>'name' <> 'Fornecedor Beta'
     or (v->'summary'->>'naoComprar')::integer <> 1 or (v->'summary'->>'comprar')::integer <> 0 then
    raise exception 'FALHOU: reposição por fornecedor: %', v;
  end if;
  begin perform public.stock_intel_replenishment(jsonb_build_object('companyId', 'all', 'supplier', '9001'));
    raise exception 'FALHOU: reposição por fornecedor com várias empresas';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' then raise; end if; end;
  begin perform public.stock_intel_replenishment(jsonb_build_object('companyId', ca, 'status', 'qualquer'));
    raise exception 'FALHOU: situação inválida aceita';
  exception when others then if sqlerrm not like '%Consulta inválida%' then raise; end if; end;
  -- Radar de Capital Parado e lista da Inteligência por fornecedor.
  v := public.stock_intel_overview(ca, null, '9002');
  if v->'supplier'->>'name' <> 'Fornecedor Beta' or v->'evolution' <> '[]'::jsonb
     or (select sum((r->>'products')::integer) from jsonb_array_elements(v->'radar') r) <> 1
     or (v->'capital'->>'total')::numeric <> 4000 then
    raise exception 'FALHOU: radar por fornecedor: %', v;
  end if;
  if public.stock_intel_overview(ca)->'supplier' <> 'null'::jsonb
     or (select sum((r->>'products')::integer) from jsonb_array_elements(public.stock_intel_overview(ca)->'radar') r) <> 2 then
    raise exception 'FALHOU: radar sem filtro mudou';
  end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca, 'supplier', '9002'));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '501' then
    raise exception 'FALHOU: lista da Inteligência por fornecedor: %', v;
  end if;
  begin perform public.stock_intel_products(jsonb_build_object('companyId', 'all', 'supplier', '9002'));
    raise exception 'FALHOU: lista por fornecedor com várias empresas';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' then raise; end if; end;
  v := public.stock_intel_opportunities('{}');
  if (v->>'total')::integer <> 1 or (v->'rows'->0->>'valueAtCost')::numeric <> 3600 or v->'rows'->0->>'toCompanyName' <> 'Fase 5 B (teste)'
     or v->>'note' not like '%nota fiscal%' then
    raise exception 'FALHOU: oportunidades do super: %', v;
  end if;
  v := public.stock_intel_opportunities(jsonb_build_object('companyId', current_setting('f5.cb'), 'omieProductId', '601'));
  if (v->>'total')::integer <> 1 then raise exception 'FALHOU: oportunidade pelo produto que recebe'; end if;
  v := public.stock_intel_price_basis(ca);
  if jsonb_array_length(v->'prices') <> 1 or (v->'prices'->0->>2)::numeric <> 85 then
    raise exception 'FALHOU: base de preço do simulador: %', v;
  end if;
  v := public.stock_intel_matrix('all');
  -- só entra produto com prioridade e capital: 501 (502 tem prioridade sem capital; 601 nada)
  if (v->>'total')::integer <> 1 or v->'points'->0->>1 <> '501' or (v->'points'->0->>4)::numeric <> 4000
     or (v->'points'->0->>5)::numeric <> 80 then
    raise exception 'FALHOU: matriz só com capital e prioridade: %', v;
  end if;
  v := public.stock_replenishment_policy_set(ca, null, 'Volta aos padrões do BIOMIE');
  if not (v->>'removed')::boolean then raise exception 'FALHOU: remover a política'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; refused boolean := false;
begin
  v := public.stock_intel_replenishment(jsonb_build_object('companyId', 'all'));
  if (v->>'total')::integer <> 1 or v->'rows'->0 ? 'costEstimate' or v->'summary'->>'costEstimate' is not null
     or v->'rows'->0 ? 'supplier' or v->'rows'->0 ? 'suppliers' or (v->'rows'->0->>'leadTimeDays')::integer <> 60
     or (v->'rows'->0->>'qty')::numeric <> 15 then
    raise exception 'FALHOU: vendedor vê a reposição sem custo estimado e sem fornecedor: %', v;
  end if;
  begin perform public.stock_intel_replenishment(jsonb_build_object('companyId', current_setting('f5.ca'), 'supplier', '9001'));
    raise exception 'FALHOU: vendedor filtrou a reposição por fornecedor';
  exception when insufficient_privilege then null; end;
  v := public.stock_intel_opportunities('{}');
  if (v->>'total')::integer <> 0 then raise exception 'FALHOU: vendedor sem acesso à empresa B viu a oportunidade'; end if;
  v := public.stock_intel_product(current_setting('f5.ca'), '502');
  if v->'metrics'->'replenishment' ? 'costEstimate' or v->'metrics'->'replenishment'->>'status' <> 'comprar'
     or v->'metrics'->'replenishment' ? 'supplier' or v->'metrics'->'replenishment' ? 'suppliers' then
    raise exception 'FALHOU: detalhe do vendedor com custo estimado ou fornecedor: %', v->'metrics'->'replenishment';
  end if;
  begin
    perform public.stock_intel_price_basis('all');
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor recebeu base de preço'; end if;
  refused := false;
  begin
    perform public.stock_intel_matrix('all');
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor recebeu a matriz (capital)'; end if;
end $$;
reset role;

-- Vendedor que acessa as duas empresas vê a oportunidade, mas sem o valor a custo.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.v2'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.stock_intel_opportunities('{}');
  if (v->>'total')::integer <> 1 or v->'rows'->0 ? 'valueAtCost' or (v->'rows'->0->>'qty')::numeric <> 90 then
    raise exception 'FALHOU: oportunidade sem custo para quem não vê custo: %', v;
  end if;
end $$;
reset role;

-- 4. Nada oficial mudou (nem os prazos: o motor só lê).
do $$
begin
  if current_setting('f5.official') <> (select json_build_object(
    'positions', (select count(*) from private.stock_positions), 'products', (select count(*) from public.products),
    'movements', (select count(*) from private.stock_movements), 'manual', (select count(*) from private.stock_curves),
    'leadTimes', (select count(*) from private.stock_lead_times))::text) then
    raise exception 'FALHOU: dados oficiais mudaram com a fase 5';
  end if;
  if (select count(*) from public.audit_log where action = 'stock.replenishment_policy.changed'
      and payload->>'mudanca' = 'remove') <> 1 then
    raise exception 'FALHOU: remoção da política sem auditoria';
  end if;
  if has_function_privilege('authenticated', 'public.stock_intel_planning(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'stock_internal.intel_planning(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.stock_replenishment_policy_set(text, jsonb, text)', 'EXECUTE') then
    raise exception 'FALHOU: permissões das funções da fase 5';
  end if;
  raise notice 'PASS Inteligência fase 5: política de reposição só de Compras e do Super admin (validação, observação, auditoria antes/depois), motor recebe por empresa vínculos, prazos confirmados (teste só com o ajuste da homologação) e fornecedor principal, reposição com custo só para quem vê custo e filtro por fornecedor numa empresa, radar e lista por fornecedor, oportunidades só da execução publicada e só para quem acessa as duas empresas, lotes inválidos e empresa DEMO recusados, base de preço só com custo, dados oficiais intocados';
end $$;
rollback;
