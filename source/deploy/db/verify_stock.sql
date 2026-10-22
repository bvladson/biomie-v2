\set ON_ERROR_STOP on
-- Estoque (migrações 0041 e 0042): liberação, papéis, escopo de empresa, custo, curva, cenários,
-- pedido de leitura e o ciclo do worker (página fora de ordem, total que muda, posição repetida,
-- falha, leitura longa que avança, leitura parada e leitura de mais de 3 h).
-- Empresas e usuários sintéticos; tudo é desfeito no fim. Rodar no banco de TESTE.
begin;
do $$
declare
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid(); cd uuid := gen_random_uuid();
  su uuid := gen_random_uuid(); ad uuid := gen_random_uuid(); ge uuid := gen_random_uuid();
  an uuid := gen_random_uuid(); an2 uuid := gen_random_uuid(); ve uuid := gen_random_uuid();
  vi uuid := gen_random_uuid(); fi uuid := gen_random_uuid(); pa uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'Estoque A (teste)', 'stk-a-' || ca, 'OMIE_SHADOW', 'commercial_base', false),
    (cb, 'Estoque B (teste)', 'stk-b-' || cb, 'OMIE', 'commercial_base', false),
    (cd, 'Estoque Demo (teste)', 'stk-d-' || cd, 'DEMO', 'commercial_base', true);
  insert into public.company_integrations (company_id, provider, status) values
    (ca, 'omie', 'CONNECTED'), (cb, 'omie', 'CONNECTED');
  insert into auth.users (id, email, created_at) values
    (su, 'stk-su-' || su || '@invalid.example', now()), (ad, 'stk-ad-' || ad || '@invalid.example', now()),
    (ge, 'stk-ge-' || ge || '@invalid.example', now()), (an, 'stk-an-' || an || '@invalid.example', now()),
    (an2, 'stk-an2-' || an2 || '@invalid.example', now()), (ve, 'stk-ve-' || ve || '@invalid.example', now()),
    (vi, 'stk-vi-' || vi || '@invalid.example', now()), (fi, 'stk-fi-' || fi || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values
    (su, 'stk-su@x', 'Super Estoque'), (ad, 'stk-ad@x', 'Admin A'), (ge, 'stk-ge@x', 'Gestor A'),
    (an, 'stk-an@x', 'Analista A'), (an2, 'stk-an2@x', 'Analista Compras A'), (ve, 'stk-ve@x', 'Vendedor A'),
    (vi, 'stk-vi@x', 'Visualizador A'), (fi, 'stk-fi@x', 'Financeiro AB');
  insert into public.user_roles (user_id, role) values
    (su, 'SUPER_ADMIN'), (ad, 'ADMIN'), (ge, 'GESTOR'), (an, 'ANALISTA'), (an2, 'ANALISTA'),
    (ve, 'VENDEDOR'), (vi, 'VIEWER'), (fi, 'FINANCEIRO');
  insert into public.user_company_access (user_id, company_id) values
    (ad, ca), (ge, ca), (an, ca), (an2, ca), (ve, ca), (vi, ca), (fi, ca), (fi, cb);
  insert into public.user_permissions (user_id, permission) values (an2, 'stock.classify');
  insert into public.products (id, company_id, name, category, base_price, source, external_id, sku)
    values (pa, ca, 'Cadeira Ébano', 'Cadeiras', 0, 'omie', '101', 'CAD-101');
  insert into public.canonical_products (company_id, source, external_id, sku, description, family)
    values (ca, 'omie', '101', 'CAD-101', 'Cadeira Ébano', 'Cadeiras');
  perform set_config('stk.ca', ca::text, true); perform set_config('stk.cb', cb::text, true);
  perform set_config('stk.cd', cd::text, true); perform set_config('stk.pa', pa::text, true);
  perform set_config('stk.su', su::text, true); perform set_config('stk.ad', ad::text, true);
  perform set_config('stk.ge', ge::text, true); perform set_config('stk.an', an::text, true);
  perform set_config('stk.an2', an2::text, true); perform set_config('stk.ve', ve::text, true);
  perform set_config('stk.vi', vi::text, true); perform set_config('stk.fi', fi::text, true);
end $$;

-- 1. Módulo desligado: só o Super admin entra (pela URL); o menu não aparece para ninguém.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin perform public.stock_capabilities(); raise exception 'FALHOU: gestor entrou com o módulo desligado';
  exception when others then if sqlerrm not like '%ainda não foi liberado%' then raise; end if; end;
  if cardinality(public.my_features()) <> 0 then raise exception 'FALHOU: menu liberado com o módulo desligado'; end if;
  begin perform public.stock_admin_set_mode('on'); raise exception 'FALHOU: gestor ligou o módulo';
  exception when others then if sqlerrm not like '%Somente o Super admin%' then raise; end if; end;
  if has_function_privilege('authenticated', 'public.stock_worker_claim()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.stock_worker_finish(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'stock_internal.current_rows(uuid[], text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'stock_internal.caps()', 'EXECUTE') then
    raise exception 'FALHOU: função interna do Estoque executável pela API';
  end if;
  if has_function_privilege('anon', 'public.stock_overview(text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.my_features()', 'EXECUTE') then
    raise exception 'FALHOU: visitante sem sessão executa função do Estoque';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.stock_capabilities();
  if not (v->>'viewCost')::boolean or not (v->>'refresh')::boolean then
    raise exception 'FALHOU: super admin sem capacidades: %', v;
  end if;
  if cardinality(public.my_features()) <> 0 then raise exception 'FALHOU: menu visível no modo desligado'; end if;
  v := public.stock_admin_set_mode('pilot');
  if v->>'mode' <> 'pilot' or public.my_features() <> array['stock'] then
    raise exception 'FALHOU: piloto não mostrou o menu ao super admin';
  end if;
  begin perform public.stock_admin_set_mode('tudo'); raise exception 'FALHOU: modo inválido aceito';
  exception when others then if sqlerrm not like '%Liberação inválida%' then raise; end if; end;
  -- Leitura desligada: nenhum pedido entra, nem agendado nem manual.
  begin perform public.stock_request_refresh(current_setting('stk.ca'));
    raise exception 'FALHOU: pedido de leitura com a leitura desligada';
  exception when others then if sqlerrm not like '%leitura do estoque está desligada%' then raise; end if; end;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if cardinality(public.my_features()) <> 0 then raise exception 'FALHOU: piloto mostrou o menu ao gestor'; end if;
  begin perform public.stock_overview('all'); raise exception 'FALHOU: gestor leu o estoque no piloto';
  exception when others then if sqlerrm not like '%ainda não foi liberado%' then raise; end if; end;
end $$;
reset role;

-- 2. Worker com a leitura desligada não agenda nada.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
begin
  if public.stock_worker_enqueue('2030-01-01 07:40', 'intraday', '2030-01-01') <> 0 then
    raise exception 'FALHOU: leitura agendada com a leitura desligada';
  end if;
  if public.stock_worker_claim() is not null then raise exception 'FALHOU: havia leitura na fila'; end if;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if not (public.stock_admin_set_reading(true)->>'readingEnabled')::boolean then
    raise exception 'FALHOU: não ligou a leitura';
  end if;
  perform public.stock_admin_set_mode('on');
end $$;
reset role;

-- 3. Ciclo completo do worker: as duas empresas conectadas, a demonstração fica fora.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare
  v jsonb; n integer; i integer; r jsonb;
  ca text := current_setting('stk.ca'); cb text := current_setting('stk.cb');
begin
  n := public.stock_worker_enqueue('2030-01-01 07:40', 'intraday', '2030-01-01');
  if n <> 2 then raise exception 'FALHOU: esperava 2 leituras agendadas, veio %', n; end if;
  if public.stock_worker_enqueue('2030-01-01 07:40', 'intraday', '2030-01-01') <> 0 then
    raise exception 'FALHOU: o mesmo horário entrou duas vezes';
  end if;
  for i in 1..2 loop
    v := public.stock_worker_claim();
    if v is null then raise exception 'FALHOU: fila vazia na leitura %', i; end if;
    if (v->>'nextPage')::integer <> 1 or (v->>'locationsLoaded')::boolean then
      raise exception 'FALHOU: leitura nova não começou do início: %', v;
    end if;
    if v->>'companyId' = ca then
      perform public.stock_worker_save_locations((v->>'id')::uuid,
        '{"1": {"name": "Depósito"}, "2": {"name": "Showroom"}}');
      begin perform public.stock_worker_save_page((v->>'id')::uuid, 2, 2, 4, '[]');
        raise exception 'FALHOU: página fora de ordem aceita';
      exception when others then if sqlerrm not like '%página fora de ordem%' then raise; end if; end;
      r := public.stock_worker_save_page((v->>'id')::uuid, 1, 2, 4, jsonb_build_array(
        jsonb_build_object('omie_product_id', '101', 'location_code', '1', 'sku', 'CAD-101', 'name', 'Cadeira Ébano',
          'physical_qty', 10, 'reserved_qty', 2, 'pending_qty', 1, 'min_qty', 5, 'unit_cost', 100, 'sale_price', 180),
        jsonb_build_object('omie_product_id', '102', 'location_code', '1', 'sku', 'MES-102', 'name', 'Mesa Reta',
          'physical_qty', -2, 'unit_cost', 50, 'sale_price', 0)));
      if (r->>'saved')::integer <> 2 or (r->>'done')::boolean then raise exception 'FALHOU: página 1 de A: %', r; end if;
      r := public.stock_worker_save_page((v->>'id')::uuid, 2, 2, 4, jsonb_build_array(
        jsonb_build_object('omie_product_id', '101', 'location_code', '2', 'sku', 'CAD-101', 'name', 'Cadeira Ébano',
          'physical_qty', 1.5, 'min_qty', 5, 'unit_cost', 100, 'sale_price', 180),
        jsonb_build_object('omie_product_id', '103', 'location_code', '1', 'sku', 'NIC-103', 'name', 'Nicho',
          'physical_qty', 0, 'unit_cost', 30, 'sale_price', 60)));
      if not (r->>'done')::boolean then raise exception 'FALHOU: página 2 de A não fechou: %', r; end if;
    elsif v->>'companyId' = cb then
      perform public.stock_worker_save_locations((v->>'id')::uuid, '{}');
      r := public.stock_worker_save_page((v->>'id')::uuid, 1, 1, 1, jsonb_build_array(
        jsonb_build_object('omie_product_id', '201', 'location_code', '1', 'sku', 'ARM-201', 'name', 'Armário',
          'physical_qty', 4, 'unit_cost', 10, 'sale_price', 25)));
    else
      raise exception 'FALHOU: leitura de empresa inesperada %', v->>'companyId';
    end if;
    r := public.stock_worker_finish((v->>'id')::uuid);
    if not (r->>'published')::boolean then raise exception 'FALHOU: leitura não publicada: %', r; end if;
  end loop;
  if public.stock_worker_claim() is not null then raise exception 'FALHOU: sobrou leitura na fila'; end if;
end $$;
reset role;

-- 4. Gestor (empresa A): totais, escopo, filtros, busca sem acento, ordem e exportação negada.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; t jsonb; p jsonb;
begin
  if public.my_features() <> array['stock'] then raise exception 'FALHOU: menu não liberado ao gestor'; end if;
  v := public.stock_overview('all');
  if jsonb_array_length(v->'readings') <> 1 or v->'readings'->0->>'companyId' <> current_setting('stk.ca')
     or v->'readings'->0->>'status' <> 'ok' then
    raise exception 'FALHOU: leituras do gestor: %', v->'readings';
  end if;
  t := v->'totals';
  if (t->>'positions')::integer <> 4 or (t->>'positionsWithStock')::integer <> 3
     or (t->>'units')::numeric <> 9.5 or (t->>'costValue')::numeric <> 1050
     or (t->>'reservedQty')::numeric <> 2 or (t->>'pendingQty')::numeric <> 1
     or (t->>'negativePositions')::integer <> 1 or (t->>'unclassifiedPositions')::integer <> 4
     or (t->>'belowMinPositions')::integer <> 1 then
    raise exception 'FALHOU: totais do gestor: %', t;
  end if;
  if jsonb_array_length(v->'byCurve') <> 5 or v->'byCurve'->4->>'curve' <> 'U'
     or (v->'byCurve'->4->>'share')::numeric <> 100 then
    raise exception 'FALHOU: curvas do gestor: %', v->'byCurve';
  end if;
  begin perform public.stock_overview(current_setting('stk.cb')); raise exception 'FALHOU: gestor leu a empresa B';
  exception when others then if sqlerrm not like '%fora do seu acesso%' then raise; end if; end;
  begin perform public.stock_overview('nao-e-uuid'); raise exception 'FALHOU: empresa inválida aceita';
  exception when others then if sqlerrm not like '%Empresa inválida%' then raise; end if; end;

  p := public.stock_positions('{"companyId": "all", "page": 0}');
  if (p->>'total')::integer <> 4 or p->'rows'->0->>'omieProductId' <> '101' or p->'rows'->0->>'locationCode' <> '1'
     or p->'rows'->0->>'productId' <> current_setting('stk.pa') or p->'rows'->0->>'family' <> 'Cadeiras'
     or p->'rows'->0->>'locationName' <> 'Depósito' or (p->'rows'->0->>'costValue')::numeric <> 1000
     or p->'rows'->0->>'id' <> current_setting('stk.ca') || ':101:1' then
    raise exception 'FALHOU: primeira posição do gestor: %', p->'rows'->0;
  end if;
  if (public.stock_positions('{"companyId": "all", "page": 0, "search": "ebano"}')->>'total')::integer <> 2
     or (public.stock_positions('{"companyId": "all", "page": 0, "onlyNegative": true}')->>'total')::integer <> 1
     or (public.stock_positions('{"companyId": "all", "page": 0, "hideZero": true}')->>'total')::integer <> 3
     or (public.stock_positions('{"companyId": "all", "page": 0, "belowMin": true}')->>'total')::integer <> 1
     or (public.stock_positions('{"companyId": "all", "page": 0, "locationCode": "2"}')->>'total')::integer <> 1
     or (public.stock_positions('{"companyId": "all", "page": 1}')->>'total')::integer <> 4
     or jsonb_array_length(public.stock_positions('{"companyId": "all", "page": 1}')->'rows') <> 0
     or (public.stock_positions(jsonb_build_object('companyId', 'all', 'page', 0, 'productId',
          current_setting('stk.pa')))->>'total')::integer <> 2 then
    raise exception 'FALHOU: filtros de posições do gestor';
  end if;
  p := public.stock_positions('{"companyId": "all", "page": 0, "sortBy": "name", "sortDir": "asc"}');
  if p->'rows'->0->>'name' <> 'Cadeira Ébano' or p->'rows'->3->>'name' <> 'Nicho' then
    raise exception 'FALHOU: ordem por nome: %', p->'rows';
  end if;
  begin perform public.stock_positions('{"companyId": "all", "page": -1}'); raise exception 'FALHOU: gestor exportou';
  exception when others then if sqlerrm not like '%não pode exportar%' then raise; end if; end;
  begin perform public.stock_positions('{"companyId": "all", "page": 0, "curve": "Z"}'); raise exception 'FALHOU: curva inválida aceita';
  exception when others then if sqlerrm not like '%Consulta inválida%' then raise; end if; end;
  v := public.stock_filter_options('all');
  if jsonb_array_length(v->'locations') <> 2 or v->'families' <> '["Cadeiras"]'::jsonb then
    raise exception 'FALHOU: opções de filtro: %', v;
  end if;
  v := public.stock_simulation_base('all');
  if jsonb_array_length(v->'items') <> 4 or v->>'readAt' is null then
    raise exception 'FALHOU: base da simulação do gestor: %', v;
  end if;
  begin perform public.stock_request_refresh(current_setting('stk.ca')); raise exception 'FALHOU: gestor pediu leitura';
  exception when others then if sqlerrm not like '%não pode solicitar leitura%' then raise; end if; end;
end $$;
reset role;

-- 5. Vendedor: quantidades sim, custo e simulação não; não classifica.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; p jsonb;
begin
  v := public.stock_capabilities();
  if (v->>'viewCost')::boolean or (v->>'classify')::boolean or (v->>'export')::boolean then
    raise exception 'FALHOU: capacidades do vendedor: %', v;
  end if;
  v := public.stock_overview('all');
  if v->'totals'->'costValue' <> 'null'::jsonb or v->'byCurve'->0->'costValue' <> 'null'::jsonb
     or v->'byCompany'->0->'costValue' <> 'null'::jsonb or (v->'totals'->>'units')::numeric <> 9.5 then
    raise exception 'FALHOU: vendedor viu custo na visão geral: %', v;
  end if;
  p := public.stock_positions('{"companyId": "all", "page": 0, "sortBy": "costValue"}');
  if p->'rows'->0->'unitCost' <> 'null'::jsonb or p->'rows'->0->'costValue' <> 'null'::jsonb
     or p->'rows'->0->'salePrice' <> 'null'::jsonb or p->'rows'->0->>'name' <> 'Cadeira Ébano' then
    raise exception 'FALHOU: vendedor viu custo nas posições: %', p->'rows'->0;
  end if;
  begin perform public.stock_simulation_base('all'); raise exception 'FALHOU: vendedor abriu a simulação';
  exception when others then if sqlerrm not like '%não custos ou simulações%' then raise; end if; end;
  begin perform public.stock_set_curve(array[current_setting('stk.ca') || ':101:1'], 'A');
    raise exception 'FALHOU: vendedor classificou';
  exception when others then if sqlerrm not like '%não pode classificar%' then raise; end if; end;
end $$;
reset role;

-- 6. Visualizador: sem acesso ao módulo (nem pela API).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.vi'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if cardinality(public.my_features()) <> 0 then raise exception 'FALHOU: menu para o visualizador'; end if;
  begin perform public.stock_overview('all'); raise exception 'FALHOU: visualizador leu o estoque';
  exception when others then if sqlerrm not like '%não tem acesso ao Estoque%' then raise; end if; end;
end $$;
reset role;

-- 7. Curva: analista comum não classifica; com a permissão extra, sim, e vale para o produto inteiro.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.an'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin perform public.stock_set_curve(array[current_setting('stk.ca') || ':101:1'], 'A');
    raise exception 'FALHOU: analista classificou sem permissão';
  exception when others then if sqlerrm not like '%não pode classificar%' then raise; end if; end;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.an2'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  begin perform public.stock_set_curve(array[current_setting('stk.ca') || ':101:1'], 'A');
    raise exception 'FALHOU: curva manual sem justificativa aceita';
  exception when others then if sqlerrm not like '%Informe a justificativa%' then raise; end if; end;
  v := public.stock_set_curve(array[current_setting('stk.ca') || ':101:1'], 'A', 'Teste automático: curva manual');
  if (v->>'updated')::integer <> 2 then raise exception 'FALHOU: curva não valeu para os 2 locais: %', v; end if;
  if (public.stock_positions('{"companyId": "all", "page": 0, "curve": "A"}')->>'total')::integer <> 2 then
    raise exception 'FALHOU: posições da curva A';
  end if;
  begin perform public.stock_set_curve(array[current_setting('stk.cb') || ':201:1'], 'A', 'Teste automático: curva manual');
    raise exception 'FALHOU: classificou produto de empresa sem acesso';
  exception when others then if sqlerrm not like '%Selecione posições válidas%' then raise; end if; end;
  begin perform public.stock_set_curve(array['lixo'], 'A', 'Teste automático: curva manual'); raise exception 'FALHOU: id inválido aceito';
  exception when others then if sqlerrm not like '%Selecione posições válidas%' then raise; end if; end;
  begin perform public.stock_set_curve(array[current_setting('stk.ca') || ':999:1'], 'A', 'Teste automático: curva manual');
    raise exception 'FALHOU: posição inexistente aceita';
  exception when others then if sqlerrm not like '%Selecione posições válidas%' then raise; end if; end;
  begin perform public.stock_set_curve(array[current_setting('stk.ca') || ':101:1'], 'X');
    raise exception 'FALHOU: curva X aceita';
  exception when others then if sqlerrm not like '%Selecione posições válidas%' then raise; end if; end;
  v := public.stock_set_curve(array[current_setting('stk.ca') || ':102:1'], 'D', 'Teste automático: curva manual');
  if (v->>'updated')::integer <> 1 then raise exception 'FALHOU: curva D: %', v; end if;
  v := public.stock_set_curve(array[current_setting('stk.ca') || ':102:1'], 'U');
  if (public.stock_positions('{"companyId": "all", "page": 0, "curve": "U"}')->>'total')::integer <> 2 then
    raise exception 'FALHOU: voltar para sem curva';
  end if;
end $$;
reset role;

-- 8. Cenários: até 5 por pessoa, validação no banco, cada um só vê os seus.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; i integer; first_id text;
begin
  for i in 1..5 loop
    v := public.stock_save_scenario(jsonb_build_object('name', '  Cenário ' || i || '  ',
      'cuts', jsonb_build_object('A', 0, 'B', 10 * i, 'C', 20, 'D', 100), 'discount', 10));
    if i = 1 then first_id := v->>'id'; end if;
  end loop;
  if v->>'name' <> 'Cenário 5' or jsonb_array_length(public.stock_scenarios()) <> 5 then
    raise exception 'FALHOU: cenários salvos: %', public.stock_scenarios();
  end if;
  begin perform public.stock_save_scenario('{"name": "Sexto", "cuts": {"A":0,"B":0,"C":0,"D":0}, "discount": 0}');
    raise exception 'FALHOU: sexto cenário aceito';
  exception when others then if sqlerrm not like '%5 cenários%' then raise; end if; end;
  v := public.stock_save_scenario(jsonb_build_object('id', first_id, 'name', 'Renomeado',
    'cuts', jsonb_build_object('A', 0, 'B', 35, 'C', 75, 'D', 100), 'discount', 30));
  if v->>'name' <> 'Renomeado' or (v->'cuts'->>'B')::integer <> 35 then raise exception 'FALHOU: atualizar cenário: %', v; end if;
  begin perform public.stock_save_scenario('{"name": "x", "cuts": {"A":101,"B":0,"C":0,"D":0}, "discount": 0}');
    raise exception 'FALHOU: corte 101 aceito';
  exception when others then if sqlerrm not like '%percentuais válidos%' then raise; end if; end;
  begin perform public.stock_save_scenario('{"name": "x", "cuts": {"A":"dez","B":0,"C":0,"D":0}, "discount": 0}');
    raise exception 'FALHOU: corte em texto aceito';
  exception when others then if sqlerrm not like '%percentuais válidos%' then raise; end if; end;
  begin perform public.stock_save_scenario('{"name": "x", "cuts": [1,2,3,4], "discount": 0}');
    raise exception 'FALHOU: cortes em lista aceitos';
  exception when others then if sqlerrm not like '%percentuais válidos%' then raise; end if; end;
  begin perform public.stock_save_scenario('{"name": "x", "cuts": {"A":0,"B":0,"C":0,"D":0}, "discount": 71}');
    raise exception 'FALHOU: desconto 71 aceito';
  exception when others then if sqlerrm not like '%percentuais válidos%' then raise; end if; end;
  begin perform public.stock_save_scenario('{"name": "x", "cuts": {"A":0,"B":0.5,"C":0,"D":0}, "discount": 0}');
    raise exception 'FALHOU: corte fracionado aceito';
  exception when others then if sqlerrm not like '%percentuais válidos%' then raise; end if; end;
  perform public.stock_delete_scenario(first_id::uuid);
  if jsonb_array_length(public.stock_scenarios()) <> 4 then raise exception 'FALHOU: excluir cenário'; end if;
  perform set_config('stk.scenario', (public.stock_scenarios()->0->>'id'), true);
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.fi'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  if jsonb_array_length(public.stock_scenarios()) <> 0 then raise exception 'FALHOU: viu cenário de outra pessoa'; end if;
  begin perform public.stock_delete_scenario(current_setting('stk.scenario')::uuid);
    raise exception 'FALHOU: excluiu cenário de outra pessoa';
  exception when others then if sqlerrm not like '%Cenário não encontrado%' then raise; end if; end;
  -- Financeiro (A e B) exporta e enxerga as duas empresas.
  v := public.stock_positions('{"companyId": "all", "page": -1}');
  if (v->>'total')::integer <> 5 or jsonb_array_length(v->'rows') <> 5 then
    raise exception 'FALHOU: exportação do financeiro: %', v->>'total';
  end if;
  if jsonb_array_length(public.stock_overview('all')->'readings') <> 2 then
    raise exception 'FALHOU: financeiro não viu as duas empresas';
  end if;
end $$;
reset role;

-- 9. Pedido de leitura: só Admin, uma empresa, sem repetir enquanto há leitura na fila.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ad'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  begin perform public.stock_request_refresh('all'); raise exception 'FALHOU: pedido para todas as empresas';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' then raise; end if; end;
  begin perform public.stock_request_refresh(current_setting('stk.cb')); raise exception 'FALHOU: pedido para empresa sem acesso';
  exception when others then if sqlerrm not like '%fora do seu acesso%' then raise; end if; end;
  v := public.stock_request_refresh(current_setting('stk.ca'));
  if not (v->>'queued')::boolean then raise exception 'FALHOU: pedido não entrou: %', v; end if;
  v := public.stock_request_refresh(current_setting('stk.ca'));
  if (v->>'queued')::boolean or not (v->>'inProgress')::boolean then
    raise exception 'FALHOU: pedido repetido entrou: %', v;
  end if;
  if not (public.stock_overview(current_setting('stk.ca'))->'readings'->0->>'inProgress')::boolean then
    raise exception 'FALHOU: visão geral não mostra a leitura em andamento';
  end if;
end $$;
reset role;

-- 10. A leitura pedida: total que muda no meio recomeça; posição repetida recomeça; falha final não
--     derruba a posição publicada; e uma leitura completa nova preserva as curvas.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; r jsonb; rid uuid;
begin
  v := public.stock_worker_claim();
  if v is null or v->>'companyId' <> current_setting('stk.ca') then raise exception 'FALHOU: pedido manual não veio: %', v; end if;
  rid := (v->>'id')::uuid;
  perform set_config('stk.manual', rid::text, true);
  perform public.stock_worker_save_locations(rid, '{"1": {"name": "Depósito"}}');
  r := public.stock_worker_save_page(rid, 1, 2, 3, jsonb_build_array(jsonb_build_object('omie_product_id', '101',
    'location_code', '1', 'sku', 'CAD-101', 'name', 'Cadeira Ébano', 'physical_qty', 9, 'unit_cost', 100)));
  r := public.stock_worker_save_page(rid, 2, 3, 3, '[]');
  if not (r->>'restarted')::boolean then raise exception 'FALHOU: total mudou e não recomeçou: %', r; end if;
end $$;
reset role;

do $$
begin
  if (select status from private.stock_readings where id = current_setting('stk.manual')::uuid) <> 'queued'
     or exists (select 1 from private.stock_positions where reading_id = current_setting('stk.manual')::uuid) then
    raise exception 'FALHOU: recomeço não limpou a leitura';
  end if;
  update private.stock_readings set next_attempt_at = now() where id = current_setting('stk.manual')::uuid;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; r jsonb; rid uuid;
begin
  v := public.stock_worker_claim();
  rid := (v->>'id')::uuid;
  if rid <> current_setting('stk.manual')::uuid or (v->>'locationsLoaded')::boolean then
    raise exception 'FALHOU: recomeço não voltou do início: %', v;
  end if;
  perform public.stock_worker_save_locations(rid, '{}');
  r := public.stock_worker_save_page(rid, 1, 1, 2, jsonb_build_array(
    jsonb_build_object('omie_product_id', '101', 'location_code', '1', 'sku', 'CAD-101', 'name', 'Cadeira Ébano',
      'physical_qty', 9, 'unit_cost', 100),
    jsonb_build_object('omie_product_id', '101', 'location_code', '1', 'sku', 'CAD-101', 'name', 'Cadeira Ébano',
      'physical_qty', 9, 'unit_cost', 100)));
  if not (r->>'restarted')::boolean then raise exception 'FALHOU: posição repetida aceita: %', r; end if;
end $$;
reset role;

do $$
begin
  update private.stock_readings set next_attempt_at = now() where id = current_setting('stk.manual')::uuid;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; r jsonb;
begin
  v := public.stock_worker_claim();
  r := public.stock_worker_fail((v->>'id')::uuid, 'Credenciais Omie recusadas.', 60, true);
  if not (r->>'final')::boolean then raise exception 'FALHOU: falha final não encerrou: %', r; end if;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ad'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.stock_overview(current_setting('stk.ca'));
  if v->'readings'->0->>'status' <> 'failed' or v->'readings'->0->>'lastError' <> 'Credenciais Omie recusadas.'
     or (v->'totals'->>'positions')::integer <> 4 then
    raise exception 'FALHOU: falha derrubou a posição ou não apareceu ao admin: %', v->'readings';
  end if;
  -- Curva antes da leitura nova.
  perform public.stock_set_curve(array[current_setting('stk.ca') || ':103:1'], 'C', 'Teste automático: curva manual');
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ge'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if public.stock_overview(current_setting('stk.ca'))->'readings'->0->'lastError' <> 'null'::jsonb then
    raise exception 'FALHOU: mensagem técnica de falha visível ao gestor';
  end if;
end $$;
reset role;

do $$
begin
  -- Libera o intervalo mínimo entre pedidos manuais para o próximo passo.
  update private.stock_readings set created_at = now() - interval '1 hour' where trigger = 'manual';
end $$;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.ad'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if not (public.stock_request_refresh(current_setting('stk.ca'))->>'queued')::boolean then
    raise exception 'FALHOU: novo pedido não entrou';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; r jsonb; rid uuid;
begin
  v := public.stock_worker_claim();
  rid := (v->>'id')::uuid;
  perform set_config('stk.second', rid::text, true);
  perform public.stock_worker_save_locations(rid, '{"1": {"name": "Depósito"}}');
  r := public.stock_worker_save_page(rid, 1, 1, 2, jsonb_build_array(
    jsonb_build_object('omie_product_id', '101', 'location_code', '1', 'sku', 'CAD-101', 'name', 'Cadeira Ébano',
      'physical_qty', 7, 'unit_cost', 100, 'sale_price', 180),
    jsonb_build_object('omie_product_id', '103', 'location_code', '1', 'sku', 'NIC-103', 'name', 'Nicho',
      'physical_qty', 3, 'unit_cost', 30, 'sale_price', 60)));
  -- Conferência final: total declarado 2, recebido 2.
  r := public.stock_worker_finish(rid);
  if not (r->>'published')::boolean then raise exception 'FALHOU: segunda leitura não publicada: %', r; end if;
end $$;
reset role;

do $$
declare v_first uuid;
begin
  if (select reading_id from private.stock_current where company_id = current_setting('stk.ca')::uuid)
     <> current_setting('stk.second')::uuid then
    raise exception 'FALHOU: leitura nova não virou a atual';
  end if;
  select r.id into v_first from private.stock_readings r
    where r.company_id = current_setting('stk.ca')::uuid and r.slot = '2030-01-01 07:40';
  if (select status from private.stock_readings where id = v_first) <> 'superseded'
     or exists (select 1 from private.stock_positions where reading_id = v_first) then
    raise exception 'FALHOU: leitura antiga do dia não foi substituída';
  end if;
  if not exists (select 1 from public.audit_log where action = 'stock.curve.changed'
                 and payload->>'companyId' = current_setting('stk.ca'))
     or not exists (select 1 from public.audit_log where action = 'stock.scenario.saved')
     or not exists (select 1 from public.audit_log where action = 'stock.refresh.requested')
     or not exists (select 1 from public.audit_log where action = 'stock.module.mode') then
    raise exception 'FALHOU: auditoria do Estoque incompleta';
  end if;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.an2'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare p jsonb;
begin
  p := public.stock_positions('{"companyId": "all", "page": 0, "sortBy": "name", "sortDir": "asc"}');
  if (p->>'total')::integer <> 2 or p->'rows'->0->>'curve' <> 'A' or p->'rows'->1->>'curve' <> 'C' then
    raise exception 'FALHOU: curvas não sobreviveram à leitura nova: %', p->'rows';
  end if;
end $$;
reset role;

-- 10b. Leitura longa (0042): recomeça só se ficar 30 min sem avançar ou passar de 3 h desde o início.
--      MAG Filial em 22/10/2026: 11.088 posições em 222 páginas de 50, mais de 30 min de leitura.
do $$
declare rid uuid;
begin
  if exists (select 1 from private.stock_readings where status in ('queued', 'running')) then
    raise exception 'FALHOU: fila do teste deveria estar vazia antes da leitura longa';
  end if;
  insert into private.stock_readings (company_id, kind, trigger, status, position_date, pages_total, pages_done,
      records_expected, records_received, locations, attempts, started_at, progress_at)
    values (current_setting('stk.cb')::uuid, 'intraday', 'manual', 'running', current_date, 222, 150,
      11088, 0, '{}', 1, now() - interval '40 minutes', now() - interval '1 minute')
    returning id into rid;
  perform set_config('stk.long', rid::text, true);
end $$;

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb;
begin
  -- 40 min desde o início, avançou há 1 min: continua da página 151.
  v := public.stock_worker_claim();
  if (v->>'id')::uuid <> current_setting('stk.long')::uuid or (v->>'nextPage')::integer <> 151 then
    raise exception 'FALHOU: leitura longa que avança foi recomeçada: %', v;
  end if;
  perform public.stock_worker_save_page((v->>'id')::uuid, 151, 222, 11088, '[]');
end $$;
reset role;

do $$
begin
  if (select progress_at from private.stock_readings where id = current_setting('stk.long')::uuid)
     < now() - interval '1 second' then
    raise exception 'FALHOU: página gravada não marcou o avanço';
  end if;
  -- Sem avançar há 31 min.
  update private.stock_readings set progress_at = now() - interval '31 minutes'
    where id = current_setting('stk.long')::uuid;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb;
begin
  v := public.stock_worker_claim();
  if (v->>'id')::uuid <> current_setting('stk.long')::uuid or (v->>'nextPage')::integer <> 1
     or (v->>'locationsLoaded')::boolean then
    raise exception 'FALHOU: leitura parada não recomeçou do início: %', v;
  end if;
end $$;
reset role;

do $$
declare r private.stock_readings;
begin
  select * into r from private.stock_readings where id = current_setting('stk.long')::uuid;
  if r.error <> 'Leitura parada por mais de 30 minutos; recomeçando.' or r.pages_done <> 0
     or r.progress_at is null or r.attempts <> 2 then
    raise exception 'FALHOU: recomeço por parada sem motivo ou contagem: % % % %', r.error, r.pages_done,
      r.progress_at, r.attempts;
  end if;
  -- Avançando, mas iniciada há mais de 3 h.
  update private.stock_readings set started_at = now() - interval '3 hours 1 minute',
      progress_at = now() - interval '1 minute', pages_done = 10, pages_total = 222, records_expected = 11088
    where id = current_setting('stk.long')::uuid;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb;
begin
  v := public.stock_worker_claim();
  if (v->>'id')::uuid <> current_setting('stk.long')::uuid or (v->>'nextPage')::integer <> 1 then
    raise exception 'FALHOU: leitura de mais de 3 h não recomeçou: %', v;
  end if;
  perform public.stock_worker_fail((v->>'id')::uuid, 'Teste encerrado.', 60, true);
end $$;
reset role;

do $$
begin
  if (select status || ' ' || error from private.stock_readings where id = current_setting('stk.long')::uuid)
     <> 'failed Teste encerrado.' then
    raise exception 'FALHOU: leitura longa não encerrou';
  end if;
end $$;

-- 11. Permissões extras do Estoque no Admin 2.0.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  perform public.admin_update_access(current_setting('stk.an')::uuid, '{"permissions": ["stock.view_cost", "stock.export"]}');
  begin perform public.admin_update_access(current_setting('stk.an')::uuid, '{"permissions": ["stock.tudo"]}');
    raise exception 'FALHOU: permissão desconhecida aceita';
  exception when others then if sqlerrm not like '%Permissão desconhecida%' then raise; end if; end;
end $$;
reset role;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('stk.an'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if not (public.stock_capabilities()->>'export')::boolean then raise exception 'FALHOU: permissão extra de exportar'; end if;
  perform public.stock_positions('{"companyId": "all", "page": -1}');
  raise notice 'PASS Estoque: liberação, papéis, escopo, custo, curva, cenários, leitura (inclusive longa) e worker';
end $$;
reset role;

rollback;
