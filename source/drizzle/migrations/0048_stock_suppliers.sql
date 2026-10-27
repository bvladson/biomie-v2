-- 0048: Estoque — fornecedores do Omie e prazos de entrega por empresa, produto e fornecedor
-- (decisão do usuário de 26/10/2026). Aditiva; nada aqui escreve no Omie.
--
-- - Fornecedores: lidos do Omie SÓ PARA LEITURA (ListarProdutoFornecedor, "Produto x Fornecedor", 10
--   cadastros por página) pelo worker, uma vez por dia quando ligado no banco (stock_settings.
--   suppliers_enabled, desligado por padrão). O fornecedor é o cadastro que o BIOMIE já tem
--   (public.customers, importado do Omie por ListarClientes; nCodForn = codigo_cliente_omie): aqui fica
--   só o código do Omie, o vínculo com esse cadastro e o nome que a API devolveu (usado só enquanto o
--   cadastro não chega). Sem CPF/CNPJ. A importação nunca apaga prazo nem fornecedor principal.
-- - Prazos de entrega: a API documentada não traz prazo por produto, então ele é informado no BIOMIE,
--   pela tela, por Compras (nova permissão extra "stock.purchasing") ou pelo Super admin: por empresa,
--   fornecedor e produto, ou um prazo padrão do fornecedor para os produtos dele na empresa (o do
--   produto prevalece). Dias corridos. Toda alteração fica no histórico (usuário, data, valor anterior,
--   valor novo e observação) e na Auditoria.
-- - Um produto pode ter vários fornecedores, com prazos diferentes: Compras indica o fornecedor
--   principal (o da reposição) e pode vincular ao produto um fornecedor do cadastro que o Omie não
--   vinculou (vínculo manual, removível; o do Omie só muda no Omie).
-- - Prazo de teste (status 'teste') só existe na homologação, gravado pelo roteiro de teste, e só é lido
--   pelo motor com o ajuste stock.test_lead_times = on, que a produção não tem: a produção começa sem
--   prazo nenhum e nenhum prazo fictício é copiado para ela.
-- - Filtro por fornecedor no painel e nas posições do Estoque, uma empresa por vez (o código do
--   fornecedor é de cada conta do Omie). Consulta de fornecedores e prazos: quem vê custo ou é Compras (o
--   Comercial consulta previsões e reposições, sem fornecedores); histórico com nomes: Compras e Super admin.
-- Retorno: deploy/db/rollback/0048_stock_suppliers.down.sql (telas e agenda do worker voltam às da
-- 0043; tabelas e prazos já informados ficam).

-- ===================================================================== permissão de Compras

alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'documents:view_full', 'finance.view_summary', 'finance.view_titles',
  'finance.view_customer_details', 'finance.view_overdue', 'finance.export',
  'stock.view_cost', 'stock.classify', 'stock.export', 'stock.purchasing'));

-- Mesmo corpo da 0041, com a permissão de Compras na lista das conhecidas.
create or replace function admin_internal.apply_access(p_user uuid, p_access jsonb, p_creating boolean, p_dry boolean)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_super boolean := admin_internal.is_super();
  v_scope uuid[] := admin_internal.actor_company_ids();
  v_known_roles constant text[] := array['SUPER_ADMIN','ADMIN','DIRETORIA','GESTOR','VENDEDOR','FINANCEIRO','ANALISTA','VIEWER'];
  v_known_perms constant text[] := array['documents:view_full','finance.view_summary','finance.view_titles',
    'finance.view_customer_details','finance.view_overdue','finance.export',
    'stock.view_cost','stock.classify','stock.export','stock.purchasing'];
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

-- ===================================================================== configuração e tabelas

alter table private.stock_settings add column if not exists suppliers_enabled boolean not null default false;

-- Fornecedores que o Omie liga a produtos, por empresa (o cadastro em si é o public.customers).
create table if not exists private.stock_suppliers (
  company_id uuid not null references public.companies(id) on delete cascade,
  supplier_id text not null check (supplier_id ~ '^[1-9][0-9]{0,19}$'),
  customer_id uuid references public.customers(id) on delete set null,
  omie_name text check (char_length(omie_name) <= 120),
  omie_trade_name text check (char_length(omie_trade_name) <= 120),
  in_omie boolean not null default false,
  job_id uuid,
  seen_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (company_id, supplier_id)
);

-- Produto × fornecedor: do Omie (in_omie, refeito a cada importação completa) ou manual (Compras).
create table if not exists private.stock_product_suppliers (
  company_id uuid not null,
  omie_product_id text not null check (omie_product_id ~ '^[1-9][0-9]{0,19}$'),
  supplier_id text not null,
  supplier_code text check (char_length(supplier_code) <= 60),
  in_omie boolean not null default false,
  manual boolean not null default false,
  job_id uuid,
  seen_at timestamptz,
  linked_by uuid,
  linked_at timestamptz,
  primary key (company_id, omie_product_id, supplier_id),
  foreign key (company_id, supplier_id) references private.stock_suppliers (company_id, supplier_id) on delete cascade,
  check (in_omie or manual)
);
create index if not exists stock_product_suppliers_supplier on private.stock_product_suppliers (company_id, supplier_id);

-- Fila das importações (uma aberta por empresa).
create table if not exists private.stock_supplier_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  trigger text not null check (trigger in ('schedule', 'manual', 'ops')),
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'failed')),
  pages_total integer check (pages_total >= 0),
  pages_done integer not null default 0 check (pages_done >= 0),
  records_expected integer,
  suppliers_saved integer not null default 0,
  links_saved integer not null default 0,
  records_skipped integer not null default 0,
  links_removed integer,
  attempts integer not null default 0,
  error text,
  requested_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  progress_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz
);
create unique index if not exists stock_supplier_jobs_open on private.stock_supplier_jobs (company_id)
  where status in ('queued', 'running');
create index if not exists stock_supplier_jobs_queue on private.stock_supplier_jobs (status, next_attempt_at, created_at);
create index if not exists stock_supplier_jobs_company on private.stock_supplier_jobs (company_id, created_at desc);

-- Prazo de entrega em dias corridos: do produto com aquele fornecedor, ou padrão do fornecedor ('').
create table if not exists private.stock_lead_times (
  company_id uuid not null,
  supplier_id text not null,
  omie_product_id text not null default '' check (omie_product_id = '' or omie_product_id ~ '^[1-9][0-9]{0,19}$'),
  lead_time_days integer not null check (lead_time_days between 1 and 365),
  min_lot numeric check (min_lot is null or (min_lot > 0 and min_lot <= 1000000)),
  status text not null default 'confirmado' check (status in ('confirmado', 'teste')),
  note text not null check (char_length(note) between 10 and 300),
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (company_id, supplier_id, omie_product_id),
  foreign key (company_id, supplier_id) references private.stock_suppliers (company_id, supplier_id) on delete cascade
);

-- Fornecedor principal (o da reposição) de um produto com mais de um fornecedor.
create table if not exists private.stock_preferred_suppliers (
  company_id uuid not null,
  omie_product_id text not null check (omie_product_id ~ '^[1-9][0-9]{0,19}$'),
  supplier_id text not null,
  note text not null check (char_length(note) between 10 and 300),
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (company_id, omie_product_id),
  foreign key (company_id, supplier_id) references private.stock_suppliers (company_id, supplier_id) on delete cascade
);

-- Histórico das alterações (a Auditoria recebe o mesmo evento).
create table if not exists private.stock_supplier_changes (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  supplier_id text,
  omie_product_id text not null default '',
  kind text not null check (kind in ('prazo', 'fornecedor_principal', 'vinculo', 'politica')),
  change text not null check (change in ('create', 'update', 'remove')),
  before jsonb,
  after jsonb,
  note text,
  changed_by uuid,
  changed_at timestamptz not null default clock_timestamp()
);
create index if not exists stock_supplier_changes_supplier
  on private.stock_supplier_changes (company_id, supplier_id, changed_at desc);
create index if not exists stock_supplier_changes_product
  on private.stock_supplier_changes (company_id, omie_product_id, changed_at desc);

revoke all on private.stock_suppliers, private.stock_product_suppliers, private.stock_supplier_jobs,
  private.stock_lead_times, private.stock_preferred_suppliers, private.stock_supplier_changes
  from public, anon, authenticated, service_role;

-- ===================================================================== apoio

-- Nome do fornecedor: o do cadastro do BIOMIE quando existe; senão o que o Omie devolveu na lista.
create or replace function stock_internal.supplier_display(p_company uuid, p_supplier text) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(
    (select nullif(btrim(cu.name), '') from public.customers cu
      where cu.company_id = p_company and cu.source = 'omie' and cu.external_id = p_supplier limit 1),
    (select coalesce(nullif(btrim(s.omie_trade_name), ''), nullif(btrim(s.omie_name), ''))
       from private.stock_suppliers s where s.company_id = p_company and s.supplier_id = p_supplier),
    'Fornecedor ' || p_supplier)
$$;

create or replace function stock_internal.supplier_json(p_company uuid, p_supplier text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('id', p_supplier, 'name', stock_internal.supplier_display(p_company, p_supplier))
$$;

-- Filtro por fornecedor: uma empresa por vez (o código do fornecedor é de cada conta do Omie).
create or replace function stock_internal.supplier_filter(p_scope uuid[], p_supplier text) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v text := nullif(btrim(coalesce(p_supplier, '')), '');
begin
  if v is null then return null; end if;
  if v !~ '^[1-9][0-9]{0,19}$' then
    raise exception 'Fornecedor inválido.' using errcode = 'P0001';
  end if;
  if not coalesce((stock_internal.caps()->>'suppliers')::boolean, false) then
    raise exception 'Seu perfil consulta previsões e reposições, mas não fornecedores e prazos de entrega.'
      using errcode = '42501';
  end if;
  if cardinality(p_scope) <> 1 then
    raise exception 'Escolha uma empresa para filtrar por fornecedor.' using errcode = 'P0001';
  end if;
  return v;
end $$;

-- Exatamente uma empresa do acesso do usuário.
create or replace function stock_internal.one_company(p_company text, p_message text) returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v uuid[] := stock_internal.scope(p_company);
begin
  if cardinality(v) <> 1 then
    raise exception '%', coalesce(p_message, 'Escolha uma empresa.') using errcode = 'P0001';
  end if;
  return v[1];
end $$;

-- Para gravar: a empresa tem de vir escolhida (nunca "todas"), mesmo para quem só tem uma.
create or replace function stock_internal.write_company(p_company text, p_message text) returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(nullif(btrim(p_company), ''), 'all') = 'all' then
    raise exception '%', coalesce(p_message, 'Escolha uma empresa.') using errcode = 'P0001';
  end if;
  return stock_internal.one_company(p_company, p_message);
end $$;

create or replace function stock_internal.valid_code(p text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  if v is null or v !~ '^[1-9][0-9]{0,19}$' then
    raise exception 'Código do Omie inválido.' using errcode = 'P0001';
  end if;
  return v;
end $$;

create or replace function stock_internal.valid_note(p text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  if v is null or char_length(v) < 10 or char_length(v) > 300 then
    raise exception 'Informe a observação (de 10 a 300 caracteres): a origem do prazo ou o motivo da mudança.'
      using errcode = 'P0001';
  end if;
  return v;
end $$;

-- Prazos de teste só valem na homologação (ajuste gravado pelo roteiro de teste; a produção não tem).
create or replace function stock_internal.test_lead_times_on() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select a.value = 'on' from private.app_settings a where a.key = 'stock.test_lead_times'), false)
$$;

create or replace function stock_internal.lead_time_json(t private.stock_lead_times) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select case when t.company_id is null then null else
    jsonb_build_object('leadTimeDays', t.lead_time_days, 'minLot', t.min_lot, 'status', t.status, 'note', t.note) end
$$;

-- Histórico + Auditoria de uma alteração de fornecedor, prazo, vínculo ou política. Na Auditoria, "antes"
-- e "depois" levam o fornecedor e o produto pelo nome, os valores e a observação.
create or replace function stock_internal.supplier_change(p_company uuid, p_supplier text, p_omie text, p_kind text,
  p_change text, p_before jsonb, p_after jsonb, p_note text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_ctx jsonb := jsonb_strip_nulls(jsonb_build_object(
    'fornecedor', case when p_supplier is not null then stock_internal.supplier_display(p_company, p_supplier) end,
    'produto', case when coalesce(p_omie, '') <> '' then coalesce((select x.name from public.products x
        where x.company_id = p_company and x.source = 'omie' and x.external_id = p_omie limit 1), p_omie) end));
begin
  insert into private.stock_supplier_changes (company_id, supplier_id, omie_product_id, kind, change, before, after,
    note, changed_by)
  values (p_company, p_supplier, coalesce(p_omie, ''), p_kind, p_change, p_before, p_after, p_note, auth.uid());
  perform stock_internal.log(case p_kind when 'prazo' then 'stock.lead_time.changed'
      when 'fornecedor_principal' then 'stock.preferred_supplier.changed'
      when 'vinculo' then 'stock.supplier_link.changed'
      else 'stock.replenishment_policy.changed' end, p_company,
    jsonb_build_object('mudanca', p_change, 'codigoFornecedor', p_supplier, 'codigoProduto', nullif(p_omie, ''),
      'before', case when p_before is not null then v_ctx || p_before end,
      'after', v_ctx || coalesce(p_after, jsonb_build_object('situacao', 'removido'))
               || jsonb_build_object('note', p_note)));
end $$;

-- Saldo e nome atuais dos produtos de uma empresa (última leitura publicada), um por produto.
create or replace function stock_internal.stock_products(p_company uuid)
returns table (omie_product_id text, sku text, name text, qty numeric)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select sp.omie_product_id, min(sp.sku), min(sp.name), sum(sp.physical_qty)
  from private.stock_current sc join private.stock_positions sp on sp.reading_id = sc.reading_id
  where sc.company_id = p_company
  group by sp.omie_product_id
$$;

-- ===================================================================== permissões do Estoque

-- caps e require da 0041 com "purchasing" (Compras: permissão extra stock.purchasing; Super admin).
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
  v_purchasing boolean;
  v_suppliers boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('view', false, 'viewCost', false, 'classify', false,
      'saveScenarios', false, 'export', false, 'refresh', false, 'purchasing', false, 'suppliers', false);
  end if;
  v_view := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR', 'FINANCEIRO', 'ANALISTA', 'VENDEDOR']
    or p && array['stock.view_cost', 'stock.classify', 'stock.export', 'stock.purchasing'];
  v_cost := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR', 'FINANCEIRO', 'ANALISTA']
    or 'stock.view_cost' = any(p);
  v_classify := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR'] or 'stock.classify' = any(p);
  v_save := v_cost and (r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'GESTOR', 'FINANCEIRO']
    or 'stock.classify' = any(p));
  v_export := r && array['SUPER_ADMIN', 'ADMIN', 'DIRETORIA', 'FINANCEIRO'] or 'stock.export' = any(p);
  v_refresh := r && array['SUPER_ADMIN', 'ADMIN'];
  -- Fornecedores e prazos de entrega (0048): Compras, pela permissão extra, e o Super admin.
  v_purchasing := r && array['SUPER_ADMIN'] or 'stock.purchasing' = any(p);
  -- Fornecedores e prazos (consulta): quem vê custo ou é Compras. O Comercial (Vendedor) consulta previsões
  -- e reposições, sem a área de fornecedores (ajuste aprovado em 27/10/2026).
  v_suppliers := v_cost or v_purchasing;
  return jsonb_build_object('view', v_view, 'viewCost', v_view and v_cost, 'classify', v_view and v_classify,
    'saveScenarios', v_view and v_save, 'export', v_view and v_export, 'refresh', v_view and v_refresh,
    'purchasing', v_view and v_purchasing, 'suppliers', v_view and v_suppliers);
end $$;

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
      when 'purchasing' then 'Só Compras ou o Super admin alteram fornecedores e prazos de entrega.'
      when 'suppliers' then 'Seu perfil consulta previsões e reposições, mas não fornecedores e prazos de entrega.'
      else 'Acesso negado.' end using errcode = '42501';
  end if;
  return v_caps;
end $$;

-- ===================================================================== worker (apenas service_role)

-- Pedido de importação fora da agenda (homologação e operação): uma aberta por empresa conectada.
create or replace function public.stock_worker_suppliers_enqueue(p_company uuid, p_trigger text) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_count integer := 0; v_company uuid;
begin
  if p_trigger is null or p_trigger not in ('ops', 'schedule') then
    raise exception 'pedido de importação inválido';
  end if;
  for v_company in
    select ci.company_id from public.company_integrations ci join public.companies c on c.id = ci.company_id
    where ci.provider = 'omie' and ci.status = 'CONNECTED' and not c.is_demo
      and c.data_source in ('OMIE', 'OMIE_SHADOW') and (p_company is null or c.id = p_company)
    order by c.name
  loop
    insert into private.stock_supplier_jobs (company_id, trigger) values (v_company, p_trigger) on conflict do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

create or replace function public.stock_worker_suppliers_claim() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_job private.stock_supplier_jobs;
begin
  -- Parada de mais de 30 min sem avançar: continua da página seguinte (o salvamento é idempotente).
  update private.stock_supplier_jobs set status = 'queued', next_attempt_at = null
    where status = 'running' and coalesce(progress_at, started_at) < now() - interval '30 minutes';
  select * into v_job from private.stock_supplier_jobs j
    where j.status in ('queued', 'running') and (j.next_attempt_at is null or j.next_attempt_at <= now())
    order by (j.status = 'running') desc, j.created_at
    limit 1 for update skip locked;
  if not found then return null; end if;
  if v_job.attempts >= 6 and v_job.pages_done = 0 then
    update private.stock_supplier_jobs set status = 'failed', finished_at = clock_timestamp(),
        error = coalesce(error, 'Importação de fornecedores abandonada após 6 tentativas.')
      where id = v_job.id;
    return null;
  end if;
  update private.stock_supplier_jobs set status = 'running', started_at = coalesce(started_at, clock_timestamp()),
      progress_at = coalesce(progress_at, clock_timestamp()),
      attempts = attempts + case when pages_done = 0 then 1 else 0 end, next_attempt_at = null
    where id = v_job.id returning * into v_job;
  return jsonb_build_object('id', v_job.id, 'companyId', v_job.company_id, 'nextPage', v_job.pages_done + 1,
    'pagesTotal', v_job.pages_total);
end $$;

-- Uma página do Omie: [{supplier_id, name, trade_name, products: [{omie, code}]}]. Gravação idempotente.
create or replace function public.stock_worker_suppliers_save_page(p_job uuid, p_page integer, p_pages_total integer,
  p_records_total integer, p_rows jsonb, p_skipped integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_job private.stock_supplier_jobs;
  v_suppliers integer;
  v_links integer;
begin
  select * into v_job from private.stock_supplier_jobs where id = p_job for update;
  if not found or v_job.status <> 'running' then raise exception 'importação de fornecedores não está em andamento'; end if;
  if p_page is null or p_page <> v_job.pages_done + 1 or p_pages_total is null or p_pages_total < 0
     or p_records_total is null or p_records_total < 0 or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) > 50 then
    raise exception 'página de fornecedores inválida (recebida %, esperada %)', p_page, v_job.pages_done + 1;
  end if;
  -- Total que muda no meio: recomeça da primeira página (o que já foi gravado continua valendo).
  if v_job.records_expected is not null and v_job.records_expected <> p_records_total then
    update private.stock_supplier_jobs set pages_done = 0, pages_total = null, records_expected = null,
        progress_at = clock_timestamp() where id = p_job;
    return jsonb_build_object('restarted', true, 'done', false);
  end if;
  insert into private.stock_suppliers as s (company_id, supplier_id, customer_id, omie_name, omie_trade_name,
      in_omie, job_id, seen_at)
    select distinct on (x.supplier_id) v_job.company_id, x.supplier_id,
      (select cu.id from public.customers cu where cu.company_id = v_job.company_id and cu.source = 'omie'
         and cu.external_id = x.supplier_id limit 1),
      left(nullif(btrim(x.name), ''), 120), left(nullif(btrim(x.trade_name), ''), 120), true, v_job.id, clock_timestamp()
    from jsonb_to_recordset(p_rows) as x(supplier_id text, name text, trade_name text)
    where x.supplier_id ~ '^[1-9][0-9]{0,19}$'
    order by x.supplier_id
    on conflict (company_id, supplier_id) do update set customer_id = coalesce(excluded.customer_id, s.customer_id),
      omie_name = excluded.omie_name, omie_trade_name = excluded.omie_trade_name, in_omie = true,
      job_id = excluded.job_id, seen_at = excluded.seen_at;
  get diagnostics v_suppliers = row_count;
  insert into private.stock_product_suppliers as l (company_id, omie_product_id, supplier_id, supplier_code, in_omie,
      job_id, seen_at)
    select distinct on (x.supplier_id, p.omie) v_job.company_id, p.omie, x.supplier_id,
      left(nullif(btrim(p.code), ''), 60), true, v_job.id, clock_timestamp()
    from jsonb_to_recordset(p_rows) as x(supplier_id text, products jsonb)
    cross join lateral jsonb_to_recordset(case when jsonb_typeof(x.products) = 'array' then x.products
                                               else '[]'::jsonb end) as p(omie text, code text)
    where x.supplier_id ~ '^[1-9][0-9]{0,19}$' and p.omie ~ '^[1-9][0-9]{0,19}$'
    order by x.supplier_id, p.omie
    on conflict (company_id, omie_product_id, supplier_id) do update set supplier_code = excluded.supplier_code,
      in_omie = true, job_id = excluded.job_id, seen_at = excluded.seen_at;
  get diagnostics v_links = row_count;
  update private.stock_supplier_jobs set pages_done = p_page, pages_total = p_pages_total,
      records_expected = p_records_total, suppliers_saved = suppliers_saved + v_suppliers,
      links_saved = links_saved + v_links, records_skipped = records_skipped + greatest(coalesce(p_skipped, 0), 0),
      progress_at = clock_timestamp()
    where id = p_job;
  return jsonb_build_object('restarted', false, 'suppliers', v_suppliers, 'links', v_links,
    'done', p_page >= p_pages_total);
end $$;

-- Fim da importação: vínculos do Omie que não vieram nesta importação deixam de ser do Omie (os só do
-- Omie saem; os manuais ficam). Importação vazia com vínculos anteriores não apaga nada (falha do Omie
-- não pode zerar a base). Prazos e fornecedor principal nunca são apagados aqui.
create or replace function public.stock_worker_suppliers_finish(p_job uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_job private.stock_supplier_jobs;
  v_removed integer := 0;
  v_kept boolean := false;
begin
  select * into v_job from private.stock_supplier_jobs where id = p_job for update;
  if not found or v_job.status <> 'running' then raise exception 'importação de fornecedores não está em andamento'; end if;
  if v_job.links_saved = 0 and exists (select 1 from private.stock_product_suppliers l
                                       where l.company_id = v_job.company_id and l.in_omie) then
    v_kept := true;
  else
    delete from private.stock_product_suppliers l
      where l.company_id = v_job.company_id and l.in_omie and not l.manual and l.job_id is distinct from v_job.id;
    get diagnostics v_removed = row_count;
    update private.stock_product_suppliers l set in_omie = false
      where l.company_id = v_job.company_id and l.in_omie and l.manual and l.job_id is distinct from v_job.id;
    update private.stock_suppliers s set in_omie = false
      where s.company_id = v_job.company_id and s.in_omie and s.job_id is distinct from v_job.id;
  end if;
  update private.stock_supplier_jobs set status = 'complete', finished_at = clock_timestamp(), next_attempt_at = null,
      links_removed = v_removed,
      error = case when v_kept then 'O Omie não devolveu nenhum vínculo: os vínculos anteriores foram mantidos.' end
    where id = p_job returning * into v_job;
  return jsonb_build_object('companyId', v_job.company_id, 'suppliers', v_job.suppliers_saved,
    'links', v_job.links_saved, 'linksRemoved', v_removed, 'keptPrevious', v_kept);
end $$;

-- Falha: final (credencial recusada, registro inválido) ou nova tentativa, nunca antes de 2 min (o Omie
-- recusa a mesma consulta repetida em menos de 1 min).
create or replace function public.stock_worker_suppliers_fail(p_job uuid, p_error text, p_retry_after_seconds integer,
  p_final boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_job private.stock_supplier_jobs;
begin
  select * into v_job from private.stock_supplier_jobs where id = p_job for update;
  if not found or v_job.status not in ('running', 'queued') then return jsonb_build_object('ok', false); end if;
  if coalesce(p_final, false) then
    update private.stock_supplier_jobs set status = 'failed', finished_at = clock_timestamp(), next_attempt_at = null,
        error = left(coalesce(nullif(p_error, ''), 'Falha na importação de fornecedores.'), 500)
      where id = p_job;
    return jsonb_build_object('ok', true, 'final', true);
  end if;
  update private.stock_supplier_jobs set status = 'queued',
      error = left(coalesce(nullif(p_error, ''), 'Falha na importação de fornecedores.'), 500),
      next_attempt_at = now() + make_interval(secs => greatest(120, least(coalesce(p_retry_after_seconds, 300), 3600)))
    where id = p_job;
  return jsonb_build_object('ok', true, 'final', false);
end $$;

-- Agenda do worker: a da 0043 mais a importação diária de fornecedores (quando ligada).
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
    -- Fornecedores do Omie (0048), quando ligados: uma importação agendada por dia e por empresa.
    if v_settings.suppliers_enabled and not exists (
         select 1 from private.stock_supplier_jobs j
         where j.company_id = v_company
           and (j.status in ('queued', 'running')
                or (j.trigger = 'schedule'
                    and (j.created_at at time zone 'America/Sao_Paulo')::date >= p_position_date))) then
      insert into private.stock_supplier_jobs (company_id, trigger) values (v_company, 'schedule')
        on conflict do nothing;
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

-- ===================================================================== telas

-- Fornecedores de uma empresa, com vínculos, saldo e prazos; resumo da importação.
create or replace function stock_internal.suppliers(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('suppliers');
  v_edit boolean := coalesce((v_caps->>'purchasing')::boolean, false);
  v_company uuid := stock_internal.one_company(p_query->>'companyId',
    'Escolha uma empresa: fornecedores e prazos são de cada empresa (cada uma tem a sua conta no Omie).');
  v_search text := nullif(stock_internal.fold(btrim(coalesce(p_query->>'search', ''))), '');
  v_status text := coalesce(nullif(p_query->>'status', ''), 'all');
  v_page integer := coalesce((p_query->>'page')::integer, 0);
  v_enabled boolean := (select s.suppliers_enabled from private.stock_settings s);
  v_rows jsonb;
  v_total integer;
  v_summary jsonb;
begin
  if v_status not in ('all', 'sem_prazo', 'com_prazo', 'teste', 'com_estoque') or v_page < 0 or v_page > 1000
     or char_length(coalesce(v_search, '')) > 120 then
    raise exception 'Consulta inválida.' using errcode = 'P0001';
  end if;
  with st as (select * from stock_internal.stock_products(v_company)),
  l as (
    select ps.supplier_id, count(*)::integer as products, count(*) filter (where st.qty > 0)::integer as with_stock
    from private.stock_product_suppliers ps left join st on st.omie_product_id = ps.omie_product_id
    where ps.company_id = v_company group by ps.supplier_id),
  lt as (
    select t.supplier_id,
      max(t.lead_time_days) filter (where t.omie_product_id = '') as default_days,
      max(t.status) filter (where t.omie_product_id = '') as default_status,
      count(*) filter (where t.omie_product_id <> '')::integer as product_rows,
      bool_or(t.status = 'teste') as any_test, max(t.updated_at) as updated_at
    from private.stock_lead_times t where t.company_id = v_company group by t.supplier_id),
  pf as (
    select p.supplier_id, count(*)::integer as preferred from private.stock_preferred_suppliers p
    where p.company_id = v_company group by p.supplier_id),
  sup as (
    select s.supplier_id, stock_internal.supplier_display(s.company_id, s.supplier_id) as name, s.in_omie,
      cu.city, cu.state, coalesce(l.products, 0) as products, coalesce(l.with_stock, 0) as with_stock,
      lt.default_days, lt.default_status, coalesce(lt.product_rows, 0) as product_rows,
      coalesce(lt.any_test, false) as any_test, lt.updated_at, coalesce(pf.preferred, 0) as preferred
    from private.stock_suppliers s
    left join public.customers cu on cu.company_id = s.company_id and cu.source = 'omie' and cu.external_id = s.supplier_id
    left join l on l.supplier_id = s.supplier_id
    left join lt on lt.supplier_id = s.supplier_id
    left join pf on pf.supplier_id = s.supplier_id
    where s.company_id = v_company and (s.in_omie or l.products > 0 or lt.supplier_id is not null)),
  f as (
    select sup.* from sup
    where (v_search is null or strpos(stock_internal.fold(sup.name || ' ' || sup.supplier_id), v_search) > 0)
      and (v_status = 'all'
           or (v_status = 'sem_prazo' and sup.default_days is null and sup.product_rows = 0)
           or (v_status = 'com_prazo' and (sup.default_days is not null or sup.product_rows > 0))
           or (v_status = 'teste' and sup.any_test)
           or (v_status = 'com_estoque' and sup.with_stock > 0))),
  o as (
    select f.*, count(*) over () as total_count,
      row_number() over (order by f.with_stock desc, f.products desc, f.name, f.supplier_id) as rn
    from f)
  select coalesce(max(o.total_count), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object('supplierId', o.supplier_id, 'name', o.name, 'city', o.city,
      'state', o.state, 'inOmie', o.in_omie, 'products', o.products, 'productsWithStock', o.with_stock,
      'leadTimeDays', o.default_days, 'leadTimeStatus', o.default_status, 'productLeadTimes', o.product_rows,
      'hasTestLeadTimes', o.any_test, 'preferredFor', o.preferred, 'updatedAt', o.updated_at) order by o.rn)
      filter (where o.rn > v_page * 50 and o.rn <= (v_page + 1) * 50), '[]'::jsonb)
  into v_total, v_rows
  from o;

  with st as (select * from stock_internal.stock_products(v_company) where qty > 0),
  cov as (
    select st.omie_product_id,
      exists (select 1 from private.stock_product_suppliers ps
              where ps.company_id = v_company and ps.omie_product_id = st.omie_product_id) as linked,
      exists (select 1 from private.stock_product_suppliers ps
              join private.stock_lead_times t on t.company_id = ps.company_id and t.supplier_id = ps.supplier_id
                and t.omie_product_id in ('', ps.omie_product_id)
              where ps.company_id = v_company and ps.omie_product_id = st.omie_product_id
                and t.status = 'confirmado') as confirmed
    from st),
  job as (
    select j.* from private.stock_supplier_jobs j where j.company_id = v_company
    order by j.created_at desc limit 1),
  ok as (
    select j.finished_at from private.stock_supplier_jobs j where j.company_id = v_company and j.status = 'complete'
    order by j.finished_at desc limit 1)
  select jsonb_build_object(
    'suppliers', (select count(*) from private.stock_suppliers s where s.company_id = v_company and s.in_omie),
    'links', (select count(*) from private.stock_product_suppliers ps where ps.company_id = v_company),
    'manualLinks', (select count(*) from private.stock_product_suppliers ps
                    where ps.company_id = v_company and ps.manual and not ps.in_omie),
    'productsWithStock', (select count(*) from cov),
    'productsWithStockLinked', (select count(*) from cov where cov.linked),
    'productsWithStockConfirmed', (select count(*) from cov where cov.confirmed),
    'testLeadTimes', (select count(*) from private.stock_lead_times t where t.company_id = v_company and t.status = 'teste'),
    'testLeadTimesOn', stock_internal.test_lead_times_on(),
    'importEnabled', coalesce(v_enabled, false),
    'lastImportAt', (select ok.finished_at from ok),
    'lastJob', (select jsonb_build_object('status', job.status, 'trigger', job.trigger, 'createdAt', job.created_at,
                  'finishedAt', job.finished_at, 'pagesDone', job.pages_done, 'pagesTotal', job.pages_total,
                  'suppliers', job.suppliers_saved, 'links', job.links_saved, 'linksRemoved', job.links_removed,
                  'error', case when v_edit then job.error end) from job))
  into v_summary;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'summary', v_summary, 'canEdit', v_edit,
    'canImport', v_edit and coalesce(v_enabled, false));
end $$;

-- Um fornecedor: prazo padrão, produtos vinculados (com saldo, curva, prazo e fornecedor principal),
-- prazos sem vínculo ativo e, para Compras e o Super admin, o histórico com nomes.
create or replace function stock_internal.supplier(p_company text, p_supplier text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('suppliers');
  v_edit boolean := coalesce((v_caps->>'purchasing')::boolean, false);
  v_company uuid := stock_internal.one_company(p_company, 'Escolha uma empresa.');
  v_supplier text := stock_internal.valid_code(p_supplier);
  v_window text := stock_internal.pick_window(null);
  v_has_run boolean;
  v_sup private.stock_suppliers;
  v jsonb;
begin
  select * into v_sup from private.stock_suppliers s where s.company_id = v_company and s.supplier_id = v_supplier;
  if not found then raise exception 'Fornecedor não encontrado nesta empresa.' using errcode = 'P0002'; end if;
  v_has_run := exists (select 1 from private.stock_curve_runs r where r.company_id = v_company and r.status = 'ok');
  with st as (select * from stock_internal.stock_products(v_company)),
  d as (select * from private.stock_lead_times t
        where t.company_id = v_company and t.supplier_id = v_supplier and t.omie_product_id = ''),
  p as (
    select ps.omie_product_id as omie, ps.supplier_code, ps.in_omie, ps.manual,
      coalesce(st.sku, pr.sku) as sku, coalesce(st.name, pr.name) as name, pr.id as product_id, st.qty,
      case when m.curve is not null then m.curve when a.curve is not null then a.curve
           when not v_has_run then 'U' when st.qty > 0 then 'D' else 'U' end as curve,
      t.lead_time_days as own_days, t.min_lot as own_lot, t.status as own_status, t.note as own_note,
      t.updated_at as own_at, pf.supplier_id as preferred_id,
      (select count(*) from private.stock_product_suppliers o
        where o.company_id = v_company and o.omie_product_id = ps.omie_product_id and o.supplier_id <> v_supplier)::integer
        as others
    from private.stock_product_suppliers ps
    left join st on st.omie_product_id = ps.omie_product_id
    left join lateral (select x.id, x.sku, x.name from public.products x
                       where x.company_id = v_company and x.source = 'omie' and x.external_id = ps.omie_product_id
                       limit 1) pr on true
    left join private.stock_curves m on m.company_id = v_company and m.omie_product_id = ps.omie_product_id
    left join private.stock_auto_curves a on a.company_id = v_company and a.curve_window = v_window
      and a.omie_product_id = ps.omie_product_id
    left join private.stock_lead_times t on t.company_id = v_company and t.supplier_id = v_supplier
      and t.omie_product_id = ps.omie_product_id
    left join private.stock_preferred_suppliers pf on pf.company_id = v_company and pf.omie_product_id = ps.omie_product_id
    where ps.company_id = v_company and ps.supplier_id = v_supplier),
  orphan as (
    select t.*, coalesce(st.name, pr.name) as name, coalesce(st.sku, pr.sku) as sku
    from private.stock_lead_times t
    left join st on st.omie_product_id = t.omie_product_id
    left join lateral (select x.sku, x.name from public.products x
                       where x.company_id = v_company and x.source = 'omie' and x.external_id = t.omie_product_id
                       limit 1) pr on true
    where t.company_id = v_company and t.supplier_id = v_supplier and t.omie_product_id <> ''
      and not exists (select 1 from private.stock_product_suppliers ps where ps.company_id = v_company
                      and ps.supplier_id = v_supplier and ps.omie_product_id = t.omie_product_id))
  select jsonb_build_object(
    'supplierId', v_supplier, 'name', stock_internal.supplier_display(v_company, v_supplier),
    'legalName', coalesce((select nullif(cc.legal_name, '') from public.canonical_customers cc
                           where cc.company_id = v_company and cc.source = 'omie' and cc.external_id = v_supplier
                           limit 1), v_sup.omie_name),
    'city', (select cu.city from public.customers cu where cu.company_id = v_company and cu.source = 'omie'
               and cu.external_id = v_supplier limit 1),
    'state', (select cu.state from public.customers cu where cu.company_id = v_company and cu.source = 'omie'
                and cu.external_id = v_supplier limit 1),
    'inOmie', v_sup.in_omie, 'seenAt', v_sup.seen_at, 'canEdit', v_edit,
    'testLeadTimesOn', stock_internal.test_lead_times_on(),
    'defaultLeadTime', (select jsonb_build_object('leadTimeDays', d.lead_time_days, 'minLot', d.min_lot,
        'status', d.status, 'note', d.note, 'updatedAt', d.updated_at,
        'updatedBy', case when v_edit then (select coalesce(nullif(u.full_name, ''), 'Usuário') from public.profiles u
                                            where u.id = d.updated_by) end) from d),
    'products', coalesce((select jsonb_agg(jsonb_build_object('omieProductId', p.omie, 'productId', p.product_id,
        'sku', p.sku, 'name', p.name, 'supplierCode', p.supplier_code, 'inOmie', p.in_omie, 'manual', p.manual,
        'qty', p.qty, 'curve', p.curve, 'otherSuppliers', p.others,
        'leadTime', case when p.own_days is not null then jsonb_build_object('leadTimeDays', p.own_days,
            'minLot', p.own_lot, 'status', p.own_status, 'note', p.own_note, 'updatedAt', p.own_at) end,
        'preferred', case when p.preferred_id is null then null when p.preferred_id = v_supplier then 'este'
                          else 'outro' end,
        'preferredName', case when p.preferred_id is not null and p.preferred_id <> v_supplier
                              then stock_internal.supplier_display(v_company, p.preferred_id) end)
      order by (coalesce(p.qty, 0) > 0) desc, p.name, p.omie) from p), '[]'::jsonb),
    'orphanLeadTimes', coalesce((select jsonb_agg(jsonb_build_object('omieProductId', o.omie_product_id,
        'sku', o.sku, 'name', o.name, 'leadTimeDays', o.lead_time_days, 'status', o.status, 'updatedAt', o.updated_at)
      order by o.name, o.omie_product_id) from orphan o), '[]'::jsonb),
    'history', case when v_edit then coalesce((select jsonb_agg(jsonb_build_object('kind', h.kind,
        'change', h.change, 'omieProductId', nullif(h.omie_product_id, ''),
        'productName', (select x.name from public.products x where x.company_id = v_company and x.source = 'omie'
                          and x.external_id = h.omie_product_id limit 1),
        'before', h.before, 'after', h.after, 'note', h.note, 'at', h.changed_at,
        'by', (select coalesce(nullif(u.full_name, ''), 'Usuário') from public.profiles u where u.id = h.changed_by))
      order by h.changed_at desc, h.id desc)
      from (select * from private.stock_supplier_changes c
            where c.company_id = v_company and (c.supplier_id = v_supplier or c.before->>'supplierId' = v_supplier)
            order by c.changed_at desc, c.id desc limit 200) h), '[]'::jsonb) end)
  into v;
  return v;
end $$;

-- Fornecedores de um produto (ficha do produto): prazo efetivo de cada um e o principal.
create or replace function stock_internal.product_suppliers(p_company text, p_omie text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('suppliers');
  v_edit boolean := coalesce((v_caps->>'purchasing')::boolean, false);
  v_company uuid := stock_internal.one_company(p_company, 'Escolha uma empresa.');
  v_omie text := stock_internal.valid_code(p_omie);
  v_pref private.stock_preferred_suppliers;
begin
  select * into v_pref from private.stock_preferred_suppliers p where p.company_id = v_company and p.omie_product_id = v_omie;
  return jsonb_build_object('omieProductId', v_omie, 'canEdit', v_edit,
    'testLeadTimesOn', stock_internal.test_lead_times_on(),
    'preferred', case when v_pref.company_id is not null then jsonb_build_object('supplierId', v_pref.supplier_id,
        'name', stock_internal.supplier_display(v_company, v_pref.supplier_id), 'note', v_pref.note,
        'updatedAt', v_pref.updated_at,
        'updatedBy', case when v_edit then (select coalesce(nullif(u.full_name, ''), 'Usuário') from public.profiles u
                                            where u.id = v_pref.updated_by) end) end,
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('supplierId', ps.supplier_id,
        'name', stock_internal.supplier_display(v_company, ps.supplier_id), 'supplierCode', ps.supplier_code,
        'inOmie', ps.in_omie, 'manual', ps.manual, 'isPreferred', coalesce(ps.supplier_id = v_pref.supplier_id, false),
        'leadTimeDays', coalesce(t.lead_time_days, d.lead_time_days),
        'leadTimeSource', case when t.lead_time_days is not null then 'produto'
                               when d.lead_time_days is not null then 'fornecedor' end,
        'leadTimeStatus', coalesce(t.status, d.status), 'minLot', coalesce(t.min_lot, d.min_lot),
        'note', coalesce(t.note, d.note), 'updatedAt', coalesce(t.updated_at, d.updated_at))
      order by (ps.supplier_id = v_pref.supplier_id) desc, stock_internal.supplier_display(v_company, ps.supplier_id))
      from private.stock_product_suppliers ps
      left join private.stock_lead_times t on t.company_id = ps.company_id and t.supplier_id = ps.supplier_id
        and t.omie_product_id = ps.omie_product_id
      left join private.stock_lead_times d on d.company_id = ps.company_id and d.supplier_id = ps.supplier_id
        and d.omie_product_id = ''
      where ps.company_id = v_company and ps.omie_product_id = v_omie), '[]'::jsonb));
end $$;

-- Define, altera ou remove (p_values nulo) o prazo de um fornecedor: de um produto ou o padrão dele
-- (p_omie vazio). Só Compras e o Super admin; sempre com observação; histórico e Auditoria.
create or replace function stock_internal.lead_time_set(p_company text, p_supplier text, p_omie text,
  p_values jsonb, p_note text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('purchasing');
  v_company uuid := stock_internal.write_company(p_company, 'Escolha uma empresa: os prazos são de cada empresa.');
  v_supplier text := stock_internal.valid_code(p_supplier);
  v_omie text := case when nullif(btrim(coalesce(p_omie, '')), '') is null then '' else stock_internal.valid_code(p_omie) end;
  v_note text := stock_internal.valid_note(p_note);
  v_before private.stock_lead_times;
  v_days integer;
  v_lot numeric;
begin
  if not exists (select 1 from private.stock_suppliers s where s.company_id = v_company and s.supplier_id = v_supplier) then
    raise exception 'Fornecedor não encontrado nesta empresa.' using errcode = 'P0001';
  end if;
  if v_omie <> '' and not exists (select 1 from private.stock_product_suppliers ps where ps.company_id = v_company
       and ps.supplier_id = v_supplier and ps.omie_product_id = v_omie) then
    raise exception 'Este produto não está vinculado a este fornecedor. Vincule o fornecedor ao produto antes de informar o prazo.'
      using errcode = 'P0001';
  end if;
  select * into v_before from private.stock_lead_times t
   where t.company_id = v_company and t.supplier_id = v_supplier and t.omie_product_id = v_omie for update;
  if p_values is null or jsonb_typeof(p_values) = 'null' then
    if v_before.company_id is null then return jsonb_build_object('removed', false); end if;
    delete from private.stock_lead_times t
     where t.company_id = v_company and t.supplier_id = v_supplier and t.omie_product_id = v_omie;
    perform stock_internal.supplier_change(v_company, v_supplier, v_omie, 'prazo', 'remove',
      stock_internal.lead_time_json(v_before), null, v_note);
    return jsonb_build_object('removed', true);
  end if;
  begin
    v_days := (p_values->>'leadTimeDays')::integer;
    v_lot := nullif(p_values->>'minLot', '')::numeric;
  exception when others then
    raise exception 'Prazo inválido: use um número inteiro de dias.' using errcode = 'P0001';
  end;
  if v_days is null or v_days not between 1 and 365 or (v_lot is not null and (v_lot <= 0 or v_lot > 1000000)) then
    raise exception 'Prazo de 1 a 365 dias corridos; lote mínimo, se informado, maior que zero.' using errcode = 'P0001';
  end if;
  insert into private.stock_lead_times as t (company_id, supplier_id, omie_product_id, lead_time_days, min_lot, status,
    note, created_by, updated_by)
  values (v_company, v_supplier, v_omie, v_days, v_lot, 'confirmado', v_note, auth.uid(), auth.uid())
  on conflict (company_id, supplier_id, omie_product_id) do update set lead_time_days = excluded.lead_time_days,
    min_lot = excluded.min_lot, status = 'confirmado', note = excluded.note, updated_by = excluded.updated_by,
    updated_at = clock_timestamp();
  perform stock_internal.supplier_change(v_company, v_supplier, v_omie, 'prazo',
    case when v_before.company_id is null then 'create' else 'update' end, stock_internal.lead_time_json(v_before),
    jsonb_build_object('leadTimeDays', v_days, 'minLot', v_lot, 'status', 'confirmado', 'note', v_note), v_note);
  return jsonb_build_object('saved', true);
end $$;

-- Fornecedor principal do produto (um dos vinculados) ou nenhum (p_supplier nulo).
create or replace function stock_internal.preferred_supplier_set(p_company text, p_omie text, p_supplier text,
  p_note text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('purchasing');
  v_company uuid := stock_internal.write_company(p_company, 'Escolha uma empresa.');
  v_omie text := stock_internal.valid_code(p_omie);
  v_supplier text := case when nullif(btrim(coalesce(p_supplier, '')), '') is null then null
                          else stock_internal.valid_code(p_supplier) end;
  v_note text := stock_internal.valid_note(p_note);
  v_before private.stock_preferred_suppliers;
  v_before_json jsonb;
begin
  select * into v_before from private.stock_preferred_suppliers p
   where p.company_id = v_company and p.omie_product_id = v_omie for update;
  if v_before.company_id is not null then
    v_before_json := jsonb_build_object('supplierId', v_before.supplier_id,
      'principal', stock_internal.supplier_display(v_company, v_before.supplier_id));
  end if;
  if v_supplier is null then
    if v_before.company_id is null then return jsonb_build_object('removed', false); end if;
    delete from private.stock_preferred_suppliers p where p.company_id = v_company and p.omie_product_id = v_omie;
    perform stock_internal.supplier_change(v_company, v_before.supplier_id, v_omie, 'fornecedor_principal', 'remove',
      v_before_json, null, v_note);
    return jsonb_build_object('removed', true);
  end if;
  if not exists (select 1 from private.stock_product_suppliers ps where ps.company_id = v_company
                 and ps.omie_product_id = v_omie and ps.supplier_id = v_supplier) then
    raise exception 'O fornecedor principal precisa ser um dos fornecedores vinculados ao produto.' using errcode = 'P0001';
  end if;
  if v_before.supplier_id = v_supplier then return jsonb_build_object('saved', false); end if;
  insert into private.stock_preferred_suppliers as p (company_id, omie_product_id, supplier_id, note, updated_by)
  values (v_company, v_omie, v_supplier, v_note, auth.uid())
  on conflict (company_id, omie_product_id) do update set supplier_id = excluded.supplier_id, note = excluded.note,
    updated_by = excluded.updated_by, updated_at = clock_timestamp();
  perform stock_internal.supplier_change(v_company, v_supplier, v_omie, 'fornecedor_principal',
    case when v_before.company_id is null then 'create' else 'update' end, v_before_json,
    jsonb_build_object('supplierId', v_supplier, 'principal', stock_internal.supplier_display(v_company, v_supplier)), v_note);
  return jsonb_build_object('saved', true);
end $$;

-- Vínculo manual produto × fornecedor (o fornecedor é um cadastro da empresa no BIOMIE). Remover só
-- tira o vínculo manual; com ele saem o prazo daquele produto e, se for o caso, o fornecedor principal.
create or replace function stock_internal.supplier_link_set(p_company text, p_omie text, p_supplier text,
  p_linked boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('purchasing');
  v_company uuid := stock_internal.write_company(p_company, 'Escolha uma empresa.');
  v_omie text := stock_internal.valid_code(p_omie);
  v_supplier text := stock_internal.valid_code(p_supplier);
  v_note text := stock_internal.valid_note(p_note);
  v_link private.stock_product_suppliers;
  v_lead private.stock_lead_times;
  v_customer uuid;
begin
  if p_linked is null then raise exception 'Pedido inválido.' using errcode = 'P0001'; end if;
  select * into v_link from private.stock_product_suppliers ps
   where ps.company_id = v_company and ps.omie_product_id = v_omie and ps.supplier_id = v_supplier for update;
  if p_linked then
    if v_link.company_id is not null and v_link.manual then return jsonb_build_object('changed', false); end if;
    if not exists (select 1 from private.stock_suppliers s where s.company_id = v_company and s.supplier_id = v_supplier) then
      select cu.id into v_customer from public.customers cu
       where cu.company_id = v_company and cu.source = 'omie' and cu.external_id = v_supplier limit 1;
      if v_customer is null then
        raise exception 'Fornecedor não encontrado no cadastro desta empresa (importado do Omie).' using errcode = 'P0001';
      end if;
      insert into private.stock_suppliers (company_id, supplier_id, customer_id, in_omie)
      values (v_company, v_supplier, v_customer, false) on conflict do nothing;
    end if;
    if not exists (select 1 from public.products x where x.company_id = v_company and x.source = 'omie'
                   and x.external_id = v_omie)
       and not exists (select 1 from stock_internal.stock_products(v_company) sp where sp.omie_product_id = v_omie) then
      raise exception 'Produto não encontrado nesta empresa.' using errcode = 'P0001';
    end if;
    insert into private.stock_product_suppliers as l (company_id, omie_product_id, supplier_id, manual, linked_by, linked_at)
    values (v_company, v_omie, v_supplier, true, auth.uid(), clock_timestamp())
    on conflict (company_id, omie_product_id, supplier_id) do update set manual = true, linked_by = excluded.linked_by,
      linked_at = excluded.linked_at;
    perform stock_internal.supplier_change(v_company, v_supplier, v_omie, 'vinculo',
      case when v_link.company_id is null then 'create' else 'update' end,
      case when v_link.company_id is not null then jsonb_build_object('omie', v_link.in_omie, 'manual', v_link.manual) end,
      jsonb_build_object('omie', coalesce(v_link.in_omie, false), 'manual', true), v_note);
    return jsonb_build_object('changed', true);
  end if;
  if v_link.company_id is null or not v_link.manual then
    if v_link.company_id is not null then
      raise exception 'Este vínculo vem do Omie (Produto x Fornecedor): retire-o no Omie; a próxima importação atualiza o BIOMIE.'
        using errcode = 'P0001';
    end if;
    return jsonb_build_object('changed', false);
  end if;
  if v_link.in_omie then
    update private.stock_product_suppliers ps set manual = false, linked_by = null, linked_at = null
     where ps.company_id = v_company and ps.omie_product_id = v_omie and ps.supplier_id = v_supplier;
  else
    delete from private.stock_product_suppliers ps
     where ps.company_id = v_company and ps.omie_product_id = v_omie and ps.supplier_id = v_supplier;
    select * into v_lead from private.stock_lead_times t
     where t.company_id = v_company and t.supplier_id = v_supplier and t.omie_product_id = v_omie;
    if v_lead.company_id is not null then
      delete from private.stock_lead_times t
       where t.company_id = v_company and t.supplier_id = v_supplier and t.omie_product_id = v_omie;
      perform stock_internal.supplier_change(v_company, v_supplier, v_omie, 'prazo', 'remove',
        stock_internal.lead_time_json(v_lead), null, 'Removido junto com o vínculo manual: ' || v_note);
    end if;
    if exists (select 1 from private.stock_preferred_suppliers p where p.company_id = v_company
               and p.omie_product_id = v_omie and p.supplier_id = v_supplier) then
      delete from private.stock_preferred_suppliers p where p.company_id = v_company and p.omie_product_id = v_omie;
      perform stock_internal.supplier_change(v_company, v_supplier, v_omie, 'fornecedor_principal', 'remove',
        jsonb_build_object('supplierId', v_supplier, 'principal', stock_internal.supplier_display(v_company, v_supplier)),
        null, 'Removido junto com o vínculo manual: ' || v_note);
    end if;
  end if;
  perform stock_internal.supplier_change(v_company, v_supplier, v_omie, 'vinculo', 'remove',
    jsonb_build_object('omie', v_link.in_omie, 'manual', true), jsonb_build_object('omie', v_link.in_omie, 'manual', false),
    v_note);
  return jsonb_build_object('changed', true);
end $$;

-- Busca no cadastro da empresa (clientes/fornecedores importados do Omie) para vincular a um produto.
-- Só para Compras e o Super admin (o cadastro inteiro não é visível para todos os perfis).
create or replace function stock_internal.supplier_search(p_company text, p_search text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('purchasing');
  v_company uuid := stock_internal.one_company(p_company, 'Escolha uma empresa.');
  v_search text := nullif(stock_internal.fold(btrim(coalesce(p_search, ''))), '');
begin
  if v_search is null or char_length(v_search) < 3 or char_length(v_search) > 120 then
    raise exception 'Digite pelo menos 3 letras do nome.' using errcode = 'P0001';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('supplierId', t.external_id, 'name', t.name, 'city', t.city,
      'state', t.state, 'isSupplier', t.is_supplier) order by t.is_supplier desc, t.name)
    from (select cu.external_id, cu.name, cu.city, cu.state,
            exists (select 1 from private.stock_suppliers s where s.company_id = v_company
                    and s.supplier_id = cu.external_id) as is_supplier
          from public.customers cu
          where cu.company_id = v_company and cu.source = 'omie' and cu.external_id ~ '^[1-9][0-9]{0,19}$'
            and strpos(stock_internal.fold(cu.name), v_search) > 0
          order by 5 desc, cu.name limit 20) t), '[]'::jsonb);
end $$;

-- Importação pedida pela tela (Compras ou Super admin), com a importação liberada no banco: uma por vez
-- e no máximo uma a cada 30 minutos por empresa.
create or replace function stock_internal.supplier_request_import(p_company text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('purchasing');
  v_company uuid := stock_internal.write_company(p_company, 'Escolha uma empresa.');
  v_last timestamptz;
begin
  if not coalesce((select s.suppliers_enabled from private.stock_settings s), false) then
    raise exception 'A importação de fornecedores do Omie ainda não foi liberada.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.company_integrations ci join public.companies c on c.id = ci.company_id
                 where ci.company_id = v_company and ci.provider = 'omie' and ci.status = 'CONNECTED'
                   and not c.is_demo and c.data_source in ('OMIE', 'OMIE_SHADOW')) then
    raise exception 'Esta empresa não está conectada ao Omie.' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.stock_supplier_jobs j where j.company_id = v_company and j.status in ('queued', 'running')) then
    return jsonb_build_object('queued', false, 'inProgress', true, 'nextAllowedAt', null);
  end if;
  select max(j.created_at) into v_last from private.stock_supplier_jobs j
   where j.company_id = v_company and j.trigger = 'manual';
  if v_last is not null and v_last > now() - interval '30 minutes' then
    return jsonb_build_object('queued', false, 'inProgress', false, 'nextAllowedAt', v_last + interval '30 minutes');
  end if;
  insert into private.stock_supplier_jobs (company_id, trigger, requested_by) values (v_company, 'manual', auth.uid())
    on conflict do nothing;
  perform stock_internal.log('stock.suppliers.import_requested', v_company, null);
  return jsonb_build_object('queued', true, 'inProgress', false, 'nextAllowedAt', null);
end $$;

-- ===================================================================== filtro por fornecedor

-- ===================================================================== pontos de entrada

drop function if exists public.stock_overview(text, text);
drop function if exists stock_internal.overview(text, text);

-- Painel da 0043 com o filtro por fornecedor (uma empresa).
create or replace function stock_internal.overview(p_company text, p_window text, p_supplier text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_caps jsonb := stock_internal.require('view');
  v_cost boolean := (v_caps->>'viewCost')::boolean;
  v_admin boolean := (v_caps->>'refresh')::boolean;
  v_scope uuid[] := stock_internal.scope(p_company);
  v_window text := stock_internal.pick_window(p_window);
  v_stale interval := make_interval(hours => (select s.stale_hours from private.stock_settings s));
  v_supplier text := stock_internal.supplier_filter(v_scope, p_supplier);
  v jsonb;
begin
  with x as (
    select cr.* from stock_internal.current_rows(v_scope, v_window) cr
    where v_supplier is null or exists (select 1 from private.stock_product_suppliers ps
      where ps.company_id = cr.company_id and ps.omie_product_id = cr.omie_product_id and ps.supplier_id = v_supplier)),
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
    'supplier', case when v_supplier is not null then stock_internal.supplier_json(v_scope[1], v_supplier) end,
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

-- Posições da 0043 com os filtros "fornecedor" e "sem fornecedor vinculado".
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
  v_supplier text := stock_internal.supplier_filter(v_scope, p_query->>'supplier');
  v_no_supplier boolean := coalesce((p_query->>'noSupplier')::boolean, false);
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
      and (v_supplier is null or exists (select 1 from private.stock_product_suppliers ps
      where ps.company_id = r.company_id and ps.omie_product_id = r.omie_product_id and ps.supplier_id = v_supplier))
      and (not v_no_supplier or not exists (select 1 from private.stock_product_suppliers ps
           where ps.company_id = r.company_id and ps.omie_product_id = r.omie_product_id))
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
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'window', v_window, 'view', v_view,
    'supplier', v_supplier);
end $$;

-- Opções de filtro da 0043 com a lista de fornecedores da empresa.
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
    'defaultWindow', stock_internal.pick_window(null),
    -- Fornecedores (0048): só com uma empresa, porque o código do fornecedor é de cada conta do Omie.
    'suppliers', case when cardinality(v_scope) = 1 and coalesce((v_caps->>'suppliers')::boolean, false) then coalesce((
        select jsonb_agg(jsonb_build_object('id', s.supplier_id, 'name', s.name, 'products', s.products)
                         order by s.name, s.supplier_id)
        from (select ps.supplier_id, stock_internal.supplier_display(ps.company_id, ps.supplier_id) as name,
                count(distinct ps.omie_product_id)::integer as products
              from private.stock_product_suppliers ps
              where ps.company_id = v_scope[1]
                and exists (select 1 from x where x.company_id = ps.company_id and x.omie_product_id = ps.omie_product_id)
              group by ps.company_id, ps.supplier_id) s), '[]'::jsonb) else '[]'::jsonb end,
    'suppliersNeedCompany', cardinality(v_scope) > 1,
    'suppliersAllowed', coalesce((v_caps->>'suppliers')::boolean, false))
  into v;
  return v;
end $$;

create or replace function public.stock_overview(p_company text, p_window text default null, p_supplier text default null)
returns jsonb language sql stable as $$ select stock_internal.overview(p_company, p_window, p_supplier) $$;
create or replace function public.stock_suppliers(p_query jsonb)
returns jsonb language sql stable as $$ select stock_internal.suppliers(p_query) $$;
create or replace function public.stock_supplier(p_company text, p_supplier text)
returns jsonb language sql stable as $$ select stock_internal.supplier(p_company, p_supplier) $$;
create or replace function public.stock_product_suppliers(p_company text, p_omie text)
returns jsonb language sql stable as $$ select stock_internal.product_suppliers(p_company, p_omie) $$;
create or replace function public.stock_lead_time_set(p_company text, p_supplier text, p_omie text, p_values jsonb,
  p_note text)
returns jsonb language sql as $$ select stock_internal.lead_time_set(p_company, p_supplier, p_omie, p_values, p_note) $$;
create or replace function public.stock_preferred_supplier_set(p_company text, p_omie text, p_supplier text, p_note text)
returns jsonb language sql as $$ select stock_internal.preferred_supplier_set(p_company, p_omie, p_supplier, p_note) $$;
create or replace function public.stock_supplier_link_set(p_company text, p_omie text, p_supplier text, p_linked boolean,
  p_note text)
returns jsonb language sql as $$ select stock_internal.supplier_link_set(p_company, p_omie, p_supplier, p_linked, p_note) $$;
create or replace function public.stock_supplier_search(p_company text, p_search text)
returns jsonb language sql stable as $$ select stock_internal.supplier_search(p_company, p_search) $$;
create or replace function public.stock_supplier_request_import(p_company text)
returns jsonb language sql as $$ select stock_internal.supplier_request_import(p_company) $$;

-- Funções novas do stock_internal: fechadas para todos; a tela entra só pelas que a API usa.
revoke all on function stock_internal.supplier_display(uuid, text), stock_internal.supplier_json(uuid, text),
  stock_internal.supplier_filter(uuid[], text), stock_internal.one_company(text, text),
  stock_internal.write_company(text, text), stock_internal.valid_code(text),
  stock_internal.valid_note(text), stock_internal.test_lead_times_on(),
  stock_internal.lead_time_json(private.stock_lead_times),
  stock_internal.supplier_change(uuid, text, text, text, text, jsonb, jsonb, text), stock_internal.stock_products(uuid),
  stock_internal.overview(text, text, text), stock_internal.suppliers(jsonb), stock_internal.supplier(text, text),
  stock_internal.product_suppliers(text, text), stock_internal.lead_time_set(text, text, text, jsonb, text),
  stock_internal.preferred_supplier_set(text, text, text, text),
  stock_internal.supplier_link_set(text, text, text, boolean, text), stock_internal.supplier_search(text, text),
  stock_internal.supplier_request_import(text)
from public, anon, authenticated;
grant execute on function stock_internal.overview(text, text, text), stock_internal.suppliers(jsonb),
  stock_internal.supplier(text, text), stock_internal.product_suppliers(text, text),
  stock_internal.lead_time_set(text, text, text, jsonb, text), stock_internal.preferred_supplier_set(text, text, text, text),
  stock_internal.supplier_link_set(text, text, text, boolean, text), stock_internal.supplier_search(text, text),
  stock_internal.supplier_request_import(text)
to authenticated;

revoke all on function public.stock_overview(text, text, text), public.stock_suppliers(jsonb),
  public.stock_supplier(text, text), public.stock_product_suppliers(text, text),
  public.stock_lead_time_set(text, text, text, jsonb, text), public.stock_preferred_supplier_set(text, text, text, text),
  public.stock_supplier_link_set(text, text, text, boolean, text), public.stock_supplier_search(text, text),
  public.stock_supplier_request_import(text)
from public, anon;
grant execute on function public.stock_overview(text, text, text), public.stock_suppliers(jsonb),
  public.stock_supplier(text, text), public.stock_product_suppliers(text, text),
  public.stock_lead_time_set(text, text, text, jsonb, text), public.stock_preferred_supplier_set(text, text, text, text),
  public.stock_supplier_link_set(text, text, text, boolean, text), public.stock_supplier_search(text, text),
  public.stock_supplier_request_import(text)
to authenticated;

revoke all on function public.stock_worker_suppliers_enqueue(uuid, text), public.stock_worker_suppliers_claim(),
  public.stock_worker_suppliers_save_page(uuid, integer, integer, integer, jsonb, integer),
  public.stock_worker_suppliers_finish(uuid), public.stock_worker_suppliers_fail(uuid, text, integer, boolean)
from public, anon, authenticated;
grant execute on function public.stock_worker_suppliers_enqueue(uuid, text), public.stock_worker_suppliers_claim(),
  public.stock_worker_suppliers_save_page(uuid, integer, integer, integer, jsonb, integer),
  public.stock_worker_suppliers_finish(uuid), public.stock_worker_suppliers_fail(uuid, text, integer, boolean)
to service_role;
notify pgrst, 'reload schema';
