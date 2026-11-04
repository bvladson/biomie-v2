-- Plano de Voo v2 (04/11/2026): os cinco pilares (Destino, Rota, Velocidade, Painel, Correção de rota).
--
-- Só acréscimos. A única mudança em dado existente é o canal do cadastro dos vendedores das empresas
-- reais, preenchido pela regra oficial (vendedor "Licitação" = licitação, demais = varejo; aprovada em
-- 29/09/2026 e usada nas notas desde a 0031). Estava vazio em todos, e todo filtro de canal que olhava o
-- vendedor (Plano de Voo, meta do Cockpit, lista de vendedores) devolvia zero vendedores.
--
-- Leitura: funções SECURITY INVOKER (a RLS vale). Escrita: só por flight_plan_internal (SECURITY DEFINER,
-- esquema fora da API), chamadas por wrappers SECURITY INVOKER no public; permissão conferida linha a
-- linha e cada alteração vai para o audit_log. A release anterior não usa nada daqui.

-- ============ 1. Canal oficial do vendedor ============
create or replace function public.seller_official_channel(p_company uuid, p_name text, p_external_id text)
returns text language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case
    when public.normalize_text(p_name) = 'licitacao' then 'licitacao'
    when p_external_id is not null and exists (
      select 1 from private.legacy_classification_config l
      where l.company_id = p_company
        and coalesce(l.settings->'licitacao_seller_codes', '[]'::jsonb) ? p_external_id) then 'licitacao'
    else 'varejo' end
$$;
revoke all on function public.seller_official_channel(uuid, text, text) from public, anon;
grant execute on function public.seller_official_channel(uuid, text, text) to authenticated, service_role;

-- Toda empresa real tem as três dimensões de canal (empresas criadas depois da 0031 também).
insert into public.channels(company_id, name)
  select c.id, ch.name from public.companies c cross join (values ('varejo'), ('licitacao'), ('outros')) ch(name)
  where not c.is_demo
    and not exists (select 1 from public.channels x where x.company_id = c.id and lower(x.name) = ch.name);

create or replace function public.apply_seller_official_channel()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from public.companies c where c.id = new.company_id and not c.is_demo) then
    new.channel_id := (
      select ch.id from public.channels ch
      where ch.company_id = new.company_id
        and lower(ch.name) = public.seller_official_channel(new.company_id, new.name, new.external_id)
      order by ch.id limit 1);
  end if;
  return new;
end $$;
revoke all on function public.apply_seller_official_channel() from public, anon, authenticated, service_role;
drop trigger if exists zz_sellers_official_channel on public.sellers;
create trigger zz_sellers_official_channel before insert or update of name, external_id, company_id, channel_id
  on public.sellers for each row execute function public.apply_seller_official_channel();

update public.sellers s set channel_id = (
    select ch.id from public.channels ch
    where ch.company_id = s.company_id
      and lower(ch.name) = public.seller_official_channel(s.company_id, s.name, s.external_id)
    order by ch.id limit 1)
  where exists (select 1 from public.companies c where c.id = s.company_id and not c.is_demo);

-- ============ 2. Configuração (chaves novas; as existentes prevalecem) ============
update public.metric_config set
  config = jsonb_build_object(
    'saturdayWeights', jsonb_build_object('mag-filial', 0.33, 'uni-design', 0.33),
    'saturdayWeightDefault', 0,
    'lateOrderWeight', 0.3,
    'alerts', jsonb_build_object('lowCoverage', 0.5, 'paceAcceleration', 0.2, 'staleQuoteDays', 15, 'idleSellerWorkdays', 5),
    'conversion', jsonb_build_object(
      'since', to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'), 'minDays', 60, 'minResolved', 20),
    'targetLists', jsonb_build_object('inactiveDays', 90, 'lookbackDays', 365, 'maxItems', 200)
  ) || config,
  version = version + 1,
  updated_at = now()
where metric_key = 'flight_plan';

-- ============ 3. Metas: uma por vendedor/empresa, mês e nível ============
alter table public.sales_targets
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;
create unique index if not exists sales_targets_one_active
  on public.sales_targets (company_id, seller_id, year, month, level) where active and seller_id is not null;
create unique index if not exists sales_targets_one_company
  on public.sales_targets (company_id, coalesce(channel_id, '00000000-0000-0000-0000-000000000000'::uuid), year, month, level)
  where active and seller_id is null;
alter table public.sales_targets drop constraint if exists sales_targets_values_check;
alter table public.sales_targets add constraint sales_targets_values_check
  check (amount >= 0 and month between 1 and 12 and year between 2000 and 2100) not valid;

-- ============ 4. Tabelas novas ============
create table if not exists public.flight_plan_initiatives (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  year int not null check (year between 2000 and 2100),
  month int not null check (month between 1 and 12),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  lever text not null check (lever in ('CONVERT_QUOTES','REACTIVATE_CUSTOMERS','EXPAND_MIX','PRODUCT_CAMPAIGN',
    'PUBLIC_BIDS','PROSPECTING','OTHER')),
  owner_user_id uuid references public.profiles(id) on delete set null,
  owner_seller_id uuid references public.sellers(id) on delete set null,
  owner_name text not null,
  seller_ids uuid[] not null default '{}',
  due_date date not null,
  expected_amount numeric(14,2) not null check (expected_amount > 0),
  realized_amount numeric(14,2) check (realized_amount >= 0),
  status text not null default 'PLANNED' check (status in ('PLANNED','IN_PROGRESS','DONE','CANCELLED')),
  alert_key text check (char_length(alert_key) <= 200),
  target_list_kind text check (target_list_kind in ('OPEN_QUOTES','INACTIVE_CUSTOMERS','LATE_ORDERS','IDLE_STOCK')),
  notes text check (char_length(notes) <= 1000),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create index if not exists flight_plan_initiatives_period on public.flight_plan_initiatives (company_id, year, month);

create table if not exists public.flight_plan_alert_states (
  company_id uuid not null references public.companies(id) on delete cascade,
  alert_key text not null check (char_length(alert_key) <= 200),
  subject text not null check (char_length(subject) <= 120),
  year int not null check (year between 2000 and 2100),
  month int not null check (month between 1 and 12),
  seller_id uuid references public.sellers(id) on delete cascade,
  state text not null default 'OPEN' check (state in ('OPEN','ACKNOWLEDGED','ACTION_CREATED','RESOLVED')),
  priority int check (priority between 1 and 3),
  message text check (char_length(message) <= 300),
  evidence text check (char_length(evidence) <= 500),
  note text check (char_length(note) <= 1000),
  initiative_id uuid references public.flight_plan_initiatives(id) on delete set null,
  first_seen date,
  last_seen date,
  absent_since date,
  reopened boolean not null default false,
  updated_by uuid,
  updated_at timestamptz,
  primary key (company_id, alert_key)
);
create index if not exists flight_plan_alert_states_period on public.flight_plan_alert_states (company_id, year, month);

create table if not exists public.flight_plan_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  week_start date not null,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  author_id uuid default auth.uid(),
  author_name text,
  created_at timestamptz not null default now()
);
create index if not exists flight_plan_decisions_week on public.flight_plan_decisions (company_id, week_start);

alter table public.flight_plan_initiatives enable row level security;
alter table public.flight_plan_alert_states enable row level security;
alter table public.flight_plan_decisions enable row level security;
revoke all on public.flight_plan_initiatives, public.flight_plan_alert_states, public.flight_plan_decisions
  from public, anon, authenticated;
grant select on public.flight_plan_initiatives, public.flight_plan_alert_states, public.flight_plan_decisions to authenticated;
grant all on public.flight_plan_initiatives, public.flight_plan_alert_states, public.flight_plan_decisions to service_role;

drop policy if exists "initiatives scoped" on public.flight_plan_initiatives;
create policy "initiatives scoped" on public.flight_plan_initiatives for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and (
    not (select public.is_seller_restricted(auth.uid()))
    or seller_ids && (select public.visible_seller_ids(auth.uid()))
    or owner_user_id = auth.uid() or created_by = auth.uid()
    or (owner_seller_id is not null and (select public.visible_seller_ids(auth.uid())) @> array[owner_seller_id])));
drop policy if exists "alert states scoped" on public.flight_plan_alert_states;
create policy "alert states scoped" on public.flight_plan_alert_states for select to authenticated
  using (public.can_access_company(auth.uid(), company_id) and (
    seller_id is null or not (select public.is_seller_restricted(auth.uid()))
    or (select public.visible_seller_ids(auth.uid())) @> array[seller_id]));
drop policy if exists "decisions by company" on public.flight_plan_decisions;
create policy "decisions by company" on public.flight_plan_decisions for select to authenticated
  using (public.can_access_company(auth.uid(), company_id));

-- Histórico de etapa dos pedidos (para a taxa de conversão de orçamentos; antes só a etapa atual existia).
create table if not exists private.sales_order_stage_events (
  id bigint generated always as identity primary key,
  order_id uuid not null,
  company_id uuid not null,
  from_stage text,
  to_stage text,
  from_status text,
  to_status text,
  at timestamptz not null default now()
);
create index if not exists sales_order_stage_events_company on private.sales_order_stage_events (company_id, at);
create index if not exists sales_order_stage_events_order on private.sales_order_stage_events (order_id);
revoke all on private.sales_order_stage_events from public, anon, authenticated;
grant all on private.sales_order_stage_events to service_role;

create or replace function private.track_sales_order_stage()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.source = 'omie' then
      insert into private.sales_order_stage_events(order_id, company_id, from_stage, to_stage, from_status, to_status)
      values (new.id, new.company_id, null, new.stage_code, null, new.status::text);
    end if;
  elsif new.source = 'omie'
        and (old.stage_code is distinct from new.stage_code or old.status is distinct from new.status) then
    insert into private.sales_order_stage_events(order_id, company_id, from_stage, to_stage, from_status, to_status)
    values (new.id, new.company_id, old.stage_code, new.stage_code, old.status::text, new.status::text);
  end if;
  return null;
end $$;
revoke all on function private.track_sales_order_stage() from public, anon, authenticated, service_role;
drop trigger if exists zz_track_sales_order_stage on public.sales_orders;
create trigger zz_track_sales_order_stage after insert or update of stage_code, status on public.sales_orders
  for each row execute function private.track_sales_order_stage();

-- Ponto de partida: os orçamentos abertos de hoje entram como acompanhados.
insert into private.sales_order_stage_events(order_id, company_id, from_stage, to_stage, from_status, to_status)
  select o.id, o.company_id, null, o.stage_code, null, o.status::text from public.sales_orders o
  where o.source = 'omie' and o.operation_scope = 'commercial' and o.stage_code = '10' and o.status = 'open'
    and not exists (select 1 from private.sales_order_stage_events e where e.order_id = o.id);

create index if not exists audit_log_entity_lookup on public.audit_log (entity, entity_id, created_at desc);

-- ============ 5. Funções internas (escrita e leituras que precisam ver além da RLS) ============
create schema if not exists flight_plan_internal;
revoke all on schema flight_plan_internal from public, anon;
grant usage on schema flight_plan_internal to authenticated, service_role;

create or replace function flight_plan_internal.is_manager(p_uid uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select p_uid is not null and exists (
    select 1 from public.user_roles where user_id = p_uid and role in ('SUPER_ADMIN','ADMIN','DIRETORIA'))
$$;

-- Devolve o usuário da sessão (null = job do servidor) depois de conferir o acesso à empresa.
create or replace function flight_plan_internal.require_company(p_company uuid)
returns uuid language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if public.is_service_request() then return null; end if;
  if v_uid is null then raise exception 'Sessão expirada.' using errcode = '42501'; end if;
  if p_company is null or not public.can_access_company(v_uid, p_company) then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  return v_uid;
end $$;

create or replace function flight_plan_internal.require_person(p_company uuid)
returns uuid language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_uid uuid := flight_plan_internal.require_company(p_company);
begin
  if v_uid is null then raise exception 'Alterações exigem um usuário.' using errcode = '42501'; end if;
  return v_uid;
end $$;

create or replace function flight_plan_internal.check_period(p_year int, p_month int)
returns date language plpgsql immutable as $$
begin
  if p_year is null or p_month is null or p_month not between 1 and 12 or p_year not between 2000 and 2100 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  return make_date(p_year, p_month, 1);
end $$;

create or replace function flight_plan_internal.can_edit_seller(p_uid uuid, p_company uuid, p_seller uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(p_uid is not null and public.can_access_company(p_uid, p_company)
    and exists (select 1 from public.sellers s where s.id = p_seller and s.company_id = p_company)
    and (flight_plan_internal.is_manager(p_uid) or public.manages_seller(p_uid, p_seller)), false)
$$;

create or replace function flight_plan_internal.audit(p_uid uuid, p_action text, p_entity text, p_company uuid, p_payload jsonb)
returns void language sql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
  insert into public.audit_log(actor_id, action, entity, entity_id, payload)
  values (p_uid, p_action, p_entity, p_company::text, p_payload)
$$;

-- Destino: a grade do mês. Lista os vendedores da equipe VÁLIDA no mês da meta (Gestor) ou todos
-- (Admin, Diretoria e demais papéis amplos); "editable" segue a equipe de HOJE. "allSellers" soma
-- todos os vendedores da empresa (o "Não distribuído" não depende do escopo de quem vê).
create or replace function flight_plan_internal.targets_month(p_company uuid, p_year int, p_month int)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := flight_plan_internal.require_company(p_company);
  v_ms date := flight_plan_internal.check_period(p_year, p_month);
  v_me date := (v_ms + interval '1 month - 1 day')::date;
  v_prev date := (v_ms - interval '1 month')::date;
  v_restricted boolean := v_uid is not null and public.is_seller_restricted(v_uid);
  v_result jsonb;
begin
  with tg as (
    select t.seller_id, lower(ch.name) channel, t.year, t.month, t.level::text lvl, t.amount
    from public.sales_targets t left join public.channels ch on ch.id = t.channel_id
    where t.company_id = p_company and t.active
      and ((t.year = p_year and t.month = p_month)
        or (t.year = extract(year from v_prev)::int and t.month = extract(month from v_prev)::int))
  ), cur as (
    select seller_id, jsonb_object_agg(lvl, amount) v from tg
    where seller_id is not null and year = p_year and month = p_month group by 1
  ), prev as (
    select seller_id, jsonb_object_agg(lvl, amount) v from tg
    where seller_id is not null and not (year = p_year and month = p_month) group by 1
  ), comp as (
    select coalesce(channel, 'all') ch, jsonb_object_agg(lvl, amount) v from tg
    where seller_id is null and year = p_year and month = p_month group by 1
  ), team as (
    select distinct m.seller_id from public.sales_team_members m
    join public.sales_team_managers g on g.team_id = m.team_id
    join public.sales_teams t on t.id = m.team_id and t.company_id = p_company
    where g.user_id = v_uid
      and m.valid_from <= v_me and (m.valid_to is null or m.valid_to >= v_ms)
      and g.valid_from <= v_me and (g.valid_to is null or g.valid_to >= v_ms)
  ), s as (
    select se.id, se.name, se.active, coalesce(lower(ch.name), 'varejo') channel,
      (v_uid is not null and (flight_plan_internal.is_manager(v_uid) or public.manages_seller(v_uid, se.id))) editable
    from public.sellers se left join public.channels ch on ch.id = se.channel_id
    where se.company_id = p_company
      and (not v_restricted or se.user_id = v_uid or se.id in (select seller_id from team))
      and (se.active or exists (select 1 from cur where cur.seller_id = se.id)
           or exists (select 1 from prev where prev.seller_id = se.id))
  ), l3 as (
    select f.seller_id, date_trunc('month', f.competence_date)::date ms, sum(f.amount) amt
    from public.fact_sales(p_company, (v_ms - interval '3 months')::date, v_ms - 1) f
    where f.seller_id in (select id from s)
    group by 1, 2
  ), l3s as (
    select seller_id, jsonb_agg(jsonb_build_object('month', to_char(ms, 'YYYY-MM'), 'amount', round(amt, 2))
      order by ms desc) v from l3 group by 1
  ), allsum as (
    select lvl, sum(amount) amt from tg where seller_id is not null and year = p_year and month = p_month group by 1
  )
  select jsonb_build_object(
    'companyId', p_company,
    'month', to_char(v_ms, 'YYYY-MM'),
    'activeLevel', public.active_target_level(),
    'canEditCompany', v_uid is null or flight_plan_internal.is_manager(v_uid),
    'company', jsonb_build_object(
      'varejo', coalesce((select v from comp where ch = 'varejo'), '{}'::jsonb),
      'licitacao', coalesce((select v from comp where ch = 'licitacao'), '{}'::jsonb),
      'all', coalesce((select v from comp where ch = 'all'), '{}'::jsonb)),
    'allSellers', coalesce((select jsonb_object_agg(lvl, amt) from allsum), '{}'::jsonb),
    'sellers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'active', s.active, 'channel', s.channel, 'editable', s.editable,
        'targets', coalesce(cur.v, '{}'::jsonb), 'previous', coalesce(prev.v, '{}'::jsonb),
        'last3', coalesce(l3s.v, '[]'::jsonb)) order by s.active desc, s.name)
      from s left join cur on cur.seller_id = s.id left join prev on prev.seller_id = s.id
      left join l3s on l3s.seller_id = s.id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

-- Destino: grava um lote. Uma linha fora do escopo recusa o lote inteiro (uma chamada = uma transação).
-- [{"scope":"company","channel":"varejo"|"licitacao"|null,"level":"ACTIVE","amount":number|null},
--  {"scope":"seller","sellerId":uuid,"level":"BASE","amount":number|null}]; null apaga a célula.
create or replace function flight_plan_internal.save_targets(p_company uuid, p_year int, p_month int, p_changes jsonb)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := flight_plan_internal.require_person(p_company);
  v_ms date := flight_plan_internal.check_period(p_year, p_month);
  r jsonb; v_scope text; v_channel text; v_channel_id uuid; v_seller uuid; v_level public.target_level;
  v_amount numeric; v_old numeric; v_label text; v_key text; v_seen text[] := '{}';
  n_created int := 0; n_updated int := 0; n_removed int := 0; n_same int := 0;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception 'Nenhuma meta enviada.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 3000 then
    raise exception 'Envio grande demais: salve em partes.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(r) <> 'object' or coalesce(r->>'scope', '') not in ('company', 'seller')
       or coalesce(r->>'level', '') not in ('BASE', 'ACTIVE', 'CHALLENGE') then
      raise exception 'Linha de meta inválida.' using errcode = '22023';
    end if;
    v_scope := r->>'scope';
    v_level := (r->>'level')::public.target_level;
    if r->'amount' is null or jsonb_typeof(r->'amount') = 'null' then
      v_amount := null;
    elsif jsonb_typeof(r->'amount') = 'number' then
      v_amount := (r->>'amount')::numeric;
      if v_amount <> round(v_amount, 2) then
        raise exception 'Valor de meta com mais de duas casas decimais.' using errcode = '22023';
      end if;
    else
      raise exception 'Valor de meta inválido.' using errcode = '22023';
    end if;
    if v_amount is not null and (v_amount < 0 or v_amount > 999999999999.99) then
      raise exception 'Valor de meta fora do intervalo permitido.' using errcode = '22023';
    end if;

    if v_scope = 'company' then
      if not flight_plan_internal.is_manager(v_uid) then
        raise exception 'Só Admin e Diretoria alteram a meta da empresa.' using errcode = '42501';
      end if;
      v_channel := nullif(r->>'channel', '');
      if v_channel is not null and v_channel not in ('varejo', 'licitacao') then
        raise exception 'Canal inválido.' using errcode = '22023';
      end if;
      v_channel_id := null;
      if v_channel is not null then
        select id into v_channel_id from public.channels
        where company_id = p_company and lower(name) = v_channel order by id limit 1;
        if v_channel_id is null then raise exception 'Canal inexistente nesta empresa.' using errcode = '22023'; end if;
      end if;
      v_seller := null;
      v_label := case v_channel when 'varejo' then 'Empresa · Varejo' when 'licitacao' then 'Empresa · Licitação'
                 else 'Empresa' end;
      v_key := 'c:' || coalesce(v_channel, 'all') || ':' || v_level::text;
      select amount into v_old from public.sales_targets
      where company_id = p_company and seller_id is null and year = p_year and month = p_month
        and level = v_level and active and channel_id is not distinct from v_channel_id
      for update;
    else
      if coalesce(r->>'sellerId', '') !~ '^[0-9a-fA-F-]{36}$' then
        raise exception 'Vendedor inválido.' using errcode = '22023';
      end if;
      v_seller := (r->>'sellerId')::uuid;
      if not flight_plan_internal.can_edit_seller(v_uid, p_company, v_seller) then
        raise exception 'Sem permissão para alterar a meta deste vendedor.' using errcode = '42501';
      end if;
      v_channel := null;
      select s.name, s.channel_id into v_label, v_channel_id from public.sellers s where s.id = v_seller;
      v_key := 's:' || v_seller::text || ':' || v_level::text;
      select amount into v_old from public.sales_targets
      where company_id = p_company and seller_id = v_seller and year = p_year and month = p_month
        and level = v_level and active
      for update;
    end if;
    if v_key = any(v_seen) then
      raise exception 'A mesma meta aparece duas vezes no envio.' using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;

    if v_amount is null then
      if v_old is null then n_same := n_same + 1; continue; end if;
      delete from public.sales_targets
      where company_id = p_company and seller_id is not distinct from v_seller and year = p_year and month = p_month
        and level = v_level and active
        and (v_seller is not null or channel_id is not distinct from v_channel_id);
      n_removed := n_removed + 1;
    elsif v_old is not distinct from v_amount then
      n_same := n_same + 1; continue;
    elsif v_old is null then
      insert into public.sales_targets(company_id, channel_id, seller_id, year, month, level, amount, active, updated_at, updated_by)
      values (p_company, v_channel_id, v_seller, p_year, p_month, v_level, v_amount, true, now(), v_uid);
      n_created := n_created + 1;
    else
      update public.sales_targets set amount = v_amount, updated_at = now(), updated_by = v_uid
      where company_id = p_company and seller_id is not distinct from v_seller and year = p_year and month = p_month
        and level = v_level and active
        and (v_seller is not null or channel_id is not distinct from v_channel_id);
      n_updated := n_updated + 1;
    end if;
    perform flight_plan_internal.audit(v_uid,
      case when v_old is null then 'flight_plan.target.created' when v_amount is null then 'flight_plan.target.removed'
           else 'flight_plan.target.updated' end,
      'flight_plan.targets', p_company,
      jsonb_build_object('area', 'destino', 'month', to_char(v_ms, 'YYYY-MM'), 'level', v_level, 'label', v_label,
        'scope', v_scope, 'channel', v_channel,
        'sellerIds', case when v_seller is null then '[]'::jsonb else jsonb_build_array(v_seller) end,
        'before', v_old, 'after', v_amount));
  end loop;
  return jsonb_build_object('created', n_created, 'updated', n_updated, 'removed', n_removed, 'unchanged', n_same);
end $$;

-- Compromisso do mês (previsão manual do vendedor). Admin, Diretoria, o Gestor do vendedor ou o próprio
-- vendedor. Valor nulo apaga.
create or replace function flight_plan_internal.set_commit(p_company uuid, p_seller uuid, p_year int, p_month int,
  p_amount numeric, p_note text)
returns void language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := flight_plan_internal.require_person(p_company);
  v_ms date := flight_plan_internal.check_period(p_year, p_month);
  v_name text; v_user uuid; v_old numeric; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select s.name, s.user_id into v_name, v_user from public.sellers s where s.id = p_seller and s.company_id = p_company;
  if v_name is null then raise exception 'Vendedor inválido.' using errcode = '22023'; end if;
  if not coalesce(flight_plan_internal.is_manager(v_uid) or public.manages_seller(v_uid, p_seller)
                  or v_user is not distinct from v_uid, false) then
    raise exception 'Sem permissão para registrar o compromisso deste vendedor.' using errcode = '42501';
  end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 999999999999.99 or p_amount <> round(p_amount, 2)) then
    raise exception 'Valor inválido.' using errcode = '22023';
  end if;
  if char_length(v_note) > 500 then raise exception 'Observação longa demais (máximo 500).' using errcode = '22023'; end if;
  select amount into v_old from public.flight_plan_commits
  where company_id = p_company and seller_id = p_seller and year = p_year and month = p_month for update;
  if p_amount is null then
    if v_old is null then return; end if;
    delete from public.flight_plan_commits
    where company_id = p_company and seller_id = p_seller and year = p_year and month = p_month;
  else
    insert into public.flight_plan_commits(company_id, seller_id, year, month, amount, note, created_by, updated_at)
    values (p_company, p_seller, p_year, p_month, p_amount, v_note, v_uid, now())
    on conflict (company_id, seller_id, year, month)
    do update set amount = excluded.amount, note = excluded.note, updated_at = now();
  end if;
  perform flight_plan_internal.audit(v_uid, case when p_amount is null then 'flight_plan.commit.removed'
      else 'flight_plan.commit.saved' end, 'flight_plan.commits', p_company,
    jsonb_build_object('area', 'visao', 'month', to_char(v_ms, 'YYYY-MM'), 'label', v_name,
      'sellerIds', jsonb_build_array(p_seller), 'before', v_old, 'after', p_amount, 'note', v_note));
end $$;

-- Quem pode criar/alterar uma iniciativa: Admin/Diretoria sempre; Gestor se todos os vendedores (e o
-- responsável, quando é vendedor) são da equipe dele hoje; Vendedor só as próprias.
create or replace function flight_plan_internal.can_write_initiative(p_uid uuid, p_company uuid, p_sellers uuid[],
  p_owner_user uuid, p_owner_seller uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(p_uid is not null and public.can_access_company(p_uid, p_company) and (
    flight_plan_internal.is_manager(p_uid)
    or (public.has_role(p_uid, 'GESTOR')
        and not exists (select 1 from unnest(coalesce(p_sellers, '{}'::uuid[])) x where not public.manages_seller(p_uid, x))
        and (p_owner_seller is null or public.manages_seller(p_uid, p_owner_seller)))
    or (public.has_role(p_uid, 'VENDEDOR')
        and not exists (select 1 from unnest(coalesce(p_sellers, '{}'::uuid[])) x
                        where not exists (select 1 from public.sellers s where s.id = x and s.user_id = p_uid))
        and (p_owner_user is not distinct from p_uid
             or exists (select 1 from public.sellers s where s.id = p_owner_seller and s.user_id = p_uid)))), false)
$$;

-- Rota: cria ou altera uma iniciativa. O responsável é "user:<uuid>" (pessoa com acesso à empresa) ou
-- "seller:<uuid>" (vendedor da empresa, com ou sem login).
create or replace function flight_plan_internal.save_initiative(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_company uuid; v_uid uuid; v_id uuid; v_ms date; v_me date; v_due date; v_title text; v_lever text;
  v_owner text; v_owner_user uuid; v_owner_seller uuid; v_owner_name text; v_sellers uuid[]; v_expected numeric;
  v_realized numeric; v_status text; v_alert text; v_list text; v_notes text; v_old public.flight_plan_initiatives;
  v_x text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Iniciativa inválida.' using errcode = '22023'; end if;
  if coalesce(p->>'companyId', '') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Empresa inválida.' using errcode = '22023'; end if;
  v_company := (p->>'companyId')::uuid;
  v_uid := flight_plan_internal.require_person(v_company);
  if coalesce(p->>'month', '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Mês inválido.' using errcode = '22023'; end if;
  v_ms := to_date(p->>'month' || '-01', 'YYYY-MM-DD');
  v_me := (v_ms + interval '1 month - 1 day')::date;
  v_title := btrim(coalesce(p->>'title', ''));
  v_lever := coalesce(p->>'lever', '');
  v_status := coalesce(nullif(p->>'status', ''), 'PLANNED');
  v_alert := nullif(btrim(coalesce(p->>'alertKey', '')), '');
  v_list := nullif(p->>'targetListKind', '');
  v_notes := nullif(btrim(coalesce(p->>'notes', '')), '');
  if char_length(v_title) not between 1 and 160 then
    raise exception 'Informe um título de até 160 caracteres.' using errcode = '22023';
  end if;
  if v_lever not in ('CONVERT_QUOTES','REACTIVATE_CUSTOMERS','EXPAND_MIX','PRODUCT_CAMPAIGN','PUBLIC_BIDS','PROSPECTING','OTHER') then
    raise exception 'Alavanca inválida.' using errcode = '22023';
  end if;
  if v_status not in ('PLANNED','IN_PROGRESS','DONE','CANCELLED') then raise exception 'Status inválido.' using errcode = '22023'; end if;
  if v_list is not null and v_list not in ('OPEN_QUOTES','INACTIVE_CUSTOMERS','LATE_ORDERS','IDLE_STOCK') then
    raise exception 'Lista inválida.' using errcode = '22023';
  end if;
  if char_length(v_alert) > 200 or char_length(v_notes) > 1000 then
    raise exception 'Texto longo demais.' using errcode = '22023';
  end if;
  if coalesce(p->>'dueDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Prazo inválido.' using errcode = '22023'; end if;
  v_due := (p->>'dueDate')::date;
  if v_due < v_ms or v_due > v_me + 30 then
    raise exception 'O prazo deve estar dentro do mês ou até 30 dias depois.' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'expectedAmount') is distinct from 'number' then
    raise exception 'Informe o valor esperado.' using errcode = '22023';
  end if;
  v_expected := (p->>'expectedAmount')::numeric;
  if v_expected <= 0 or v_expected > 999999999999.99 or v_expected <> round(v_expected, 2) then
    raise exception 'Valor esperado inválido.' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'realizedAmount') = 'number' then
    v_realized := (p->>'realizedAmount')::numeric;
    if v_realized < 0 or v_realized > 999999999999.99 or v_realized <> round(v_realized, 2) then
      raise exception 'Resultado inválido.' using errcode = '22023';
    end if;
  end if;
  if v_status = 'DONE' and v_realized is null then
    raise exception 'Informe o resultado em R$ para concluir.' using errcode = '22023';
  end if;
  v_sellers := '{}';
  if p ? 'sellerIds' and jsonb_typeof(p->'sellerIds') = 'array' then
    if jsonb_array_length(p->'sellerIds') > 100 then raise exception 'Vendedores demais.' using errcode = '22023'; end if;
    for v_x in select jsonb_array_elements_text(p->'sellerIds') loop
      if v_x !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Vendedor inválido.' using errcode = '22023'; end if;
      if not exists (select 1 from public.sellers s where s.id = v_x::uuid and s.company_id = v_company) then
        raise exception 'Vendedor inválido.' using errcode = '22023';
      end if;
      if not v_x::uuid = any(v_sellers) then v_sellers := v_sellers || v_x::uuid; end if;
    end loop;
  elsif p ? 'sellerIds' and jsonb_typeof(p->'sellerIds') <> 'null' then
    raise exception 'Vendedores inválidos.' using errcode = '22023';
  end if;
  v_owner := coalesce(p->>'ownerUserId', '');
  if v_owner ~ '^user:[0-9a-fA-F-]{36}$' then
    v_owner_user := substr(v_owner, 6)::uuid;
    if v_owner_user <> v_uid and not public.can_access_company(v_owner_user, v_company) then
      raise exception 'Responsável sem acesso a esta empresa.' using errcode = '22023';
    end if;
    select coalesce(nullif(btrim(full_name), ''), email) into v_owner_name from public.profiles where id = v_owner_user;
  elsif v_owner ~ '^seller:[0-9a-fA-F-]{36}$' then
    v_owner_seller := substr(v_owner, 8)::uuid;
    select name into v_owner_name from public.sellers where id = v_owner_seller and company_id = v_company;
  else
    raise exception 'Responsável inválido.' using errcode = '22023';
  end if;
  if v_owner_name is null then raise exception 'Responsável inválido.' using errcode = '22023'; end if;

  if not flight_plan_internal.can_write_initiative(v_uid, v_company, v_sellers, v_owner_user, v_owner_seller) then
    raise exception 'Sem permissão para esta iniciativa.' using errcode = '42501';
  end if;

  if nullif(p->>'id', '') is not null then
    if (p->>'id') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Iniciativa não encontrada.' using errcode = '22023'; end if;
    select * into v_old from public.flight_plan_initiatives where id = (p->>'id')::uuid and company_id = v_company for update;
    if v_old.id is null then raise exception 'Iniciativa não encontrada.' using errcode = '22023'; end if;
    if not flight_plan_internal.can_write_initiative(v_uid, v_company, v_old.seller_ids, v_old.owner_user_id, v_old.owner_seller_id) then
      raise exception 'Sem permissão para esta iniciativa.' using errcode = '42501';
    end if;
    update public.flight_plan_initiatives set
      year = extract(year from v_ms)::int, month = extract(month from v_ms)::int, title = v_title, lever = v_lever,
      owner_user_id = v_owner_user, owner_seller_id = v_owner_seller, owner_name = v_owner_name, seller_ids = v_sellers,
      due_date = v_due, expected_amount = v_expected, realized_amount = coalesce(v_realized, realized_amount),
      status = v_status, alert_key = v_alert, target_list_kind = v_list, notes = v_notes,
      updated_by = v_uid, updated_at = now()
    where id = v_old.id;
    v_id := v_old.id;
    perform flight_plan_internal.audit(v_uid, 'flight_plan.initiative.updated', 'flight_plan.initiatives', v_company,
      jsonb_build_object('area', 'rota', 'month', to_char(v_ms, 'YYYY-MM'), 'label', v_title, 'initiativeId', v_id,
        'sellerIds', to_jsonb(v_sellers), 'before', v_old.title || ' · ' || v_old.expected_amount,
        'after', v_title || ' · ' || v_expected));
  else
    insert into public.flight_plan_initiatives(company_id, year, month, title, lever, owner_user_id, owner_seller_id,
      owner_name, seller_ids, due_date, expected_amount, realized_amount, status, alert_key, target_list_kind, notes,
      created_by, updated_by)
    values (v_company, extract(year from v_ms)::int, extract(month from v_ms)::int, v_title, v_lever, v_owner_user,
      v_owner_seller, v_owner_name, v_sellers, v_due, v_expected, v_realized, v_status, v_alert, v_list, v_notes,
      v_uid, v_uid)
    returning id into v_id;
    perform flight_plan_internal.audit(v_uid, 'flight_plan.initiative.created', 'flight_plan.initiatives', v_company,
      jsonb_build_object('area', case when v_alert is null then 'rota' else 'correcao' end,
        'month', to_char(v_ms, 'YYYY-MM'), 'label', v_title, 'initiativeId', v_id, 'sellerIds', to_jsonb(v_sellers),
        'before', null, 'after', v_expected));
  end if;
  return v_id;
end $$;

create or replace function flight_plan_internal.set_initiative_status(p_id uuid, p_status text, p_realized numeric, p_note text)
returns uuid language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_row public.flight_plan_initiatives; v_uid uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_row from public.flight_plan_initiatives where id = p_id for update;
  if v_row.id is null then raise exception 'Iniciativa não encontrada.' using errcode = '22023'; end if;
  v_uid := flight_plan_internal.require_person(v_row.company_id);
  if not flight_plan_internal.can_write_initiative(v_uid, v_row.company_id, v_row.seller_ids, v_row.owner_user_id,
    v_row.owner_seller_id) then
    raise exception 'Sem permissão para esta iniciativa.' using errcode = '42501';
  end if;
  if coalesce(p_status, '') not in ('PLANNED','IN_PROGRESS','DONE','CANCELLED') then
    raise exception 'Status inválido.' using errcode = '22023';
  end if;
  if p_status = 'DONE' and (p_realized is null or p_realized < 0) then
    raise exception 'Informe o resultado em R$ para concluir.' using errcode = '22023';
  end if;
  if p_realized is not null and (p_realized > 999999999999.99 or p_realized <> round(p_realized, 2)) then
    raise exception 'Resultado inválido.' using errcode = '22023';
  end if;
  if p_status = 'CANCELLED' and v_note is null then
    raise exception 'Informe o motivo do cancelamento.' using errcode = '22023';
  end if;
  if char_length(v_note) > 1000 then raise exception 'Texto longo demais.' using errcode = '22023'; end if;
  update public.flight_plan_initiatives set
    status = p_status,
    realized_amount = case when p_status = 'DONE' then p_realized else realized_amount end,
    notes = coalesce(v_note, notes), updated_by = v_uid, updated_at = now()
  where id = p_id;
  perform flight_plan_internal.audit(v_uid, 'flight_plan.initiative.status', 'flight_plan.initiatives', v_row.company_id,
    jsonb_build_object('area', 'rota', 'month', v_row.year || '-' || lpad(v_row.month::text, 2, '0'), 'label', v_row.title,
      'initiativeId', p_id, 'sellerIds', to_jsonb(v_row.seller_ids), 'before', v_row.status,
      'after', p_status || case when p_status = 'DONE' then ' (' || p_realized || ')' else '' end));
  return p_id;
end $$;

-- Correção de rota: o usuário muda o estado de um alerta (calculado na leitura pelo motor do Plano de Voo).
create or replace function flight_plan_internal.set_alert_state(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_company uuid; v_uid uuid; v_key text; v_subject text; v_seller uuid; v_state text; v_note text; v_init uuid;
  v_ms date; v_prio int; v_msg text; v_evid text; v_old public.flight_plan_alert_states; v_today date; v_row jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p->>'companyId', '') !~ '^[0-9a-fA-F-]{36}$' then
    raise exception 'Alerta inválido.' using errcode = '22023';
  end if;
  v_company := (p->>'companyId')::uuid;
  v_uid := flight_plan_internal.require_person(v_company);
  v_key := coalesce(p->>'key', '');
  v_subject := coalesce(p->>'subject', '');
  v_state := coalesce(p->>'state', '');
  v_note := nullif(btrim(coalesce(p->>'note', '')), '');
  v_msg := left(coalesce(p->>'message', ''), 300);
  v_evid := left(coalesce(p->>'evidence', ''), 500);
  if char_length(v_key) not between 1 and 200 or char_length(v_subject) not between 1 and 120 then
    raise exception 'Alerta inválido.' using errcode = '22023';
  end if;
  if coalesce(p->>'month', '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Mês inválido.' using errcode = '22023'; end if;
  v_ms := to_date(p->>'month' || '-01', 'YYYY-MM-DD');
  if v_state not in ('OPEN','ACKNOWLEDGED','ACTION_CREATED','RESOLVED') then
    raise exception 'Estado inválido.' using errcode = '22023';
  end if;
  if nullif(p->>'sellerId', '') is not null then
    if (p->>'sellerId') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Vendedor inválido.' using errcode = '22023'; end if;
    v_seller := (p->>'sellerId')::uuid;
    if not exists (select 1 from public.sellers s where s.id = v_seller and s.company_id = v_company) then
      raise exception 'Vendedor inválido.' using errcode = '22023';
    end if;
  end if;
  if jsonb_typeof(p->'priority') = 'number' then
    if (p->>'priority')::numeric not in (1, 2, 3) then raise exception 'Prioridade inválida.' using errcode = '22023'; end if;
    v_prio := (p->>'priority')::int;
  end if;
  if nullif(p->>'initiativeId', '') is not null then
    if (p->>'initiativeId') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Iniciativa inválida.' using errcode = '22023'; end if;
    v_init := (p->>'initiativeId')::uuid;
    if not exists (select 1 from public.flight_plan_initiatives i where i.id = v_init and i.company_id = v_company) then
      raise exception 'Iniciativa inválida.' using errcode = '22023';
    end if;
  end if;
  if not (flight_plan_internal.is_manager(v_uid)
          or (public.has_role(v_uid, 'GESTOR') and (v_seller is null or public.manages_seller(v_uid, v_seller)))
          or (public.has_role(v_uid, 'VENDEDOR') and v_state = 'ACTION_CREATED' and v_seller is not null
              and exists (select 1 from public.sellers s where s.id = v_seller and s.user_id = v_uid))) then
    raise exception 'Sem permissão para alterar este alerta.' using errcode = '42501';
  end if;
  if v_state = 'ACKNOWLEDGED' and v_note is null then
    raise exception 'A justificativa é obrigatória para marcar como ciente.' using errcode = '22023';
  end if;
  if char_length(v_note) > 1000 then raise exception 'Texto longo demais.' using errcode = '22023'; end if;
  v_today := public.data_as_of(v_company);
  select * into v_old from public.flight_plan_alert_states where company_id = v_company and alert_key = v_key for update;
  insert into public.flight_plan_alert_states as t(company_id, alert_key, subject, year, month, seller_id, state, priority,
    message, evidence, note, initiative_id, first_seen, last_seen, absent_since, reopened, updated_by, updated_at)
  values (v_company, v_key, v_subject, extract(year from v_ms)::int, extract(month from v_ms)::int, v_seller, v_state,
    v_prio, v_msg, v_evid, v_note, v_init, v_today, v_today, null, false, v_uid, now())
  on conflict (company_id, alert_key) do update set
    state = excluded.state, note = excluded.note, initiative_id = coalesce(excluded.initiative_id, t.initiative_id),
    priority = coalesce(excluded.priority, t.priority), message = excluded.message, evidence = excluded.evidence,
    last_seen = excluded.last_seen, absent_since = null, reopened = false, updated_by = v_uid, updated_at = now();
  perform flight_plan_internal.audit(v_uid, 'flight_plan.alert.state', 'flight_plan.alerts', v_company,
    jsonb_build_object('area', 'correcao', 'month', to_char(v_ms, 'YYYY-MM'), 'label', v_msg, 'alertKey', v_key,
      'sellerIds', case when v_seller is null then '[]'::jsonb else jsonb_build_array(v_seller) end,
      'before', coalesce(v_old.state, 'OPEN'), 'after', v_state, 'note', v_note));
  select jsonb_build_object('key', a.alert_key, 'state', a.state, 'reopened', a.reopened, 'note', a.note,
    'initiativeId', a.initiative_id, 'updatedAt', a.updated_at, 'firstSeen', a.first_seen) into v_row
  from public.flight_plan_alert_states a where a.company_id = v_company and a.alert_key = v_key;
  return v_row;
end $$;

-- Correção de rota: registro de presença dos alertas calculados. Um alerta "Ciente" ou "Resolvido" volta
-- a "Aberto" (reopened) quando piora de prioridade ou quando tinha sumido e voltou. Só os assuntos
-- avaliados nesta leitura (p_subjects) podem ser marcados como ausentes.
-- p_alerts: [{"key":..., "subject":..., "sellerId":uuid|null, "priority":1|2|3, "message":..., "evidence":...}]
create or replace function flight_plan_internal.sync_alerts(p_company uuid, p_year int, p_month int,
  p_subjects text[], p_alerts jsonb)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := flight_plan_internal.require_company(p_company);
  v_ms date := flight_plan_internal.check_period(p_year, p_month);
  v_today date := public.data_as_of(p_company);
  v_keys text[]; v jsonb;
begin
  if p_alerts is null or jsonb_typeof(p_alerts) <> 'array' or jsonb_array_length(p_alerts) > 2000 then
    raise exception 'Lista de alertas inválida.' using errcode = '22023';
  end if;
  if coalesce(array_length(p_subjects, 1), 0) > 2000 then raise exception 'Assuntos demais.' using errcode = '22023'; end if;
  select coalesce(array_agg(a->>'key'), '{}') into v_keys from jsonb_array_elements(p_alerts) a;
  if exists (select 1 from unnest(v_keys) k where k is null or char_length(k) not between 1 and 200)
     or exists (select 1 from jsonb_array_elements(p_alerts) a
                where coalesce(a->>'subject', '') = '' or char_length(a->>'subject') > 120
                   or case when jsonb_typeof(a->'priority') = 'number'
                           then (a->>'priority')::numeric not in (1, 2, 3) else true end
                   or (nullif(a->>'sellerId', '') is not null and not exists (
                     select 1 from public.sellers s where s.id::text = lower(a->>'sellerId') and s.company_id = p_company))) then
    raise exception 'Alerta inválido.' using errcode = '22023';
  end if;
  insert into public.flight_plan_alert_states as t(company_id, alert_key, subject, year, month, seller_id, state,
    priority, message, evidence, first_seen, last_seen)
  select p_company, a->>'key', a->>'subject', p_year, p_month, nullif(a->>'sellerId', '')::uuid, 'OPEN',
    (a->>'priority')::int, left(coalesce(a->>'message', ''), 300), left(coalesce(a->>'evidence', ''), 500), v_today, v_today
  from (select distinct on (x->>'key') x a from jsonb_array_elements(p_alerts) x) q
  on conflict (company_id, alert_key) do update set
    state = case when t.state in ('ACKNOWLEDGED', 'RESOLVED')
                  and (t.absent_since is not null or excluded.priority < coalesce(t.priority, 3)) then 'OPEN' else t.state end,
    reopened = case when t.state in ('ACKNOWLEDGED', 'RESOLVED')
                  and (t.absent_since is not null or excluded.priority < coalesce(t.priority, 3)) then true else t.reopened end,
    priority = excluded.priority, message = excluded.message, evidence = excluded.evidence,
    last_seen = greatest(coalesce(t.last_seen, excluded.last_seen), excluded.last_seen), absent_since = null;
  update public.flight_plan_alert_states set absent_since = v_today
  where company_id = p_company and year = p_year and month = p_month and absent_since is null
    and subject = any(coalesce(p_subjects, '{}')) and not (alert_key = any(v_keys));
  select coalesce(jsonb_agg(jsonb_build_object('key', a.alert_key, 'state', a.state, 'reopened', a.reopened,
      'note', a.note, 'initiativeId', a.initiative_id, 'updatedAt', a.updated_at, 'firstSeen', a.first_seen)), '[]'::jsonb)
    into v
  from public.flight_plan_alert_states a where a.company_id = p_company and a.alert_key = any(v_keys);
  return v;
end $$;

create or replace function flight_plan_internal.add_decision(p_company uuid, p_week date, p_text text)
returns uuid language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := flight_plan_internal.require_person(p_company);
  v_text text := btrim(coalesce(p_text, '')); v_week date; v_id uuid; v_name text;
begin
  if not (flight_plan_internal.is_manager(v_uid) or public.has_role(v_uid, 'GESTOR')) then
    raise exception 'Só Admin, Diretoria e Gestor registram decisões.' using errcode = '42501';
  end if;
  if p_week is null then raise exception 'Semana inválida.' using errcode = '22023'; end if;
  if char_length(v_text) not between 1 and 1000 then raise exception 'Escreva a decisão (até 1.000 caracteres).' using errcode = '22023'; end if;
  v_week := date_trunc('week', p_week)::date;
  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = v_uid;
  insert into public.flight_plan_decisions(company_id, week_start, body, author_id, author_name)
  values (p_company, v_week, v_text, v_uid, v_name) returning id into v_id;
  perform flight_plan_internal.audit(v_uid, 'flight_plan.decision.created', 'flight_plan.decisions', p_company,
    jsonb_build_object('area', 'correcao', 'label', 'Semana de ' || to_char(v_week, 'DD/MM/YYYY'),
      'sellerIds', '[]'::jsonb, 'before', null, 'after', v_text));
  return v_id;
end $$;

-- Histórico das alterações do Plano de Voo (audit_log). Quem só vê parte dos vendedores (Gestor,
-- Vendedor) só vê as linhas sobre esses vendedores, sobre a empresa ou feitas por ele.
create or replace function flight_plan_internal.history(p_company uuid, p_area text, p_limit int)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := flight_plan_internal.require_company(p_company);
  v_restricted boolean := v_uid is not null and public.is_seller_restricted(v_uid);
  v_visible uuid[] := case when v_restricted then public.visible_seller_ids(v_uid) else null end;
  v jsonb;
begin
  if p_area is not null and p_area not in ('visao', 'destino', 'rota', 'correcao') then
    raise exception 'Área inválida.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(x order by (x->>'at') desc), '[]'::jsonb) into v from (
    select jsonb_build_object('id', a.id::text, 'at', a.created_at, 'action', a.action,
      'area', a.payload->>'area', 'label', a.payload->>'label', 'month', a.payload->>'month',
      'level', a.payload->>'level', 'before', a.payload->'before', 'after', a.payload->'after',
      'author', coalesce(nullif(btrim(pr.full_name), ''), pr.email, 'Sistema')) x
    from public.audit_log a left join public.profiles pr on pr.id = a.actor_id
    where a.entity = any(array['flight_plan.targets', 'flight_plan.commits', 'flight_plan.initiatives',
                               'flight_plan.alerts', 'flight_plan.decisions'])
      and a.entity_id = p_company::text
      and (p_area is null or a.payload->>'area' = p_area)
      and (not v_restricted or a.actor_id = v_uid
           or not exists (select 1 from jsonb_array_elements_text(coalesce(a.payload->'sellerIds', '[]'::jsonb)) sid
                          where not (sid::uuid = any(v_visible))))
    order by a.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)) q;
  return v;
end $$;

-- Conversão de orçamentos desde o início do acompanhamento (histórico de etapa). Só os vendedores visíveis.
create or replace function flight_plan_internal.conversion(p_company uuid, p_since date, p_channel uuid, p_seller uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := flight_plan_internal.require_company(p_company);
  v_visible uuid[] := case when v_uid is not null and public.is_seller_restricted(v_uid)
                           then public.visible_seller_ids(v_uid) else null end;
  v jsonb;
begin
  with q as (
    select distinct e.order_id from private.sales_order_stage_events e
    where e.company_id = p_company and e.to_stage = '10'
      and e.at >= (coalesce(p_since, date '2026-11-04')::timestamp at time zone 'America/Sao_Paulo')
  ), o as (
    select o.id, o.stage_code, o.status,
      coalesce((select sum(it.total) from public.sales_order_items it where it.order_id = o.id), o.total) amt
    from public.sales_orders o
    where o.id in (select order_id from q) and o.company_id = p_company and o.operation_scope = 'commercial'
      and (p_channel is null or o.channel_id = p_channel) and (p_seller is null or o.seller_id = p_seller)
      and (v_visible is null or o.seller_id = any(v_visible))
  )
  select jsonb_build_object(
    'tracked', count(*),
    'trackedAmount', coalesce(round(sum(amt), 2), 0),
    'converted', count(*) filter (where status <> 'cancelled' and stage_code is distinct from '10'),
    'convertedAmount', coalesce(round(sum(amt) filter (where status <> 'cancelled' and stage_code is distinct from '10'), 2), 0),
    'lost', count(*) filter (where status = 'cancelled'),
    'lostAmount', coalesce(round(sum(amt) filter (where status = 'cancelled'), 2), 0))
  into v from o;
  return v;
end $$;

-- ============ 6. Leituras (SECURITY INVOKER: a RLS decide o que cada um vê) ============

-- Contexto do usuário: papéis, empresas (com data de referência e canais), vendedor próprio e equipe.
create or replace function public.flight_plan_v2_me()
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'userId', auth.uid(),
    'name', (select coalesce(nullif(btrim(full_name), ''), email) from public.profiles where id = auth.uid()),
    'roles', coalesce((select jsonb_agg(role::text order by role::text) from public.user_roles where user_id = auth.uid()), '[]'::jsonb),
    'config', coalesce((select config from public.metric_config where metric_key = 'flight_plan'), '{}'::jsonb),
    'companies', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name,
        'isDemo', c.is_demo, 'asOf', public.data_as_of(c.id),
        'channels', coalesce((select jsonb_object_agg(lower(ch.name), ch.id) from public.channels ch where ch.company_id = c.id), '{}'::jsonb))
      order by c.name) from public.companies c), '[]'::jsonb),
    'sellerIds', coalesce((select jsonb_agg(s.id) from public.sellers s where s.user_id = auth.uid()), '[]'::jsonb),
    'managedSellerIds', case when public.has_role(auth.uid(), 'GESTOR')
      then to_jsonb(public.visible_seller_ids(auth.uid())) else '[]'::jsonb end)
$$;

-- Plano de Voo do mês: fatos crus numa leitura só (vendas, metas do ano, carteira, orçamentos, compromissos,
-- feriados, fotos da última segunda e conversão). As fórmulas ficam no motor (src/domain/flight-plan) e as
-- janelas de comparação vêm de src/domain/comparison.ts:
-- p_windows = {"previous":{"start","end"},"lastYear":{"start","end"},"trailing3":{"start","end","divisor"}}.
-- p_as_of: data de referência (padrão data_as_of; a foto diária informa o dia que está fotografando).
create or replace function public.flight_plan_v2_dataset(p_company uuid, p_year int, p_month int, p_windows jsonb,
  p_channel text default null, p_seller uuid default null, p_as_of date default null, p_channel_id uuid default null,
  p_branch uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_start date; v_end date; v_today date; v_cut date; v_state text;
  v_year_start date; v_year_end date; v_win_from date; v_win_to date; v_pmm_start date;
  v_pm_start date; v_pm_end date; v_pm_cut date; v_py_start date; v_py_cut date;
  v_l3_start date; v_l3_end date; v_l3_div numeric;
  v_lm date; v_chan uuid; v_cfg jsonb; v_out jsonb; v_conv jsonb;
begin
  perform public.assert_company_access(p_company);
  if p_year is null or p_month is null or p_month not between 1 and 12 or p_year not between 2000 and 2100 then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_channel is not null and p_channel not in ('varejo', 'licitacao') then
    raise exception 'Canal inválido.' using errcode = '22023';
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'object'
     or jsonb_typeof(p_windows->'previous') is distinct from 'object'
     or jsonb_typeof(p_windows->'lastYear') is distinct from 'object'
     or jsonb_typeof(p_windows->'trailing3') is distinct from 'object' then
    raise exception 'Janelas de comparação ausentes.' using errcode = '22023';
  end if;
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + interval '1 month - 1 day')::date;
  v_today := coalesce(p_as_of, public.data_as_of(p_company));
  v_cut := least(v_end, v_today);
  v_state := case when v_today < v_start then 'future' when v_today > v_end then 'closed' else 'current' end;
  v_year_start := make_date(p_year, 1, 1);
  v_year_end := make_date(p_year, 12, 31);
  v_pmm_start := (v_start - interval '1 month')::date;
  v_pm_end := v_start - 1;
  v_pm_start := (p_windows->'previous'->>'start')::date;
  v_pm_cut := (p_windows->'previous'->>'end')::date;
  v_py_start := (p_windows->'lastYear'->>'start')::date;
  v_py_cut := (p_windows->'lastYear'->>'end')::date;
  v_l3_start := (p_windows->'trailing3'->>'start')::date;
  v_l3_end := (p_windows->'trailing3'->>'end')::date;
  v_l3_div := coalesce((p_windows->'trailing3'->>'divisor')::numeric, 3);
  if v_pm_start is null or v_pm_cut is null or v_py_start is null or v_py_cut is null or v_l3_start is null
     or v_l3_end is null or v_l3_div <= 0 or v_pm_cut - v_pm_start > 400 or v_py_cut - v_py_start > 400
     or v_l3_end - v_l3_start > 400 or v_pm_start > v_start or v_l3_end >= v_start then
    raise exception 'Janelas de comparação inválidas.' using errcode = '22023';
  end if;
  v_win_from := least(v_year_start, v_l3_start, v_pmm_start, v_pm_start);
  v_win_to := least(v_year_end, v_today);
  v_lm := case when extract(isodow from v_today) = 1 then v_today - 7 else date_trunc('week', v_today)::date end;
  if p_channel_id is not null then
    v_chan := coalesce((select id from public.channels where id = p_channel_id and company_id = p_company),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  elsif p_channel is not null then
    v_chan := coalesce((select id from public.channels where company_id = p_company and lower(name) = p_channel order by id limit 1),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  end if;
  select config into v_cfg from public.metric_config where metric_key = 'flight_plan';
  v_conv := flight_plan_internal.conversion(p_company,
    coalesce(nullif(v_cfg->'conversion'->>'since', '')::date, date '2026-11-04'), v_chan, p_seller);

  with s as materialized (
    select f.competence_date d, f.seller_id, f.customer_id, f.invoice_id, sum(f.amount) amt
    from public.fact_sales(p_company, v_win_from, greatest(v_win_to, v_win_from), v_chan, p_branch, p_seller,
      p_state, p_city, p_category) f
    where f.competence_date <= v_win_to
    group by 1, 2, 3, 4
  ), py as materialized (
    select f.seller_id, sum(f.amount) amt
    from public.fact_sales(p_company, v_py_start, v_py_cut, v_chan, p_branch, p_seller, p_state, p_city, p_category) f
    group by 1
  ), cur as (
    select * from s where d between v_start and v_cut
  ), sc as (
    select se.id, se.name, se.active, se.user_id, coalesce(lower(ch.name), 'varejo') channel
    from public.sellers se left join public.channels ch on ch.id = se.channel_id
    where se.company_id = p_company and (p_seller is null or se.id = p_seller)
      and (v_chan is null or se.channel_id = v_chan) and (p_branch is null or se.branch_id = p_branch)
  ), tg as (
    select t.seller_id, t.month, t.level::text lvl, t.amount, lower(ch.name) channel
    from public.sales_targets t left join public.channels ch on ch.id = t.channel_id
    where t.company_id = p_company and t.year = p_year and t.active
  ), ord as (
    select o.order_id, o.number, o.seller_id, o.order_date, o.expected_date, sum(o.amount) amt
    from public.fact_orders(p_company, v_chan, p_branch, p_seller, p_state, p_city, p_category) o
    where o.status = 'open' and o.order_date <= v_today
    group by 1, 2, 3, 4, 5
  ), qt as (
    select o.id, o.number, o.seller_id, o.order_date,
      coalesce((select sum(it.total) from public.sales_order_items it join public.products pr on pr.id = it.product_id
                where it.order_id = o.id and (p_category is null or pr.category = p_category)),
               case when p_category is null then o.total end) amt
    from public.sales_orders o
    where o.company_id = p_company and o.source = 'omie' and o.operation_scope = 'commercial'
      and o.stage_code = '10' and o.status = 'open' and o.order_date <= v_today
      and (v_chan is null or o.channel_id = v_chan) and (p_seller is null or o.seller_id = p_seller)
      and (p_branch is null or o.branch_id = p_branch)
      and (p_state is null and p_city is null or exists (select 1 from public.customers cu where cu.id = o.customer_id
           and (p_state is null or cu.state = p_state) and (p_city is null or cu.city = p_city)))
      and (p_category is null or exists (select 1 from public.sales_order_items it join public.products pr on pr.id = it.product_id
           where it.order_id = o.id and pr.category = p_category))
  ), prior_buyers as (
    select distinct i.customer_id from public.invoices i
    where i.company_id = p_company and i.competence_date < v_start
      and i.customer_id in (select customer_id from cur)
      and i.status = any(public.revenue_valid_statuses())
      and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible)
  ), sr as (
    select seller_id, sum(amt) rev, count(distinct invoice_id) nfs, count(distinct customer_id) cust from cur group by 1
  ), slast as (
    select seller_id, max(d) last_d from s where d <= v_today group by 1
  ), spm as (
    select seller_id, sum(amt) amt from s where d between v_pm_start and v_pm_cut group by 1
  ), sl3 as (
    select seller_id, sum(amt) / v_l3_div amt from s where d between v_l3_start and v_l3_end group by 1
  ), st as (
    select seller_id, jsonb_object_agg(lvl, amount) v from tg where month = p_month and seller_id is not null group by 1
  ), so as (
    select seller_id, count(*) n from ord group by 1
  ), sq as (
    select seller_id, count(*) n from qt group by 1
  ), cm as (
    select c.seller_id, c.amount, c.note, c.updated_at from public.flight_plan_commits c
    where c.company_id = p_company and c.year = p_year and c.month = p_month
  ), snapd as (
    select max(x.snapshot_date) d from public.flight_plan_snapshots x
    where x.company_id = p_company and x.snapshot_date between v_lm - 6 and v_lm
  ), snap as (
    select f.seller_id, f.status from public.flight_plan_snapshots f, snapd
    where f.company_id = p_company and f.snapshot_date = snapd.d
  ), srows as (
    select sc.*, sr.rev, sr.nfs, sr.cust, slast.last_d, spm.amt pm, py.amt pyv, sl3.amt l3, st.v targets,
      coalesce(so.n, 0) n_orders, coalesce(sq.n, 0) n_quotes, cm.amount c_amount, cm.note c_note, cm.updated_at c_at
    from sc left join sr on sr.seller_id = sc.id left join slast on slast.seller_id = sc.id
      left join spm on spm.seller_id = sc.id left join py on py.seller_id = sc.id left join sl3 on sl3.seller_id = sc.id
      left join st on st.seller_id = sc.id left join so on so.seller_id = sc.id left join sq on sq.seller_id = sc.id
      left join cm on cm.seller_id = sc.id
  )
  select jsonb_build_object(
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'today', v_today, 'state', v_state,
      'lastMonday', v_lm, 'yearEnd', v_year_end),
    'config', coalesce(v_cfg, '{}'::jsonb),
    'company', (select jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'isDemo', c.is_demo)
                from public.companies c where c.id = p_company),
    'channel', (select lower(ch.name) from public.channels ch where ch.id = v_chan),
    'restricted', public.is_seller_restricted(auth.uid()),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'amount', round(a, 2)) order by d)
      from (select d, sum(amt) a from cur group by d) x), '[]'::jsonb),
    'previousDaily', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'amount', round(a, 2)) order by d)
      from (select d, sum(amt) a from s where d between v_pmm_start and v_pm_end group by d) x), '[]'::jsonb),
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'amount', round(a, 2)) order by m)
      from (select extract(month from d)::int m, sum(amt) a from s where d between v_year_start and v_win_to group by 1) x),
      '[]'::jsonb),
    'totals', jsonb_build_object(
      'invoices', (select count(distinct invoice_id) from cur),
      'customers', (select count(distinct customer_id) from cur),
      'newCustomers', (select count(distinct customer_id) from cur where customer_id not in (select customer_id from prior_buyers)),
      'unassigned', coalesce((select round(sum(amt), 2) from cur where seller_id is null), 0),
      'previousMonthSameCut', coalesce((select round(sum(amt), 2) from s where d between v_pm_start and v_pm_cut), 0),
      'previousYearSameCut', coalesce((select round(sum(amt), 2) from py), 0),
      'last3MonthsAvg', coalesce((select round(sum(amt) / v_l3_div, 2) from s where d between v_l3_start and v_l3_end), 0)),
    'sellers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'active', r.active, 'channel', r.channel, 'hasLogin', r.user_id is not null,
        'revenue', coalesce(round(r.rev, 2), 0), 'invoices', coalesce(r.nfs, 0), 'customers', coalesce(r.cust, 0),
        'lastInvoice', r.last_d,
        'previousMonthSameCut', coalesce(round(r.pm, 2), 0), 'previousYearSameCut', coalesce(round(r.pyv, 2), 0),
        'last3MonthsAvg', coalesce(round(r.l3, 2), 0),
        'targets', coalesce(r.targets, '{}'::jsonb), 'openOrders', r.n_orders, 'openQuotes', r.n_quotes,
        'commit', case when r.c_amount is null then null
                  else jsonb_build_object('amount', r.c_amount, 'note', r.c_note, 'updatedAt', r.c_at) end,
        'statusLastMonday', (select snap.status from snap where snap.seller_id = r.id)) order by r.name)
      from srows r
      where r.active or r.rev is not null or r.targets is not null or r.n_orders > 0 or r.n_quotes > 0
         or r.c_amount is not null), '[]'::jsonb),
    'companyTargets', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'channel', channel, 'level', lvl,
        'amount', amount)) from tg where seller_id is null), '[]'::jsonb),
    'sellerTargets', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'level', lvl, 'amount', a))
      from (select month, lvl, sum(amount) a from tg where seller_id in (select id from sc) group by 1, 2) x), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', order_id, 'number', number, 'sellerId', seller_id,
        'amount', round(amt, 2), 'openedAt', order_date, 'expectedDate', expected_date)) from ord), '[]'::jsonb),
    'quotes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'number', number, 'sellerId', seller_id,
        'amount', round(amt, 2), 'openedAt', order_date)) from qt), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('date', h.date, 'name', h.name) order by h.date)
      from public.holidays h where (h.company_id is null or h.company_id = p_company)
        and h.date between least(v_pmm_start, v_year_start) and v_year_end), '[]'::jsonb),
    'holidayYears', jsonb_build_object(
      p_year::text, (select count(*) from public.holidays h where (h.company_id is null or h.company_id = p_company)
        and extract(year from h.date) = p_year),
      (p_year + 1)::text, (select count(*) from public.holidays h where (h.company_id is null or h.company_id = p_company)
        and extract(year from h.date) = p_year + 1)),
    'lastMonday', jsonb_build_object('date', (select d from snapd),
      'companyStatus', (select snap.status from snap where snap.seller_id is null)),
    'conversion', v_conv
  ) into v_out;
  return v_out;
end $$;

-- Destino (Visão do ano): realizado por mês e metas do ano, no escopo de quem vê.
create or replace function public.flight_plan_v2_year(p_company uuid, p_year int, p_channel text default null,
  p_seller uuid default null, p_channel_id uuid default null, p_branch uuid default null, p_state text default null,
  p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v_today date; v_chan uuid; v_to date; v jsonb;
begin
  perform public.assert_company_access(p_company);
  if p_year is null or p_year not between 2000 and 2100 then raise exception 'Ano inválido.' using errcode = '22023'; end if;
  if p_channel is not null and p_channel not in ('varejo', 'licitacao') then
    raise exception 'Canal inválido.' using errcode = '22023';
  end if;
  v_today := public.data_as_of(p_company);
  v_to := least(make_date(p_year, 12, 31), v_today);
  if p_channel_id is not null then
    v_chan := coalesce((select id from public.channels where id = p_channel_id and company_id = p_company),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  elsif p_channel is not null then
    v_chan := coalesce((select id from public.channels where company_id = p_company and lower(name) = p_channel order by id limit 1),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  end if;
  with sc as (
    select se.id from public.sellers se where se.company_id = p_company and (p_seller is null or se.id = p_seller)
      and (v_chan is null or se.channel_id = v_chan) and (p_branch is null or se.branch_id = p_branch)
  ), tg as (
    select t.seller_id, t.month, t.level::text lvl, t.amount, lower(ch.name) channel
    from public.sales_targets t left join public.channels ch on ch.id = t.channel_id
    where t.company_id = p_company and t.year = p_year and t.active
  )
  select jsonb_build_object(
    'today', v_today,
    'restricted', public.is_seller_restricted(auth.uid()),
    'config', coalesce((select config from public.metric_config where metric_key = 'flight_plan'), '{}'::jsonb),
    'company', (select jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name) from public.companies c where c.id = p_company),
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'amount', round(a, 2)) order by m) from (
        select extract(month from f.competence_date)::int m, sum(f.amount) a
        from public.fact_sales(p_company, make_date(p_year, 1, 1), greatest(v_to, make_date(p_year, 1, 1)), v_chan,
          p_branch, p_seller, p_state, p_city, p_category) f
        where f.competence_date <= v_to group by 1) x), '[]'::jsonb),
    'companyTargets', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'channel', channel, 'level', lvl,
        'amount', amount)) from tg where seller_id is null), '[]'::jsonb),
    'sellerTargets', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'level', lvl, 'amount', a))
      from (select month, lvl, sum(amount) a from tg where seller_id in (select id from sc) group by 1, 2) x), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('date', h.date, 'name', h.name) order by h.date)
      from public.holidays h where (h.company_id is null or h.company_id = p_company)
        and extract(year from h.date) = p_year), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- Rota: listas de alvos. Contagem e soma de tudo; itens limitados (os maiores primeiro).
create or replace function public.flight_plan_v2_target_lists(p_company uuid, p_channel text default null,
  p_seller uuid default null, p_limit int default null, p_channel_id uuid default null, p_branch uuid default null,
  p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_today date; v_chan uuid; v_cfg jsonb; v_limit int; v_inactive int; v_back int; v jsonb;
begin
  perform public.assert_company_access(p_company);
  if p_channel is not null and p_channel not in ('varejo', 'licitacao') then
    raise exception 'Canal inválido.' using errcode = '22023';
  end if;
  v_today := public.data_as_of(p_company);
  select config into v_cfg from public.metric_config where metric_key = 'flight_plan';
  v_limit := least(greatest(coalesce(p_limit, (v_cfg->'targetLists'->>'maxItems')::int, 200), 1), 500);
  v_inactive := coalesce((v_cfg->'targetLists'->>'inactiveDays')::int, 90);
  v_back := coalesce((v_cfg->'targetLists'->>'lookbackDays')::int, 365);
  if p_channel_id is not null then
    v_chan := coalesce((select id from public.channels where id = p_channel_id and company_id = p_company),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  elsif p_channel is not null then
    v_chan := coalesce((select id from public.channels where company_id = p_company and lower(name) = p_channel order by id limit 1),
                       '00000000-0000-0000-0000-000000000000'::uuid);
  end if;
  with qt as (
    select o.id, o.number, o.seller_id, o.order_date, cu.name customer, se.name seller,
      coalesce((select sum(it.total) from public.sales_order_items it join public.products pr on pr.id = it.product_id
                where it.order_id = o.id and (p_category is null or pr.category = p_category)),
               case when p_category is null then o.total end) amt
    from public.sales_orders o
    left join public.customers cu on cu.id = o.customer_id
    left join public.sellers se on se.id = o.seller_id
    where o.company_id = p_company and o.source = 'omie' and o.operation_scope = 'commercial'
      and o.stage_code = '10' and o.status = 'open' and o.order_date <= v_today
      and (v_chan is null or o.channel_id = v_chan) and (p_seller is null or o.seller_id = p_seller)
      and (p_branch is null or o.branch_id = p_branch)
      and (p_state is null or cu.state = p_state) and (p_city is null or cu.city = p_city)
      and (p_category is null or exists (select 1 from public.sales_order_items it join public.products pr on pr.id = it.product_id
           where it.order_id = o.id and pr.category = p_category))
  ), lt as (
    select o.order_id id, o.number, o.seller_id, o.expected_date, cu.name customer, se.name seller, sum(o.amount) amt
    from public.fact_orders(p_company, v_chan, p_branch, p_seller, p_state, p_city, p_category) o
    left join public.customers cu on cu.id = o.customer_id
    left join public.sellers se on se.id = o.seller_id
    where o.status = 'open' and o.order_date <= v_today and o.expected_date < v_today
    group by 1, 2, 3, 4, 5, 6
  ), buys as (
    select f.customer_id, max(f.competence_date) last_d, sum(f.amount) total,
      (array_agg(f.seller_id order by f.competence_date desc, f.invoice_id))[1] seller_id
    from public.fact_sales(p_company, v_today - v_back, v_today, v_chan, p_branch, p_seller, p_state, p_city, p_category) f
    group by 1
  ), ina as (
    select b.customer_id id, cu.name customer, b.seller_id, se.name seller, b.last_d, b.total
    from buys b left join public.customers cu on cu.id = b.customer_id left join public.sellers se on se.id = b.seller_id
    where b.last_d < v_today - v_inactive
  )
  select jsonb_build_object(
    'today', v_today, 'limit', v_limit, 'inactiveDays', v_inactive, 'lookbackDays', v_back,
    'quotes', jsonb_build_object('count', (select count(*) from qt), 'amount', coalesce((select round(sum(amt), 2) from qt), 0),
      'items', coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', id, 'number', number, 'sellerId', seller_id,
        'seller', seller, 'customer', customer, 'amount', round(amt, 2), 'openedAt', order_date) x
        from qt order by amt desc nulls last, order_date limit v_limit) y), '[]'::jsonb)),
    'lateOrders', jsonb_build_object('count', (select count(*) from lt), 'amount', coalesce((select round(sum(amt), 2) from lt), 0),
      'items', coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', id, 'number', number, 'sellerId', seller_id,
        'seller', seller, 'customer', customer, 'amount', round(amt, 2), 'expectedDate', expected_date) x
        from lt order by amt desc nulls last, expected_date limit v_limit) y), '[]'::jsonb)),
    'inactiveCustomers', jsonb_build_object('count', (select count(*) from ina),
      'amount', coalesce((select round(sum(total), 2) from ina), 0),
      'items', coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', id, 'customer', customer, 'sellerId', seller_id,
        'seller', seller, 'amount', round(total, 2), 'lastPurchase', last_d) x
        from ina order by total desc nulls last, last_d limit v_limit) y), '[]'::jsonb))
  ) into v;
  return v;
end $$;

-- ============ 7. Wrappers de escrita (SECURITY INVOKER; a regra está no esquema interno) ============
create or replace function public.flight_plan_targets_month(p_company uuid, p_year int, p_month int)
returns jsonb language sql stable as $$ select flight_plan_internal.targets_month(p_company, p_year, p_month) $$;
create or replace function public.flight_plan_save_targets(p_company uuid, p_year int, p_month int, p_changes jsonb)
returns jsonb language sql as $$ select flight_plan_internal.save_targets(p_company, p_year, p_month, p_changes) $$;
create or replace function public.flight_plan_set_commit(p_company uuid, p_seller uuid, p_year int, p_month int,
  p_amount numeric, p_note text)
returns void language sql as $$ select flight_plan_internal.set_commit(p_company, p_seller, p_year, p_month, p_amount, p_note) $$;
create or replace function public.flight_plan_save_initiative(p_initiative jsonb)
returns uuid language sql as $$ select flight_plan_internal.save_initiative(p_initiative) $$;
create or replace function public.flight_plan_set_initiative_status(p_id uuid, p_status text, p_realized numeric, p_note text)
returns uuid language sql as $$ select flight_plan_internal.set_initiative_status(p_id, p_status, p_realized, p_note) $$;
create or replace function public.flight_plan_set_alert_state(p_alert jsonb)
returns jsonb language sql as $$ select flight_plan_internal.set_alert_state(p_alert) $$;
create or replace function public.flight_plan_sync_alerts(p_company uuid, p_year int, p_month int, p_subjects text[], p_alerts jsonb)
returns jsonb language sql as $$ select flight_plan_internal.sync_alerts(p_company, p_year, p_month, p_subjects, p_alerts) $$;
create or replace function public.flight_plan_add_decision(p_company uuid, p_week date, p_text text)
returns uuid language sql as $$ select flight_plan_internal.add_decision(p_company, p_week, p_text) $$;
create or replace function public.flight_plan_history(p_company uuid, p_area text default null, p_limit int default 50)
returns jsonb language sql stable as $$ select flight_plan_internal.history(p_company, p_area, p_limit) $$;

-- ============ 8. Permissões ============
revoke all on all functions in schema flight_plan_internal from public, anon, authenticated;
grant execute on function flight_plan_internal.is_manager(uuid), flight_plan_internal.require_company(uuid),
  flight_plan_internal.require_person(uuid), flight_plan_internal.check_period(int, int),
  flight_plan_internal.can_edit_seller(uuid, uuid, uuid), flight_plan_internal.targets_month(uuid, int, int),
  flight_plan_internal.save_targets(uuid, int, int, jsonb),
  flight_plan_internal.set_commit(uuid, uuid, int, int, numeric, text),
  flight_plan_internal.can_write_initiative(uuid, uuid, uuid[], uuid, uuid),
  flight_plan_internal.save_initiative(jsonb), flight_plan_internal.set_initiative_status(uuid, text, numeric, text),
  flight_plan_internal.set_alert_state(jsonb), flight_plan_internal.sync_alerts(uuid, int, int, text[], jsonb),
  flight_plan_internal.add_decision(uuid, date, text), flight_plan_internal.history(uuid, text, int),
  flight_plan_internal.conversion(uuid, date, uuid, uuid)
to authenticated, service_role;
revoke all on function flight_plan_internal.audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated, service_role;

revoke all on function public.flight_plan_v2_me(), public.flight_plan_v2_dataset(uuid, int, int, jsonb, text, uuid, date, uuid, uuid, text, text, text),
  public.flight_plan_v2_year(uuid, int, text, uuid, uuid, uuid, text, text, text), public.flight_plan_v2_target_lists(uuid, text, uuid, int, uuid, uuid, text, text, text),
  public.flight_plan_targets_month(uuid, int, int), public.flight_plan_save_targets(uuid, int, int, jsonb),
  public.flight_plan_set_commit(uuid, uuid, int, int, numeric, text), public.flight_plan_save_initiative(jsonb),
  public.flight_plan_set_initiative_status(uuid, text, numeric, text), public.flight_plan_set_alert_state(jsonb),
  public.flight_plan_sync_alerts(uuid, int, int, text[], jsonb), public.flight_plan_add_decision(uuid, date, text),
  public.flight_plan_history(uuid, text, int)
from public, anon;
grant execute on function public.flight_plan_v2_me(), public.flight_plan_v2_dataset(uuid, int, int, jsonb, text, uuid, date, uuid, uuid, text, text, text),
  public.flight_plan_v2_year(uuid, int, text, uuid, uuid, uuid, text, text, text), public.flight_plan_v2_target_lists(uuid, text, uuid, int, uuid, uuid, text, text, text),
  public.flight_plan_targets_month(uuid, int, int), public.flight_plan_save_targets(uuid, int, int, jsonb),
  public.flight_plan_set_commit(uuid, uuid, int, int, numeric, text), public.flight_plan_save_initiative(jsonb),
  public.flight_plan_set_initiative_status(uuid, text, numeric, text), public.flight_plan_set_alert_state(jsonb),
  public.flight_plan_sync_alerts(uuid, int, int, text[], jsonb), public.flight_plan_add_decision(uuid, date, text),
  public.flight_plan_history(uuid, text, int)
to authenticated, service_role;

insert into public.audit_log(actor_id, action, entity, entity_id, payload)
values (null, 'migration.0050', 'flight_plan', 'v2', jsonb_build_object(
  'decisions', jsonb_build_array('D1 meta da empresa por canal + distribuição por vendedor',
    'D2 sábado 0,33 na MAG Filial e na Uni Design, 0 nas demais', 'D3 pedido com previsão vencida pesa 30%',
    'D4 orçamentos à parte, fora da previsão', 'D5 Admin e Diretoria editam a meta da empresa; Gestor os próprios vendedores',
    'Compromisso: Admin, Diretoria, Gestor do vendedor ou o próprio vendedor',
    'Responsável de iniciativa: pessoa com acesso ou vendedor (com ou sem login)'),
  'sellerChannel', 'official-seller-2026-09-29'));

notify pgrst, 'reload schema';
