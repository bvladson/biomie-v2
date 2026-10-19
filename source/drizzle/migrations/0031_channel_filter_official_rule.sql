-- Business decision (19/10/2026): COMPANY = authorization, CHANNEL = filter.
-- Historical legacy grants (can_varejo/can_licitacao) never hide authorized rows.
-- Sales channel follows the official seller rule (approved 29/09/2026); the
-- company default channel is only a UI preference (default_view_channel).

-- 1. Channel no longer participates in authorization.
drop policy if exists "legacy invoice channel" on public.invoices;
drop policy if exists "legacy invoice item channel" on public.invoice_items;
drop policy if exists "legacy order channel" on public.sales_orders;
drop policy if exists "legacy order item channel" on public.sales_order_items;
drop policy if exists "legacy financial title channel" on public.financial_titles;
drop policy if exists "legacy customer channel" on public.customers;
drop policy if exists "legacy canonical invoice channel" on public.canonical_invoices;
drop policy if exists "legacy canonical invoice item channel" on public.canonical_invoice_items;
drop policy if exists "legacy canonical order channel" on public.canonical_orders;
drop policy if exists "legacy canonical order item channel" on public.canonical_order_items;
drop policy if exists "legacy canonical receivable channel" on public.canonical_receivables;
drop policy if exists "legacy canonical settlement channel" on public.canonical_settlements;

-- Kept with the same signatures because older read models still call them.
-- Company access, role and seller scope keep being enforced by their own policies.
create or replace function public.legacy_channel_allowed(p_company uuid,p_channel text)
returns boolean language sql stable security invoker set search_path=public as $$ select true $$;
create or replace function public.legacy_customer_allowed(p_company uuid,p_customer uuid)
returns boolean language sql stable security invoker set search_path=public as $$ select true $$;
comment on table private.legacy_company_access is
  'Historical legacy can_varejo/can_licitacao grants. Since migration 0031 they never restrict data: channel is a filter.';

-- Revenue universe: commercial operations of the varejo and licitacao channels.
-- Intra-group (outros) and unclassified channels never count. DEMO keeps its own data.
create or replace function public.invoice_revenue_eligible(p_company uuid,p_scope text,p_channel text,p_visible boolean)
returns boolean language sql stable security invoker set search_path=public as $$
  select is_demo or (p_scope='commercial' and p_channel in ('varejo','licitacao'))
  from public.companies where id=p_company
$$;

-- 2. The global "Canal" filter compares channel_id. Omie facts only carried
--    business_channel, so every channel filter returned nothing for real data.
create or replace function public.apply_business_channel_id()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.business_channel in ('varejo','licitacao','outros') then
    select c.id into new.channel_id from public.channels c
      where c.company_id=new.company_id and lower(c.name)=new.business_channel
      order by c.id limit 1;
  end if;
  return new;
end $$;
revoke all on function public.apply_business_channel_id() from public,anon,authenticated,service_role;
-- "zz_" makes it fire after the triggers that copy the canonical channel (alphabetical order).
drop trigger if exists zz_invoices_business_channel_id on public.invoices;
create trigger zz_invoices_business_channel_id before insert or update on public.invoices
  for each row execute function public.apply_business_channel_id();
drop trigger if exists zz_orders_business_channel_id on public.sales_orders;
create trigger zz_orders_business_channel_id before insert or update on public.sales_orders
  for each row execute function public.apply_business_channel_id();

-- Every real company has the three channel dimensions.
insert into public.channels(company_id,name)
  select c.id,ch.name from public.companies c cross join (values('varejo'),('licitacao'),('outros')) ch(name)
  where not c.is_demo and not exists(select 1 from public.channels x where x.company_id=c.id and lower(x.name)=ch.name);

update public.invoices set business_channel=business_channel where source='omie' and business_channel in ('varejo','licitacao','outros');
update public.sales_orders set business_channel=business_channel where source='omie' and business_channel in ('varejo','licitacao','outros');

-- 3. Traceability: why each document received its channel.
alter table public.canonical_invoices add column if not exists channel_reason text;
alter table public.canonical_orders add column if not exists channel_reason text;
alter table public.canonical_receivables add column if not exists channel_reason text;

-- 4. Official rule configuration per company: explicit codes of the operational
--    seller "Licitação" (exact normalized name), and the default channel renamed
--    to a UI-only preference.
update private.legacy_classification_config s set
  settings=(s.settings-'default_channel')
    ||jsonb_build_object('default_view_channel',s.settings->'default_channel')
    ||jsonb_build_object('licitacao_seller_codes',coalesce((
        select jsonb_agg(v.external_id order by v.external_id) from public.canonical_vendors v
        where v.company_id=s.company_id and v.source='omie' and public.normalize_text(v.name)='licitacao'),'[]'::jsonb))
    ||jsonb_build_object('channel_rule_version','official-seller-2026-09-29'),
  updated_at=now();

-- 5. Finance read model: channel filter by the title's own channel (titles
--    without an invoice must not disappear), no channel-based authorization.
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
      and (p_channel is null or ft.business_channel = (select lower(ch.name) from public.channels ch where ch.id = p_channel)
           or (ft.business_channel = 'unconfirmed' and i.channel_id = p_channel))
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
revoke all on function public.finance_title_facts(uuid,date,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.finance_title_facts(uuid,date,uuid,uuid,uuid,text,text) to service_role;

insert into public.audit_log(actor_id,action,entity,entity_id,payload)
  values(null,'migration.0031','authorization','channel',
    jsonb_build_object('decision','company=authorization, channel=filter','channel_rule','official-seller-2026-09-29'));
notify pgrst, 'reload schema';
