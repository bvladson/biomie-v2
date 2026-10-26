\set ON_ERROR_STOP on
-- sales_kpis rápido (0046) = sales_kpis anterior (0021), número a número.
-- A referência é o corpo da 0021 copiado SEM MUDANÇA para um esquema que só existe nesta transação.
-- Compara o JSON inteiro (como texto) em vários períodos e filtros: sem RLS (serviço), como Super admin
-- e como vendedor restrito (só enxerga as próprias notas, itens e pedidos). Os casos difíceis: compra
-- anterior cancelada, negada, de remessa, intragrupo, sem itens, de outro vendedor, com item de outro
-- vendedor; primeira compra no primeiro dia e véspera; filtros que não podem mudar a "primeira compra";
-- pedidos cancelados, orçamento (etapa 10), remessa, sem etapa, sem itens, fora do período, origem
-- manual. Valores principais também conferidos à mão. Usuários e empresa sintéticos; tudo desfeito.
begin;
create schema verify_sk;

create function verify_sk.sales_kpis_ref(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  with f as (
    select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  ), fb as (
    select customer_id,min(competence_date) d from public.fact_sales(p_company,'-infinity'::date,'infinity'::date) group by 1
  )
  select jsonb_build_object(
    'revenue', coalesce(sum(f.amount), 0),
    'invoices', count(distinct f.invoice_id),
    'units', coalesce(sum(f.qty), 0),
    'customers', count(distinct f.customer_id),
    'newCustomers', (select count(distinct f2.customer_id) from f f2 join fb on fb.customer_id = f2.customer_id and fb.d between p_start and p_end),
    'orders', (select count(distinct order_id) from public.fact_orders(p_company, p_channel, p_branch, p_seller, p_state, p_city, p_category)
               where status <> 'cancelled' and order_date between p_start and p_end)
  ) into v from f;
  return v;
end $$;

create table verify_sk.cases(label text primary key, s date, e date, ch uuid, br uuid, se uuid, st text, ci text, ca text);

create function verify_sk.compare_all(p_company uuid) returns table(checked int, first_diff text)
language plpgsql stable security invoker set search_path = public as $$
declare r record; a text; b text; n int := 0; diff text;
begin
  for r in select * from verify_sk.cases order by label loop
    a := public.sales_kpis(p_company, r.s, r.e, r.ch, r.br, r.se, r.st, r.ci, r.ca)::text;
    b := verify_sk.sales_kpis_ref(p_company, r.s, r.e, r.ch, r.br, r.se, r.st, r.ci, r.ca)::text;
    n := n + 1;
    if a is distinct from b and diff is null then
      diff := r.label || ': novo=' || coalesce(a, 'null') || ' anterior=' || coalesce(b, 'null');
    end if;
  end loop;
  return query select n, diff;
end $$;

create function verify_sk.k(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_seller uuid default null,
  p_category text default null) returns jsonb language sql stable security invoker set search_path = public as $$
  select public.sales_kpis(p_company, p_start, p_end, p_channel, null, p_seller, null, null, p_category)
$$;
grant usage on schema verify_sk to authenticated;
grant select on verify_sk.cases to authenticated;
grant execute on all functions in schema verify_sk to authenticated;

do $$
declare
  sa uuid := gen_random_uuid(); vend uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  pa uuid := gen_random_uuid(); pb uuid := gen_random_uuid();
  k uuid[] := array(select gen_random_uuid() from generate_series(1, 18));
  i uuid[] := array(select gen_random_uuid() from generate_series(1, 31));
  o uuid[] := array(select gen_random_uuid() from generate_series(1, 14));
  chv uuid; chl uuid; cho uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into auth.users(id, email) values (sa, 'sa-' || sa || '@invalid.example'), (vend, 'vend-' || vend || '@invalid.example');
  insert into public.profiles(id) values (sa), (vend);
  insert into public.user_roles(user_id, role) values (sa, 'SUPER_ADMIN'), (vend, 'VENDEDOR');
  insert into public.companies(id, name, slug, data_source, revenue_basis) values (c, 'KPI fixture', 'kpi-' || c, 'OMIE_SHADOW', 'commercial_base');
  insert into public.user_company_access(user_id, company_id) values (vend, c);
  insert into public.channels(company_id, name) values (c, 'varejo'), (c, 'licitacao'), (c, 'outros');
  select id into chv from public.channels where company_id = c and name = 'varejo';
  select id into chl from public.channels where company_id = c and name = 'licitacao';
  select id into cho from public.channels where company_id = c and name = 'outros';
  insert into public.branches(id, company_id, name) values (b1, c, 'Matriz'), (b2, c, 'Filial');
  insert into public.sellers(id, company_id, name, user_id) values (s1, c, 'Vendedor 1', vend), (s2, c, 'Vendedor 2', null);
  insert into public.products(id, company_id, name, category, base_price) values
    (pa, c, 'Cadeira', 'Cadeiras', 100), (pb, c, 'Mesa', 'Mesas', 300);
  insert into public.customers(id, company_id, name, state, city)
    select k[n], c, 'Cliente ' || n,
      case when n in (3, 4) then 'SP' else 'CE' end,
      case n when 3 then 'São Paulo' when 4 then 'Campinas' when 5 then 'Sobral' else 'Fortaleza' end
    from generate_series(1, 18) n;

  -- Notas: (índice, cliente, vendedor, data, status, operação, canal, filial)
  insert into public.invoices(id, company_id, seller_id, customer_id, branch_id, number, status, competence_date, total, source, external_id,
    gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible)
  select i[x.n], c, case x.sel when 1 then s1 else s2 end, k[x.cust], case x.br when 1 then b1 else b2 end, 'NF' || x.n,
    x.st::public.invoice_status, x.d::date, x.tot, 'omie', 'kpi-' || c || '-' || x.n, x.tot, x.tot, x.tot, x.scope, x.chan,
    x.chan = 'varejo'
  from (values
    -- antes do período de março
    ( 1,  1, 1, '2026-02-10', 'authorized', 'commercial', 'varejo',    1, 100),
    ( 2,  3, 1, '2026-02-01', 'cancelled',  'commercial', 'varejo',    1, 100),
    ( 3,  4, 1, '2026-02-05', 'authorized', 'commercial', 'outros',    1, 100),
    ( 4,  5, 1, '2026-01-20', 'authorized', 'remittance', 'varejo',    1, 100),
    ( 5,  6, 2, '2026-02-20', 'authorized', 'commercial', 'varejo',    2, 100),
    ( 6,  7, 1, '2026-02-25', 'authorized', 'commercial', 'varejo',    1, 100),
    ( 7,  9, 1, '2026-02-28', 'authorized', 'commercial', 'licitacao', 1, 300),
    ( 8, 11, 1, '2026-02-03', 'authorized', 'commercial', 'varejo',    1, 100),
    ( 9, 12, 1, '2026-02-14', 'denied',     'commercial', 'varejo',    1, 100),
    (10, 13, 1, '2026-02-12', 'authorized', 'commercial', 'varejo',    1, 100),
    (11, 14, 2, '2026-01-15', 'authorized', 'commercial', 'licitacao', 2, 300),
    -- março
    (13,  1, 1, '2026-03-05', 'authorized', 'commercial', 'varejo',    1, 500),
    (14,  2, 2, '2026-03-10', 'authorized', 'commercial', 'varejo',    2, 300),
    (15,  2, 2, '2026-03-11', 'cancelled',  'commercial', 'varejo',    2, 300),
    (16,  3, 1, '2026-03-15', 'authorized', 'commercial', 'licitacao', 1, 100),
    (17,  4, 1, '2026-03-20', 'authorized', 'commercial', 'varejo',    1, 100),
    (18,  5, 2, '2026-03-25', 'authorized', 'commercial', 'licitacao', 2, 300),
    (19,  6, 1, '2026-03-08', 'authorized', 'commercial', 'varejo',    1, 100),
    (20,  7, 1, '2026-03-12', 'authorized', 'commercial', 'varejo',    1, 100),
    (21,  8, 1, '2026-03-01', 'authorized', 'commercial', 'varejo',    1, 100),
    (22,  9, 1, '2026-03-31', 'authorized', 'commercial', 'licitacao', 1, 300),
    (23, 11, 1, '2026-03-18', 'authorized', 'commercial', 'varejo',    1, 100),
    (24, 12, 1, '2026-03-19', 'authorized', 'commercial', 'varejo',    1, 100),
    (25, 13, 1, '2026-03-22', 'authorized', 'commercial', 'varejo',    1, 300),
    (26, 14, 2, '2026-03-23', 'authorized', 'commercial', 'varejo',    2, 100),
    (27, 16, 1, '2026-03-26', 'authorized', 'commercial', 'outros',    1, 100),
    (30, 18, 2, '2026-03-27', 'authorized', 'commercial', 'varejo',    2, 100),
    -- abril
    (28, 10, 1, '2026-04-05', 'authorized', 'commercial', 'varejo',    1, 100),
    (29,  2, 2, '2026-04-07', 'authorized', 'commercial', 'varejo',    2, 300)
  ) as x(n, cust, sel, d, st, scope, chan, br, tot);

  -- Itens: (nota, sequência, produto, vendedor do item, quantidade, total). A nota 8 fica sem itens; o item
  -- da nota 6 é de outro vendedor (o vendedor 1 enxerga a nota, mas não o item).
  insert into public.invoice_items(invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence)
  select i[x.n], c, case x.sel when 1 then s1 else s2 end, case x.prod when 1 then pa else pb end, x.q, x.tot, x.seq
  from (values
    ( 1, 1, 1, 1, 1, 100), ( 2, 1, 1, 1, 1, 100), ( 3, 1, 1, 1, 1, 100), ( 4, 1, 1, 1, 1, 100),
    ( 5, 1, 1, 2, 1, 100), ( 6, 1, 1, 2, 1, 100), ( 7, 1, 2, 1, 1, 300), ( 9, 1, 1, 1, 1, 100),
    (10, 1, 1, 1, 1, 100), (11, 1, 2, 2, 1, 300),
    (13, 1, 1, 1, 2, 200), (13, 2, 2, 1, 1, 300), (14, 1, 2, 2, 1, 300), (15, 1, 2, 2, 1, 300),
    (16, 1, 1, 1, 1, 100), (17, 1, 1, 1, 1, 100), (18, 1, 2, 2, 1, 300), (19, 1, 1, 1, 1, 100),
    (20, 1, 1, 1, 1, 100), (21, 1, 1, 1, 1, 100), (22, 1, 2, 1, 1, 300), (23, 1, 1, 1, 1, 100),
    (24, 1, 1, 1, 1, 100), (25, 1, 2, 1, 1, 300), (26, 1, 1, 2, 1, 100), (27, 1, 1, 1, 1, 100),
    (30, 1, 1, 2, 1, 100), (28, 1, 1, 1, 1, 100), (29, 1, 2, 2, 1, 300)
  ) as x(n, seq, prod, sel, q, tot);

  -- Pedidos: (índice, cliente, vendedor, status, data, origem, operação, etapa, canal, filial)
  insert into public.sales_orders(id, company_id, seller_id, customer_id, branch_id, number, status, order_date, total, source,
    operation_scope, stage_code, business_channel)
  select o[x.n], c, case x.sel when 1 then s1 else s2 end, k[x.cust], case x.br when 1 then b1 else b2 end, 'PV' || x.n,
    x.st::public.order_status, x.d::date, 100, x.src, x.scope, x.stage, x.chan
  from (values
    ( 1,  1, 1, 'open',      '2026-03-05', 'omie',   'commercial',  '20', 'varejo',    1),
    ( 2,  2, 2, 'cancelled', '2026-03-10', 'omie',   'commercial',  '20', 'varejo',    2),
    ( 3,  3, 1, 'open',      '2026-03-15', 'omie',   'commercial',  '10', 'licitacao', 1),
    ( 4,  4, 1, 'open',      '2026-03-20', 'omie',   'remittance',  '20', 'varejo',    1),
    ( 5,  5, 2, 'open',      '2026-03-25', 'omie',   'commercial',  null, 'licitacao', 2),
    ( 6,  6, 1, 'open',      '2026-03-08', 'manual', 'unconfirmed', null, 'varejo',    1),
    ( 7,  7, 1, 'open',      '2026-02-15', 'omie',   'commercial',  '20', 'varejo',    1),
    ( 8,  8, 1, 'open',      '2026-04-02', 'omie',   'commercial',  '20', 'varejo',    1),
    ( 9,  9, 1, 'open',      '2026-03-12', 'omie',   'commercial',  '20', 'varejo',    1),
    (10,  1, 1, 'invoiced',  '2026-03-06', 'omie',   'commercial',  '30', 'varejo',    1),
    (11, 13, 2, 'open',      '2026-03-22', 'omie',   'commercial',  '20', 'varejo',    2),
    (12, 14, 2, 'open',      '2026-03-23', 'omie',   'commercial',  '20', 'licitacao', 2),
    (13,  8, 1, 'open',      '2026-03-01', 'omie',   'commercial',  '20', 'varejo',    1),
    (14,  9, 1, 'open',      '2026-03-31', 'omie',   'commercial',  '20', 'licitacao', 1)
  ) as x(n, cust, sel, st, d, src, scope, stage, chan, br);

  -- Itens dos pedidos: (pedido, sequência, produto, vendedor do item). O pedido 9 fica sem itens; o item do
  -- pedido 10 é de outro vendedor.
  insert into public.sales_order_items(order_id, company_id, seller_id, product_id, quantity, total, item_sequence)
  select o[x.n], c, case x.sel when 1 then s1 else s2 end, case x.prod when 1 then pa else pb end, 1, 100, x.seq
  from (values
    (1, 1, 1, 1), (2, 1, 2, 2), (3, 1, 1, 1), (4, 1, 1, 1), (5, 1, 2, 2), (6, 1, 1, 1), (7, 1, 1, 1), (8, 1, 1, 1),
    (10, 1, 2, 2), (11, 1, 2, 2), (12, 1, 1, 2), (12, 2, 2, 2), (13, 1, 1, 1), (14, 1, 2, 1)
  ) as x(n, seq, prod, sel);

  -- Casos: os períodos principais com cada filtro e combinações; os de borda sem filtro.
  insert into verify_sk.cases
  select p.name || '|' || f.name, p.s, p.e, f.ch, f.br, f.se, f.st, f.ci, f.ca
  from (values ('a_marco', date '2026-03-01', date '2026-03-31'), ('b_fevereiro', date '2026-02-01', date '2026-02-28'),
               ('c_ano', date '2026-01-01', date '2026-12-31'), ('d_abril', date '2026-04-01', date '2026-04-30')) p(name, s, e)
  cross join (values
    ('00_sem_filtro', null::uuid, null::uuid, null::uuid, null::text, null::text, null::text),
    ('01_varejo', chv, null, null, null, null, null), ('02_licitacao', chl, null, null, null, null, null),
    ('03_outros', cho, null, null, null, null, null), ('04_filial_1', null, b1, null, null, null, null),
    ('05_filial_2', null, b2, null, null, null, null), ('06_vendedor_1', null, null, s1, null, null, null),
    ('07_vendedor_2', null, null, s2, null, null, null), ('08_ce', null, null, null, 'CE', null, null),
    ('09_sp', null, null, null, 'SP', null, null), ('10_fortaleza', null, null, null, null, 'Fortaleza', null),
    ('11_campinas', null, null, null, null, 'Campinas', null), ('12_cadeiras', null, null, null, null, null, 'Cadeiras'),
    ('13_mesas', null, null, null, null, null, 'Mesas'), ('14_varejo_v1', chv, null, s1, null, null, null),
    ('15_ce_mesas', null, null, null, 'CE', null, 'Mesas'), ('16_f2_v2_varejo', chv, b2, s2, null, null, null),
    ('17_licitacao_campinas', chl, null, null, null, 'Campinas', null)
  ) f(name, ch, br, se, st, ci, ca);
  insert into verify_sk.cases(label, s, e) values
    ('e_um_dia', '2026-03-01', '2026-03-01'), ('f_tudo', '-infinity', 'infinity'),
    ('g_invertido', '2026-03-31', '2026-03-01'), ('h_vazio_2025', '2025-01-01', '2025-12-31'),
    ('i_sem_inicio', null, '2026-03-31'), ('j_virada', '2026-02-28', '2026-03-01');

  perform set_config('vsk.company', c::text, true);
  perform set_config('vsk.sa', sa::text, true);
  perform set_config('vsk.vend', vend::text, true);
  perform set_config('vsk.s1', s1::text, true);
  perform set_config('vsk.chv', chv::text, true);
end $$;

-- 0. A versão nova não volta a ler todo o histórico nem todos os pedidos.
do $$
declare src text := (select prosrc from pg_proc where oid = 'public.sales_kpis(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure);
begin
  if src like '%-infinity%' or src like '%fact_orders(%' then raise exception 'sales_kpis voltou a varrer todo o histórico'; end if;
  if (select prosecdef from pg_proc where oid = 'public.sales_kpis(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure) then
    raise exception 'sales_kpis deve continuar security invoker';
  end if;
  raise notice 'PASS estrutura: sem varredura do histórico, security invoker';
end $$;

-- 1. Sem RLS (pedido de serviço).
do $$
declare c uuid := current_setting('vsk.company')::uuid; r record; k jsonb;
begin
  select * into r from verify_sk.compare_all(c);
  if r.first_diff is not null then raise exception 'Serviço: %', r.first_diff; end if;
  if r.checked < 78 then raise exception 'Poucos casos comparados: %', r.checked; end if;
  k := verify_sk.k(c, '2026-03-01', '2026-03-31');
  if k <> '{"revenue": 2600, "invoices": 14, "units": 16, "customers": 14, "newCustomers": 8, "orders": 7}'::jsonb then
    raise exception 'Março (serviço) diferente do conferido à mão: %', k;
  end if;
  raise notice 'PASS serviço: % casos iguais; março = %', r.checked, k;
end $$;

-- 2. Super admin (RLS ativa, enxerga tudo).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('vsk.sa'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare c uuid := current_setting('vsk.company')::uuid; r record; k jsonb;
begin
  select * into r from verify_sk.compare_all(c);
  if r.first_diff is not null then raise exception 'Super admin: %', r.first_diff; end if;
  k := verify_sk.k(c, '2026-03-01', '2026-03-31');
  if (k->>'newCustomers')::int <> 8 or (k->>'orders')::int <> 7 or (k->>'customers')::int <> 14 then
    raise exception 'Super admin março: %', k;
  end if;
  k := verify_sk.k(c, '2026-03-01', '2026-03-31', p_category => 'Mesas');
  if (k->>'newCustomers')::int <> 2 or (k->>'orders')::int <> 4 then raise exception 'Mesas: %', k; end if;
  k := verify_sk.k(c, '2026-03-01', '2026-03-31', p_channel => current_setting('vsk.chv')::uuid);
  if (k->>'newCustomers')::int <> 6 then raise exception 'Varejo: %', k; end if;
  k := verify_sk.k(c, '2026-04-01', '2026-04-30');
  if (k->>'newCustomers')::int <> 1 or (k->>'customers')::int <> 2 then raise exception 'Abril: %', k; end if;
  k := verify_sk.k(c, '2026-03-31', '2026-03-01');
  if k <> '{"revenue": 0, "invoices": 0, "units": 0, "customers": 0, "newCustomers": 0, "orders": 0}'::jsonb then
    raise exception 'Período invertido: %', k;
  end if;
  raise notice 'PASS super admin: % casos iguais; filtros não mudam a primeira compra', r.checked;
end $$;
reset role;

-- 3. Vendedor restrito: só as próprias notas, itens e pedidos.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('vsk.vend'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare c uuid := current_setting('vsk.company')::uuid; r record; k jsonb;
begin
  select * into r from verify_sk.compare_all(c);
  if r.first_diff is not null then raise exception 'Vendedor: %', r.first_diff; end if;
  k := verify_sk.k(c, '2026-03-01', '2026-03-31');
  if (k->>'customers')::int <> 10 or (k->>'invoices')::int <> 10 or (k->>'newCustomers')::int <> 7 or (k->>'orders')::int <> 4 then
    raise exception 'Vendedor março: %', k;
  end if;
  raise notice 'PASS vendedor restrito: % casos iguais; março = %', r.checked, k;
end $$;
reset role;
rollback;
