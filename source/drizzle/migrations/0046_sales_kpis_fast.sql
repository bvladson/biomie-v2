-- 0046: sales_kpis sem varrer todo o histórico a cada chamada (prioridade 1 dos pareceres de 23 e
-- 26/10/2026: "melhorar o desempenho mantendo os resultados financeiros").
--
-- Mesmo contrato (assinatura, permissões, security invoker) e os mesmos números. Mudam só duas partes:
--   * newCustomers — antes: a primeira compra de cada cliente saía de fact_sales sobre TODO o histórico
--     da empresa (com o rateio comercial de cada item), a cada chamada. Um cliente que comprou no período
--     tem a primeira compra <= fim do período; então ela cai no período exatamente quando NÃO existe
--     compra válida dele ANTES do início. Agora é essa checagem de existência, com as mesmas junções e
--     condições que fazem uma linha existir em fact_sales (empresa, item da mesma empresa, produto,
--     cliente, status válido de receita e universo comercial) e sem os filtros da tela, como antes.
--   * orders — antes: fact_orders montava todos os pedidos e itens da empresa e só depois filtrava
--     período e status. Agora o corpo de fact_orders entra direto na consulta, com período e status.
-- Faturamento, notas, unidades e clientes continuam vindo de fact_sales do período, sem mudança.
-- Tudo segue security invoker: as regras de acesso por empresa e por vendedor valem do mesmo jeito.
-- Numerada 0046 porque 0044/0045 estão reservadas para a Inteligência do Estoque (em homologação). O
-- executor aplica por nome, então a ordem entre elas não importa (não mexem nas mesmas funções).
-- Retorno: deploy/db/rollback/0046_sales_kpis_fast.down.sql devolve o corpo anterior (0021).
create or replace function public.sales_kpis(p_company uuid, p_start date, p_end date, p_channel uuid default null, p_branch uuid default null,
  p_seller uuid default null, p_state text default null, p_city text default null, p_category text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare v jsonb; v_statuses public.invoice_status[];
begin
  perform public.assert_company_access(p_company);
  v_statuses := public.revenue_valid_statuses();
  with f as (
    select * from public.fact_sales(p_company, p_start, p_end, p_channel, p_branch, p_seller, p_state, p_city, p_category)
  )
  select jsonb_build_object(
    'revenue', coalesce(sum(f.amount), 0),
    'invoices', count(distinct f.invoice_id),
    'units', coalesce(sum(f.qty), 0),
    'customers', count(distinct f.customer_id),
    -- cliente novo: sem compra válida antes do início do período (regras de fact_sales, sem filtros)
    'newCustomers', (select count(*) from (select distinct f2.customer_id from f f2 where f2.customer_id is not null) x
      where not exists (
        select 1 from public.invoices i
        join public.invoice_items it on it.invoice_id = i.id and it.company_id = i.company_id
        join public.products p on p.id = it.product_id
        join public.customers c on c.id = i.customer_id
        where i.company_id = p_company and i.customer_id = x.customer_id and i.competence_date < p_start
          and i.status = any(v_statuses)
          and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible))),
    -- corpo de fact_orders com período e status dentro da consulta
    'orders', (select count(distinct o.id) from public.sales_orders o
      join public.sales_order_items it on it.order_id = o.id and it.company_id = o.company_id
      join public.products p on p.id = it.product_id
      join public.customers c on c.id = o.customer_id
      where o.company_id = p_company and o.status <> 'cancelled' and o.order_date between p_start and p_end
        and public.legacy_channel_allowed(o.company_id, o.business_channel)
        and (o.source <> 'omie' or (o.operation_scope = 'commercial' and o.stage_code is not null and o.stage_code <> '10'))
        and (p_channel is null or o.channel_id = p_channel)
        and (p_branch is null or o.branch_id = p_branch)
        and (p_seller is null or o.seller_id = p_seller)
        and (p_state is null or c.state = p_state)
        and (p_city is null or c.city = p_city)
        and (p_category is null or p.category = p_category))
  ) into v from f;
  return v;
end $$;
