# Mapeamento Omie — fatos transacionais (NÃO CONFIRMADO)

Os métodos abaixo seguem a referência pública da API Omie. **Os nomes de campos da resposta não foram validados com uma resposta real.** O Codex deve rodar uma página de cada método em homologação, comparar com esta tabela e ajustar somente `src/lib/omie/adapters.ts`.

| Entidade | Método | ID externo | Campos usados |
|---|---|---|---|
| Notas fiscais | produtos/nfconsultar `ListarNF` (filtro dEmiInicial/dEmiFinal) | `compl.nIdNF` | ide.nNF, ide.serie, ide.dEmi, ide.cStatus, info.cancelada, nfDestInt.nCodCli, compl.nCodVend, compl.nIdPedido, total.ICMSTot.vNF/vProd/vFrete/vSeg/vOutro/vDesc |
| Itens de nota | (dentro de `det`) | nota + `det[].ide.nItem` | prod.xProd, prod.qCom, prod.vUnCom, prod.vProd, nfProdInt.nCodProd |
| Pedidos | produtos/pedido `ListarPedidos` | `cabecalho.codigo_pedido` | numero_pedido, codigo_cliente, data_previsao, etapa, infoCadastro.dInc/cancelado/faturado, informacoes_adicionais.codVend, total_pedido.valor_total_pedido |
| Itens de pedido | (dentro de `det`) | pedido + `det[].ide.codigo_item` | produto.codigo_produto, quantidade, valor_unitario, valor_total |
| Contas a receber | financas/contareceber `ListarContasReceber` | `codigo_lancamento_omie` | numero_documento, numero_parcela (n/m), codigo_cliente_fornecedor, codigo_vendedor, nCodNF, data_emissao, data_registro, data_vencimento, data_previsao, valor_documento, status_titulo, codigo_categoria, id_conta_corrente |
| Liquidações | financas/mf `ListarMovimentos` (cTpLancamento=CR) | `detalhes.nCodBaixa` | detalhes.nCodTitulo, dDtPagamento, nCodCC, resumo.nValPago |

## Contrato de faturamento
`invoices.total` = `gross_amount` (vNF) até a decisão de negócio. Todos os componentes ficam gravados separadamente (bruto, mercadorias, frete, seguro, outras despesas, desconto). Qual componente é "faturamento comercial" é decisão do negócio e deve ser registrada em `metric_config` (chave `revenue`), nunca em tela.

## Incremental
Só deve ser ativado depois que o Codex confirmar na API um filtro por data de alteração confiável. Até lá, usar carga por período com sobreposição (ex.: últimos 3 dias) — idempotente pelas chaves únicas.
