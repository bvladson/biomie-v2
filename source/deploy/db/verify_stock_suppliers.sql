\set ON_ERROR_STOP on
-- Estoque, migração 0048: fornecedores do Omie e prazos de entrega por empresa, produto e fornecedor.
-- Importação (fila, página fora de ordem, total que muda, idempotência, vínculos que somem, importação
-- vazia que não apaga, falha com espera mínima), cadastro do BIOMIE reaproveitado (sem duplicar),
-- permissão de Compras (stock.purchasing) e do Super admin, Admin sem a permissão só lê, Comercial
-- (vendedor) sem a área de fornecedores (ajuste de 27/10: consulta previsões e reposições), validações, histórico e Auditoria com valor anterior e novo, prazo de teste só
-- lido com o ajuste da homologação, filtros por fornecedor (uma empresa), dados oficiais intocados.
-- Empresas, produtos e usuários sintéticos; tudo é desfeito no fim. Banco de TESTE.
begin;
do $$
declare
  t date := stock_internal.as_of();
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid(); cd uuid := gen_random_uuid();
  su uuid := gen_random_uuid(); co uuid := gen_random_uuid(); ad uuid := gen_random_uuid();
  ve uuid := gen_random_uuid();
  ra uuid := gen_random_uuid(); rb uuid := gen_random_uuid();
begin
  insert into public.companies (id, name, slug, data_source, revenue_basis, is_demo) values
    (ca, 'Fornecedores A (teste)', 'sup-a-' || ca, 'OMIE_SHADOW', 'commercial_base', false),
    (cb, 'Fornecedores B (teste)', 'sup-b-' || cb, 'OMIE', 'commercial_base', false),
    (cd, 'Fornecedores DEMO', 'sup-d-' || cd, 'DEMO', 'commercial_base', true);
  insert into public.company_integrations (company_id, provider, status) values
    (ca, 'omie', 'CONNECTED'), (cb, 'omie', 'CONNECTED');
  insert into auth.users (id, email, created_at) values
    (su, 'sup-su-' || su || '@invalid.example', now()), (co, 'sup-co-' || co || '@invalid.example', now()),
    (ad, 'sup-ad-' || ad || '@invalid.example', now()), (ve, 'sup-ve-' || ve || '@invalid.example', now());
  insert into public.profiles (id, email, full_name) values (su, 'sup-su@x', 'Super Fornecedores'),
    (co, 'sup-co@x', 'Compras Teste'), (ad, 'sup-ad@x', 'Admin Teste'), (ve, 'sup-ve@x', 'Vendedor Teste');
  -- Compras: papel sem acesso ao Estoque + a permissão extra (que dá leitura e os prazos, não o custo).
  insert into public.user_roles (user_id, role) values (su, 'SUPER_ADMIN'), (co, 'VIEWER'), (ad, 'ADMIN'),
    (ve, 'VENDEDOR');
  insert into public.user_company_access (user_id, company_id) values (co, ca), (ad, ca), (ve, ca);
  insert into public.user_permissions (user_id, permission) values (co, 'stock.purchasing');
  insert into public.customers (company_id, name, state, city, source, external_id) values
    (ca, 'Fornecedor Alfa', 'CE', 'Fortaleza', 'omie', '9001'), (ca, 'Fornecedor Beta', 'SP', 'Campinas', 'omie', '9002'),
    (ca, 'Gama Móveis', 'CE', 'Caucaia', 'omie', '9003'), (cb, 'Outro na B', 'CE', 'Sobral', 'omie', '9001');
  insert into public.products (company_id, name, category, base_price, sku, source, external_id) values
    (ca, 'Cadeira X', 'Cadeiras', 0, 'SUP-X', 'omie', '501'), (ca, 'Mesa Y', 'Mesas', 0, 'SUP-Y', 'omie', '502'),
    (ca, 'Armário Z', 'Armários', 0, 'SUP-Z', 'omie', '503'), (ca, 'Banco W', 'Bancos', 0, 'SUP-W', 'omie', '504'),
    (cb, 'Cadeira X', 'Cadeiras', 0, 'SUP-X', 'omie', '601');
  insert into private.stock_readings (id, company_id, kind, trigger, status, position_date, pages_total, pages_done,
      records_expected, records_received, locations, attempts, finished_at) values
    (ra, ca, 'close', 'manual', 'complete', t, 1, 1, 4, 4, '{"1": {"name": "Depósito"}}', 1, now()),
    (rb, cb, 'close', 'manual', 'complete', t, 1, 1, 1, 1, '{"1": {"name": "Depósito"}}', 1, now());
  insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
      physical_qty, reserved_qty, pending_qty, unit_cost, sale_price) values
    (ra, ca, '501', '1', 'SUP-X', 'Cadeira X', 100, 0, 0, 40, 90), (ra, ca, '502', '1', 'SUP-Y', 'Mesa Y', 2, 0, 0, 200, 500),
    (ra, ca, '503', '1', 'SUP-Z', 'Armário Z', 0, 0, 0, 300, 700), (ra, ca, '504', '1', 'SUP-W', 'Banco W', 7, 0, 0, 30, 60),
    (rb, cb, '601', '1', 'SUP-X', 'Cadeira X', 5, 0, 0, 40, 90);
  insert into private.stock_current (company_id, reading_id, published_at) values (ca, ra, now()), (cb, rb, now());
  update private.feature_flags set mode = 'on' where key = 'stock';
  perform set_config('sup.ca', ca::text, true); perform set_config('sup.cb', cb::text, true);
  perform set_config('sup.su', su::text, true); perform set_config('sup.co', co::text, true);
  perform set_config('sup.ad', ad::text, true); perform set_config('sup.ve', ve::text, true);
  perform set_config('sup.t', t::text, true);
end $$;
select set_config('sup.official', (select json_build_object(
  'positions', (select count(*) from private.stock_positions), 'products', (select count(*) from public.products),
  'customers', (select count(*) from public.customers), 'curves', (select count(*) from private.stock_curves))::text), true);

-- 1. Importação pelo worker (service_role): fila, páginas, idempotência, cadastro reaproveitado.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; job uuid; ca uuid := current_setting('sup.ca')::uuid; cb uuid := current_setting('sup.cb')::uuid;
  p1 jsonb := '[{"supplier_id": "9001", "name": "ALFA COMERCIO LTDA", "trade_name": "Alfa",
                 "products": [{"omie": "501", "code": "A-501"}, {"omie": "502", "code": "A-502"}, {"omie": "502", "code": "dup"}]},
                {"supplier_id": "9002", "name": "BETA SA", "trade_name": null, "products": [{"omie": "501", "code": "B-1"}]}]';
  p2 jsonb := '[{"supplier_id": "9004", "name": "DELTA INDUSTRIA", "trade_name": "", "products": [{"omie": "503", "code": null},
                 {"omie": "0", "code": "inválido"}]}, {"supplier_id": "abc", "name": "Inválido", "products": []}]';
begin
  if public.stock_worker_suppliers_enqueue(null, 'ops') <> 2 then raise exception 'FALHOU: fila das duas empresas reais'; end if;
  if public.stock_worker_suppliers_enqueue(null, 'ops') <> 0 then raise exception 'FALHOU: segunda importação aberta'; end if;
  begin perform public.stock_worker_suppliers_enqueue(null, 'qualquer'); raise exception 'FALHOU: gatilho inválido aceito';
  exception when others then if sqlerrm not like '%inválido%' then raise; end if; end;
end $$;
reset role;
-- A empresa B vai primeiro na fila (pedido mais antigo).
update private.stock_supplier_jobs set created_at = created_at - interval '1 hour' where company_id = current_setting('sup.cb')::uuid;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; job uuid; ca uuid := current_setting('sup.ca')::uuid; cb uuid := current_setting('sup.cb')::uuid;
  p1 jsonb := '[{"supplier_id": "9001", "name": "ALFA COMERCIO LTDA", "trade_name": "Alfa",
                 "products": [{"omie": "501", "code": "A-501"}, {"omie": "502", "code": "A-502"}, {"omie": "502", "code": "dup"}]},
                {"supplier_id": "9002", "name": "BETA SA", "trade_name": null, "products": [{"omie": "501", "code": "B-1"}]}]';
  p2 jsonb := '[{"supplier_id": "9004", "name": "DELTA INDUSTRIA", "trade_name": "", "products": [{"omie": "503", "code": null},
                 {"omie": "0", "code": "inválido"}]}, {"supplier_id": "abc", "name": "Inválido", "products": []}]';
begin
  -- A empresa B: falha temporária espera pelo menos 2 min; depois falha final.
  v := public.stock_worker_suppliers_claim();
  if (v->>'companyId')::uuid <> cb or (v->>'nextPage')::integer <> 1 then raise exception 'FALHOU: ordem da fila: %', v; end if;
  job := (v->>'id')::uuid;
  perform set_config('sup.jobb', job::text, true);
  perform public.stock_worker_suppliers_fail(job, 'Omie ocupado', 10, false);
  -- A empresa A (a B espera a nova tentativa): duas páginas, total que muda no meio, página fora de ordem.
  v := public.stock_worker_suppliers_claim();
  job := (v->>'id')::uuid;
  if (v->>'companyId')::uuid <> ca then raise exception 'FALHOU: segunda da fila: %', v; end if;
  perform set_config('sup.job1', job::text, true);
  v := public.stock_worker_suppliers_save_page(job, 1, 2, 3, p1, 0);
  if (v->>'done')::boolean or (v->>'links')::integer <> 3 then raise exception 'FALHOU: página 1: %', v; end if;
  begin perform public.stock_worker_suppliers_save_page(job, 3, 2, 3, p2, 0); raise exception 'FALHOU: página fora de ordem aceita';
  exception when others then if sqlerrm not like '%página de fornecedores inválida%' then raise; end if; end;
  v := public.stock_worker_suppliers_save_page(job, 2, 2, 4, p2, 1);
  if not (v->>'restarted')::boolean then raise exception 'FALHOU: total mudou e não recomeçou: %', v; end if;
  perform public.stock_worker_suppliers_save_page(job, 1, 2, 3, p1, 0);
  v := public.stock_worker_suppliers_save_page(job, 2, 2, 3, p2, 1);
  if not (v->>'done')::boolean then raise exception 'FALHOU: última página: %', v; end if;
  v := public.stock_worker_suppliers_finish(job);
  if (v->>'links')::integer <> 7 or (v->>'linksRemoved')::integer <> 0 or (v->>'keptPrevious')::boolean then
    raise exception 'FALHOU: fim da importação: %', v;
  end if;
end $$;
reset role;
do $$
begin
  if (select next_attempt_at < now() + interval '119 seconds' or status <> 'queued' from private.stock_supplier_jobs
      where id = current_setting('sup.jobb')::uuid) then
    raise exception 'FALHOU: nova tentativa antes de 2 minutos';
  end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
begin
  if public.stock_worker_suppliers_claim() is not null then raise exception 'FALHOU: fila devolveu job esperando'; end if;
  if not (public.stock_worker_suppliers_fail(current_setting('sup.jobb')::uuid, 'Credencial recusada', null, true)->>'final')::boolean then
    raise exception 'FALHOU: falha final';
  end if;
end $$;
reset role;
do $$
declare ca uuid := current_setting('sup.ca')::uuid;
begin
  if (select status from private.stock_supplier_jobs where id = current_setting('sup.jobb')::uuid) <> 'failed' then
    raise exception 'FALHOU: falha final gravada';
  end if;
  if (select count(*) from private.stock_product_suppliers where company_id = ca) <> 4
     or (select count(*) from private.stock_suppliers where company_id = ca) <> 3
     or (select supplier_code from private.stock_product_suppliers where company_id = ca and omie_product_id = '502'
         and supplier_id = '9001') not in ('A-502', 'dup') then
    raise exception 'FALHOU: vínculos gravados (repetidos e inválidos fora)';
  end if;
  if (select customer_id is null from private.stock_suppliers where company_id = ca and supplier_id = '9001')
     or (select customer_id is not null from private.stock_suppliers where company_id = ca and supplier_id = '9004')
     or stock_internal.supplier_display(ca, '9001') <> 'Fornecedor Alfa'
     or stock_internal.supplier_display(ca, '9004') <> 'DELTA INDUSTRIA'
     or stock_internal.supplier_display(ca, '9002') <> 'Fornecedor Beta' then
    raise exception 'FALHOU: cadastro do BIOMIE reaproveitado e nome do Omie só sem cadastro';
  end if;
end $$;

-- 2. Compras: lê sem custo, informa prazos, fornecedor principal e vínculo manual; validações.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.co'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('sup.ca');
begin
  v := public.stock_capabilities();
  if not (v->>'purchasing')::boolean or not (v->>'view')::boolean or (v->>'viewCost')::boolean or (v->>'classify')::boolean
     or not (v->>'suppliers')::boolean then
    raise exception 'FALHOU: capacidades de Compras: %', v;
  end if;
  v := public.stock_suppliers(jsonb_build_object('companyId', ca));
  if (v->>'total')::integer <> 3 or not (v->>'canEdit')::boolean or (v->>'canImport')::boolean
     or v->'rows'->0->>'supplierId' <> '9001' or (v->'rows'->0->>'productsWithStock')::integer <> 2
     or (v->'summary'->>'productsWithStock')::integer <> 3 or (v->'summary'->>'productsWithStockLinked')::integer <> 2
     or (v->'summary'->>'productsWithStockConfirmed')::integer <> 0 or v->'summary'->'lastJob'->>'status' <> 'complete' then
    raise exception 'FALHOU: lista de fornecedores: %', v;
  end if;
  v := public.stock_lead_time_set(ca, '9001', '', '{"leadTimeDays": 20}', 'Prazo padrão informado pelo fornecedor');
  if not (v->>'saved')::boolean then raise exception 'FALHOU: prazo padrão'; end if;
  perform public.stock_lead_time_set(ca, '9001', '502', '{"leadTimeDays": 45, "minLot": 5}', 'Mesa importada sob encomenda');
  perform public.stock_lead_time_set(ca, '9001', '502', '{"leadTimeDays": 60, "minLot": 5, "status": "teste"}',
    'Fornecedor avisou atraso no porto');
  begin perform public.stock_lead_time_set(ca, '9001', '502', '{"leadTimeDays": 400}', 'Prazo acima do limite');
    raise exception 'FALHOU: prazo acima de 365 aceito';
  exception when others then if sqlerrm not like '%1 a 365 dias corridos%' then raise; end if; end;
  begin perform public.stock_lead_time_set(ca, '9001', '502', '{"leadTimeDays": "dez"}', 'Texto no lugar do número');
    raise exception 'FALHOU: prazo não numérico aceito';
  exception when others then if sqlerrm not like '%Prazo inválido%' then raise; end if; end;
  begin perform public.stock_lead_time_set(ca, '9001', '502', '{"leadTimeDays": 12.5}', 'Prazo com fração de dia');
    raise exception 'FALHOU: prazo fracionado aceito';
  exception when others then if sqlerrm not like '%Prazo inválido%' then raise; end if; end;
  begin perform public.stock_lead_time_set(ca, '9001', '502', '{"leadTimeDays": 10}', 'curto');
    raise exception 'FALHOU: observação curta aceita';
  exception when others then if sqlerrm not like '%observação%' then raise; end if; end;
  begin perform public.stock_lead_time_set(ca, '9001', '503', '{"leadTimeDays": 10}', 'Produto sem vínculo com este');
    raise exception 'FALHOU: prazo para produto não vinculado aceito';
  exception when others then if sqlerrm not like '%não está vinculado%' then raise; end if; end;
  begin perform public.stock_lead_time_set(ca, '9999', '', '{"leadTimeDays": 10}', 'Fornecedor inexistente aqui');
    raise exception 'FALHOU: fornecedor inexistente aceito';
  exception when others then if sqlerrm not like '%não encontrado%' then raise; end if; end;
  begin perform public.stock_lead_time_set('all', '9001', '', '{"leadTimeDays": 10}', 'Todas as empresas de uma vez');
    raise exception 'FALHOU: prazo sem empresa aceito';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' and sqlerrm not like '%fora do seu acesso%' then raise; end if; end;
  begin perform public.stock_lead_time_set(current_setting('sup.cb'), '9001', '', '{"leadTimeDays": 10}', 'Empresa fora do acesso');
    raise exception 'FALHOU: prazo em empresa fora do acesso';
  exception when insufficient_privilege then null; end;
  v := public.stock_preferred_supplier_set(ca, '501', '9002', 'Beta entrega mais rápido na região');
  if not (v->>'saved')::boolean then raise exception 'FALHOU: fornecedor principal'; end if;
  begin perform public.stock_preferred_supplier_set(ca, '502', '9002', 'Beta não vende a mesa');
    raise exception 'FALHOU: principal não vinculado aceito';
  exception when others then if sqlerrm not like '%um dos fornecedores vinculados%' then raise; end if; end;
  v := public.stock_supplier_link_set(ca, '502', '9003', true, 'Gama também fornece a mesa');
  if not (v->>'changed')::boolean then raise exception 'FALHOU: vínculo manual'; end if;
  perform public.stock_lead_time_set(ca, '9003', '502', '{"leadTimeDays": 30}', 'Gama confirmou por e-mail');
  begin perform public.stock_supplier_link_set(ca, '502', '9999', true, 'Fornecedor fora do cadastro');
    raise exception 'FALHOU: vínculo com fornecedor fora do cadastro';
  exception when others then if sqlerrm not like '%cadastro desta empresa%' then raise; end if; end;
  begin perform public.stock_supplier_link_set(ca, '501', '9001', false, 'Tentar tirar vínculo do Omie');
    raise exception 'FALHOU: vínculo do Omie removido pelo BIOMIE';
  exception when others then if sqlerrm not like '%vem do Omie%' then raise; end if; end;
  v := public.stock_supplier_search(ca, 'gam');
  if v->0->>'supplierId' <> '9003' or not (v->0->>'isSupplier')::boolean then raise exception 'FALHOU: busca no cadastro: %', v; end if;
  begin perform public.stock_supplier_search(ca, 'ab'); raise exception 'FALHOU: busca curta';
  exception when others then if sqlerrm not like '%3 letras%' then raise; end if; end;
  v := public.stock_product_suppliers(ca, '502');
  if jsonb_array_length(v->'suppliers') <> 2 or v->'preferred' <> 'null'::jsonb
     or not exists (select 1 from jsonb_array_elements(v->'suppliers') s where s->>'supplierId' = '9001'
                    and (s->>'leadTimeDays')::integer = 60 and s->>'leadTimeSource' = 'produto'
                    and s->>'leadTimeStatus' = 'confirmado' and (s->>'minLot')::numeric = 5)
     or not exists (select 1 from jsonb_array_elements(v->'suppliers') s where s->>'supplierId' = '9003'
                    and (s->>'manual')::boolean and not (s->>'inOmie')::boolean and (s->>'leadTimeDays')::integer = 30) then
    raise exception 'FALHOU: fornecedores da mesa: %', v;
  end if;
  v := public.stock_product_suppliers(ca, '501');
  if v->'suppliers'->0->>'supplierId' <> '9002' or not (v->'suppliers'->0->>'isPreferred')::boolean
     or v->'suppliers'->0->'leadTimeDays' <> 'null'::jsonb or v->'preferred'->>'updatedBy' <> 'Compras Teste'
     or not exists (select 1 from jsonb_array_elements(v->'suppliers') s where s->>'supplierId' = '9001'
                    and (s->>'leadTimeDays')::integer = 20 and s->>'leadTimeSource' = 'fornecedor') then
    raise exception 'FALHOU: fornecedores da cadeira (principal e prazo padrão): %', v;
  end if;
  v := public.stock_supplier(ca, '9001');
  if (v->'defaultLeadTime'->>'leadTimeDays')::integer <> 20 or jsonb_array_length(v->'products') <> 2
     or v->'products'->0->>'omieProductId' <> '501' or v->'products'->0->>'preferred' <> 'outro'
     or v->'products'->0->>'preferredName' <> 'Fornecedor Beta' or (v->'products'->1->'leadTime'->>'leadTimeDays')::integer <> 60
     or jsonb_array_length(v->'history') <> 3 or v->'history'->0->>'by' <> 'Compras Teste'
     or (v->'history'->0->'before'->>'leadTimeDays')::integer <> 45 or (v->'history'->0->'after'->>'leadTimeDays')::integer <> 60 then
    raise exception 'FALHOU: detalhe do fornecedor e histórico: %', v;
  end if;
  begin perform public.stock_supplier(ca, 'abc'); raise exception 'FALHOU: código inválido aceito';
  exception when others then if sqlerrm not like '%inválido%' then raise; end if; end;
  begin perform public.stock_supplier_request_import(ca); raise exception 'FALHOU: importação pedida com ela desligada';
  exception when others then if sqlerrm not like '%ainda não foi liberada%' then raise; end if; end;
end $$;
reset role;

-- 3. Admin sem a permissão de Compras: lê, não altera, não vê o histórico. Comercial (vendedor): não entra
--    na área de fornecedores nem filtra por fornecedor.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.ad'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('sup.ca');
begin
  begin perform public.stock_lead_time_set(ca, '9001', '', '{"leadTimeDays": 5}', 'Admin tentando mudar o prazo');
    raise exception 'FALHOU: Admin sem a permissão alterou prazo';
  exception when insufficient_privilege then if sqlerrm not like '%Só Compras%' then raise; end if; end;
  v := public.stock_supplier(ca, '9001');
  if (v->>'canEdit')::boolean or v->'history' <> 'null'::jsonb or v->'defaultLeadTime'->'updatedBy' <> 'null'::jsonb then
    raise exception 'FALHOU: Admin vê histórico ou edita: %', v;
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.ve'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('sup.ca'); refused boolean := false;
begin
  v := public.stock_capabilities();
  if (v->>'suppliers')::boolean or (v->>'purchasing')::boolean or not (v->>'view')::boolean then
    raise exception 'FALHOU: capacidades do vendedor: %', v;
  end if;
  begin perform public.stock_suppliers(jsonb_build_object('companyId', 'all'));
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor abriu a lista de fornecedores'; end if;
  refused := false;
  begin perform public.stock_supplier(ca, '9001'); exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor abriu o fornecedor'; end if;
  refused := false;
  begin perform public.stock_product_suppliers(ca, '501'); exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor viu os fornecedores do produto'; end if;
  refused := false;
  begin perform public.stock_supplier_search(ca, 'gama'); exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor buscou no cadastro inteiro'; end if;
  refused := false;
  begin perform public.stock_preferred_supplier_set(ca, '501', null, 'Vendedor tirando o principal');
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor mudou o fornecedor principal'; end if;
  refused := false;
  begin perform public.stock_positions(jsonb_build_object('companyId', ca, 'supplier', '9001', 'page', 0));
  exception when insufficient_privilege then refused := true; end;
  if not refused then raise exception 'FALHOU: vendedor filtrou posições por fornecedor'; end if;
  v := public.stock_filter_options(ca);
  if v->'suppliers' <> '[]'::jsonb or (v->>'suppliersAllowed')::boolean then
    raise exception 'FALHOU: vendedor recebeu a lista de fornecedores no filtro: %', v;
  end if;
  -- O resto do Estoque continua igual para o vendedor.
  if (public.stock_overview(ca)->'totals'->>'positions')::integer <> 4 then
    raise exception 'FALHOU: painel do vendedor';
  end if;
end $$;
reset role;

-- 4. Filtros por fornecedor (Super admin): painel, posições, opções; só com uma empresa.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('sup.ca');
begin
  v := public.stock_overview(ca, null, '9001');
  if (v->'totals'->>'positions')::integer <> 2 or v->'supplier'->>'name' <> 'Fornecedor Alfa'
     or (v->'totals'->>'costValue')::numeric <> 4400 then
    raise exception 'FALHOU: painel por fornecedor: %', v->'totals';
  end if;
  if (public.stock_overview(ca)->'totals'->>'positions')::integer <> 4 or public.stock_overview(ca)->'supplier' <> 'null'::jsonb then
    raise exception 'FALHOU: painel sem filtro mudou';
  end if;
  begin perform public.stock_overview('all', null, '9001'); raise exception 'FALHOU: filtro por fornecedor com várias empresas';
  exception when others then if sqlerrm not like '%Escolha uma empresa para filtrar%' then raise; end if; end;
  v := public.stock_positions(jsonb_build_object('companyId', ca, 'supplier', '9002', 'page', 0));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '501' or v->>'supplier' <> '9002' then
    raise exception 'FALHOU: posições por fornecedor: %', v;
  end if;
  v := public.stock_positions(jsonb_build_object('companyId', ca, 'noSupplier', true, 'page', 0));
  if (v->>'total')::integer <> 1 or v->'rows'->0->>'omieProductId' <> '504' then
    raise exception 'FALHOU: posições sem fornecedor: %', v;
  end if;
  begin perform public.stock_positions(jsonb_build_object('companyId', 'all', 'supplier', '9001', 'page', 0));
    raise exception 'FALHOU: posições por fornecedor com várias empresas';
  exception when others then if sqlerrm not like '%Escolha uma empresa%' then raise; end if; end;
  v := public.stock_filter_options(ca);
  if jsonb_array_length(v->'suppliers') <> 4 or (v->>'suppliersNeedCompany')::boolean
     or not exists (select 1 from jsonb_array_elements(v->'suppliers') s where s->>'id' = '9001' and (s->>'products')::integer = 2) then
    raise exception 'FALHOU: opções de fornecedor: %', v->'suppliers';
  end if;
  v := public.stock_filter_options('all');
  if v->'suppliers' <> '[]'::jsonb or not (v->>'suppliersNeedCompany')::boolean then
    raise exception 'FALHOU: opções com todas as empresas: %', v;
  end if;
end $$;
reset role;

-- 5. Nova importação: vínculo que sumiu do Omie sai (o manual fica, o prazo vira "sem vínculo");
-- importação vazia não apaga nada; agenda diária só com a importação ligada.
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
do $$
declare v jsonb; job uuid; ca uuid := current_setting('sup.ca')::uuid; n integer;
begin
  perform public.stock_worker_suppliers_enqueue(ca, 'ops');
  v := public.stock_worker_suppliers_claim();
  job := (v->>'id')::uuid;
  perform public.stock_worker_suppliers_save_page(job, 1, 1, 2,
    '[{"supplier_id": "9001", "name": "ALFA", "products": [{"omie": "501"}]}, {"supplier_id": "9002", "name": "BETA", "products": [{"omie": "501"}]}]', 0);
  v := public.stock_worker_suppliers_finish(job);
  if (v->>'linksRemoved')::integer <> 2 then raise exception 'FALHOU: vínculos que sumiram: %', v; end if;
  perform public.stock_worker_suppliers_enqueue(ca, 'ops');
  v := public.stock_worker_suppliers_claim();
  job := (v->>'id')::uuid;
  perform public.stock_worker_suppliers_save_page(job, 1, 1, 0, '[]', 0);
  v := public.stock_worker_suppliers_finish(job);
  if not (v->>'keptPrevious')::boolean or (v->>'linksRemoved')::integer <> 0 then
    raise exception 'FALHOU: importação vazia apagou vínculos: %', v;
  end if;
end $$;
reset role;
-- Agenda: desligada não cria; ligada cria uma por empresa por dia.
update private.stock_settings set reading_enabled = true;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
select public.stock_worker_enqueue('2030-01-01 07:40', 'intraday', current_setting('sup.t')::date) is not null as agenda_1;
reset role;
do $$
begin
  if exists (select 1 from private.stock_supplier_jobs where trigger = 'schedule') then
    raise exception 'FALHOU: agenda com a importação desligada';
  end if;
end $$;
update private.stock_settings set suppliers_enabled = true;
select set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
set local role service_role;
select public.stock_worker_enqueue('2030-01-01 12:40', 'intraday', current_setting('sup.t')::date) is not null as agenda_2;
select public.stock_worker_enqueue('2030-01-01 17:40', 'intraday', current_setting('sup.t')::date) is not null as agenda_3;
reset role;
do $$
declare ca uuid := current_setting('sup.ca')::uuid; n integer;
begin
  select count(*) into n from private.stock_supplier_jobs where trigger = 'schedule';
  if n <> 2 then raise exception 'FALHOU: agenda diária (esperado 1 por empresa): %', n; end if;
  if (select count(*) from private.stock_product_suppliers where company_id = ca) <> 3
     or not exists (select 1 from private.stock_product_suppliers where company_id = ca and omie_product_id = '502'
                    and supplier_id = '9003' and manual and not in_omie)
     or (select in_omie from private.stock_suppliers where company_id = ca and supplier_id = '9004')
     or not exists (select 1 from private.stock_lead_times where company_id = ca and supplier_id = '9001' and omie_product_id = '502')
     or not exists (select 1 from private.stock_preferred_suppliers where company_id = ca and omie_product_id = '501') then
    raise exception 'FALHOU: importação manteve manual, prazo e principal';
  end if;
  -- As importações agendadas acima não rodam neste teste (a tela pede a sua a seguir).
  update private.stock_supplier_jobs set status = 'failed', finished_at = now() where trigger = 'schedule';
end $$;

-- 6. Compras: prazo sem vínculo aparece à parte; remover vínculo manual leva junto o prazo dele;
-- importação pedida pela tela (liberada) com limite; prazo de teste só com o ajuste da homologação.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.co'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('sup.ca');
begin
  v := public.stock_supplier(ca, '9001');
  if jsonb_array_length(v->'products') <> 1 or jsonb_array_length(v->'orphanLeadTimes') <> 1
     or v->'orphanLeadTimes'->0->>'omieProductId' <> '502' then
    raise exception 'FALHOU: prazo sem vínculo ativo: %', v;
  end if;
  v := public.stock_supplier_link_set(ca, '502', '9003', false, 'Gama deixou de fornecer');
  if not (v->>'changed')::boolean then raise exception 'FALHOU: remoção do vínculo manual'; end if;
  v := public.stock_supplier_request_import(ca);
  if not (v->>'queued')::boolean then raise exception 'FALHOU: importação pela tela: %', v; end if;
  v := public.stock_supplier_request_import(ca);
  if (v->>'queued')::boolean or not (v->>'inProgress')::boolean then raise exception 'FALHOU: segunda importação: %', v; end if;
  v := public.stock_suppliers(jsonb_build_object('companyId', ca));
  if (v->'summary'->>'testLeadTimes')::integer <> 0 or (v->'summary'->>'testLeadTimesOn')::boolean then
    raise exception 'FALHOU: prazo de teste na base: %', v->'summary';
  end if;
end $$;
reset role;
do $$
declare ca uuid := current_setting('sup.ca')::uuid;
begin
  if exists (select 1 from private.stock_lead_times where company_id = ca and supplier_id = '9003')
     or exists (select 1 from private.stock_product_suppliers where company_id = ca and supplier_id = '9003') then
    raise exception 'FALHOU: remoção do vínculo manual deixou o prazo';
  end if;
  -- Roteiro da homologação: prazo de teste gravado direto no banco; só vale com o ajuste ligado.
  insert into private.stock_lead_times (company_id, supplier_id, omie_product_id, lead_time_days, status, note)
  values (ca, '9002', '', 30, 'teste', 'Teste de homologação: prazo hipotético de 30 dias');
  if stock_internal.test_lead_times_on() then raise exception 'FALHOU: ajuste de teste ligado por padrão'; end if;
  insert into private.app_settings (key, value) values ('stock.test_lead_times', 'on')
    on conflict (key) do update set value = excluded.value;
  if not stock_internal.test_lead_times_on() then raise exception 'FALHOU: ajuste de teste'; end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.co'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v jsonb; ca text := current_setting('sup.ca');
begin
  v := public.stock_product_suppliers(ca, '501');
  if not (v->>'testLeadTimesOn')::boolean or not exists (select 1 from jsonb_array_elements(v->'suppliers') s
       where s->>'supplierId' = '9002' and s->>'leadTimeStatus' = 'teste' and (s->>'leadTimeDays')::integer = 30) then
    raise exception 'FALHOU: prazo de teste rotulado: %', v;
  end if;
  -- Compras confirma o prazo: deixa de ser de teste.
  perform public.stock_lead_time_set(ca, '9002', '', '{"leadTimeDays": 25}', 'Prazo confirmado com o fornecedor');
  v := public.stock_product_suppliers(ca, '501');
  if not exists (select 1 from jsonb_array_elements(v->'suppliers') s where s->>'supplierId' = '9002'
                 and s->>'leadTimeStatus' = 'confirmado' and (s->>'leadTimeDays')::integer = 25) then
    raise exception 'FALHOU: confirmação do prazo de teste: %', v;
  end if;
end $$;
reset role;

-- 7. Auditoria (valor anterior, novo, observação e autor), permissão pelo Admin 2.0 e dados oficiais.
do $$
declare co uuid := current_setting('sup.co')::uuid;
begin
  if (select count(*) from public.audit_log where action = 'stock.lead_time.changed' and actor_id = co) <> 6
     or not exists (select 1 from public.audit_log where action = 'stock.lead_time.changed' and actor_id = co
                    and payload->>'mudanca' = 'update' and (payload->'before'->>'leadTimeDays')::integer = 45
                    and (payload->'after'->>'leadTimeDays')::integer = 60
                    and payload->'before'->>'note' = 'Mesa importada sob encomenda'
                    and payload->'after'->>'note' = 'Fornecedor avisou atraso no porto'
                    and payload->'after'->>'fornecedor' = 'Fornecedor Alfa' and payload->'after'->>'produto' = 'Mesa Y')
     or not exists (select 1 from public.audit_log where action = 'stock.lead_time.changed' and actor_id = co
                    and payload->>'mudanca' = 'remove' and payload->'after'->>'situacao' = 'removido'
                    and payload->'before'->>'leadTimeDays' = '30')
     or (select count(*) from public.audit_log where action = 'stock.preferred_supplier.changed' and actor_id = co) <> 1
     or (select count(*) from public.audit_log where action = 'stock.supplier_link.changed' and actor_id = co) <> 2
     or (select count(*) from public.audit_log where action = 'stock.suppliers.import_requested' and actor_id = co) <> 1
     or (select count(*) from private.stock_supplier_changes where changed_by = co) <> 9 then
    raise exception 'FALHOU: auditoria e histórico das alterações';
  end if;
  if exists (select 1 from public.audit_log where payload::text like '%"leadTimeDays": 400%') then
    raise exception 'FALHOU: alteração recusada foi auditada como feita';
  end if;
end $$;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.su'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  perform public.admin_update_access(current_setting('sup.ad')::uuid, '{"permissions": ["stock.purchasing"]}');
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('sup.ad'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
begin
  if not (public.stock_capabilities()->>'purchasing')::boolean then raise exception 'FALHOU: permissão dada pelo Admin 2.0'; end if;
  perform public.stock_lead_time_set(current_setting('sup.ca'), '9001', '', '{"leadTimeDays": 22}', 'Admin agora com a permissão de Compras');
end $$;
reset role;
do $$
begin
  if (select json_build_object(
        'positions', (select count(*) from private.stock_positions), 'products', (select count(*) from public.products),
        'customers', (select count(*) from public.customers), 'curves', (select count(*) from private.stock_curves))::text)
     <> current_setting('sup.official') then
    raise exception 'FALHOU: dados oficiais alterados';
  end if;
  if has_function_privilege('authenticated', 'public.stock_worker_suppliers_claim()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.stock_worker_suppliers_enqueue(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'stock_internal.supplier_change(uuid, text, text, text, text, jsonb, jsonb, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.stock_lead_time_set(text, text, text, jsonb, text)', 'EXECUTE')
     or has_table_privilege('authenticated', 'private.stock_lead_times', 'SELECT') then
    raise exception 'FALHOU: permissões das funções e tabelas novas';
  end if;
  raise notice 'PASS Estoque fornecedores e prazos: importação só leitura do Omie (fila, páginas, total que muda, idempotência, vínculo que some, importação vazia que não apaga, espera mínima), cadastro do BIOMIE reaproveitado, Compras e Super admin alteram com observação, histórico e Auditoria (antes/depois), Admin sem a permissão e vendedor só leem, prazo de teste só com o ajuste da homologação, filtros por fornecedor numa empresa, dados oficiais intocados';
end $$;
rollback;
