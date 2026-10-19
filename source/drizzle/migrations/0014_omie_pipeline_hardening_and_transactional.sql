-- P0 security: anonymous callers never execute privileged functions.
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
revoke execute on function public.audit_user_roles() from authenticated;

-- A2: sync runs gain temporal coverage, proof of completeness and a per company+entity lock.
alter table public.integration_sync_runs
  add column if not exists period_from date,
  add column if not exists period_to date,
  add column if not exists expected_records integer,
  add column if not exists raw_complete boolean not null default false,
  add column if not exists canonical_complete boolean not null default false,
  add column if not exists gold_complete boolean not null default false,
  add column if not exists backfill_job_id uuid;
create unique index if not exists integration_sync_runs_one_running
  on public.integration_sync_runs (company_id, entity) where status = 'RUNNING';

-- A3: RAW is reprocessable: method, page, period and processing state on every RAW row.
do $$ declare t text; begin
  foreach t in array array['raw_omie_vendors','raw_omie_customers','raw_omie_products'] loop
    execute format('alter table public.%I add column if not exists provider text not null default ''omie'',
      add column if not exists method text, add column if not exists page integer,
      add column if not exists requested_period jsonb,
      add column if not exists processing_state text not null default ''PENDING'',
      add column if not exists processing_error text', t);
  end loop;
end $$;

-- B: RAW for transactional entities (service_role only, no grants to app roles).
do $$ declare t text; begin
  foreach t in array array['raw_omie_invoices','raw_omie_orders','raw_omie_receivables','raw_omie_settlements'] loop
    execute format($f$
      create table if not exists public.%1$I (
        id uuid primary key default gen_random_uuid(),
        company_id uuid not null references public.companies(id),
        provider text not null default 'omie',
        external_id text not null,
        method text, page integer, requested_period jsonb,
        payload jsonb not null, payload_hash text not null,
        source_updated_at timestamptz,
        fetched_at timestamptz not null default now(),
        first_fetched_at timestamptz not null default now(),
        sync_run_id uuid references public.integration_sync_runs(id),
        is_active boolean,
        processing_state text not null default 'PENDING',
        processing_error text,
        unique (company_id, provider, external_id)
      )$f$, t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- B: Canonical transactional models. Identity = company + source + external id (+ item sequence).
create table if not exists public.canonical_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source text not null default 'omie', external_id text not null,
  raw_record_id uuid, sync_run_id uuid, last_seen_run_id uuid,
  number text not null, series text, status text not null,
  issue_date date, competence_date date not null,
  customer_external_id text, seller_external_id text, order_external_id text,
  gross_amount numeric not null default 0, goods_amount numeric not null default 0,
  freight_amount numeric not null default 0, insurance_amount numeric not null default 0,
  other_expenses_amount numeric not null default 0, discount_amount numeric not null default 0,
  missing_in_source boolean not null default false,
  source_updated_at timestamptz, canonicalized_at timestamptz not null default now(),
  unique (company_id, source, external_id)
);
create table if not exists public.canonical_invoice_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source text not null default 'omie',
  invoice_external_id text not null, item_sequence integer not null,
  product_external_id text, description text,
  quantity numeric not null default 0, unit_price numeric not null default 0, total numeric not null default 0,
  sync_run_id uuid, canonicalized_at timestamptz not null default now(),
  unique (company_id, source, invoice_external_id, item_sequence)
);
create table if not exists public.canonical_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source text not null default 'omie', external_id text not null,
  raw_record_id uuid, sync_run_id uuid, last_seen_run_id uuid,
  number text not null, status text not null, order_date date not null, expected_date date,
  customer_external_id text, seller_external_id text,
  total numeric not null default 0,
  missing_in_source boolean not null default false,
  source_updated_at timestamptz, canonicalized_at timestamptz not null default now(),
  unique (company_id, source, external_id)
);
create table if not exists public.canonical_order_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source text not null default 'omie',
  order_external_id text not null, item_sequence integer not null,
  product_external_id text, description text,
  quantity numeric not null default 0, unit_price numeric not null default 0, total numeric not null default 0,
  sync_run_id uuid, canonicalized_at timestamptz not null default now(),
  unique (company_id, source, order_external_id, item_sequence)
);
create table if not exists public.canonical_receivables (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source text not null default 'omie', external_id text not null,
  raw_record_id uuid, sync_run_id uuid, last_seen_run_id uuid,
  document_number text not null, installment integer not null default 1, installments integer not null default 1,
  customer_external_id text, seller_external_id text, invoice_external_id text,
  issue_date date, competence_date date, due_date date not null, expected_date date,
  original_amount numeric not null default 0, interest numeric not null default 0,
  fine numeric not null default 0, discount numeric not null default 0,
  source_status text, cancelled_at date, category_code text, account_external_id text,
  missing_in_source boolean not null default false,
  source_updated_at timestamptz, canonicalized_at timestamptz not null default now(),
  unique (company_id, source, external_id)
);
create table if not exists public.canonical_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source text not null default 'omie', external_id text not null,
  receivable_external_id text not null,
  settlement_date date not null, amount numeric not null,
  account_external_id text, sync_run_id uuid, canonicalized_at timestamptz not null default now(),
  unique (company_id, source, external_id)
);
do $$ declare t text; begin
  foreach t in array array['canonical_invoices','canonical_invoice_items','canonical_orders','canonical_order_items','canonical_receivables','canonical_settlements'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "admins read %1$s" on public.%1$I for select to authenticated using (public.is_admin(auth.uid()) and (select public.accessible_company_ids(auth.uid())) @> array[company_id])', t);
  end loop;
end $$;

-- Gold identity: external keys on analytic tables, unique per company+source.
alter table public.sellers add column if not exists source text not null default 'demo', add column if not exists external_id text;
alter table public.customers add column if not exists source text not null default 'demo', add column if not exists external_id text;
alter table public.products add column if not exists source text not null default 'demo', add column if not exists external_id text;
alter table public.invoices add column if not exists external_id text,
  add column if not exists gross_amount numeric, add column if not exists goods_amount numeric,
  add column if not exists freight_amount numeric, add column if not exists insurance_amount numeric,
  add column if not exists other_expenses_amount numeric, add column if not exists discount_amount numeric;
alter table public.invoice_items add column if not exists item_sequence integer;
alter table public.sales_orders add column if not exists external_id text;
alter table public.sales_order_items add column if not exists item_sequence integer;
create unique index if not exists sellers_ext_uq on public.sellers (company_id, source, external_id) where external_id is not null;
create unique index if not exists customers_ext_uq on public.customers (company_id, source, external_id) where external_id is not null;
create unique index if not exists products_ext_uq on public.products (company_id, source, external_id) where external_id is not null;
create unique index if not exists invoices_ext_uq on public.invoices (company_id, source, external_id) where external_id is not null;
create unique index if not exists invoice_items_seq_uq on public.invoice_items (invoice_id, item_sequence) where item_sequence is not null;
create unique index if not exists orders_ext_uq on public.sales_orders (company_id, source, external_id) where external_id is not null;
create unique index if not exists order_items_seq_uq on public.sales_order_items (order_id, item_sequence) where item_sequence is not null;
create unique index if not exists fin_titles_ext_uq on public.financial_titles (company_id, source, external_id) where external_id is not null;
create unique index if not exists fin_settle_ext_uq on public.financial_settlements (company_id, source, external_id) where external_id is not null;

-- C: backfill jobs with from/to; month is only the partition strategy.
create table if not exists public.integration_backfill_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  provider text not null default 'omie',
  entity text not null,
  period_from date not null, period_to date not null,
  partition_strategy text not null default 'month',
  priority integer not null default 100,
  status text not null default 'PENDING',
  partitions_total integer not null default 0,
  partitions_done integer not null default 0,
  current_partition date,
  last_error text,
  attempts integer not null default 0,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint backfill_period_ok check (period_to >= period_from),
  constraint backfill_status_ok check (status in ('PENDING','RUNNING','PAUSED','CANCELLED','FAILED','DONE'))
);
grant select on public.integration_backfill_jobs to authenticated;
grant all on public.integration_backfill_jobs to service_role;
alter table public.integration_backfill_jobs enable row level security;
create policy "admins read backfill" on public.integration_backfill_jobs for select to authenticated
  using (public.is_admin(auth.uid()) and (select public.accessible_company_ids(auth.uid())) @> array[company_id]);

-- D: integrity issues (divergences are recorded, never auto-adjusted).
create table if not exists public.integrity_issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  entity text not null, external_id text, check_key text not null,
  severity text not null default 'MEDIUM',
  reason text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1,
  status text not null default 'OPEN',
  justification text, resolved_by uuid, resolved_at timestamptz,
  constraint integrity_sev_ok check (severity in ('LOW','MEDIUM','HIGH','CRITICAL')),
  constraint integrity_status_ok check (status in ('OPEN','ACKNOWLEDGED','RESOLVED','IGNORED'))
);
create unique index if not exists integrity_issues_uq on public.integrity_issues (company_id, entity, check_key, coalesce(external_id,''));
grant select on public.integrity_issues to authenticated;
grant all on public.integrity_issues to service_role;
alter table public.integrity_issues enable row level security;
create policy "quality readers" on public.integrity_issues for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id]
    and (public.is_admin(auth.uid()) or public.has_role(auth.uid(),'ANALISTA') or public.has_role(auth.uid(),'DIRETORIA')));

-- Generic RAW ingestion for all entities, with metadata.
create or replace function public.omie_raw_table(p_entity text) returns text language sql immutable set search_path = public as $$
  select case p_entity when 'vendors' then 'raw_omie_vendors' when 'customers' then 'raw_omie_customers'
    when 'products' then 'raw_omie_products' when 'invoices' then 'raw_omie_invoices' when 'orders' then 'raw_omie_orders'
    when 'receivables' then 'raw_omie_receivables' when 'settlements' then 'raw_omie_settlements' end $$;

create or replace function public.ingest_omie_raw(p_entity text, p_company uuid, p_run uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_table text; r jsonb; v_created int := 0; v_updated int := 0; v_skipped int := 0; v_ids jsonb := '{}'::jsonb;
  v_id uuid; v_old text; v_hash text;
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  v_table := public.omie_raw_table(p_entity);
  if v_table is null then raise exception 'Entidade inválida: %', p_entity; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'external_id','') = '' then raise exception 'Registro sem identificador externo.'; end if;
    v_hash := encode(extensions.digest((r->'payload')::text, 'sha256'), 'hex');
    execute format('select id, payload_hash from public.%I where company_id = $1 and external_id = $2 for update', v_table)
      into v_id, v_old using p_company, r->>'external_id';
    if v_id is null then
      execute format('insert into public.%I (company_id, external_id, payload, payload_hash, source_updated_at, sync_run_id, is_active, method, page, requested_period)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id', v_table)
        into v_id using p_company, r->>'external_id', r->'payload', v_hash, (r->>'source_updated_at')::timestamptz, p_run,
          (r->>'is_active')::boolean, r->>'method', (r->>'page')::int, r->'requested_period';
      v_created := v_created + 1;
    elsif v_old is distinct from v_hash then
      execute format('update public.%I set payload = $2, payload_hash = $3, source_updated_at = $4, sync_run_id = $5,
        is_active = $6, fetched_at = now(), method = $7, page = $8, requested_period = $9, processing_state = ''PENDING'', processing_error = null where id = $1', v_table)
        using v_id, r->'payload', v_hash, (r->>'source_updated_at')::timestamptz, p_run, (r->>'is_active')::boolean,
          r->>'method', (r->>'page')::int, r->'requested_period';
      v_updated := v_updated + 1;
    else
      execute format('update public.%I set fetched_at = now(), sync_run_id = $2 where id = $1', v_table) using v_id, p_run;
      v_skipped := v_skipped + 1;
    end if;
    v_ids := v_ids || jsonb_build_object(r->>'external_id', v_id);
    v_id := null; v_old := null;
  end loop;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped, 'ids', v_ids);
end $$;
revoke all on function public.ingest_omie_raw(text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_omie_raw(text,uuid,uuid,jsonb) to service_role;

create or replace function public.mark_raw_processed(p_entity text, p_company uuid, p_ids uuid[], p_state text, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  if p_state not in ('PENDING','CANONICAL','GOLD','ERROR') then raise exception 'Estado inválido'; end if;
  execute format('update public.%I set processing_state = $3, processing_error = $4 where company_id = $1 and id = any($2)', public.omie_raw_table(p_entity))
    using p_company, p_ids, p_state, p_error;
end $$;
revoke all on function public.mark_raw_processed(text,uuid,uuid[],text,text) from public, anon, authenticated;
grant execute on function public.mark_raw_processed(text,uuid,uuid[],text,text) to service_role;

-- Missing-in-source marking for every entity with a header table.
create or replace function public.finish_omie_full_sync(p_entity text, p_company uuid, p_run uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  if p_entity not in ('vendors','customers','products','invoices','orders','receivables') then raise exception 'Entidade inválida'; end if;
  execute format('update public.%I set missing_in_source = (last_seen_run_id is distinct from $2) where company_id = $1', 'canonical_' || p_entity)
    using p_company, p_run;
  execute format('select count(*) from public.%I where company_id = $1 and missing_in_source', 'canonical_' || p_entity) into n using p_company;
  return n;
end $$;

-- Gold promotion (Canonical -> analytic tables). Never touches DEMO companies.
create or replace function public.promote_omie_gold(p_company uuid, p_entity text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_src text; n int := 0; v_unknown uuid;
begin
  if not public.is_service_request() then raise exception 'Somente jobs do servidor.' using errcode = '42501'; end if;
  select data_source into v_src from companies where id = p_company and not is_demo;
  if v_src is null or v_src = 'DEMO' then raise exception 'Promoção Gold exige empresa real em OMIE_SHADOW ou OMIE.'; end if;

  if p_entity = 'vendors' then
    insert into sellers (company_id, name, active, source, external_id)
      select company_id, name, is_active and not missing_in_source, 'omie', external_id from canonical_vendors where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, active = excluded.active;
    get diagnostics n = row_count;
  elsif p_entity = 'customers' then
    insert into customers (company_id, name, state, city, created_at, source, external_id)
      select company_id, name, coalesce(state,'—'), coalesce(city,'—'), canonicalized_at::date, 'omie', external_id
      from canonical_customers where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, state = excluded.state, city = excluded.city;
    get diagnostics n = row_count;
  elsif p_entity = 'products' then
    insert into products (company_id, name, category, base_price, sku, source, external_id)
      select company_id, description, coalesce(family,'Sem categoria'), 0, sku, 'omie', external_id
      from canonical_products where company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null
      do update set name = excluded.name, category = excluded.category, sku = excluded.sku;
    get diagnostics n = row_count;
  elsif p_entity in ('invoices','orders') then
    -- Facts without a known customer are kept under an explicit "Sem cliente" dimension, never dropped.
    insert into customers (company_id, name, state, city, created_at, source, external_id)
      values (p_company, 'Sem cliente identificado', '—', '—', current_date, 'omie', '__unknown__')
    on conflict (company_id, source, external_id) where external_id is not null do nothing;
    select id into v_unknown from customers where company_id = p_company and source = 'omie' and external_id = '__unknown__';
    insert into products (company_id, name, category, base_price, source, external_id)
      values (p_company, 'Produto não identificado', 'Sem categoria', 0, 'omie', '__unknown__')
    on conflict (company_id, source, external_id) where external_id is not null do nothing;

    if p_entity = 'invoices' then
      insert into invoices (company_id, seller_id, customer_id, number, status, competence_date, total, source, external_id,
        gross_amount, goods_amount, freight_amount, insurance_amount, other_expenses_amount, discount_amount)
      select ci.company_id, s.id, coalesce(c.id, v_unknown), ci.number,
        case ci.status when 'cancelled' then 'cancelled'::invoice_status when 'denied' then 'denied'::invoice_status else 'authorized'::invoice_status end,
        ci.competence_date, ci.gross_amount, 'omie', ci.external_id,
        ci.gross_amount, ci.goods_amount, ci.freight_amount, ci.insurance_amount, ci.other_expenses_amount, ci.discount_amount
      from canonical_invoices ci
      left join sellers s on s.company_id = ci.company_id and s.source = 'omie' and s.external_id = ci.seller_external_id
      left join customers c on c.company_id = ci.company_id and c.source = 'omie' and c.external_id = ci.customer_external_id
      where ci.company_id = p_company
      on conflict (company_id, source, external_id) where external_id is not null do update set
        seller_id = excluded.seller_id, customer_id = excluded.customer_id, number = excluded.number, status = excluded.status,
        competence_date = excluded.competence_date, total = excluded.total, gross_amount = excluded.gross_amount,
        goods_amount = excluded.goods_amount, freight_amount = excluded.freight_amount, insurance_amount = excluded.insurance_amount,
        other_expenses_amount = excluded.other_expenses_amount, discount_amount = excluded.discount_amount;
      get diagnostics n = row_count;
      insert into invoice_items (invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence)
      select i.id, i.company_id, i.seller_id, coalesce(p.id, (select id from products where company_id = p_company and source='omie' and external_id='__unknown__')),
        it.quantity, it.total, it.item_sequence
      from canonical_invoice_items it
      join invoices i on i.company_id = it.company_id and i.source = 'omie' and i.external_id = it.invoice_external_id
      left join products p on p.company_id = it.company_id and p.source = 'omie' and p.external_id = it.product_external_id
      where it.company_id = p_company
      on conflict (invoice_id, item_sequence) where item_sequence is not null do update set
        product_id = excluded.product_id, quantity = excluded.quantity, total = excluded.total, seller_id = excluded.seller_id;
    else
      insert into sales_orders (company_id, seller_id, customer_id, number, status, order_date, expected_date, total, source, external_id)
      select co.company_id, s.id, coalesce(c.id, v_unknown), co.number,
        case co.status when 'cancelled' then 'cancelled'::order_status when 'invoiced' then 'invoiced'::order_status else 'open'::order_status end,
        co.order_date, co.expected_date, co.total, 'omie', co.external_id
      from canonical_orders co
      left join sellers s on s.company_id = co.company_id and s.source = 'omie' and s.external_id = co.seller_external_id
      left join customers c on c.company_id = co.company_id and c.source = 'omie' and c.external_id = co.customer_external_id
      where co.company_id = p_company
      on conflict (company_id, source, external_id) where external_id is not null do update set
        seller_id = excluded.seller_id, customer_id = excluded.customer_id, status = excluded.status,
        order_date = excluded.order_date, expected_date = excluded.expected_date, total = excluded.total;
      get diagnostics n = row_count;
      insert into sales_order_items (order_id, company_id, seller_id, product_id, quantity, total, item_sequence)
      select o.id, o.company_id, o.seller_id, coalesce(p.id, (select id from products where company_id = p_company and source='omie' and external_id='__unknown__')),
        it.quantity, it.total, it.item_sequence
      from canonical_order_items it
      join sales_orders o on o.company_id = it.company_id and o.source = 'omie' and o.external_id = it.order_external_id
      left join products p on p.company_id = it.company_id and p.source = 'omie' and p.external_id = it.product_external_id
      where it.company_id = p_company
      on conflict (order_id, item_sequence) where item_sequence is not null do update set
        product_id = excluded.product_id, quantity = excluded.quantity, total = excluded.total, seller_id = excluded.seller_id;
    end if;
  elsif p_entity = 'receivables' then
    insert into financial_titles (company_id, customer_id, invoice_id, seller_id, document_number, installment, installments,
      issue_date, competence_date, due_date, expected_date, original_amount, interest, fine, discount, cancelled_at, source_status, source, external_id)
    select r.company_id, c.id, i.id, s.id, r.document_number, r.installment, r.installments,
      coalesce(r.issue_date, r.due_date), coalesce(r.competence_date, r.issue_date, r.due_date), r.due_date, r.expected_date,
      r.original_amount, r.interest, r.fine, r.discount, r.cancelled_at, r.source_status, 'omie', r.external_id
    from canonical_receivables r
    left join customers c on c.company_id = r.company_id and c.source = 'omie' and c.external_id = r.customer_external_id
    left join sellers s on s.company_id = r.company_id and s.source = 'omie' and s.external_id = r.seller_external_id
    left join invoices i on i.company_id = r.company_id and i.source = 'omie' and i.external_id = r.invoice_external_id
    where r.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      customer_id = excluded.customer_id, invoice_id = excluded.invoice_id, seller_id = excluded.seller_id,
      due_date = excluded.due_date, expected_date = excluded.expected_date, original_amount = excluded.original_amount,
      interest = excluded.interest, fine = excluded.fine, discount = excluded.discount,
      cancelled_at = excluded.cancelled_at, source_status = excluded.source_status;
    get diagnostics n = row_count;
    insert into financial_settlements (title_id, company_id, settlement_date, amount, source, external_id)
    select t.id, st.company_id, st.settlement_date, st.amount, 'omie', st.external_id
    from canonical_settlements st
    join financial_titles t on t.company_id = st.company_id and t.source = 'omie' and t.external_id = st.receivable_external_id
    where st.company_id = p_company
    on conflict (company_id, source, external_id) where external_id is not null do update set
      settlement_date = excluded.settlement_date, amount = excluded.amount, title_id = excluded.title_id;
  else
    raise exception 'Entidade inválida: %', p_entity;
  end if;
  return jsonb_build_object('entity', p_entity, 'rows', n);
end $$;
revoke all on function public.promote_omie_gold(uuid,text) from public, anon, authenticated;
grant execute on function public.promote_omie_gold(uuid,text) to service_role;

-- D: integrity checks (record divergences, never adjust).
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
    select 'invoice_items', it.invoice_external_id || '#' || it.item_sequence, 'item_without_product', 'MEDIUM', 'Item sem produto correspondente'
      from canonical_invoice_items it where it.company_id = p_company and not exists
        (select 1 from canonical_products p where p.company_id = it.company_id and p.external_id = it.product_external_id)
    union all
    select 'orders', co.external_id, 'order_without_items', 'MEDIUM', 'Pedido sem itens'
      from canonical_orders co where co.company_id = p_company and not exists
        (select 1 from canonical_order_items it where it.company_id = co.company_id and it.order_external_id = co.external_id)
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

create or replace function public.resolve_integrity_issue(p_issue uuid, p_status text, p_justification text)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from integrity_issues where id = p_issue;
  if v_company is null then raise exception 'Divergência não encontrada.'; end if;
  perform public.integration_admin_assert(v_company);
  if p_status not in ('ACKNOWLEDGED','RESOLVED','IGNORED') then raise exception 'Status inválido'; end if;
  if length(coalesce(trim(p_justification),'')) < 3 then raise exception 'Justificativa obrigatória.'; end if;
  update integrity_issues set status = p_status, justification = p_justification, resolved_by = auth.uid(),
    resolved_at = case when p_status = 'ACKNOWLEDGED' then null else now() end where id = p_issue;
  insert into audit_log (actor_id, action, entity, entity_id, payload)
    values (auth.uid(), 'integrity.resolve', 'integrity_issues', p_issue::text, jsonb_build_object('status', p_status, 'justification', p_justification));
end $$;
revoke all on function public.resolve_integrity_issue(uuid,text,text) from public, anon;
grant execute on function public.resolve_integrity_issue(uuid,text,text) to authenticated;

-- A2: readiness per company + entity + temporal coverage. READY needs RAW+Canonical+Gold+reconciled, fresh, no critical issues.
create or replace function public.omie_readiness(p_company uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare res jsonb := '[]'::jsonb; e text; r record; v_state text; v_open int; v_stale boolean;
begin
  if not public.is_service_request() then perform public.integration_admin_assert(p_company); end if;
  foreach e in array array['vendors','customers','products','invoices','orders','receivables'] loop
    select * into r from integration_sync_runs where company_id = p_company and entity = e order by started_at desc limit 1;
    select count(*) into v_open from integrity_issues where company_id = p_company and entity in (e, case e when 'invoices' then 'invoice_items' when 'receivables' then 'settlements' else e end)
      and status = 'OPEN' and severity in ('HIGH','CRITICAL');
    v_stale := r.finished_at is null or r.finished_at < now() - interval '36 hours';
    v_state := case
      when r.id is null then 'PENDING'
      when r.status = 'RUNNING' then 'SYNCING'
      when r.status = 'FAILED' then 'ERROR'
      when not r.raw_complete then 'DEGRADED'
      when not r.canonical_complete then 'RAW_COMPLETE'
      when not r.gold_complete then 'CANONICAL_COMPLETE'
      when v_open > 0 then 'DEGRADED'
      when v_stale then 'DEGRADED'
      when r.expected_records is not null and r.received < r.expected_records then 'DEGRADED'
      else 'READY' end;
    res := res || jsonb_build_object('entity', e, 'state', v_state, 'lastRunAt', r.started_at, 'finishedAt', r.finished_at,
      'periodFrom', r.period_from, 'periodTo', r.period_to, 'expected', r.expected_records, 'received', r.received,
      'failed', r.failed, 'openIssues', v_open, 'stale', v_stale, 'runStatus', r.status, 'message', r.message);
  end loop;
  return res;
end $$;
revoke all on function public.omie_readiness(uuid) from public, anon;
grant execute on function public.omie_readiness(uuid) to authenticated, service_role;

-- Backfill control (admin only). Partitions are months within from/to.
create or replace function public.manage_backfill(p_company uuid, p_action text, p_entity text default null,
  p_from date default null, p_to date default null, p_job uuid default null, p_priority int default 100)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_company uuid;
begin
  if p_action = 'create' then
    perform public.integration_admin_assert(p_company);
    if p_entity not in ('invoices','orders','receivables') then raise exception 'Entidade sem backfill por período.'; end if;
    if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido.'; end if;
    insert into integration_backfill_jobs (company_id, entity, period_from, period_to, priority, partitions_total, current_partition, created_by)
      values (p_company, p_entity, p_from, p_to, p_priority,
        ((extract(year from p_to)*12 + extract(month from p_to)) - (extract(year from p_from)*12 + extract(month from p_from)) + 1)::int,
        date_trunc('month', p_from)::date, auth.uid())
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
grant execute on function public.manage_backfill(uuid,text,text,date,date,uuid,int) to authenticated;