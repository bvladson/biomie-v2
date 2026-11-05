-- Candidata (só medição local): mesmas regras e mesmo resultado, mas as regras da empresa
-- (company_revenue_basis, revenue_valid_statuses, invoice_revenue_eligible) são calculadas uma vez por
-- combinação distinta de (status, escopo, canal, visível), e não uma vez por item de nota.
create or replace function public.invoice_item_amounts(p_company uuid,p_start date,p_end date)
returns table(item_id uuid,invoice_id uuid,amount numeric)
language sql stable security invoker set search_path=public as $$
  with inv as materialized (
    select i.id,i.total,i.status,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible
    from public.invoices i
    where i.company_id=p_company and i.competence_date between p_start and p_end
  ), flags as materialized (
    select k.status,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible,
      public.company_revenue_basis(p_company)='commercial_base'
        and k.status=any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(p_company,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible) use_commercial
    from (select distinct status,operation_scope,business_channel,is_biomie_commercial_visible from inv) k
  ), original as (
    select it.id item_id,i.id invoice_id,it.total original_amount,i.total header_amount,f.use_commercial,
      sum(it.total) over(partition by i.id) original_sum,
      row_number() over(partition by i.id order by it.item_sequence nulls last,it.id) item_position,
      count(*) over(partition by i.id) item_count
    from inv i
    join flags f on f.status=i.status and f.operation_scope=i.operation_scope and f.business_channel=i.business_channel
      and f.is_biomie_commercial_visible=i.is_biomie_commercial_visible
    join public.invoice_items it on it.invoice_id=i.id and it.company_id=p_company
  ), rounded as (
    select original.*,case when use_commercial
      then public.round_commercial_item(header_amount,original_amount,original_sum)
      else original_amount end provisional_amount from original
  )
  select item_id,invoice_id,provisional_amount+case
    when use_commercial and item_position=item_count
      then header_amount-sum(provisional_amount) over(partition by invoice_id)
    else 0 end from rounded
$$;

create or replace function public.fact_sales(p_company uuid,p_start date,p_end date,p_channel uuid default null,p_branch uuid default null,
  p_seller uuid default null,p_state text default null,p_city text default null,p_category text default null)
returns table(invoice_id uuid,competence_date date,seller_id uuid,customer_id uuid,product_id uuid,category text,state text,city text,qty numeric,amount numeric)
language sql stable security invoker set search_path=public as $$
  with base as materialized (
    select i.id,i.competence_date,i.seller_id,i.customer_id,i.status,i.operation_scope,i.business_channel,
      i.is_biomie_commercial_visible,i.channel_id,i.branch_id,a.item_id,a.amount
    from public.invoice_item_amounts(p_company,p_start,p_end) a
    join public.invoices i on i.id=a.invoice_id
    where i.company_id=p_company
      and (p_channel is null or i.channel_id=p_channel)
      and (p_branch is null or i.branch_id=p_branch)
      and (p_seller is null or i.seller_id=p_seller)
  ), ok as materialized (
    select k.status,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible
    from (select distinct status,operation_scope,business_channel,is_biomie_commercial_visible from base) k
    where k.status=any(public.revenue_valid_statuses())
      and public.invoice_revenue_eligible(p_company,k.operation_scope,k.business_channel,k.is_biomie_commercial_visible)
  )
  select b.id,b.competence_date,b.seller_id,b.customer_id,it.product_id,p.category,c.state,c.city,it.quantity,b.amount
  from base b
  join ok on ok.status=b.status and ok.operation_scope=b.operation_scope and ok.business_channel=b.business_channel
    and ok.is_biomie_commercial_visible=b.is_biomie_commercial_visible
  join public.invoice_items it on it.id=b.item_id
  join public.products p on p.id=it.product_id
  join public.customers c on c.id=b.customer_id
  where (p_state is null or c.state=p_state)
    and (p_city is null or c.city=p_city)
    and (p_category is null or p.category=p_category)
$$;
