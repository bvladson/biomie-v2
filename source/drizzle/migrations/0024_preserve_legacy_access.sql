-- Preserve explicit legacy channel grants without changing the V2 role policies.
create table private.legacy_company_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  allowed_channels text[] not null default '{}'
    check (allowed_channels <@ array['varejo','licitacao']::text[]),
  legacy_role text, legacy_role_override text,
  primary key(user_id,company_id)
);
revoke all on private.legacy_company_access from public,anon,authenticated,service_role;

create or replace function public.legacy_channel_allowed(p_company uuid,p_channel text)
returns boolean language plpgsql stable security definer set search_path=private,public as $$
declare channels text[];
begin
  if public.is_service_request() then return true; end if;
  if auth.uid() is null then return false; end if;
  if exists(select 1 from public.companies where id=p_company and is_demo) then return true; end if;
  select allowed_channels into channels from private.legacy_company_access where user_id=auth.uid() and company_id=p_company;
  if not found then return true; end if;
  return coalesce(lower(trim(p_channel)) in ('varejo','licitacao') and lower(trim(p_channel))=any(channels),false);
end $$;
revoke all on function public.legacy_channel_allowed(uuid,text) from public,anon;
grant execute on function public.legacy_channel_allowed(uuid,text) to authenticated,service_role;

create or replace function public.assert_company_access(p_company uuid)
returns void language plpgsql stable security invoker set search_path=public as $$
begin
  if not public.is_service_request() and not public.can_access_company(auth.uid(),p_company) then
    raise exception 'forbidden' using errcode='42501';
  end if;
end $$;
revoke all on function public.assert_company_access(uuid) from public,anon;
grant execute on function public.assert_company_access(uuid) to authenticated,service_role;

alter table public.sales_orders add column business_channel text not null default 'unconfirmed';
alter table public.canonical_orders add column business_channel text not null default 'unconfirmed';
alter table public.financial_titles add column business_channel text not null default 'unconfirmed';
alter table public.canonical_receivables add column business_channel text not null default 'unconfirmed';

-- Existing named channel dimensions are evidence; absence is never interpreted as all.
update public.sales_orders o set business_channel=lower(c.name) from public.channels c
  where c.id=o.channel_id and c.company_id=o.company_id and lower(c.name) in ('varejo','licitacao');
update public.financial_titles t set business_channel=i.business_channel from public.invoices i
  where i.id=t.invoice_id and i.company_id=t.company_id and i.business_channel in ('varejo','licitacao');

create or replace function public.apply_canonical_business_channel()
returns trigger language plpgsql security definer set search_path=public as $$
declare channel_value text;
begin
  if new.source='omie' and new.external_id is not null and new.business_channel='unconfirmed' then
    if tg_table_name='sales_orders' then
      select business_channel into channel_value from public.canonical_orders
        where company_id=new.company_id and source='omie' and external_id=new.external_id;
    else
      select business_channel into channel_value from public.canonical_receivables
        where company_id=new.company_id and source='omie' and external_id=new.external_id;
    end if;
    if channel_value in ('varejo','licitacao') then new.business_channel:=channel_value; end if;
  end if;
  return new;
end $$;
revoke all on function public.apply_canonical_business_channel() from public,anon,authenticated,service_role;
create trigger orders_canonical_channel before insert or update on public.sales_orders for each row execute function public.apply_canonical_business_channel();
create trigger titles_canonical_channel before insert or update on public.financial_titles for each row execute function public.apply_canonical_business_channel();

create policy "legacy invoice channel" on public.invoices as restrictive for select to authenticated
  using(public.legacy_channel_allowed(company_id,business_channel));
create policy "legacy invoice item channel" on public.invoice_items as restrictive for select to authenticated
  using(exists(select 1 from public.invoices i where i.id=invoice_id and i.company_id=invoice_items.company_id
    and public.legacy_channel_allowed(i.company_id,i.business_channel)));
create policy "legacy order channel" on public.sales_orders as restrictive for select to authenticated
  using(public.legacy_channel_allowed(company_id,business_channel));
create policy "legacy order item channel" on public.sales_order_items as restrictive for select to authenticated
  using(exists(select 1 from public.sales_orders o where o.id=order_id and o.company_id=sales_order_items.company_id
    and public.legacy_channel_allowed(o.company_id,o.business_channel)));
create policy "legacy financial title channel" on public.financial_titles as restrictive for select to authenticated
  using(public.legacy_channel_allowed(company_id,business_channel));

-- SECURITY DEFINER finance queries call fact_sales, so this helper enforces the
-- channel even when the table owner bypasses RLS.
create or replace function public.invoice_revenue_eligible(p_company uuid,p_scope text,p_channel text,p_visible boolean)
returns boolean language sql stable security invoker set search_path=public as $$
  select (is_demo or (p_scope='commercial' and (p_channel='licitacao' or coalesce(p_visible,false))))
    and public.legacy_channel_allowed(p_company,p_channel)
  from public.companies where id=p_company
$$;

create or replace function public.legacy_customer_allowed(p_company uuid,p_customer uuid)
returns boolean language plpgsql stable security definer set search_path=private,public as $$
begin
  if public.is_service_request() then return true; end if;
  if auth.uid() is null then return false; end if;
  if not exists(select 1 from private.legacy_company_access where user_id=auth.uid() and company_id=p_company)
    or exists(select 1 from public.companies where id=p_company and is_demo) then return true; end if;
  return exists(select 1 from public.invoices where company_id=p_company and customer_id=p_customer
      and public.legacy_channel_allowed(p_company,business_channel))
    or exists(select 1 from public.sales_orders where company_id=p_company and customer_id=p_customer
      and public.legacy_channel_allowed(p_company,business_channel));
end $$;
revoke all on function public.legacy_customer_allowed(uuid,uuid) from public,anon;
grant execute on function public.legacy_customer_allowed(uuid,uuid) to authenticated,service_role;
create policy "legacy customer channel" on public.customers as restrictive for select to authenticated
  using(public.legacy_customer_allowed(company_id,id));

create or replace function public.customer_document(p_customer uuid)
returns text language sql stable security definer set search_path=public as $$
  select public.mask_document(c.document) from public.customers c where c.id=p_customer
  and public.legacy_customer_allowed(c.company_id,c.id)
  and (public.is_service_request() or (public.can_access_company(auth.uid(),c.company_id)
    and (not public.is_seller_restricted(auth.uid()) or c.id=any(public.visible_customer_ids(auth.uid())))))
$$;
create or replace function public.reveal_customer_document(p_customer uuid,p_reason text)
returns text language plpgsql security definer set search_path=public as $$
declare v_doc text; v_company uuid;
begin
  if not public.can_view_full_document() then raise exception 'Forbidden' using errcode='42501'; end if;
  if length(coalesce(trim(p_reason),''))<5 then raise exception 'Reason required'; end if;
  select document,company_id into v_doc,v_company from public.customers where id=p_customer;
  if not found or not public.can_access_company(auth.uid(),v_company)
    or not public.legacy_customer_allowed(v_company,p_customer)
    or (public.is_seller_restricted(auth.uid()) and not p_customer=any(public.visible_customer_ids(auth.uid()))) then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  insert into public.audit_log(actor_id,action,entity,entity_id,payload)
    values(auth.uid(),'document.reveal','customers',p_customer::text,jsonb_build_object('reason',p_reason,'company',v_company));
  return v_doc;
end $$;
revoke all on function public.customer_document(uuid),public.reveal_customer_document(uuid,text) from public,anon;
grant execute on function public.customer_document(uuid) to authenticated,service_role;
grant execute on function public.reveal_customer_document(uuid,text) to authenticated;

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
    where ft.company_id = p_company and ft.issue_date <= p_ref and public.legacy_channel_allowed(ft.company_id,ft.business_channel)
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
revoke all on function public.finance_title_facts(uuid,date,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.finance_title_facts(uuid,date,uuid,uuid,uuid,text,text) to service_role;
notify pgrst, 'reload schema';