\set ON_ERROR_STOP on
-- Plano de Voo v2 (migração 0050): canal oficial do vendedor, leitura numa chamada só, metas (empresa por
-- canal e vendedor), compromisso, iniciativas, estados de alerta, decisões, histórico e conversão.
-- Usuários e empresa sintéticos; tudo é desfeito no fim. Rodar no banco de TESTE.
begin;
do $$
declare
  sa uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); dir uuid := gen_random_uuid();
  ges uuid := gen_random_uuid(); ven uuid := gen_random_uuid(); outsider uuid := gen_random_uuid(); fin uuid := gen_random_uuid();
  c uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid();
  sl uuid := gen_random_uuid(); p uuid := gen_random_uuid();
  cu1 uuid := gen_random_uuid(); cu2 uuid := gen_random_uuid(); cu3 uuid := gen_random_uuid();
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); i3 uuid := gen_random_uuid(); i4 uuid := gen_random_uuid();
  i5 uuid := gen_random_uuid(); o1 uuid := gen_random_uuid(); q1 uuid := gen_random_uuid();
  v_today date; v_start date; v_pm date;
begin
  insert into auth.users(id, email) values
    (sa, 'fp-sa-' || sa || '@invalid.example'), (adm, 'fp-adm-' || adm || '@invalid.example'),
    (dir, 'fp-dir-' || dir || '@invalid.example'), (ges, 'fp-ges-' || ges || '@invalid.example'),
    (ven, 'fp-ven-' || ven || '@invalid.example'), (outsider, 'fp-out-' || outsider || '@invalid.example'),
    (fin, 'fp-fin-' || fin || '@invalid.example');
  insert into public.profiles(id, full_name) values (sa, 'Super'), (adm, 'Admin FP'), (dir, 'Diretoria FP'),
    (ges, 'Gestor FP'), (ven, 'Vendedora FP'), (outsider, 'Fora'), (fin, 'Financeiro FP');
  insert into public.user_roles(user_id, role) values (sa, 'SUPER_ADMIN'), (adm, 'ADMIN'), (dir, 'DIRETORIA'),
    (ges, 'GESTOR'), (ven, 'VENDEDOR'), (outsider, 'ADMIN'), (fin, 'FINANCEIRO');
  insert into public.companies(id, name, slug, data_source, revenue_basis)
    values (c, 'Plano de Voo fixture', 'fp-' || c, 'OMIE_SHADOW', 'commercial_base');
  insert into public.channels(company_id, name) values (c, 'varejo'), (c, 'licitacao'), (c, 'outros');
  insert into public.user_company_access(user_id, company_id) values (adm, c), (dir, c), (ges, c), (ven, c), (fin, c);
  insert into public.sellers(id, company_id, name, external_id) values
    (s1, c, 'Ana FP', 'V1'), (s2, c, 'Bruno FP', 'V2'), (s3, c, 'Carla FP', 'V3'), (sl, c, 'Licitação', 'L1');
  update public.sellers set user_id = ven where id = s3;
  insert into public.products(id, company_id, name, category, base_price) values (p, c, 'Cadeira FP', 'Teste', 1);
  insert into public.customers(id, company_id, name, state, city) values
    (cu1, c, 'Cliente antigo', 'CE', 'Fortaleza'), (cu2, c, 'Cliente novo', 'CE', 'Fortaleza'),
    (cu3, c, 'Órgão público', 'CE', 'Fortaleza');

  v_today := public.data_as_of(c);
  v_start := date_trunc('month', v_today)::date;
  v_pm := (v_start - interval '1 month')::date;
  -- Equipe 1 (Ana e Bruno) gerida pelo Gestor; Bruno saiu da equipe no fim do mês passado.
  insert into public.sales_teams(id, company_id, name) values (t1, c, 'Equipe FP 1'), (t2, c, 'Equipe FP 2');
  insert into public.sales_team_managers(team_id, user_id, valid_from) values (t1, ges, v_pm - 60);
  insert into public.sales_team_members(team_id, seller_id, valid_from, valid_to) values
    (t1, s1, v_pm - 60, null), (t1, s2, v_pm - 60, v_start - 1), (t2, s3, v_pm - 60, null);

  insert into public.invoices(id, company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
    gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible) values
    (i1, c, s1, cu1, 'N1', v_today, 100, 'omie', 'fp-1', 100, 100, 100, 'commercial', 'varejo', true),
    (i2, c, s2, cu2, 'N2', v_today, 200, 'omie', 'fp-2', 200, 200, 200, 'commercial', 'varejo', true),
    (i3, c, sl, cu3, 'N3', v_today, 300, 'omie', 'fp-3', 300, 300, 300, 'commercial', 'licitacao', false),
    (i4, c, null, cu2, 'N4', v_today, 50, 'omie', 'fp-4', 50, 50, 50, 'commercial', 'varejo', true),
    (i5, c, s1, cu1, 'N5', v_pm, 400, 'omie', 'fp-5', 400, 400, 400, 'commercial', 'varejo', true);
  insert into public.invoice_items(invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence) values
    (i1, c, s1, p, 1, 100, 1), (i2, c, s2, p, 1, 200, 1), (i3, c, sl, p, 1, 300, 1), (i4, c, null, p, 1, 50, 1),
    (i5, c, s1, p, 1, 400, 1);
  -- Pedido aceito com previsão vencida (Ana) e orçamento aberto (Bruno).
  insert into public.sales_orders(id, company_id, seller_id, customer_id, number, status, order_date, expected_date, total,
    source, operation_scope, stage_code, business_channel) values
    (o1, c, s1, cu1, 'P1', 'open', v_today - 20, v_today - 1, 1000, 'omie', 'commercial', '20', 'varejo'),
    (q1, c, s2, cu2, 'Q1', 'open', v_today - 30, null, 500, 'omie', 'commercial', '10', 'varejo');
  insert into public.sales_order_items(order_id, company_id, seller_id, product_id, quantity, total) values
    (o1, c, s1, p, 1, 1000), (q1, c, s2, p, 1, 500);

  perform set_config('fp.c', c::text, true);
  perform set_config('fp.s1', s1::text, true); perform set_config('fp.s2', s2::text, true);
  perform set_config('fp.s3', s3::text, true); perform set_config('fp.sl', sl::text, true);
  perform set_config('fp.sa', sa::text, true); perform set_config('fp.adm', adm::text, true);
  perform set_config('fp.dir', dir::text, true); perform set_config('fp.ges', ges::text, true);
  perform set_config('fp.ven', ven::text, true); perform set_config('fp.out', outsider::text, true);
  perform set_config('fp.fin', fin::text, true); perform set_config('fp.q1', q1::text, true);
  perform set_config('fp.y', extract(year from v_today)::int::text, true);
  perform set_config('fp.m', extract(month from v_today)::int::text, true);
  perform set_config('fp.pmy', extract(year from v_pm)::int::text, true);
  perform set_config('fp.pmm', extract(month from v_pm)::int::text, true);
  perform set_config('fp.ym', to_char(v_today, 'YYYY-MM'), true);
  perform set_config('fp.win', jsonb_build_object(
    'previous', jsonb_build_object('start', v_pm,
      'end', least(v_pm + (extract(day from v_today)::int - 1), v_start - 1)),
    'lastYear', jsonb_build_object('start', (v_start - interval '1 year')::date,
      'end', least((v_start - interval '1 year')::date + (extract(day from v_today)::int - 1),
                   ((v_start - interval '1 year') + interval '1 month - 1 day')::date)),
    'trailing3', jsonb_build_object('start', (v_start - interval '3 months')::date, 'end', v_start - 1, 'divisor', 3)
  )::text, true);
end $$;

-- 1. Canal oficial do vendedor: "Licitação" = licitação, demais = varejo; o gatilho mantém.
do $$
declare c uuid := current_setting('fp.c')::uuid;
begin
  if exists (select 1 from public.sellers s join public.channels ch on ch.id = s.channel_id
             where s.company_id = c and lower(ch.name) <> case when s.name = 'Licitação' then 'licitacao' else 'varejo' end)
     or exists (select 1 from public.sellers where company_id = c and channel_id is null) then
    raise exception 'Canal oficial do vendedor não aplicado';
  end if;
  update public.sellers set name = 'LICITACAO' where id = current_setting('fp.s2')::uuid;
  if (select lower(ch.name) from public.sellers s join public.channels ch on ch.id = s.channel_id
      where s.id = current_setting('fp.s2')::uuid) <> 'licitacao' then raise exception 'Renomear para Licitação não mudou o canal'; end if;
  update public.sellers set name = 'Bruno FP', channel_id = null where id = current_setting('fp.s2')::uuid;
  if (select lower(ch.name) from public.sellers s join public.channels ch on ch.id = s.channel_id
      where s.id = current_setting('fp.s2')::uuid) <> 'varejo' then raise exception 'Canal manual sobrescreveu a regra oficial'; end if;
  if (select count(*) from private.sales_order_stage_events where order_id = current_setting('fp.q1')::uuid and to_stage = '10') <> 1 then
    raise exception 'Orçamento novo não entrou no histórico de etapa';
  end if;
  raise notice 'PASS canal oficial do vendedor e histórico de etapa';
end $$;

-- 2. Admin: leitura completa, filtro de canal, metas, compromisso, iniciativas, alertas, decisões, histórico.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('fp.adm'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  c uuid := current_setting('fp.c')::uuid; y int := current_setting('fp.y')::int; m int := current_setting('fp.m')::int;
  s1 uuid := current_setting('fp.s1')::uuid; s2 uuid := current_setting('fp.s2')::uuid; s3 uuid := current_setting('fp.s3')::uuid;
  d jsonb; t jsonb; r jsonb; v numeric; ok boolean; init uuid; k text := 'BELOW_FLIGHT_LINE:' || current_setting('fp.c') || ':empresa:' || current_setting('fp.ym');
begin
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb);
  select sum((x->>'amount')::numeric) into v from jsonb_array_elements(d->'daily') x;
  if v is distinct from 650::numeric then raise exception 'Faturamento do mês: esperado 650, veio %', v; end if;
  if (d->'totals'->>'invoices')::int <> 4 or (d->'totals'->>'customers')::int <> 3
     or (d->'totals'->>'newCustomers')::int <> 2 or (d->'totals'->>'unassigned')::numeric <> 50
     or (d->'totals'->>'previousMonthSameCut')::numeric <> 400 then
    raise exception 'Totais do mês errados: %', d->'totals';
  end if;
  if jsonb_array_length(d->'sellers') <> 4 or (d->>'restricted')::boolean then raise exception 'Admin deveria ver os 4 vendedores'; end if;
  if jsonb_array_length(d->'orders') <> 1 or jsonb_array_length(d->'quotes') <> 1 then
    raise exception 'Carteira e orçamentos separados: %, %', d->'orders', d->'quotes';
  end if;
  if (d->'conversion'->>'tracked')::int <> 1 or (d->'conversion'->>'converted')::int <> 0 then
    raise exception 'Conversão inicial errada: %', d->'conversion';
  end if;
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb, 'varejo');
  select sum((x->>'amount')::numeric) into v from jsonb_array_elements(d->'daily') x;
  if v is distinct from 350::numeric or jsonb_array_length(d->'sellers') <> 3 then
    raise exception 'Filtro Varejo: esperado 350 e 3 vendedores, veio % e %', v, jsonb_array_length(d->'sellers');
  end if;
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb, 'licitacao');
  select sum((x->>'amount')::numeric) into v from jsonb_array_elements(d->'daily') x;
  if v is distinct from 300::numeric or jsonb_array_length(d->'sellers') <> 1 then
    raise exception 'Filtro Licitação: esperado 300 e 1 vendedor, veio % e %', v, jsonb_array_length(d->'sellers');
  end if;
  begin
    perform public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb, 'outros'); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Canal fora de varejo/licitação aceito'; end if;
  -- Filtros globais: canal pelo id, UF, categoria (o realizado muda; a meta não é por categoria).
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb, p_channel_id =>
    (select id from public.channels where company_id = c and name = 'licitacao'));
  select sum((x->>'amount')::numeric) into v from jsonb_array_elements(d->'daily') x;
  if v is distinct from 300::numeric then raise exception 'Canal pelo id: esperado 300, veio %', v; end if;
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb, p_state => 'SP');
  if jsonb_array_length(d->'daily') <> 0 or jsonb_array_length(d->'orders') <> 0 or jsonb_array_length(d->'quotes') <> 0 then
    raise exception 'Filtro de UF não aplicado: %', d->'daily';
  end if;
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb, p_category => 'Teste');
  select sum((x->>'amount')::numeric) into v from jsonb_array_elements(d->'daily') x;
  if v is distinct from 650::numeric or jsonb_array_length(d->'quotes') <> 1 then
    raise exception 'Filtro de categoria Teste: esperado 650 e 1 orçamento, veio % e %', v, jsonb_array_length(d->'quotes');
  end if;
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb, p_category => 'Outra');
  if jsonb_array_length(d->'daily') <> 0 or jsonb_array_length(d->'quotes') <> 0 then
    raise exception 'Filtro de categoria Outra deveria zerar';
  end if;
  if (public.flight_plan_v2_target_lists(c, p_state => 'SP')->'quotes'->>'count')::int <> 0
     or (public.flight_plan_v2_target_lists(c)->'quotes'->>'count')::int <> 1
     or (public.flight_plan_v2_target_lists(c)->'lateOrders'->>'count')::int <> 1 then
    raise exception 'Listas de alvos erradas';
  end if;
  if jsonb_array_length(public.flight_plan_v2_year(c, y)->'months') < 1 then raise exception 'Ano sem meses'; end if;
  begin
    perform public.flight_plan_v2_dataset(c, y, m, '{}'::jsonb); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Leitura sem janelas de comparação aceita'; end if;

  -- Metas: empresa (Varejo) + vendedor; repetir não muda; alterar; apagar.
  r := public.flight_plan_save_targets(c, y, m, jsonb_build_array(
    jsonb_build_object('scope', 'company', 'channel', 'varejo', 'level', 'ACTIVE', 'amount', 1000),
    jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'ACTIVE', 'amount', 300),
    jsonb_build_object('scope', 'seller', 'sellerId', s3, 'level', 'ACTIVE', 'amount', 250)));
  if (r->>'created')::int <> 3 then raise exception 'Metas não criadas: %', r; end if;
  r := public.flight_plan_save_targets(c, y, m, jsonb_build_array(
    jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'ACTIVE', 'amount', 300)));
  if (r->>'unchanged')::int <> 1 then raise exception 'Mesmo valor deveria ficar inalterado: %', r; end if;
  r := public.flight_plan_save_targets(c, y, m, jsonb_build_array(
    jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'ACTIVE', 'amount', 350.5)));
  if (r->>'updated')::int <> 1 then raise exception 'Meta não alterada: %', r; end if;
  t := public.flight_plan_targets_month(c, y, m);
  if (t->'company'->'varejo'->>'ACTIVE')::numeric <> 1000 or (t->'allSellers'->>'ACTIVE')::numeric <> 600.5
     or not (t->>'canEditCompany')::boolean then
    raise exception 'Grade do mês errada: company=% allSellers=%', t->'company', t->'allSellers';
  end if;
  begin
    perform public.flight_plan_save_targets(c, y, m, jsonb_build_array(
      jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'BASE', 'amount', 1),
      jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'BASE', 'amount', 2))); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Célula repetida no lote foi aceita'; end if;
  begin
    perform public.flight_plan_save_targets(c, y, m, jsonb_build_array(
      jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'BASE', 'amount', 1.005))); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Valor com 3 casas foi aceito'; end if;
  if exists (select 1 from public.sales_targets where company_id = c and level = 'BASE') then
    raise exception 'Lote recusado gravou algo';
  end if;

  -- Compromisso: Admin registra (decisão de 04/11) e apaga.
  perform public.flight_plan_set_commit(c, s1, y, m, 1200, 'Fecha até o dia 25');
  perform public.flight_plan_set_commit(c, s2, y, m, 80, null);
  perform public.flight_plan_set_commit(c, s2, y, m, null, null);
  if (select count(*) from public.flight_plan_commits where company_id = c) <> 1 then raise exception 'Compromisso não gravado/apagado'; end if;

  -- Iniciativa com responsável vendedor SEM login (Ana).
  init := public.flight_plan_save_initiative(jsonb_build_object('companyId', c, 'month', current_setting('fp.ym'),
    'title', 'Converter orçamentos', 'lever', 'CONVERT_QUOTES', 'ownerUserId', 'seller:' || s1,
    'sellerIds', jsonb_build_array(s1), 'dueDate', to_char(date_trunc('month', current_date) + interval '20 days', 'YYYY-MM-DD'),
    'expectedAmount', 5000, 'status', 'PLANNED'));
  if (select owner_name from public.flight_plan_initiatives where id = init) <> 'Ana FP' then raise exception 'Responsável vendedor não gravado'; end if;
  begin
    perform public.flight_plan_set_initiative_status(init, 'DONE', null, null); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Concluir sem resultado foi aceito'; end if;
  begin
    perform public.flight_plan_set_initiative_status(init, 'CANCELLED', null, '  '); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Cancelar sem motivo foi aceito'; end if;
  perform public.flight_plan_set_initiative_status(init, 'IN_PROGRESS', null, null);
  begin
    perform public.flight_plan_save_initiative(jsonb_build_object('companyId', c, 'month', current_setting('fp.ym'),
      'title', 'Prazo fora', 'lever', 'OTHER', 'ownerUserId', 'user:' || current_setting('fp.adm'),
      'dueDate', to_char(date_trunc('month', current_date) + interval '75 days', 'YYYY-MM-DD'), 'expectedAmount', 10)); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Prazo além de 30 dias depois do mês foi aceito'; end if;
  perform set_config('fp.init', init::text, true);

  -- Alertas: ciente exige justificativa; ciente cai quando piora; resolvido volta quando some e reaparece.
  r := public.flight_plan_sync_alerts(c, y, m, array['empresa'], jsonb_build_array(jsonb_build_object(
    'key', k, 'subject', 'empresa', 'priority', 2, 'message', 'Empresa abaixo da linha de voo.', 'evidence', 'e1')));
  if r->0->>'state' <> 'OPEN' then raise exception 'Alerta novo deveria abrir: %', r; end if;
  begin
    perform public.flight_plan_set_alert_state(jsonb_build_object('companyId', c, 'key', k, 'subject', 'empresa',
      'month', current_setting('fp.ym'), 'state', 'ACKNOWLEDGED', 'priority', 2)); ok := true;
  exception when invalid_parameter_value then ok := false; end;
  if ok then raise exception 'Ciente sem justificativa foi aceito'; end if;
  perform public.flight_plan_set_alert_state(jsonb_build_object('companyId', c, 'key', k, 'subject', 'empresa',
    'month', current_setting('fp.ym'), 'state', 'ACKNOWLEDGED', 'note', 'Gestor cobrando', 'priority', 2));
  r := public.flight_plan_sync_alerts(c, y, m, array['empresa'], jsonb_build_array(jsonb_build_object(
    'key', k, 'subject', 'empresa', 'priority', 2, 'message', 'm', 'evidence', 'e2')));
  if r->0->>'state' <> 'ACKNOWLEDGED' then raise exception 'Ciente deveria continuar com a mesma prioridade: %', r; end if;
  r := public.flight_plan_sync_alerts(c, y, m, array['empresa'], jsonb_build_array(jsonb_build_object(
    'key', k, 'subject', 'empresa', 'priority', 1, 'message', 'm', 'evidence', 'e3')));
  if r->0->>'state' <> 'OPEN' or not (r->0->>'reopened')::boolean then raise exception 'Ciente deveria cair quando piora: %', r; end if;
  perform public.flight_plan_set_alert_state(jsonb_build_object('companyId', c, 'key', k, 'subject', 'empresa',
    'month', current_setting('fp.ym'), 'state', 'RESOLVED', 'priority', 1));
  r := public.flight_plan_sync_alerts(c, y, m, array['empresa'], jsonb_build_array(jsonb_build_object(
    'key', k, 'subject', 'empresa', 'priority', 1, 'message', 'm', 'evidence', 'e4')));
  if r->0->>'state' <> 'RESOLVED' then raise exception 'Resolvido com evidência nova não pode reabrir sozinho: %', r; end if;
  perform public.flight_plan_sync_alerts(c, y, m, array['escopo-outro'], '[]'::jsonb);
  if (select absent_since from public.flight_plan_alert_states where company_id = c and alert_key = k) is not null then
    raise exception 'Leitura de outro escopo marcou o alerta da empresa como ausente';
  end if;
  perform public.flight_plan_sync_alerts(c, y, m, array['empresa'], '[]'::jsonb);
  r := public.flight_plan_sync_alerts(c, y, m, array['empresa'], jsonb_build_array(jsonb_build_object(
    'key', k, 'subject', 'empresa', 'priority', 1, 'message', 'm', 'evidence', 'e4')));
  if r->0->>'state' <> 'OPEN' or not (r->0->>'reopened')::boolean then raise exception 'Resolvido deveria reabrir quando volta: %', r; end if;

  perform public.flight_plan_add_decision(c, current_date, 'Priorizar pedidos vencidos');
  r := public.flight_plan_history(c, null, 100);
  if jsonb_array_length(r) < 10 then raise exception 'Histórico incompleto: % linhas', jsonb_array_length(r); end if;
  if jsonb_array_length(public.flight_plan_history(c, 'destino', 100)) <> 4 then
    raise exception 'Histórico do Destino deveria ter 4 linhas (3 criadas e 1 alterada)';
  end if;
  begin
    insert into public.flight_plan_initiatives(company_id, year, month, title, lever, owner_name, due_date, expected_amount)
      values (c, y, m, 'direto', 'OTHER', 'x', current_date, 1); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Escrita direta em iniciativas foi aceita'; end if;
  begin
    update public.sales_targets set amount = 1 where company_id = c; ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Escrita direta em metas foi aceita'; end if;
  raise notice 'PASS Admin: leitura, canais, metas, compromisso, iniciativa, alertas, decisão, histórico e escrita direta negada';
end $$;
reset role;

-- 3. Diretoria: meta da empresa e compromisso.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('fp.dir'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare c uuid := current_setting('fp.c')::uuid; y int := current_setting('fp.y')::int; m int := current_setting('fp.m')::int; r jsonb;
begin
  r := public.flight_plan_save_targets(c, y, m, jsonb_build_array(
    jsonb_build_object('scope', 'company', 'channel', 'licitacao', 'level', 'ACTIVE', 'amount', 500)));
  if (r->>'created')::int <> 1 then raise exception 'Diretoria não gravou a meta da empresa: %', r; end if;
  perform public.flight_plan_set_commit(c, current_setting('fp.s3')::uuid, y, m, 90, null);
  raise notice 'PASS Diretoria: meta da empresa e compromisso';
end $$;
reset role;

-- 4. Gestor: só a própria equipe; equipe válida no mês da meta; lote misto não grava nada.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('fp.ges'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  c uuid := current_setting('fp.c')::uuid; y int := current_setting('fp.y')::int; m int := current_setting('fp.m')::int;
  s1 uuid := current_setting('fp.s1')::uuid; s2 uuid := current_setting('fp.s2')::uuid; s3 uuid := current_setting('fp.s3')::uuid;
  d jsonb; t jsonb; v numeric; ok boolean; me jsonb;
begin
  me := public.flight_plan_v2_me();
  if me->'managedSellerIds' <> jsonb_build_array(s1) then raise exception 'Equipe do Gestor errada: %', me->'managedSellerIds'; end if;
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb);
  select sum((x->>'amount')::numeric) into v from jsonb_array_elements(d->'daily') x;
  if not (d->>'restricted')::boolean or jsonb_array_length(d->'sellers') <> 1 or v is distinct from 100::numeric then
    raise exception 'Gestor deveria ver só Ana (100): vendedores %, faturado %', jsonb_array_length(d->'sellers'), v;
  end if;
  t := public.flight_plan_targets_month(c, y, m);
  if jsonb_array_length(t->'sellers') <> 1 or not (t->'sellers'->0->>'editable')::boolean or (t->>'canEditCompany')::boolean then
    raise exception 'Grade do Gestor no mês errada: %', t->'sellers';
  end if;
  if (t->'allSellers'->>'ACTIVE')::numeric <> 600.5 then raise exception 'Não distribuído do Gestor precisa da empresa toda'; end if;
  t := public.flight_plan_targets_month(c, current_setting('fp.pmy')::int, current_setting('fp.pmm')::int);
  if jsonb_array_length(t->'sellers') <> 2
     or (select (x->>'editable')::boolean from jsonb_array_elements(t->'sellers') x where x->>'id' = s2::text) then
    raise exception 'No mês passado Bruno estava na equipe (listado, sem edição hoje): %', t->'sellers';
  end if;
  begin
    perform public.flight_plan_save_targets(c, y, m, jsonb_build_array(
      jsonb_build_object('scope', 'company', 'channel', 'varejo', 'level', 'ACTIVE', 'amount', 1))); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Gestor alterou a meta da empresa'; end if;
  begin
    perform public.flight_plan_save_targets(c, y, m, jsonb_build_array(
      jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'CHALLENGE', 'amount', 999),
      jsonb_build_object('scope', 'seller', 'sellerId', s3, 'level', 'CHALLENGE', 'amount', 999))); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Gestor alterou vendedor de fora'; end if;
  if exists (select 1 from public.sales_targets where company_id = c and level = 'CHALLENGE') then
    raise exception 'Lote misto gravou parte';
  end if;
  perform public.flight_plan_save_targets(c, y, m, jsonb_build_array(
    jsonb_build_object('scope', 'seller', 'sellerId', s1, 'level', 'CHALLENGE', 'amount', 400)));
  perform public.flight_plan_set_commit(c, s1, y, m, 1300, null);
  begin
    perform public.flight_plan_set_commit(c, s3, y, m, 1, null); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Gestor registrou compromisso de vendedor de fora'; end if;
  begin
    perform public.flight_plan_save_initiative(jsonb_build_object('companyId', c, 'month', current_setting('fp.ym'),
      'title', 'Fora da equipe', 'lever', 'OTHER', 'ownerUserId', 'user:' || current_setting('fp.ges'),
      'sellerIds', jsonb_build_array(s3), 'dueDate', to_char(current_date, 'YYYY-MM-DD'), 'expectedAmount', 10)); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Gestor criou iniciativa de vendedor de fora'; end if;
  perform public.flight_plan_save_initiative(jsonb_build_object('companyId', c, 'month', current_setting('fp.ym'),
    'title', 'Reativar clientes da Ana', 'lever', 'REACTIVATE_CUSTOMERS', 'ownerUserId', 'user:' || current_setting('fp.ges'),
    'sellerIds', jsonb_build_array(s1), 'dueDate', to_char(current_date, 'YYYY-MM-DD'), 'expectedAmount', 10));
  if (select count(*) from public.flight_plan_initiatives where company_id = c) <> 2 then
    raise exception 'Gestor deveria ver as 2 iniciativas da Ana';
  end if;
  begin
    perform public.flight_plan_set_alert_state(jsonb_build_object('companyId', c, 'key', 'SELLER_IDLE:x:' || s3, 'subject', s3::text,
      'sellerId', s3, 'month', current_setting('fp.ym'), 'state', 'RESOLVED')); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Gestor mudou alerta de vendedor de fora'; end if;
  if exists (select 1 from jsonb_array_elements(public.flight_plan_history(c, null, 200)) x
             where x->>'label' = 'Carla FP' and x->>'author' <> 'Gestor FP') then
    raise exception 'Histórico mostrou ao Gestor alteração de vendedor de fora';
  end if;
  raise notice 'PASS Gestor: equipe, equipe na competência, lote atômico, compromisso, iniciativa, alerta e histórico no escopo';
end $$;
reset role;

-- 5. Vendedor: só ele; compromisso próprio; ação própria; não edita metas nem decide.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('fp.ven'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  c uuid := current_setting('fp.c')::uuid; y int := current_setting('fp.y')::int; m int := current_setting('fp.m')::int;
  s1 uuid := current_setting('fp.s1')::uuid; s3 uuid := current_setting('fp.s3')::uuid; d jsonb; ok boolean; init uuid;
begin
  d := public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb);
  if jsonb_array_length(d->'sellers') <> 1 or d->'sellers'->0->>'id' <> s3::text then raise exception 'Vendedor deveria ver só a si'; end if;
  if (public.flight_plan_v2_me()->'sellerIds') <> jsonb_build_array(s3) then raise exception 'Vendedor sem o próprio vendedor no contexto'; end if;
  begin
    perform public.flight_plan_save_targets(c, y, m, jsonb_build_array(
      jsonb_build_object('scope', 'seller', 'sellerId', s3, 'level', 'ACTIVE', 'amount', 1))); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Vendedor alterou meta'; end if;
  perform public.flight_plan_set_commit(c, s3, y, m, 95, 'meu compromisso');
  init := public.flight_plan_save_initiative(jsonb_build_object('companyId', c, 'month', current_setting('fp.ym'),
    'title', 'Ligar para 10 clientes', 'lever', 'PROSPECTING', 'ownerUserId', 'user:' || current_setting('fp.ven'),
    'sellerIds', jsonb_build_array(s3), 'dueDate', to_char(current_date, 'YYYY-MM-DD'), 'expectedAmount', 10));
  begin
    perform public.flight_plan_save_initiative(jsonb_build_object('companyId', c, 'month', current_setting('fp.ym'),
      'title', 'Da colega', 'lever', 'OTHER', 'ownerUserId', 'user:' || current_setting('fp.ven'),
      'sellerIds', jsonb_build_array(s1), 'dueDate', to_char(current_date, 'YYYY-MM-DD'), 'expectedAmount', 10)); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Vendedor criou iniciativa de outro vendedor'; end if;
  if exists (select 1 from public.flight_plan_initiatives where id = current_setting('fp.init')::uuid) then
    raise exception 'Vendedor viu iniciativa da colega';
  end if;
  perform public.flight_plan_set_alert_state(jsonb_build_object('companyId', c, 'key', 'SELLER_IDLE:x:' || s3, 'subject', s3::text,
    'sellerId', s3, 'month', current_setting('fp.ym'), 'state', 'ACTION_CREATED', 'initiativeId', init));
  begin
    perform public.flight_plan_set_alert_state(jsonb_build_object('companyId', c, 'key', 'SELLER_IDLE:x:' || s3, 'subject', s3::text,
      'sellerId', s3, 'month', current_setting('fp.ym'), 'state', 'RESOLVED')); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Vendedor resolveu alerta'; end if;
  begin
    perform public.flight_plan_add_decision(c, current_date, 'x'); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Vendedor registrou decisão'; end if;
  raise notice 'PASS Vendedor: só a si, compromisso e ação próprios, sem metas nem decisões';
end $$;
reset role;

-- 6. Financeiro (leitura ampla, sem escrita) e Admin de fora da empresa.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('fp.fin'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare c uuid := current_setting('fp.c')::uuid; y int := current_setting('fp.y')::int; m int := current_setting('fp.m')::int; ok boolean;
begin
  if jsonb_array_length(public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb)->'sellers') <> 4 then raise exception 'Financeiro deveria ler tudo'; end if;
  begin
    perform public.flight_plan_set_commit(c, current_setting('fp.s1')::uuid, y, m, 1, null); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Financeiro registrou compromisso'; end if;
  begin
    perform public.flight_plan_save_targets(c, y, m, jsonb_build_array(
      jsonb_build_object('scope', 'seller', 'sellerId', current_setting('fp.s1')::uuid, 'level', 'BASE', 'amount', 1))); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Financeiro alterou meta'; end if;
  begin
    perform public.flight_plan_save_initiative(jsonb_build_object('companyId', c, 'month', current_setting('fp.ym'),
      'title', 'Sem papel comercial', 'lever', 'OTHER', 'ownerUserId', 'seller:' || current_setting('fp.s1'),
      'dueDate', to_char(current_date, 'YYYY-MM-DD'), 'expectedAmount', 10)); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Financeiro criou iniciativa'; end if;
  begin
    perform public.flight_plan_set_alert_state(jsonb_build_object('companyId', c, 'key', 'X:empresa', 'subject', 'empresa',
      'month', current_setting('fp.ym'), 'state', 'RESOLVED')); ok := true;
  exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Financeiro mudou alerta'; end if;
  raise notice 'PASS Financeiro: lê, não altera';
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('fp.out'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare c uuid := current_setting('fp.c')::uuid; y int := current_setting('fp.y')::int; m int := current_setting('fp.m')::int; ok boolean;
begin
  begin perform public.flight_plan_v2_dataset(c, y, m, current_setting('fp.win')::jsonb); ok := true; exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Admin de fora leu o Plano de Voo'; end if;
  begin perform public.flight_plan_targets_month(c, y, m); ok := true; exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Admin de fora leu as metas'; end if;
  begin perform public.flight_plan_history(c, null, 10); ok := true; exception when insufficient_privilege then ok := false; end;
  if ok then raise exception 'Admin de fora leu o histórico'; end if;
  if exists (select 1 from public.flight_plan_initiatives where company_id = c)
     or exists (select 1 from public.flight_plan_alert_states where company_id = c) then
    raise exception 'Admin de fora viu dados da empresa';
  end if;
  raise notice 'PASS Admin de fora da empresa: nada';
end $$;
reset role;

-- 7. Conversão: orçamento que vira pedido conta como convertido; o job do servidor lê sem usuário.
do $$
declare c uuid := current_setting('fp.c')::uuid; d jsonb;
begin
  update public.sales_orders set stage_code = '20' where id = current_setting('fp.q1')::uuid;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  d := public.flight_plan_v2_dataset(c, current_setting('fp.y')::int, current_setting('fp.m')::int,
    current_setting('fp.win')::jsonb);
  if (d->'conversion'->>'converted')::int <> 1 or jsonb_array_length(d->'quotes') <> 0 then
    raise exception 'Conversão depois do aceite errada: %', d->'conversion';
  end if;
  if (select count(*) from private.sales_order_stage_events where order_id = current_setting('fp.q1')::uuid) <> 2 then
    raise exception 'Mudança de etapa não registrada';
  end if;
  raise notice 'PASS conversão pelo histórico de etapa e leitura do job do servidor';
end $$;
rollback;
