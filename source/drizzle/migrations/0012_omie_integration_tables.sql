alter table public.companies add column if not exists data_source text not null default 'DEMO';
alter table public.companies drop constraint if exists companies_data_source_check;
alter table public.companies add constraint companies_data_source_check check (data_source in ('DEMO','OMIE_SHADOW','OMIE'));

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.integration_credentials (
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null,
  app_key text not null,
  app_secret text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (company_id, provider)
);

create table public.company_integrations (
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider in ('omie')),
  enabled boolean not null default true,
  environment text not null default 'production' check (environment in ('production','sandbox')),
  status text not null default 'NOT_CONFIGURED' check (status in ('NOT_CONFIGURED','CONNECTING','CONNECTED','ERROR')),
  app_key_hint text,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_message text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (company_id, provider)
);
grant select on public.company_integrations to authenticated;
grant all on public.company_integrations to service_role;
alter table public.company_integrations enable row level security;
create policy "admins read integrations" on public.company_integrations for select to authenticated
  using (public.is_admin(auth.uid()) and public.can_access_company(auth.uid(), company_id));

create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null default 'omie',
  entity text not null check (entity in ('vendors','customers','products','invoices','orders','financial')),
  mode text not null default 'FULL' check (mode in ('FULL','INCREMENTAL')),
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','SUCCESS','WARNING','FAILED')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  pages_total int,
  pages_done int not null default 0,
  received int not null default 0,
  created int not null default 0,
  updated int not null default 0,
  skipped int not null default 0,
  failed int not null default 0,
  checkpoint_start jsonb,
  checkpoint_end jsonb,
  message text,
  error_page int,
  triggered_by uuid,
  duration_ms int
);
create index on public.integration_sync_runs (company_id, entity, started_at desc);
grant select on public.integration_sync_runs to authenticated;
grant all on public.integration_sync_runs to service_role;
alter table public.integration_sync_runs enable row level security;
create policy "broad roles read sync runs" on public.integration_sync_runs for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id] and public.has_broad_scope(auth.uid()));

do $$
declare t text;
begin
  foreach t in array array['raw_omie_vendors','raw_omie_customers','raw_omie_products'] loop
    execute format($f$
      create table public.%1$I (
        id uuid primary key default gen_random_uuid(),
        company_id uuid not null references public.companies(id) on delete cascade,
        external_id text not null,
        payload jsonb not null,
        payload_hash text not null,
        source_updated_at timestamptz,
        fetched_at timestamptz not null default now(),
        first_fetched_at timestamptz not null default now(),
        sync_run_id uuid references public.integration_sync_runs(id) on delete set null,
        is_active boolean,
        unique (company_id, external_id)
      );
      grant all on public.%1$I to service_role;
      alter table public.%1$I enable row level security;
    $f$, t);
  end loop;
end $$;

create table public.canonical_vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source text not null default 'omie',
  external_id text not null,
  raw_record_id uuid,
  sync_run_id uuid,
  last_seen_run_id uuid,
  missing_in_source boolean not null default false,
  name text not null,
  email text,
  is_active boolean not null default true,
  source_updated_at timestamptz,
  canonicalized_at timestamptz not null default now(),
  unique (company_id, source, external_id)
);
create table public.canonical_customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source text not null default 'omie',
  external_id text not null,
  raw_record_id uuid,
  sync_run_id uuid,
  last_seen_run_id uuid,
  missing_in_source boolean not null default false,
  legal_name text,
  trade_name text,
  name text not null,
  document_hash text,
  document_masked text,
  person_type text,
  state text,
  city text,
  external_seller_id text,
  is_active boolean not null default true,
  source_updated_at timestamptz,
  canonicalized_at timestamptz not null default now(),
  unique (company_id, source, external_id)
);
create table public.canonical_products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source text not null default 'omie',
  external_id text not null,
  raw_record_id uuid,
  sync_run_id uuid,
  last_seen_run_id uuid,
  missing_in_source boolean not null default false,
  sku text,
  description text not null,
  family text,
  unit text,
  is_active boolean not null default true,
  source_updated_at timestamptz,
  canonicalized_at timestamptz not null default now(),
  unique (company_id, source, external_id)
);
do $$
declare t text;
begin
  foreach t in array array['canonical_vendors','canonical_customers','canonical_products'] loop
    execute format($f$
      grant select on public.%1$I to authenticated;
      grant all on public.%1$I to service_role;
      alter table public.%1$I enable row level security;
      create policy "admins read %1$s" on public.%1$I for select to authenticated
        using (public.is_admin(auth.uid()) and (select public.accessible_company_ids(auth.uid())) @> array[company_id]);
    $f$, t);
  end loop;
end $$;

create table public.canonical_entity_matches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  entity text not null check (entity in ('vendors','customers','products')),
  canonical_id uuid not null,
  biomie_id uuid,
  method text not null check (method in ('name','email','document','sku','manual','none')),
  status text not null check (status in ('MATCHED','CONFLICT','UNMATCHED','MANUAL','IGNORED')),
  candidates int not null default 0,
  note text,
  resolved_by uuid,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (entity, canonical_id)
);
grant select on public.canonical_entity_matches to authenticated;
grant all on public.canonical_entity_matches to service_role;
alter table public.canonical_entity_matches enable row level security;
create policy "admins read matches" on public.canonical_entity_matches for select to authenticated
  using (public.is_admin(auth.uid()) and (select public.accessible_company_ids(auth.uid())) @> array[company_id]);