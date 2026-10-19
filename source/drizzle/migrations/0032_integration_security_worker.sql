-- 1. Integration status means proof: CONNECTED only after an accepted Omie call.
alter table public.company_integrations drop constraint if exists company_integrations_status_check;
alter table public.company_integrations add constraint company_integrations_status_check
  check (status in ('NOT_CONFIGURED','CONNECTING','CONNECTED','ERROR','INVALID_CREDENTIALS','DISABLED'));
update public.company_integrations set status='CONNECTING', updated_at=now()
  where status='CONNECTED' and coalesce(last_test_ok,false)=false;

-- 2. Omie credentials are stored only as application-level ciphertext
--    (AES-256-GCM, key outside the database). Plaintext writes are rejected.
alter table private.integration_credentials drop constraint if exists integration_credentials_encrypted;
alter table private.integration_credentials add constraint integration_credentials_encrypted
  check (app_key like 'enc:v1:%' and app_secret like 'enc:v1:%') not valid;

drop function if exists public.set_integration_credentials(uuid,text,text,text,text);

create or replace function public.set_integration_credentials_encrypted(
  p_company uuid, p_provider text, p_app_key_enc text, p_app_secret_enc text, p_app_key_hint text,
  p_environment text default 'production')
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform public.integration_admin_assert(p_company);
  if p_provider <> 'omie' then raise exception 'Provedor não suportado.'; end if;
  if coalesce(p_app_key_enc,'') not like 'enc:v1:%' or coalesce(p_app_secret_enc,'') not like 'enc:v1:%' then
    raise exception 'Credenciais precisam ser cifradas pelo servidor.' using errcode='22023';
  end if;
  if p_app_key_hint !~ '^••••[A-Za-z0-9]{1,4}$' then raise exception 'Dica de chave inválida.'; end if;
  insert into private.integration_credentials (company_id, provider, app_key, app_secret, updated_by)
  values (p_company, p_provider, p_app_key_enc, p_app_secret_enc, auth.uid())
  on conflict (company_id, provider) do update set app_key = excluded.app_key, app_secret = excluded.app_secret,
    updated_at = now(), updated_by = excluded.updated_by;
  insert into public.company_integrations (company_id, provider, environment, status, app_key_hint, updated_at)
  values (p_company, p_provider, p_environment, 'CONNECTING', p_app_key_hint, now())
  on conflict (company_id, provider) do update set environment = excluded.environment, status = 'CONNECTING',
    app_key_hint = excluded.app_key_hint, last_test_ok = null, last_test_message = null, updated_at = now();
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (auth.uid(), 'integration.credentials_set', 'company_integrations', p_company::text,
    jsonb_build_object('provider', p_provider, 'environment', p_environment, 'encrypted', true));
end $$;
revoke all on function public.set_integration_credentials_encrypted(uuid,text,text,text,text,text) from public, anon;
grant execute on function public.set_integration_credentials_encrypted(uuid,text,text,text,text,text) to authenticated, service_role;

-- Re-encryption of rows written before 0032 (server job only, no status change).
create or replace function public.replace_integration_credentials_ciphertext(
  p_company uuid, p_provider text, p_app_key_enc text, p_app_secret_enc text)
returns boolean language plpgsql security definer set search_path = public, private as $$
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  if coalesce(p_app_key_enc,'') not like 'enc:v1:%' or coalesce(p_app_secret_enc,'') not like 'enc:v1:%' then
    raise exception 'Credenciais precisam ser cifradas pelo servidor.' using errcode='22023';
  end if;
  update private.integration_credentials set app_key=p_app_key_enc, app_secret=p_app_secret_enc, updated_at=now()
    where company_id=p_company and provider=p_provider;
  if found then
    insert into public.audit_log (actor_id, action, entity, entity_id, payload)
    values (null, 'integration.credentials_encrypted', 'company_integrations', p_company::text,
      jsonb_build_object('provider', p_provider));
  end if;
  return found;
end $$;
revoke all on function public.replace_integration_credentials_ciphertext(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.replace_integration_credentials_ciphertext(uuid,text,text,text) to service_role;

-- Integration status written only by the server after a real validation call.
create or replace function public.record_integration_test(
  p_company uuid, p_provider text, p_status text, p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  if p_status not in ('CONNECTED','ERROR','INVALID_CREDENTIALS','DISABLED') then raise exception 'Status inválido.'; end if;
  update public.company_integrations set status=p_status, last_test_at=now(), last_test_ok=p_ok,
    last_test_message=left(p_message,300),
    last_success_at=case when p_ok then now() else last_success_at end,
    last_failure_at=case when p_ok then last_failure_at else now() end, updated_at=now()
  where company_id=p_company and provider=p_provider;
  insert into public.audit_log (actor_id, action, entity, entity_id, payload)
  values (null, 'integration.tested', 'company_integrations', p_company::text,
    jsonb_build_object('provider', p_provider, 'status', p_status, 'ok', p_ok));
end $$;
revoke all on function public.record_integration_test(uuid,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.record_integration_test(uuid,text,text,boolean,text) to service_role;

-- 3. Worker control (pause/resume/recurring) and status. Stored in private settings.
create or replace function public.get_worker_control()
returns jsonb language sql stable security definer set search_path = private, public as $$
  select '{"paused":false,"recurring":false}'::jsonb
    || coalesce((select value::jsonb from private.app_settings where key='worker.control'), '{}'::jsonb)
$$;
revoke all on function public.get_worker_control() from public, anon, authenticated;
grant execute on function public.get_worker_control() to service_role;

create or replace function public.set_worker_control(p_paused boolean default null, p_recurring boolean default null,
  p_reason text default null)
returns jsonb language plpgsql security definer set search_path = private, public as $$
declare v jsonb;
begin
  if not (public.is_service_request() or public.has_role(auth.uid(),'SUPER_ADMIN')) then
    raise exception 'Somente o worker ou um SUPER_ADMIN controla a integração.' using errcode = '42501';
  end if;
  v := public.get_worker_control();
  if p_paused is not null then v := v || jsonb_build_object('paused', p_paused); end if;
  if p_recurring is not null then v := v || jsonb_build_object('recurring', p_recurring); end if;
  v := v || jsonb_build_object('reason', left(coalesce(p_reason,''),200), 'updated_at', now());
  insert into private.app_settings(key,value,updated_at) values('worker.control', v::text, now())
    on conflict(key) do update set value=excluded.value, updated_at=now();
  insert into public.audit_log(actor_id,action,entity,entity_id,payload)
    values(auth.uid(),'worker.control','worker','omie',v);
  return v;
end $$;
revoke all on function public.set_worker_control(boolean,boolean,text) from public, anon;
grant execute on function public.set_worker_control(boolean,boolean,text) to authenticated, service_role;

create or replace function public.report_worker_status(p_status jsonb)
returns void language plpgsql security definer set search_path = private, public as $$
begin
  if not public.is_service_request() then raise exception 'Somente o worker.' using errcode = '42501'; end if;
  insert into private.app_settings(key,value,updated_at)
    values('worker.status', (coalesce(p_status,'{}'::jsonb) || jsonb_build_object('heartbeat_at', now()))::text, now())
    on conflict(key) do update set value=excluded.value, updated_at=now();
end $$;
revoke all on function public.report_worker_status(jsonb) from public, anon, authenticated;
grant execute on function public.report_worker_status(jsonb) to service_role;

create or replace function public.worker_status()
returns jsonb language plpgsql stable security definer set search_path = private, public as $$
begin
  if not (public.is_service_request() or public.is_admin(auth.uid())) then
    raise exception 'Acesso restrito a administradores.' using errcode = '42501';
  end if;
  return jsonb_build_object('control', public.get_worker_control(),
    'status', coalesce((select value::jsonb from private.app_settings where key='worker.status'), '{}'::jsonb));
end $$;
revoke all on function public.worker_status() from public, anon;
grant execute on function public.worker_status() to authenticated, service_role;

-- 4. Queue accepts settlements and dimension requests; the worker executes them.
create or replace function public.manage_backfill(p_company uuid, p_action text, p_entity text default null,
  p_from date default null, p_to date default null, p_job uuid default null, p_priority int default 100)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_company uuid; v_dimension boolean;
begin
  if p_action = 'create' then
    perform public.integration_admin_assert(p_company);
    if p_entity not in ('invoices','orders','receivables','settlements','vendors','customers','products') then
      raise exception 'Entidade sem fila de sincronização.';
    end if;
    v_dimension := p_entity in ('vendors','customers','products');
    if not v_dimension and (p_from is null or p_to is null or p_to < p_from) then raise exception 'Período inválido.'; end if;
    if exists(select 1 from integration_backfill_jobs where company_id=p_company and entity=p_entity
        and status in ('PENDING','RUNNING','PAUSED')
        and (v_dimension or (period_from<=coalesce(p_to,current_date) and period_to>=coalesce(p_from,current_date)))) then
      raise exception 'Já existe uma sincronização pendente para esta entidade e período.';
    end if;
    insert into integration_backfill_jobs (company_id, entity, period_from, period_to, priority, partitions_total, current_partition, created_by)
      values (p_company, p_entity,
        case when v_dimension then current_date else p_from end,
        case when v_dimension then current_date else p_to end, p_priority,
        case when v_dimension then 1 else
          ((extract(year from p_to)*12 + extract(month from p_to)) - (extract(year from p_from)*12 + extract(month from p_from)) + 1)::int end,
        case when v_dimension then null else date_trunc('month', p_from)::date end, auth.uid())
      returning id into v_id;
  else
    select company_id into v_company from integration_backfill_jobs where id = p_job;
    if v_company is null then raise exception 'Backfill não encontrado.'; end if;
    perform public.integration_admin_assert(v_company);
    update integration_backfill_jobs set status = case p_action
        when 'pause' then case when status in ('PENDING','RUNNING') then 'PAUSED' else status end
        when 'resume' then case when status = 'PAUSED' then 'PENDING' else status end
        when 'cancel' then case when status <> 'DONE' then 'CANCELLED' else status end
        when 'retry' then case when status = 'FAILED' then 'PENDING' else status end
        else status end, updated_at = now()
      where id = p_job returning id into v_id;
  end if;
  insert into audit_log (actor_id, action, entity, entity_id, payload)
    values (auth.uid(), 'backfill.' || p_action, 'integration_backfill_jobs', v_id::text,
      jsonb_build_object('entity', p_entity, 'from', p_from, 'to', p_to));
  return v_id;
end $$;
revoke all on function public.manage_backfill(uuid,text,text,date,date,uuid,int) from public, anon;
grant execute on function public.manage_backfill(uuid,text,text,date,date,uuid,int) to authenticated, service_role;

-- 5. Pending classifications are divergences, never silent exclusions.
create or replace function public.run_integrity_checks(p_company uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.is_service_request() or public.is_admin(auth.uid())) then raise exception 'Acesso negado' using errcode = '42501'; end if;
  if not public.is_service_request() then perform public.integration_admin_assert(p_company); end if;
  create temp table _iss (entity text, external_id text, check_key text, severity text, reason text) on commit drop;
  insert into _iss
    select 'invoices', ci.external_id, 'invoice_without_customer', 'HIGH', 'Nota sem cliente correspondente'
      from canonical_invoices ci where ci.company_id = p_company and not exists
        (select 1 from canonical_customers c where c.company_id = ci.company_id and c.external_id = ci.customer_external_id)
    union all
    select 'invoices', ci.external_id, 'invoice_without_seller', 'MEDIUM', 'Nota sem vendedor correspondente'
      from canonical_invoices ci where ci.company_id = p_company and ci.seller_external_id is not null and not exists
        (select 1 from canonical_vendors v where v.company_id = ci.company_id and v.external_id = ci.seller_external_id)
    union all
    select 'invoices', ci.external_id, 'invoice_without_items', 'HIGH', 'Nota sem itens'
      from canonical_invoices ci where ci.company_id = p_company and not exists
        (select 1 from canonical_invoice_items it where it.company_id = ci.company_id and it.invoice_external_id = ci.external_id)
    union all
    select 'invoices', ci.external_id, 'invoice_items_sum', 'HIGH', 'Soma dos itens difere do valor de mercadorias'
      from canonical_invoices ci join (select invoice_external_id, sum(total) s from canonical_invoice_items where company_id = p_company group by 1) x
        on x.invoice_external_id = ci.external_id where ci.company_id = p_company and abs(x.s - ci.goods_amount) > 0.01
    union all
    select 'invoices', ci.external_id, 'invoice_operation_pending', 'HIGH',
        'Nota com operação pendente: CFOP ausente, desconhecido ou misto; fica fora do faturamento até a decisão'
      from canonical_invoices ci where ci.company_id = p_company and not ci.missing_in_source
        and ci.status = 'authorized' and ci.operation_scope in ('unconfirmed','unknown')
    union all
    select 'invoices', ci.external_id, 'invoice_negative_base', 'HIGH', 'Base comercial negativa'
      from canonical_invoices ci where ci.company_id = p_company and coalesce(ci.commercial_base_amount,0) < 0
    union all
    select 'invoice_items', it.invoice_external_id || '#' || it.item_sequence, 'item_without_product', 'MEDIUM', 'Item sem produto correspondente'
      from canonical_invoice_items it where it.company_id = p_company and not exists
        (select 1 from canonical_products p where p.company_id = it.company_id and p.external_id = it.product_external_id)
    union all
    select 'orders', co.external_id, 'order_without_items', 'MEDIUM', 'Pedido sem itens'
      from canonical_orders co where co.company_id = p_company and not exists
        (select 1 from canonical_order_items it where it.company_id = co.company_id and it.order_external_id = co.external_id)
    union all
    select 'orders', co.external_id, 'order_operation_pending', 'HIGH',
        'Pedido com operação pendente: sem CFOP reconhecido nos itens; preservado, fora da carteira até a decisão'
      from canonical_orders co where co.company_id = p_company and not co.missing_in_source
        and co.status not in ('cancelled') and co.operation_scope in ('unconfirmed','unknown')
    union all
    select 'settlements', st.external_id, 'settlement_without_title', 'HIGH', 'Liquidação sem título'
      from canonical_settlements st where st.company_id = p_company and not exists
        (select 1 from canonical_receivables r where r.company_id = st.company_id and r.external_id = st.receivable_external_id)
    union all
    select 'receivables', r.external_id, 'overpaid_title', 'HIGH', 'Recebido maior que o valor do título'
      from canonical_receivables r join (select receivable_external_id, sum(amount) s from canonical_settlements where company_id = p_company group by 1) x
        on x.receivable_external_id = r.external_id where r.company_id = p_company
        and x.s > r.original_amount + r.interest + r.fine - r.discount + 0.01;
  insert into integrity_issues (company_id, entity, external_id, check_key, severity, reason)
    select p_company, entity, external_id, check_key, severity, reason from _iss
  on conflict (company_id, entity, check_key, coalesce(external_id,'')) do update
    set last_seen_at = now(), occurrences = integrity_issues.occurrences + 1,
        status = case when integrity_issues.status = 'RESOLVED' then 'OPEN' else integrity_issues.status end;
  get diagnostics n = row_count;
  update integrity_issues i set status = 'RESOLVED', resolved_at = now(), justification = coalesce(justification, 'Não ocorre mais na última verificação.')
    where i.company_id = p_company and i.status in ('OPEN','ACKNOWLEDGED')
      and not exists (select 1 from _iss x where x.entity = i.entity and x.check_key = i.check_key and coalesce(x.external_id,'') = coalesce(i.external_id,''));
  return n;
end $$;
revoke all on function public.run_integrity_checks(uuid) from public, anon;
grant execute on function public.run_integrity_checks(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
