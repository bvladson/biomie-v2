-- Assistente MAG AI no BIOMIE (Fase 4, 10/11/2026). O BIOMIE calcula os indicadores e as conclusões com
-- a sessão do usuário (RLS); a IA local (MAG AI) só redige. Este arquivo segue o plano aprovado
-- (mag-ai/docs/fase2-plano.md §6):
--   - chave `ai_assistant` no metric_config, DESLIGADA por padrão, começando só com SUPER_ADMIN;
--   - registro de pedidos SÓ COM METADADOS (nunca o texto da pergunta nem da resposta) em
--     private.ai_requests, retenção de 90 dias;
--   - a IA nunca acessa o banco; o modelo não escolhe a intenção (regras no servidor).
-- Só acréscimos: a release anterior ignora tudo daqui (volta = ativar a release anterior).

-- ============ 1. Chave de liberação (desligada; perfis começam em SUPER_ADMIN) ============
insert into public.metric_config (metric_key, config)
  values ('ai_assistant', '{"enabled": false, "roles": ["SUPER_ADMIN"]}'::jsonb)
  on conflict (metric_key) do nothing;

create or replace function public.ai_assistant_config()
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(
    (select config from public.metric_config where metric_key = 'ai_assistant'),
    '{"enabled": false, "roles": ["SUPER_ADMIN"]}'::jsonb)
$$;

create or replace function public.ai_assistant_enabled_for_me()
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((c.cfg->>'enabled')::boolean, false)
     and exists (
       select 1 from public.user_roles r
       where r.user_id = auth.uid()
         and r.role::text in (
           select jsonb_array_elements_text(coalesce(c.cfg->'roles', '["SUPER_ADMIN"]'::jsonb))))
  from (select public.ai_assistant_config() as cfg) c
$$;

-- O balão só aparece quando 'ai_assistant' está nas features do usuário (ctx.features).
create or replace function public.my_features() returns text[]
language sql stable as $$
  select stock_internal.features()
      || case when public.ai_assistant_enabled_for_me()
              then array['ai_assistant'] else array[]::text[] end
$$;

-- Liga/desliga e escolhe os perfis liberados. Só administradores; tudo vai para o audit_log.
create or replace function public.ai_assistant_set(p_enabled boolean, p_roles text[])
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_roles text[] := coalesce(p_roles, array['SUPER_ADMIN']);
  v_cfg jsonb;
begin
  if v_actor is null or not public.is_admin(v_actor) then
    raise exception 'ai::Só administradores alteram o assistente.';
  end if;
  if coalesce(array_length(v_roles, 1), 0) = 0 then
    v_roles := array['SUPER_ADMIN'];
  end if;
  if exists (
    select 1 from unnest(v_roles) r
    where r not in ('SUPER_ADMIN','ADMIN','DIRETORIA','GESTOR','VENDEDOR','FINANCEIRO','ANALISTA','VIEWER')) then
    raise exception 'ai::Papel desconhecido na liberação do assistente.';
  end if;
  v_cfg := jsonb_build_object('enabled', coalesce(p_enabled, false), 'roles', to_jsonb(v_roles));
  insert into public.metric_config (metric_key, config) values ('ai_assistant', v_cfg)
    on conflict (metric_key) do update
      set config = excluded.config, version = metric_config.version + 1, updated_at = now();
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
    values (v_actor, 'ai_assistant_set', 'metric_config', 'ai_assistant', v_cfg);
  return v_cfg;
end $$;

-- ============ 2. Registro de pedidos (só metadados; nunca o texto) ============
create table if not exists private.ai_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  intent text not null,
  status text not null,
  model text not null default '',
  queue_ms integer not null default 0,
  total_ms integer not null default 0,
  prompt_tokens integer not null default 0,
  output_tokens integer not null default 0,
  flagged_count integer not null default 0,
  useful boolean,
  created_at timestamptz not null default now(),
  constraint ai_requests_intent_len check (char_length(intent) between 1 and 40),
  constraint ai_requests_status_check
    check (status in ('ok','descartada','fora_catalogo','erro','indisponivel','ocupado','limite'))
);
create index if not exists ai_requests_company_created on private.ai_requests (company_id, created_at desc);
create index if not exists ai_requests_user_created on private.ai_requests (user_id, created_at desc);
create index if not exists ai_requests_created on private.ai_requests (created_at);

create or replace function public.ai_request_log(
  p_company uuid, p_intent text, p_status text, p_model text,
  p_queue_ms integer, p_total_ms integer, p_prompt_tokens integer, p_output_tokens integer,
  p_flagged integer)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'ai::Sessão necessária.'; end if;
  if not public.ai_assistant_enabled_for_me() then raise exception 'ai::Assistente desligado.'; end if;
  if not public.can_access_company(v_user, p_company) then raise exception 'ai::Sem acesso a esta empresa.'; end if;
  insert into private.ai_requests
      (user_id, company_id, intent, status, model, queue_ms, total_ms, prompt_tokens, output_tokens, flagged_count)
    values (v_user, p_company, p_intent, p_status, left(coalesce(p_model, ''), 60),
      greatest(0, least(coalesce(p_queue_ms, 0), 600000)),
      greatest(0, least(coalesce(p_total_ms, 0), 600000)),
      greatest(0, least(coalesce(p_prompt_tokens, 0), 100000)),
      greatest(0, least(coalesce(p_output_tokens, 0), 100000)),
      greatest(0, least(coalesce(p_flagged, 0), 100)))
    returning id into v_id;
  return v_id;
end $$;

-- Avaliação útil/não útil do próprio pedido (até 7 dias; null limpa a avaliação).
create or replace function public.ai_request_rate(p_id uuid, p_useful boolean)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_n integer;
begin
  if v_user is null then raise exception 'ai::Sessão necessária.'; end if;
  update private.ai_requests set useful = p_useful
    where id = p_id and user_id = v_user and created_at > now() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- Resumo para administradores (piloto): volumes, erros, tempos e avaliações. Sem texto: não existe texto.
create or replace function public.ai_requests_summary(p_company uuid default null, p_days integer default 7)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_days integer := greatest(1, least(coalesce(p_days, 7), 90));
begin
  if v_user is null or not public.is_admin(v_user) then
    raise exception 'ai::Só administradores.';
  end if;
  if p_company is not null and not public.can_access_company(v_user, p_company) then
    raise exception 'ai::Sem acesso a esta empresa.';
  end if;
  return (
    with q as (
      select * from private.ai_requests
      where created_at > now() - make_interval(days => v_days)
        and (p_company is null or company_id = p_company))
    select jsonb_build_object(
      'days', v_days,
      'total', (select count(*) from q),
      'ok', (select count(*) from q where status = 'ok'),
      'descartadas', (select count(*) from q where status = 'descartada'),
      'foraCatalogo', (select count(*) from q where status = 'fora_catalogo'),
      'falhas', (select count(*) from q where status in ('erro','indisponivel','ocupado','limite')),
      'uteis', (select count(*) from q where useful is true),
      'naoUteis', (select count(*) from q where useful is false),
      'tempoMedioMs', (select coalesce(avg(total_ms)::integer, 0) from q where status = 'ok'),
      'porIntencao', (select coalesce(jsonb_object_agg(i.intent, i.n), '{}'::jsonb)
                        from (select intent, count(*) as n from q group by intent) i)));
end $$;

-- ============ 3. Retenção de 90 dias (mesmo padrão da 0003) ============
select cron.unschedule(jobid) from cron.job where jobname = 'biomie-ai-requests-retencao';
select cron.schedule('biomie-ai-requests-retencao', '41 6 * * *', $cmd$
  delete from private.ai_requests where created_at < now() - interval '90 days'
$cmd$);

-- ============ 4. Permissões ============
revoke all on function public.ai_assistant_config(), public.ai_assistant_enabled_for_me(),
  public.ai_assistant_set(boolean, text[]),
  public.ai_request_log(uuid, text, text, text, integer, integer, integer, integer, integer),
  public.ai_request_rate(uuid, boolean), public.ai_requests_summary(uuid, integer)
  from public, anon;
grant execute on function public.ai_assistant_config(), public.ai_assistant_enabled_for_me(),
  public.ai_assistant_set(boolean, text[]),
  public.ai_request_log(uuid, text, text, text, integer, integer, integer, integer, integer),
  public.ai_request_rate(uuid, boolean), public.ai_requests_summary(uuid, integer)
  to authenticated, service_role;
