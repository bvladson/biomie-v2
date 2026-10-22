\set ON_ERROR_STOP on
-- Estoque, migração 0043: curva A/B/C/D automática pelo faturamento (mesma base da página
-- Produtos), janelas, produto novo, histórico incompleto, tempo sem venda, venda em outra empresa
-- do grupo, última entrada, curva manual com justificativa, proteções do recálculo e fila das
-- movimentações. Empresas, vendas e usuários sintéticos; tudo é desfeito no fim. Banco de TESTE.
begin;
do $$
declare
  t date := stock_internal.as_of();
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  su uuid := gen_random_uuid(); ge uuid := gen_random_uuid(); ve uuid := gen_random_uuid();
  s uuid := gen_random_uuid(); sb uuid := gen_random_uuid();
  cu uuid := gen_random_uuid(); cub uuid := gen_random_uuid();
  rd uuid := gen_random_uuid();
  p1 uuid := gen_random_uuid(); ta uuid := gen_random_uuid(); tb uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid(); p4 uuid := gen_random_uuid(); p5 uuid := gen_random_uuid();
  p6 uuid := gen_random_uuid(); p7 uuid := gen_random_uuid(); p9 uuid := gen_random_uuid();
  p10 uuid := gen_random_uuid(); p11 uuid := gen_random_uuid(); pb uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); i3 uuid := gen_random_uuid();
  i4 uuid := gen_random_uuid(); i5 uuid := gen_random_uuid(); ib uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'Curvas A (teste)', 'crv-a-' || ca, 'OMIE_SHADOW', 'commercial_base', false),
    (cb, 'Curvas B (teste)', 'crv-b-' || cb, 'OMIE', 'commercial_base', false);
  insert into public.company_integrations (company_id, provider, status) values (ca, 'omie', 'CONNECTED'), (cb, 'omie', 'CONNECTED');
  insert into public.channels (company_id, name) values (ca, 'varejo'), (cb, 'varejo');
  insert into auth.users (id, email, created_at) values
    (su, 'crv-su-' || su || '@invalid.example', now()), (ge, 'crv-ge-' || ge || '@invalid.example', now()),
    (ve, 'crv-ve-' || ve || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values
    (su, 'crv-su@x', 'Super Curvas'), (ge, 'crv-ge@x', 'Gestor Curvas'), (ve, 'crv-ve@x', 'Vendedor Curvas');
  insert into public.user_roles (user_id, role) values (su, 'SUPER_ADMIN'), (ge, 'GESTOR'), (ve, 'VENDEDOR');
  insert into public.user_company_access (user_id, company_id) values (ge, ca), (ve, ca);
  insert into public.sellers (id, company_id, name) values (s, ca, 'Vendedor A'), (sb, cb, 'Vendedor B');
  insert into public.customers (id, company_id, name, state, city, document) values
    (cu, ca, 'Cliente A', 'CE', 'Fortaleza', '12345678000195'), (cub, cb, 'Cliente B', 'CE', 'Fortaleza', '12345678000195');
  insert into public.products (id, company_id, name, category, base_price, sku, source, external_id) values
    (p1, ca, 'Mesa diretoria', 'Mesas', 0, 'SKU-1001', 'omie', '1001'),
    (ta, ca, 'Cadeira empate A', 'Cadeiras', 0, 'SKU-1002', 'omie', '1002'),
    (tb, ca, 'Cadeira empate B', 'Cadeiras', 0, 'SKU-1003', 'omie', '1003'),
    (p3, ca, 'Gaveteiro', 'Gaveteiros', 0, 'SKU-1004', 'omie', '1004'),
    (p4, ca, 'Armário sem saldo', 'Armários', 0, 'SKU-1005', 'omie', '1005'),
    (p5, ca, 'Estante venda antiga', 'Estantes', 0, 'SKU-1006', 'omie', '1006'),
    (p6, ca, 'Poltrona nova', 'Poltronas', 0, 'SKU-1007', 'omie', '1007'),
    (p7, ca, 'Banco zerado', 'Bancos', 0, 'SKU-1008', 'omie', '1008'),
    (p9, ca, 'Mesa negativa', 'Mesas', 0, 'SKU-1009', 'omie', '1009'),
    (p10, ca, 'Painel parado', 'Painéis', 0, 'SKU-1010', 'omie', '1010'),
    (p11, ca, 'Nicho recente', 'Nichos', 0, 'SKU-1011', 'omie', '1011'),
    (pb, cb, 'Poltrona nova (B)', 'Poltronas', 0, 'SKU-1007', 'omie', '2001');
  -- Vendas de A em 12 meses: 700 + 100 + 100 + 60 + 40 = 1.000 (a de 400 dias fica fora).
  insert into public.invoices (id, company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
      gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible) values
    (i1, ca, s, cu, '1', t - 10, 700, 'omie', 'crv-1-' || i1, 700, 700, 700, 'commercial', 'varejo', true),
    (i2, ca, s, cu, '2', t - 40, 200, 'omie', 'crv-2-' || i2, 200, 200, 200, 'commercial', 'varejo', true),
    (i3, ca, s, cu, '3', t - 100, 60, 'omie', 'crv-3-' || i3, 60, 60, 60, 'commercial', 'varejo', true),
    (i4, ca, s, cu, '4', t - 200, 40, 'omie', 'crv-4-' || i4, 40, 40, 40, 'commercial', 'varejo', true),
    (i5, ca, s, cu, '5', t - 400, 999, 'omie', 'crv-5-' || i5, 999, 999, 999, 'commercial', 'varejo', true),
    (ib, cb, sb, cub, 'B1', t - 30, 50, 'omie', 'crv-b-' || ib, 50, 50, 50, 'commercial', 'varejo', true);
  insert into public.invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence) values
    (i1, ca, s, p1, 1, 700, 1), (i2, ca, s, ta, 1, 100, 1), (i2, ca, s, tb, 1, 100, 2),
    (i3, ca, s, p3, 2, 60, 1), (i4, ca, s, p4, 1, 40, 1), (i5, ca, s, p5, 3, 999, 1), (ib, cb, sb, pb, 1, 50, 1);
  -- Cobertura de notas do BIOMIE: 300 dias (a janela de 12 meses fica incompleta).
  insert into public.integration_sync_runs (company_id, entity, status, started_at, finished_at, period_from, period_to,
      raw_complete, canonical_complete, gold_complete) values
    (ca, 'invoices', 'SUCCESS', now() - interval '2 minutes', now() - interval '1 minute', t - 300, t, true, true, true),
    (cb, 'invoices', 'SUCCESS', now() - interval '2 minutes', now() - interval '1 minute', t - 300, t, true, true, true);
  -- Cadastro no Omie (dInc): poltrona há 20 dias (nova), painel há 350, nicho há 120.
  insert into public.raw_omie_products (company_id, external_id, payload, payload_hash) values
    (ca, '1007', jsonb_build_object('info', jsonb_build_object('dInc', to_char(t - 20, 'DD/MM/YYYY'))), 'h1007'),
    (ca, '1010', jsonb_build_object('info', jsonb_build_object('dInc', to_char(t - 350, 'DD/MM/YYYY'))), 'h1010'),
    (ca, '1011', jsonb_build_object('info', jsonb_build_object('dInc', to_char(t - 120, 'DD/MM/YYYY'))), 'h1011');
  -- Movimentações lidas: entrada da poltrona há 15 dias; entrada CANCELADA do gaveteiro; painel antigo.
  insert into private.stock_movements (company_id, movement_id, moved_on, kind, operation, canceled, omie_product_id, qty) values
    (ca, 1, t - 15, 'entrada', '21', false, '1007', 2),
    (ca, 2, t - 5, 'entrada', '21', true, '1004', 9),
    (ca, 3, t - 250, 'entrada', '00', false, '1010', 6),
    (ca, 4, t - 240, 'saida', '11', false, '1010', 1),
    (ca, 5, t - 90, 'entrada', '21', false, '1004', 4),
    (ca, 6, t - 3, 'entrada', '15', false, '1004', 0),
    (ca, 7, t - 2, 'entrada', '11', false, '1004', 1),
    (ca, 8, t - 30, 'saida', '28', false, '1006', 2);
  -- Posição publicada de A (duas linhas do mesmo produto em locais diferentes).
  insert into private.stock_readings (id, company_id, kind, trigger, status, position_date, pages_total, pages_done,
      records_expected, records_received, locations, attempts, finished_at)
    values (rd, ca, 'intraday', 'manual', 'complete', t, 1, 1, 12, 12,
      '{"1": {"name": "Depósito"}, "2": {"name": "Loja"}}', 1, now());
  insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
      physical_qty, reserved_qty, pending_qty, unit_cost, sale_price) values
    (rd, ca, '1001', '1', 'SKU-1001', 'Mesa diretoria', 5, 0, 0, 100, 300),
    (rd, ca, '1002', '1', 'SKU-1002', 'Cadeira empate A', 3, 0, 0, 50, 100),
    (rd, ca, '1002', '2', 'SKU-1002', 'Cadeira empate A', 2, 0, 0, 50, 100),
    (rd, ca, '1003', '1', 'SKU-1003', 'Cadeira empate B', 1, 0, 0, 50, 100),
    (rd, ca, '1004', '1', 'SKU-1004', 'Gaveteiro', 4, 0, 0, 20, 30),
    (rd, ca, '1005', '1', 'SKU-1005', 'Armário sem saldo', 0, 0, 0, 10, 40),
    (rd, ca, '1006', '1', 'SKU-1006', 'Estante venda antiga', 7, 0, 0, 30, 300),
    (rd, ca, '1007', '1', 'SKU-1007', 'Poltrona nova', 2, 0, 0, 40, 90),
    (rd, ca, '1008', '1', 'SKU-1008', 'Banco zerado', 0, 0, 0, 10, 20),
    (rd, ca, '1009', '1', 'SKU-1009', 'Mesa negativa', -1, 0, 0, 10, 20),
    (rd, ca, '1010', '1', 'SKU-1010', 'Painel parado', 6, 0, 0, 15, 50),
    (rd, ca, '1011', '1', 'SKU-1011', 'Nicho recente', 3, 0, 0, 25, 60);
  insert into private.stock_current (company_id, reading_id, published_at) values (ca, rd, now());
  update private.feature_flags set mode = 'on' where key = 'stock';
  update private.stock_settings set curve_window = '12m', curve_a_limit = 80, curve_b_limit = 95, new_product_days = 90;
  perform set_config('crv.t', t::text, true);
  perform set_config('crv.ca', ca::text, true); perform set_config('crv.cb', cb::text, true);
  perform set_config('crv.su', su::text, true); perform set_config('crv.ge', ge::text, true);
  perform set_config('crv.ve', ve::text, true);
  perform set_config('crv.ta', ta::text, true); perform set_config('crv.tb', tb::text, true);
end $$;

-- 1. Antes do primeiro cálculo: tudo "sem curva" (nada inventado).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.stock_overview(current_setting('crv.ca'));
  if (v->'byCurve'->4->>'positions')::integer <> 12 or v->>'window' <> '12m'
     or v->'curves'->0->>'status' <> 'missing' then
    raise exception 'FALHOU: antes do cálculo deveria estar tudo sem curva: % %', v->'byCurve', v->'curves';
  end if;
end $$;
reset role;

-- 2. Cálculo pelo worker (service_role): B primeiro (para a venda no grupo), depois A.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.stock_worker_refresh_curves(current_setting('crv.cb')::uuid);
  if r->>'status' <> 'ok' then raise exception 'FALHOU: cálculo de B: %', r; end if;
  r := public.stock_worker_refresh_curves(current_setting('crv.ca')::uuid);
  if r->>'status' <> 'ok' or (r->'totals'->'12m'->>'revenue')::numeric <> 1000
     or (r->'totals'->'12m'->>'products')::integer <> 5 or (r->'totals'->'12m'->>'A')::integer <> 2
     or (r->'totals'->'12m'->>'B')::integer <> 2 or (r->'totals'->'12m'->>'C')::integer <> 1
     or (r->>'salesFrom')::date <> current_setting('crv.t')::date - 300 then
    raise exception 'FALHOU: totais de 12 meses de A: %', r;
  end if;
  if (r->'totals'->'90d'->>'revenue')::numeric <> 900 or (r->'totals'->'30d'->>'revenue')::numeric <> 700 then
    raise exception 'FALHOU: totais por janela: %', r->'totals';
  end if;
end $$;
reset role;

-- 3. Pareto: o acumulado ANTES do produto decide; quem atravessa 80% fica em A; empate pelo id.
do $$
declare
  first_tie uuid := least(current_setting('crv.ta')::uuid, current_setting('crv.tb')::uuid);
  second_tie uuid := greatest(current_setting('crv.ta')::uuid, current_setting('crv.tb')::uuid);
  v record;
begin
  for v in select a.omie_product_id, a.product_id, a.curve, a.cumulative_before, a.rank, a.share
           from private.stock_auto_curves a
           where a.company_id = current_setting('crv.ca')::uuid and a.curve_window = '12m' order by a.rank loop
    if v.omie_product_id = '1001' and (v.curve <> 'A' or v.rank <> 1 or v.share <> 0.7) then
      raise exception 'FALHOU: mesa (70%%) deveria ser A, posição 1: %', v; end if;
    if v.product_id = first_tie and (v.curve <> 'A' or v.cumulative_before <> 0.7) then
      raise exception 'FALHOU: primeiro do empate atravessa 80%% e fica em A: %', v; end if;
    if v.product_id = second_tie and (v.curve <> 'B' or v.cumulative_before <> 0.8) then
      raise exception 'FALHOU: segundo do empate começa em 80%% e vai para B: %', v; end if;
    if v.omie_product_id = '1004' and (v.curve <> 'B' or v.cumulative_before <> 0.9) then
      raise exception 'FALHOU: gaveteiro deveria ser B: %', v; end if;
    if v.omie_product_id = '1005' and (v.curve <> 'C' or v.cumulative_before <> 0.96) then
      raise exception 'FALHOU: armário (vendido, sem saldo) entra no acumulado como C: %', v; end if;
  end loop;
  if exists (select 1 from private.stock_auto_curves a where a.company_id = current_setting('crv.ca')::uuid
             and a.omie_product_id = '1006' and a.curve_window = '12m') then
    raise exception 'FALHOU: venda de 400 dias entrou na janela de 12 meses';
  end if;
end $$;

-- 4. Posição com a curva efetiva por janela, indicadores e fatos do produto.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare p jsonb; r jsonb; t date := current_setting('crv.t')::date; got jsonb := '{}';
begin
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'view', 'product',
    'sortBy', 'sku', 'sortDir', 'asc'));
  if (p->>'total')::integer <> 11 or p->>'window' <> '12m' then
    raise exception 'FALHOU: visão por produto deveria ter 11 produtos: %', p->>'total';
  end if;
  for r in select * from jsonb_array_elements(p->'rows') loop
    got := got || jsonb_build_object(r->>'omieProductId', r->>'curve');
    if r->>'omieProductId' = '1002' and ((r->>'physicalQty')::numeric <> 5 or (r->>'locations')::integer <> 2
        or (r->>'costValue')::numeric <> 250) then
      raise exception 'FALHOU: produto com 2 locais somados: %', r; end if;
    if r->>'omieProductId' = '1001' and ((r->>'windowRevenue')::numeric <> 700 or r->>'curveSource' <> 'auto'
        or (r->>'lastSale')::date <> t - 10 or (r->>'daysWithoutSale')::integer <> 10) then
      raise exception 'FALHOU: fatos da mesa: %', r; end if;
    if r->>'omieProductId' = '1007' and (not (r->>'isNew')::boolean or r->'incompleteHistory' <> 'null'::jsonb
        or (r->>'lastEntry')::date <> t - 15 or r->>'lastEntryOperation' <> '21'
        or r->'soldElsewhere'->>'companyName' <> 'Curvas B (teste)') then
      raise exception 'FALHOU: poltrona nova (entrada há 15 dias, vendida em B): %', r; end if;
    if r->>'omieProductId' = '1004' and ((r->>'lastEntry')::date <> t - 90) then
      raise exception 'FALHOU: entrada cancelada, frete (15) ou estorno (11) contou como última entrada: %', r; end if;
    if r->>'omieProductId' = '1006' and ((r->>'lastExit')::date <> t - 30 or r->>'lastExitOperation' <> '28'
        or not (r->>'recentExit')::boolean) then
      raise exception 'FALHOU: consumo da produção como saída recente: %', r; end if;
    if r->>'omieProductId' = '1010' and (r->>'recentExit')::boolean then
      raise exception 'FALHOU: saída de 240 dias não é recente: %', r; end if;
    if r->>'omieProductId' in ('1006', '1010', '1011') and r->>'incompleteHistory' <> 'sales' then
      raise exception 'FALHOU: 12 meses com histórico de 300 dias deveria ser incompleto: %', r; end if;
  end loop;
  if got <> '{"1001": "A", "1002": "A", "1003": "B", "1004": "B", "1005": "C", "1006": "D", "1007": "D",
               "1008": "U", "1009": "U", "1010": "D", "1011": "D"}'::jsonb
     and got <> '{"1001": "A", "1002": "B", "1003": "A", "1004": "B", "1005": "C", "1006": "D", "1007": "D",
               "1008": "U", "1009": "U", "1010": "D", "1011": "D"}'::jsonb then
    raise exception 'FALHOU: curvas de 12 meses: %', got;
  end if;
  -- 90 dias: o gaveteiro (venda há 100 dias) vira D; painel confirmado; nicho mais novo que a janela? não.
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'view', 'product',
    'window', '90d', 'curve', 'D', 'sortBy', 'sku', 'sortDir', 'asc'));
  if (select string_agg(x->>'omieProductId', ',' order by x->>'omieProductId') from jsonb_array_elements(p->'rows') x)
     <> '1004,1006,1007,1010,1011' then
    raise exception 'FALHOU: curva D em 90 dias: %', p->'rows';
  end if;
  if exists (select 1 from jsonb_array_elements(p->'rows') x
             where x->>'omieProductId' in ('1004', '1006', '1010', '1011') and x->'incompleteHistory' <> 'null'::jsonb) then
    raise exception 'FALHOU: 90 dias com histórico de 300 dias é ausência de venda confirmada: %', p->'rows';
  end if;
  -- 180 dias: nicho cadastrado há 120 dias (não é novo) é mais novo que a janela → histórico do produto.
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'view', 'product',
    'window', '180d', 'onlyIncomplete', true));
  if (p->>'total')::integer <> 1 or p->'rows'->0->>'omieProductId' <> '1011'
     or p->'rows'->0->>'incompleteHistory' <> 'product' then
    raise exception 'FALHOU: histórico incompleto pelo produto em 180 dias: %', p->'rows';
  end if;
  -- Tempo sem venda (independente da janela): 90+ dias = gaveteiro (100) + estante e painel (desde o
  -- início do histórico, 301) + nicho (desde a chegada, 121). A poltrona chegou há 20 dias: não entra.
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'view', 'product',
    'minDaysWithoutSale', 90));
  if (select string_agg(x->>'omieProductId', ',' order by x->>'omieProductId') from jsonb_array_elements(p->'rows') x)
     <> '1004,1006,1010,1011' then
    raise exception 'FALHOU: sem venda há 90+ dias: %', p->'rows';
  end if;
  if (select x->>'idleSince' from jsonb_array_elements(p->'rows') x where x->>'omieProductId' = '1011')::date
       <> t - 120
     or (select (x->>'daysWithoutSale')::integer from jsonb_array_elements(p->'rows') x where x->>'omieProductId' = '1011') <> 121 then
    raise exception 'FALHOU: tempo sem venda do nicho conta da chegada: %', p->'rows';
  end if;
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'view', 'product',
    'recentExit', true));
  if (p->>'total')::integer <> 1 or p->'rows'->0->>'omieProductId' <> '1006' then
    raise exception 'FALHOU: filtro de saída recente: %', p->'rows';
  end if;
  begin perform public.stock_positions(jsonb_build_object('companyId', 'all', 'page', 0, 'window', '7d'));
    raise exception 'FALHOU: janela inválida aceita';
  exception when others then if sqlerrm not like '%Janela inválida%' then raise; end if; end;
  begin perform public.stock_positions(jsonb_build_object('companyId', 'all', 'page', 0, 'minDaysWithoutSale', 45));
    raise exception 'FALHOU: faixa de dias inválida aceita';
  exception when others then if sqlerrm not like '%Consulta inválida%' then raise; end if; end;
end $$;
reset role;

-- 5. Visão geral: distribuição da janela, curva D aberta em novo / incompleto / confirmado, faixas.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; a jsonb;
begin
  v := public.stock_overview(current_setting('crv.ca'), '12m');
  -- D em 12 meses: estante (210), poltrona nova (80), painel (90), nicho (75) = 455.
  if (v->'dAnalysis'->>'movingProducts')::integer <> 1 or (v->'dAnalysis'->>'movingCostValue')::numeric <> 210 then
    raise exception 'FALHOU: curva D com saída recente: %', v->'dAnalysis';
  end if;
  if (v->'dAnalysis'->>'products')::integer <> 4 or (v->'dAnalysis'->>'costValue')::numeric <> 455
     or (v->'dAnalysis'->>'newProducts')::integer <> 1 or (v->'dAnalysis'->>'newCostValue')::numeric <> 80
     or (v->'dAnalysis'->>'incompleteProducts')::integer <> 3 or (v->'dAnalysis'->>'confirmedProducts')::integer <> 0
     or (v->'dAnalysis'->>'elsewhereProducts')::integer <> 1 then
    raise exception 'FALHOU: curva D aberta (12 meses): %', v->'dAnalysis';
  end if;
  if not (v->'curves'->0->>'incompleteHistory')::boolean or v->'curves'->0->>'status' <> 'ok'
     or (v->'curves'->0->>'salesFrom')::date <> current_setting('crv.t')::date - 300 then
    raise exception 'FALHOU: aviso de histórico incompleto da janela: %', v->'curves';
  end if;
  v := public.stock_overview(current_setting('crv.ca'), '90d');
  if (v->'dAnalysis'->>'confirmedProducts')::integer <> 4 or (v->'curves'->0->>'incompleteHistory')::boolean then
    raise exception 'FALHOU: curva D aberta (90 dias): %', v->'dAnalysis';
  end if;
  -- Faixas por produto com saldo: 30 = cadeiras (40 dias); 90 = gaveteiro (100) e nicho (121, desde a
  -- chegada); 180 = estante e painel (nunca venderam, já estavam antes do histórico: incompletos);
  -- a poltrona nova (21 dias) não entra em faixa nenhuma.
  a := v->'aging';
  if (a->0->>'band') <> '30' or (a->0->>'products')::integer <> 2 or (a->1->>'products')::integer <> 2
     or (a->1->>'incompleteProducts')::integer <> 0 or (a->2->>'products')::integer <> 2
     or (a->2->>'newProducts')::integer <> 0 or (a->2->>'incompleteProducts')::integer <> 2
     or (a->3->>'products')::integer <> 0 then
    raise exception 'FALHOU: faixas de tempo sem venda: %', a;
  end if;
end $$;
reset role;

-- 6. Curva manual: justificativa obrigatória, prevalece sobre a automática, sobrevive ao recálculo,
--    volta para a automática e fica na Auditoria; vendedor não classifica nem vê faturamento.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; p jsonb;
begin
  begin perform public.stock_set_curve(array[current_setting('crv.ca') || ':1006:*'], 'A', 'curta');
    raise exception 'FALHOU: justificativa curta aceita';
  exception when others then if sqlerrm not like '%Informe a justificativa%' then raise; end if; end;
  v := public.stock_set_curve(array[current_setting('crv.ca') || ':1006:*'], 'A', 'Produto estratégico em reposição');
  if (v->>'updated')::integer <> 1 then raise exception 'FALHOU: curva manual pelo produto: %', v; end if;
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'onlyManual', true));
  if (p->>'total')::integer <> 1 or p->'rows'->0->>'curve' <> 'A' or p->'rows'->0->>'curveSource' <> 'manual'
     or p->'rows'->0->>'curveReason' <> 'Produto estratégico em reposição'
     or p->'rows'->0->>'curveSetBy' <> 'Gestor Curvas' or p->'rows'->0->'curveSetAt' = 'null'::jsonb then
    raise exception 'FALHOU: curva manual com quem, quando e por quê: %', p->'rows';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
begin
  if public.stock_worker_refresh_curves(current_setting('crv.ca')::uuid)->>'status' <> 'ok' then
    raise exception 'FALHOU: recálculo com curva manual';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare p jsonb;
begin
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'search', 'Estante'));
  if p->'rows'->0->>'curve' <> 'A' or p->'rows'->0->>'curveSource' <> 'manual' then
    raise exception 'FALHOU: recálculo apagou a curva manual: %', p->'rows'->0;
  end if;
  perform public.stock_set_curve(array[current_setting('crv.ca') || ':1006:1'], 'AUTO', 'Voltou ao giro normal');
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'search', 'Estante'));
  if p->'rows'->0->>'curve' <> 'D' or p->'rows'->0->>'curveSource' <> 'auto' then
    raise exception 'FALHOU: voltar para a automática: %', p->'rows'->0;
  end if;
end $$;
reset role;

do $$
begin
  if (select count(*) from public.audit_log where action = 'stock.curve.changed'
        and entity_id = current_setting('crv.ca')
        and payload->>'justificativa' in ('Produto estratégico em reposição', 'Voltou ao giro normal')) <> 2
     or not exists (select 1 from public.audit_log where action = 'stock.curve.changed'
        and payload->>'curva' = 'Automática' and entity_id = current_setting('crv.ca')) then
    raise exception 'FALHOU: auditoria da curva manual';
  end if;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare p jsonb; v jsonb;
begin
  begin perform public.stock_set_curve(array[current_setting('crv.ca') || ':1006:*'], 'A', 'Vendedor tentando mudar');
    raise exception 'FALHOU: vendedor classificou';
  exception when others then if sqlerrm not like '%não pode classificar%' then raise; end if; end;
  p := public.stock_positions(jsonb_build_object('companyId', current_setting('crv.ca'), 'page', 0, 'search', 'Mesa diretoria'));
  if p->'rows'->0->'windowRevenue' <> 'null'::jsonb or p->'rows'->0->'costValue' <> 'null'::jsonb
     or p->'rows'->0->>'curve' <> 'A' then
    raise exception 'FALHOU: vendedor viu faturamento ou custo: %', p->'rows'->0;
  end if;
  v := public.stock_overview(current_setting('crv.ca'));
  if v->'dAnalysis'->'costValue' <> 'null'::jsonb or v->'aging'->0->'costValue' <> 'null'::jsonb then
    raise exception 'FALHOU: vendedor viu valor da curva D: %', v->'dAnalysis';
  end if;
end $$;
reset role;

-- 7. Proteções do recálculo: notas sincronizando e queda brusca mantêm as curvas anteriores; uma
--    falha no meio desfaz tudo (transação); a falha registrada aparece para quem administra.
do $$
declare v_before integer; r jsonb;
begin
  select count(*) into v_before from private.stock_auto_curves where company_id = current_setting('crv.ca')::uuid;
  insert into public.integration_backfill_jobs (company_id, entity, period_from, period_to, status)
    values (current_setting('crv.ca')::uuid, 'invoices', current_setting('crv.t')::date - 5, current_setting('crv.t')::date, 'RUNNING');
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  r := public.stock_worker_refresh_curves(current_setting('crv.ca')::uuid);
  if r->>'status' <> 'skipped' or r->>'reason' not like '%Notas fiscais em sincronização%' then
    raise exception 'FALHOU: notas sincronizando deveria adiar: %', r;
  end if;
  if (select count(*) from private.stock_auto_curves where company_id = current_setting('crv.ca')::uuid) <> v_before then
    raise exception 'FALHOU: adiamento mexeu nas curvas';
  end if;
  update public.integration_backfill_jobs set status = 'DONE' where company_id = current_setting('crv.ca')::uuid;
  -- Queda brusca: some a nota de 700 (70% do faturamento).
  delete from public.invoice_items where invoice_id in (select id from public.invoices where company_id = current_setting('crv.ca')::uuid and number = '1');
  delete from public.invoices where company_id = current_setting('crv.ca')::uuid and number = '1';
  r := public.stock_worker_refresh_curves(current_setting('crv.ca')::uuid);
  if r->>'status' <> 'skipped' or not exists (select 1 from private.stock_auto_curves
       where company_id = current_setting('crv.ca')::uuid and omie_product_id = '1001' and curve_window = '12m') then
    raise exception 'FALHOU: queda brusca deveria manter as curvas: %', r;
  end if;
  r := stock_internal.refresh_curves(current_setting('crv.ca')::uuid, 'ops', true);
  if r->>'status' <> 'ok' or exists (select 1 from private.stock_auto_curves
       where company_id = current_setting('crv.ca')::uuid and omie_product_id = '1001') then
    raise exception 'FALHOU: cálculo forçado: %', r;
  end if;
  -- Falha no meio: o erro desfaz a troca inteira (subtransação = mesma garantia da chamada do worker).
  select count(*) into v_before from private.stock_auto_curves where company_id = current_setting('crv.ca')::uuid;
  begin
    perform stock_internal.refresh_curves(current_setting('crv.ca')::uuid, 'teste', true);
    delete from private.stock_auto_curves where company_id = current_setting('crv.ca')::uuid;
    raise exception 'falha simulada depois da troca';
  exception when others then
    if sqlerrm <> 'falha simulada depois da troca' then raise; end if;
  end;
  if (select count(*) from private.stock_auto_curves where company_id = current_setting('crv.ca')::uuid) <> v_before then
    raise exception 'FALHOU: falha no meio apagou curvas';
  end if;
  perform public.stock_worker_curve_failed(current_setting('crv.ca')::uuid, 'Erro de teste no cálculo');
end $$;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.stock_overview(current_setting('crv.ca'));
  if v->'curves'->0->>'status' <> 'failed' or v->'curves'->0->>'reason' <> 'Erro de teste no cálculo'
     or v->'curves'->0->'computedAt' = 'null'::jsonb then
    raise exception 'FALHOU: falha do cálculo visível com as curvas anteriores: %', v->'curves';
  end if;
end $$;
reset role;

-- 8. Movimentações: carga inicial em blocos, página a página, idempotente, total que muda, falha.
do $$
declare n integer; j jsonb; r jsonb; v_job uuid;
begin
  update private.stock_settings set reading_enabled = true, movements_enabled = true, movements_days = 62,
    movements_chunk_days = 31;
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  -- Empresas sintéticas do teste + as que existirem no banco de teste: conferimos só A.
  perform public.stock_worker_enqueue('2030-01-01 07:40', 'intraday', current_setting('crv.t')::date);
  select count(*) into n from private.stock_movement_jobs where company_id = current_setting('crv.ca')::uuid and trigger = 'backfill';
  if n <> 2 then raise exception 'FALHOU: carga inicial de 62 dias em blocos de 31: % blocos', n; end if;
  perform public.stock_worker_enqueue('2030-01-01 12:40', 'intraday', current_setting('crv.t')::date);
  if (select count(*) from private.stock_movement_jobs where company_id = current_setting('crv.ca')::uuid) <> 2 then
    raise exception 'FALHOU: fila duplicada enquanto há blocos pendentes';
  end if;
  -- Só os blocos de A na frente: tira os das demais empresas do teste.
  delete from private.stock_movement_jobs where company_id <> current_setting('crv.ca')::uuid;
  j := public.stock_worker_movements_claim();
  v_job := (j->>'id')::uuid;
  if j->>'companyId' <> current_setting('crv.ca') or (j->>'nextPage')::integer <> 1
     or to_date(j->>'from', 'DD/MM/YYYY') <> current_setting('crv.t')::date - 62 then
    raise exception 'FALHOU: primeiro bloco (mais antigo): %', j;
  end if;
  r := public.stock_worker_movements_save_page(v_job, 1, 2, 3, jsonb_build_array(
    jsonb_build_object('movement_id', 10, 'moved_on', current_setting('crv.t')::date - 60, 'kind', 'entrada',
      'operation', '22', 'omie_product_id', '1011', 'qty', 3),
    jsonb_build_object('movement_id', 11, 'moved_on', current_setting('crv.t')::date - 59, 'kind', 'saida',
      'operation', '11', 'omie_product_id', '1011', 'qty', 1)), 0);
  if (r->>'done')::boolean or (r->>'saved')::integer <> 2 then raise exception 'FALHOU: página 1: %', r; end if;
  -- Total muda: volta para a página 1, sem perder o que já foi gravado.
  r := public.stock_worker_movements_save_page(v_job, 2, 2, 4, '[]', 0);
  if not (r->>'restarted')::boolean or (select count(*) from private.stock_movements
       where company_id = current_setting('crv.ca')::uuid and movement_id in (10, 11)) <> 2 then
    raise exception 'FALHOU: total que muda recomeça sem perder movimentos: %', r;
  end if;
  r := public.stock_worker_movements_save_page(v_job, 1, 1, 4, jsonb_build_array(
    jsonb_build_object('movement_id', 10, 'moved_on', current_setting('crv.t')::date - 60, 'kind', 'entrada',
      'operation', '22', 'omie_product_id', '1011', 'qty', 3)), 1);
  if not (r->>'done')::boolean then raise exception 'FALHOU: bloco de 1 página: %', r; end if;
  r := public.stock_worker_movements_finish(v_job);
  if (r->>'lastOfCompany')::boolean then raise exception 'FALHOU: ainda havia outro bloco: %', r; end if;
  if (select records_skipped from private.stock_movement_jobs where id = v_job) <> 1 then
    raise exception 'FALHOU: registros ignorados não contados';
  end if;
  j := public.stock_worker_movements_claim();
  r := public.stock_worker_movements_fail((j->>'id')::uuid, 'Credenciais Omie recusadas.', 60, true);
  if not (r->>'final')::boolean or (select status from private.stock_movement_jobs where id = (j->>'id')::uuid) <> 'failed' then
    raise exception 'FALHOU: falha final do bloco: %', r;
  end if;
  -- Entrada nova do nicho entra nos fatos no próximo cálculo. O nicho foi cadastrado há 120 dias,
  -- antes do histórico lido (62 dias): a entrada de 60 dias é reposição, não chegada de produto novo.
  if stock_internal.movements_from(current_setting('crv.ca')::uuid) <> current_setting('crv.t')::date - 62 then
    raise exception 'FALHOU: início do histórico de movimentações lido';
  end if;
  r := stock_internal.refresh_curves(current_setting('crv.ca')::uuid, 'teste', true);
  if (select last_entry from private.stock_product_facts where company_id = current_setting('crv.ca')::uuid
        and omie_product_id = '1011') <> current_setting('crv.t')::date - 60
     or (select arrived_on from private.stock_product_facts where company_id = current_setting('crv.ca')::uuid
        and omie_product_id = '1011') <> current_setting('crv.t')::date - 120 then
    raise exception 'FALHOU: última entrada e chegada vindas das movimentações';
  end if;
end $$;

-- 9. Permissões e compatibilidade com a tela antiga (assinaturas com 1 e 2 argumentos).
do $$
begin
  if has_function_privilege('authenticated', 'public.stock_worker_refresh_curves(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.stock_worker_movements_claim()', 'EXECUTE')
     or has_function_privilege('authenticated', 'stock_internal.refresh_curves(uuid, text, boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.stock_set_curve(text[], text, text)', 'EXECUTE') then
    raise exception 'FALHOU: função interna da curva executável pela API';
  end if;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('crv.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  perform public.stock_overview(current_setting('crv.ca'));
  perform public.stock_simulation_base(current_setting('crv.ca'));
  if (public.stock_simulation_base(current_setting('crv.ca'), '30d')->>'window') <> '30d' then
    raise exception 'FALHOU: simulação na janela pedida';
  end if;
  perform public.stock_set_curve(array[current_setting('crv.ca') || ':1004:1'], 'U');
  raise notice 'PASS Estoque curvas: Pareto 80/95 com empate estável, D só com saldo, janelas, novo, histórico incompleto, tempo sem venda, venda no grupo, última entrada, manual justificada, proteções do recálculo e movimentações';
end $$;
reset role;

rollback;
