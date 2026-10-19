# Mapeamento Omie → BIOMIE (Financeiro / Contas a Receber)

Status: **preparado, não integrado**. Nenhum campo abaixo foi validado contra a API Omie atual.
A coluna "Origem do nome" indica onde o nome foi visto. "Legado" = código PHP antigo (referência apenas, não contrato).

| BIOMIE (`financial_titles` / `financial_settlements`) | Campo Omie provável | Origem do nome | Confirmado? |
|---|---|---|---|
| external_id | codigo_lancamento_omie | Legado | Não |
| customer_id (via clientes) | codigo_cliente_fornecedor | Legado | Não |
| issue_date | data_emissao | Legado | Não |
| competence_date | data_competencia | Legado | Não |
| due_date | data_vencimento | Legado | Não |
| settlement_date | data_liquidacao | Legado | Não |
| original_amount | valor_documento / valor_liquido | Legado | Não |
| amount paid (settlements) | valor_pago | Legado | Não |
| saldo (derivado, nunca importado como verdade) | valor_aberto | Legado (somente conferência) | Não |
| source_status | status_titulo | Legado | Não |
| account_id | id_conta_corrente | Legado | Não |
| juros / multa / desconto | — | Não identificado | Não |
| installment number/total | — | Não identificado | Não |

Endpoints citados no legado: `ListarContasReceber`, `ListarContasCorrentes`, `ListarMovimentos`.

Regras do BIOMIE que independem da Omie:
- Saldo = original + juros + multa − desconto − liquidações até a data de referência (nunca negativo).
- Vencido = vencimento anterior à referência com saldo > 0. Cancelados ficam fora dos indicadores.
- `source_status` é preservado bruto; o status canônico é sempre derivado.

Antes de ativar: obter credenciais, chamar cada endpoint em homologação, registrar payload em RAW e preencher a coluna "Confirmado?".
