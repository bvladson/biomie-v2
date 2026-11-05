\set ON_ERROR_STOP on
-- Equivalência da 0051_fact_sales_performance: invoice_item_amounts, fact_sales e "clientes novos" do Plano de Voo
-- devolvem EXATAMENTE o mesmo que as definições anteriores (0021 e 0050), linha a linha, para admin, gestor com
-- equipe, vendedor ligado, super admin e usuário sem acesso, em várias janelas e filtros. Empresas com base comercial,
-- com base de mercadorias e de demonstração; todas as combinações de status, escopo, canal e visibilidade.
-- Dados sintéticos; tudo desfeito no fim. Rodar no banco de TESTE.
begin;
set local time zone 'America/Sao_Paulo';

-- Referência: os corpos da 0021, sem mudar nada além do nome (security invoker: mesma RLS de quem chama).
create function pg_temp.ref_amounts(p_company uuid,p_start date,p_end date)
returns table(item_id uuid,invoice_id uuid,amount numeric)
language sql stable security invoker set search_path=public as $$
  with original as (
    select it.id item_id,i.id invoice_id,it.total original_amount,i.total header_amount,
      public.company_revenue_basis(i.company_id)='commercial_base'
        and i.status=any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible) use_commercial,
      sum(it.total) over(partition by i.id) original_sum,
      row_number() over(partition by i.id order by it.item_sequence nulls last,it.id) item_position,
      count(*) over(partition by i.id) item_count
    from public.invoices i join public.invoice_items it on it.invoice_id=i.id and it.company_id=i.company_id
    where i.company_id=p_company and i.competence_date between p_start and p_end
  ), rounded as (
    select original.*,case when use_commercial
      then public.round_commercial_item(header_amount,original_amount,original_sum)
      else original_amount end provisional_amount from original
  )
  select item_id,invoice_id,provisional_amount+case
    when use_commercial and item_position=item_count
      then header_amount-sum(provisional_amount) over(partition by invoice_id)
    else 0 end from rounded
$$;

create function pg_temp.ref_fact_sales(p_company uuid,p_start date,p_end date,p_channel uuid default null,p_branch uuid default null,
  p_seller uuid default null,p_state text default null,p_city text default null,p_category text default null)
returns table(invoice_id uuid,competence_date date,seller_id uuid,customer_id uuid,product_id uuid,category text,state text,city text,qty numeric,amount numeric)
language sql stable security invoker set search_path=public as $$
  select i.id,i.competence_date,i.seller_id,i.customer_id,it.product_id,p.category,c.state,c.city,it.quantity,a.amount
  from pg_temp.ref_amounts(p_company,p_start,p_end) a
  join public.invoices i on i.id=a.invoice_id
  join public.invoice_items it on it.id=a.item_id
  join public.products p on p.id=it.product_id
  join public.customers c on c.id=i.customer_id
  where i.company_id=p_company and i.status=any(public.revenue_valid_statuses())
    and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible)
    and (p_channel is null or i.channel_id=p_channel)
    and (p_branch is null or i.branch_id=p_branch)
    and (p_seller is null or i.seller_id=p_seller)
    and (p_state is null or c.state=p_state)
    and (p_city is null or c.city=p_city)
    and (p_category is null or p.category=p_category)
$$;

create function pg_temp.ref_new_customers(p_company uuid, p_start date, p_cut date) returns bigint
language sql stable as $$
  with cur as (select distinct customer_id from pg_temp.ref_fact_sales(p_company, p_start, p_cut)),
  prior as (
    select distinct i.customer_id from public.invoices i
    where i.company_id = p_company and i.competence_date < p_start
      and i.customer_id in (select customer_id from cur)
      and i.status = any(public.revenue_valid_statuses())
      and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible))
  select count(*) from cur where customer_id not in (select customer_id from prior)
$$;

-- Diferença simétrica (com repetições): 0 = mesmas linhas, mesmas quantidades.
create function pg_temp.diff_fact(p_company uuid, p_start date, p_end date, p_channel uuid, p_seller uuid,
  p_state text, p_category text) returns bigint
language sql stable as $$
  select count(*) from (
    (select * from public.fact_sales(p_company, p_start, p_end, p_channel, null, p_seller, p_state, null, p_category)
     except all
     select * from pg_temp.ref_fact_sales(p_company, p_start, p_end, p_channel, null, p_seller, p_state, null, p_category))
    union all
    (select * from pg_temp.ref_fact_sales(p_company, p_start, p_end, p_channel, null, p_seller, p_state, null, p_category)
     except all
     select * from public.fact_sales(p_company, p_start, p_end, p_channel, null, p_seller, p_state, null, p_category))) d
$$;
create function pg_temp.diff_amounts(p_company uuid, p_start date, p_end date) returns bigint
language sql stable as $$
  select count(*) from (
    (select * from public.invoice_item_amounts(p_company, p_start, p_end)
     except all select * from pg_temp.ref_amounts(p_company, p_start, p_end))
    union all
    (select * from pg_temp.ref_amounts(p_company, p_start, p_end)
     except all select * from public.invoice_item_amounts(p_company, p_start, p_end))) d
$$;

-- Confere tudo para quem estiver na sessão; devolve quantas linhas a referência deu (prova de que testou algo).
create function pg_temp.check_all(p_label text, p_companies uuid[], p_dataset boolean, p_need_mix boolean) returns bigint
language plpgsql as $$
declare
  c uuid; w record; f record; n bigint; total bigint := 0; m int; st date; en date; v jsonb; got bigint; want bigint;
  mix boolean := false;
begin
  foreach c in array p_companies loop
    for w in select * from (values (date '2025-01-01', date '2026-12-31'), (date '2026-03-01', date '2026-03-31'),
                                   (date '2026-07-15', date '2026-07-15')) x(s, e) loop
      n := pg_temp.diff_amounts(c, w.s, w.e);
      if n <> 0 then raise exception '% invoice_item_amounts difere (% linhas) em % a %', p_label, n, w.s, w.e; end if;
      for f in select * from (values
          (null::uuid, null::uuid, null::text, null::text),
          ((select id from public.channels where company_id = c and name = 'varejo'), null, null, null),
          ((select id from public.channels where company_id = c and name = 'licitacao'), null, null, null),
          (null, (select id from public.sellers where company_id = c order by name limit 1), null, null),
          (null, null, 'SP', null),
          (null, null, null, 'Cat 1')) x(ch, se, uf, cat) loop
        n := pg_temp.diff_fact(c, w.s, w.e, f.ch, f.se, f.uf, f.cat);
        if n <> 0 then
          raise exception '% fact_sales difere (% linhas) em % a % (canal %, vendedor %, UF %, categoria %)',
            p_label, n, w.s, w.e, f.ch, f.se, f.uf, f.cat;
        end if;
      end loop;
      total := total + (select count(*) from pg_temp.ref_fact_sales(c, w.s, w.e));
    end loop;
    if p_dataset then
      for m in 2..10 loop
        st := make_date(2026, m, 1);
        en := (st + interval '1 month - 1 day')::date;
        v := public.flight_plan_v2_dataset(c, 2026, m, jsonb_build_object(
          'previous', jsonb_build_object('start', (st - interval '1 month')::date, 'end', st - 1),
          'lastYear', jsonb_build_object('start', (st - interval '1 year')::date, 'end', (en - interval '1 year')::date),
          'trailing3', jsonb_build_object('start', (st - interval '3 months')::date, 'end', st - 1, 'divisor', 3)));
        got := (v->'totals'->>'newCustomers')::bigint;
        want := pg_temp.ref_new_customers(c, st, en);
        if got is distinct from want then
          raise exception '% clientes novos de %/2026: % (nova) x % (anterior)', p_label, m, got, want;
        end if;
        if want > 0 and want < (v->'totals'->>'customers')::bigint then mix := true; end if;
      end loop;
    end if;
  end loop;
  if p_need_mix and not mix then
    raise exception '% fixture sem mês com clientes novos E antigos: o teste de clientes novos não provaria nada', p_label;
  end if;
  raise notice 'PASS % (% linhas de referência; mês com clientes novos e antigos: %)', p_label, total, mix;
  return total;
end $$;
grant execute on function pg_temp.ref_amounts(uuid, date, date),
  pg_temp.ref_fact_sales(uuid, date, date, uuid, uuid, uuid, text, text, text),
  pg_temp.ref_new_customers(uuid, date, date), pg_temp.diff_fact(uuid, date, date, uuid, uuid, text, text),
  pg_temp.diff_amounts(uuid, date, date), pg_temp.check_all(text, uuid[], boolean, boolean) to authenticated;

do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  adm uuid := gen_random_uuid(); ges uuid := gen_random_uuid(); ven uuid := gen_random_uuid();
  sa uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid();
  s4 uuid := gen_random_uuid(); s5 uuid := gen_random_uuid(); t uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) select u, 'eq-' || u || '@invalid.example' from unnest(array[adm, ges, ven, sa, outsider]) u;
  insert into public.profiles(id) select u from unnest(array[adm, ges, ven, sa, outsider]) u;
  insert into public.user_roles(user_id, role) values
    (adm, 'ADMIN'), (ges, 'GESTOR'), (ven, 'VENDEDOR'), (sa, 'SUPER_ADMIN'), (outsider, 'FINANCEIRO');
  insert into public.companies(id, name, slug, data_source, revenue_basis) values
    (a, 'Equivalência base comercial', 'eqa-' || a, 'OMIE_SHADOW', 'commercial_base'),
    (b, 'Equivalência mercadorias', 'eqb-' || b, 'OMIE_SHADOW', 'goods');
  insert into public.companies(id, name, slug, is_demo, data_source) values (d, 'Equivalência demo', 'eqd-' || d, true, 'DEMO');
  insert into public.channels(company_id, name)
    select x, n from unnest(array[a, b, d]) x, unnest(array['varejo', 'licitacao', 'outros']) n;
  insert into public.user_company_access(user_id, company_id) values (adm, a), (adm, b), (adm, d), (ges, a), (ven, a);
  insert into public.sellers(id, company_id, name) values
    (s1, a, 'Eq S1'), (s2, a, 'Eq S2'), (s3, a, 'Eq S3'), (s4, b, 'Eq S4'), (s5, d, 'Eq S5');
  update public.sellers set user_id = ven where id = s2;
  insert into public.sales_teams(id, company_id, name) values (t, a, 'Equipe equivalência');
  insert into public.sales_team_managers(team_id, user_id, valid_from) values (t, ges, date '2025-01-01');
  insert into public.sales_team_members(team_id, seller_id, valid_from) values (t, s1, date '2025-01-01');
  insert into public.products(company_id, name, category, base_price)
    select x, 'Eq P' || g, 'Cat ' || (g % 3), 1 from unnest(array[a, b, d]) x, generate_series(1, 6) g;
  insert into public.customers(company_id, name, state, city)
    select x, 'Eq C' || lpad(g::text, 2, '0'), case when g % 3 = 0 then 'SP' else 'CE' end, 'Cidade'
    from unnest(array[a, b, d]) x, generate_series(1, 30) g;
  -- Clientes 1–20 compram desde 2025 (antigos); 21–30 só a partir de um mês de 2026 (novos naquele mês).
  -- Bits de g: status (g % 5), escopo (g >> 2), canal (g >> 4), visível (g >> 6), vendedor (g >> 7).
  insert into public.invoices(company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
      gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible, status)
    select x.c,
      case when x.c = a then (array[s1, s2, s3, null::uuid])[1 + (g >> 7) % 4] when x.c = b then s4 else s5 end,
      (select id from public.customers where company_id = x.c and name = 'Eq C' || lpad((1 + (g * 7) % 30)::text, 2, '0')),
      'EQ' || g,
      case when 1 + (g * 7) % 30 <= 20 then date '2025-01-01' + (g * 37) % 670
           else date '2026-01-01' + ((g * 7) % 30 - 20) * 30 + g % 25 end,
      h.hdr, 'omie', 'eq-' || x.c || '-' || g, h.hdr, h.hdr, h.hdr,
      (array['commercial', 'commercial', 'remittance', 'unconfirmed'])[1 + (g >> 2) % 4],
      (array['varejo', 'licitacao', 'outros', 'unconfirmed'])[1 + (g >> 4) % 4],
      (g >> 6) % 2 = 0,
      (array['authorized', 'authorized', 'cancelled', 'denied', 'not_authorized'])[1 + g % 5]::public.invoice_status
    from (values (a, 1024), (b, 128), (d, 64)) x(c, n), generate_series(0, x.n - 1) g,
      lateral (select case when g % 37 = 0 then 0
                      else 5 * (1 + g % 4) * (2 + g % 4) + (1 + g % 4) * (g % 7) + g % 3 - 1 end hdr) h;
  -- Itens: 1 a 4 por nota, soma diferente do cabeçalho (rateio da base comercial), alguns sem sequência, notas zeradas.
  insert into public.invoice_items(invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence)
    select i.id, i.company_id, i.seller_id,
      (select id from public.products where company_id = i.company_id and name = 'Eq P' || (1 + (x.g + k) % 6)),
      k, case when x.g % 37 = 0 then 0 else 10 * k + x.g % 7 end,
      case when x.g % 11 = 0 then null else k end
    from public.invoices i, lateral (select substring(i.number from 3)::int g) x, generate_series(1, 1 + x.g % 4) k
    where i.company_id in (a, b, d) and i.number like 'EQ%';
  perform set_config('eq.a', a::text, true);
  perform set_config('eq.b', b::text, true);
  perform set_config('eq.d', d::text, true);
  perform set_config('eq.adm', adm::text, true);
  perform set_config('eq.ges', ges::text, true);
  perform set_config('eq.ven', ven::text, true);
  perform set_config('eq.sa', sa::text, true);
  perform set_config('eq.outsider', outsider::text, true);
  -- Empresa de demonstração visível (desfeito no rollback).
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.set_demo_visibility(true);
end $$;

-- 1. Admin: as três empresas, com "clientes novos" do Plano de Voo e exigindo mês com clientes novos e antigos.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('eq.adm'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  if pg_temp.check_all('admin', array[current_setting('eq.a')::uuid, current_setting('eq.b')::uuid,
                                       current_setting('eq.d')::uuid], true, true) = 0 then
    raise exception 'admin: a referência não devolveu linhas (dados de teste vazios)';
  end if;
end $$;
reset role;

-- 2. Gestor com equipe (só o vendedor da equipe) e 3. vendedor ligado (só o próprio).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('eq.ges'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  if pg_temp.check_all('gestor', array[current_setting('eq.a')::uuid], true, false) = 0 then
    raise exception 'gestor: a referência não devolveu linhas';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('eq.ven'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  if pg_temp.check_all('vendedor', array[current_setting('eq.a')::uuid], true, false) = 0 then
    raise exception 'vendedor: a referência não devolveu linhas';
  end if;
end $$;
reset role;

-- 4. Super admin (sem acesso por empresa, vê todas).
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('eq.sa'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  perform pg_temp.check_all('super admin', array[current_setting('eq.a')::uuid, current_setting('eq.b')::uuid,
                                                current_setting('eq.d')::uuid], false, false);
end $$;
reset role;

-- 5. Sem acesso à empresa: as duas versões não devolvem nada.
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('eq.outsider'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  if pg_temp.check_all('sem acesso', array[current_setting('eq.a')::uuid], false, false) <> 0 then
    raise exception 'sem acesso: a referência devolveu linhas de outra empresa';
  end if;
end $$;
reset role;

-- 6. As permissões continuam as de antes (create or replace mantém os grants).
do $$ begin
  if has_function_privilege('anon', 'public.fact_sales(uuid,date,date,uuid,uuid,uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.invoice_item_amounts(uuid,date,date)', 'execute') then
    raise exception 'anon ganhou acesso ao faturamento';
  end if;
  if not has_function_privilege('authenticated', 'public.fact_sales(uuid,date,date,uuid,uuid,uuid,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.invoice_item_amounts(uuid,date,date)', 'execute') then
    raise exception 'authenticated perdeu acesso ao faturamento';
  end if;
  if to_regclass('public.invoices_company_customer_date_idx') is null then
    raise exception 'índice invoices_company_customer_date_idx ausente';
  end if;
  raise notice 'PASS permissões e índice';
end $$;
rollback;
