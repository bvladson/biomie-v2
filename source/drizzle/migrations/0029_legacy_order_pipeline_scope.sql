-- Keep quotations and remittances out of accepted-order portfolio/forecast.
alter table public.canonical_orders
  add column operation_scope text not null default 'unconfirmed',
  add column stage_code text;
alter table public.sales_orders
  add column operation_scope text not null default 'unconfirmed',
  add column stage_code text;

create or replace function public.apply_canonical_order_semantics()
returns trigger language plpgsql security definer set search_path=public as $$
declare source_scope text; source_stage text;
begin
  if new.source='omie' and new.external_id is not null then
    select operation_scope,stage_code into source_scope,source_stage from public.canonical_orders
      where company_id=new.company_id and source='omie' and external_id=new.external_id;
    if found then
      new.operation_scope:=source_scope;
      new.stage_code:=source_stage;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.apply_canonical_order_semantics() from public,anon,authenticated,service_role;
create trigger orders_canonical_semantics before insert or update on public.sales_orders
  for each row execute function public.apply_canonical_order_semantics();

create or replace function public.fact_orders(p_company uuid,p_channel uuid default null,p_branch uuid default null,
  p_seller uuid default null,p_state text default null,p_city text default null,p_category text default null)
returns table(order_id uuid,number text,status public.order_status,order_date date,expected_date date,seller_id uuid,
  customer_id uuid,product_id uuid,category text,qty numeric,amount numeric)
language sql stable security invoker set search_path=public as $$
  select o.id,o.number,o.status,o.order_date,o.expected_date,o.seller_id,o.customer_id,it.product_id,p.category,it.quantity,it.total
  from public.sales_orders o join public.sales_order_items it on it.order_id=o.id and it.company_id=o.company_id
  join public.products p on p.id=it.product_id
  join public.customers c on c.id=o.customer_id
  where o.company_id=p_company
    and public.legacy_channel_allowed(o.company_id,o.business_channel)
    and (o.source<>'omie' or (o.operation_scope='commercial' and o.stage_code is not null and o.stage_code<>'10'))
    and (p_channel is null or o.channel_id=p_channel)
    and (p_branch is null or o.branch_id=p_branch)
    and (p_seller is null or o.seller_id=p_seller)
    and (p_state is null or c.state=p_state)
    and (p_city is null or c.city=p_city)
    and (p_category is null or p.category=p_category)
$$;
revoke all on function public.fact_orders(uuid,uuid,uuid,uuid,text,text,text) from public,anon;
grant execute on function public.fact_orders(uuid,uuid,uuid,uuid,text,text,text) to authenticated,service_role;
notify pgrst, 'reload schema';
