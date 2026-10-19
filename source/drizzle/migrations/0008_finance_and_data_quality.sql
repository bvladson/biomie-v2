-- ================= Etapa 4: Financeiro (analytical receivables) + Data Quality =================

alter table public.user_permissions drop constraint if exists user_permissions_permission_check;
alter table public.user_permissions add constraint user_permissions_permission_check check (permission in (
  'documents:view_full', 'finance.view_summary', 'finance.view_titles',
  'finance.view_customer_details', 'finance.view_overdue', 'finance.export'));

create or replace function public.finance_capabilities(_user uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct c order by c), array[]::text[]) from (
    select unnest(case
      when r.role in ('SUPER_ADMIN','ADMIN','DIRETORIA','FINANCEIRO') then array[
        'finance.view_summary','finance.view_titles','finance.view_customer_details',
        'finance.view_overdue','finance.export']
      when r.role = 'GESTOR' then array[
        'finance.view_summary','finance.view_titles','finance.view_customer_details','finance.view_overdue']
      when r.role in ('ANALISTA','VENDEDOR') then array['finance.view_summary']
      else array[]::text[] end) c
    from public.user_roles r where r.user_id = _user
    union
    select permission from public.user_permissions where user_id = _user and permission like 'finance.%'
  ) x
$$;

create or replace function public.has_finance_capability(_cap text) returns boolean
language sql stable security definer set search_path = public as $$
  select current_user = 'service_role' or _cap = any(public.finance_capabilities(auth.uid()))
$$;
grant execute on function public.finance_capabilities(uuid), public.has_finance_capability(text)
  to authenticated, service_role;

create table public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  external_id text,
  source text not null default 'demo',
  unique (company_id, name)
);
create table public.financial_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  kind text not null default 'receivable' check (kind in ('receivable','payable')),
  external_id text,
  source text not null default 'demo',
  unique (company_id, code)
);
create table public.financial_titles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id),
  invoice_id uuid references public.invoices(id),
  sales_order_id uuid references public.sales_orders(id),
  seller_id uuid references public.sellers(id),
  category_id uuid references public.financial_categories(id),
  account_id uuid references public.financial_accounts(id),
  document_number text not null,
  installment int not null default 1,
  installments int not null default 1,
  issue_date date not null,
  competence_date date not null,
  due_date date not null,
  expected_date date,
  original_amount numeric(14,2) not null check (original_amount >= 0),
  interest numeric(14,2) not null default 0,
  fine numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,
  cancelled_at date,
  source_status text,
  source text not null default 'demo',
  external_id text,
  created_at timestamptz not null default now(),
  check (installment between 1 and installments)
);
create index on public.financial_titles (company_id, due_date);
create index on public.financial_titles (company_id, customer_id);
create index on public.financial_titles (invoice_id);
create unique index on public.financial_titles (company_id, external_id) where external_id is not null;

create table public.financial_settlements (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references public.financial_titles(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  settlement_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  account_id uuid references public.financial_accounts(id),
  source text not null default 'demo',
  external_id text,
  created_at timestamptz not null default now()
);
create index on public.financial_settlements (title_id);
create index on public.financial_settlements (company_id, settlement_date);

grant select on public.financial_accounts, public.financial_categories,
  public.financial_titles, public.financial_settlements to authenticated;
grant all on public.financial_accounts, public.financial_categories,
  public.financial_titles, public.financial_settlements to service_role;
alter table public.financial_accounts enable row level security;
alter table public.financial_categories enable row level security;
alter table public.financial_titles enable row level security;
alter table public.financial_settlements enable row level security;

create policy "fin accounts by company" on public.financial_accounts for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id]);
create policy "fin categories by company" on public.financial_categories for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id]);
create policy "fin titles scoped" on public.financial_titles for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id]
    and (select public.has_finance_capability('finance.view_titles'))
    and ((not (select public.is_seller_restricted(auth.uid())))
         or (select public.visible_seller_ids(auth.uid())) @> array[seller_id]));
create policy "fin settlements scoped" on public.financial_settlements for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id]
    and exists (select 1 from public.financial_titles t where t.id = title_id));

-- Rule: balance = original + interest + fine - discount - settlements(date <= ref), never < 0.
-- CANCELLED if cancelled_at <= ref; PAID if balance = 0; OVERDUE if due_date < ref and balance > 0;
-- PARTIALLY_PAID if paid > 0; else OPEN. Internal: callers apply capability + scope.
create or replace function public.finance_title_facts(
  p_company uuid, p_ref date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null)
returns table(
  title_id uuid, customer_id uuid, customer_name text, state text, city text,
  seller_id uuid, seller_name text, invoice_id uuid, invoice_number text,
  document_number text, installment int, installments int,
  issue_date date, competence_date date, due_date date, settled_date date,
  original numeric, adjustments numeric, paid numeric, open numeric,
  status text, days_late int, cancelled boolean)
language sql stable security definer set search_path = public as $$
  with t as (
    select ft.*, c.name cname, c.state cstate, c.city ccity, s.name sname, i.number inum,
      coalesce((select sum(st.amount) from public.financial_settlements st
                where st.title_id = ft.id and st.settlement_date <= p_ref), 0) paid_amt,
      (select max(st.settlement_date) from public.financial_settlements st
        where st.title_id = ft.id and st.settlement_date <= p_ref) last_settle,
      (ft.cancelled_at is not null and ft.cancelled_at <= p_ref) is_cancelled
    from public.financial_titles ft
    left join public.customers c on c.id = ft.customer_id
    left join public.sellers s on s.id = ft.seller_id
    left join public.invoices i on i.id = ft.invoice_id
    where ft.company_id = p_company and ft.issue_date <= p_ref
      and (p_channel is null or i.channel_id = p_channel)
      and (p_branch is null or i.branch_id = p_branch)
      and (p_seller is null or ft.seller_id = p_seller)
      and (p_state is null or c.state = p_state)
      and (p_city is null or c.city = p_city)
  ), b as (
    select t.*, case when is_cancelled then 0
      else greatest(original_amount + interest + fine - discount - paid_amt, 0) end bal
    from t
  )
  select id, customer_id, cname, cstate, ccity, seller_id, sname, invoice_id, inum,
    document_number, installment, installments, issue_date, competence_date, due_date, last_settle,
    original_amount, interest + fine - discount, paid_amt, bal,
    case when is_cancelled then 'CANCELLED'
         when bal = 0 then 'PAID'
         when due_date < p_ref then 'OVERDUE'
         when paid_amt > 0 then 'PARTIALLY_PAID'
         else 'OPEN' end,
    case when is_cancelled then 0
         when bal > 0 and due_date < p_ref then p_ref - due_date
         when bal = 0 and last_settle is not null then greatest(last_settle - due_date, 0)
         else 0 end,
    is_cancelled
  from b
$$;
revoke execute on function public.finance_title_facts(uuid, date, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.finance_title_facts(uuid, date, uuid, uuid, uuid, text, text) to service_role;

create or replace function public.finance_assert(p_company uuid, p_cap text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if current_user <> 'service_role' and not public.can_access_company(auth.uid(), p_company) then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  if not public.has_finance_capability(p_cap) then
    raise exception 'Sem permissão financeira (%).', p_cap using errcode = '42501';
  end if;
end $$;
revoke execute on function public.finance_assert(uuid, text) from public, anon;
grant execute on function public.finance_assert(uuid, text) to authenticated, service_role;

create or replace function public.finance_summary(
  p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ref date; v_overdue boolean; v_restricted boolean; v_vis uuid[]; r jsonb;
begin
  perform public.finance_assert(p_company, 'finance.view_summary');
  v_ref := least(p_end, public.data_as_of(p_company));
  v_overdue := public.has_finance_capability('finance.view_overdue');
  v_restricted := current_user <> 'service_role' and public.is_seller_restricted(auth.uid());
  v_vis := case when v_restricted then public.visible_seller_ids(auth.uid()) else null end;

  with f as (
    select * from public.finance_title_facts(p_company, v_ref, p_channel, p_branch, p_seller, p_state, p_city) x
    where not v_restricted or x.seller_id = any(v_vis)
  ), act as (select * from f where not cancelled),
  st as (
    select s.amount, s.settlement_date, a.issue_date, a.due_date, a.customer_id
    from public.financial_settlements s join act a on a.title_id = s.title_id
    where s.settlement_date between p_start and v_ref
  ), ag as (
    select case when v_ref - due_date <= 0 then 'future'
                when v_ref - due_date <= 30 then 'd1_30'
                when v_ref - due_date <= 60 then 'd31_60'
                when v_ref - due_date <= 90 then 'd61_90'
                when v_ref - due_date <= 180 then 'd91_180'
                else 'd180p' end bucket, open, customer_id, title_id
    from act where open > 0
  ), months as (
    select to_char(d, 'YYYY-MM') ym, d::date ms
    from generate_series(date_trunc('month', p_end) - interval '11 months', date_trunc('month', p_end), interval '1 month') d
  ), billed as (
    select to_char(fs.competence_date, 'YYYY-MM') ym, sum(fs.amount) v
    from public.fact_sales(p_company, (select min(ms) from months), v_ref, p_channel, p_branch, p_seller, p_state, p_city, null) fs
    where not v_restricted or fs.seller_id = any(v_vis)
    group by 1
  ), recv as (
    select to_char(s.settlement_date, 'YYYY-MM') ym, sum(s.amount) v
    from public.financial_settlements s join act a on a.title_id = s.title_id
    where s.settlement_date between (select min(ms) from months) and v_ref
    group by 1
  )
  select jsonb_build_object(
    'ref', v_ref,
    'capabilities', to_jsonb(public.finance_capabilities(auth.uid())),
    'overdueVisible', v_overdue,
    'receivable', coalesce((select sum(original + adjustments) from act where due_date between p_start and p_end), 0),
    'receivableCount', (select count(*) from act where due_date between p_start and p_end),
    'received', coalesce((select sum(amount) from st), 0),
    'receivedCount', (select count(*) from st),
    'receivedDaysWeighted', coalesce((select sum(amount * (settlement_date - issue_date)) from st), 0),
    'receivedDelayWeighted', coalesce((select sum(amount * greatest(settlement_date - due_date, 0)) from st), 0),
    'open', coalesce((select sum(open) from act), 0),
    'openCount', (select count(*) from act where open > 0),
    'overdue', case when v_overdue then coalesce((select sum(open) from act where status = 'OVERDUE'), 0) end,
    'overdueCount', case when v_overdue then (select count(*) from act where status = 'OVERDUE') end,
    'dueFuture', coalesce((select sum(open) from act where open > 0 and due_date >= v_ref), 0),
    'customersOverdue', case when v_overdue then (select count(distinct customer_id) from act where status = 'OVERDUE') end,
    'cancelledCount', (select count(*) from f where cancelled),
    'aging', (select coalesce(jsonb_agg(jsonb_build_object('bucket', b.k,
        'value', case when b.k = 'future' or v_overdue then coalesce(x.v, 0) end,
        'titles', case when b.k = 'future' or v_overdue then coalesce(x.n, 0) end,
        'customers', case when b.k = 'future' or v_overdue then coalesce(x.c, 0) end) order by b.o), '[]'::jsonb)
      from (values ('future',0),('d1_30',1),('d31_60',2),('d61_90',3),('d91_180',4),('d180p',5)) b(k,o)
      left join (select bucket, sum(open) v, count(*) n, count(distinct customer_id) c from ag group by 1) x on x.bucket = b.k),
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object('month', m.ym,
        'billed', coalesce(bi.v, 0), 'received', coalesce(re.v, 0)) order by m.ym), '[]'::jsonb)
      from months m left join billed bi on bi.ym = m.ym left join recv re on re.ym = m.ym)
  ) into r;
  return r;
end $$;
grant execute on function public.finance_summary(uuid, date, date, uuid, uuid, uuid, text, text) to authenticated, service_role;

create or replace function public.finance_titles_list(
  p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_customer uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ref date; v_overdue boolean; v_restricted boolean; v_vis uuid[]; r jsonb;
begin
  perform public.finance_assert(p_company, 'finance.view_titles');
  v_ref := least(p_end, public.data_as_of(p_company));
  v_overdue := public.has_finance_capability('finance.view_overdue');
  v_restricted := current_user <> 'service_role' and public.is_seller_restricted(auth.uid());
  v_vis := case when v_restricted then public.visible_seller_ids(auth.uid()) else null end;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.title_id, 'customerId', f.customer_id, 'customer', f.customer_name,
      'sellerId', f.seller_id, 'seller', f.seller_name, 'invoiceId', f.invoice_id,
      'document', f.document_number, 'installment', f.installment, 'installments', f.installments,
      'issueDate', f.issue_date, 'dueDate', f.due_date, 'settledDate', f.settled_date,
      'original', f.original, 'adjustments', f.adjustments, 'paid', f.paid, 'open', f.open,
      'status', case when not v_overdue and f.status = 'OVERDUE' then 'OPEN' else f.status end,
      'daysLate', case when v_overdue then f.days_late end
    ) order by f.due_date desc, f.document_number, f.installment), '[]'::jsonb)
  into r
  from public.finance_title_facts(p_company, v_ref, p_channel, p_branch, p_seller, p_state, p_city) f
  where (not v_restricted or f.seller_id = any(v_vis))
    and (p_customer is null or f.customer_id = p_customer)
    and (p_customer is not null or f.open > 0 or f.due_date between p_start and p_end
         or f.issue_date between p_start and p_end
         or exists (select 1 from public.financial_settlements s where s.title_id = f.title_id
                    and s.settlement_date between p_start and v_ref));
  return jsonb_build_object('ref', v_ref, 'overdueVisible', v_overdue, 'rows', r);
end $$;
grant execute on function public.finance_titles_list(uuid, date, date, uuid, uuid, uuid, text, text, uuid) to authenticated, service_role;

create or replace function public.finance_customer(p_company uuid, p_customer uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ref date; v_overdue boolean; v_restricted boolean; v_vis uuid[]; r jsonb;
begin
  perform public.finance_assert(p_company, 'finance.view_customer_details');
  v_ref := public.data_as_of(p_company);
  v_overdue := public.has_finance_capability('finance.view_overdue');
  v_restricted := current_user <> 'service_role' and public.is_seller_restricted(auth.uid());
  v_vis := case when v_restricted then public.visible_seller_ids(auth.uid()) else null end;
  with f as (
    select * from public.finance_title_facts(p_company, v_ref) x
    where x.customer_id = p_customer and (not v_restricted or x.seller_id = any(v_vis))
  ), act as (select * from f where not cancelled),
  st as (
    select s.settlement_date, s.amount, a.document_number, a.installment, a.due_date
    from public.financial_settlements s join act a on a.title_id = s.title_id
    where s.settlement_date <= v_ref
  )
  select jsonb_build_object(
    'ref', v_ref, 'overdueVisible', v_overdue,
    'billed', coalesce((select sum(fs.amount) from public.fact_sales(p_company, '1900-01-01', v_ref) fs
                        where fs.customer_id = p_customer and (not v_restricted or fs.seller_id = any(v_vis))), 0),
    'titled', coalesce((select sum(original + adjustments) from act), 0),
    'received', coalesce((select sum(amount) from st), 0),
    'open', coalesce((select sum(open) from act), 0),
    'overdue', case when v_overdue then coalesce((select sum(open) from act where status = 'OVERDUE'), 0) end,
    'aging', (select coalesce(jsonb_agg(jsonb_build_object('bucket', b.k,
        'value', case when b.k = 'future' or v_overdue then coalesce(x.v, 0) end,
        'titles', case when b.k = 'future' or v_overdue then coalesce(x.n, 0) end,
        'customers', case when b.k = 'future' or v_overdue then least(coalesce(x.n, 0), 1) end) order by b.o), '[]'::jsonb)
      from (values ('future',0),('d1_30',1),('d31_60',2),('d61_90',3),('d91_180',4),('d180p',5)) b(k,o)
      left join (select case when v_ref - due_date <= 0 then 'future'
                when v_ref - due_date <= 30 then 'd1_30' when v_ref - due_date <= 60 then 'd31_60'
                when v_ref - due_date <= 90 then 'd61_90' when v_ref - due_date <= 180 then 'd91_180'
                else 'd180p' end bucket, sum(open) v, count(*) n from act where open > 0 group by 1) x on x.bucket = b.k),
    'settlements', (select coalesce(jsonb_agg(jsonb_build_object('date', settlement_date, 'amount', amount,
        'document', document_number, 'installment', installment, 'dueDate', due_date,
        'daysLate', greatest(settlement_date - due_date, 0)) order by settlement_date desc), '[]'::jsonb)
      from (select * from st order by settlement_date desc limit 100) z),
    'titles', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', title_id, 'document', document_number, 'installment', installment, 'installments', installments,
        'issueDate', issue_date, 'dueDate', due_date, 'settledDate', settled_date, 'seller', seller_name,
        'original', original, 'adjustments', adjustments, 'paid', paid, 'open', open,
        'status', case when not v_overdue and status = 'OVERDUE' then 'OPEN' else status end,
        'daysLate', case when v_overdue then days_late end) order by due_date desc), '[]'::jsonb) from f)
  ) into r;
  return r;
end $$;
grant execute on function public.finance_customer(uuid, uuid) to authenticated, service_role;

insert into public.financial_accounts (company_id, name)
select id, a from public.companies, unnest(array['Banco Principal','Banco Secundário']) a where is_demo
on conflict do nothing;
insert into public.financial_categories (company_id, code, name)
select id, '1.01.01', 'Venda de produtos' from public.companies where is_demo on conflict do nothing;

-- Demo titles + settlements in one statement (deterministic by invoice id hash)
with base as (
  select i.id inv, i.company_id, i.customer_id, i.seller_id, i.number, i.status, i.competence_date,
         i.total, n.n, gs.k, public.data_as_of(i.company_id) asof,
         ((((hashtext(i.id::text || ':' || gs.k)::bigint % 100) + 100) % 100))::int h
  from public.invoices i
  join public.companies co on co.id = i.company_id and co.is_demo
  cross join lateral (select (1 + ((hashtext(i.id::text || ':n')::bigint % 3) + 3) % 3)::int n) n
  cross join lateral generate_series(1, n.n) gs(k)
  where i.source = 'demo'
), amt as (
  select *, case when k < n then trunc(total / n, 2) else total - trunc(total / n, 2) * (n - 1) end orig,
         competence_date + 30 * k due from base
), plan as (
  select *, case when status <> 'authorized' then 'cancel'
    when h < 55 then 'ontime' when h < 72 then 'late' when h < 82 then 'partial'
    when h >= 97 then 'early' when h < 92 and due < asof - 120 then 'late_old'
    else 'unpaid' end sc from amt
), sd as (
  select *, case sc when 'ontime' then due - (h % 6) when 'late' then due + 3 + h % 40
    when 'late_old' then due + 30 + h % 60 when 'partial' then due + (h % 10)
    when 'early' then due - 10 end sdate from plan
), p as (
  select sd.*,
    case when sc in ('late','late_old') and sdate <= asof then round(orig * 0.00033 * (sdate - due), 2) else 0 end interest,
    case when sc in ('late','late_old') and sdate <= asof then round(orig * 0.02, 2) else 0 end fine,
    case when sc = 'early' and sdate <= asof then round(orig * 0.02, 2) else 0 end discount
  from sd
), ins as (
  insert into public.financial_titles (company_id, customer_id, invoice_id, seller_id, category_id, account_id,
    document_number, installment, installments, issue_date, competence_date, due_date, expected_date,
    original_amount, interest, fine, discount, cancelled_at, source_status, source, external_id)
  select p.company_id, p.customer_id, p.inv, p.seller_id,
    (select id from public.financial_categories c where c.company_id = p.company_id and c.code = '1.01.01'),
    (select id from public.financial_accounts a where a.company_id = p.company_id and a.name = 'Banco Principal'),
    p.number, p.k, p.n, p.competence_date, p.competence_date, p.due, p.due,
    p.orig, p.interest, p.fine, p.discount,
    case when p.sc = 'cancel' then p.competence_date + 2 end, 'demo:' || p.sc, 'demo',
    'demo:' || p.inv || ':' || p.k
  from p
  returning id, company_id, external_id, account_id
)
insert into public.financial_settlements (title_id, company_id, settlement_date, amount, account_id, source, external_id)
select t.id, p.company_id, p.sdate,
  case p.sc when 'partial' then round(p.orig * 0.4, 2)
            when 'early' then p.orig - p.discount
            else p.orig + p.interest + p.fine end,
  t.account_id, 'demo', t.external_id || ':1'
from p
join ins t on t.company_id = p.company_id and t.external_id = 'demo:' || p.inv || ':' || p.k
where p.sc not in ('cancel','unpaid') and p.sdate <= p.asof
  and (case p.sc when 'partial' then round(p.orig * 0.4, 2) when 'early' then p.orig - p.discount
       else p.orig + p.interest + p.fine end) > 0;

create table public.dataset_sync_state (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  dataset text not null check (dataset in ('customers','products','sellers','orders','invoices','finance','targets','flight_plan')),
  layer text not null check (layer in ('SOURCE','RAW','CANONICAL','GOLD','MART')),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  records bigint,
  status text not null default 'ok' check (status in ('ok','failed')),
  error text,
  unique (company_id, dataset, layer)
);
create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  period text not null,
  status text not null default 'running' check (status in ('running','success','failed')),
  triggered_by uuid,
  job_run_id uuid references public.job_runs(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);
create table public.reconciliation_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.reconciliation_runs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  dataset text not null,
  check_key text not null,
  check_name text not null,
  period text not null,
  source_count bigint,
  source_value numeric(16,2),
  target_count bigint,
  target_value numeric(16,2),
  abs_diff numeric(16,2) not null,
  pct_diff numeric(12,6),
  status text not null check (status in ('OK','WARNING','FAILED')),
  rule text not null,
  created_at timestamptz not null default now()
);
create index on public.reconciliation_runs (company_id, started_at desc);
create index on public.reconciliation_results (run_id);

grant select on public.dataset_sync_state, public.reconciliation_runs, public.reconciliation_results to authenticated;
grant all on public.dataset_sync_state, public.reconciliation_runs, public.reconciliation_results to service_role;
alter table public.dataset_sync_state enable row level security;
alter table public.reconciliation_runs enable row level security;
alter table public.reconciliation_results enable row level security;
create policy "quality sync read" on public.dataset_sync_state for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id] and (select public.has_broad_scope(auth.uid())));
create policy "quality runs read" on public.reconciliation_runs for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id] and (select public.has_broad_scope(auth.uid())));
create policy "quality results read" on public.reconciliation_results for select to authenticated
  using ((select public.accessible_company_ids(auth.uid())) @> array[company_id] and (select public.has_broad_scope(auth.uid())));

insert into public.dataset_sync_state (company_id, dataset, layer, last_success_at, last_attempt_at)
select c.id, d, l, (public.data_as_of(c.id) + time '06:00') at time zone 'America/Sao_Paulo',
       (public.data_as_of(c.id) + time '06:00') at time zone 'America/Sao_Paulo'
from public.companies c,
  unnest(array['customers','products','sellers','orders','invoices','finance','targets']) d,
  unnest(array['SOURCE','RAW','CANONICAL','GOLD','MART']) l
where c.is_demo on conflict do nothing;

create or replace function public.quality_assert(p_company uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if current_user = 'service_role' then return; end if;
  if not public.can_access_company(auth.uid(), p_company) then
    raise exception 'Sem acesso a esta empresa.' using errcode = '42501';
  end if;
  if not public.has_broad_scope(auth.uid()) then
    raise exception 'Qualidade dos dados restrita a perfis com visão da empresa inteira.' using errcode = '42501';
  end if;
end $$;
grant execute on function public.quality_assert(uuid) to authenticated, service_role;

create or replace function public.data_freshness(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_demo boolean; v_ref timestamptz; v_cfg jsonb; v_warn numeric; v_stale numeric; r jsonb;
begin
  perform public.quality_assert(p_company);
  select is_demo into v_demo from public.companies where id = p_company;
  v_ref := case when v_demo
    then least(now(), ((public.data_as_of(p_company) + 1)::timestamp) at time zone 'America/Sao_Paulo')
    else now() end;
  select config into v_cfg from public.metric_config where metric_key = 'quality';
  v_warn := coalesce((v_cfg->>'warningHours')::numeric, 26);
  v_stale := coalesce((v_cfg->>'staleHours')::numeric, 72);
  with ds(dataset, label, o) as (values
    ('customers','Clientes',1),('products','Produtos',2),('sellers','Vendedores',3),('orders','Pedidos',4),
    ('invoices','Notas fiscais',5),('finance','Financeiro',6),('targets','Metas',7),('flight_plan','Plano de Voo',8)
  ), cnt as (
    select 'customers' dataset, count(*) n from public.customers where company_id = p_company
    union all select 'products', count(*) from public.products where company_id = p_company
    union all select 'sellers', count(*) from public.sellers where company_id = p_company
    union all select 'orders', count(*) from public.sales_orders where company_id = p_company
    union all select 'invoices', count(*) from public.invoices where company_id = p_company
    union all select 'finance', count(*) from public.financial_titles where company_id = p_company
    union all select 'targets', count(*) from public.sales_targets where company_id = p_company
    union all select 'flight_plan', count(*) from public.flight_plan_snapshots where company_id = p_company
  ), st as (
    select dataset,
      max(last_success_at) filter (where layer in ('SOURCE','RAW')) sync_at,
      max(last_success_at) filter (where layer = 'CANONICAL') transform_at,
      max(last_success_at) filter (where layer in ('GOLD','MART')) mart_at,
      bool_or(status = 'failed') failed,
      string_agg(error, '; ') filter (where error is not null) err
    from public.dataset_sync_state where company_id = p_company group by dataset
  ), fp as (
    select max(finished_at) filter (where status = 'success') ok_at,
           (array_agg(status order by started_at desc))[1] last_status,
           (array_agg(error order by started_at desc))[1] last_error
    from public.job_runs where job_name = 'flight-plan-snapshots'
  ), merged as (
    select ds.dataset, ds.label, ds.o, cnt.n records,
      case when ds.dataset = 'flight_plan' then (select ok_at from fp) else st.sync_at end sync_at,
      case when ds.dataset = 'flight_plan' then (select ok_at from fp) else st.transform_at end transform_at,
      case when ds.dataset = 'flight_plan' then (select ok_at from fp) else st.mart_at end mart_at,
      case when ds.dataset = 'flight_plan' then coalesce((select last_status from fp) = 'failed', false) else coalesce(st.failed, false) end failed,
      case when ds.dataset = 'flight_plan' then (select last_error from fp) else st.err end err
    from ds join cnt on cnt.dataset = ds.dataset left join st on st.dataset = ds.dataset
  )
  select jsonb_build_object('reference', v_ref, 'warningHours', v_warn, 'staleHours', v_stale, 'isDemo', v_demo,
    'datasets', coalesce(jsonb_agg(jsonb_build_object(
      'dataset', dataset, 'label', label, 'records', records,
      'lastSync', sync_at, 'lastTransform', transform_at, 'martUpdated', mart_at, 'error', err,
      'ageHours', round((extract(epoch from (v_ref - least(sync_at, transform_at, mart_at))) / 3600.0)::numeric, 1),
      'status', case when failed then 'FAILED'
        when sync_at is null or transform_at is null or mart_at is null then 'STALE'
        when v_ref - least(sync_at, transform_at, mart_at) > make_interval(hours => v_stale::int) then 'STALE'
        when v_ref - least(sync_at, transform_at, mart_at) > make_interval(hours => v_warn::int) then 'WARNING'
        else 'FRESH' end) order by o), '[]'::jsonb))
  into r from merged;
  return r;
end $$;
grant execute on function public.data_freshness(uuid) to authenticated, service_role;

create or replace function public.quality_job_runs(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform public.quality_assert(p_company);
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'job', job_name,
      'company', params->>'company', 'trigger', trigger, 'startedAt', started_at, 'finishedAt', finished_at,
      'durationMs', round((extract(epoch from (finished_at - started_at)) * 1000)::numeric),
      'rows', rows_written, 'status', status, 'error', error) order by started_at desc), '[]'::jsonb)
  into r from (select * from public.job_runs
               where params->>'company' is null or params->>'company' = p_company::text
               order by started_at desc limit 50) j;
  return r;
end $$;
grant execute on function public.quality_job_runs(uuid) to authenticated, service_role;

create or replace function public.scheduler_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if current_user <> 'service_role' and not public.has_broad_scope(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  begin
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'schedule', j.schedule, 'active', j.active,
        'lastRun', d.start_time, 'lastStatus', d.status) order by j.jobname), '[]'::jsonb)
      from cron.job j
      left join lateral (select start_time, status from cron.job_run_details x
                         where x.jobid = j.jobid order by start_time desc limit 1) d on true$q$ into r;
  exception when others then
    return jsonb_build_object('available', false);
  end;
  return jsonb_build_object('available', true, 'jobs', r);
end $$;
grant execute on function public.scheduler_status() to authenticated, service_role;

create or replace function public.run_reconciliation(p_company uuid, p_period text)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_start date; v_end date; v_ref date; v_run uuid; v_job uuid;
  v_rev numeric; v_cnt bigint; v_a numeric; v_b numeric; v_ca bigint; v_cb bigint; v_failed int;
begin
  perform public.quality_assert(p_company);
  if p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  v_start := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end := (v_start + interval '1 month - 1 day')::date;
  v_ref := public.data_as_of(p_company);
  v_end := least(v_end, v_ref);

  insert into public.job_runs (job_name, params, status, trigger, triggered_by)
  values ('reconciliation', jsonb_build_object('company', p_company, 'period', p_period), 'running', 'manual', auth.uid())
  returning id into v_job;
  insert into public.reconciliation_runs (company_id, period, triggered_by, job_run_id)
  values (p_company, p_period, auth.uid(), v_job) returning id into v_run;

  create temporary table if not exists _rec (dataset text, check_key text, check_name text,
    sc bigint, sv numeric, tc bigint, tv numeric, rule text) on commit drop;
  delete from _rec;

  select count(distinct x.invoice_id), coalesce(sum(x.amount), 0) into v_cnt, v_rev
  from public.fact_sales(p_company, v_start, v_end) x;

  select count(*), coalesce(sum(total), 0) into v_ca, v_a from public.invoices
  where company_id = p_company and competence_date between v_start and v_end
    and status = any(public.revenue_valid_statuses());
  insert into _rec values ('invoices', 'invoices_vs_gold', 'NFs autorizadas = faturamento Gold', v_ca, v_a, v_cnt, v_rev,
    'Σ invoices.total (status válidos, competência no período) comparado a Σ invoice_items.total (fact_sales).');

  select coalesce(sum(v), 0) into v_b from (select x.seller_id, sum(x.amount) v from public.fact_sales(p_company, v_start, v_end) x group by 1) y;
  insert into _rec values ('sellers', 'sellers_vs_revenue', 'Soma dos vendedores = faturamento', null, v_rev, null, v_b,
    'Σ por vendedor (incluindo "Não atribuído") comparado ao faturamento da empresa.');
  select coalesce(sum(v), 0) into v_b from (select x.customer_id, sum(x.amount) v from public.fact_sales(p_company, v_start, v_end) x group by 1) y;
  insert into _rec values ('customers', 'customers_vs_revenue', 'Soma dos clientes = faturamento', null, v_rev, null, v_b,
    'Σ por cliente comparado ao faturamento da empresa.');
  select coalesce(sum(v), 0) into v_b from (select x.product_id, sum(x.amount) v from public.fact_sales(p_company, v_start, v_end) x group by 1) y;
  insert into _rec values ('products', 'products_vs_revenue', 'Soma dos produtos = faturamento', null, v_rev, null, v_b,
    'Σ por produto comparado ao faturamento da empresa.');

  select count(*), coalesce(sum(total), 0) into v_ca, v_a from public.sales_orders
  where company_id = p_company and status = 'open' and order_date <= v_ref;
  select count(distinct o.id), coalesce(sum(it.total), 0) into v_cb, v_b
  from public.sales_orders o join public.sales_order_items it on it.order_id = o.id
  where o.company_id = p_company and o.status = 'open' and o.order_date <= v_ref;
  insert into _rec values ('orders', 'portfolio_vs_items', 'Carteira agregada = soma dos itens elegíveis', v_ca, v_a, v_cb, v_b,
    'Σ sales_orders.total (abertos, emitidos até a data de referência) comparado a Σ sales_order_items.total.');

  select count(*), coalesce(sum(t.original_amount + t.interest + t.fine - t.discount), 0)
       - coalesce((select sum(s.amount) from public.financial_settlements s join public.financial_titles t2 on t2.id = s.title_id
                   where t2.company_id = p_company and s.settlement_date <= v_ref and t2.issue_date <= v_ref
                     and not (t2.cancelled_at is not null and t2.cancelled_at <= v_ref)), 0)
    into v_ca, v_a
  from public.financial_titles t
  where t.company_id = p_company and t.issue_date <= v_ref and not (t.cancelled_at is not null and t.cancelled_at <= v_ref);
  select count(*), coalesce(sum(x.open), 0) into v_cb, v_b from public.finance_title_facts(p_company, v_ref) x where not x.cancelled;
  insert into _rec values ('finance', 'finance_balance', 'Saldo financeiro = original + ajustes − liquidações', v_ca, v_a, v_cb, v_b,
    'Σ(original + juros + multa − desconto) − Σ liquidações até a data de referência, títulos não cancelados, comparado a Σ saldo por título (saldo nunca negativo: pagamento a maior aparece como divergência).');

  select count(distinct t.invoice_id), coalesce(sum(t.original_amount), 0) into v_cb, v_b
  from public.financial_titles t join public.invoices i on i.id = t.invoice_id
  where t.company_id = p_company and i.competence_date between v_start and v_end
    and i.status = any(public.revenue_valid_statuses());
  select count(*), coalesce(sum(total), 0) into v_ca, v_a from public.invoices
  where company_id = p_company and competence_date between v_start and v_end and status = any(public.revenue_valid_statuses());
  insert into _rec values ('finance', 'titles_vs_invoices', 'Títulos gerados = NFs autorizadas', v_ca, v_a, v_cb, v_b,
    'Σ valor original dos títulos das NFs válidas do período comparado a Σ invoices.total.');

  insert into public.reconciliation_results (run_id, company_id, dataset, check_key, check_name, period,
    source_count, source_value, target_count, target_value, abs_diff, pct_diff, status, rule)
  select v_run, p_company, r.dataset, r.check_key, r.check_name, p_period, r.sc, round(r.sv, 2), r.tc, round(r.tv, 2),
    round(abs(r.sv - r.tv), 2),
    case when r.sv = 0 then case when r.tv = 0 then 0 end else round(abs(r.sv - r.tv) / abs(r.sv), 6) end,
    case when abs(r.sv - r.tv) < 0.005 and (r.sc is null or r.tc is null or r.sc = r.tc) then 'OK'
         when abs(r.sv - r.tv) < 0.005 or (r.sv <> 0 and abs(r.sv - r.tv) / abs(r.sv) < 0.005) then 'WARNING'
         else 'FAILED' end,
    r.rule
  from _rec r;

  select count(*) into v_failed from public.reconciliation_results where run_id = v_run and status = 'FAILED';
  update public.reconciliation_runs set status = 'success', finished_at = now(),
    summary = (select jsonb_object_agg(z.status, z.n) from (select rr.status, count(*) n from public.reconciliation_results rr
               where rr.run_id = v_run group by rr.status) z)
  where id = v_run;
  update public.job_runs set status = 'success', finished_at = now(),
    rows_written = (select count(*) from public.reconciliation_results where run_id = v_run),
    error = case when v_failed > 0 then v_failed || ' verificação(ões) com divergência' end
  where id = v_job;
  return v_run;
end $$;
revoke execute on function public.run_reconciliation(uuid, text) from public, anon;
grant execute on function public.run_reconciliation(uuid, text) to authenticated, service_role;