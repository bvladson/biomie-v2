# Métricas — definição única

Fonte de verdade: `src/domain/metrics/registry.ts` (definições) e `src/domain/metrics/compute.ts` (razões). Agregações em SQL (`fact_sales`, `sales_aggregate`, `finance_title_facts`).

| Métrica | Definição |
|---|---|
| Faturamento bruto | soma de `invoices.gross_amount` (vNF) de notas com status válido (`revenue_valid_statuses()`), por data de competência |
| Faturamento comercial | empresa real com `companies.revenue_basis='commercial_base'`: `invoices.total` preserva a base comercial original ou bruto − frete − seguro − outras despesas; IPI permanece. `fact_sales.amount` distribui essa base pelos itens, com resíduo de centavos determinístico |
| Mercadorias | soma de `goods_amount` |
| Recebido | soma de `financial_settlements.amount` no período |
| Aberto | saldo de títulos não cancelados em `data_as_of` |
| Inadimplência | aberto com vencimento < `data_as_of` (só com `finance.view_overdue`) |
| Ticket médio | faturamento ÷ nº de notas válidas |
| Cliente ativo | cliente com compra válida no período |
| Novo cliente | primeira compra histórica dentro do período |
| RFM | `src/domain/customers/rfm.ts`, faixas em `metric_config.rfm` |
| ABC | curva por participação acumulada no faturamento (80/95/100) |
| Metas | `sales_targets`, nível ativo único em `metric_config.flight_plan.activeLevel` |
| Ritmo / necessário por dia | `FlightPlanEngine` (dias úteis com feriados) |
| Forecast | realizado + carteira ponderada (`OrderWeightModel`) |
| Aging | faixas de atraso sobre títulos abertos em `data_as_of` |

O rateio é calculado antes do filtro de categoria/produto. `invoice_items.total` continua sendo o valor fiscal original do item. Empresas DEMO mantêm a soma original dos itens, independentemente da configuração de base. O universo comercial exige operação comercial e licitação ou visibilidade comercial; status, competência e demais filtros continuam aplicáveis. O contrato de implantação e os campos obrigatórios de importação estão em `VPS_REVENUE_CONTRACT.md`.
