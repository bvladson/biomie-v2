create or replace function public.integration_admin_assert(p_company uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.is_service_request() then return; end if;
  if not (public.is_admin(auth.uid()) and public.can_access_company(auth.uid(), p_company)) then
    raise exception 'Somente administradores podem gerenciar integrações.' using errcode = '42501';
  end if;
end $$;

create or replace function public.normalize_text(p text)
returns text language sql immutable set search_path = public as $$
  select nullif(trim(regexp_replace(lower(translate(coalesce(p,''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')), '[^a-z0-9]+', ' ', 'g')), '')
$$;

create or replace function public.document_hash(p text)
returns text language sql immutable set search_path = public, extensions as $$
  select case when length(regexp_replace(coalesce(p,''), '\D', '', 'g')) in (11,14)
    then encode(extensions.digest(regexp_replace(p, '\D', '', 'g'), 'sha256'), 'hex') end
$$;

create or replace function public.set_integration_credentials(
  p_company uuid, p_provider text, p_app_key text, p_app_secret text, p_environment text default 'production')
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform public.integration_admin_assert(p_company);
  if p_provider <> 'omie' then raise exception 'Provedor não suportado.'; end if;
  if length(coalesce(trim(p_app_key),'')) < 4 or length(coalesce(trim(p_app_secret),'')) < 4 then
    raise exception 'Credenciais inválidas.';
  end if;
  insert into private.integration_credentials (company_id, provider, app_key, app_secret, updated_by)
  values (p_company, p_provider, trim(p_app_key), trim(p_app_secret), auth.uid())
  on conflict (company_id, provider) do update set app_key = excluded.app_key, app_secret = excluded.app_secret,
    updated_at = now(), updated_by = excluded.updated_by;
  insert into public.company_integrations (company_id, provider, environment, status, app_key_hint, updated_at)
  values (p_company, p_provider, p_environment, 'CONNECTING', '••••' || right(trim(p_app_key), 4), now())
  on conflict (company_id, provider) do update set environment = excluded.environment, status = 'CONNECTING',
    app_key_hint = excluded.app_key_hint, last_test_ok = null, last_test_message = null, updated_at = now();
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (auth.uid(), 'integration.credentials_set', 'company_integrations', p_company::text,
    jsonb_build_object('provider', p_provider, 'environment', p_environment));
end $$;
revoke all on function public.set_integration_credentials(uuid,text,text,text,text) from public, anon;
grant execute on function public.set_integration_credentials(uuid,text,text,text,text) to authenticated, service_role;

create or replace function public.get_integration_credentials(p_company uuid, p_provider text)
returns table (app_key text, app_secret text) language sql stable security definer set search_path = private, public as $$
  select app_key, app_secret from private.integration_credentials where company_id = p_company and provider = p_provider
$$;
revoke all on function public.get_integration_credentials(uuid,text) from public, anon, authenticated;
grant execute on function public.get_integration_credentials(uuid,text) to service_role;

create or replace function public.ingest_omie_raw(p_entity text, p_company uuid, p_run uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_table text; r jsonb; v_created int := 0; v_updated int := 0; v_skipped int := 0; v_ids jsonb := '{}'::jsonb;
  v_id uuid; v_old text; v_hash text;
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  v_table := case p_entity when 'vendors' then 'raw_omie_vendors' when 'customers' then 'raw_omie_customers'
    when 'products' then 'raw_omie_products' else null end;
  if v_table is null then raise exception 'Entidade inválida: %', p_entity; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_hash := encode(extensions.digest((r->'payload')::text, 'sha256'), 'hex');
    execute format('select id, payload_hash from public.%I where company_id = $1 and external_id = $2', v_table)
      into v_id, v_old using p_company, r->>'external_id';
    if v_id is null then
      execute format('insert into public.%I (company_id, external_id, payload, payload_hash, source_updated_at, sync_run_id, is_active)
        values ($1,$2,$3,$4,$5,$6,$7) returning id', v_table)
        into v_id using p_company, r->>'external_id', r->'payload', v_hash, (r->>'source_updated_at')::timestamptz, p_run, (r->>'is_active')::boolean;
      v_created := v_created + 1;
    elsif v_old is distinct from v_hash then
      execute format('update public.%I set payload = $2, payload_hash = $3, source_updated_at = $4, sync_run_id = $5,
        is_active = $6, fetched_at = now() where id = $1', v_table)
        using v_id, r->'payload', v_hash, (r->>'source_updated_at')::timestamptz, p_run, (r->>'is_active')::boolean;
      v_updated := v_updated + 1;
    else
      execute format('update public.%I set fetched_at = now() where id = $1', v_table) using v_id;
      v_skipped := v_skipped + 1;
    end if;
    v_ids := v_ids || jsonb_build_object(r->>'external_id', v_id);
    v_id := null; v_old := null;
  end loop;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped, 'ids', v_ids);
end $$;
revoke all on function public.ingest_omie_raw(text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_omie_raw(text,uuid,uuid,jsonb) to service_role;

create or replace function public.finish_omie_full_sync(p_entity text, p_company uuid, p_run uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_table text; n int;
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  if p_entity not in ('vendors','customers','products') then raise exception 'Entidade inválida'; end if;
  v_table := 'canonical_' || p_entity;
  execute format('update public.%I set missing_in_source = (last_seen_run_id is distinct from $2) where company_id = $1', v_table)
    using p_company, p_run;
  execute format('select count(*) from public.%I where company_id = $1 and missing_in_source', v_table) into n using p_company;
  return n;
end $$;
revoke all on function public.finish_omie_full_sync(text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.finish_omie_full_sync(text,uuid,uuid) to service_role;

create or replace function public.compute_omie_matches(p_company uuid, p_entity text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.integration_admin_assert(p_company);
  if p_entity = 'vendors' then
    with c as (
      select cv.id, (select array_agg(s.id) from public.sellers s where s.company_id = p_company
        and public.normalize_text(s.name) = public.normalize_text(cv.name)) cand
      from public.canonical_vendors cv where cv.company_id = p_company)
    insert into public.canonical_entity_matches (company_id, entity, canonical_id, biomie_id, method, status, candidates, updated_at)
    select p_company, 'vendors', c.id,
      case when cardinality(c.cand) = 1 then c.cand[1] end,
      case when coalesce(cardinality(c.cand),0) = 0 then 'none' else 'name' end,
      case when coalesce(cardinality(c.cand),0) = 0 then 'UNMATCHED' when cardinality(c.cand) = 1 then 'MATCHED' else 'CONFLICT' end,
      coalesce(cardinality(c.cand),0), now()
    from c
    on conflict (entity, canonical_id) do update set biomie_id = excluded.biomie_id, method = excluded.method,
      status = excluded.status, candidates = excluded.candidates, updated_at = now()
    where canonical_entity_matches.status not in ('MANUAL','IGNORED');
  elsif p_entity = 'customers' then
    with c as (
      select cc.id,
        case when cc.document_hash is not null then (select array_agg(x.id) from public.customers x
          where x.company_id = p_company and public.document_hash(x.document) = cc.document_hash) end cand
      from public.canonical_customers cc where cc.company_id = p_company)
    insert into public.canonical_entity_matches (company_id, entity, canonical_id, biomie_id, method, status, candidates, updated_at)
    select p_company, 'customers', c.id,
      case when cardinality(c.cand) = 1 then c.cand[1] end,
      case when coalesce(cardinality(c.cand),0) = 0 then 'none' else 'document' end,
      case when coalesce(cardinality(c.cand),0) = 0 then 'UNMATCHED' when cardinality(c.cand) = 1 then 'MATCHED' else 'CONFLICT' end,
      coalesce(cardinality(c.cand),0), now()
    from c
    on conflict (entity, canonical_id) do update set biomie_id = excluded.biomie_id, method = excluded.method,
      status = excluded.status, candidates = excluded.candidates, updated_at = now()
    where canonical_entity_matches.status not in ('MANUAL','IGNORED');
  elsif p_entity = 'products' then
    with c as (
      select cp.id, (select array_agg(p.id) from public.products p where p.company_id = p_company
        and cp.sku is not null and lower(trim(p.sku)) = lower(trim(cp.sku))) cand
      from public.canonical_products cp where cp.company_id = p_company)
    insert into public.canonical_entity_matches (company_id, entity, canonical_id, biomie_id, method, status, candidates, updated_at)
    select p_company, 'products', c.id,
      case when cardinality(c.cand) = 1 then c.cand[1] end,
      case when coalesce(cardinality(c.cand),0) = 0 then 'none' else 'sku' end,
      case when coalesce(cardinality(c.cand),0) = 0 then 'UNMATCHED' when cardinality(c.cand) = 1 then 'MATCHED' else 'CONFLICT' end,
      coalesce(cardinality(c.cand),0), now()
    from c
    on conflict (entity, canonical_id) do update set biomie_id = excluded.biomie_id, method = excluded.method,
      status = excluded.status, candidates = excluded.candidates, updated_at = now()
    where canonical_entity_matches.status not in ('MANUAL','IGNORED');
  else
    raise exception 'Entidade inválida';
  end if;
  return (select jsonb_object_agg(status, n) from (select status, count(*) n from public.canonical_entity_matches
    where company_id = p_company and entity = p_entity group by status) s);
end $$;
revoke all on function public.compute_omie_matches(uuid,text) from public, anon;
grant execute on function public.compute_omie_matches(uuid,text) to authenticated, service_role;

create or replace function public.omie_comparison(p_company uuid, p_entity text)
returns table (match_id uuid, canonical_id uuid, external_id text, omie_name text, omie_code text, omie_active boolean,
  missing_in_source boolean, biomie_id uuid, biomie_name text, biomie_active boolean, method text, status text,
  candidates int, divergence text, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.integration_admin_assert(p_company);
  if p_entity = 'vendors' then
    return query select m.id, cv.id, cv.external_id, cv.name, cv.email, cv.is_active, cv.missing_in_source,
      s.id, s.name, s.active, m.method, m.status, m.candidates,
      nullif(concat_ws('; ', case when s.id is not null and s.active <> cv.is_active then 'status ativo diverge' end,
        case when s.id is not null and public.normalize_text(s.name) <> public.normalize_text(cv.name) then 'nome diverge' end), ''),
      m.note
    from public.canonical_vendors cv left join public.canonical_entity_matches m on m.canonical_id = cv.id and m.entity = 'vendors'
    left join public.sellers s on s.id = m.biomie_id where cv.company_id = p_company order by cv.name;
  elsif p_entity = 'customers' then
    return query select m.id, cc.id, cc.external_id, cc.name, cc.document_masked, cc.is_active, cc.missing_in_source,
      x.id, x.name, null::boolean, m.method, m.status, m.candidates,
      nullif(concat_ws('; ', case when x.id is not null and coalesce(x.state,'') <> coalesce(cc.state,'') then 'UF diverge' end,
        case when x.id is not null and public.normalize_text(x.city) is distinct from public.normalize_text(cc.city) then 'cidade diverge' end,
        case when cc.document_hash is null then 'sem CPF/CNPJ válido na origem' end), ''),
      m.note
    from public.canonical_customers cc left join public.canonical_entity_matches m on m.canonical_id = cc.id and m.entity = 'customers'
    left join public.customers x on x.id = m.biomie_id where cc.company_id = p_company order by cc.name;
  elsif p_entity = 'products' then
    return query select m.id, cp.id, cp.external_id, cp.description, cp.sku, cp.is_active, cp.missing_in_source,
      p.id, p.name, null::boolean, m.method, m.status, m.candidates,
      nullif(concat_ws('; ', case when p.id is not null and public.normalize_text(p.name) is distinct from public.normalize_text(cp.description) then 'descrição diverge' end,
        case when p.id is not null and public.normalize_text(p.category) is distinct from public.normalize_text(cp.family) then 'categoria/família diverge' end,
        case when cp.sku is null then 'sem código na origem' end), ''),
      m.note
    from public.canonical_products cp left join public.canonical_entity_matches m on m.canonical_id = cp.id and m.entity = 'products'
    left join public.products p on p.id = m.biomie_id where cp.company_id = p_company order by cp.description;
  end if;
end $$;
revoke all on function public.omie_comparison(uuid,text) from public, anon;
grant execute on function public.omie_comparison(uuid,text) to authenticated, service_role;

create or replace function public.resolve_omie_match(p_match uuid, p_biomie_id uuid, p_ignore boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare m public.canonical_entity_matches;
begin
  select * into m from public.canonical_entity_matches where id = p_match;
  if m.id is null then raise exception 'Correspondência não encontrada.'; end if;
  perform public.integration_admin_assert(m.company_id);
  if p_biomie_id is not null and not exists (
    select 1 from public.sellers where id = p_biomie_id and company_id = m.company_id and m.entity = 'vendors'
    union all select 1 from public.customers where id = p_biomie_id and company_id = m.company_id and m.entity = 'customers'
    union all select 1 from public.products where id = p_biomie_id and company_id = m.company_id and m.entity = 'products') then
    raise exception 'Registro BIOMIE inválido para esta empresa.';
  end if;
  update public.canonical_entity_matches set biomie_id = case when p_ignore then null else p_biomie_id end,
    method = 'manual', status = case when p_ignore then 'IGNORED' when p_biomie_id is null then 'UNMATCHED' else 'MANUAL' end,
    note = p_note, resolved_by = auth.uid(), resolved_at = now(), updated_at = now() where id = p_match;
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (auth.uid(), 'integration.match_resolved', 'canonical_entity_matches', p_match::text,
    jsonb_build_object('entity', m.entity, 'from', m.biomie_id, 'to', p_biomie_id, 'ignore', p_ignore, 'note', p_note));
end $$;
revoke all on function public.resolve_omie_match(uuid,uuid,boolean,text) from public, anon;
grant execute on function public.resolve_omie_match(uuid,uuid,boolean,text) to authenticated, service_role;

create or replace function public.omie_migration_status(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform public.integration_admin_assert(p_company);
  with e(entity, label, o) as (values ('vendors','Vendedores',1),('customers','Clientes',2),('products','Produtos',3),
    ('invoices','Notas fiscais',4),('orders','Pedidos',5),('financial','Financeiro',6)),
  raw as (
    select 'vendors' entity, count(*) n from public.raw_omie_vendors where company_id = p_company
    union all select 'customers', count(*) from public.raw_omie_customers where company_id = p_company
    union all select 'products', count(*) from public.raw_omie_products where company_id = p_company),
  can as (
    select 'vendors' entity, count(*) n, count(*) filter (where missing_in_source) missing from public.canonical_vendors where company_id = p_company
    union all select 'customers', count(*), count(*) filter (where missing_in_source) from public.canonical_customers where company_id = p_company
    union all select 'products', count(*), count(*) filter (where missing_in_source) from public.canonical_products where company_id = p_company),
  dup as (
    select 'customers' entity, coalesce(sum(n - 1), 0) n from (select count(*) n from public.canonical_customers
      where company_id = p_company and document_hash is not null group by document_hash having count(*) > 1) d
    union all select 'products', coalesce(sum(n - 1), 0) from (select count(*) n from public.canonical_products
      where company_id = p_company and sku is not null group by lower(trim(sku)) having count(*) > 1) d
    union all select 'vendors', coalesce(sum(n - 1), 0) from (select count(*) n from public.canonical_vendors
      where company_id = p_company group by public.normalize_text(name) having count(*) > 1) d),
  mt as (
    select entity, count(*) filter (where status in ('MATCHED','MANUAL')) matched,
      count(*) filter (where status = 'CONFLICT') conflicts, count(*) filter (where status = 'UNMATCHED') unmatched,
      count(*) filter (where status = 'IGNORED') ignored
    from public.canonical_entity_matches where company_id = p_company group by entity),
  lr as (
    select distinct on (entity) entity, id, status, started_at, finished_at, received, failed, message, duration_ms, pages_done, pages_total
    from public.integration_sync_runs where company_id = p_company order by entity, started_at desc),
  ls as (select entity, max(finished_at) ok_at from public.integration_sync_runs where company_id = p_company and status in ('SUCCESS','WARNING') group by entity)
  select jsonb_agg(jsonb_build_object(
    'entity', e.entity, 'label', e.label, 'enabled', e.o <= 3,
    'raw', coalesce(raw.n, 0), 'canonical', coalesce(can.n, 0), 'missingInSource', coalesce(can.missing, 0),
    'gold', 0, 'duplicates', coalesce(dup.n, 0),
    'matched', coalesce(mt.matched, 0), 'conflicts', coalesce(mt.conflicts, 0), 'unmatched', coalesce(mt.unmatched, 0), 'ignored', coalesce(mt.ignored, 0),
    'lastRun', case when lr.id is null then null else jsonb_build_object('id', lr.id, 'status', lr.status, 'startedAt', lr.started_at,
      'finishedAt', lr.finished_at, 'received', lr.received, 'failed', lr.failed, 'message', lr.message, 'durationMs', lr.duration_ms,
      'pagesDone', lr.pages_done, 'pagesTotal', lr.pages_total) end,
    'lastSuccessAt', ls.ok_at,
    'status', case
      when e.o > 3 then 'BLOCKED'
      when lr.status in ('RUNNING','PENDING') then 'SYNCING'
      when lr.id is null then 'NOT_STARTED'
      when lr.status = 'FAILED' and ls.ok_at is null then 'BLOCKED'
      when coalesce(mt.conflicts,0) > 0 or coalesce(mt.unmatched,0) > 0 or coalesce(dup.n,0) > 0 or (coalesce(can.n,0) > 0 and mt.entity is null) then 'RECONCILING'
      when coalesce(can.n,0) > 0 then 'READY'
      else 'RECONCILING' end) order by e.o)
  into r
  from e left join raw on raw.entity = e.entity left join can on can.entity = e.entity left join dup on dup.entity = e.entity
  left join mt on mt.entity = e.entity left join lr on lr.entity = e.entity left join ls on ls.entity = e.entity;
  return r;
end $$;
revoke all on function public.omie_migration_status(uuid) from public, anon;
grant execute on function public.omie_migration_status(uuid) to authenticated, service_role;

create or replace function public.set_company_data_source(p_company uuid, p_source text, p_confirmation text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text; v_blocked int;
begin
  perform public.integration_admin_assert(p_company);
  if p_source not in ('DEMO','OMIE_SHADOW','OMIE') then raise exception 'Fonte inválida.'; end if;
  select data_source into v_old from public.companies where id = p_company;
  if p_source = 'OMIE' then
    if not public.has_role(auth.uid(), 'SUPER_ADMIN') then
      raise exception 'Somente Super Admin pode ativar a fonte OMIE.' using errcode = '42501';
    end if;
    if p_confirmation is distinct from 'ATIVAR OMIE' then raise exception 'Confirmação inválida.'; end if;
    select count(*) into v_blocked from jsonb_array_elements(public.omie_migration_status(p_company)) x where x->>'status' <> 'READY';
    if v_blocked > 0 then
      raise exception 'Homologação incompleta: % entidade(s) ainda não estão prontas.', v_blocked;
    end if;
  end if;
  update public.companies set data_source = p_source where id = p_company;
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (auth.uid(), 'company.data_source_changed', 'companies', p_company::text,
    jsonb_build_object('from', v_old, 'to', p_source));
end $$;
revoke all on function public.set_company_data_source(uuid,text,text) from public, anon;
grant execute on function public.set_company_data_source(uuid,text,text) to authenticated, service_role;