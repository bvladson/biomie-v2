# Contrato de receita na VPS

A migration `0021_legacy_commercial_contract.sql` preserva o contrato comercial já usado pelo legado. A configuração é por empresa; `metric_config.revenue.valid_statuses` continua definindo os status válidos. Nenhuma empresa é convertida automaticamente e os itens fiscais originais permanecem intactos.

## Campos do importador

| Destino | Origem/regra |
|---|---|
| `companies.revenue_basis` | Definir explicitamente `commercial_base` nas empresas reais homologadas. Default `goods`. Empresas DEMO sempre usam `goods` na função semântica. |
| `companies.data_source` | Manter `OMIE_SHADOW` até homologação; o gate de readiness autoriza o corte posterior. |
| `canonical_invoices.commercial_base_amount` | Preservar `valor_base_comercial_nf` quando disponível. Se NULL, promoção usa bruto − frete − outras despesas − seguro. IPI permanece; não descontar novamente descontos já contidos no bruto. |
| `canonical_invoices.operation_scope` | Copiar a classificação original. Default `unconfirmed`; não presumir que toda NF autorizada é venda. |
| `canonical_invoices.business_channel` | Copiar o canal original. Default `unconfirmed`; preservar licitação separadamente. |
| `canonical_invoices.is_biomie_commercial_visible` | Copiar a visibilidade original. Default false. |
| Componentes fiscais do cabeçalho | Preservar `gross_amount`, `goods_amount`, `freight_amount`, `insurance_amount`, `other_expenses_amount`, `discount_amount`. |
| `invoice_items.total` | Preservar os valores fiscais originais. A promoção copia os itens canônicos, sem substituir por valores rateados. |

Os mesmos campos existem em `invoices`. O caminho normal é carregar o canônico e chamar `promote_omie_gold`. Uma carga direta também precisa preencher os campos, `source`, `external_id`, identidade por empresa e `item_sequence`, além de definir `invoices.total` e `commercial_base_amount` com a base comercial aprovada. Alterar a configuração de receita de uma empresa existente exige reexecutar promoção/reconciliação; a configuração isolada não recalcula o cabeçalho.

## Universo e distribuição

`fact_sales` mantém status válido, competência e RLS. Para empresa real, também exige `operation_scope='commercial'` e `(business_channel='licitacao' OR is_biomie_commercial_visible=true)`. Portanto remessas e operações sem classificação não contam; licitações permanecem mesmo quando o sinal de visibilidade varejista é false. Um canal distinto não é excluído apenas por seu nome se a classificação e a visibilidade originais o incluem.

Para empresa real configurada com `commercial_base`, cada item recebe, apenas no resultado analítico, sua proporção da base do cabeçalho sobre a soma dos valores originais dos itens. Cada resultado é arredondado a centavos. O último item na ordem `item_sequence NULLS LAST, id` recebe o resíduo, de modo que a soma seja exatamente o cabeçalho. O cálculo usa todos os itens da NF antes de aplicar categoria/produto. Se a soma original é zero e a base não é zero, a leitura falha explicitamente e a prontidão deve permanecer degradada; não se cria uma distribuição arbitrária.

Os históricos de clientes, o 360 e a classificação `counted` das notas usam esse mesmo universo. O valor de títulos financeiros continua sendo obrigação fiscal: a reconciliação de títulos com NF compara `gross_amount`, e não base comercial. Recebimentos exigem liquidações reais; uma carga de títulos sem baixas não comprova a prontidão financeira.

## Critério de ativação

O importador deve preencher classificações provenientes da origem e validar totais por empresa, competência, canal, vendedor, NF e item. O adaptador Omie novo que ainda não oferece classificação comercial produzirá defaults `unconfirmed`: completar e homologar essa classificação antes de promover/ativar a fonte. Os defaults não constituem evidência comercial.

Execute `scripts/test-commercial-contract.sql` em staging após a migration. A fixture cobre rateio, resíduo, filtro de categoria, cabeçalho pré-calculado, reprocessamento, quatro casas na quantidade, remessa, cancelamento, licitação, classificação ausente e preservação DEMO. Todos os dados de teste são revertidos. Esse teste não substitui reconciliação com os dados extraídos nem os testes de acesso por usuário.
