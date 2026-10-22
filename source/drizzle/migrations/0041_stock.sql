-- Estoque (fase 1): posição de estoque do Omie por empresa, produto e local; curva por produto;
-- cenários de liquidação por usuário; liberação gradual do módulo. Somente acréscimos.
--
-- Só o worker grava leituras (funções stock_worker_*, apenas service_role). A tela lê por funções
-- públicas SECURITY INVOKER que chamam stock_internal (SECURITY DEFINER, search_path fixo, fora
-- dos esquemas expostos pela API). Permissão, escopo de empresa e custo são decididos aqui; a tela
-- só esconde o que a pessoa não pode usar. Uma leitura só vira a posição exibida quando todas as
-- páginas chegaram e conferem com o total declarado pelo Omie.

create schema if not exists stock_internal;
revoke all on schema stock_internal from public, anon;
grant usage on schema stock_internal to authenticated;

-- ===================================================================== validações puras

create or replace function stock_internal.valid_slot(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p is not null and p ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
$$;

create or replace function stock_internal.valid_slots(p text[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p is not null and cardinality(p) <= 24
    and not exists (select 1 from unnest(p) s where not stock_internal.valid_slot(s))
$$;

-- Busca sem acento e sem diferença de maiúsculas.
create or replace function stock_internal.fold(p text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select translate(lower(coalesce(p, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
$$;

-- ===================================================================== tabelas

-- Liberação de módulos: off = escondido (Super admin entra pela URL), pilot = menu só para
-- Super admin, on = todos os perfis com permissão.
create table if not exists private.feature_flags (
  key text primary key,
  mode text not null check (mode in ('off', 'pilot', 'on')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into private.feature_flags (key, mode) values ('stock', 'off') on conflict (key) do nothing;

-- Leitura do estoque pelo worker: desligada até a validação com o Omie.
create table if not exists private.stock_settings (
  id boolean primary key default true check (id),
  reading_enabled boolean not null default false,
  slots text[] not null default array['07:40', '12:40', '17:40'] check (stock_internal.valid_slots(slots)),
  close_slot text not null default '23:50' check (stock_internal.valid_slot(close_slot)),
  manual_min_minutes integer not null default 15 check (manual_min_minutes between 5 and 240),
  stale_hours integer not null default 6 check (stale_hours between 1 and 48),
  close_retention_days integer not null default 400 check (close_retention_days between 30 and 1100),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into private.stock_settings (id) values (true) on conflict (id) do nothing;

-- Leituras: fila do worker e histórico (fechamentos diários ficam pelo prazo configurado).
create table if not exists private.stock_readings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('intraday', 'close')),
  trigger text not null check (trigger in ('schedule', 'manual')),
  slot text,
  requested_by uuid,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'complete', 'failed', 'superseded')),
  position_date date not null,
  pages_total integer check (pages_total >= 0),
  pages_done integer not null default 0 check (pages_done >= 0),
  records_expected integer check (records_expected >= 0),
  records_received integer not null default 0,
  locations jsonb,
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz
);
create unique index if not exists stock_readings_slot_uq on private.stock_readings (company_id, slot)
  where slot is not null;
create index if not exists stock_readings_queue on private.stock_readings (status, next_attempt_at, created_at);
create index if not exists stock_readings_company on private.stock_readings (company_id, created_at desc);

create table if not exists private.stock_positions (
  reading_id uuid not null references private.stock_readings(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  omie_product_id text not null,
  location_code text not null,
  sku text not null,
  name text not null,
  physical_qty numeric not null,
  balance_qty numeric,
  reserved_qty numeric not null default 0,
  pending_qty numeric not null default 0,
  min_qty numeric,
  unit_cost numeric not null,
  sale_price numeric not null default 0,
  primary key (reading_id, omie_product_id, location_code)
);

-- A leitura publicada de cada empresa (a que as telas mostram).
create table if not exists private.stock_current (
  company_id uuid primary key references public.companies(id) on delete cascade,
  reading_id uuid not null references private.stock_readings(id),
  published_at timestamptz not null default now()
);

-- Curva por produto em cada empresa; sem linha = sem curva. Sobrevive a todas as leituras.
create table if not exists private.stock_curves (
  company_id uuid not null references public.companies(id) on delete cascade,
  omie_product_id text not null,
  curve text not null check (curve in ('A', 'B', 'C', 'D')),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (company_id, omie_product_id)
);

-- Cenários de liquidação de cada usuário (até 5).
create table if not exists private.stock_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  cuts jsonb not null,
  discount integer not null check (discount between 0 and 70),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stock_scenarios_user on private.stock_scenarios (user_id);

revoke all on private.feature_flags, private.stock_settings, private.stock_readings,
  private.stock_positions, private.stock_current, private.stock_curves, private.stock_scenarios
  from public, anon, authenticated;

-- ===================================================================== permissões extras

-- Três permissões por usuário no Admin 2.0, para dar a alguém (compras, por exemplo) o que o
-- papel dele não dá.
alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'documents:view_full', 'finance.view_summary', 'finance.view_titles',
  'finance.view_customer_details', 'finance.view_overdue', 'finance.export',
  'stock.view_cost', 'stock.classify', 'stock.export'));

-- Mesmo corpo da 0040, só com a lista de permissões conhecidas ampliada.
create or replace function admin_internal.apply_access(p_user uuid, p_access jsonb, p_creating boolean, p_dry boolean)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_super boolean := admin_internal.is_super();
  v_scope uuid[] := admin_internal.actor_company_ids();
  v_known_roles constant text[] := array['SUPER_ADMIN','ADMIN','DIRETORIA','GESTOR','VENDEDOR','FINANCEIRO','ANALISTA','VIEWER'];
  v_known_perms constant text[] := array['documents:view_full','finance.view_summary','finance.view_titles',
    'finance.view_customer_details','finance.view_overdue','finance.export',
    'stock.view_cost','stock.classify','stock.export'];
  v_cur_roles text[]; v_roles text[];
  v_cur_companies uuid[]; v_companies uuid[]; v_req uuid[]; v_added uuid[]; v_removed uuid[];
  v_cur_default uuid; v_default uuid;
  v_cur_sellers uuid[]; v_sellers uuid[]; v_req_sellers uuid[];
  v_cur_teams uuid[]; v_teams uuid[]; v_req_teams uuid[];
  v_cur_perms text[]; v_perms text[];
  v_bad text; r record;
  v_today date := (now() at time zone 'America/Fortaleza')::date;
begin
  select coalesce(array_agg(role::text), '{}') into v_cur_roles from public.user_roles where user_id = p_user;
  select coalesce(array_agg(company_id), '{}') into v_cur_companies from public.user_company_access where user_id = p_user;
  select default_company_id into v_cur_default from public.profiles where id = p_user;
  select coalesce(array_agg(id), '{}') into v_cur_sellers from public.sellers where user_id = p_user;
  select coalesce(array_agg(team_id), '{}') into v_cur_teams from public.sales_team_managers
    where user_id = p_user and valid_to is null;
  select coalesce(array_agg(permission), '{}') into v_cur_perms from public.user_permissions where user_id = p_user;

  -- Papéis: na criação, Admin só concede papéis operacionais; depois, só o Super admin altera.
  v_roles := v_cur_roles;
  if p_access ? 'roles' then
    select coalesce(array_agg(distinct x), '{}') into v_roles from jsonb_array_elements_text(p_access->'roles') as e(x);
    select string_agg(x, ', ') into v_bad from unnest(v_roles) x where not x = any(v_known_roles);
    if v_bad is not null then raise exception 'Papel desconhecido: %.', v_bad; end if;
    if p_creating then
      if cardinality(v_roles) = 0 then raise exception 'Escolha pelo menos um papel.'; end if;
      if not v_super then
        select string_agg(admin_internal.role_label(x), ', ') into v_bad from unnest(v_roles) x
          where x in ('SUPER_ADMIN', 'ADMIN');
        if v_bad is not null then
          raise exception 'Você não pode criar usuários com o papel %.', v_bad using errcode = '42501';
        end if;
      end if;
    elsif not (v_roles @> v_cur_roles and v_cur_roles @> v_roles) then
      if not v_super then raise exception 'Somente o Super admin altera papéis.' using errcode = '42501'; end if;
      if p_user = v_actor and not (v_roles && array['SUPER_ADMIN', 'ADMIN']) then
        raise exception 'Você não pode remover o próprio acesso de administrador.' using errcode = '42501';
      end if;
    end if;
  elsif p_creating then
    raise exception 'Escolha pelo menos um papel.';
  end if;

  -- Empresas: o ator só concede ou retira as que ele mesmo acessa; as demais ficam como estão.
  v_companies := v_cur_companies;
  if p_access ? 'companyIds' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_req from jsonb_array_elements_text(p_access->'companyIds') as e(x);
    if exists (select 1 from unnest(v_req) x where not exists (select 1 from public.companies c where c.id = x)) then
      raise exception 'Empresa não encontrada.';
    end if;
    select string_agg(c.name, ', ' order by c.name) into v_bad from public.companies c
      where c.id = any(v_req) and not c.id = any(v_scope);
    if v_bad is not null then
      raise exception 'Você não pode conceder a empresa %.', v_bad using errcode = '42501';
    end if;
    select coalesce(array_agg(distinct x), '{}') into v_companies from (
      select c as x from unnest(v_cur_companies) c where not c = any(v_scope)
      union all select q from unnest(v_req) q) s;
  end if;
  if cardinality(v_companies) = 0 then
    if p_creating then raise exception 'Escolha pelo menos uma empresa.'; end if;
    raise exception 'O usuário precisa ter pelo menos uma empresa.';
  end if;
  select coalesce(array_agg(x), '{}') into v_added from unnest(v_companies) x where not x = any(v_cur_companies);
  select coalesce(array_agg(x), '{}') into v_removed from unnest(v_cur_companies) x where not x = any(v_companies);

  -- Empresa padrão: precisa ser uma das empresas do usuário.
  v_default := v_cur_default;
  if nullif(p_access->>'defaultCompanyId', '') is not null then
    v_default := (p_access->>'defaultCompanyId')::uuid;
    if not v_default = any(v_companies) then
      raise exception 'A empresa padrão precisa ser uma das empresas escolhidas.';
    end if;
  end if;
  if v_default is null or not v_default = any(v_companies) then
    select c.id into v_default from public.companies c where c.id = any(v_companies) order by c.is_demo, c.name limit 1;
  end if;

  -- Vendedor do Omie: ativo, sem login de outra pessoa, um por empresa, de empresa do usuário.
  v_sellers := v_cur_sellers;
  if p_access ? 'sellerIds' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_req_sellers from jsonb_array_elements_text(p_access->'sellerIds') as e(x);
    if (select count(*) from public.sellers s where s.id = any(v_req_sellers)) <> cardinality(v_req_sellers) then
      raise exception 'Vendedor do Omie não encontrado.';
    end if;
    for r in select s.id, s.name, s.company_id, s.active, s.user_id from public.sellers s where s.id = any(v_req_sellers) loop
      if not r.company_id = any(v_companies) then
        raise exception '% é de uma empresa que o usuário não acessa.', r.name;
      end if;
      if not r.company_id = any(v_scope) then
        raise exception 'Você não pode vincular vendedores de outras empresas.' using errcode = '42501';
      end if;
      -- Inativo só passa se já era o vendedor desta mesma pessoa.
      if not r.active and not (p_user is not null and r.user_id = p_user) then
        raise exception '% está inativo no Omie.', r.name;
      end if;
      if r.user_id is not null and r.user_id is distinct from p_user then
        raise exception '% já tem login vinculado.', r.name;
      end if;
    end loop;
    if exists (select 1 from public.sellers s where s.id = any(v_req_sellers) group by s.company_id having count(*) > 1) then
      raise exception 'Apenas um vendedor do Omie por empresa.';
    end if;
    select coalesce(array_agg(distinct x), '{}') into v_sellers from (
      select s.id as x from public.sellers s where s.user_id = p_user and not s.company_id = any(v_scope)
      union all select q from unnest(v_req_sellers) q) z;
  end if;
  if not 'VENDEDOR' = any(v_roles) then
    -- Vínculo de vendedor só vale para o papel Vendedor (os de fora do alcance do ator ficam).
    select coalesce(array_agg(s.id), '{}') into v_sellers from public.sellers s
      where s.id = any(v_sellers) and not s.company_id = any(v_scope);
  end if;
  select coalesce(array_agg(s.id), '{}') into v_sellers from public.sellers s
    where s.id = any(v_sellers) and s.company_id = any(v_companies);
  if 'VENDEDOR' = any(v_roles) and cardinality(v_sellers) = 0 then
    raise exception 'Vendedor precisa estar vinculado a um vendedor do Omie.';
  end if;

  -- Equipes que gerencia: de empresas do usuário e do alcance do ator; só para o papel Gestor.
  v_teams := v_cur_teams;
  if p_access ? 'managedTeamIds' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_req_teams from jsonb_array_elements_text(p_access->'managedTeamIds') as e(x);
    if (select count(*) from public.sales_teams t where t.id = any(v_req_teams)) <> cardinality(v_req_teams) then
      raise exception 'Equipe não encontrada.';
    end if;
    if exists (select 1 from public.sales_teams t where t.id = any(v_req_teams) and not t.company_id = any(v_companies)) then
      raise exception 'Equipe de empresa à qual o usuário não tem acesso.';
    end if;
    if exists (select 1 from public.sales_teams t where t.id = any(v_req_teams) and not t.company_id = any(v_scope)) then
      raise exception 'Você não pode atribuir equipes de outras empresas.' using errcode = '42501';
    end if;
    select coalesce(array_agg(distinct x), '{}') into v_teams from (
      select m.team_id as x from public.sales_team_managers m join public.sales_teams t on t.id = m.team_id
        where m.user_id = p_user and m.valid_to is null and not t.company_id = any(v_scope)
      union all select q from unnest(v_req_teams) q) z;
  end if;
  if not 'GESTOR' = any(v_roles) then
    select coalesce(array_agg(t.id), '{}') into v_teams from public.sales_teams t
      where t.id = any(v_teams) and not t.company_id = any(v_scope);
  end if;
  select coalesce(array_agg(t.id), '{}') into v_teams from public.sales_teams t
    where t.id = any(v_teams) and t.company_id = any(v_companies);

  -- Permissões extras.
  v_perms := v_cur_perms;
  if p_access ? 'permissions' then
    select coalesce(array_agg(distinct x), '{}') into v_perms from jsonb_array_elements_text(p_access->'permissions') as e(x);
    select string_agg(x, ', ') into v_bad from unnest(v_perms) x where not x = any(v_known_perms);
    if v_bad is not null then raise exception 'Permissão desconhecida: %.', v_bad; end if;
  end if;

  if p_dry then return; end if;

  update public.profiles set default_company_id = v_default
    where id = p_user and default_company_id is distinct from v_default;
  insert into public.user_company_access (user_id, company_id) select p_user, x from unnest(v_added) x on conflict do nothing;
  delete from public.user_company_access where user_id = p_user and company_id = any(v_removed);
  -- O gatilho de user_roles audita cada papel concedido ou retirado, com o ator da sessão.
  insert into public.user_roles (user_id, role)
    select p_user, x::public.app_role from unnest(v_roles) x where not x = any(v_cur_roles) on conflict do nothing;
  delete from public.user_roles where user_id = p_user and not role::text = any(v_roles);
  update public.sellers set user_id = null where user_id = p_user and not id = any(v_sellers);
  update public.sellers set user_id = p_user where id = any(v_sellers) and user_id is distinct from p_user;
  -- Histórico de gestão de equipes é preservado: fecha a vigência em vez de apagar.
  update public.sales_team_managers set valid_to = v_today
    where user_id = p_user and valid_to is null and not team_id = any(v_teams);
  insert into public.sales_team_managers (team_id, user_id, valid_from)
    select x, p_user, v_today from unnest(v_teams) x where not x = any(v_cur_teams);
  delete from public.user_permissions where user_id = p_user and not permission = any(v_perms);
  insert into public.user_permissions (user_id, permission, granted_by)
    select p_user, x, v_actor from unnest(v_perms) x where not x = any(v_cur_perms)
    on conflict (user_id, permission) do nothing;

  if p_creating then return; end if;
  perform admin_internal.log('company.granted', 'user', p_user::text, x,
      jsonb_build_object('empresas', to_jsonb(v_cur_companies)), jsonb_build_object('empresas', to_jsonb(v_companies)))
    from unnest(v_added) x;
  perform admin_internal.log('company.revoked', 'user', p_user::text, x,
      jsonb_build_object('empresas', to_jsonb(v_cur_companies)), jsonb_build_object('empresas', to_jsonb(v_companies)))
    from unnest(v_removed) x;
  if not (v_perms @> v_cur_perms and v_cur_perms @> v_perms) then
    perform admin_internal.log('permission.changed', 'user', p_user::text, v_default,
      jsonb_build_object('permissoes', to_jsonb(v_cur_perms)), jsonb_build_object('permissoes', to_jsonb(v_perms)));
  end if;
  if not (v_sellers @> v_cur_sellers and v_cur_sellers @> v_sellers) then
    perform admin_internal.log('user.updated', 'user', p_user::text, v_default,
      jsonb_build_object('vendedores', (select coalesce(jsonb_agg(name order by name), '[]') from public.sellers where id = any(v_cur_sellers))),
      jsonb_build_object('vendedores', (select coalesce(jsonb_agg(name order by name), '[]') from public.sellers where id = any(v_sellers))));
  end if;
  if not (v_teams @> v_cur_teams and v_cur_teams @> v_teams) then
    perform admin_internal.log('user.updated', 'user', p_user::text, v_default,
      jsonb_build_object('equipes', (select coalesce(jsonb_agg(name order by name), '[]') from public.sales_teams where id = any(v_cur_teams))),
      jsonb_build_object('equipes', (select coalesce(jsonb_agg(name order by name), '[]') from public.sales_teams where id = any(v_teams))));
  end if;
  if v_default is distinct from v_cur_default then
    perform admin_internal.log('user.updated', 'user', p_user::text, v_default,
      jsonb_build_object('empresaPadrao', v_cur_default), jsonb_build_object('empresaPadrao', v_default));
  end if;
end $$;

-- ===================================================================== auxiliares

create or replace function stock_internal.roles() returns text[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(array_agg(r.role::text), '{}') from public.user_roles r where r.user_id = auth.uid()
$$;

create or replace function stock_internal.perms() returns text[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(array_agg(p.permission), '{}') from public.user_permissions p where p.user_id = auth.uid()
$$;

create or replace function stock_internal.is_super() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select auth.uid() is not null and public.has_role(auth.uid(), 'SUPER_ADMIN')
$$;

create or replace function stock_internal.mode() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select f.mode from private.feature_flags f where f.key = 'stock'), 'off')
$$;

-- O que o usuário pode fazer no Estoque. O custo (CMC) segue a regra do Financeiro; a curva
-- fica com quem decide compras; VIEWER não entra. Permissões extras ampliam, nunca reduzem.
create or replace function stock_internal.caps() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  r text[] := stock_internal.roles();
  p text[] := stock_internal.perms();
  v_view boolean;
  v_cost boolean;
  v_classify boolean;
  v_save boolean;
  v_export boolean;
  v_refresh boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('view', false, 'viewCost', false, 'classify', false,
      'saveScenarios', false, 'export', false, 'refresh', false);
  end if;
  v_view := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR', 'FINANCEIRO', 'ANALISTA', 'VENDEDOR']
    or p && array['stock.view_cost', 'stock.classify', 'stock.export'];
  v_cost := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR', 'FINANCEIRO', 'ANALISTA']
    or 'stock.view_cost' = any(p);
  v_classify := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR'] or 'stock.classify' = any(p);
  v_save := v_cost and (r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR', 'FINANCEIRO']
    or 'stock.classify' = any(p));
  v_export := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'FINANCEIRO'] or 'stock.export' = any(p);
  v_refresh := r && array['SUPER_ADMIN', 'ADMIN'];
  return jsonb_build_object('view', v_view, 'viewCost', v_view and v_cost, 'classify', v_view and v_classify,
    'saveScenarios', v_view and v_save, 'export', v_view and v_export, 'refresh', v_view and v_refresh);
end $$;

-- Barra quem não pode usar o recurso pedido; devolve as capacidades.
create or replace function stock_internal.require(p_cap text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_caps jsonb := stock_internal.caps();
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta para acessar o Estoque.' using errcode = '42501';
  end if;
  if stock_internal.mode() <> 'on' and not stock_internal.is_super() then
    raise exception 'O módulo Estoque ainda não foi liberado.' using errcode = '42501';
  end if;
  if not (v_caps->>'view')::boolean then
    raise exception 'Seu perfil não tem acesso ao Estoque.' using errcode = '42501';
  end if;
  if p_cap <> 'view' and not coalesce((v_caps->>p_cap)::boolean, false) then
    raise exception '%', case p_cap
      when 'viewCost' then 'Seu perfil pode ver quantidades, mas não custos ou simulações.'
      when 'classify' then 'Você não pode classificar curvas.'
      when 'saveScenarios' then 'Você não pode salvar cenários.'
      when 'export' then 'Você não pode exportar o estoque.'
      when 'refresh' then 'Você não pode solicitar leitura.'
      else 'Acesso negado.' end using errcode = '42501';
  end if;
  return v_caps;
end $$;

-- 'all' ou o id de uma empresa -> empresas reais (com estoque) que o usuário acessa.
create or replace function stock_internal.scope(p_company text) returns uuid[]
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_id uuid;
  v uuid[];
begin
  if p_company is null or p_company = 'all' then
    v_id := null;
  elsif p_company ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_id := p_company::uuid;
  else
    raise exception 'Empresa inválida.' using errcode = 'P0001';
  end if;
  if v_id is not null and not public.can_access_company(auth.uid(), v_id) then
    raise exception 'Empresa fora do seu acesso.' using errcode = '42501';
  end if;
  -- Empresas de demonstração não têm estoque: ficam fora sem erro.
  select coalesce(array_agg(c.id order by c.name), '{}') into v from public.companies c
    where not c.is_demo and (v_id is null or c.id = v_id)
      and public.can_access_company(auth.uid(), c.id);
  return v;
end $$;

-- Posições publicadas (última leitura completa de cada empresa) com curva, produto e local.
create or replace function stock_internal.current_rows(p_companies uuid[])
returns table (company_id uuid, company_name text, omie_product_id text, location_code text, sku text,
  name text, physical_qty numeric, reserved_qty numeric, pending_qty numeric, min_qty numeric,
  unit_cost numeric, sale_price numeric, curve text, product_id uuid, family text, location_name text,
  read_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select sp.company_id, c.name, sp.omie_product_id, sp.location_code, sp.sku, sp.name,
         sp.physical_qty, sp.reserved_qty, sp.pending_qty, sp.min_qty, sp.unit_cost, sp.sale_price,
         coalesce(cu.curve, 'U'), p.id, coalesce(nullif(cp.family, ''), nullif(p.category, '')),
         nullif(r.locations -> sp.location_code ->> 'name', ''), r.finished_at
  from private.stock_current sc
  join private.stock_readings r on r.id = sc.reading_id
  join private.stock_positions sp on sp.reading_id = sc.reading_id
  join public.companies c on c.id = sc.company_id
  left join private.stock_curves cu on cu.company_id = sp.company_id and cu.omie_product_id = sp.omie_product_id
  left join public.products p
    on p.company_id = sp.company_id and p.source = 'omie' and p.external_id = sp.omie_product_id
  left join public.canonical_products cp
    on cp.company_id = sp.company_id and cp.source = 'omie' and cp.external_id = sp.omie_product_id
  where sc.company_id = any(p_companies)
$$;

create or replace function stock_internal.log(p_action text, p_company uuid, p_payload jsonb) returns void
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (auth.uid(), p_action, 'stock', p_company::text,
          jsonb_strip_nulls(jsonb_build_object('companyId', p_company) || coalesce(p_payload, '{}'::jsonb)))
$$;

-- ===================================================================== leitura pela tela

create or replace function stock_internal.features() returns text[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case
    when auth.uid() is null then '{}'::text[]
    when stock_internal.mode() = 'on' and (stock_internal.caps()->>'view')::boolean then array['stock']
    when stock_internal.mode() = 'pilot' and stock_internal.is_super() then array['stock']
    else '{}'::text[] end
$$;

create or replace function stock_internal.overview(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_admin boolean := (v_caps->>'refresh')::boolean;
  v_scope uuid[] := stock_internal.scope(p_company);
  v_stale interval := make_interval(hours => (select s.stale_hours from private.stock_settings s));
  v jsonb;
begin
  with x as (select * from stock_internal.current_rows(v_scope)),
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
      coalesce(sum(x.physical_qty), 0) as units, coalesce(sum(x.physical_qty * x.unit_cost), 0) as cost_value
    from unnest(array['A', 'B', 'C', 'D', 'U']) with ordinality as k(curve, ord)
    left join x on x.curve = k.curve
    group by k.curve, k.ord),
  co as (
    select s.id as company_id, cmp.name as company_name, s.ord,
      (select count(*) from x where x.company_id = s.id)::integer as positions,
      (select coalesce(sum(x.physical_qty * x.unit_cost), 0) from x where x.company_id = s.id) as cost_value
    from unnest(v_scope) with ordinality as s(id, ord) join public.companies cmp on cmp.id = s.id),
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
    'totals', (select jsonb_build_object('positions', t.positions, 'positionsWithStock', t.with_stock,
        'units', t.units, 'costValue', case when v_cost then t.cost_value end,
        'reservedQty', t.reserved, 'pendingQty', t.pending, 'negativePositions', t.negative,
        'unclassifiedPositions', t.unclassified,
        'unclassifiedCostValue', case when v_cost then t.unclassified_cost end,
        'belowMinPositions', t.below_min) from t),
    'byCurve', (select jsonb_agg(jsonb_build_object('curve', c.curve, 'positions', c.positions, 'units', c.units,
        'costValue', case when v_cost then c.cost_value end,
        'share', case when v_cost and t.cost_value > 0 then round(c.cost_value / t.cost_value * 100, 4) end)
      order by c.ord) from c, t),
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
  v_search text := nullif(stock_internal.fold(btrim(coalesce(p_query->>'search', ''))), '');
  v_curve text := coalesce(nullif(p_query->>'curve', ''), 'all');
  v_location text := nullif(p_query->>'locationCode', '');
  v_family text := nullif(p_query->>'family', '');
  v_negative boolean := coalesce((p_query->>'onlyNegative')::boolean, false);
  v_hide_zero boolean := coalesce((p_query->>'hideZero')::boolean, false);
  v_below_min boolean := coalesce((p_query->>'belowMin')::boolean, false);
  v_product text := nullif(p_query->>'productId', '');
  v_sort text := coalesce(nullif(p_query->>'sortBy', ''), 'costValue');
  v_dir text := coalesce(nullif(p_query->>'sortDir', ''), 'desc');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_total integer;
  v_rows jsonb;
begin
  if v_curve not in ('all', 'A', 'B', 'C', 'D', 'U')
     or v_sort not in ('costValue', 'physicalQty', 'name', 'sku')
     or v_dir not in ('asc', 'desc') or v_page < -1 or v_page > 1000
     or char_length(coalesce(v_search, '')) > 120 then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  -- page = -1: todas as linhas do filtro, só para exportação.
  if v_page = -1 then perform stock_internal.require('export'); end if;
  -- Sem acesso a custo, a ordem padrão (valor a custo) vira nome em ordem alfabética.
  if v_sort = 'costValue' and not v_cost then
    v_sort := 'name';
    v_dir := 'asc';
  end if;

  with x as (
    select r.*, r.physical_qty * r.unit_cost as cost_value
    from stock_internal.current_rows(v_scope) r
    where (v_search is null or strpos(stock_internal.fold(r.name || ' ' || r.sku), v_search) > 0)
      and (v_curve = 'all' or r.curve = v_curve)
      and (v_location is null or r.location_code = v_location)
      and (v_family is null or r.family = v_family)
      and (not v_negative or r.physical_qty < 0)
      and (not v_hide_zero or r.physical_qty <> 0 or r.reserved_qty <> 0 or r.pending_qty <> 0)
      and (not v_below_min or (r.min_qty > 0 and r.physical_qty < r.min_qty))
      and (v_product is null or r.product_id::text = v_product)),
  o as (
    select x.*, count(*) over () as total_count,
      row_number() over (order by
        case when v_dir = 'asc' then case v_sort when 'costValue' then x.cost_value
          when 'physicalQty' then x.physical_qty end end asc nulls last,
        case when v_dir = 'desc' then case v_sort when 'costValue' then x.cost_value
          when 'physicalQty' then x.physical_qty end end desc nulls last,
        case when v_dir = 'asc' then case v_sort when 'name' then x.name when 'sku' then x.sku end end asc,
        case when v_dir = 'desc' then case v_sort when 'name' then x.name when 'sku' then x.sku end end desc,
        x.name, x.sku, x.company_name, x.location_code) as rn
    from x)
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', o.company_id::text || ':' || o.omie_product_id || ':' || o.location_code,
      'companyId', o.company_id, 'companyName', o.company_name, 'productId', o.product_id,
      'omieProductId', o.omie_product_id, 'sku', o.sku, 'name', o.name, 'family', o.family,
      'locationCode', o.location_code, 'locationName', o.location_name, 'curve', o.curve,
      'physicalQty', o.physical_qty, 'reservedQty', o.reserved_qty, 'pendingQty', o.pending_qty,
      'minQty', o.min_qty,
      'unitCost', case when v_cost then o.unit_cost end,
      'costValue', case when v_cost then o.cost_value end,
      'salePrice', case when v_cost then o.sale_price end) order by o.rn)
      filter (where v_page = -1 or (o.rn > v_page * 100 and o.rn <= (v_page + 1) * 100)), '[]'::jsonb)
  into v_total, v_rows
  from o;
  if v_page = -1 and v_total > 20000 then
    raise exception 'A exportação vai até 20.000 posições. Refine os filtros.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('rows', v_rows, 'total', v_total);
end $$;

create or replace function stock_internal.filter_options(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_scope uuid[] := stock_internal.scope(p_company);
  v jsonb;
begin
  with x as (select * from stock_internal.current_rows(v_scope)),
  l as (select x.location_code as code, max(x.location_name) as name from x group by x.location_code)
  select jsonb_build_object(
    'locations', coalesce((select jsonb_agg(jsonb_build_object('code', l.code, 'name', l.name)
      order by coalesce(l.name, l.code)) from l), '[]'::jsonb),
    'families', coalesce((select jsonb_agg(f.family order by f.family)
      from (select distinct x.family from x where x.family is not null) f), '[]'::jsonb))
  into v;
  return v;
end $$;

create or replace function stock_internal.simulation_base(p_company text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('viewCost');
  v_scope uuid[] := stock_internal.scope(p_company);
  v jsonb;
begin
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', r.company_id::text || ':' || r.omie_product_id || ':' || r.location_code,
      'sku', r.sku, 'name', r.name, 'curve', r.curve, 'qty', r.physical_qty, 'cost', r.unit_cost,
      'price', r.sale_price, 'companyName', r.company_name, 'locationName', coalesce(r.location_name, r.location_code))
      order by r.company_name, r.name, r.sku, r.location_code), '[]'::jsonb),
    'readAt', min(r.read_at))
  into v
  from stock_internal.current_rows(v_scope) r;
  return v;
end $$;

-- ===================================================================== escrita pela tela

-- A curva vale para o produto inteiro na empresa: todos os locais mudam juntos.
create or replace function stock_internal.set_curve(p_position_ids text[], p_curve text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
  set client_min_messages = warning as $$
declare
  v_caps jsonb := stock_internal.require('classify');
  v_scope uuid[] := stock_internal.scope('all');
  v_bad integer;
  v_updated integer;
  v_company record;
begin
  if p_curve is null or p_curve not in ('A', 'B', 'C', 'D', 'U')
     or coalesce(cardinality(p_position_ids), 0) = 0 or cardinality(p_position_ids) > 5000 then
    raise exception 'Selecione posições válidas e uma curva.' using errcode = 'P0001';
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
  -- Toda posição pedida precisa existir na leitura publicada de uma empresa do usuário.
  select count(*) into v_bad from unnest(p_position_ids) x
    where not exists (select 1 from private.stock_current sc
      join private.stock_positions sp on sp.reading_id = sc.reading_id
      where sc.company_id = split_part(x, ':', 1)::uuid and sc.company_id = any(v_scope)
        and sp.omie_product_id = split_part(x, ':', 2) and sp.location_code = split_part(x, ':', 3));
  if v_bad > 0 then
    raise exception 'Selecione posições válidas e uma curva.' using errcode = 'P0001';
  end if;
  if p_curve = 'U' then
    delete from private.stock_curves c using pg_temp.stock_sel s
      where c.company_id = s.company_id and c.omie_product_id = s.omie_product_id;
  else
    insert into private.stock_curves (company_id, omie_product_id, curve, updated_at, updated_by)
      select s.company_id, s.omie_product_id, p_curve, now(), auth.uid() from pg_temp.stock_sel s
      on conflict (company_id, omie_product_id) do update
        set curve = excluded.curve, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        where private.stock_curves.curve is distinct from excluded.curve;
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
      jsonb_build_object('curva', case when p_curve = 'U' then 'Sem curva' else p_curve end,
        'produtos', v_company.products, 'amostra', to_jsonb(v_company.sample)));
  end loop;
  return jsonb_build_object('updated', v_updated);
end $$;

create or replace function stock_internal.scenario_json(s private.stock_scenarios) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'cuts', s.cuts, 'discount', s.discount,
    'updatedAt', s.updated_at)
$$;

create or replace function stock_internal.scenarios() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_caps jsonb := stock_internal.require('viewCost');
begin
  return coalesce((select jsonb_agg(stock_internal.scenario_json(s) order by s.created_at)
    from private.stock_scenarios s where s.user_id = auth.uid()), '[]'::jsonb);
end $$;

create or replace function stock_internal.save_scenario(p_scenario jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('saveScenarios');
  v_name text := btrim(coalesce(p_scenario->>'name', ''));
  v_id text := nullif(p_scenario->>'id', '');
  v_cuts jsonb := p_scenario->'cuts';
  v_discount jsonb := p_scenario->'discount';
  v_row private.stock_scenarios;
begin
  -- Em etapas: o SQL não garante a ordem de avaliação de um "or", e um texto no lugar de um
  -- número não pode virar erro cru.
  if char_length(v_name) not between 1 and 60 or jsonb_typeof(v_cuts) is distinct from 'object'
     or jsonb_typeof(v_discount) is distinct from 'number' then
    raise exception 'Informe um nome de até 60 caracteres e percentuais válidos.' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_object_keys(v_cuts)) <> 4
     or exists (select 1 from unnest(array['A', 'B', 'C', 'D']) k
                where jsonb_typeof(v_cuts->k) is distinct from 'number') then
    raise exception 'Informe um nome de até 60 caracteres e percentuais válidos.' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(array['A', 'B', 'C', 'D']) k
             where (v_cuts->>k)::numeric not between 0 and 100
                or (v_cuts->>k)::numeric <> trunc((v_cuts->>k)::numeric))
     or (v_discount #>> '{}')::numeric not between 0 and 70
     or (v_discount #>> '{}')::numeric <> trunc((v_discount #>> '{}')::numeric) then
    raise exception 'Informe um nome de até 60 caracteres e percentuais válidos.' using errcode = 'P0001';
  end if;
  v_cuts := jsonb_build_object('A', (v_cuts->>'A')::integer, 'B', (v_cuts->>'B')::integer,
    'C', (v_cuts->>'C')::integer, 'D', (v_cuts->>'D')::integer);
  if v_id is not null then
    if v_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'Cenário não encontrado.' using errcode = 'P0002';
    end if;
    update private.stock_scenarios set name = v_name, cuts = v_cuts,
        discount = (v_discount #>> '{}')::integer, updated_at = now()
      where id = v_id::uuid and user_id = auth.uid() returning * into v_row;
    if not found then raise exception 'Cenário não encontrado.' using errcode = 'P0002'; end if;
  else
    -- Trava por usuário: duas abas salvando ao mesmo tempo não passam do limite.
    perform pg_advisory_xact_lock(hashtext('stock_scenarios:' || auth.uid()::text));
    if (select count(*) from private.stock_scenarios where user_id = auth.uid()) >= 5 then
      raise exception 'Você já tem 5 cenários. Exclua um antes de salvar outro.' using errcode = 'P0001';
    end if;
    insert into private.stock_scenarios (user_id, name, cuts, discount)
      values (auth.uid(), v_name, v_cuts, (v_discount #>> '{}')::integer) returning * into v_row;
  end if;
  perform stock_internal.log('stock.scenario.saved', null,
    jsonb_build_object('cenario', v_row.name, 'cortes', v_row.cuts, 'desconto', v_row.discount));
  return stock_internal.scenario_json(v_row);
end $$;

create or replace function stock_internal.delete_scenario(p_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('saveScenarios');
  v_name text;
begin
  delete from private.stock_scenarios where id = p_id and user_id = auth.uid() returning name into v_name;
  if not found then raise exception 'Cenário não encontrado.' using errcode = 'P0002'; end if;
  perform stock_internal.log('stock.scenario.deleted', null, jsonb_build_object('cenario', v_name));
end $$;

-- Pedido de leitura fora da agenda: só Admin, uma empresa por vez, com intervalo mínimo.
create or replace function stock_internal.request_refresh(p_company text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('refresh');
  v_scope uuid[];
  v_company uuid;
  v_settings private.stock_settings;
  v_last timestamptz;
  v_gap interval;
begin
  if p_company is null or p_company = 'all' then
    raise exception 'Escolha uma empresa para solicitar a leitura.' using errcode = 'P0001';
  end if;
  v_scope := stock_internal.scope(p_company);
  if cardinality(v_scope) = 0 then
    raise exception 'Empresas de demonstração não têm estoque para ler.' using errcode = 'P0001';
  end if;
  v_company := v_scope[1];
  select * into v_settings from private.stock_settings;
  if not v_settings.reading_enabled then
    raise exception 'A leitura do estoque está desligada no momento.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.company_integrations ci
                 where ci.company_id = v_company and ci.provider = 'omie' and ci.status = 'CONNECTED') then
    raise exception 'A integração com o Omie desta empresa não está conectada.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('stock_refresh:' || v_company::text));
  if exists (select 1 from private.stock_readings r
             where r.company_id = v_company and r.status in ('queued', 'running')) then
    return jsonb_build_object('queued', false, 'nextAllowedAt', null, 'inProgress', true);
  end if;
  v_gap := make_interval(mins => v_settings.manual_min_minutes);
  select max(r.created_at) into v_last from private.stock_readings r
    where r.company_id = v_company and r.trigger = 'manual';
  if v_last is not null and v_last > now() - v_gap then
    return jsonb_build_object('queued', false, 'nextAllowedAt', v_last + v_gap, 'inProgress', false);
  end if;
  insert into private.stock_readings (company_id, kind, trigger, requested_by, status, position_date)
    values (v_company, 'intraday', 'manual', auth.uid(), 'queued',
            (now() at time zone 'America/Fortaleza')::date);
  perform stock_internal.log('stock.refresh.requested', v_company, null);
  return jsonb_build_object('queued', true, 'nextAllowedAt', now() + v_gap, 'inProgress', true);
end $$;

-- ===================================================================== administração (Super admin)

create or replace function stock_internal.require_super() returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not stock_internal.is_super() then
    raise exception 'Somente o Super admin altera a liberação do Estoque.' using errcode = '42501';
  end if;
end $$;

create or replace function stock_internal.admin_settings() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v jsonb;
begin
  perform stock_internal.require_super();
  select jsonb_build_object('mode', stock_internal.mode(), 'readingEnabled', s.reading_enabled,
    'slots', to_jsonb(s.slots), 'closeSlot', s.close_slot, 'manualMinMinutes', s.manual_min_minutes,
    'staleHours', s.stale_hours) into v from private.stock_settings s;
  return v;
end $$;

create or replace function stock_internal.admin_set_mode(p_mode text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_before text := stock_internal.mode();
begin
  perform stock_internal.require_super();
  if p_mode is null or p_mode not in ('off', 'pilot', 'on') then
    raise exception 'Liberação inválida.' using errcode = 'P0001';
  end if;
  insert into private.feature_flags (key, mode, updated_at, updated_by) values ('stock', p_mode, now(), auth.uid())
    on conflict (key) do update set mode = excluded.mode, updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;
  perform stock_internal.log('stock.module.mode', null, jsonb_build_object('antes', v_before, 'depois', p_mode));
  return stock_internal.admin_settings();
end $$;

create or replace function stock_internal.admin_set_reading(p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform stock_internal.require_super();
  if p_enabled is null then raise exception 'Valor inválido.' using errcode = 'P0001'; end if;
  update private.stock_settings set reading_enabled = p_enabled, updated_at = now(), updated_by = auth.uid();
  perform stock_internal.log('stock.reading.toggled', null, jsonb_build_object('ligada', p_enabled));
  return stock_internal.admin_settings();
end $$;

-- ===================================================================== worker (apenas service_role)

create or replace function public.stock_worker_settings() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('readingEnabled', s.reading_enabled, 'slots', to_jsonb(s.slots),
    'closeSlot', s.close_slot) from private.stock_settings s
$$;

-- Uma leitura agendada por empresa conectada; o mesmo horário nunca entra duas vezes.
create or replace function public.stock_worker_enqueue(p_slot text, p_kind text, p_position_date date)
returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_count integer := 0;
  v_company uuid;
begin
  if p_slot is null or p_kind not in ('intraday', 'close') or p_position_date is null then
    raise exception 'pedido de leitura inválido';
  end if;
  if not (select s.reading_enabled from private.stock_settings s) then return 0; end if;
  for v_company in
    select ci.company_id from public.company_integrations ci join public.companies c on c.id = ci.company_id
    where ci.provider = 'omie' and ci.status = 'CONNECTED' and not c.is_demo
      and c.data_source in ('OMIE', 'OMIE_SHADOW')
    order by c.name
  loop
    continue when exists (select 1 from private.stock_readings r
                          where r.company_id = v_company and r.status in ('queued', 'running'));
    insert into private.stock_readings (company_id, kind, trigger, slot, status, position_date)
      values (v_company, p_kind, 'schedule', p_slot, 'queued', p_position_date)
      on conflict (company_id, slot) where slot is not null do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

-- Recomeça do zero, guardando o motivo (estoque mudou no meio, página repetida, parada longa).
create or replace function stock_internal.restart(p_reading uuid, p_reason text, p_delay interval)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from private.stock_positions where reading_id = p_reading;
  update private.stock_readings set status = 'queued', pages_done = 0, pages_total = null,
      records_expected = null, records_received = 0, locations = null, started_at = null,
      next_attempt_at = now() + p_delay, error = p_reason
    where id = p_reading;
end $$;

-- Próxima leitura para o worker (continua a que está em andamento).
create or replace function public.stock_worker_claim() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_reading private.stock_readings;
  v_stale uuid;
begin
  -- Leitura iniciada há mais de 30 min (processo reiniciado, bloqueio longo): recomeça do zero,
  -- para nunca juntar páginas de horários muito diferentes.
  for v_stale in
    select r.id from private.stock_readings r
    where r.status in ('queued', 'running') and r.started_at < now() - interval '30 minutes'
    for update skip locked
  loop
    perform stock_internal.restart(v_stale, 'Leitura interrompida por mais de 30 minutos; recomeçando.',
      interval '0 seconds');
  end loop;
  select * into v_reading from private.stock_readings r
    where r.status in ('queued', 'running') and (r.next_attempt_at is null or r.next_attempt_at <= now())
    order by (r.status = 'running') desc, (r.kind = 'close') desc, r.created_at
    limit 1 for update skip locked;
  if not found then return null; end if;
  if v_reading.pages_done = 0 and v_reading.attempts >= 4 then
    update private.stock_readings set status = 'failed', finished_at = now(), next_attempt_at = null,
        error = coalesce(error, 'Leitura abandonada após 4 tentativas.')
      where id = v_reading.id;
    return null;
  end if;
  update private.stock_readings set status = 'running', started_at = coalesce(started_at, now()),
      attempts = attempts + case when pages_done = 0 then 1 else 0 end, next_attempt_at = null
    where id = v_reading.id returning * into v_reading;
  return jsonb_build_object('id', v_reading.id, 'companyId', v_reading.company_id,
    'positionDate', to_char(v_reading.position_date, 'DD/MM/YYYY'), 'nextPage', v_reading.pages_done + 1,
    'pagesTotal', v_reading.pages_total, 'recordsExpected', v_reading.records_expected,
    'locationsLoaded', v_reading.locations is not null, 'kind', v_reading.kind, 'attempts', v_reading.attempts);
end $$;

create or replace function public.stock_worker_save_locations(p_reading uuid, p_locations jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if jsonb_typeof(coalesce(p_locations, '{}'::jsonb)) <> 'object' then raise exception 'locais inválidos'; end if;
  update private.stock_readings set locations = coalesce(p_locations, '{}'::jsonb)
    where id = p_reading and status = 'running';
  if not found then raise exception 'leitura não está em andamento'; end if;
end $$;

create or replace function public.stock_worker_save_page(p_reading uuid, p_page integer, p_pages_total integer,
  p_records_total integer, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_reading private.stock_readings;
  v_saved integer;
begin
  select * into v_reading from private.stock_readings where id = p_reading for update;
  if not found or v_reading.status <> 'running' then raise exception 'leitura não está em andamento'; end if;
  if p_page is null or p_page <> v_reading.pages_done + 1 then
    raise exception 'página fora de ordem (recebida %, esperada %)', p_page, v_reading.pages_done + 1;
  end if;
  if p_pages_total is null or p_pages_total < 1 or p_records_total is null or p_records_total < 0
     or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'página inválida';
  end if;
  if (v_reading.pages_total is not null and v_reading.pages_total <> p_pages_total)
     or (v_reading.records_expected is not null and v_reading.records_expected <> p_records_total) then
    perform stock_internal.restart(p_reading, 'O total de posições mudou durante a leitura; recomeçando.',
      interval '2 minutes');
    return jsonb_build_object('restarted', true, 'done', false);
  end if;
  begin
    insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name,
        physical_qty, balance_qty, reserved_qty, pending_qty, min_qty, unit_cost, sale_price)
      select v_reading.id, v_reading.company_id, x.omie_product_id, x.location_code, x.sku, x.name,
        x.physical_qty, x.balance_qty, coalesce(x.reserved_qty, 0), coalesce(x.pending_qty, 0), x.min_qty,
        x.unit_cost, coalesce(x.sale_price, 0)
      from jsonb_to_recordset(p_rows) as x(omie_product_id text, location_code text, sku text, name text,
        physical_qty numeric, balance_qty numeric, reserved_qty numeric, pending_qty numeric,
        min_qty numeric, unit_cost numeric, sale_price numeric);
    get diagnostics v_saved = row_count;
  exception when unique_violation then
    perform stock_internal.restart(p_reading, 'O Omie devolveu a mesma posição duas vezes; recomeçando.',
      interval '2 minutes');
    return jsonb_build_object('restarted', true, 'done', false);
  end;
  update private.stock_readings set pages_done = p_page, pages_total = p_pages_total,
      records_expected = p_records_total, records_received = records_received + v_saved
    where id = p_reading;
  return jsonb_build_object('restarted', false, 'saved', v_saved, 'done', p_page >= p_pages_total);
end $$;

-- Publica a leitura completa e aplica a retenção (leituras do dia saem; fechamentos ficam).
create or replace function public.stock_worker_finish(p_reading uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_reading private.stock_readings;
  v_count integer;
  v_keep integer := (select s.close_retention_days from private.stock_settings s);
  v_old uuid;
begin
  select * into v_reading from private.stock_readings where id = p_reading for update;
  if not found or v_reading.status <> 'running' then raise exception 'leitura não está em andamento'; end if;
  select count(*) into v_count from private.stock_positions where reading_id = p_reading;
  if v_reading.pages_total is null or v_reading.pages_done is distinct from v_reading.pages_total
     or v_count is distinct from v_reading.records_expected
     or v_count is distinct from v_reading.records_received then
    perform stock_internal.restart(p_reading, format(
      'Leitura incompleta (%s de %s páginas, %s de %s posições); recomeçando.', v_reading.pages_done,
      coalesce(v_reading.pages_total::text, '?'), v_count, coalesce(v_reading.records_expected::text, '?')),
      interval '2 minutes');
    return jsonb_build_object('published', false, 'restarted', true);
  end if;
  -- clock_timestamp: a hora real da publicação (now() é a do início da transação).
  insert into private.stock_current (company_id, reading_id, published_at)
    values (v_reading.company_id, v_reading.id, clock_timestamp())
    on conflict (company_id) do update set reading_id = excluded.reading_id, published_at = excluded.published_at;
  update private.stock_readings set status = 'complete', finished_at = clock_timestamp(), error = null,
      next_attempt_at = null
    where id = p_reading;
  for v_old in
    select o.id from private.stock_readings o
    where o.company_id = v_reading.company_id and o.status = 'complete' and o.id <> v_reading.id
      and (o.kind = 'intraday' or o.finished_at < now() - make_interval(days => v_keep))
  loop
    delete from private.stock_positions where reading_id = v_old;
    update private.stock_readings set status = 'superseded' where id = v_old;
  end loop;
  return jsonb_build_object('published', true, 'positions', v_count);
end $$;

-- Falha de uma etapa: tenta de novo mais tarde (continuando da última página) ou desiste.
create or replace function public.stock_worker_fail(p_reading uuid, p_error text, p_retry_after_seconds integer,
  p_final boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_reading private.stock_readings;
begin
  select * into v_reading from private.stock_readings where id = p_reading for update;
  if not found or v_reading.status not in ('running', 'queued') then
    return jsonb_build_object('ok', false);
  end if;
  if coalesce(p_final, false) or (v_reading.pages_done = 0 and v_reading.attempts >= 4) then
    delete from private.stock_positions where reading_id = p_reading;
    update private.stock_readings set status = 'failed', finished_at = clock_timestamp(), next_attempt_at = null,
        error = left(coalesce(nullif(p_error, ''), 'Falha na leitura do estoque.'), 500)
      where id = p_reading;
    return jsonb_build_object('ok', true, 'final', true);
  end if;
  update private.stock_readings set status = 'queued',
      error = left(coalesce(nullif(p_error, ''), 'Falha na leitura do estoque.'), 500),
      next_attempt_at = now() + make_interval(secs => greatest(30, least(coalesce(p_retry_after_seconds, 300), 3600)))
    where id = p_reading;
  return jsonb_build_object('ok', true, 'final', false);
end $$;

-- ===================================================================== pontos de entrada

create or replace function public.stock_capabilities() returns jsonb
language sql stable as $$ select stock_internal.require('view') $$;
create or replace function public.stock_overview(p_company text) returns jsonb
language sql stable as $$ select stock_internal.overview(p_company) $$;
create or replace function public.stock_positions(p_query jsonb) returns jsonb
language sql stable as $$ select stock_internal.positions(p_query) $$;
create or replace function public.stock_filter_options(p_company text) returns jsonb
language sql stable as $$ select stock_internal.filter_options(p_company) $$;
create or replace function public.stock_simulation_base(p_company text) returns jsonb
language sql stable as $$ select stock_internal.simulation_base(p_company) $$;
create or replace function public.stock_set_curve(p_position_ids text[], p_curve text) returns jsonb
language sql as $$ select stock_internal.set_curve(p_position_ids, p_curve) $$;
create or replace function public.stock_scenarios() returns jsonb
language sql stable as $$ select stock_internal.scenarios() $$;
create or replace function public.stock_save_scenario(p_scenario jsonb) returns jsonb
language sql as $$ select stock_internal.save_scenario(p_scenario) $$;
create or replace function public.stock_delete_scenario(p_id uuid) returns void
language sql as $$ select stock_internal.delete_scenario(p_id) $$;
create or replace function public.stock_request_refresh(p_company text) returns jsonb
language sql as $$ select stock_internal.request_refresh(p_company) $$;
create or replace function public.my_features() returns text[]
language sql stable as $$ select stock_internal.features() $$;
create or replace function public.stock_admin_settings() returns jsonb
language sql stable as $$ select stock_internal.admin_settings() $$;
create or replace function public.stock_admin_set_mode(p_mode text) returns jsonb
language sql as $$ select stock_internal.admin_set_mode(p_mode) $$;
create or replace function public.stock_admin_set_reading(p_enabled boolean) returns jsonb
language sql as $$ select stock_internal.admin_set_reading(p_enabled) $$;

revoke all on all functions in schema stock_internal from public, anon, authenticated;
grant execute on function stock_internal.require(text), stock_internal.overview(text),
  stock_internal.positions(jsonb), stock_internal.filter_options(text), stock_internal.simulation_base(text),
  stock_internal.set_curve(text[], text), stock_internal.scenarios(), stock_internal.save_scenario(jsonb),
  stock_internal.delete_scenario(uuid), stock_internal.request_refresh(text), stock_internal.features(),
  stock_internal.admin_settings(), stock_internal.admin_set_mode(text), stock_internal.admin_set_reading(boolean)
to authenticated;

revoke all on function public.stock_capabilities(), public.stock_overview(text), public.stock_positions(jsonb),
  public.stock_filter_options(text), public.stock_simulation_base(text), public.stock_set_curve(text[], text),
  public.stock_scenarios(), public.stock_save_scenario(jsonb), public.stock_delete_scenario(uuid),
  public.stock_request_refresh(text), public.my_features(), public.stock_admin_settings(),
  public.stock_admin_set_mode(text), public.stock_admin_set_reading(boolean)
from public, anon;
grant execute on function public.stock_capabilities(), public.stock_overview(text), public.stock_positions(jsonb),
  public.stock_filter_options(text), public.stock_simulation_base(text), public.stock_set_curve(text[], text),
  public.stock_scenarios(), public.stock_save_scenario(jsonb), public.stock_delete_scenario(uuid),
  public.stock_request_refresh(text), public.my_features(), public.stock_admin_settings(),
  public.stock_admin_set_mode(text), public.stock_admin_set_reading(boolean)
to authenticated;

revoke all on function public.stock_worker_settings(), public.stock_worker_enqueue(text, text, date),
  public.stock_worker_claim(), public.stock_worker_save_locations(uuid, jsonb),
  public.stock_worker_save_page(uuid, integer, integer, integer, jsonb), public.stock_worker_finish(uuid),
  public.stock_worker_fail(uuid, text, integer, boolean)
from public, anon, authenticated;
grant execute on function public.stock_worker_settings(), public.stock_worker_enqueue(text, text, date),
  public.stock_worker_claim(), public.stock_worker_save_locations(uuid, jsonb),
  public.stock_worker_save_page(uuid, integer, integer, integer, jsonb), public.stock_worker_finish(uuid),
  public.stock_worker_fail(uuid, text, integer, boolean)
to service_role;

notify pgrst, 'reload schema';
