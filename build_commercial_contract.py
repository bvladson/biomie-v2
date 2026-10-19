from pathlib import Path
import re

root = Path(__file__).parent / 'source'
migrations = root / 'drizzle' / 'migrations'

prefix = r'''-- Explicit contract for real-company revenue. Existing DEMO amounts remain unchanged.
-- Original fiscal header components and invoice_items.total are never rewritten.
alter table public.companies add column revenue_basis text not null default 'goods'
  check (revenue_basis in ('goods','commercial_base'));
alter table public.canonical_invoices
  add column commercial_base_amount numeric,
  add column operation_scope text not null default 'unconfirmed',
  add column business_channel text not null default 'unconfirmed',
  add column is_biomie_commercial_visible boolean not null default false;
alter table public.invoices
  add column commercial_base_amount numeric,
  add column operation_scope text not null default 'unconfirmed',
  add column business_channel text not null default 'unconfirmed',
  add column is_biomie_commercial_visible boolean not null default false;

create or replace function public.company_revenue_basis(p_company uuid)
returns text language sql stable security invoker set search_path=public as $$
  select case when is_demo then 'goods' else revenue_basis end from public.companies where id=p_company
$$;
create or replace function public.invoice_revenue_eligible(p_company uuid,p_scope text,p_channel text,p_visible boolean)
returns boolean language sql stable security invoker set search_path=public as $$
  select is_demo or (p_scope='commercial' and (p_channel='licitacao' or coalesce(p_visible,false)))
    from public.companies where id=p_company
$$;

create or replace function public.round_commercial_item(p_base numeric,p_original numeric,p_sum_original numeric)
returns numeric language plpgsql immutable security invoker set search_path=public as $$
begin
  if p_sum_original=0 then
    if p_base=0 then return 0; end if;
    raise exception 'Base comercial sem distribuicao: soma dos itens igual a zero.' using errcode='22012';
  end if;
  return round(p_base*p_original/p_sum_original,2);
end $$;

-- Calculate against every item of each invoice BEFORE product/category filters.
-- The final item absorbs the exact cent difference; no fiscal item value is changed.
create or replace function public.invoice_item_amounts(p_company uuid,p_start date,p_end date)
returns table(item_id uuid,invoice_id uuid,amount numeric)
language sql stable security invoker set search_path=public as $$
  with original as (
    select it.id item_id,i.id invoice_id,it.total original_amount,i.total header_amount,
      public.company_revenue_basis(i.company_id)='commercial_base'
        and i.status=any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible) use_commercial,
      sum(it.total) over(partition by i.id) original_sum,
      row_number() over(partition by i.id order by it.item_sequence nulls last,it.id) item_position,
      count(*) over(partition by i.id) item_count
    from public.invoices i join public.invoice_items it on it.invoice_id=i.id and it.company_id=i.company_id
    where i.company_id=p_company and i.competence_date between p_start and p_end
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
  select i.id,i.competence_date,i.seller_id,i.customer_id,it.product_id,p.category,c.state,c.city,it.quantity,a.amount
  from public.invoice_item_amounts(p_company,p_start,p_end) a
  join public.invoices i on i.id=a.invoice_id
  join public.invoice_items it on it.id=a.item_id
  join public.products p on p.id=it.product_id
  join public.customers c on c.id=i.customer_id
  where i.company_id=p_company and i.status=any(public.revenue_valid_statuses())
    and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible)
    and (p_channel is null or i.channel_id=p_channel)
    and (p_branch is null or i.branch_id=p_branch)
    and (p_seller is null or i.seller_id=p_seller)
    and (p_state is null or c.state=p_state)
    and (p_city is null or c.city=p_city)
    and (p_category is null or p.category=p_category)
$$;
revoke all on function public.company_revenue_basis(uuid),public.invoice_revenue_eligible(uuid,text,text,boolean),
  public.round_commercial_item(numeric,numeric,numeric),public.invoice_item_amounts(uuid,date,date) from public,anon;
grant execute on function public.company_revenue_basis(uuid),public.invoice_revenue_eligible(uuid,text,text,boolean),
  public.round_commercial_item(numeric,numeric,numeric),public.invoice_item_amounts(uuid,date,date),
  public.fact_sales(uuid,date,date,uuid,uuid,uuid,text,text,text) to authenticated,service_role;
'''

def function_sql(filename, name):
    source = (migrations / filename).read_text(encoding='utf-8')
    match = re.search(r'create or replace function public\.' + name + r'\(.*?\nend \$\$;', source, re.S)
    if not match:
        raise RuntimeError('Function not found: ' + name)
    return match.group(0)

promotion = function_sql('0020_atomic_canonical_item_replacement.sql', 'promote_omie_gold')
old_columns = 'gross_amount, goods_amount, freight_amount, insurance_amount, other_expenses_amount, discount_amount)'
new_columns = 'gross_amount, goods_amount, freight_amount, insurance_amount, other_expenses_amount, discount_amount,\n        commercial_base_amount,operation_scope,business_channel,is_biomie_commercial_visible)'
assert promotion.count(old_columns) == 1
promotion = promotion.replace(old_columns, new_columns)
old = "ci.competence_date, ci.gross_amount, 'omie', ci.external_id,"
new = """ci.competence_date, case when public.company_revenue_basis(p_company)='commercial_base'
          then coalesce(ci.commercial_base_amount,ci.gross_amount-ci.freight_amount-ci.other_expenses_amount-ci.insurance_amount)
          else ci.gross_amount end, 'omie', ci.external_id,"""
assert old in promotion
promotion = promotion.replace(old, new)
old = 'ci.gross_amount, ci.goods_amount, ci.freight_amount, ci.insurance_amount, ci.other_expenses_amount, ci.discount_amount\n'
new = '''ci.gross_amount, ci.goods_amount, ci.freight_amount, ci.insurance_amount, ci.other_expenses_amount, ci.discount_amount,
        coalesce(ci.commercial_base_amount,ci.gross_amount-ci.freight_amount-ci.other_expenses_amount-ci.insurance_amount),
        ci.operation_scope,ci.business_channel,ci.is_biomie_commercial_visible
'''
assert old in promotion
promotion = promotion.replace(old, new)
old = 'other_expenses_amount = excluded.other_expenses_amount, discount_amount = excluded.discount_amount;'
new = '''other_expenses_amount = excluded.other_expenses_amount, discount_amount = excluded.discount_amount,
        commercial_base_amount=excluded.commercial_base_amount,operation_scope=excluded.operation_scope,
        business_channel=excluded.business_channel,is_biomie_commercial_visible=excluded.is_biomie_commercial_visible;'''
assert old in promotion
promotion = promotion.replace(old, new)
# Repair only double-decoded Portuguese in copied diagnostic strings, never SQL identifiers.
for bad, good in [('PromoÃ§Ã£o','Promoção'),('â€”','—'),('nÃ£o','não'),('invÃ¡lida','inválida')]:
    promotion = promotion.replace(bad, good)

sales_kpis = function_sql('0002_hardening_sales_360.sql','sales_kpis')
old = '''select i.customer_id, min(i.competence_date) d from public.invoices i
    where i.company_id = p_company and i.status = any(public.revenue_valid_statuses()) group by 1'''
new = "select customer_id,min(competence_date) d from public.fact_sales(p_company,'-infinity'::date,'infinity'::date) group by 1"
assert old in sales_kpis
sales_kpis = sales_kpis.replace(old,new)

sales_invoices = function_sql('0002_hardening_sales_360.sql','sales_invoices')
sales_invoices = sales_invoices.replace("'counted', i.status = any(public.revenue_valid_statuses())", "'counted', i.status=any(public.revenue_valid_statuses()) and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible)")
sales_invoices = sales_invoices.replace("  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (", """  with item_totals as (
    select ii.invoice_id,sum(a.amount) amt,count(*) n
    from public.invoice_item_amounts(p_company,p_start,p_end) a
    join public.invoice_items ii on ii.id=a.item_id
    join public.products p on p.id=ii.product_id
    where p_category is null or p.category=p_category
    group by ii.invoice_id
  )
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (""")
old = '''join lateral (select sum(ii.total) amt, count(*) n from public.invoice_items ii join public.products p on p.id = ii.product_id
                  where ii.invoice_id = i.id and (p_category is null or p.category = p_category)) it on it.n > 0'''
assert old in sales_invoices
sales_invoices = sales_invoices.replace(old,'join item_totals it on it.invoice_id=i.id and it.n>0')

overview = function_sql('0004_teams_target_level_customers_products.sql','customers_overview')
old = '''select i.customer_id, min(i.competence_date) first_d, max(i.competence_date) last_d, count(distinct i.id) nfs_all, sum(it.total) life_rev
    from public.invoices i join public.invoice_items it on it.invoice_id = i.id
    where i.company_id = p_company and i.status = any(public.revenue_valid_statuses()) and i.competence_date <= p_as_of group by 1'''
new = "select customer_id,min(competence_date) first_d,max(competence_date) last_d,count(distinct invoice_id) nfs_all,sum(amount) life_rev from public.fact_sales(p_company,'-infinity'::date,p_as_of) group by 1"
assert old in overview
overview = overview.replace(old,new)
old = '''select i.customer_id, i.seller_id, sum(it.total) s from public.invoices i join public.invoice_items it on it.invoice_id = i.id
      where i.company_id = p_company and i.status = any(public.revenue_valid_statuses()) and i.competence_date <= p_as_of group by 1, 2'''
assert old in overview
overview = overview.replace(old,"select customer_id,seller_id,sum(amount) s from public.fact_sales(p_company,'-infinity'::date,p_as_of) group by 1,2")
overview = overview.replace('c.document', 'public.customer_document(c.id) document')

customer = function_sql('0004_teams_target_level_customers_products.sql','customer_360')
old = '''select i.id, i.number, i.competence_date d, i.seller_id, it.total, it.quantity, it.product_id
    from public.invoices i join public.invoice_items it on it.invoice_id = i.id
    where i.company_id = p_company and i.customer_id = p_customer and i.status = any(public.revenue_valid_statuses()) and i.competence_date <= p_as_of'''
new = """select fs.invoice_id id,i.number,fs.competence_date d,fs.seller_id,fs.amount total,fs.qty quantity,fs.product_id
    from public.fact_sales(p_company,'-infinity'::date,p_as_of) fs join public.invoices i on i.id=fs.invoice_id
    where fs.customer_id=p_customer"""
assert old in customer
customer = customer.replace(old,new)
customer = customer.replace('select * into v_c from public.customers','select id,name,city,state into v_c from public.customers')
customer = customer.replace('v_c.document','public.customer_document(v_c.id)')
customer = customer.replace('max(f.competence_date) "lastDate"','max(f.competence_date) "lastDate", (select max(v4.d) from valid v4 where v4.product_id=f.product_id) "lastDateAll"')

product = function_sql('0004_teams_target_level_customers_products.sql','product_360')
old = '''select max(i.competence_date) from public.invoices i join public.invoice_items it on it.invoice_id = i.id
                   where it.product_id = p_product and i.company_id = p_company and i.status = any(public.revenue_valid_statuses())'''
assert old in product
product = product.replace(old,"select max(competence_date) from public.fact_sales(p_company,'-infinity'::date,'infinity'::date) where product_id=p_product")

reconciliation = function_sql('0010_reconciliation_safe_delete.sql','run_reconciliation')
old = 'and status = any(public.revenue_valid_statuses());'
assert reconciliation.count(old) == 2
first = reconciliation.index(old)
reconciliation = reconciliation[:first] + reconciliation[first:].replace(old,old[:-1]+' and public.invoice_revenue_eligible(company_id,operation_scope,business_channel,is_biomie_commercial_visible);',1)
# Finance compares fiscal obligations to gross fiscal NF, independently of commercial exclusions.
old = 'select count(*), coalesce(sum(total), 0) into v_ca, v_a from public.invoices'
assert reconciliation.count(old) == 2
last = reconciliation.rindex(old)
reconciliation = reconciliation[:last] + reconciliation[last:].replace(old,'select count(*), coalesce(sum(coalesce(gross_amount,total)), 0) into v_ca, v_a from public.invoices',1)
reconciliation = reconciliation.replace("'Σ valor original dos títulos das NFs válidas do período comparado a Σ invoices.total.'", "'Σ valor original dos títulos das NFs válidas comparado ao bruto fiscal (gross_amount; DEMO total).'")

sections = [prefix,promotion,sales_kpis,sales_invoices,overview,customer,product,reconciliation,
    "revoke all on function public.promote_omie_gold(uuid,text) from public,anon,authenticated;\ngrant execute on function public.promote_omie_gold(uuid,text) to service_role;\nnotify pgrst, 'reload schema';\n"]
target = migrations / '0021_legacy_commercial_contract.sql'
target.write_text('\n\n'.join(sections),encoding='utf-8')
print('Generated',target.name,'lines',len(target.read_text(encoding='utf-8').splitlines()))
