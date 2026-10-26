\set ON_ERROR_STOP on
-- Estoque, migração 0048: Inteligência fase 5 (reposição, oportunidades entre empresas, base de preço).
-- Parâmetros por empresa/família/produto só de quem classifica, com justificativa, validação e auditoria
-- (antes e depois); o motor lê os parâmetros da execução; lista da reposição com custo só para quem vê
-- custo; oportunidades só para quem acessa as duas empresas e só da execução publicada das duas; lotes
-- inválidos recusados; base de preço só com custo; dados oficiais intocados.
-- Empresas, produtos e usuários sintéticos; tudo é desfeito no fim. Banco de TESTE.
begin;
do $$
declare
  t date := stock_internal.as_of();
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid(); cd uuid := gen_random_uuid();
  su uuid := gen_random_uuid(); ve uuid := gen_random_uuid(); v2 uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'Fase 5 A (teste)', 'intel5a-' || ca, 'OMIE_SHADOW', 'commercial_base', false),
    (cb, 'Fase 5 B (teste)', 'intel5b-' || cb, 'OMIE_SHADOW', 'commercial_base', false),
    (cd, 'Fase 5 DEMO', 'intel5d-' || cd, 'OMIE_SHADOW', 'commercial_base', true);
  insert into auth.users (id, email, created_at) values
    (su, 'intel5-su-' || su || '@invalid.example', now()), (ve, 'intel5-ve-' || ve || '@invalid.example', now()),
    (v2, 'intel5-v2-' || v2 || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values (su, 'intel5-su@x', 'Super Fase5'), (ve, 'intel5-ve@x', 'Vendedor Fase5'),
    (v2, 'intel5-v2@x', 'Vendedor Duas Empresas');
  insert into public.user_roles (user_id, role) values (su, 'SUPER_ADMIN'), (ve, 'VENDEDOR'), (v2, 'VENDEDOR');
  insert into public.user_company_access (user_id, company_id) values (ve, ca), (v2, ca), (v2, cb);
  insert into public.products (company_id, name, category, base_price, sku, source, external_id) values
    (ca, 'Cadeira X', 'Cadeiras', 0, 'F5-X', 'omie', '501'), (ca, 'Mesa Y', 'Mesas', 0, 'F5-Y', 'omie', '502'),
    (cb, 'Cadeira X', 'Cadeiras', 0, 'F5-X', 'omie', '601');
  insert into private.stock_readings (id, company_id, kind, trigger, status, position_date, pages_total, pages_done,
      records_expected, records_received, locations, attempts, finished_at) values
    (ra, ca, 'close', 'manual', 'complete', t, 1, 1, 2, 2, '{"1": {"name": "Depósito"}}', 1, now()),
    (rb, cb, 'close', 'manual', 'complete', t, 1, 1, 1, 1, '{"1": {"name": "Depósito"}}', 1, now());
  insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
      physical_qty, reserved_qty, pending_qty, unit_cost, sale_price) values
    (ra, ca, '501', '1', 'F5-X', 'Cadeira X', 100, 0, 0, 40, 90), (ra, ca, '502', '1', 'F5-Y', 'Mesa Y', 2, 0, 0, 200, 500),
    (rb, cb, '601', '1', 'F5-X', 'Cadeira X', 0, 0, 0, 40, 90);
  insert into private.stock_current (company_id, reading_id, published_at) values (ca, ra, now()), (cb, rb, now());
  update private.feature_flags set mode = 'on' where key = 'stock';
  perform set_config('f5.ca', ca::text, true);
  perform set_config('f5.cb', cb::text, true);
  perform set_config('f5.cd', cd::text, true);
  perform set_config('f5.su', su::text, true);
  perform set_config('f5.ve', ve::text, true);
  perform set_config('f5.v2', v2::text, true);
end $$;
select set_config('f5.official', (select json_build_object(
  'positions', (select count(*) from private.stock_positions), 'products', (select count(*) from public.products),
  'movements', (select count(*) from private.stock_movements), 'manual', (select count(*) from private.stock_curves))::text), true);

-- 1. Parâmetros: Super admin define; validações; vendedor (sem classificar) não define.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('f5.ca'); bad text[];
begin
  v := public.stock_intel_set_replenishment(ca, 'empresa', '', '{"leadTimeDays": 20}', 'Prazo médio do fornecedor principal');
  if not (v->>'saved')::boolean then raise exception 'FALHOU: parâmetro da empresa'; end if;
  perform public.stock_intel_set_replenishment(ca, 'produto', '502', '{"leadTimeDays": 45, "reviewDays": 15, "serviceLevel": 0.95, "minLot": 5}',
    'Mesa importada, prazo maior');
  perform public.stock_intel_set_replenishment(ca, 'produto', '502', '{"leadTimeDays": 60, "reviewDays": 15, "serviceLevel": 0.95, "minLot": 5}',
    'Fornecedor avisou atraso');
  begin
    perform public.stock_intel_set_replenishment(ca, 'produto', '502', '{"leadTimeDays": 400}', 'Prazo inválido de teste');
    raise exception 'FALHOU: prazo acima de 365 aceito';
  exception when others then if sqlerrm not like '%Prazo de 1 a 365%' then raise; end if; end;
  begin
    perform public.stock_intel_set_replenishment(ca, 'empresa', '', '{"leadTimeDays": 10, "serviceLevel": 0.5}', 'Nível inexistente');
    raise exception 'FALHOU: nível de serviço fora da lista aceito';
  exception when others then if sqlerrm not like '%nível de serviço%' then raise; end if; end;
  begin
    perform public.stock_intel_set_replenishment(ca, 'empresa', '', '{"leadTimeDays": "dez"}', 'Texto no lugar do número');
    raise exception 'FALHOU: valor não numérico aceito';
  exception when others then if sqlerrm not like '%inválido%' then raise; end if; end;
  begin
    perform public.stock_intel_set_replenishment(ca, 'empresa', '', '{"leadTimeDays": 10}', 'curto');
    raise exception 'FALHOU: justificativa curta aceita';
  exception when others then if sqlerrm not like '%justificativa%' then raise; end if; end;
  begin
    perform public.stock_intel_set_replenishment(ca, 'produto', '999', '{"leadTimeDays": 10}', 'Produto de outra empresa');
    raise exception 'FALHOU: produto inexistente aceito';
  exception when others then if sqlerrm not like '%não encontrado%' then raise; end if; end;
  begin
    perform public.stock_intel_set_replenishment('all', 'empresa', '', '{"leadTimeDays": 10}', 'Todas as empresas de uma vez');
    raise exception 'FALHOU: parâmetro para todas as empresas aceito';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' then raise; end if; end;
  v := public.stock_intel_replenishment_params(ca);
  if not (v->>'canEdit')::boolean or jsonb_array_length(v->'rows') <> 2 or v->'rows'->1->>'sku' <> 'F5-Y'
     or (v->'rows'->1->>'leadTimeDays')::integer <> 60 or v->'rows'->1->>'updatedBy' <> 'Super Fase5' then
    raise exception 'FALHOU: lista de parâmetros: %', v;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.audit_log where action = 'stock.intel.replenishment' and actor_id = current_setting('f5.su')::uuid) <> 3
     or not exists (select 1 from public.audit_log where action = 'stock.intel.replenishment' and payload->>'change' = 'update'
                    and (payload->'before'->>'lead_time_days')::integer = 45 and (payload->'after'->>'lead_time_days')::integer = 60
                    and payload->>'reason' = 'Fornecedor avisou atraso') then
    raise exception 'FALHOU: auditoria dos parâmetros (antes, depois e justificativa)';
  end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; refused boolean := false;
begin
  begin
    perform public.stock_intel_set_replenishment(current_setting('f5.ca'), 'empresa', '', '{"leadTimeDays": 5}', 'Tentativa do vendedor');
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor definiu parâmetro de reposição'; end if;
  v := public.stock_intel_replenishment_params('all');
  if (v->>'canEdit')::boolean or jsonb_array_length(v->'rows') <> 2 then
    raise exception 'FALHOU: vendedor vê os parâmetros da empresa dele, sem editar: %', v;
  end if;
end $$;
reset role;

-- 2. Motor: parâmetros da execução; reposição e oportunidades gravadas; lotes inválidos recusados.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; p jsonb; run uuid; ca uuid := current_setting('f5.ca')::uuid; cb uuid := current_setting('f5.cb')::uuid;
begin
  v := public.stock_intel_begin('ops', 'intel-test-f5', true);
  run := (v->>'runId')::uuid;
  perform set_config('f5.run', run::text, true);
  p := public.stock_intel_planning(run);
  if jsonb_array_length(p->'replenishment') <> 2
     or not exists (select 1 from jsonb_array_elements(p->'replenishment') x
                    where x->>'scope' = 'produto' and x->>'key' = '502' and (x->>'leadTimeDays')::integer = 60
                      and (x->>'serviceLevel')::numeric = 0.95 and (x->>'minLot')::numeric = 5) then
    raise exception 'FALHOU: parâmetros entregues ao motor: %', p;
  end if;
  perform public.stock_intel_publish(run, ca, 0, jsonb_build_array(
    jsonb_build_object('omieProductId', '501', 'sku', 'F5-X', 'name', 'Cadeira X', 'state', 'possivel_excesso', 'flags', '[]'::jsonb,
      'priority', 80, 'metrics', jsonb_build_object('stock', jsonb_build_object('qty', 100, 'available', 100),
        'avgPrice', 85, 'sales', jsonb_build_object('d365', jsonb_build_object('units', 4)),
        'replenishment', jsonb_build_object('status', 'nao_comprar', 'qty', 0, 'leadTimeDays', 20, 'coverageDays', 900))),
    jsonb_build_object('omieProductId', '502', 'sku', 'F5-Y', 'name', 'Mesa Y', 'state', 'risco_ruptura', 'flags', '[]'::jsonb,
      'priority', 60, 'metrics', jsonb_build_object('stock', jsonb_build_object('qty', 2, 'available', 2),
        'replenishment', jsonb_build_object('status', 'comprar', 'qty', 15, 'leadTimeDays', 60, 'coverageDays', 10,
          'costEstimate', 3000, 'risk', 'Falta estimada.', 'explanation', 'Demanda prevista de 0,2 un./dia.')))));
  perform public.stock_intel_publish(run, cb, 0, jsonb_build_array(
    jsonb_build_object('omieProductId', '601', 'sku', 'F5-X', 'name', 'Cadeira X', 'state', 'sem_saldo', 'flags', '[]'::jsonb,
      'metrics', jsonb_build_object('stock', jsonb_build_object('qty', 0, 'available', 0),
        'replenishment', jsonb_build_object('status', 'sem_prazo', 'message', 'Prazo de reposição não informado.')))));
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
    perform public.stock_intel_planning(run);
    raise exception 'FALHOU: parâmetros de execução já encerrada';
  exception when others then if sqlerrm not like '%encerrada%' then raise; end if; end;
end $$;
reset role;

-- 3. Telas: Super admin vê custo e a oportunidade; vendedor (só a empresa A, sem custo) não vê custo nem a
--    oportunidade (que envolve a empresa B) e não recebe base de preço.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('f5.ca');
begin
  v := public.stock_intel_replenishment(jsonb_build_object('companyId', ca));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '502' or (v->'rows'->0->>'costEstimate')::numeric <> 3000
     or (v->'summary'->>'comprar')::integer <> 1 or (v->'summary'->>'naoComprar')::integer <> 1
     or (v->'summary'->>'costEstimate')::numeric <> 3000 then
    raise exception 'FALHOU: reposição do super: %', v;
  end if;
  v := public.stock_intel_replenishment(jsonb_build_object('companyId', 'all', 'status', 'sem_prazo'));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '601' then raise exception 'FALHOU: sem prazo: %', v; end if;
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
  v := public.stock_intel_set_replenishment(ca, 'produto', '502', null, 'Volta ao prazo da empresa');
  if not (v->>'removed')::boolean then raise exception 'FALHOU: remover parâmetro'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f5.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; refused boolean := false;
begin
  v := public.stock_intel_replenishment(jsonb_build_object('companyId', 'all'));
  if (v->>'total')::integer <> 1 or v->'rows'->0 ? 'costEstimate' or v->'summary'->>'costEstimate' is not null then
    raise exception 'FALHOU: vendedor não vê custo estimado: %', v;
  end if;
  v := public.stock_intel_opportunities('{}');
  if (v->>'total')::integer <> 0 then raise exception 'FALHOU: vendedor sem acesso à empresa B viu a oportunidade'; end if;
  v := public.stock_intel_product(current_setting('f5.ca'), '502');
  if v->'metrics'->'replenishment' ? 'costEstimate' or v->'metrics'->'replenishment'->>'status' <> 'comprar' then
    raise exception 'FALHOU: detalhe do vendedor com custo estimado: %', v->'metrics'->'replenishment';
  end if;
  begin
    perform public.stock_intel_price_basis('all');
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor recebeu base de preço'; end if;
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

-- 4. Nada oficial mudou.
do $$
begin
  if current_setting('f5.official') <> (select json_build_object(
    'positions', (select count(*) from private.stock_positions), 'products', (select count(*) from public.products),
    'movements', (select count(*) from private.stock_movements), 'manual', (select count(*) from private.stock_curves))::text) then
    raise exception 'FALHOU: dados oficiais mudaram com a fase 5';
  end if;
  if (select count(*) from public.audit_log where action = 'stock.intel.replenishment' and payload->>'change' = 'remove') <> 1 then
    raise exception 'FALHOU: remoção do parâmetro sem auditoria';
  end if;
  raise notice 'PASS Inteligência fase 5: parâmetros só de quem classifica (validação, justificativa, auditoria antes/depois), entregues ao motor, reposição com custo só para quem vê custo, oportunidades só da execução publicada e só para quem acessa as duas empresas, lotes inválidos e empresa DEMO recusados, base de preço só com custo, dados oficiais intocados';
end $$;
rollback;
