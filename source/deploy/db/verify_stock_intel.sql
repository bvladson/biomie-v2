\set ON_ERROR_STOP on
-- Estoque, migração 0044: BIOMIE Intelligence (fundação). Ciclo da execução do motor (desligado não
-- roda, uma por vez, extração, lotes idempotentes, nada visível antes do fim, falha mantém a execução
-- anterior, execução esquecida abandonada), foto diária e histórico de curva, dados oficiais intocados
-- e permissões. Empresa, vendas e usuários sintéticos; tudo é desfeito no fim. Banco de TESTE.
begin;
do $$
declare
  t date := stock_internal.as_of();
  ca uuid := gen_random_uuid(); su uuid := gen_random_uuid(); ve uuid := gen_random_uuid();
  s uuid := gen_random_uuid(); cu uuid := gen_random_uuid(); rd uuid := gen_random_uuid();
  p1 uuid := gen_random_uuid(); p2 uuid := gen_random_uuid(); p3 uuid := gen_random_uuid(); p4 uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'Inteligência (teste)', 'intel-' || ca, 'OMIE_SHADOW', 'commercial_base', false);
  insert into public.company_integrations (company_id, provider, status) values (ca, 'omie', 'CONNECTED');
  insert into public.channels (company_id, name) values (ca, 'varejo');
  insert into auth.users (id, email, created_at) values
    (su, 'intel-su-' || su || '@invalid.example', now()), (ve, 'intel-ve-' || ve || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values (su, 'intel-su@x', 'Super Intel'), (ve, 'intel-ve@x', 'Vendedor Intel');
  insert into public.user_roles (user_id, role) values (su, 'SUPER_ADMIN'), (ve, 'VENDEDOR');
  insert into public.user_company_access (user_id, company_id) values (ve, ca);
  insert into public.sellers (id, company_id, name) values (s, ca, 'Vendedor I');
  insert into public.customers (id, company_id, name, state, city, document) values
    (cu, ca, 'Cliente I', 'CE', 'Fortaleza', '12345678000195');
  insert into public.products (id, company_id, name, category, base_price, sku, source, external_id) values
    (p1, ca, 'Mesa vendida', 'Mesas', 0, 'SKU-3001', 'omie', '3001'),
    (p2, ca, 'Cadeira parada', 'Cadeiras', 0, 'SKU-3002', 'omie', '3002'),
    (p3, ca, 'Armário sem saldo', 'Armários', 0, 'SKU-3003', 'omie', '3003'),
    (p4, ca, 'Banco sem nada', 'Bancos', 0, 'SKU-3004', 'omie', '3004');
  insert into public.invoices (id, company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
      gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible) values
    (i1, ca, s, cu, 'I1', t - 10, 200, 'omie', 'intel-1-' || i1, 200, 200, 200, 'commercial', 'varejo', true),
    (i2, ca, s, cu, 'I2', t - 40, 100, 'omie', 'intel-2-' || i2, 100, 100, 100, 'commercial', 'varejo', true);
  insert into public.invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence) values
    (i1, ca, s, p1, 2, 200, 1), (i2, ca, s, p3, 1, 100, 1);
  insert into public.integration_sync_runs (company_id, entity, status, started_at, finished_at, period_from, period_to,
      raw_complete, canonical_complete, gold_complete) values
    (ca, 'invoices', 'SUCCESS', now() - interval '2 minutes', now() - interval '1 minute', t - 300, t, true, true, true);
  insert into private.stock_movements (company_id, movement_id, moved_on, kind, operation, canceled, omie_product_id, qty, document)
    values (ca, 1, t - 5, 'entrada', '13', false, '3001', 1, 'DEV1');
  insert into private.stock_readings (id, company_id, kind, trigger, status, position_date, pages_total, pages_done,
      records_expected, records_received, locations, attempts, finished_at)
    values (rd, ca, 'close', 'manual', 'complete', t, 1, 1, 4, 4, '{"1": {"name": "Depósito"}}', 1, now());
  insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
      physical_qty, reserved_qty, pending_qty, unit_cost, sale_price) values
    (rd, ca, '3001', '1', 'SKU-3001', 'Mesa vendida', 5, 0, 0, 10, 100),
    (rd, ca, '3002', '1', 'SKU-3002', 'Cadeira parada', 3, 0, 0, 20, 80),
    (rd, ca, '3003', '1', 'SKU-3003', 'Armário sem saldo', 0, 0, 0, 30, 150),
    (rd, ca, '3004', '1', 'SKU-3004', 'Banco sem nada', 0, 0, 0, 5, 10);
  insert into private.stock_current (company_id, reading_id, published_at) values (ca, rd, now());
  update private.feature_flags set mode = 'on' where key = 'stock';
  update private.intel_settings set enabled = false;
  perform set_config('intel.t', t::text, true);
  perform set_config('intel.ca', ca::text, true);
  perform set_config('intel.su', su::text, true);
  perform set_config('intel.ve', ve::text, true);
end $$;

-- 1. Curvas oficiais pelo worker; contagem das tabelas oficiais antes do motor.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
begin
  if public.stock_worker_refresh_curves(current_setting('intel.ca')::uuid)->>'status' <> 'ok' then
    raise exception 'FALHOU: cálculo das curvas do cenário';
  end if;
end $$;
reset role;
select set_config('intel.official', (select json_build_object(
  'auto', (select count(*) from private.stock_auto_curves), 'manual', (select count(*) from private.stock_curves),
  'positions', (select count(*) from private.stock_positions), 'invoices', (select count(*) from public.invoices),
  'items', (select count(*) from public.invoice_items), 'movements', (select count(*) from private.stock_movements),
  'facts', (select count(*) from private.stock_product_facts))::text), true);

-- 2. Desligado não roda; forçado roda; uma execução por vez; pedido inválido recusado.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb;
begin
  v := public.stock_intel_begin('schedule', 'intel-test', false);
  if (v->>'started')::boolean or v->>'reason' not like '%desligado%' then
    raise exception 'FALHOU: motor desligado não deveria rodar: %', v;
  end if;
  v := public.stock_intel_begin('ops', 'intel-test', true);
  if not (v->>'started')::boolean or not exists (select 1 from jsonb_array_elements(v->'companies') c
                                                  where c->>'id' = current_setting('intel.ca')) then
    raise exception 'FALHOU: execução forçada deveria começar com a empresa do teste: %', v;
  end if;
  perform set_config('intel.run1', v->>'runId', true);
  v := public.stock_intel_begin('ops', 'intel-test', true);
  if (v->>'started')::boolean or v->>'reason' not like '%andamento%' then
    raise exception 'FALHOU: segunda execução simultânea deveria ser recusada: %', v;
  end if;
  begin
    perform public.stock_intel_begin('qualquer', 'intel-test', true);
    raise exception 'FALHOU: gatilho inválido aceito';
  exception when others then if sqlerrm not like '%inválido%' then raise; end if; end;
end $$;

-- 3. Extração: produtos relevantes, vendas da base da página Produtos, devoluções, foto e histórico.
--    (As chamadas do motor rodam como service_role; as conferências nas tabelas privadas, que o
--    service_role não enxerga, rodam depois de "reset role".)
do $$
declare
  e jsonb;
  ca uuid := current_setting('intel.ca')::uuid;
  t date := current_setting('intel.t')::date;
  ids text;
begin
  e := public.stock_intel_extract(current_setting('intel.run1')::uuid, ca);
  select string_agg(p->>'omieProductId', ',' order by p->>'omieProductId') into ids from jsonb_array_elements(e->'products') p;
  if ids <> '3001,3002,3003' then
    raise exception 'FALHOU: produtos da extração (com saldo ou venda; 3004 fica fora): %', ids;
  end if;
  if (select sum((s->>2)::numeric) from jsonb_array_elements(e->'sales') s) <> 3
     or (select sum((s->>3)::numeric) from jsonb_array_elements(e->'sales') s)
        <> (select sum(f.amount) from public.fact_sales(ca, t - 364, t) f) then
    raise exception 'FALHOU: vendas da extração diferentes da base da página Produtos: %', e->'sales';
  end if;
  if jsonb_array_length(e->'returns') <> 1 or e->'returns'->0->>0 <> '3001' then
    raise exception 'FALHOU: devolução de venda (operação 13): %', e->'returns';
  end if;
  if (select (p->>'capital')::numeric from jsonb_array_elements(e->'products') p where p->>'omieProductId' = '3002') <> 60 then
    raise exception 'FALHOU: capital a custo da cadeira (3 × 20): %', e->'products';
  end if;
  if not (e->'capture'->>'captured')::boolean or (e->'capture'->>'day')::date <> t then
    raise exception 'FALHOU: foto diária não registrada: %', e->'capture';
  end if;
end $$;
reset role;
do $$
declare
  ca uuid := current_setting('intel.ca')::uuid;
  t date := current_setting('intel.t')::date;
begin
  if not exists (select 1 from private.stock_snapshots s where s.company_id = ca and s.day = t
                 and (s.totals->'D'->>'capital')::numeric = 60 and (s.totals->'A'->>'products')::integer = 1) then
    raise exception 'FALHOU: foto diária por curva: %', (select totals from private.stock_snapshots where company_id = ca);
  end if;
  if (select string_agg(h.omie_product_id || h.curve, ',' order by h.omie_product_id)
      from private.stock_curve_history h where h.company_id = ca) <> '3001A,3002D,3003A' then
    raise exception 'FALHOU: histórico de curva inicial: %',
      (select json_agg(h) from private.stock_curve_history h where h.company_id = ca);
  end if;
end $$;

-- 4. Lotes idempotentes, validados e invisíveis até o fim; o fim troca a execução de uma vez.
set local role service_role;
do $$
declare
  run uuid := current_setting('intel.run1')::uuid;
  ca uuid := current_setting('intel.ca')::uuid;
  n integer;
begin
  n := public.stock_intel_publish(run, ca, 0, jsonb_build_array(
    jsonb_build_object('omieProductId', '3001', 'sku', 'SKU-3001', 'name', 'Mesa vendida', 'state', 'saudavel',
      'flags', jsonb_build_array('devolucoes'), 'priority', 42.5, 'metrics', jsonb_build_object(
        'capital', 50, 'stock', jsonb_build_object('qty', 5, 'available', 5), 'daysWithoutSale', 10,
        'lastSale', current_setting('intel.t')::date - 10, 'cost', jsonb_build_object('unitCost', 10),
        'curve', jsonb_build_object('current', 'A', 'source', 'auto', 'revenue12m', 200),
        'sales', jsonb_build_object('d365', jsonb_build_object('units', 2, 'revenue', 200)))),
    jsonb_build_object('omieProductId', '3002', 'sku', 'SKU-3002', 'name', 'Cadeira parada',
      'state', 'historico_insuficiente', 'flags', jsonb_build_array('custo_provisorio'), 'priority', 61,
      'priorityParts', jsonb_build_object('capital', 1, 'idle', 0.05, 'coverage', 1, 'trend', 0,
        'weights', jsonb_build_object('capital', 0.4, 'idle', 0.3, 'coverage', 0.15, 'trend', 0.15)),
      'metrics', jsonb_build_object(
        'capital', 60, 'stock', jsonb_build_object('qty', 3, 'available', 3), 'daysWithoutSale', 20,
        'lastSale', null, 'cost', jsonb_build_object('unitCost', 20),
        'curve', jsonb_build_object('current', 'D', 'source', 'auto')))));
  n := n + public.stock_intel_publish(run, ca, 1, '[{"omieProductId": "3003", "state": "sem_saldo", "flags": [], "priority": null, "metrics": {}}]');
  n := n + public.stock_intel_publish(run, ca, 1, '[{"omieProductId": "3003", "state": "sem_saldo", "flags": ["demanda_recente"], "priority": null, "metrics": {}}]');
  begin
    perform public.stock_intel_publish(run, ca, 2, '[{"omieProductId": "3004", "state": "inventado", "metrics": {}}]');
    raise exception 'FALHOU: estado inválido aceito';
  exception when check_violation then null; end;
  begin
    perform public.stock_intel_publish(run, ca, 2, '[{"omieProductId": "3004", "state": "novo", "priority": 150, "metrics": {}}]');
    raise exception 'FALHOU: prioridade acima de 100 aceita';
  exception when check_violation then null; end;
end $$;
reset role;
do $$
declare
  run uuid := current_setting('intel.run1')::uuid;
  ca uuid := current_setting('intel.ca')::uuid;
begin
  if (select count(*) from private.intel_product_metrics m where m.run_id = run) <> 3
     or (select flags from private.intel_product_metrics m where m.run_id = run and m.omie_product_id = '3003') <> '{demanda_recente}' then
    raise exception 'FALHOU: lote repetido deveria substituir, não duplicar';
  end if;
  if exists (select 1 from private.intel_current c where c.company_id = ca) then
    raise exception 'FALHOU: resultado visível antes do fim da execução';
  end if;
end $$;
set local role service_role;
do $$
declare
  run uuid := current_setting('intel.run1')::uuid;
  ca uuid := current_setting('intel.ca')::uuid;
begin
  if not (public.stock_intel_finish(run, '{"teste": true}')->>'published')::boolean then
    raise exception 'FALHOU: fim da execução deveria publicar';
  end if;
  begin
    perform public.stock_intel_publish(run, ca, 0, '[]');
    raise exception 'FALHOU: gravou numa execução encerrada';
  exception when others then if sqlerrm not like '%encerrada%' then raise; end if; end;
end $$;
reset role;
do $$
declare
  run uuid := current_setting('intel.run1')::uuid;
  ca uuid := current_setting('intel.ca')::uuid;
begin
  if (select c.run_id from private.intel_current c where c.company_id = ca) <> run
     or (select r.status from private.intel_runs r where r.id = run) <> 'published' then
    raise exception 'FALHOU: fim da execução deveria trocar a execução em uso';
  end if;
end $$;

-- 5. Falha mantém a execução anterior; falha atrasada não apaga o que já foi publicado;
--    execução esquecida (sem fim há mais de 2 horas) é abandonada.
set local role service_role;
do $$
declare
  ca uuid := current_setting('intel.ca')::uuid;
  run2 uuid;
begin
  run2 := (public.stock_intel_begin('ops', 'intel-test', true)->>'runId')::uuid;
  perform set_config('intel.run2', run2::text, true);
  perform public.stock_intel_publish(run2, ca, 0, '[{"omieProductId": "3001", "state": "novo", "priority": 1, "metrics": {}}]');
  perform public.stock_intel_fail(run2, 'falha simulada');
  perform public.stock_intel_fail(current_setting('intel.run1')::uuid, 'aviso atrasado');
end $$;
reset role;
do $$
declare
  ca uuid := current_setting('intel.ca')::uuid;
  run1 uuid := current_setting('intel.run1')::uuid;
  run2 uuid := current_setting('intel.run2')::uuid;
begin
  if (select r.status from private.intel_runs r where r.id = run2) <> 'failed'
     or exists (select 1 from private.intel_product_metrics m where m.run_id = run2)
     or (select c.run_id from private.intel_current c where c.company_id = ca) <> run1 then
    raise exception 'FALHOU: falha deveria manter a execução anterior e apagar a nova';
  end if;
  if (select r.status from private.intel_runs r where r.id = run1) <> 'published'
     or (select count(*) from private.intel_product_metrics m where m.run_id = run1) <> 3 then
    raise exception 'FALHOU: falha atrasada apagou uma execução publicada';
  end if;
  insert into private.intel_runs (trigger, algorithm_version, status, as_of, started_at)
    values ('ops', 'esquecida', 'running', current_setting('intel.t')::date, now() - interval '3 hours');
end $$;
set local role service_role;
do $$
declare v jsonb;
begin
  v := public.stock_intel_begin('ops', 'intel-test', true);
  if not (v->>'started')::boolean then
    raise exception 'FALHOU: execução esquecida deveria ser abandonada e a nova começar: %', v;
  end if;
  perform public.stock_intel_fail((v->>'runId')::uuid, 'fim do teste');
end $$;
reset role;
do $$
begin
  if exists (select 1 from private.intel_runs r where r.algorithm_version = 'esquecida' and r.status <> 'abandoned') then
    raise exception 'FALHOU: execução esquecida deveria ficar como abandonada';
  end if;
end $$;

-- 6. Dados oficiais intocados pelo motor.
do $$
begin
  if current_setting('intel.official')::jsonb <> (select jsonb_build_object(
      'auto', (select count(*) from private.stock_auto_curves), 'manual', (select count(*) from private.stock_curves),
      'positions', (select count(*) from private.stock_positions), 'invoices', (select count(*) from public.invoices),
      'items', (select count(*) from public.invoice_items), 'movements', (select count(*) from private.stock_movements),
      'facts', (select count(*) from private.stock_product_facts))) then
    raise exception 'FALHOU: o motor alterou dados oficiais';
  end if;
end $$;

-- 6b. Painel: cards e distribuição da janela, radar, estados, prioridades, lista, produto e Pareto;
--     custo e faturamento só para quem pode ver custo; exportação só para quem pode exportar.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('intel.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v jsonb;
  ca text := current_setting('intel.ca');
begin
  v := public.stock_intel_overview(ca, '12m');
  if (v->'capital'->>'total')::numeric <> 110 or (v->'capital'->'byCurve'->'A'->>'capital')::numeric <> 50
     or (v->'capital'->'byCurve'->'D'->>'capital')::numeric <> 60 or (v->'capital'->>'cdShare')::numeric <> 0.5455
     or (v->'capital'->'negative'->>'positions')::integer <> 0 then
    raise exception 'FALHOU: capital por curva da janela (Super admin): %', v->'capital';
  end if;
  if (select (r->>'products')::integer from jsonb_array_elements(v->'radar') r where r->>'band' = '0-30') <> 1
     or (select (r->>'capital')::numeric from jsonb_array_elements(v->'radar') r where r->>'band' = 'insuficiente') <> 60
     or jsonb_array_length(v->'radar') <> 7 then
    raise exception 'FALHOU: radar de tempo sem venda: %', v->'radar';
  end if;
  if v->'top'->0->>'omieProductId' <> '3002' or jsonb_array_length(v->'top') <> 2
     or jsonb_array_length(v->'states') <> 3 or jsonb_array_length(v->'evolution') <> 1
     or (v->'evolution'->0->'capital'->>'D')::numeric <> 60 then
    raise exception 'FALHOU: prioridades, estados ou evolução: % % %', v->'top', v->'states', v->'evolution';
  end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca));
  if (v->>'total')::integer <> 3 or v->'rows'->0->>'omieProductId' <> '3002' then
    raise exception 'FALHOU: lista por prioridade: %', v;
  end if;
  if (public.stock_intel_products(jsonb_build_object('companyId', ca, 'state', 'sem_saldo'))->'rows'->0->>'omieProductId') <> '3003'
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'search', 'Cadeira'))->>'total')::integer <> 1
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'curve', 'A'))->>'total')::integer <> 1
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'band', 'insuficiente'))->>'total')::integer <> 1
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'flag', 'devolucoes'))->>'total')::integer <> 1
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'page', -1))->>'total')::integer <> 3
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'minIdle', 30))->>'total')::integer <> 0
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'minIdle', 30, 'sortBy', 'daysWithoutSale'))->>'total')::integer <> 0 then
    raise exception 'FALHOU: filtros da lista';
  end if;
  begin
    perform public.stock_intel_products(jsonb_build_object('companyId', ca, 'sortBy', 'qualquer'));
    raise exception 'FALHOU: ordenação inválida aceita';
  exception when others then if sqlerrm not like '%Consulta inválida%' then raise; end if; end;
  if (public.stock_intel_product(ca, '3002')->'metrics'->>'capital')::numeric <> 60 then
    raise exception 'FALHOU: produto com custo para o Super admin';
  end if;
  -- 0045: sinais de custo e explicação da prioridade continuam visíveis para quem vê custo.
  if (public.stock_intel_products(jsonb_build_object('companyId', ca, 'flag', 'custo_provisorio'))->>'total')::integer <> 1
     or not (public.stock_intel_product(ca, '3002')->'flags') ? 'custo_provisorio'
     or public.stock_intel_product(ca, '3002')->'priorityParts' = 'null'::jsonb
     or (public.stock_intel_overview(ca, '12m')->'capital'->'byCurve'->'D'->>'unknownCost') is null then
    raise exception 'FALHOU: Super admin deveria ver sinais de custo, explicação da prioridade e produtos sem custo';
  end if;
  v := public.stock_intel_pareto(ca, '12m');
  if (v->>'total')::numeric <> 300 or jsonb_array_length(v->'rows') <> 2 or v->'rows'->0->>1 <> '3001'
     or (v->'rows'->0->>6)::numeric <> 0.666667 or v->'limits' <> '[80, 95]'::jsonb then
    raise exception 'FALHOU: Pareto da empresa: %', v;
  end if;
  begin
    perform public.stock_intel_pareto('all', '12m');
    raise exception 'FALHOU: Pareto de todas as empresas aceito';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' then raise; end if; end;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('intel.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v jsonb;
  ca text := current_setting('intel.ca');
begin
  v := public.stock_intel_overview(ca, '12m');
  if v->'capital'->'total' <> 'null'::jsonb or v->'capital'->'byCurve'->'A'->'capital' <> 'null'::jsonb
     or (v->'capital'->'byCurve'->'A'->>'products')::integer <> 1 or v->'top'->0->'capital' <> 'null'::jsonb then
    raise exception 'FALHOU: vendedor não pode ver capital: %', v->'capital';
  end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca, 'sortBy', 'capital'));
  if v->'rows'->0->'capital' <> 'null'::jsonb or v->'rows'->0->'revenue365' <> 'null'::jsonb then
    raise exception 'FALHOU: lista do vendedor com custo ou faturamento: %', v->'rows'->0;
  end if;
  v := public.stock_intel_product(ca, '3001');
  if v->'metrics' ? 'capital' or v->'metrics' ? 'cost' or v->'metrics'->'curve' ? 'revenue12m'
     or v->'metrics'->'sales'->'d365' ? 'revenue' or v->'metrics'->'sales'->'d365'->>'units' <> '2' then
    raise exception 'FALHOU: produto do vendedor deveria vir sem custo e sem faturamento: %', v->'metrics';
  end if;
  -- 0045: sinal de custo ("até R$ 1"), explicação da prioridade (capital) e sem custo por curva: não.
  v := public.stock_intel_product(ca, '3002');
  if v->'flags' <> '[]'::jsonb or v->'priorityParts' <> 'null'::jsonb then
    raise exception 'FALHOU: vendedor viu sinal de custo ou a explicação da prioridade: % %', v->'flags', v->'priorityParts';
  end if;
  if exists (select 1 from jsonb_array_elements(public.stock_intel_products(jsonb_build_object('companyId', ca))->'rows') r
             where r->'flags' ? 'custo_provisorio' or r->'priorityParts' <> 'null'::jsonb)
     or public.stock_intel_overview(ca, '12m')->'capital'->'byCurve'->'D'->'unknownCost' <> 'null'::jsonb then
    raise exception 'FALHOU: lista ou painel do vendedor com sinal de custo';
  end if;
  begin
    perform public.stock_intel_products(jsonb_build_object('companyId', ca, 'flag', 'custo_provisorio'));
    raise exception 'FALHOU: vendedor filtrou por sinal de custo';
  exception when others then if sqlerrm not like '%custos%' then raise; end if; end;
  begin
    perform public.stock_intel_products(jsonb_build_object('companyId', ca, 'page', -1));
    raise exception 'FALHOU: vendedor exportou';
  exception when others then if sqlerrm not like '%exportar%' then raise; end if; end;
  begin
    perform public.stock_intel_pareto(ca, '12m');
    raise exception 'FALHOU: vendedor viu o Pareto do faturamento';
  exception when others then if sqlerrm not like '%custos%' then raise; end if; end;
end $$;
reset role;

-- 6c. Fronteiras: o radar e o filtro "sem venda há mais de N dias" usam a mesma regra (30 dias
--     ficam na faixa 0–30 e fora de "mais de 30"; 31 entram), para o card e a lista baterem.
do $$
declare t date := current_setting('intel.t')::date;
begin
  if stock_internal.intel_band(30, t, 'saudavel') <> '0-30' or stock_internal.intel_band(31, t, 'saudavel') <> '31-60'
     or stock_internal.intel_band(180, t, 'saudavel') <> '91-180' or stock_internal.intel_band(181, t, 'saudavel') <> '181-365'
     or stock_internal.intel_band(365, t, 'saudavel') <> '181-365' or stock_internal.intel_band(366, t, 'saudavel') <> '365+'
     or stock_internal.intel_band(29, null, 'sem_venda_janela') <> 'insuficiente'
     or stock_internal.intel_band(400, null, 'novo') <> 'insuficiente'
     or stock_internal.intel_band(null, null, 'saudavel') <> 'insuficiente' then
    raise exception 'FALHOU: fronteiras das faixas do radar';
  end if;
end $$;
update private.intel_product_metrics m set metrics = jsonb_set(m.metrics, '{daysWithoutSale}', '30')
  where m.run_id = current_setting('intel.run1')::uuid and m.omie_product_id = '3001';
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('intel.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare ca text := current_setting('intel.ca');
begin
  if (public.stock_intel_products(jsonb_build_object('companyId', ca, 'minIdle', 30))->>'total')::integer <> 0
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'band', '0-30'))->>'total')::integer <> 1 then
    raise exception 'FALHOU: 30 dias sem venda não é "mais de 30 dias"';
  end if;
end $$;
reset role;
update private.intel_product_metrics m set metrics = jsonb_set(m.metrics, '{daysWithoutSale}', '31')
  where m.run_id = current_setting('intel.run1')::uuid and m.omie_product_id = '3001';
set local role authenticated;
do $$
declare ca text := current_setting('intel.ca');
begin
  if (public.stock_intel_products(jsonb_build_object('companyId', ca, 'minIdle', 30))->'rows'->0->>'omieProductId') is distinct from '3001'
     or (public.stock_intel_products(jsonb_build_object('companyId', ca, 'band', '31-60'))->>'total')::integer <> 1
     or (select (r->>'products')::integer from jsonb_array_elements(public.stock_intel_overview(ca, '12m')->'radar') r
         where r->>'band' = '31-60') <> 1 then
    raise exception 'FALHOU: 31 dias sem venda deveria entrar em "mais de 30 dias" e na faixa 31–60';
  end if;
end $$;
reset role;
update private.intel_product_metrics m set metrics = jsonb_set(m.metrics, '{daysWithoutSale}', '10')
  where m.run_id = current_setting('intel.run1')::uuid and m.omie_product_id = '3001';

-- 7. Foto do mesmo dia é idempotente e registra a curva efetiva (manual prevalece).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('intel.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  perform public.stock_set_curve(array[current_setting('intel.ca') || ':3002:*'], 'A', 'Teste automático do histórico');
end $$;
reset role;
do $$
declare ca uuid := current_setting('intel.ca')::uuid;
begin
  perform stock_internal.intel_capture(ca);
  perform stock_internal.intel_capture(ca);
  if (select count(*) from private.stock_curve_history h where h.company_id = ca) <> 3
     or (select h.curve || h.source from private.stock_curve_history h
         where h.company_id = ca and h.omie_product_id = '3002') <> 'Amanual'
     or (select count(*) from private.stock_snapshots s where s.company_id = ca) <> 1
     or (select (s.totals->'A'->>'products')::integer from private.stock_snapshots s where s.company_id = ca) <> 2 then
    raise exception 'FALHOU: foto idempotente com a curva manual: % %',
      (select json_agg(h) from private.stock_curve_history h where h.company_id = ca),
      (select totals from private.stock_snapshots where company_id = ca);
  end if;
end $$;

-- 8. Permissões: só o service_role chama o motor; a situação é lida por quem vê o Estoque e o
--    motivo de falha só aparece para o Super admin.
do $$
begin
  if has_function_privilege('authenticated', 'public.stock_intel_begin(text, text, boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.stock_intel_extract(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.stock_intel_publish(uuid, uuid, integer, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.stock_intel_finish(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.stock_intel_fail(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.stock_intel_status()', 'EXECUTE')
     or has_function_privilege('authenticated', 'stock_internal.intel_capture(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.stock_intel_begin(text, text, boolean)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.stock_intel_status()', 'EXECUTE') then
    raise exception 'FALHOU: permissões do motor';
  end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('intel.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb := public.stock_intel_status();
begin
  if (v->>'enabled')::boolean or v->'lastRun'->>'status' <> 'failed' or v->'lastRun'->'error' <> 'null'::jsonb
     or (select count(*) from jsonb_array_elements(v->'current') c where c->>'companyId' = current_setting('intel.ca')) <> 1 then
    raise exception 'FALHOU: situação do motor para o vendedor: %', v;
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('intel.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb := public.stock_intel_status();
begin
  if v->'lastRun'->>'error' <> 'fim do teste' then
    raise exception 'FALHOU: Super admin deveria ver o motivo da falha: %', v;
  end if;
end $$;
reset role;

do $$ begin raise notice 'PASS Estoque inteligência: desligado não roda, uma execução por vez, extração com a base da página Produtos, lotes idempotentes e invisíveis até o fim, falha mantém a anterior, execução esquecida abandonada, foto diária e histórico de curva, dados oficiais intocados e permissões'; end $$;
rollback;
