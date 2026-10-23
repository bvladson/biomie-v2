-- 0043: Estoque — curva A/B/C/D automática (aprovada pelo usuário em 22/10/2026).
--
-- Regras aprovadas:
--   * base: faturamento líquido válido por produto, a mesma da página Produtos (public.fact_sales),
--     por empresa, sem os filtros de canal/vendedor; janelas de 30, 90 e 180 dias e 12 meses até a
--     data de referência (hoje, como data_as_of), padrão 12 meses;
--   * A = produtos que somam até 80% do faturamento da janela, B = até 95%, C = demais com venda;
--     o produto que atravessa o limite fica na faixa que estava sendo preenchida; empate pela ordem
--     estável do identificador do produto; todos os produtos vendidos entram no acumulado, com ou
--     sem saldo, e o filtro de estoque vem depois;
--   * D = produto com saldo positivo e sem venda na janela;
--   * a curva manual prevalece, sempre com usuário, data e justificativa, e pode voltar para a
--     automática; tudo vai para a Auditoria.
-- Cuidados: produto novo (primeira entrada ou cadastro no Omie há até N dias) não é estoque
-- encalhado; histórico incompleto (vendas do BIOMIE começam depois do início da janela, ou o
-- produto é mais novo que a janela) não é ausência de venda confirmada; tempo sem venda em faixas
-- de 30/90/180/365 dias, independente da janela; venda do mesmo SKU em outra empresa do grupo;
-- última entrada pelas movimentações do Omie (ListarMovimentoEstoque).
-- Recálculo: depois de cada leitura publicada (até 4x/dia), só com as notas fiscais consistentes;
-- tudo numa transação: falha ou queda brusca do faturamento mantém as curvas anteriores.
-- Somente acréscimos: tabelas e colunas novas; as funções mudam mantendo as chamadas antigas
-- válidas (parâmetros novos com valor padrão).

-- ===================================================================== configuração

alter table private.stock_settings
  add column if not exists curve_window text not null default '12m',
  add column if not exists curve_a_limit numeric not null default 80,
  add column if not exists curve_b_limit numeric not null default 95,
  add column if not exists new_product_days integer not null default 90,
  add column if not exists movements_enabled boolean not null default false,
  add column if not exists movements_days integer not null default 365,
  add column if not exists movements_chunk_days integer not null default 31;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_settings_curves_ok') then
    alter table private.stock_settings add constraint stock_settings_curves_ok check (
      curve_window in ('30d', '90d', '180d', '12m')
      and curve_a_limit > 0 and curve_a_limit < curve_b_limit and curve_b_limit < 100
      and new_product_days between 1 and 365
      and movements_days between 30 and 730 and movements_chunk_days between 7 and 92);
  end if;
end $$;

-- Justificativa da curva manual (obrigatória a partir desta migração).
alter table private.stock_curves add column if not exists reason text;

-- ===================================================================== tabelas

-- Curva automática dos produtos VENDIDOS (A/B/C) por empresa e janela. D e "sem curva" saem
-- da posição (saldo) na hora da consulta. Substituída por inteiro a cada cálculo bem-sucedido.
create table if not exists private.stock_auto_curves (
  company_id uuid not null references public.companies(id) on delete cascade,
  curve_window text not null check (curve_window in ('30d', '90d', '180d', '12m')),
  product_id uuid not null,
  omie_product_id text,
  sku text,
  curve text not null check (curve in ('A', 'B', 'C')),
  revenue numeric not null,
  units numeric not null,
  share numeric not null,
  cumulative_before numeric not null,
  rank integer not null,
  last_sale date,
  primary key (company_id, curve_window, product_id)
);
create index if not exists stock_auto_curves_omie on private.stock_auto_curves (company_id, curve_window, omie_product_id);
create index if not exists stock_auto_curves_sku on private.stock_auto_curves (curve_window, sku);

-- Fatos por produto do estoque, independentes da janela.
create table if not exists private.stock_product_facts (
  company_id uuid not null references public.companies(id) on delete cascade,
  omie_product_id text not null,
  registered_at date,          -- inclusão do produto no Omie (info.dInc do cadastro)
  first_sale date,             -- no histórico de vendas disponível (até 12 meses)
  last_sale date,
  first_entry date,            -- nas movimentações lidas do Omie
  last_entry date,
  last_entry_operation text,   -- 21 compra, 22 importação, 00 ajuste, 13 devolução de venda...
  last_entry_qty numeric,
  last_exit date,              -- última saída (venda, consumo da produção, remessa, ajuste...)
  last_exit_operation text,
  last_exit_group boolean not null default false,  -- a última saída é venda para empresa do grupo
  elsewhere_company_id uuid,   -- mesma SKU vendida por outra empresa do grupo (12 meses)
  elsewhere_last_sale date,
  -- Chegada do produto: a primeira entrada só vale quando o histórico de movimentações lido começa
  -- antes do cadastro (senão uma reposição recente pareceria produto novo); fora isso, o cadastro.
  arrived_on date,
  primary key (company_id, omie_product_id)
);

-- Cada cálculo por empresa: situação, data de referência e totais por janela.
create table if not exists private.stock_curve_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  status text not null check (status in ('ok', 'skipped', 'failed')),
  trigger text not null default 'worker',
  as_of date not null,
  sales_from date,
  reason text,
  totals jsonb,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz not null default clock_timestamp()
);
create index if not exists stock_curve_runs_company on private.stock_curve_runs (company_id, finished_at desc);

-- Movimentações do Omie (ListarMovimentoEstoque): base da última entrada e do produto novo.
create table if not exists private.stock_movements (
  company_id uuid not null references public.companies(id) on delete cascade,
  movement_id bigint not null,
  moved_on date not null,
  kind text not null check (kind in ('entrada', 'saida')),
  operation text,
  origin text,
  canceled boolean not null default false,
  is_return boolean not null default false,
  omie_product_id text not null,
  location_code text,
  qty numeric,
  unit_cost numeric,
  value numeric,
  document text,
  saved_at timestamptz not null default now(),
  primary key (company_id, movement_id)
);
create index if not exists stock_movements_product on private.stock_movements (company_id, omie_product_id, kind, moved_on desc);

-- Fila das leituras de movimentação (carga inicial em blocos e atualizações do dia).
create table if not exists private.stock_movement_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  trigger text not null check (trigger in ('backfill', 'delta', 'manual')),
  period_from date not null,
  period_to date not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'failed')),
  pages_total integer check (pages_total >= 0),
  pages_done integer not null default 0 check (pages_done >= 0),
  records_expected integer,
  records_saved integer not null default 0,
  records_skipped integer not null default 0,
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  progress_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz,
  check (period_from <= period_to)
);
create index if not exists stock_movement_jobs_queue on private.stock_movement_jobs (status, next_attempt_at, created_at);
create index if not exists stock_movement_jobs_company on private.stock_movement_jobs (company_id, period_to desc);

revoke all on private.stock_auto_curves, private.stock_product_facts, private.stock_curve_runs,
  private.stock_movements, private.stock_movement_jobs from public, anon, authenticated;

-- ===================================================================== apoio

create or replace function stock_internal.window_days(p_window text) returns integer
language sql immutable set search_path = pg_catalog as $$
  select case p_window when '30d' then 30 when '90d' then 90 when '180d' then 180 when '12m' then 365 end
$$;

-- Janela pedida pela tela ou a padrão da configuração; qualquer outro valor é recusado.
create or replace function stock_internal.pick_window(p_window text) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_window is null or p_window = '' then
    return (select s.curve_window from private.stock_settings s);
  end if;
  if stock_internal.window_days(p_window) is null then
    raise exception 'Janela inválida. Use 30, 90 ou 180 dias ou 12 meses.' using errcode = 'P0001';
  end if;
  return p_window;
end $$;

-- Data de referência das vendas, a mesma da página Produtos para empresas reais.
create or replace function stock_internal.as_of() returns date
language sql stable set search_path = pg_catalog as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

-- Notas fiscais consistentes para o cálculo? null = sim; senão, o motivo (curvas anteriores ficam).
create or replace function stock_internal.sales_block(p_company uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare r record;
begin
  if exists (select 1 from public.integration_backfill_jobs j
             where j.company_id = p_company and j.entity = 'invoices' and j.status = 'RUNNING') then
    return 'Notas fiscais em sincronização; o cálculo fica para a próxima leitura.';
  end if;
  select s.status, s.gold_complete into r from public.integration_sync_runs s
    where s.company_id = p_company and s.entity = 'invoices' order by s.started_at desc limit 1;
  if not found then return 'Ainda não há carga de notas fiscais concluída para esta empresa.'; end if;
  if r.status in ('RUNNING', 'PENDING') then
    return 'Notas fiscais em sincronização; o cálculo fica para a próxima leitura.';
  end if;
  if r.status = 'FAILED' then
    return 'A última carga de notas fiscais falhou; as curvas anteriores foram mantidas.';
  end if;
  if not coalesce(r.gold_complete, false) then
    return 'A última carga de notas fiscais não terminou; as curvas anteriores foram mantidas.';
  end if;
  return null;
end $$;

-- Início do histórico contínuo de notas do BIOMIE que chega até a data de referência.
create or replace function stock_internal.sales_from(p_company uuid, p_as_of date) returns date
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select min((x->>'from')::date)
  from jsonb_array_elements(coalesce(public.data_coverage(p_company)->'entities'->'invoices', '[]'::jsonb)) x
  where (x->>'to')::date >= p_as_of - 3
$$;

-- Entradas que são chegada de mercadoria (22/10/2026, códigos reais do Omie): 00 ajuste manual,
-- 13 devolução de venda, 21 compra, 22 importação, 24 retorno/nota de entrada, 28 entrada da ordem de
-- produção. Ficam de fora 15 (conhecimento de transporte: frete, só custo), 26 (nota complementar)
-- e as entradas de estorno (11 e 14 = cancelamento de venda e de remessa).
create or replace function stock_internal.is_receipt(p_operation text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(p_operation in ('00', '13', '21', '22', '24', '28'), false)
$$;

-- Saídas que mostram giro do produto: 00 ajuste manual, 11 e 12 venda, 14 remessa, 23 devolução ao
-- fornecedor, 28 consumo da ordem de produção. Fora: 16 (nota complementar) e 24 (estorno de entrada).
-- Estornos: o Omie lança o cancelamento no sentido oposto, com cancelamento = S, a mesma operação e o
-- mesmo documento (22/10/2026: 359 de 359 acham o original). O cancelamento nunca conta e o movimento
-- estornado também não: venda cancelada não é saída, nota de entrada cancelada não é chegada.
create or replace function stock_internal.is_exit(p_operation text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(p_operation in ('00', '11', '12', '14', '23', '28'), false)
$$;

-- Início do histórico contínuo de movimentações lidas que chega à leitura mais recente (ou null).
create or replace function stock_internal.movements_from(p_company uuid) returns date
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with j as (
    select m.period_from, m.period_to,
      max(m.period_to) over (order by m.period_from, m.period_to
                             rows between unbounded preceding and 1 preceding) as prev_to
    from private.stock_movement_jobs m where m.company_id = p_company and m.status = 'complete'),
  g as (
    select j.period_from, j.period_to,
      sum(case when j.prev_to is null or j.period_from > j.prev_to + 1 then 1 else 0 end)
        over (order by j.period_from, j.period_to) as grp
    from j),
  r as (select min(g.period_from) as f, max(g.period_to) as t from g group by g.grp)
  select r.f from r order by r.t desc limit 1
$$;

-- ===================================================================== cálculo

create or replace function stock_internal.refresh_curves(p_company uuid, p_trigger text, p_force boolean)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
  set client_min_messages = warning as $$
declare
  v_settings private.stock_settings;
  v_as_of date := stock_internal.as_of();
  v_started timestamptz := clock_timestamp();
  v_block text;
  v_sales_from date;
  v_prev numeric;
  v_new numeric;
  v_totals jsonb;
  v_movements_from date;
begin
  if p_company is null or not exists (select 1 from public.companies c where c.id = p_company and not c.is_demo) then
    raise exception 'Empresa inválida para o cálculo das curvas.' using errcode = 'P0001';
  end if;
  -- Um cálculo por empresa de cada vez.
  perform pg_advisory_xact_lock(hashtext('stock_curves:' || p_company::text));
  select * into v_settings from private.stock_settings;

  v_block := stock_internal.sales_block(p_company);
  if v_block is not null and not coalesce(p_force, false) then
    insert into private.stock_curve_runs (company_id, status, trigger, as_of, reason, started_at, finished_at)
      values (p_company, 'skipped', coalesce(p_trigger, 'worker'), v_as_of, v_block, v_started, clock_timestamp());
    return jsonb_build_object('status', 'skipped', 'reason', v_block);
  end if;
  v_sales_from := stock_internal.sales_from(p_company, v_as_of);

  -- Vendas de 12 meses por produto, da mesma base da página Produtos (fact_sales), sem filtros.
  create temporary table if not exists pg_temp.stock_sales (
    product_id uuid primary key, omie_product_id text, sku text,
    r30 numeric, r90 numeric, r180 numeric, r365 numeric,
    u30 numeric, u90 numeric, u180 numeric, u365 numeric,
    first_sale date, last_sale date) on commit drop;
  delete from pg_temp.stock_sales;
  insert into pg_temp.stock_sales
  select f.product_id,
    max(p.external_id) filter (where p.source = 'omie'),
    max(nullif(btrim(p.sku), '')),
    coalesce(sum(f.amount) filter (where f.competence_date > v_as_of - 30), 0),
    coalesce(sum(f.amount) filter (where f.competence_date > v_as_of - 90), 0),
    coalesce(sum(f.amount) filter (where f.competence_date > v_as_of - 180), 0),
    coalesce(sum(f.amount), 0),
    coalesce(sum(f.qty) filter (where f.competence_date > v_as_of - 30), 0),
    coalesce(sum(f.qty) filter (where f.competence_date > v_as_of - 90), 0),
    coalesce(sum(f.qty) filter (where f.competence_date > v_as_of - 180), 0),
    coalesce(sum(f.qty), 0),
    min(f.competence_date) filter (where f.amount > 0),
    max(f.competence_date) filter (where f.amount > 0)
  from public.fact_sales(p_company, v_as_of - 364, v_as_of) f
  join public.products p on p.id = f.product_id
  group by f.product_id;

  -- Proteção: queda de mais da metade do faturamento de 12 meses desde o último cálculo indica
  -- problema nas vendas; as curvas anteriores ficam até alguém conferir (ou forçar o cálculo).
  select coalesce(sum(s.r365) filter (where s.r365 > 0), 0) into v_new from pg_temp.stock_sales s;
  select (r.totals->'12m'->>'revenue')::numeric into v_prev from private.stock_curve_runs r
    where r.company_id = p_company and r.status = 'ok' order by r.finished_at desc limit 1;
  if not coalesce(p_force, false) and coalesce(v_prev, 0) > 0 and v_new < v_prev * 0.5 then
    insert into private.stock_curve_runs (company_id, status, trigger, as_of, sales_from, reason, started_at, finished_at)
      values (p_company, 'skipped', coalesce(p_trigger, 'worker'), v_as_of, v_sales_from,
        format('O faturamento de 12 meses caiu de %s para %s desde o último cálculo; curvas anteriores mantidas para conferência.',
          round(v_prev, 2), round(v_new, 2)), v_started, clock_timestamp());
    return jsonb_build_object('status', 'skipped', 'reason', 'Queda brusca do faturamento de 12 meses.');
  end if;

  -- Curva de Pareto por janela: acumulado ANTES do produto decide a faixa (quem atravessa o
  -- limite fica na faixa que estava sendo preenchida); empate pelo identificador do produto.
  delete from private.stock_auto_curves a where a.company_id = p_company;
  insert into private.stock_auto_curves (company_id, curve_window, product_id, omie_product_id, sku, curve,
      revenue, units, share, cumulative_before, rank, last_sale)
  select p_company, x.win, x.product_id, x.omie_product_id, x.sku,
    case when x.cum_before * 100 < v_settings.curve_a_limit then 'A'
         when x.cum_before * 100 < v_settings.curve_b_limit then 'B'
         else 'C' end,
    x.rev, x.units, x.rev / x.total, x.cum_before, x.rank, x.last_sale
  from (
    select s.product_id, s.omie_product_id, s.sku, s.last_sale, w.win, w.rev, w.units,
      sum(w.rev) over (partition by w.win) as total,
      coalesce(sum(w.rev) over (partition by w.win order by w.rev desc, s.product_id
                                rows between unbounded preceding and 1 preceding), 0)
        / sum(w.rev) over (partition by w.win) as cum_before,
      row_number() over (partition by w.win order by w.rev desc, s.product_id)::integer as rank
    from pg_temp.stock_sales s
    cross join lateral (values ('30d', s.r30, s.u30), ('90d', s.r90, s.u90),
                               ('180d', s.r180, s.u180), ('12m', s.r365, s.u365)) as w(win, rev, units)
    where w.rev > 0) x;

  -- Fatos de cada produto da posição publicada: cadastro, vendas, entradas e venda no grupo.
  v_movements_from := stock_internal.movements_from(p_company);
  delete from private.stock_product_facts f where f.company_id = p_company;
  insert into private.stock_product_facts (company_id, omie_product_id, registered_at, first_sale, last_sale,
      first_entry, last_entry, last_entry_operation, last_entry_qty, last_exit, last_exit_operation,
      last_exit_group, elsewhere_company_id, elsewhere_last_sale, arrived_on)
  select p_company, sp.omie_product_id, reg.registered_at, sl.first_sale, sl.last_sale,
    ent.first_entry, ent.last_entry, ent.last_operation, ent.last_qty, ex.last_exit, ex.last_operation,
    -- Venda para empresa do grupo: a nota do documento é do canal "outros" (regra oficial, 0031), que
    -- nunca conta como faturamento. O estoque saiu, mas foi transferência dentro do grupo.
    coalesce(ex.last_operation in ('11', '12') and ex.last_document in (
      select i.number from public.invoices i where i.company_id = p_company and i.business_channel = 'outros'), false),
    other.company_id, other.last_sale,
    case when ent.first_entry is not null and v_movements_from is not null and reg.registered_at is not null
              and reg.registered_at >= v_movements_from then ent.first_entry
         else reg.registered_at end
  from (select x.omie_product_id, max(nullif(btrim(x.sku), '')) as sku
        from private.stock_current sc join private.stock_positions x on x.reading_id = sc.reading_id
        where sc.company_id = p_company group by x.omie_product_id) sp
  left join lateral (
    select min(s.first_sale) as first_sale, max(s.last_sale) as last_sale
    from pg_temp.stock_sales s where s.omie_product_id = sp.omie_product_id) sl on true
  left join lateral (
    select case when r.payload->'info'->>'dInc' ~ '^\d{2}/\d{2}/\d{4}$'
                then to_date(r.payload->'info'->>'dInc', 'DD/MM/YYYY') end as registered_at
    from public.raw_omie_products r
    where r.company_id = p_company and r.external_id = sp.omie_product_id
    order by r.fetched_at desc limit 1) reg on true
  left join lateral (
    select min(m.moved_on) as first_entry, max(m.moved_on) as last_entry,
      (array_agg(m.operation order by m.moved_on desc, m.movement_id desc))[1] as last_operation,
      (array_agg(m.qty order by m.moved_on desc, m.movement_id desc))[1] as last_qty
    from private.stock_movements m
    where m.company_id = p_company and m.omie_product_id = sp.omie_product_id
      and m.kind = 'entrada' and not m.canceled and stock_internal.is_receipt(m.operation)
      and not exists (select 1 from private.stock_movements r
        where r.company_id = m.company_id and r.omie_product_id = m.omie_product_id and r.kind = 'saida'
          and r.canceled and r.operation = m.operation and r.document = m.document)) ent on true
  left join lateral (
    select max(m.moved_on) as last_exit,
      (array_agg(m.operation order by m.moved_on desc, m.movement_id desc))[1] as last_operation,
      (array_agg(m.document order by m.moved_on desc, m.movement_id desc))[1] as last_document
    from private.stock_movements m
    where m.company_id = p_company and m.omie_product_id = sp.omie_product_id
      and m.kind = 'saida' and not m.canceled and stock_internal.is_exit(m.operation)
      and not exists (select 1 from private.stock_movements r
        where r.company_id = m.company_id and r.omie_product_id = m.omie_product_id and r.kind = 'entrada'
          and r.canceled and r.operation = m.operation and r.document = m.document)) ex on true
  left join lateral (
    select a.company_id, a.last_sale from private.stock_auto_curves a
    join public.companies oc on oc.id = a.company_id and not oc.is_demo
    where sp.sku is not null and sp.sku <> sp.omie_product_id
      and a.curve_window = '12m' and a.company_id <> p_company and a.sku = sp.sku
    order by a.last_sale desc nulls last, a.company_id limit 1) other on true;

  select coalesce(jsonb_object_agg(w.win, jsonb_build_object(
      'revenue', coalesce(t.revenue, 0), 'products', coalesce(t.products, 0),
      'A', coalesce(t.a, 0), 'B', coalesce(t.b, 0), 'C', coalesce(t.c, 0))), '{}'::jsonb)
  into v_totals
  from (values ('30d'), ('90d'), ('180d'), ('12m')) w(win)
  left join (
    select a.curve_window, round(sum(a.revenue), 2) as revenue, count(*) as products,
      count(*) filter (where a.curve = 'A') as a, count(*) filter (where a.curve = 'B') as b,
      count(*) filter (where a.curve = 'C') as c
    from private.stock_auto_curves a where a.company_id = p_company group by a.curve_window) t
    on t.curve_window = w.win;

  insert into private.stock_curve_runs (company_id, status, trigger, as_of, sales_from, reason, totals, started_at, finished_at)
    values (p_company, 'ok', coalesce(p_trigger, 'worker'), v_as_of, v_sales_from,
            case when coalesce(p_force, false) then 'Cálculo forçado pela operação.' end, v_totals, v_started, clock_timestamp());
  delete from private.stock_curve_runs r where r.company_id = p_company and r.finished_at < now() - interval '120 days';
  return jsonb_build_object('status', 'ok', 'asOf', v_as_of, 'salesFrom', v_sales_from, 'totals', v_totals);
end $$;

-- ===================================================================== posição com curva

drop function if exists stock_internal.current_rows(uuid[]);
create or replace function stock_internal.current_rows(p_companies uuid[], p_window text)
returns table (company_id uuid, company_name text, omie_product_id text, location_code text, sku text,
  name text, physical_qty numeric, reserved_qty numeric, pending_qty numeric, min_qty numeric,
  unit_cost numeric, sale_price numeric, curve text, product_id uuid, family text, location_name text,
  read_at timestamptz, curve_source text, curve_reason text, curve_set_at timestamptz, curve_set_by text,
  window_revenue numeric, window_share numeric, product_qty numeric, last_sale date,
  days_without_sale integer, last_entry date, last_entry_operation text, first_entry date,
  registered_at date, is_new boolean, incomplete_reason text, elsewhere_company text,
  elsewhere_last_sale date, curves_as_of date, sales_from date, window_start date, arrived_on date,
  idle_since date, last_exit date, last_exit_operation text, recent_exit boolean, last_exit_group boolean)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with base as (
    select sp.*, c.name as company_name, r.finished_at as read_at, r.locations,
      sum(sp.physical_qty) over (partition by sp.company_id, sp.omie_product_id) as total_qty
    from private.stock_current sc
    join private.stock_readings r on r.id = sc.reading_id
    join private.stock_positions sp on sp.reading_id = sc.reading_id
    join public.companies c on c.id = sc.company_id
    where sc.company_id = any(p_companies)),
  run as (
    select distinct on (cr.company_id) cr.company_id, cr.as_of, cr.sales_from
    from private.stock_curve_runs cr
    where cr.company_id = any(p_companies) and cr.status = 'ok'
    order by cr.company_id, cr.finished_at desc),
  x as (
    select b.*, run.as_of, run.sales_from,
      run.as_of - stock_internal.window_days(p_window) + 1 as win_start,
      cu.curve as manual_curve, cu.reason as manual_reason, cu.updated_at as manual_at,
      pr.full_name as manual_by, ac.curve as auto_curve, ac.revenue as auto_revenue, ac.share as auto_share,
      f.last_sale as f_last_sale, f.last_entry as f_last_entry, f.last_entry_operation as f_last_op,
      f.first_entry as f_first_entry, f.registered_at as f_registered, ec.name as f_elsewhere,
      f.elsewhere_last_sale as f_elsewhere_sale, f.arrived_on as f_arrived,
      f.last_exit as f_last_exit, f.last_exit_operation as f_last_exit_op, f.last_exit_group as f_last_exit_group,
      coalesce(f.arrived_on >= run.as_of - s.new_product_days, false) as fresh,
      p.id as p_id, coalesce(nullif(cp.family, ''), nullif(p.category, '')) as p_family
    from base b
    cross join private.stock_settings s
    left join run on run.company_id = b.company_id
    left join private.stock_curves cu on cu.company_id = b.company_id and cu.omie_product_id = b.omie_product_id
    left join public.profiles pr on pr.id = cu.updated_by
    left join private.stock_auto_curves ac
      on ac.company_id = b.company_id and ac.curve_window = p_window and ac.omie_product_id = b.omie_product_id
    left join private.stock_product_facts f on f.company_id = b.company_id and f.omie_product_id = b.omie_product_id
    left join public.companies ec on ec.id = f.elsewhere_company_id
    left join public.products p
      on p.company_id = b.company_id and p.source = 'omie' and p.external_id = b.omie_product_id
    left join public.canonical_products cp
      on cp.company_id = b.company_id and cp.source = 'omie' and cp.external_id = b.omie_product_id)
  select x.company_id, x.company_name, x.omie_product_id, x.location_code, x.sku, x.name,
    x.physical_qty, x.reserved_qty, x.pending_qty, x.min_qty, x.unit_cost, x.sale_price,
    case when x.manual_curve is not null then x.manual_curve
         when x.auto_curve is not null then x.auto_curve
         when x.as_of is null then 'U'
         when x.total_qty > 0 then 'D'
         else 'U' end,
    x.p_id, x.p_family, nullif(x.locations -> x.location_code ->> 'name', ''), x.read_at,
    case when x.manual_curve is not null then 'manual'
         when x.auto_curve is not null or (x.as_of is not null and x.total_qty > 0) then 'auto' end,
    x.manual_reason, x.manual_at, x.manual_by,
    case when x.as_of is not null then coalesce(x.auto_revenue, 0) end, x.auto_share, x.total_qty,
    x.f_last_sale,
    -- Tempo sem venda: da última venda; quem nunca vendeu no histórico conta da chegada do produto ou
    -- do início do histórico, o que vier depois (produto novo não aparece como parado há meses).
    case when x.as_of is null then null
         when x.f_last_sale is not null then (x.as_of - x.f_last_sale)::integer
         when x.sales_from is null then null
         else (x.as_of - greatest(x.sales_from, coalesce(x.f_arrived, x.sales_from)) + 1)::integer end,
    x.f_last_entry, x.f_last_op, x.f_first_entry, x.f_registered, x.fresh,
    -- Sem venda na janela, mas sem histórico para afirmar isso: vendas do BIOMIE começam depois do
    -- início da janela ('sales') ou o produto chegou/foi cadastrado depois dele ('product').
    case when x.as_of is null or x.auto_curve is not null or x.fresh then null
         when x.sales_from is null or x.win_start < x.sales_from then 'sales'
         when x.f_arrived > x.win_start then 'product' end,
    x.f_elsewhere, x.f_elsewhere_sale, x.as_of, x.sales_from, x.win_start, x.f_arrived,
    case when x.f_last_sale is not null then x.f_last_sale
         when x.sales_from is not null then greatest(x.sales_from, coalesce(x.f_arrived, x.sales_from)) end,
    x.f_last_exit, x.f_last_exit_op,
    -- Saída nos últimos 90 dias (consumo da produção, remessa, ajuste...): o produto gira mesmo sem venda.
    coalesce(x.f_last_exit >= x.as_of - 89, false),
    coalesce(x.f_last_exit_group, false)
  from x
$$;

-- ===================================================================== leitura pela tela

drop function if exists public.stock_overview(text);
drop function if exists stock_internal.overview(text);
create or replace function stock_internal.overview(p_company text, p_window text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_admin boolean := (v_caps->>'refresh')::boolean;
  v_scope uuid[] := stock_internal.scope(p_company);
  v_window text := stock_internal.pick_window(p_window);
  v_stale interval := make_interval(hours => (select s.stale_hours from private.stock_settings s));
  v jsonb;
begin
  with x as (select * from stock_internal.current_rows(v_scope, v_window)),
  t as (
    select count(*)::integer as positions,
      count(*) filter (where x.physical_qty <> 0 or x.reserved_qty <> 0 or x.pending_qty <> 0)::integer as with_stock,
      coalesce(sum(x.physical_qty), 0) as units,
      coalesce(sum(x.physical_qty * x.unit_cost), 0) as cost_value,
      coalesce(sum(x.reserved_qty), 0) as reserved,
      coalesce(sum(x.pending_qty), 0) as pending,
      count(*) filter (where x.physical_qty < 0)::integer as negative,
      count(*) filter (where x.curve = 'U')::integer as unclassified,
      coalesce(sum(x.physical_qty * x.unit_cost) filter (where x.curve = 'U'), 0) as unclassified_cost,
      count(*) filter (where x.min_qty > 0 and x.physical_qty < x.min_qty)::integer as below_min
    from x),
  c as (
    select k.curve, k.ord, count(x.company_id)::integer as positions,
      count(distinct (x.company_id, x.omie_product_id)) filter (where x.company_id is not null)::integer as products,
      coalesce(sum(x.physical_qty), 0) as units, coalesce(sum(x.physical_qty * x.unit_cost), 0) as cost_value
    from unnest(array['A', 'B', 'C', 'D', 'U']) with ordinality as k(curve, ord)
    left join x on x.curve = k.curve
    group by k.curve, k.ord),
  -- Por produto (todos os locais juntos): base da curva D e do tempo sem venda.
  pr as (
    select x.company_id, x.omie_product_id, min(x.curve) as curve, min(x.curve_source) as source,
      sum(x.physical_qty) as qty, sum(x.physical_qty * x.unit_cost) as value,
      bool_or(x.is_new) as is_new, min(x.incomplete_reason) as incomplete_reason,
      bool_or(x.elsewhere_company is not null) as elsewhere, bool_or(x.recent_exit) as moving,
      min(x.last_sale) as last_sale, min(x.curves_as_of) as as_of, min(x.sales_from) as sales_from,
      min(x.days_without_sale) as idle_days, min(x.arrived_on) as arrived_on
    from x group by x.company_id, x.omie_product_id),
  d as (
    select count(*)::integer as products, coalesce(sum(pr.value), 0) as value,
      count(*) filter (where pr.is_new)::integer as new_products,
      coalesce(sum(pr.value) filter (where pr.is_new), 0) as new_value,
      count(*) filter (where not pr.is_new and pr.incomplete_reason is not null)::integer as incomplete_products,
      coalesce(sum(pr.value) filter (where not pr.is_new and pr.incomplete_reason is not null), 0) as incomplete_value,
      count(*) filter (where not pr.is_new and pr.incomplete_reason is null)::integer as confirmed_products,
      coalesce(sum(pr.value) filter (where not pr.is_new and pr.incomplete_reason is null), 0) as confirmed_value,
      count(*) filter (where pr.elsewhere)::integer as elsewhere_products,
      coalesce(sum(pr.value) filter (where pr.elsewhere), 0) as elsewhere_value,
      count(*) filter (where pr.moving)::integer as moving_products,
      coalesce(sum(pr.value) filter (where pr.moving), 0) as moving_value
    from pr where pr.curve = 'D' and pr.qty > 0),
  -- Tempo sem venda (independente da janela): só produtos com saldo positivo e curva calculada.
  ag as (
    select pr.*, pr.idle_days as days, pr.last_sale is null as never
    from pr where pr.qty > 0 and pr.as_of is not null and pr.idle_days is not null),
  agb as (
    select case when ag.days >= 365 then '365' when ag.days >= 180 then '180'
                when ag.days >= 90 then '90' when ag.days >= 30 then '30' end as band, ag.*
    from ag),
  co as (
    select s.id as company_id, cmp.name as company_name, s.ord,
      (select count(*) from x where x.company_id = s.id)::integer as positions,
      (select coalesce(sum(x.physical_qty * x.unit_cost), 0) from x where x.company_id = s.id) as cost_value
    from unnest(v_scope) with ordinality as s(id, ord) join public.companies cmp on cmp.id = s.id),
  cr as (
    select s.id as company_id, s.ord, cmp.name as company_name, ok.as_of, ok.sales_from, ok.finished_at as computed_at,
      lastrun.status as last_status, lastrun.reason as last_reason, lastrun.finished_at as last_at
    from unnest(v_scope) with ordinality as s(id, ord)
    join public.companies cmp on cmp.id = s.id
    left join lateral (select r.as_of, r.sales_from, r.finished_at from private.stock_curve_runs r
      where r.company_id = s.id and r.status = 'ok' order by r.finished_at desc limit 1) ok on true
    left join lateral (select r.status, r.reason, r.finished_at from private.stock_curve_runs r
      where r.company_id = s.id order by r.finished_at desc limit 1) lastrun on true),
  rd as (
    select s.id as company_id, s.ord, cmp.name as company_name, cur.finished_at as read_at,
      cur.records_received as positions, last.status as last_status, last.error as last_error,
      last.finished_at as last_finished,
      exists (select 1 from private.stock_readings q
              where q.company_id = s.id and q.status in ('queued', 'running')) as in_progress
    from unnest(v_scope) with ordinality as s(id, ord)
    join public.companies cmp on cmp.id = s.id
    left join private.stock_current sc on sc.company_id = s.id
    left join private.stock_readings cur on cur.id = sc.reading_id
    left join lateral (
      select l.status, l.error, l.finished_at from private.stock_readings l
      where l.company_id = s.id and l.status in ('complete', 'failed')
      order by coalesce(l.finished_at, l.created_at) desc, l.created_at desc limit 1) last on true)
  select jsonb_build_object(
    'window', v_window,
    'readings', coalesce((select jsonb_agg(jsonb_build_object(
        'companyId', rd.company_id, 'companyName', rd.company_name, 'readAt', rd.read_at,
        'positions', coalesce(rd.positions, 0),
        'status', case
          when rd.last_status = 'failed' and (rd.read_at is null or rd.last_finished > rd.read_at) then 'failed'
          when rd.read_at is null then 'missing'
          when rd.read_at < now() - v_stale then 'stale'
          else 'ok' end,
        'inProgress', rd.in_progress,
        'lastError', case when v_admin and rd.last_status = 'failed' then rd.last_error end)
      order by rd.ord) from rd), '[]'::jsonb),
    'curves', coalesce((select jsonb_agg(jsonb_build_object(
        'companyId', cr.company_id, 'companyName', cr.company_name,
        'status', case when cr.computed_at is null then 'missing'
                       when cr.last_status in ('skipped', 'failed') and cr.last_at > cr.computed_at then cr.last_status
                       else 'ok' end,
        'computedAt', cr.computed_at, 'asOf', cr.as_of, 'salesFrom', cr.sales_from,
        'windowStart', cr.as_of - stock_internal.window_days(v_window) + 1,
        'incompleteHistory', cr.as_of is not null
          and (cr.sales_from is null or cr.as_of - stock_internal.window_days(v_window) + 1 < cr.sales_from),
        'reason', case when cr.last_status in ('skipped', 'failed') and cr.last_at > coalesce(cr.computed_at, '-infinity')
                       then cr.last_reason end)
      order by cr.ord) from cr), '[]'::jsonb),
    'totals', (select jsonb_build_object('positions', t.positions, 'positionsWithStock', t.with_stock,
        'units', t.units, 'costValue', case when v_cost then t.cost_value end,
        'reservedQty', t.reserved, 'pendingQty', t.pending, 'negativePositions', t.negative,
        'unclassifiedPositions', t.unclassified,
        'unclassifiedCostValue', case when v_cost then t.unclassified_cost end,
        'belowMinPositions', t.below_min,
        'manualCurves', (select count(*) from pr where pr.source = 'manual')::integer) from t),
    'byCurve', (select jsonb_agg(jsonb_build_object('curve', c.curve, 'positions', c.positions,
        'products', c.products, 'units', c.units,
        'costValue', case when v_cost then c.cost_value end,
        'share', case when v_cost and t.cost_value > 0 then round(c.cost_value / t.cost_value * 100, 4) end)
      order by c.ord) from c, t),
    'dAnalysis', (select jsonb_build_object('products', d.products,
        'costValue', case when v_cost then d.value end,
        'newProducts', d.new_products, 'newCostValue', case when v_cost then d.new_value end,
        'incompleteProducts', d.incomplete_products,
        'incompleteCostValue', case when v_cost then d.incomplete_value end,
        'confirmedProducts', d.confirmed_products,
        'confirmedCostValue', case when v_cost then d.confirmed_value end,
        'elsewhereProducts', d.elsewhere_products,
        'elsewhereCostValue', case when v_cost then d.elsewhere_value end,
        'movingProducts', d.moving_products,
        'movingCostValue', case when v_cost then d.moving_value end) from d),
    'aging', (select jsonb_agg(jsonb_build_object('band', k.band, 'products', coalesce(a.products, 0),
        'costValue', case when v_cost then coalesce(a.value, 0) end,
        'newProducts', coalesce(a.new_products, 0), 'incompleteProducts', coalesce(a.incomplete_products, 0))
      order by k.ord)
      from unnest(array['30', '90', '180', '365']) with ordinality as k(band, ord)
      left join (
        select agb.band, count(*)::integer as products, sum(agb.value) as value,
          count(*) filter (where agb.is_new)::integer as new_products,
          -- Nunca vendeu e já estava no estoque antes do histórico começar (mais curto que 12 meses):
          -- o tempo real sem venda pode ser maior do que o histórico mostra.
          count(*) filter (where not agb.is_new and agb.never and agb.days < 365
                           and (agb.arrived_on is null or agb.arrived_on < agb.sales_from))::integer
            as incomplete_products
        from agb where agb.band is not null group by agb.band) a on a.band = k.band),
    'byCompany', coalesce((select jsonb_agg(jsonb_build_object('companyId', co.company_id,
        'companyName', co.company_name, 'positions', co.positions,
        'costValue', case when v_cost then co.cost_value end) order by co.ord) from co), '[]'::jsonb))
  into v;
  return v;
end $$;

create or replace function stock_internal.positions(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_scope uuid[] := stock_internal.scope(p_query->>'companyId');
  v_window text := stock_internal.pick_window(nullif(p_query->>'window', ''));
  v_view text := coalesce(nullif(p_query->>'view', ''), 'position');
  v_search text := nullif(stock_internal.fold(btrim(coalesce(p_query->>'search', ''))), '');
  v_curve text := coalesce(nullif(p_query->>'curve', ''), 'all');
  v_location text := nullif(p_query->>'locationCode', '');
  v_family text := nullif(p_query->>'family', '');
  v_negative boolean := coalesce((p_query->>'onlyNegative')::boolean, false);
  v_hide_zero boolean := coalesce((p_query->>'hideZero')::boolean, false);
  v_below_min boolean := coalesce((p_query->>'belowMin')::boolean, false);
  v_new boolean := coalesce((p_query->>'onlyNew')::boolean, false);
  v_incomplete boolean := coalesce((p_query->>'onlyIncomplete')::boolean, false);
  v_elsewhere boolean := coalesce((p_query->>'soldElsewhere')::boolean, false);
  v_manual boolean := coalesce((p_query->>'onlyManual')::boolean, false);
  v_confirmed boolean := coalesce((p_query->>'onlyConfirmed')::boolean, false);
  v_moving boolean := coalesce((p_query->>'recentExit')::boolean, false);
  v_min_days integer := nullif(p_query->>'minDaysWithoutSale', '')::integer;
  v_product text := nullif(p_query->>'productId', '');
  v_sort text := coalesce(nullif(p_query->>'sortBy', ''), 'costValue');
  v_dir text := coalesce(nullif(p_query->>'sortDir', ''), 'desc');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_total integer;
  v_rows jsonb;
begin
  if v_curve not in ('all', 'A', 'B', 'C', 'D', 'U')
     or v_sort not in ('costValue', 'physicalQty', 'name', 'sku', 'lastSale', 'daysWithoutSale', 'windowRevenue')
     or v_dir not in ('asc', 'desc') or v_view not in ('position', 'product')
     or v_page < -1 or v_page > 1000
     or (v_min_days is not null and v_min_days not in (30, 90, 180, 365))
     or char_length(coalesce(v_search, '')) > 120 then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  -- page = -1: todas as linhas do filtro, só para exportação.
  if v_page = -1 then perform stock_internal.require('export'); end if;
  -- Sem acesso a custo, a ordem por valor (ou faturamento) vira nome em ordem alfabética.
  if v_sort in ('costValue', 'windowRevenue') and not v_cost then
    v_sort := 'name';
    v_dir := 'asc';
  end if;

  with x as (
    select r.*, r.physical_qty * r.unit_cost as cost_value,
      case when v_view = 'product' then '*' else r.location_code end as loc_key
    from stock_internal.current_rows(v_scope, v_window) r
    where (v_search is null or strpos(stock_internal.fold(r.name || ' ' || r.sku), v_search) > 0)
      and (v_curve = 'all' or r.curve = v_curve)
      and (v_location is null or r.location_code = v_location)
      and (v_family is null or r.family = v_family)
      and (not v_negative or r.physical_qty < 0)
      and (not v_hide_zero or r.physical_qty <> 0 or r.reserved_qty <> 0 or r.pending_qty <> 0)
      and (not v_below_min or (r.min_qty > 0 and r.physical_qty < r.min_qty))
      and (not v_new or r.is_new)
      and (not v_incomplete or r.incomplete_reason is not null)
      and (not v_elsewhere or r.elsewhere_company is not null)
      and (not v_manual or r.curve_source = 'manual')
      and (not v_moving or r.recent_exit)
      -- Sem venda confirmada: sem venda na janela, com histórico suficiente e não é produto novo.
      and (not v_confirmed or (r.product_qty > 0 and r.curves_as_of is not null and r.window_revenue = 0
           and not r.is_new and r.incomplete_reason is null))
      and (v_min_days is null or (r.product_qty > 0 and r.curves_as_of is not null
           and r.days_without_sale >= v_min_days))
      and (v_product is null or r.product_id::text = v_product)),
  -- Visão por produto: todos os locais somados (a curva é do produto na empresa).
  g as (
    select x.company_id::text || ':' || x.omie_product_id || ':' || x.loc_key as id,
      x.company_id, min(x.company_name) as company_name, min(x.product_id::text) as product_id,
      x.omie_product_id, min(x.sku) as sku, min(x.name) as name, min(x.family) as family,
      x.loc_key as location_code,
      case when v_view = 'product' then null else min(x.location_name) end as location_name,
      count(*)::integer as locations, min(x.curve) as curve, min(x.curve_source) as curve_source,
      min(x.curve_reason) as curve_reason, min(x.curve_set_at) as curve_set_at, min(x.curve_set_by) as curve_set_by,
      sum(x.physical_qty) as physical_qty, sum(x.reserved_qty) as reserved_qty, sum(x.pending_qty) as pending_qty,
      case when v_view = 'product' then null else min(x.min_qty) end as min_qty,
      case when sum(x.physical_qty) <> 0 then sum(x.cost_value) / sum(x.physical_qty) else max(x.unit_cost) end as unit_cost,
      sum(x.cost_value) as cost_value, max(x.sale_price) as sale_price,
      min(x.window_revenue) as window_revenue, min(x.window_share) as window_share, min(x.product_qty) as product_qty,
      min(x.last_sale) as last_sale, min(x.days_without_sale) as days_without_sale,
      min(x.last_entry) as last_entry, min(x.last_entry_operation) as last_entry_operation,
      min(x.first_entry) as first_entry, min(x.registered_at) as registered_at, min(x.arrived_on) as arrived_on,
      bool_or(x.is_new) as is_new, min(x.incomplete_reason) as incomplete_reason,
      min(x.elsewhere_company) as elsewhere_company, min(x.elsewhere_last_sale) as elsewhere_last_sale,
      min(x.sales_from) as sales_from, min(x.idle_since) as idle_since,
      min(x.last_exit) as last_exit, min(x.last_exit_operation) as last_exit_operation,
      bool_or(x.recent_exit) as recent_exit, bool_or(x.last_exit_group) as last_exit_group
    from x
    group by x.company_id, x.omie_product_id, x.loc_key),
  o as (
    select g.*, count(*) over () as total_count,
      row_number() over (order by
        case when v_dir = 'asc' then case v_sort when 'costValue' then g.cost_value
          when 'physicalQty' then g.physical_qty when 'windowRevenue' then g.window_revenue
          when 'daysWithoutSale' then coalesce(g.days_without_sale, 100000) end end asc nulls last,
        case when v_dir = 'desc' then case v_sort when 'costValue' then g.cost_value
          when 'physicalQty' then g.physical_qty when 'windowRevenue' then g.window_revenue
          when 'daysWithoutSale' then coalesce(g.days_without_sale, 100000) end end desc nulls last,
        case when v_dir = 'asc' and v_sort = 'lastSale' then g.last_sale end asc nulls first,
        case when v_dir = 'desc' and v_sort = 'lastSale' then g.last_sale end desc nulls last,
        case when v_dir = 'asc' then case v_sort when 'name' then g.name when 'sku' then g.sku end end asc,
        case when v_dir = 'desc' then case v_sort when 'name' then g.name when 'sku' then g.sku end end desc,
        g.name, g.sku, g.company_name, g.location_code) as rn
    from g)
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'companyId', o.company_id, 'companyName', o.company_name, 'productId', o.product_id,
      'omieProductId', o.omie_product_id, 'sku', o.sku, 'name', o.name, 'family', o.family,
      'locationCode', o.location_code, 'locationName', o.location_name, 'locations', o.locations,
      'curve', o.curve, 'curveSource', o.curve_source, 'curveReason', o.curve_reason,
      'curveSetAt', o.curve_set_at, 'curveSetBy', o.curve_set_by,
      'physicalQty', o.physical_qty, 'reservedQty', o.reserved_qty, 'pendingQty', o.pending_qty,
      'minQty', o.min_qty, 'productQty', o.product_qty,
      'unitCost', case when v_cost then o.unit_cost end,
      'costValue', case when v_cost then o.cost_value end,
      'salePrice', case when v_cost then o.sale_price end,
      'windowRevenue', case when v_cost then o.window_revenue end,
      'windowShare', case when v_cost then o.window_share end,
      'lastSale', o.last_sale, 'daysWithoutSale', o.days_without_sale, 'salesFrom', o.sales_from,
      'idleSince', o.idle_since, 'lastExit', o.last_exit, 'lastExitOperation', o.last_exit_operation,
      'recentExit', o.recent_exit, 'lastExitGroup', o.last_exit_group,
      'lastEntry', o.last_entry, 'lastEntryOperation', o.last_entry_operation, 'firstEntry', o.first_entry,
      'registeredAt', o.registered_at, 'arrivedOn', o.arrived_on, 'isNew', o.is_new,
      'incompleteHistory', o.incomplete_reason,
      'soldElsewhere', case when o.elsewhere_company is not null then
        jsonb_build_object('companyName', o.elsewhere_company, 'lastSale', o.elsewhere_last_sale) end)
      order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 100 and o.rn <= (v_page + 1) * 100)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  if v_page = -1 and v_total > 20000 then
    raise exception 'A exportação vai até 20.000 linhas. Refine os filtros.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'window', v_window, 'view', v_view);
end $$;

create or replace function stock_internal.filter_options(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_scope uuid[] := stock_internal.scope(p_company);
  v jsonb;
begin
  with x as (select * from stock_internal.current_rows(v_scope, stock_internal.pick_window(null))),
  l as (select x.location_code as code, max(x.location_name) as name from x group by x.location_code)
  select jsonb_build_object(
    'locations', coalesce((select jsonb_agg(jsonb_build_object('code', l.code, 'name', l.name)
      order by coalesce(l.name, l.code)) from l), '[]'::jsonb),
    'families', coalesce((select jsonb_agg(f.family order by f.family)
      from (select distinct x.family from x where x.family is not null) f), '[]'::jsonb),
    'defaultWindow', stock_internal.pick_window(null))
  into v;
  return v;
end $$;

drop function if exists public.stock_simulation_base(text);
drop function if exists stock_internal.simulation_base(text);
create or replace function stock_internal.simulation_base(p_company text, p_window text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('viewCost');
  v_scope uuid[] := stock_internal.scope(p_company);
  v_window text := stock_internal.pick_window(p_window);
  v jsonb;
begin
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', r.company_id::text || ':' || r.omie_product_id || ':' || r.location_code,
      'sku', r.sku, 'name', r.name, 'curve', r.curve, 'qty', r.physical_qty, 'cost', r.unit_cost,
      'price', r.sale_price, 'companyName', r.company_name, 'locationName', coalesce(r.location_name, r.location_code))
      order by r.company_name, r.name, r.sku, r.location_code), '[]'::jsonb),
    'readAt', min(r.read_at), 'window', v_window)
  into v
  from stock_internal.current_rows(v_scope, v_window) r;
  return v;
end $$;

-- ===================================================================== curva manual

-- A curva vale para o produto inteiro na empresa: todos os locais mudam juntos. Manual exige
-- justificativa; 'AUTO' (ou 'U', o valor das telas antigas) volta para a curva automática.
drop function if exists public.stock_set_curve(text[], text);
drop function if exists stock_internal.set_curve(text[], text);
create or replace function stock_internal.set_curve(p_position_ids text[], p_curve text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
  set client_min_messages = warning as $$
declare
  v_caps jsonb := stock_internal.require('classify');
  v_scope uuid[] := stock_internal.scope('all');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_auto boolean := p_curve in ('AUTO', 'U');
  v_bad integer;
  v_updated integer;
  v_company record;
begin
  if p_curve is null or p_curve not in ('A', 'B', 'C', 'D', 'AUTO', 'U')
     or coalesce(cardinality(p_position_ids), 0) = 0 or cardinality(p_position_ids) > 5000 then
    raise exception 'Selecione posições válidas e uma curva.' using errcode = 'P0001';
  end if;
  if char_length(coalesce(v_reason, '')) > 300 then
    raise exception 'A justificativa vai até 300 caracteres.' using errcode = 'P0001';
  end if;
  if not v_auto and char_length(coalesce(v_reason, '')) < 10 then
    raise exception 'Informe a justificativa da curva manual (pelo menos 10 caracteres).' using errcode = 'P0001';
  end if;
  create temporary table if not exists pg_temp.stock_sel (company_id uuid, omie_product_id text) on commit drop;
  delete from pg_temp.stock_sel;
  select count(*) into v_bad from unnest(p_position_ids) x
    where x !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[^:]+:[^:]+$';
  if v_bad > 0 then
    raise exception 'Selecione posições válidas e uma curva.' using errcode = 'P0001';
  end if;
  insert into pg_temp.stock_sel
    select distinct split_part(x, ':', 1)::uuid, split_part(x, ':', 2) from unnest(p_position_ids) x;
  -- Toda posição (ou produto, com local '*') precisa existir na leitura publicada de uma empresa do usuário.
  select count(*) into v_bad from unnest(p_position_ids) x
    where not exists (select 1 from private.stock_current sc
      join private.stock_positions sp on sp.reading_id = sc.reading_id
      where sc.company_id = split_part(x, ':', 1)::uuid and sc.company_id = any(v_scope)
        and sp.omie_product_id = split_part(x, ':', 2)
        and (split_part(x, ':', 3) = '*' or sp.location_code = split_part(x, ':', 3)));
  if v_bad > 0 then
    raise exception 'Selecione posições válidas e uma curva.' using errcode = 'P0001';
  end if;
  if v_auto then
    delete from private.stock_curves c using pg_temp.stock_sel s
      where c.company_id = s.company_id and c.omie_product_id = s.omie_product_id;
  else
    insert into private.stock_curves (company_id, omie_product_id, curve, reason, updated_at, updated_by)
      select s.company_id, s.omie_product_id, p_curve, v_reason, now(), auth.uid() from pg_temp.stock_sel s
      on conflict (company_id, omie_product_id) do update
        set curve = excluded.curve, reason = excluded.reason, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by;
  end if;
  select count(*) into v_updated from private.stock_current sc
    join private.stock_positions sp on sp.reading_id = sc.reading_id
    join pg_temp.stock_sel s on s.company_id = sp.company_id and s.omie_product_id = sp.omie_product_id;
  for v_company in
    select s.company_id, count(*) as products,
      (array_agg(s.omie_product_id order by s.omie_product_id))[1:50] as sample
    from pg_temp.stock_sel s group by s.company_id
  loop
    perform stock_internal.log('stock.curve.changed', v_company.company_id,
      jsonb_build_object('curva', case when v_auto then 'Automática' else p_curve end,
        'produtos', v_company.products, 'amostra', to_jsonb(v_company.sample), 'justificativa', v_reason));
  end loop;
  return jsonb_build_object('updated', v_updated);
end $$;

-- ===================================================================== administração

create or replace function stock_internal.admin_settings() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v jsonb;
begin
  perform stock_internal.require_super();
  select jsonb_build_object('mode', stock_internal.mode(), 'readingEnabled', s.reading_enabled,
    'slots', to_jsonb(s.slots), 'closeSlot', s.close_slot, 'manualMinMinutes', s.manual_min_minutes,
    'staleHours', s.stale_hours, 'curveWindow', s.curve_window, 'curveLimits',
    jsonb_build_array(s.curve_a_limit, s.curve_b_limit), 'newProductDays', s.new_product_days,
    'movementsEnabled', s.movements_enabled) into v from private.stock_settings s;
  return v;
end $$;

-- ===================================================================== worker (apenas service_role)

create or replace function public.stock_worker_settings() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('readingEnabled', s.reading_enabled, 'slots', to_jsonb(s.slots),
    'closeSlot', s.close_slot, 'movementsEnabled', s.movements_enabled) from private.stock_settings s
$$;

create or replace function public.stock_worker_refresh_curves(p_company uuid) returns jsonb
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select stock_internal.refresh_curves(p_company, 'worker', false)
$$;

-- Falha do cálculo (a transação dele já desfez tudo): só registra, as curvas anteriores ficam.
create or replace function public.stock_worker_curve_failed(p_company uuid, p_error text) returns void
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  insert into private.stock_curve_runs (company_id, status, trigger, as_of, reason)
  select c.id, 'failed', 'worker', stock_internal.as_of(),
    left(coalesce(nullif(p_error, ''), 'Falha no cálculo das curvas.'), 500)
  from public.companies c where c.id = p_company and not c.is_demo
$$;

-- Leituras de estoque agendadas (como na 0041) e, com as movimentações ligadas, a fila delas:
-- carga inicial em blocos (até movements_days atrás) e, depois, a atualização dos últimos dias.
create or replace function public.stock_worker_enqueue(p_slot text, p_kind text, p_position_date date)
returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_count integer := 0;
  v_company uuid;
  v_settings private.stock_settings;
  v_yesterday date := p_position_date - 1;
  v_covered date;
  v_from date;
begin
  if p_slot is null or p_kind not in ('intraday', 'close') or p_position_date is null then
    raise exception 'pedido de leitura inválido';
  end if;
  select * into v_settings from private.stock_settings;
  if not v_settings.reading_enabled then return 0; end if;
  for v_company in
    select ci.company_id from public.company_integrations ci join public.companies c on c.id = ci.company_id
    where ci.provider = 'omie' and ci.status = 'CONNECTED' and not c.is_demo
      and c.data_source in ('OMIE', 'OMIE_SHADOW')
    order by c.name
  loop
    if not exists (select 1 from private.stock_readings r
                   where r.company_id = v_company and r.status in ('queued', 'running')) then
      insert into private.stock_readings (company_id, kind, trigger, slot, status, position_date)
        values (v_company, p_kind, 'schedule', p_slot, 'queued', p_position_date)
        on conflict (company_id, slot) where slot is not null do nothing;
      if found then v_count := v_count + 1; end if;
    end if;
    continue when not v_settings.movements_enabled
      or exists (select 1 from private.stock_movement_jobs j
                 where j.company_id = v_company and j.status in ('queued', 'running'));
    select max(j.period_to) into v_covered from private.stock_movement_jobs j
      where j.company_id = v_company and j.status = 'complete';
    if not exists (select 1 from private.stock_movement_jobs j
                   where j.company_id = v_company and j.trigger = 'backfill') then
      -- Carga inicial: blocos de movements_chunk_days, do mais antigo para ontem.
      v_from := v_yesterday - v_settings.movements_days + 1;
      while v_from <= v_yesterday loop
        insert into private.stock_movement_jobs (company_id, trigger, period_from, period_to)
          values (v_company, 'backfill', v_from,
                  least(v_from + v_settings.movements_chunk_days - 1, v_yesterday));
        v_from := v_from + v_settings.movements_chunk_days;
      end loop;
    elsif v_covered < v_yesterday then
      -- Atualização: relê 3 dias para pegar cancelamentos e lançamentos atrasados.
      insert into private.stock_movement_jobs (company_id, trigger, period_from, period_to)
        values (v_company, 'delta', greatest(v_covered - 3, v_yesterday - 30), v_yesterday);
    end if;
  end loop;
  return v_count;
end $$;

create or replace function public.stock_worker_movements_claim() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_job private.stock_movement_jobs;
begin
  -- Parada de mais de 30 min sem avançar: continua da página seguinte (o salvamento é idempotente).
  update private.stock_movement_jobs set status = 'queued', next_attempt_at = null
    where status = 'running' and coalesce(progress_at, started_at) < now() - interval '30 minutes';
  select * into v_job from private.stock_movement_jobs j
    where j.status in ('queued', 'running') and (j.next_attempt_at is null or j.next_attempt_at <= now())
    order by (j.status = 'running') desc, j.created_at, j.period_from
    limit 1 for update skip locked;
  if not found then return null; end if;
  if v_job.attempts >= 6 and v_job.pages_done = 0 then
    update private.stock_movement_jobs set status = 'failed', finished_at = now(),
        error = coalesce(error, 'Leitura de movimentações abandonada após 6 tentativas.')
      where id = v_job.id;
    return null;
  end if;
  update private.stock_movement_jobs set status = 'running', started_at = coalesce(started_at, now()),
      progress_at = coalesce(progress_at, now()),
      attempts = attempts + case when pages_done = 0 then 1 else 0 end, next_attempt_at = null
    where id = v_job.id returning * into v_job;
  return jsonb_build_object('id', v_job.id, 'companyId', v_job.company_id,
    'from', to_char(v_job.period_from, 'DD/MM/YYYY'), 'to', to_char(v_job.period_to, 'DD/MM/YYYY'),
    'nextPage', v_job.pages_done + 1, 'pagesTotal', v_job.pages_total);
end $$;

create or replace function public.stock_worker_movements_save_page(p_job uuid, p_page integer, p_pages_total integer,
  p_records_total integer, p_rows jsonb, p_skipped integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_job private.stock_movement_jobs;
  v_saved integer;
begin
  select * into v_job from private.stock_movement_jobs where id = p_job for update;
  if not found or v_job.status <> 'running' then raise exception 'leitura de movimentações não está em andamento'; end if;
  if p_page is null or p_page <> v_job.pages_done + 1 or p_pages_total is null or p_pages_total < 0
     or p_records_total is null or p_records_total < 0 or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'página de movimentações inválida (recebida %, esperada %)', p_page, v_job.pages_done + 1;
  end if;
  -- Total que muda no meio (lançamentos novos no período): recomeça da primeira página; o que já foi
  -- salvo continua valendo, porque cada movimento é gravado pelo seu identificador no Omie.
  if v_job.records_expected is not null and v_job.records_expected <> p_records_total then
    update private.stock_movement_jobs set pages_done = 0, pages_total = null, records_expected = null,
        progress_at = clock_timestamp() where id = p_job;
    return jsonb_build_object('restarted', true, 'done', false);
  end if;
  insert into private.stock_movements (company_id, movement_id, moved_on, kind, operation, origin, canceled,
      is_return, omie_product_id, location_code, qty, unit_cost, value, document, saved_at)
    select v_job.company_id, x.movement_id, x.moved_on, x.kind, x.operation, x.origin, coalesce(x.canceled, false),
      coalesce(x.is_return, false), x.omie_product_id, x.location_code, x.qty, x.unit_cost, x.value, x.document,
      clock_timestamp()
    from jsonb_to_recordset(p_rows) as x(movement_id bigint, moved_on date, kind text, operation text, origin text,
      canceled boolean, is_return boolean, omie_product_id text, location_code text, qty numeric,
      unit_cost numeric, value numeric, document text)
    on conflict (company_id, movement_id) do update set moved_on = excluded.moved_on, kind = excluded.kind,
      operation = excluded.operation, origin = excluded.origin, canceled = excluded.canceled,
      is_return = excluded.is_return, omie_product_id = excluded.omie_product_id,
      location_code = excluded.location_code, qty = excluded.qty, unit_cost = excluded.unit_cost,
      value = excluded.value, document = excluded.document, saved_at = excluded.saved_at;
  get diagnostics v_saved = row_count;
  update private.stock_movement_jobs set pages_done = p_page, pages_total = p_pages_total,
      records_expected = p_records_total, records_saved = records_saved + v_saved,
      records_skipped = records_skipped + greatest(coalesce(p_skipped, 0), 0), progress_at = clock_timestamp()
    where id = p_job;
  return jsonb_build_object('restarted', false, 'saved', v_saved, 'done', p_page >= p_pages_total);
end $$;

create or replace function public.stock_worker_movements_finish(p_job uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_job private.stock_movement_jobs;
begin
  update private.stock_movement_jobs set status = 'complete', finished_at = clock_timestamp(), error = null,
      next_attempt_at = null
    where id = p_job and status = 'running' returning * into v_job;
  if not found then raise exception 'leitura de movimentações não está em andamento'; end if;
  -- Recalcula as curvas quando não sobra outro bloco da empresa na fila (fim da carga ou atualização).
  return jsonb_build_object('companyId', v_job.company_id, 'records', v_job.records_saved,
    'lastOfCompany', not exists (select 1 from private.stock_movement_jobs j
                                 where j.company_id = v_job.company_id and j.status in ('queued', 'running')));
end $$;

create or replace function public.stock_worker_movements_fail(p_job uuid, p_error text, p_retry_after_seconds integer,
  p_final boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_job private.stock_movement_jobs;
begin
  select * into v_job from private.stock_movement_jobs where id = p_job for update;
  if not found or v_job.status not in ('running', 'queued') then return jsonb_build_object('ok', false); end if;
  if coalesce(p_final, false) then
    update private.stock_movement_jobs set status = 'failed', finished_at = clock_timestamp(), next_attempt_at = null,
        error = left(coalesce(nullif(p_error, ''), 'Falha na leitura das movimentações.'), 500)
      where id = p_job;
    return jsonb_build_object('ok', true, 'final', true);
  end if;
  update private.stock_movement_jobs set status = 'queued',
      error = left(coalesce(nullif(p_error, ''), 'Falha na leitura das movimentações.'), 500),
      next_attempt_at = now() + make_interval(secs => greatest(30, least(coalesce(p_retry_after_seconds, 300), 3600)))
    where id = p_job;
  return jsonb_build_object('ok', true, 'final', false);
end $$;

-- ===================================================================== pontos de entrada

create or replace function public.stock_overview(p_company text, p_window text default null) returns jsonb
language sql stable as $$ select stock_internal.overview(p_company, p_window) $$;
create or replace function public.stock_simulation_base(p_company text, p_window text default null) returns jsonb
language sql stable as $$ select stock_internal.simulation_base(p_company, p_window) $$;
create or replace function public.stock_set_curve(p_position_ids text[], p_curve text, p_reason text default null)
returns jsonb language sql as $$ select stock_internal.set_curve(p_position_ids, p_curve, p_reason) $$;

revoke all on all functions in schema stock_internal from public, anon, authenticated;
grant execute on function stock_internal.require(text), stock_internal.overview(text, text),
  stock_internal.positions(jsonb), stock_internal.filter_options(text), stock_internal.simulation_base(text, text),
  stock_internal.set_curve(text[], text, text), stock_internal.scenarios(), stock_internal.save_scenario(jsonb),
  stock_internal.delete_scenario(uuid), stock_internal.request_refresh(text), stock_internal.features(),
  stock_internal.admin_settings(), stock_internal.admin_set_mode(text), stock_internal.admin_set_reading(boolean)
to authenticated;

revoke all on function public.stock_overview(text, text), public.stock_simulation_base(text, text),
  public.stock_set_curve(text[], text, text) from public, anon;
grant execute on function public.stock_overview(text, text), public.stock_simulation_base(text, text),
  public.stock_set_curve(text[], text, text) to authenticated;

revoke all on function public.stock_worker_settings(), public.stock_worker_enqueue(text, text, date),
  public.stock_worker_refresh_curves(uuid), public.stock_worker_curve_failed(uuid, text),
  public.stock_worker_movements_claim(), public.stock_worker_movements_save_page(uuid, integer, integer, integer, jsonb, integer),
  public.stock_worker_movements_finish(uuid), public.stock_worker_movements_fail(uuid, text, integer, boolean)
from public, anon, authenticated;
grant execute on function public.stock_worker_settings(), public.stock_worker_enqueue(text, text, date),
  public.stock_worker_refresh_curves(uuid), public.stock_worker_curve_failed(uuid, text),
  public.stock_worker_movements_claim(), public.stock_worker_movements_save_page(uuid, integer, integer, integer, jsonb, integer),
  public.stock_worker_movements_finish(uuid), public.stock_worker_movements_fail(uuid, text, integer, boolean)
to service_role;

notify pgrst, 'reload schema';
