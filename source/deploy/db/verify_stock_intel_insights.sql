\set ON_ERROR_STOP on
-- Estoque, migração 0047: Inteligência fase 3 (diagnóstico, recomendações e alertas). Extração com
-- janela da curva, custo da análise anterior e entradas de compra em 30/90 dias (sem devolução, estorno
-- ou transferência); alertas que abrem, continuam sem repetir o aviso, mudam de gravidade (a ciência cai
-- só quando piora), resolvem e ficam como histórico; máscara de custo nos itens, na lista e no detalhe;
-- ciência só para quem classifica, com auditoria; filtros novos; dados oficiais intocados.
-- Empresa, vendas e usuários sintéticos; tudo é desfeito no fim. Banco de TESTE.
begin;
do $$
declare
  t date := stock_internal.as_of();
  ca uuid := gen_random_uuid(); su uuid := gen_random_uuid(); ve uuid := gen_random_uuid();
  s uuid := gen_random_uuid(); cu uuid := gen_random_uuid(); rd uuid := gen_random_uuid();
  p1 uuid := gen_random_uuid(); p2 uuid := gen_random_uuid(); p3 uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'Inteligência fase 3 (teste)', 'intel3-' || ca, 'OMIE_SHADOW', 'commercial_base', false);
  insert into public.company_integrations (company_id, provider, status) values (ca, 'omie', 'CONNECTED');
  insert into public.channels (company_id, name) values (ca, 'varejo');
  insert into auth.users (id, email, created_at) values
    (su, 'intel3-su-' || su || '@invalid.example', now()), (ve, 'intel3-ve-' || ve || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values (su, 'intel3-su@x', 'Super Fase3'), (ve, 'intel3-ve@x', 'Vendedor Fase3');
  insert into public.user_roles (user_id, role) values (su, 'SUPER_ADMIN'), (ve, 'VENDEDOR');
  insert into public.user_company_access (user_id, company_id) values (ve, ca);
  insert into public.sellers (id, company_id, name) values (s, ca, 'Vendedor F3');
  insert into public.customers (id, company_id, name, state, city, document) values
    (cu, ca, 'Cliente F3', 'CE', 'Fortaleza', '12345678000195');
  insert into public.products (id, company_id, name, category, base_price, sku, source, external_id) values
    (p1, ca, 'Mesa vendida', 'Mesas', 0, 'F3-3001', 'omie', '3001'),
    (p2, ca, 'Cadeira parada', 'Cadeiras', 0, 'F3-3002', 'omie', '3002'),
    (p3, ca, 'Armário sem saldo', 'Armários', 0, 'F3-3003', 'omie', '3003');
  insert into public.invoices (id, company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
      gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible) values
    (i1, ca, s, cu, 'F1', t - 10, 200, 'omie', 'intel3-1-' || i1, 200, 200, 200, 'commercial', 'varejo', true),
    (i2, ca, s, cu, 'F2', t - 40, 100, 'omie', 'intel3-2-' || i2, 100, 100, 100, 'commercial', 'varejo', true);
  insert into public.invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence) values
    (i1, ca, s, p1, 2, 200, 1), (i2, ca, s, p3, 1, 100, 1);
  insert into public.integration_sync_runs (company_id, entity, status, started_at, finished_at, period_from, period_to,
      raw_complete, canonical_complete, gold_complete) values
    (ca, 'invoices', 'SUCCESS', now() - interval '2 minutes', now() - interval '1 minute', t - 300, t, true, true, true);
  -- Movimentações de 3002: compra de 4 (conta), compra de 9 estornada (não conta), transferência entre
  -- locais 6+6 (não conta), devolução de venda 1 (não é compra), compra de 3 há 60 dias (só nos 90 dias).
  insert into private.stock_movement_jobs (company_id, trigger, period_from, period_to, status)
    values (ca, 'backfill', t - 400, t, 'complete');
  insert into private.stock_movements (company_id, movement_id, moved_on, kind, operation, canceled, omie_product_id, qty, document)
    values (ca, 1, t - 10, 'entrada', '21', false, '3002', 4, 'NF-C1'),
           (ca, 2, t - 12, 'entrada', '21', false, '3002', 9, 'NF-C2'),
           (ca, 3, t - 11, 'saida', '21', true, '3002', -9, 'NF-C2'),
           (ca, 4, t - 8, 'saida', '00', false, '3002', -6, null),
           (ca, 5, t - 8, 'entrada', '00', false, '3002', 6, null),
           (ca, 6, t - 5, 'entrada', '13', false, '3002', 1, 'DEV1'),
           (ca, 7, t - 60, 'entrada', '21', false, '3002', 3, 'NF-C3');
  insert into private.stock_readings (id, company_id, kind, trigger, status, position_date, pages_total, pages_done,
      records_expected, records_received, locations, attempts, finished_at)
    values (rd, ca, 'close', 'manual', 'complete', t, 1, 1, 3, 3, '{"1": {"name": "Depósito"}}', 1, now());
  insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
      physical_qty, reserved_qty, pending_qty, unit_cost, sale_price) values
    (rd, ca, '3001', '1', 'F3-3001', 'Mesa vendida', 5, 0, 0, 10, 100),
    (rd, ca, '3002', '1', 'F3-3002', 'Cadeira parada', 3, 0, 0, 20, 80),
    (rd, ca, '3003', '1', 'F3-3003', 'Armário sem saldo', 0, 0, 0, 30, 150);
  insert into private.stock_current (company_id, reading_id, published_at) values (ca, rd, now());
  update private.feature_flags set mode = 'on' where key = 'stock';
  update private.intel_settings set enabled = false;
  perform set_config('f3.t', t::text, true);
  perform set_config('f3.ca', ca::text, true);
  perform set_config('f3.su', su::text, true);
  perform set_config('f3.ve', ve::text, true);
end $$;

select set_config('f3.official', (select json_build_object(
  'positions', (select count(*) from private.stock_positions), 'invoices', (select count(*) from public.invoices),
  'items', (select count(*) from public.invoice_items), 'movements', (select count(*) from private.stock_movements),
  'manual', (select count(*) from private.stock_curves))::text), true);

-- Linhas como o motor publica (diagnósticos, recomendações e alertas dentro dos indicadores).
create function pg_temp.f3_rows(p_sev3001 text, p_alert3002 boolean, p_alert3003 boolean) returns jsonb
language sql as $$
  select jsonb_build_array(
    jsonb_build_object('omieProductId', '3001', 'sku', 'F3-3001', 'name', 'Mesa vendida', 'state', 'saudavel',
      'flags', jsonb_build_array('demanda_em_queda'), 'priority', 30,
      'metrics', jsonb_build_object('capital', 50, 'cost', jsonb_build_object('unitCost', 10, 'known', true),
        'stock', jsonb_build_object('qty', 5), 'curve', jsonb_build_object('current', 'A'), 'daysWithoutSale', 10,
        'diagnoses', jsonb_build_array(jsonb_build_object('rule', 'D03', 'code', 'demanda_em_queda', 'severity', 'media',
          'title', 'Demanda em queda', 'text', 'Vendas caíram.',
          'evidence', jsonb_build_array(jsonb_build_object('key', 'trend60Pct', 'value', -60, 'unit', '%')))),
        'recommendations', jsonb_build_array(jsonb_build_object('rule', 'R02', 'type', 'rever_compras',
          'action', 'Rever compras planejadas', 'why', 'Queda', 'evidence', '[]'::jsonb, 'limitations', '[]'::jsonb)),
        'alerts', case when p_sev3001 is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'rule', 'A01', 'kind', 'queda_abrupta_vendas', 'severity', p_sev3001, 'reason', 'Vendas caíram 60%.',
          'evidence', jsonb_build_array(jsonb_build_object('key', 'trend60Pct', 'value', -60, 'unit', '%')))) end)),
    jsonb_build_object('omieProductId', '3002', 'sku', 'F3-3002', 'name', 'Cadeira parada', 'state', 'sem_venda_janela',
      'flags', jsonb_build_array('custo_provisorio'), 'priority', 70,
      'metrics', jsonb_build_object('capital', 60, 'cost', jsonb_build_object('unitCost', 20, 'known', true),
        'stock', jsonb_build_object('qty', 3), 'curve', jsonb_build_object('current', 'D'), 'daysWithoutSale', 120,
        'diagnoses', jsonb_build_array(
          jsonb_build_object('rule', 'D10', 'code', 'custo_provisorio', 'severity', 'media', 'title', 'Custo provisório',
            'text', 'Custo muito baixo.', 'requiresCost', true, 'evidence',
            jsonb_build_array(jsonb_build_object('key', 'cost.unitCost', 'value', 20, 'unit', 'R$', 'cost', true))),
          jsonb_build_object('rule', 'D04', 'code', 'sem_venda_prolongada', 'severity', 'media', 'title', 'Sem venda na janela',
            'text', 'Sem vendas há 120 dias.', 'evidence', jsonb_build_array(
              jsonb_build_object('key', 'daysWithoutSale', 'value', 120, 'unit', 'dias'),
              jsonb_build_object('key', 'capital', 'value', 60, 'unit', 'R$', 'cost', true)))),
        'recommendations', jsonb_build_array(
          jsonb_build_object('rule', 'R04', 'type', 'nao_comprar', 'action', 'Não comprar agora', 'why', 'Parado',
            'evidence', '[]'::jsonb, 'limitations', '[]'::jsonb),
          jsonb_build_object('rule', 'R06', 'type', 'conferir_custo', 'action', 'Conferir o custo', 'why', 'Custo',
            'evidence', '[]'::jsonb, 'limitations', '[]'::jsonb, 'requiresCost', true)),
        'alerts', case when p_alert3002 then jsonb_build_array(jsonb_build_object('rule', 'A03', 'kind', 'custo_mudou',
          'severity', 'media', 'reason', 'O custo mudou 100%.', 'requiresCost', true, 'evidence', jsonb_build_array(
            jsonb_build_object('key', 'cost.unitCost', 'value', 20, 'unit', 'R$', 'cost', true),
            jsonb_build_object('key', 'costChangePct', 'value', 100, 'unit', '%')))) else '[]'::jsonb end)),
    jsonb_build_object('omieProductId', '3003', 'sku', 'F3-3003', 'name', 'Armário sem saldo', 'state', 'sem_saldo',
      'flags', '[]'::jsonb, 'priority', null,
      'metrics', jsonb_build_object('stock', jsonb_build_object('qty', 0), 'curve', jsonb_build_object('current', 'A'),
        'diagnoses', '[]'::jsonb, 'recommendations', '[]'::jsonb,
        'alerts', case when p_alert3003 then jsonb_build_array(jsonb_build_object('rule', 'A07', 'kind', 'parou_de_vender',
          'severity', 'media', 'reason', 'Parou de vender.', 'evidence', '[]'::jsonb)) else '[]'::jsonb end)))
$$;
grant execute on function pg_temp.f3_rows(text, boolean, boolean) to service_role;

-- 1. Curvas oficiais; execução 1 com os campos novos da extração; alertas abertos no fim.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; e jsonb; p jsonb; ca uuid := current_setting('f3.ca')::uuid; t date := current_setting('f3.t')::date;
begin
  if public.stock_worker_refresh_curves(ca)->>'status' <> 'ok' then raise exception 'FALHOU: curvas do cenário'; end if;
  v := public.stock_intel_begin('ops', 'intel-test-f3', true);
  if not (v->>'started')::boolean then raise exception 'FALHOU: execução 1 não começou: %', v; end if;
  perform set_config('f3.run1', v->>'runId', true);
  if (v->'params'->>'abruptDropPct')::numeric <> -50 or (v->'params'->>'alertsKeptDays')::integer <> 180 then
    raise exception 'FALHOU: parâmetros novos da fase 3: %', v->'params';
  end if;
  e := public.stock_intel_extract((v->>'runId')::uuid, ca);
  if (e->>'movementsFrom')::date <> t - 400 then raise exception 'FALHOU: movementsFrom %', e->>'movementsFrom'; end if;
  select x into p from jsonb_array_elements(e->'products') x where x->>'omieProductId' = '3002';
  if (p->>'received30')::numeric is distinct from 4 or (p->>'received90')::numeric is distinct from 7 then
    raise exception 'FALHOU: entradas de compra (30 = 4 e 90 = 7, sem estorno, transferência ou devolução): %/%',
      p->>'received30', p->>'received90';
  end if;
  if p ? 'prevUnitCost' and p->>'prevUnitCost' is not null then raise exception 'FALHOU: sem análise anterior, custo anterior deveria ser nulo'; end if;
  select x into p from jsonb_array_elements(e->'products') x where x->>'omieProductId' = '3001';
  if (p->>'curveWindowStart')::date <> t - 364 then raise exception 'FALHOU: janela da curva %', p->>'curveWindowStart'; end if;
  perform public.stock_intel_publish((v->>'runId')::uuid, ca, 0, pg_temp.f3_rows('media', true, false));
  v := public.stock_intel_finish((v->>'runId')::uuid, '{}'::jsonb);
  if (v->>'alertsSeen')::integer <> 2 or (v->>'alertsResolved')::integer <> 0 then
    raise exception 'FALHOU: execução 1 deveria abrir 2 alertas: %', v;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from private.intel_alerts where company_id = current_setting('f3.ca')::uuid and status = 'open') <> 2 then
    raise exception 'FALHOU: 2 alertas abertos depois da execução 1';
  end if;
  if not exists (select 1 from private.intel_alerts where company_id = current_setting('f3.ca')::uuid
                 and kind = 'custo_mudou' and requires_cost and first_run = current_setting('f3.run1')::uuid) then
    raise exception 'FALHOU: alerta de custo deveria vir marcado como de custo';
  end if;
end $$;

-- 2. Leitura: Super admin vê tudo; vendedor não vê alerta de custo nem evidência de custo; ciência só de
--    quem classifica, com auditoria.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f3.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; r jsonb; ca text := current_setting('f3.ca');
begin
  v := public.stock_intel_alerts(jsonb_build_object('companyId', ca));
  if (v->>'total')::integer <> 2 or (v->'summary'->>'open')::integer <> 2 or (v->'summary'->>'new')::integer <> 2 then
    raise exception 'FALHOU: super deveria ver 2 alertas novos: %', v->'summary';
  end if;
  select x into r from jsonb_array_elements(v->'rows') x where x->>'kind' = 'custo_mudou';
  if not exists (select 1 from jsonb_array_elements(r->'evidence') e where (e->>'cost')::boolean) or r->>'sku' <> 'F3-3002' then
    raise exception 'FALHOU: super deveria ver a evidência de custo e a SKU: %', r;
  end if;
  select x into r from jsonb_array_elements(v->'rows') x where x->>'kind' = 'queda_abrupta_vendas';
  perform set_config('f3.alert3001', r->>'id', true);
  v := public.stock_intel_alert_ack((r->>'id')::uuid, 'Comercial já avisado');
  if not (v->>'acknowledged')::boolean then raise exception 'FALHOU: ciência do super'; end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca, 'sortBy', 'name', 'sortDir', 'asc'));
  select x into r from jsonb_array_elements(v->'rows') x where x->>'omieProductId' = '3001';
  if r->'diagnosis'->>'code' <> 'demanda_em_queda' or r->'action'->>'type' <> 'rever_compras' or (r->>'alerts')::integer <> 1 then
    raise exception 'FALHOU: lista do super, produto 3001: %', r;
  end if;
  select x into r from jsonb_array_elements(v->'rows') x where x->>'omieProductId' = '3002';
  if r->'diagnosis'->>'code' <> 'custo_provisorio' or (r->>'alerts')::integer <> 1 then
    raise exception 'FALHOU: lista do super, produto 3002 (com itens de custo): %', r;
  end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca, 'rec', 'nao_comprar'));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '3002' then
    raise exception 'FALHOU: filtro por recomendação: %', v;
  end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca, 'withAlerts', true));
  if (v->>'total')::integer <> 2 then raise exception 'FALHOU: filtro com alerta (super): %', v->>'total'; end if;
  v := public.stock_intel_product(ca, '3002');
  if jsonb_array_length(v->'alerts') <> 1 or v->'metrics'->'diagnoses'->0->>'code' <> 'custo_provisorio' then
    raise exception 'FALHOU: detalhe do super, produto 3002: %', v->'alerts';
  end if;
  if (select (d->>3)::numeric from jsonb_array_elements(v->'movements'->'days') d
      where (d->>0)::date = current_setting('f3.t')::date - 10) is distinct from 4 then
    raise exception 'FALHOU: movimentações do produto (compra de 4 há 10 dias): %', v->'movements';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f3.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; r jsonb; ca text := current_setting('f3.ca'); refused boolean := false;
begin
  v := public.stock_intel_alerts(jsonb_build_object('companyId', ca));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'kind' <> 'queda_abrupta_vendas' or (v->'summary'->>'open')::integer <> 1 then
    raise exception 'FALHOU: vendedor não deveria ver o alerta de custo: %', v;
  end if;
  if v->'rows'->0->'acknowledged'->>'by' <> 'Super Fase3' or v->'rows'->0->'acknowledged'->>'note' <> 'Comercial já avisado' then
    raise exception 'FALHOU: ciência visível a quem vê o alerta: %', v->'rows'->0->'acknowledged';
  end if;
  begin
    perform public.stock_intel_alert_ack((v->'rows'->0->>'id')::uuid, null);
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor (sem classificar) deu ciência'; end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca, 'sortBy', 'name', 'sortDir', 'asc'));
  select x into r from jsonb_array_elements(v->'rows') x where x->>'omieProductId' = '3002';
  if r->'diagnosis'->>'code' <> 'sem_venda_prolongada' or r->'action'->>'type' <> 'nao_comprar' or (r->>'alerts')::integer <> 0 then
    raise exception 'FALHOU: lista do vendedor deveria esconder os itens de custo: %', r;
  end if;
  v := public.stock_intel_products(jsonb_build_object('companyId', ca, 'withAlerts', true));
  if (v->>'total')::integer <> 1 then raise exception 'FALHOU: filtro com alerta (vendedor): %', v->>'total'; end if;
  refused := false;
  begin
    perform public.stock_intel_products(jsonb_build_object('companyId', ca, 'rec', 'conferir_custo'));
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor filtrou por recomendação de custo'; end if;
  v := public.stock_intel_product(ca, '3002');
  if jsonb_array_length(v->'alerts') <> 0 or jsonb_array_length(v->'metrics'->'alerts') <> 0
     or jsonb_array_length(v->'metrics'->'diagnoses') <> 1 or v->'metrics'->'diagnoses'->0->>'code' <> 'sem_venda_prolongada'
     or exists (select 1 from jsonb_array_elements(v->'metrics'->'diagnoses'->0->'evidence') e where (e->>'cost')::boolean)
     or exists (select 1 from jsonb_array_elements(v->'metrics'->'recommendations') x where x->>'type' = 'conferir_custo') then
    raise exception 'FALHOU: detalhe do vendedor com custo: %', v->'metrics';
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from public.audit_log where action = 'stock.intel.alert_ack' and actor_id = current_setting('f3.su')::uuid
                 and payload->>'note' = 'Comercial já avisado') then
    raise exception 'FALHOU: ciência sem auditoria';
  end if;
end $$;

-- 3. Execução 2: 3001 piora (alta: muda e a ciência cai), o alerta de custo some (resolvido) e 3003 abre.
--    Execução 3: 3001 melhora (média: muda, mas a ciência dada depois da 2 continua).
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; e jsonb; ca uuid := current_setting('f3.ca')::uuid;
begin
  v := public.stock_intel_begin('ops', 'intel-test-f3', true);
  perform set_config('f3.run2', v->>'runId', true);
  e := public.stock_intel_extract((v->>'runId')::uuid, ca);
  if (select (x->>'prevUnitCost')::numeric from jsonb_array_elements(e->'products') x where x->>'omieProductId' = '3001') <> 10 then
    raise exception 'FALHOU: custo da análise anterior (10)';
  end if;
  perform public.stock_intel_publish((v->>'runId')::uuid, ca, 0, pg_temp.f3_rows('alta', false, true));
  v := public.stock_intel_finish((v->>'runId')::uuid, '{}'::jsonb);
  if (v->>'alertsSeen')::integer <> 2 or (v->>'alertsResolved')::integer <> 1 then
    raise exception 'FALHOU: execução 2 (2 vistos, 1 resolvido): %', v;
  end if;
end $$;
reset role;
do $$
declare a private.intel_alerts;
begin
  select * into a from private.intel_alerts where id = current_setting('f3.alert3001')::uuid;
  if a.status <> 'open' or a.severity <> 'alta' or a.acknowledged_at is not null or a.changed_at <= a.first_seen_at
     or a.first_run <> current_setting('f3.run1')::uuid or a.last_run <> current_setting('f3.run2')::uuid then
    raise exception 'FALHOU: alerta que piorou continua o mesmo, muda e perde a ciência: %', row_to_json(a);
  end if;
  if (select status from private.intel_alerts where company_id = current_setting('f3.ca')::uuid and kind = 'custo_mudou')
     <> 'resolved' then raise exception 'FALHOU: alerta que sumiu deveria ser resolvido'; end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f3.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('f3.ca');
begin
  v := public.stock_intel_alerts(jsonb_build_object('companyId', ca, 'onlyNew', true));
  if (v->>'total')::integer <> 2 or (v->'summary'->>'new')::integer <> 1 or (v->'summary'->>'changed')::integer <> 1 then
    raise exception 'FALHOU: novos e mudados da execução 2: %', v->'summary';
  end if;
  v := public.stock_intel_alerts(jsonb_build_object('companyId', ca, 'status', 'resolved'));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'kind' <> 'custo_mudou' or v->'rows'->0->>'resolvedAt' is null then
    raise exception 'FALHOU: histórico dos resolvidos: %', v;
  end if;
  perform public.stock_intel_alert_ack(current_setting('f3.alert3001')::uuid, 'Revisado de novo');
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; ca uuid := current_setting('f3.ca')::uuid;
begin
  v := public.stock_intel_begin('ops', 'intel-test-f3', true);
  perform public.stock_intel_extract((v->>'runId')::uuid, ca);
  perform public.stock_intel_publish((v->>'runId')::uuid, ca, 0, pg_temp.f3_rows('media', false, true));
  perform public.stock_intel_finish((v->>'runId')::uuid, '{}'::jsonb);
end $$;
reset role;
do $$
declare a private.intel_alerts;
begin
  select * into a from private.intel_alerts where id = current_setting('f3.alert3001')::uuid;
  if a.severity <> 'media' or a.acknowledged_note is distinct from 'Revisado de novo' then
    raise exception 'FALHOU: alerta que melhorou mantém a ciência: %', row_to_json(a);
  end if;
  if (select count(*) from private.intel_alerts where company_id = current_setting('f3.ca')::uuid) <> 3 then
    raise exception 'FALHOU: histórico (2 abertos + 1 resolvido)';
  end if;
end $$;

-- 4. Nada oficial mudou; consultas inválidas recusadas.
do $$
declare before json := current_setting('f3.official')::json;
begin
  if before::text <> json_build_object(
    'positions', (select count(*) from private.stock_positions), 'invoices', (select count(*) from public.invoices),
    'items', (select count(*) from public.invoice_items), 'movements', (select count(*) from private.stock_movements),
    'manual', (select count(*) from private.stock_curves))::text then
    raise exception 'FALHOU: dados oficiais mudaram com a fase 3';
  end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('f3.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare bad jsonb;
begin
  foreach bad in array array['{"status": "x"}', '{"severity": "urgente"}', '{"kind": "DROP TABLE"}', '{"page": -2}']::jsonb[] loop
    begin
      perform public.stock_intel_alerts(bad);
      raise exception 'FALHOU: consulta inválida aceita: %', bad;
    exception when others then if sqlerrm not like '%inválida%' then raise; end if; end;
  end loop;
  begin
    perform public.stock_intel_alert_ack(gen_random_uuid(), null);
    raise exception 'FALHOU: ciência de alerta inexistente';
  exception when others then if sqlerrm not like '%inexistente%' then raise; end if; end;
  raise notice 'PASS Inteligência fase 3: extração (janela, custo anterior, compras 30/90 sem estorno/transferência/devolução), alertas abrem/continuam/mudam/resolvem sem repetir aviso, ciência com auditoria só de quem classifica e cai só quando piora, máscara de custo em itens/lista/detalhe, filtros novos, dados oficiais intocados';
end $$;
reset role;
rollback;
