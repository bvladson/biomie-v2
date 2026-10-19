## Rules

- Sales/Vendedor 360 read models are SECURITY INVOKER SQL functions (`sales_*`, `seller_history`) behind `src/lib/repositories/sales.repository.server.ts`; revenue reconciliation across Cockpit/Plano de Voo/Vendas/Vendedor 360 is enforced by `src/test/reconciliation.test.ts`.
- Customers/Products read models are `customers_overview`, `customer_360`, `products_overview`, `product_360` behind `src/lib/repositories/customers-products.repository.server.ts`; RFM scoring lives only in `src/domain/customers/rfm.ts` (config key `rfm`).
- Finance read models (`finance_summary`, `finance_titles`, `customer_finance`) derive balance/status in SQL from `finance_title_facts` at `data_as_of`; never recompute status or balance in TS/components.
- Data quality lives in `data_freshness`, `run_reconciliation` (results in `reconciliation_results`, logged in `job_runs`) and health checks behind `src/lib/repositories/quality.repository.server.ts`; divergences are shown, never adjusted.
