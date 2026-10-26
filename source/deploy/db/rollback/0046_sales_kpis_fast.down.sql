-- Retorno da 0046 (sales_kpis rápido): devolve o sales_kpis da 0021, com o corpo IDÊNTICO.
-- Usar só se a 0046 precisar ser desfeita. Roda numa transação só (psql -1); nada muda nos dados:
--   docker compose --env-file /opt/biomie-v2/shared/stack.env -f /opt/biomie-v2/compose.yml exec -T db \
--     psql -X -1 -U postgres -d biomie_v2 -v ON_ERROR_STOP=1 < deploy/db/rollback/0046_sales_kpis_fast.down.sql
-- Também apaga o registro da 0046 no controle de migrações: o banco volta a dizer a verdade ("0046 não
-- aplicada"), e uma nova ativação de release que a contenha a aplica outra vez.
-- O código do site não muda: a assinatura e o formato da resposta são os mesmos nas duas versões.
create or replace function public.sales_kpis(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb;
begin
  perform public.assert_company_access(p_company);
  with f as (
    select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  ), fb as (
    select customer_id,min(competence_date) d from public.fact_sales(p_company,'-infinity'::date,'infinity'::date) group by 1
  )
  select jsonb_build_object(
    'revenue', coalesce(sum(f.amount), 0),
    'invoices', count(distinct f.invoice_id),
    'units', coalesce(sum(f.qty), 0),
    'customers', count(distinct f.customer_id),
    'newCustomers', (select count(distinct f2.customer_id) from f f2 join fb on fb.customer_id = f2.customer_id and fb.d between p_start and p_end),
    'orders', (select count(distinct order_id) from public.fact_orders(p_company, p_channel, p_branch, p_seller, p_state, p_city, p_category)
               where status <> 'cancelled' and order_date between p_start and p_end)
  ) into v from f;
  return v;
end $$;

delete from private.vps_schema_migrations where name = '0046_sales_kpis_fast';
do $$ begin
  if (select prosrc from pg_proc where oid = 'public.sales_kpis(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure)
     not like '%fact_sales(p_company,''-infinity''::date,''infinity''::date)%' then
    raise exception 'sales_kpis não voltou ao corpo da 0021';
  end if;
end $$;
notify pgrst, 'reload schema';
