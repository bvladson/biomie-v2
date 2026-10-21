-- Admin 2.0: usuários, acessos, calendário de feriados e auditoria. Somente acréscimos.
--
-- Quem concede acesso não pode depender só da tela: as regras ficam aqui, no banco.
-- A lógica privilegiada mora no esquema admin_internal (SECURITY DEFINER, search_path fixo,
-- fora dos esquemas expostos pela API). A API enxerga apenas invólucros SECURITY INVOKER em
-- public. Toda função identifica o ator por auth.uid(): a auditoria registra o autor real e o
-- gatilho de user_roles continua atribuindo cada papel concedido ou retirado.
-- O que é do serviço de login (criar conta, link de acesso, senha, bloqueio, exclusão) roda no
-- servidor da aplicação com a chave de serviço; estas funções validam antes e registram depois.

create schema if not exists admin_internal;
revoke all on schema admin_internal from public, anon;
grant usage on schema admin_internal to authenticated;

-- Nome de usuário gerenciado pela tela, separado dos apelidos herdados do sistema antigo.
alter table private.legacy_user_aliases add column if not exists source text not null default 'legacy';
alter table private.legacy_user_aliases drop constraint if exists legacy_user_aliases_source_check;
alter table private.legacy_user_aliases add constraint legacy_user_aliases_source_check
  check (source in ('legacy', 'admin'));

-- Feriados: abrangência explícita e um por dia em cada abrangência/empresa.
-- (Os 26 feriados existentes são nacionais, sem empresa, e todos distintos.)
alter table public.holidays drop constraint if exists holidays_scope_check;
alter table public.holidays add constraint holidays_scope_check
  check (scope in ('national', 'state', 'city', 'company') and ((scope = 'company') = (company_id is not null)));
create unique index if not exists holidays_one_per_day
  on public.holidays (date, scope, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Estado administrativo que o serviço de login não guarda.
create table if not exists private.user_admin_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  blocked_reason text,
  blocked_at timestamptz,
  blocked_by uuid,
  access_kind text check (access_kind in ('INVITE_LINK', 'TEMP_PASSWORD')),
  access_issued_at timestamptz,
  access_expires_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  updated_at timestamptz not null default now()
);
revoke all on private.user_admin_state from public, anon, authenticated;

-- ===================================================================== auxiliares

create or replace function admin_internal.is_super() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select auth.uid() is not null and public.has_role(auth.uid(), 'SUPER_ADMIN')
$$;

create or replace function admin_internal.require_admin() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_admin(auth.uid()) then
    raise exception 'Acesso restrito a administradores.' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- Empresas que o ator acessa (Super admin: todas as visíveis; demonstração some quando oculta).
create or replace function admin_internal.actor_company_ids() returns uuid[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(array_agg(c.id order by c.name), '{}')
  from public.companies c
  where auth.uid() is not null and public.can_access_company(auth.uid(), c.id)
$$;

-- Super admin vê todos; Admin vê quem tem acesso a uma empresa sua (e a si mesmo).
create or replace function admin_internal.can_see(p_target uuid, p_scope uuid[]) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select auth.uid() is not null and public.is_admin(auth.uid()) and (
    public.has_role(auth.uid(), 'SUPER_ADMIN') or p_target = auth.uid()
    or exists (select 1 from public.user_company_access a
               where a.user_id = p_target and a.company_id = any(p_scope)))
$$;

-- Motivo pelo qual o ator não pode gerenciar o alvo (null = pode). Espelha manageBlockReason.
create or replace function admin_internal.manage_reason(p_target uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_admin(auth.uid()) then
    return 'Acesso restrito a administradores.';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_target and u.deleted_at is null)
     or not admin_internal.can_see(p_target, admin_internal.actor_company_ids()) then
    return 'Usuário não encontrado.';
  end if;
  if admin_internal.is_super() then return null; end if;
  if p_target <> auth.uid() and public.is_admin(p_target) then
    return 'Admin não altera outro Admin nem Super admin.';
  end if;
  return null;
end $$;

create or replace function admin_internal.require_manage(p_target uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_reason text := admin_internal.manage_reason(p_target);
begin
  if v_reason is not null then raise exception '%', v_reason using errcode = '42501'; end if;
end $$;

create or replace function admin_internal.role_label(p_role text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_role when 'SUPER_ADMIN' then 'Super admin' when 'ADMIN' then 'Admin'
    when 'DIRETORIA' then 'Diretoria' when 'GESTOR' then 'Gestor' when 'VENDEDOR' then 'Vendedor'
    when 'FINANCEIRO' then 'Financeiro' when 'ANALISTA' then 'Analista' when 'VIEWER' then 'Visualizador'
    else p_role end
$$;

-- Evento de auditoria com o ator da sessão. Nunca recebe senha nem link.
create or replace function admin_internal.log(p_action text, p_entity text, p_entity_id text, p_company uuid,
  p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (auth.uid(), p_action, p_entity, p_entity_id,
          jsonb_strip_nulls(jsonb_build_object('companyId', p_company, 'before', p_before, 'after', p_after)))
$$;

create or replace function admin_internal.check_username(p_username text, p_user uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_username is null then return; end if;
  if p_username !~ '^[a-z0-9.-]{3,40}$' then
    raise exception 'Nome de usuário: de 3 a 40 caracteres, letras minúsculas, números, ponto ou hífen.';
  end if;
  if exists (select 1 from private.legacy_user_aliases a
             where a.alias = p_username and a.user_id is distinct from p_user) then
    raise exception 'Nome de usuário já em uso.';
  end if;
end $$;

-- Usuário no formato do contrato AdminUser. Empresas e equipes fora do alcance do ator ficam de
-- fora da lista e aparecem só como contagem (otherCompanyCount).
create or replace function admin_internal.user_json(p_user uuid, p_scope uuid[]) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'id', u.id,
    'fullName', coalesce(nullif(p.full_name, ''), u.raw_user_meta_data->>'full_name', u.email),
    'email', u.email,
    'username', (select a.alias from private.legacy_user_aliases a
                 where a.user_id = u.id and a.is_active and a.source = 'admin' order by a.created_at desc limit 1),
    'legacyUsernames', coalesce((select jsonb_agg(a.alias order by a.alias) from private.legacy_user_aliases a
                 where a.user_id = u.id and a.is_active and a.source = 'legacy'), '[]'::jsonb),
    'roles', coalesce((select jsonb_agg(r.role order by r.role) from public.user_roles r where r.user_id = u.id), '[]'::jsonb),
    'companyIds', coalesce((select jsonb_agg(a.company_id order by c.name) from public.user_company_access a
                 join public.companies c on c.id = a.company_id
                 where a.user_id = u.id and a.company_id = any(p_scope)), '[]'::jsonb),
    'otherCompanyCount', (select count(*) from public.user_company_access a
                 where a.user_id = u.id and not a.company_id = any(p_scope)),
    'defaultCompanyId', case when p.default_company_id = any(p_scope) then p.default_company_id end,
    'sellerIds', coalesce((select jsonb_agg(s.id order by s.name) from public.sellers s
                 where s.user_id = u.id and s.company_id = any(p_scope)), '[]'::jsonb),
    'managedTeamIds', coalesce((select jsonb_agg(m.team_id) from public.sales_team_managers m
                 join public.sales_teams t on t.id = m.team_id
                 where m.user_id = u.id and m.valid_to is null and t.company_id = any(p_scope)), '[]'::jsonb),
    'permissions', coalesce((select jsonb_agg(x.permission order by x.permission) from public.user_permissions x
                 where x.user_id = u.id), '[]'::jsonb),
    'status', case when u.banned_until > now() then 'BLOCKED'
                   when u.last_sign_in_at is not null then 'ACTIVE'
                   when u.invited_at is not null or st.access_kind = 'INVITE_LINK' then 'INVITED'
                   else 'NEVER_SIGNED_IN' end,
    'createdAt', u.created_at,
    'lastSignInAt', u.last_sign_in_at,
    'blockedReason', case when u.banned_until > now() then st.blocked_reason end)
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join private.user_admin_state st on st.user_id = u.id
  where u.id = p_user
$$;

-- Valida e (fora do modo de ensaio) aplica papéis, empresas, empresa padrão, vendedores do Omie,
-- equipes e permissões numa única transação. Chaves ausentes em p_access ficam como estão.
create or replace function admin_internal.apply_access(p_user uuid, p_access jsonb, p_creating boolean, p_dry boolean)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_super boolean := admin_internal.is_super();
  v_scope uuid[] := admin_internal.actor_company_ids();
  v_known_roles constant text[] := array['SUPER_ADMIN','ADMIN','DIRETORIA','GESTOR','VENDEDOR','FINANCEIRO','ANALISTA','VIEWER'];
  v_known_perms constant text[] := array['documents:view_full','finance.view_summary','finance.view_titles',
    'finance.view_customer_details','finance.view_overdue','finance.export'];
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

-- ===================================================================== pontos de entrada

create or replace function admin_internal.me() returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'userId', auth.uid(),
    'fullName', coalesce((select nullif(full_name, '') from public.profiles where id = auth.uid()),
                         (select email from auth.users where id = auth.uid())),
    'roles', coalesce((select jsonb_agg(role order by role) from public.user_roles where user_id = auth.uid()), '[]'::jsonb),
    'companyIds', to_jsonb(admin_internal.actor_company_ids()))
  where auth.uid() is not null
$$;

create or replace function admin_internal.users_list() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_scope uuid[];
begin
  perform admin_internal.require_admin();
  v_scope := admin_internal.actor_company_ids();
  return coalesce((
    select jsonb_agg(admin_internal.user_json(u.id, v_scope) order by lower(coalesce(nullif(p.full_name, ''), u.email)))
    from auth.users u left join public.profiles p on p.id = u.id
    where u.deleted_at is null and admin_internal.can_see(u.id, v_scope)), '[]'::jsonb);
end $$;

create or replace function admin_internal.user_get(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_scope uuid[];
begin
  perform admin_internal.require_admin();
  v_scope := admin_internal.actor_company_ids();
  if not exists (select 1 from auth.users where id = p_user and deleted_at is null)
     or not admin_internal.can_see(p_user, v_scope) then
    raise exception 'Usuário não encontrado.' using errcode = 'P0002';
  end if;
  return admin_internal.user_json(p_user, v_scope);
end $$;

-- Ensaio antes de criar a conta no serviço de login: nada é gravado.
create or replace function admin_internal.validate_new_user(p_payload jsonb) returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_email text := lower(trim(coalesce(p_payload->>'email', '')));
  v_name text := trim(coalesce(p_payload->>'fullName', ''));
begin
  perform admin_internal.require_admin();
  if char_length(v_name) < 3 then raise exception 'Informe o nome completo.'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'E-mail inválido.'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'E-mail já cadastrado.';
  end if;
  perform admin_internal.check_username(nullif(lower(trim(p_payload->>'username')), ''), null);
  if coalesce(p_payload->>'delivery', '') not in ('INVITE_LINK', 'TEMP_PASSWORD') then
    raise exception 'Forma de entrega inválida.';
  end if;
  perform admin_internal.apply_access(null, coalesce(p_payload->'access', '{}'::jsonb), true, true);
end $$;

-- Configura a conta recém-criada no serviço de login. Só aceita conta criada há poucos minutos,
-- com o mesmo e-mail e ainda sem perfil, papel ou empresa: não serve para promover conta existente.
create or replace function admin_internal.provision_user(p_user uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_email text := lower(trim(coalesce(p_payload->>'email', '')));
  v_name text := trim(coalesce(p_payload->>'fullName', ''));
  v_username text := nullif(lower(trim(p_payload->>'username')), '');
  v_kind text := p_payload->>'delivery';
  v_expires timestamptz := nullif(p_payload->>'expiresAt', '')::timestamptz;
  v_default uuid;
  u record;
begin
  perform admin_internal.require_admin();
  select id, email, created_at, deleted_at into u from auth.users where id = p_user;
  if not found or u.deleted_at is not null or lower(u.email) is distinct from v_email
     or u.created_at < now() - interval '15 minutes'
     or exists (select 1 from public.profiles where id = p_user)
     or exists (select 1 from public.user_roles where user_id = p_user)
     or exists (select 1 from public.user_company_access where user_id = p_user) then
    raise exception 'Esta conta não pode ser configurada por aqui.' using errcode = '42501';
  end if;
  if char_length(v_name) < 3 then raise exception 'Informe o nome completo.'; end if;
  if coalesce(v_kind, '') not in ('INVITE_LINK', 'TEMP_PASSWORD') then raise exception 'Forma de entrega inválida.'; end if;
  perform admin_internal.check_username(v_username, p_user);
  insert into public.profiles (id, email, full_name) values (p_user, v_email, v_name);
  perform admin_internal.apply_access(p_user, coalesce(p_payload->'access', '{}'::jsonb), true, false);
  if v_username is not null then
    insert into private.legacy_user_aliases (alias, user_id, is_active, source) values (v_username, p_user, true, 'admin');
  end if;
  insert into private.user_admin_state (user_id, access_kind, access_issued_at, access_expires_at)
    values (p_user, v_kind, now(), v_expires)
    on conflict (user_id) do update set access_kind = excluded.access_kind, access_issued_at = excluded.access_issued_at,
      access_expires_at = excluded.access_expires_at, updated_at = now();
  select default_company_id into v_default from public.profiles where id = p_user;
  perform admin_internal.log('user.created', 'user', p_user::text, v_default, null, jsonb_build_object(
    'nome', v_name, 'email', v_email, 'usuario', v_username,
    'papeis', (select jsonb_agg(role order by role) from public.user_roles where user_id = p_user),
    'empresas', (select jsonb_agg(company_id) from public.user_company_access where user_id = p_user),
    'entrega', v_kind));
  perform admin_internal.log(case v_kind when 'INVITE_LINK' then 'access.link_issued' else 'access.password_issued' end,
    'user', p_user::text, v_default, null,
    jsonb_build_object('entrega', v_kind, 'validoAte', v_expires, 'trocaObrigatoria', v_kind = 'TEMP_PASSWORD'));
  return admin_internal.user_json(p_user, admin_internal.actor_company_ids());
end $$;

create or replace function admin_internal.update_access(p_user uuid, p_access jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform admin_internal.require_manage(p_user);
  perform admin_internal.apply_access(p_user, coalesce(p_access, '{}'::jsonb), false, false);
  return admin_internal.user_json(p_user, admin_internal.actor_company_ids());
end $$;

create or replace function admin_internal.update_profile(p_user uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_scope uuid[];
  v_before jsonb := '{}'; v_after jsonb := '{}';
  v_name text; v_cur_name text; v_username text; v_cur_username text; v_default uuid; v_cur_default uuid;
begin
  perform admin_internal.require_manage(p_user);
  v_scope := admin_internal.actor_company_ids();
  select full_name, default_company_id into v_cur_name, v_cur_default from public.profiles where id = p_user;
  select alias into v_cur_username from private.legacy_user_aliases
    where user_id = p_user and is_active and source = 'admin' order by created_at desc limit 1;
  if p_patch ? 'fullName' then
    v_name := trim(coalesce(p_patch->>'fullName', ''));
    if char_length(v_name) < 3 then raise exception 'Informe o nome completo.'; end if;
    if v_name is distinct from v_cur_name then
      insert into public.profiles (id, full_name) values (p_user, v_name)
        on conflict (id) do update set full_name = excluded.full_name;
      v_before := v_before || jsonb_build_object('nome', v_cur_name);
      v_after := v_after || jsonb_build_object('nome', v_name);
    end if;
  end if;
  if p_patch ? 'username' then
    v_username := nullif(lower(trim(coalesce(p_patch->>'username', ''))), '');
    if v_username is distinct from v_cur_username then
      perform admin_internal.check_username(v_username, p_user);
      delete from private.legacy_user_aliases where user_id = p_user and source = 'admin';
      if v_username is not null then
        insert into private.legacy_user_aliases (alias, user_id, is_active, source) values (v_username, p_user, true, 'admin');
      end if;
      v_before := v_before || jsonb_build_object('usuario', v_cur_username);
      v_after := v_after || jsonb_build_object('usuario', v_username);
    end if;
  end if;
  if nullif(p_patch->>'defaultCompanyId', '') is not null then
    v_default := (p_patch->>'defaultCompanyId')::uuid;
    if not exists (select 1 from public.user_company_access where user_id = p_user and company_id = v_default)
       or not v_default = any(v_scope) then
      raise exception 'A empresa padrão precisa ser uma das empresas do usuário.';
    end if;
    if v_default is distinct from v_cur_default then
      update public.profiles set default_company_id = v_default where id = p_user;
      v_before := v_before || jsonb_build_object('empresaPadrao', v_cur_default);
      v_after := v_after || jsonb_build_object('empresaPadrao', v_default);
    end if;
  end if;
  if v_after <> '{}'::jsonb then
    perform admin_internal.log('user.updated', 'user', p_user::text,
      (select default_company_id from public.profiles where id = p_user), v_before, v_after);
  end if;
  return admin_internal.user_json(p_user, v_scope);
end $$;

-- Pré-checagem das ações feitas no serviço de login (link, senha, bloqueio, sessões).
create or replace function admin_internal.check_action(p_user uuid, p_action text) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_reason text := admin_internal.manage_reason(p_user);
begin
  if p_action is null or p_action not in ('issue', 'block', 'unblock', 'signout') then return 'Ação desconhecida.'; end if;
  if v_reason is not null then return v_reason; end if;
  if p_action = 'block' and p_user = auth.uid() then return 'Você não pode bloquear a si mesmo.'; end if;
  if p_action = 'issue' and exists (select 1 from auth.users where id = p_user and banned_until > now()) then
    return 'Reative o usuário antes de gerar um novo acesso.';
  end if;
  return null;
end $$;

create or replace function admin_internal.access_issued(p_user uuid, p_kind text, p_expires timestamptz) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_reason text := admin_internal.check_action(p_user, 'issue');
begin
  if v_reason is not null then raise exception '%', v_reason using errcode = '42501'; end if;
  if coalesce(p_kind, '') not in ('INVITE_LINK', 'TEMP_PASSWORD') then raise exception 'Forma de entrega inválida.'; end if;
  insert into private.user_admin_state (user_id, access_kind, access_issued_at, access_expires_at)
    values (p_user, p_kind, now(), p_expires)
    on conflict (user_id) do update set access_kind = excluded.access_kind, access_issued_at = excluded.access_issued_at,
      access_expires_at = excluded.access_expires_at, updated_at = now();
  perform admin_internal.log(case p_kind when 'INVITE_LINK' then 'access.link_issued' else 'access.password_issued' end,
    'user', p_user::text, (select default_company_id from public.profiles where id = p_user), null,
    jsonb_build_object('entrega', p_kind, 'validoAte', p_expires, 'trocaObrigatoria', p_kind = 'TEMP_PASSWORD'));
end $$;

-- Registra bloqueio/reativação feito no serviço de login. Bloquear derruba as sessões.
create or replace function admin_internal.block_recorded(p_user uuid, p_blocked boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_reason text := admin_internal.check_action(p_user, case when p_blocked then 'block' else 'unblock' end);
  v_motive text := trim(coalesce(p_reason, ''));
  v_before text;
begin
  if v_reason is not null then raise exception '%', v_reason using errcode = '42501'; end if;
  if char_length(v_motive) < 3 then raise exception 'Informe o motivo.'; end if;
  select blocked_reason into v_before from private.user_admin_state where user_id = p_user;
  insert into private.user_admin_state (user_id, blocked_reason, blocked_at, blocked_by)
    values (p_user, case when p_blocked then v_motive end, case when p_blocked then now() end, case when p_blocked then auth.uid() end)
    on conflict (user_id) do update set blocked_reason = excluded.blocked_reason, blocked_at = excluded.blocked_at,
      blocked_by = excluded.blocked_by, updated_at = now();
  if p_blocked then delete from auth.sessions where user_id = p_user; end if;
  perform admin_internal.log(case when p_blocked then 'user.blocked' else 'user.reactivated' end, 'user', p_user::text,
    (select default_company_id from public.profiles where id = p_user),
    jsonb_build_object('status', case when p_blocked then 'ACTIVE' else 'BLOCKED' end, 'motivo', v_before),
    jsonb_build_object('status', case when p_blocked then 'BLOCKED' else 'ACTIVE' end, 'motivo', v_motive));
  return admin_internal.user_json(p_user, admin_internal.actor_company_ids());
end $$;

-- Encerra as sessões (a renovação some em cascata; o acesso já emitido expira em até 1 hora).
create or replace function admin_internal.revoke_sessions(p_user uuid) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_reason text := admin_internal.check_action(p_user, 'signout'); n integer;
begin
  if v_reason is not null then raise exception '%', v_reason using errcode = '42501'; end if;
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  perform admin_internal.log('sessions.revoked', 'user', p_user::text,
    (select default_company_id from public.profiles where id = p_user),
    jsonb_build_object('dispositivos', n), jsonb_build_object('dispositivos', 0));
  return n;
end $$;

-- Exclusão (só Super admin): retira todo acesso antes de a conta sair do serviço de login.
-- O perfil e a auditoria ficam para o histórico. Repetível se o serviço de login falhar.
create or replace function admin_internal.delete_user(p_user uuid, p_confirm_email text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  u record; v_name text; v_roles jsonb; v_companies jsonb; v_default uuid;
  v_today date := (now() at time zone 'America/Fortaleza')::date;
begin
  perform admin_internal.require_admin();
  if not admin_internal.is_super() then
    raise exception 'Somente o Super admin exclui usuários.' using errcode = '42501';
  end if;
  if p_user = auth.uid() then raise exception 'Você não pode excluir a si mesmo.' using errcode = '42501'; end if;
  select id, email, deleted_at into u from auth.users where id = p_user;
  if not found or u.deleted_at is not null then raise exception 'Usuário não encontrado.' using errcode = 'P0002'; end if;
  if lower(trim(coalesce(p_confirm_email, ''))) <> lower(u.email) then
    raise exception 'O e-mail digitado não confere.';
  end if;
  select full_name, default_company_id into v_name, v_default from public.profiles where id = p_user;
  select coalesce(jsonb_agg(role order by role), '[]') into v_roles from public.user_roles where user_id = p_user;
  select coalesce(jsonb_agg(company_id), '[]') into v_companies from public.user_company_access where user_id = p_user;
  delete from public.user_roles where user_id = p_user;
  delete from public.user_company_access where user_id = p_user;
  delete from public.user_permissions where user_id = p_user;
  update public.sellers set user_id = null where user_id = p_user;
  update public.sales_team_managers set valid_to = v_today where user_id = p_user and valid_to is null;
  update private.legacy_user_aliases set is_active = false where user_id = p_user;
  delete from auth.sessions where user_id = p_user;
  insert into private.user_admin_state (user_id, deleted_at, deleted_by) values (p_user, now(), auth.uid())
    on conflict (user_id) do update set deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by, updated_at = now();
  perform admin_internal.log('user.deleted', 'user', p_user::text, v_default,
    jsonb_build_object('nome', v_name, 'email', u.email, 'papeis', v_roles, 'empresas', v_companies), null);
end $$;

create or replace function admin_internal.companies_list() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_scope uuid[];
begin
  perform admin_internal.require_admin();
  v_scope := admin_internal.actor_company_ids();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'slug', c.slug, 'name', c.name, 'dataSource', c.data_source,
      'userCount', (select count(*) from public.user_company_access a join auth.users u on u.id = a.user_id
                    where a.company_id = c.id and u.deleted_at is null)) order by c.name)
    from public.companies c where c.id = any(v_scope)), '[]'::jsonb);
end $$;

create or replace function admin_internal.rename_company(p_company uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_name text := trim(coalesce(p_name, '')); v_before text;
begin
  perform admin_internal.require_admin();
  if not admin_internal.is_super() then
    raise exception 'Somente o Super admin altera o nome de exibição.' using errcode = '42501';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'Informe um nome entre 2 e 120 caracteres.';
  end if;
  select name into v_before from public.companies where id = p_company;
  if not found then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  update public.companies set name = v_name where id = p_company;
  perform admin_internal.log('config.changed', 'company', p_company::text, p_company,
    jsonb_build_object('nome', v_before), jsonb_build_object('nome', v_name));
  return (select e.v from jsonb_array_elements(admin_internal.companies_list()) as e(v) where e.v->>'id' = p_company::text);
end $$;

create or replace function admin_internal.require_company(p_company uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform admin_internal.require_admin();
  if not p_company = any(admin_internal.actor_company_ids()) then
    raise exception 'Empresa não encontrada.' using errcode = 'P0002';
  end if;
end $$;

create or replace function admin_internal.company_sellers(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform admin_internal.require_company(p_company);
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'companyId', s.company_id, 'name', s.name,
      'active', s.active, 'userId', s.user_id) order by s.name)
    from public.sellers s where s.company_id = p_company), '[]'::jsonb);
end $$;

create or replace function admin_internal.company_teams(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform admin_internal.require_company(p_company);
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'companyId', t.company_id, 'name', t.name,
      'active', t.active,
      'managerUserIds', coalesce((select jsonb_agg(m.user_id) from public.sales_team_managers m
                                  where m.team_id = t.id and m.valid_to is null), '[]'::jsonb)) order by t.name)
    from public.sales_teams t where t.company_id = p_company), '[]'::jsonb);
end $$;

-- Super admin edita qualquer feriado; Admin, só os da própria empresa.
create or replace function admin_internal.require_holiday_edit(p_scope text, p_company uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform admin_internal.require_admin();
  if admin_internal.is_super() then return; end if;
  if p_scope = 'company' and p_company = any(admin_internal.actor_company_ids()) then return; end if;
  raise exception 'Você não pode editar feriados dessa abrangência.' using errcode = '42501';
end $$;

create or replace function admin_internal.holiday_json(h public.holidays) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('id', h.id, 'date', h.date, 'name', h.name, 'scope', h.scope, 'companyId', h.company_id)
$$;

create or replace function admin_internal.holidays_list(p_year integer) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_scope uuid[];
begin
  perform admin_internal.require_admin();
  v_scope := admin_internal.actor_company_ids();
  return coalesce((select jsonb_agg(admin_internal.holiday_json(h) order by h.date, h.scope)
    from public.holidays h
    where extract(year from h.date) = p_year and (h.company_id is null or h.company_id = any(v_scope))), '[]'::jsonb);
end $$;

create or replace function admin_internal.holiday_save(p_holiday jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_id uuid := nullif(p_holiday->>'id', '')::uuid;
  v_date date := nullif(p_holiday->>'date', '')::date;
  v_name text := trim(coalesce(p_holiday->>'name', ''));
  v_scope text := coalesce(p_holiday->>'scope', '');
  v_company uuid := nullif(p_holiday->>'companyId', '')::uuid;
  v_cur public.holidays; v_row public.holidays; v_dup text;
begin
  if v_scope not in ('national', 'state', 'city', 'company') then raise exception 'Abrangência inválida.'; end if;
  if v_scope <> 'company' then v_company := null; end if;
  if v_scope = 'company' and v_company is null then raise exception 'Escolha a empresa.'; end if;
  perform admin_internal.require_holiday_edit(v_scope, v_company);
  if v_date is null or v_name = '' then raise exception 'Data e nome são obrigatórios.'; end if;
  select name into v_dup from public.holidays
    where date = v_date and scope = v_scope and company_id is not distinct from v_company and id is distinct from v_id;
  if v_dup is not null then raise exception 'Já existe um feriado nesta data: %.', v_dup; end if;
  if v_id is not null then
    select * into v_cur from public.holidays where id = v_id;
    if not found then raise exception 'Feriado não encontrado.' using errcode = 'P0002'; end if;
    perform admin_internal.require_holiday_edit(v_cur.scope, v_cur.company_id);
    update public.holidays set date = v_date, name = v_name, scope = v_scope, company_id = v_company
      where id = v_id returning * into v_row;
    perform admin_internal.log('config.changed', 'holiday', v_id::text, v_company,
      jsonb_build_object('data', v_cur.date, 'nome', v_cur.name, 'abrangencia', v_cur.scope),
      jsonb_build_object('data', v_date, 'nome', v_name, 'abrangencia', v_scope));
  else
    insert into public.holidays (date, name, scope, company_id) values (v_date, v_name, v_scope, v_company)
      returning * into v_row;
    perform admin_internal.log('config.changed', 'holiday', v_row.id::text, v_company, null,
      jsonb_build_object('data', v_date, 'nome', v_name, 'abrangencia', v_scope));
  end if;
  return admin_internal.holiday_json(v_row);
end $$;

create or replace function admin_internal.holiday_delete(p_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_cur public.holidays;
begin
  perform admin_internal.require_admin();
  select * into v_cur from public.holidays where id = p_id;
  if not found then raise exception 'Feriado não encontrado.' using errcode = 'P0002'; end if;
  perform admin_internal.require_holiday_edit(v_cur.scope, v_cur.company_id);
  delete from public.holidays where id = p_id;
  perform admin_internal.log('config.changed', 'holiday', p_id::text, v_cur.company_id,
    jsonb_build_object('data', v_cur.date, 'nome', v_cur.name, 'abrangencia', v_cur.scope), null);
end $$;

create or replace function admin_internal.holidays_import(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  x jsonb; v_scope text; v_company uuid; v_date date; v_name text;
  v_created integer := 0; v_dups integer := 0; n integer;
begin
  perform admin_internal.require_admin();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Nenhum feriado para importar.'; end if;
  if jsonb_array_length(p_rows) > 400 then raise exception 'Importe no máximo 400 feriados por vez.'; end if;
  for x in select value from jsonb_array_elements(p_rows) loop
    v_scope := coalesce(x->>'scope', '');
    v_company := case when v_scope = 'company' then nullif(x->>'companyId', '')::uuid end;
    v_date := nullif(x->>'date', '')::date;
    v_name := trim(coalesce(x->>'name', ''));
    if v_scope not in ('national', 'state', 'city', 'company') then raise exception 'Abrangência inválida.'; end if;
    if v_scope = 'company' and v_company is null then raise exception 'Escolha a empresa.'; end if;
    if v_date is null or v_name = '' then raise exception 'Data e nome são obrigatórios.'; end if;
    perform admin_internal.require_holiday_edit(v_scope, v_company);
    insert into public.holidays (date, name, scope, company_id) values (v_date, v_name, v_scope, v_company)
      on conflict do nothing;
    get diagnostics n = row_count;
    if n = 1 then v_created := v_created + 1; else v_dups := v_dups + 1; end if;
  end loop;
  if v_created > 0 then
    perform admin_internal.log('config.changed', 'holiday', null, v_company, null,
      jsonb_build_object('importados', v_created, 'duplicadosIgnorados', v_dups, 'abrangencia', v_scope));
  end if;
  return jsonb_build_object('created', v_created, 'duplicates', v_dups);
end $$;

-- Auditoria no vocabulário da tela. Eventos antigos são traduzidos (papel, permissão); o Admin vê
-- os eventos das suas empresas e os de usuários que ele enxerga; o Super admin vê tudo.
create or replace function admin_internal.audit_list(p_filter jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_scope uuid[]; v_super boolean; v_page integer := greatest(coalesce((p_filter->>'page')::integer, 1), 1);
  v_size constant integer := 20; v_total bigint; v_rows jsonb;
begin
  perform admin_internal.require_admin();
  v_scope := admin_internal.actor_company_ids();
  v_super := admin_internal.is_super();
  with base as (
    select l.id, l.created_at, l.actor_id, l.entity_id,
      case when l.entity = 'user_roles' and l.action = 'insert' then 'role.granted'
           when l.entity = 'user_roles' and l.action = 'delete' then 'role.revoked'
           when l.action in ('permission.grant', 'permission.revoke') then 'permission.changed'
           when l.action = 'profile.provision' then 'user.provisioned'
           else l.action end as action,
      case when l.entity in ('user_roles', 'user_permissions', 'profiles') then 'user' else l.entity end as entity,
      case when l.payload->>'companyId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then (l.payload->>'companyId')::uuid end as company_id,
      case when l.entity = 'user_roles' and l.action = 'delete' then jsonb_build_object('papel', l.payload->>'role')
           when l.action = 'permission.revoke' then jsonb_build_object('permissao', l.payload->>'permission')
           else l.payload->'before' end as before,
      case when l.entity = 'user_roles' and l.action = 'insert' then jsonb_build_object('papel', l.payload->>'role')
           when l.action = 'permission.grant' then jsonb_build_object('permissao', l.payload->>'permission')
           when l.payload ? 'after' or l.payload ? 'before' then l.payload->'after'
           else l.payload - 'companyId' end as after
    from public.audit_log l
  ), visible as (
    select b.* from base b
    where (v_super or b.company_id = any(v_scope)
           or (b.company_id is null and b.entity = 'user'
               and case when b.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        then admin_internal.can_see(b.entity_id::uuid, v_scope) else false end))
      and (nullif(p_filter->>'from', '') is null
           or (b.created_at at time zone 'America/Fortaleza')::date >= (p_filter->>'from')::date)
      and (nullif(p_filter->>'to', '') is null
           or (b.created_at at time zone 'America/Fortaleza')::date <= (p_filter->>'to')::date)
      and (nullif(p_filter->>'actorId', '') is null or b.actor_id::text = p_filter->>'actorId')
      and (nullif(p_filter->>'action', '') is null or b.action = p_filter->>'action')
      and (nullif(p_filter->>'entity', '') is null or b.entity = p_filter->>'entity')
      and (nullif(p_filter->>'targetId', '') is null or b.entity_id = p_filter->>'targetId')
      and (nullif(p_filter->>'companyId', '') is null or b.company_id::text = p_filter->>'companyId')
  )
  select (select count(*) from visible),
    coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', v.id, 'at', v.created_at, 'actorId', v.actor_id,
        'actorName', case when v.actor_id is null then 'Sistema'
                          else coalesce(nullif(pa.full_name, ''), ua.email, 'Usuário removido') end,
        'action', v.action, 'entity', v.entity, 'entityId', v.entity_id, 'companyId', v.company_id,
        'targetName', case when v.entity = 'user' then nullif(pt.full_name, '') end,
        'before', v.before, 'after', v.after)) order by v.created_at desc, v.id desc)
      from (select * from visible order by created_at desc, id desc offset (v_page - 1) * v_size limit v_size) v
      left join public.profiles pa on pa.id = v.actor_id
      left join auth.users ua on ua.id = v.actor_id
      left join public.profiles pt on v.entity = 'user'
        and pt.id = case when v.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v.entity_id::uuid end), '[]'::jsonb)
  into v_total, v_rows;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'pageSize', v_size);
end $$;

-- ===================================================================== minha conta (qualquer usuário)

create or replace function admin_internal.my_sessions() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Faça login novamente.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'userAgent', coalesce(s.user_agent, ''), 'ip', coalesce(host(s.ip), ''),
      'lastActiveAt', coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at),
      'current', s.id::text = coalesce(auth.jwt()->>'session_id', '')) order by coalesce(s.updated_at, s.created_at) desc)
    from auth.sessions s where s.user_id = auth.uid()), '[]'::jsonb);
end $$;

create or replace function admin_internal.my_revoke_other_sessions() returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Faça login novamente.' using errcode = '42501'; end if;
  delete from auth.sessions where user_id = auth.uid() and id::text <> coalesce(auth.jwt()->>'session_id', '');
  get diagnostics n = row_count;
  if n > 0 then
    perform admin_internal.log('sessions.revoked', 'user', auth.uid()::text, null,
      jsonb_build_object('dispositivos', n), jsonb_build_object('dispositivos', 0, 'origem', 'Minha conta'));
  end if;
  return n;
end $$;

create or replace function admin_internal.my_update_name(p_name text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_name text := trim(coalesce(p_name, '')); v_before text;
begin
  if auth.uid() is null then raise exception 'Faça login novamente.' using errcode = '42501'; end if;
  if char_length(v_name) < 3 then raise exception 'Informe o nome completo.'; end if;
  select full_name into v_before from public.profiles where id = auth.uid();
  if v_before is distinct from v_name then
    update public.profiles set full_name = v_name where id = auth.uid();
    perform admin_internal.log('user.updated', 'user', auth.uid()::text, null,
      jsonb_build_object('nome', v_before), jsonb_build_object('nome', v_name, 'origem', 'Minha conta'));
  end if;
  return admin_internal.me();
end $$;

create or replace function admin_internal.my_password_changed(p_origin text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Faça login novamente.' using errcode = '42501'; end if;
  perform admin_internal.log('access.password_changed', 'user', auth.uid()::text, null, null,
    jsonb_build_object('origem', case when p_origin = 'first_access' then 'Primeiro acesso' else 'Minha conta' end));
end $$;

-- ===================================================================== permissões

revoke all on all functions in schema admin_internal from public, anon, authenticated;
grant execute on function
  admin_internal.me(), admin_internal.users_list(), admin_internal.user_get(uuid),
  admin_internal.validate_new_user(jsonb), admin_internal.provision_user(uuid, jsonb),
  admin_internal.update_access(uuid, jsonb), admin_internal.update_profile(uuid, jsonb),
  admin_internal.check_action(uuid, text), admin_internal.access_issued(uuid, text, timestamptz),
  admin_internal.block_recorded(uuid, boolean, text), admin_internal.revoke_sessions(uuid),
  admin_internal.delete_user(uuid, text), admin_internal.companies_list(), admin_internal.rename_company(uuid, text),
  admin_internal.company_sellers(uuid), admin_internal.company_teams(uuid), admin_internal.holidays_list(integer),
  admin_internal.holiday_save(jsonb), admin_internal.holiday_delete(uuid), admin_internal.holidays_import(jsonb),
  admin_internal.audit_list(jsonb), admin_internal.my_sessions(), admin_internal.my_revoke_other_sessions(),
  admin_internal.my_update_name(text), admin_internal.my_password_changed(text)
to authenticated;

-- ===================================================================== invólucros expostos (SECURITY INVOKER)

create or replace function public.admin_me() returns jsonb language sql stable as $$ select admin_internal.me() $$;
create or replace function public.admin_users() returns jsonb language sql stable as $$ select admin_internal.users_list() $$;
create or replace function public.admin_user(p_user uuid) returns jsonb language sql stable as $$ select admin_internal.user_get(p_user) $$;
create or replace function public.admin_validate_new_user(p_payload jsonb) returns void language sql as $$ select admin_internal.validate_new_user(p_payload) $$;
create or replace function public.admin_provision_user(p_user uuid, p_payload jsonb) returns jsonb language sql as $$ select admin_internal.provision_user(p_user, p_payload) $$;
create or replace function public.admin_update_access(p_user uuid, p_access jsonb) returns jsonb language sql as $$ select admin_internal.update_access(p_user, p_access) $$;
create or replace function public.admin_update_profile(p_user uuid, p_patch jsonb) returns jsonb language sql as $$ select admin_internal.update_profile(p_user, p_patch) $$;
create or replace function public.admin_check_action(p_user uuid, p_action text) returns text language sql stable as $$ select admin_internal.check_action(p_user, p_action) $$;
create or replace function public.admin_access_issued(p_user uuid, p_kind text, p_expires timestamptz) returns void language sql as $$ select admin_internal.access_issued(p_user, p_kind, p_expires) $$;
create or replace function public.admin_block_recorded(p_user uuid, p_blocked boolean, p_reason text) returns jsonb language sql as $$ select admin_internal.block_recorded(p_user, p_blocked, p_reason) $$;
create or replace function public.admin_revoke_sessions(p_user uuid) returns integer language sql as $$ select admin_internal.revoke_sessions(p_user) $$;
create or replace function public.admin_delete_user(p_user uuid, p_confirm_email text) returns void language sql as $$ select admin_internal.delete_user(p_user, p_confirm_email) $$;
create or replace function public.admin_companies() returns jsonb language sql stable as $$ select admin_internal.companies_list() $$;
create or replace function public.admin_rename_company(p_company uuid, p_name text) returns jsonb language sql as $$ select admin_internal.rename_company(p_company, p_name) $$;
create or replace function public.admin_company_sellers(p_company uuid) returns jsonb language sql stable as $$ select admin_internal.company_sellers(p_company) $$;
create or replace function public.admin_company_teams(p_company uuid) returns jsonb language sql stable as $$ select admin_internal.company_teams(p_company) $$;
create or replace function public.admin_holidays(p_year integer) returns jsonb language sql stable as $$ select admin_internal.holidays_list(p_year) $$;
create or replace function public.admin_save_holiday(p_holiday jsonb) returns jsonb language sql as $$ select admin_internal.holiday_save(p_holiday) $$;
create or replace function public.admin_delete_holiday(p_id uuid) returns void language sql as $$ select admin_internal.holiday_delete(p_id) $$;
create or replace function public.admin_import_holidays(p_rows jsonb) returns jsonb language sql as $$ select admin_internal.holidays_import(p_rows) $$;
create or replace function public.admin_audit(p_filter jsonb) returns jsonb language sql stable as $$ select admin_internal.audit_list(p_filter) $$;
create or replace function public.my_sessions() returns jsonb language sql stable as $$ select admin_internal.my_sessions() $$;
create or replace function public.my_revoke_other_sessions() returns integer language sql as $$ select admin_internal.my_revoke_other_sessions() $$;
create or replace function public.my_update_name(p_name text) returns jsonb language sql as $$ select admin_internal.my_update_name(p_name) $$;
create or replace function public.my_password_changed(p_origin text) returns void language sql as $$ select admin_internal.my_password_changed(p_origin) $$;

revoke all on function
  public.admin_me(), public.admin_users(), public.admin_user(uuid), public.admin_validate_new_user(jsonb),
  public.admin_provision_user(uuid, jsonb), public.admin_update_access(uuid, jsonb), public.admin_update_profile(uuid, jsonb),
  public.admin_check_action(uuid, text), public.admin_access_issued(uuid, text, timestamptz),
  public.admin_block_recorded(uuid, boolean, text), public.admin_revoke_sessions(uuid), public.admin_delete_user(uuid, text),
  public.admin_companies(), public.admin_rename_company(uuid, text), public.admin_company_sellers(uuid),
  public.admin_company_teams(uuid), public.admin_holidays(integer), public.admin_save_holiday(jsonb),
  public.admin_delete_holiday(uuid), public.admin_import_holidays(jsonb), public.admin_audit(jsonb),
  public.my_sessions(), public.my_revoke_other_sessions(), public.my_update_name(text), public.my_password_changed(text)
from public, anon;
grant execute on function
  public.admin_me(), public.admin_users(), public.admin_user(uuid), public.admin_validate_new_user(jsonb),
  public.admin_provision_user(uuid, jsonb), public.admin_update_access(uuid, jsonb), public.admin_update_profile(uuid, jsonb),
  public.admin_check_action(uuid, text), public.admin_access_issued(uuid, text, timestamptz),
  public.admin_block_recorded(uuid, boolean, text), public.admin_revoke_sessions(uuid), public.admin_delete_user(uuid, text),
  public.admin_companies(), public.admin_rename_company(uuid, text), public.admin_company_sellers(uuid),
  public.admin_company_teams(uuid), public.admin_holidays(integer), public.admin_save_holiday(jsonb),
  public.admin_delete_holiday(uuid), public.admin_import_holidays(jsonb), public.admin_audit(jsonb),
  public.my_sessions(), public.my_revoke_other_sessions(), public.my_update_name(text), public.my_password_changed(text)
to authenticated;

notify pgrst, 'reload schema';
