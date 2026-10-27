# BIOMIE Intelligence — Inteligência do Estoque (fases 1 a 5)

Documento técnico do motor analítico do Estoque, das telas e da operação. Situação em 27/10/2026:
desenvolvido e testado; **nada em produção**. A ativação segue as etapas aprovadas pelo revisor
(A código com tudo desligado → B motor manual só para o Super admin → C telas para usuários piloto →
D execução diária), cada uma com autorização própria.

## 1. Princípios

- **Consultivo.** O motor e as telas nunca escrevem no Omie, não criam pedido de compra, não
  transferem estoque, não mudam preço nem saldo. Só leem o que o BIOMIE já consolidou.
- **Desconhecido não é zero.** Custo ausente, histórico que não cobre o período e dados incompletos
  ficam `null` e aparecem como "—", "sem custo" ou "histórico insuficiente".
- **Explicável.** Todo diagnóstico, recomendação, alerta e previsão diz a regra ou o modelo, os
  indicadores que o sustentam (com valor e unidade), o período e as limitações. Ausência de
  recomendação é preferível a uma recomendação sem base.
- **Custo só para quem vê custo.** O banco mascara capital, custo, faturamento, margem, preço e
  qualquer item que dependa deles para quem não tem `stock.view_cost` (vendedor, por exemplo).
- **A Curva ABCD oficial não muda.** O motor lê as curvas (automática e manual) e nunca as grava.
- **Falha não interrompe nada.** O motor roda em contêiner próprio, fora das cargas; se falhar, a
  execução é marcada como falha e a tela continua com a análise anterior.

## 2. Arquitetura e fluxo de dados

```
Omie ──(worker: posições, movimentações, notas)──► banco BIOMIE (Postgres)
                                                     │  curvas (0043), fact_sales, posições publicadas
                                                     ▼
                     contêiner avulso biomie_intel (Python 3.12, numpy, pandas; 0,5 CPU, 512 MB)
                       begin → planning → extract (por empresa) → cálculo → publish (lotes de 200)
                       → oportunidades (execução completa) → finish (publica tudo de uma vez)
                                                     │  private.intel_* (resultado por execução)
                                                     ▼
            funções stock_intel_* (SECURITY DEFINER, máscara de custo, empresas do usuário)
                                                     │
                                                     ▼
                     telas /estoque/inteligencia (abas) e ficha do produto; simulador
```

- O motor chama o banco só pelo gateway interno, com a chave de serviço do ambiente (nunca
  impressa; o cliente esconde a chave em qualquer mensagem de erro).
- `stock_intel_begin` cria a execução (uma por vez, trava consultiva; execução esquecida há mais de 2 h
  vira "abandonada"); desligado (`private.intel_settings.enabled = false`) não roda, exceto com
  `--force` (operação).
- `stock_intel_extract` entrega, por empresa: produtos com saldo ou venda em 12 meses (da posição
  publicada e das curvas), vendas diárias de 365 dias (`fact_sales`, a base da página Produtos),
  devoluções, histórico de curva, início da janela da curva, custo da análise anterior e compras de
  30/90 dias (sem devolução, estorno ou transferência entre locais; desconhecidas quando as
  movimentações não cobrem o período). Também grava a foto diária (`stock_snapshots`) e o histórico de
  curva (`stock_curve_history`) — só mudanças, nunca reconstrói o passado.
- `stock_intel_publish` grava em lotes idempotentes (repetir um lote substitui). Nada é visível antes
  de `stock_intel_finish`, que publica todas as empresas juntas, sincroniza os alertas e aplica a
  retenção. `stock_intel_fail` só falha execução em andamento e apaga só o que ela gravou.

## 3. Indicadores por produto (`biomie_intel/metrics.py`)

| Indicador | Regra |
|---|---|
| Janela de N dias | termina na data da análise e inclui o dia; "dias cobertos" = parte posterior ao início das vendas no BIOMIE |
| Venda média (un./dia) | 90 dias quando houve venda neles e ≥ 30 dias cobertos; senão os dias cobertos do ano |
| Cobertura (dias) | disponível ÷ venda média; 0 sem saldo; indeterminada sem consumo (não "infinita") |
| Giro anual | (unidades do ano ÷ dias cobertos × 365) ÷ saldo positivo, com ≥ 120 dias cobertos |
| Tendência 60 d | (últimos 60 − 60 anteriores) ÷ 60 anteriores, com 120 dias cobertos |
| Preço médio / margem | faturamento ÷ unidades em 12 meses; margem só com custo conhecido e não provisório (> R$ 1) |
| Capital | saldos positivos × custo de cada local (CMC); sem custo = desconhecido |

## 4. Estados e prioridade (`states.py`)

Um estado por produto, nesta ordem: sem saldo; produto novo (chegada há menos de 90 dias, nunca
"encalhe"); sem venda (possível obsolescência ≥ 365 dias observados, sem venda na janela ≥ 90, histórico
insuficiente abaixo disso); com venda (risco de ruptura cobertura < 15 dias, possível excesso > 180,
baixo giro < 1/ano, saudável). Prioridade (0–100, ordena o que olhar primeiro; **não é probabilidade**):
`100 × (0,4·capital + 0,3·tempo sem venda + 0,15·cobertura + 0,15·queda)`, cada fator entre 0 e 1 e
explicado na ficha; pesos configuráveis.

## 5. Diagnóstico, recomendações e alertas (fase 3, `diagnosis.py`)

**Diagnósticos (D):** D01 sem saldo com venda em 90 dias; D02 risco de ruptura; D03 demanda em queda;
D04 sem venda prolongada (com venda da mesma SKU em outra empresa, quando houver); D05 possível excesso;
D06 baixo giro; D07 curva piorou; D08 produto novo; D09 histórico insuficiente; D10 custo desconhecido,
provisório ou divergente entre locais; D11 saldo negativo; D12 abaixo do mínimo do Omie; D13 devoluções;
D14 estoque saudável.

**Recomendações (R), sempre para revisão humana:** R01 avaliar reposição; R02 rever compras (queda);
R03 recuperar capital (simulador / verificar demanda na outra empresa); R04 não comprar agora; R05
conferir saldo no Omie; R06 conferir custo no Omie; R07 verificar o mínimo; R08 comprar N un. (só com a
Reposição Inteligente; substitui a R01).

**Alertas (A):** A01 queda abrupta (≥ 50% com pelo menos 5 un. no período anterior); A02 entrada acima
da demanda (compras de 30 dias ≥ 2× vendas de 90 e cobertura > 180); A03 custo mudou ≥ 30% desde a
análise anterior; A04 custo ≥ 20% diferente entre locais; A05 saldo negativo; A06 custo acima do preço
médio de venda; A07 parou de vender (≥ 3 notas no ano, nada em 60 dias e sem venda há mais de 2× o
intervalo médio); A08 curva caiu dois níveis; A09 faturamento da curva diferente das vendas (só com a
janela da curva igual à da análise).

**Ciclo do alerta** (`private.intel_alerts`): abre quando a regra encontra; continua aberto sem
virar aviso novo; "mudou" só quando a gravidade muda; "Estou ciente" (perfis que classificam curvas,
com observação opcional e auditoria) vale até a gravidade **aumentar**; resolve quando a regra deixa
de encontrar; resolvidos ficam 180 dias como histórico.

Textos nunca trazem custo; valores de custo só nas evidências marcadas `cost`, e itens que dependem de
custo vêm marcados `requiresCost` — o banco remove os dois para quem não vê custo.

## 6. Previsão de demanda (fase 4, `forecast.py`)

- Série semanal (semanas completas terminando na data da análise; antes do início das vendas no
  BIOMIE nada vira zero).
- Modelos: média das últimas 13 semanas (base), média do histórico, suavização exponencial simples
  (alfa 0,1/0,2/0,3 escolhido só com o passado), Croston, Croston-SBA e TSB.
- Teste histórico com origem móvel e **sem vazamento**: em cada semana de corte o modelo usa só as
  semanas anteriores e prevê o total das 4, 9 e 13 seguintes (≈ 30, 60 e 90 dias). Escolhe-se o
  menor erro absoluto médio no horizonte de 4 semanas; empate fica com o mais simples.
- Métricas: erro absoluto médio, WAPE (sem divisão por zero: sem venda no teste = "não avaliável"),
  viés, ganho sobre a base. Qualidade: boa (WAPE ≤ 30%), regular (≤ 60%), fraca — rótulo das métricas,
  não probabilidade.
- Faixa: quantis 10% e 90% dos erros do próprio teste, só com ≥ 10 cortes; mostrada como "faixa dos
  erros observados", nunca como intervalo de confiança.
- Sem previsão (com o motivo na tela): produto novo; < 12 semanas observadas; < 3 semanas com venda;
  < 6 cortes; nenhuma venda; nada nas últimas 26 semanas ("Histórico insuficiente para previsão
  confiável."). Classe da demanda (Syntetos–Boylan: ADI e CV²). Sazonalidade: não avaliável com menos
  de 2 anos.
- Limitação: não há histórico diário de saldo por produto, então semana sem venda pode ter sido falta
  de estoque; produto hoje sem saldo recebe o aviso de demanda possivelmente reprimida.

## 7. Fornecedores e prazos de entrega (migração 0048; decisão do usuário de 26/10/2026)

- **Fornecedores e vínculos** vêm do Omie, só leitura: `estoque/produtofornecedor/ListarProdutoFornecedor`
  ("Produto x Fornecedor"), 10 cadastros por página (máximo documentado), pelo worker uma vez por dia
  quando `stock_settings.suppliers_enabled` está ligado (desligado por padrão) ou pela tela (Compras/Super
  admin, uma a cada 30 min). Campos usados: `nCodForn` (= `codigo_cliente_omie`), `cRazaoSocial`,
  `cNomeFantasia`, `produtos[].nCodProd` e `produtos[].cCodigo` (código do produto como o fornecedor usa).
  `cCpfCnpj` não é lido. A API documentada **não traz prazo de entrega**.
- **Sem duplicar cadastro**: o fornecedor é o cadastro que o BIOMIE já importa do Omie
  (`public.customers`, mesmo código); `private.stock_suppliers` guarda só o código, o vínculo com esse
  cadastro e o nome que a API devolveu (usado só enquanto o cadastro não chega).
- **Importação**: fila `private.stock_supplier_jobs` (uma aberta por empresa), páginas idempotentes, total
  que muda no meio recomeça, nova tentativa nunca antes de 2 min (o Omie recusa a mesma consulta repetida
  em menos de 1 min), credencial recusada encerra. No fim, vínculo que o Omie não trouxe deixa de ser do
  Omie (o manual fica); importação vazia com vínculos anteriores não apaga nada; prazos e fornecedor
  principal nunca são apagados pela importação.
- **Prazo de entrega** (`private.stock_lead_times`): por empresa, fornecedor e produto, ou o padrão do
  fornecedor na empresa (o do produto prevalece); dias corridos (1 a 365); lote mínimo opcional;
  observação obrigatória (10 a 300). Informado pela tela "Estoque › Fornecedores e prazos" ou pela ficha do
  produto, só por **Compras** (permissão extra `stock.purchasing` no Admin 2.0) e pelo **Super admin**.
  Ninguém precisa alterar o banco para informar um prazo.
- **Vários fornecedores**: Compras indica o fornecedor principal (`private.stock_preferred_suppliers`) e
  pode vincular ao produto um fornecedor do cadastro que o Omie não vinculou (vínculo manual, removível; o
  do Omie só muda no Omie).
- **Histórico e Auditoria**: toda alteração (prazo, principal, vínculo, política) grava
  `private.stock_supplier_changes` (usuário, data, valor anterior, valor novo, observação) e o mesmo evento
  na Auditoria (`stock.lead_time.changed`, `stock.preferred_supplier.changed`,
  `stock.supplier_link.changed`, `stock.replenishment_policy.changed`), com fornecedor e produto pelo nome.
- **Prazo de teste**: status `teste` só existe na homologação (roteiro `ops/47_hml_replenishment_seed.py`)
  e só é lido pelo motor com o ajuste `private.app_settings['stock.test_lead_times'] = 'on'`, que a produção
  não tem. Sai rotulado: "Prazo configurado na simulação: N dias. O prazo deve ser confirmado por Compras
  antes de servir de base a recomendações reais." A cópia de homologação é refeita da produção (o dado
  só vai da produção para a cópia), e Compras ao salvar transforma o prazo em `confirmado`.
- **Prazo realizado (futuro)**: o prazo médio por histórico precisa de pedidos de compra (data do pedido)
  e recebimentos (data da entrada) ligados ao fornecedor; hoje o BIOMIE lê só as movimentações de estoque
  (entrada sem o pedido). Prazo prometido (Compras) e prazo realizado (histórico) ficarão separados.

## 8. Reposição Inteligente (fase 5, `replenishment.py`)

**Fornecedor da reposição**: o principal; senão o único vinculado; senão o único com prazo. Vários com
prazo e nenhum principal = "fornecedor a definir". Sem fornecedor, sem prazo confiável ou com fornecedor a
definir: **a quantidade de reposição fica indisponível** e a tela diz por quê. Ciclo de revisão, **nível de
serviço por curva** (A/B/C/D de 12 meses do produto e um nível para produto sem curva) e cobertura máxima vêm
da **política de reposição da empresa** (`private.stock_replenishment_policy`, de Compras e do Super admin,
com histórico e Auditoria) ou dos padrões do BIOMIE (30 dias; A 95%, B 90%, C 85%, D 80%, sem curva 90%; sem
cobertura máxima), sempre identificados (ajuste aprovado em 27/10/2026). Exige também **previsão aprovada no teste**. Com `d` = demanda
diária prevista, `σd` = desvio semanal ÷ √7, `L` = prazo de entrega, `R` = revisão, `z` = nível de serviço
(80% → 0,84 … 90% → 1,28 … 99% → 2,33):

- estoque de segurança `ES = z · σd · √L`; ponto de reposição `PR = d · L + ES` (no mínimo o mínimo do
  Omie); posição `P = disponível + pendente de recebimento`; alvo `A = PR + d · R` (limitado à cobertura
  máxima, quando informada, sem ficar abaixo de PR);
- `P ≤ PR` → comprar `A − P`, arredondado ao lote mínimo; `P > A` → não comprar agora; entre os dois →
  sem compra neste ciclo;
- custo estimado só com custo conhecido e não provisório; risco de não comprar = dias de cobertura
  contra o prazo e falta estimada até a próxima entrega.

## 9. Oportunidades entre empresas (fase 5)

Mesma SKU (critério do "vendido no grupo" das curvas) com sobra numa empresa (excesso, possível
obsolescência, sem venda na janela ou baixo giro; sobra = disponível − demanda prevista dela em 90
dias) e falta noutra (demanda prevista e cobertura abaixo do limite de ruptura, ou sem saldo;
necessidade = demanda de 90 dias − posição). Quantidade = menor das duas. Só em execução com todas as
empresas, só para quem acessa as duas empresas, e sempre com o aviso: movimentação entre CNPJs pode
exigir nota fiscal e processos fiscais e operacionais específicos; o BIOMIE não executa transferências.

## 10. Simulador de liquidação (melhorias)

O cálculo original (saída = piso(qtd × %), redução = saída × CMC, receita = saída × preço × (1 −
desconto)) não muda. Acréscimos: descontos prontos de 5 a 30% e personalizado; base do preço explícita
(preço de venda do Omie ou preço médio vendido em 12 meses da análise; sem preço na base escolhida, o
item fica "sem preço", nunca com a outra base); margem mínima; resultado bruto, margem, desconto
concedido, receita na venda integral e produtos abaixo da margem. Avisos: receita potencial não é venda
garantida; o desconto não muda a quantidade vendida (sem histórico que sustente esse efeito); impostos,
frete e comissões não incluídos; nenhuma simulação altera preço no Omie.

## 11. Parâmetros (`stock_internal.intel_params`, sobrescritos por `private.intel_settings.params`)

| Chave | Padrão | Uso |
|---|---|---|
| minHistoryDays | 120 | dias cobertos para o giro |
| lowTurnoverAnnual | 1,0 | baixo giro |
| excessCoverageDays | 180 | possível excesso |
| obsolescenceDays | 365 | possível obsolescência |
| ruptureCoverageDays | 15 | risco de ruptura |
| trendDeclinePct | −30 | demanda em queda |
| costSuspectMax | 1,00 | custo provisório |
| runsKeptDays | 7 | execuções guardadas |
| priorityWeights | 0,4 / 0,3 / 0,15 / 0,15 | prioridade |
| anomalyMinUnits, abruptDropPct | 5, −50 | A01 |
| costChangePct, costDivergencePct | 30, 20 | A03, A04 |
| stoppedSellingMinInvoices | 3 | A07 |
| returnsAttentionPct | 10 | D13 |
| alertsKeptDays | 180 | histórico de alertas |

## 12. Banco (migrações aditivas)

| Migração | Conteúdo |
|---|---|
| 0044 | `intel_settings`, `intel_runs`, `intel_product_metrics`, `intel_current`, `stock_snapshots`, `stock_curve_history`; funções do motor e de leitura |
| 0045 | máscara de custo nos sinais, prioridade e lista |
| 0047 | `intel_alerts`; extração com os campos da fase 3; máscara dos itens; lista com diagnóstico/ação/alertas/previsão e filtros (recomendação, com alerta, família); detalhe com alertas e movimentações por dia |
| 0048 | fornecedores e prazos: permissão `stock.purchasing`; `stock_suppliers`, `stock_product_suppliers`, `stock_supplier_jobs`, `stock_lead_times`, `stock_preferred_suppliers`, `stock_supplier_changes`; importação pelo worker; telas e filtros por fornecedor no painel, nas posições e nas opções (painel, posições e opções da 0043 copiados com o filtro; retorno em `deploy/db/rollback/0048_stock_suppliers.down.sql`) |
| 0049 | `stock_replenishment_policy`, `intel_opportunities`; entrada do motor por empresa (vínculos, prazos confirmados, principal, política); reposição com fornecedor e filtro; Radar (painel da 0045) e lista (0047) com filtro por fornecedor; oportunidades; base de preço e matriz (só com custo) |

Nenhuma migração altera saldos, notas, movimentações, curvas ou funções das curvas. A importação de
fornecedores só lê o Omie.

## 13. Permissões

`stock.view` (ver a inteligência), `stock.view_cost` (capital, custo, faturamento, margem, Pareto,
matriz, custo estimado, base de preço), `stock.classify` (ciência de alertas), `stock.export` (CSV no
servidor), `stock.purchasing` (Compras: fornecedores, prazos de entrega, vínculos manuais, fornecedor
principal, política de reposição e importação pela tela; o Super admin tem tudo isso pelo papel).
Consulta de fornecedores e prazos (capacidade `suppliers`): quem vê custo ou é Compras. O **Comercial**
(Vendedor) consulta previsões e reposições sem fornecedor: sem a página Fornecedores e prazos, sem o filtro
por fornecedor e sem nome, código ou alternativas de fornecedor na reposição (o banco tira esses campos; os
textos do motor não citam o fornecedor). Histórico com nomes e busca no cadastro inteiro só para Compras e
Super admin (ajuste de visibilidade comercial aprovado em 27/10/2026). O menu do Estoque segue o modo do módulo (off/pilot/on); a aba
Inteligência aparece quando o motor está ligado, quando há análise publicada ou para o Super admin.

## 14. Operação

- Produção (só com autorização da etapa): `python ops/remote.py ops/42_intel.py status|run [--force]|enable|disable`.
- Homologação: `python ops/noturno.py intel-fornecedores <release>` (suítes, cópia nova, up,
  fornecedores do Omie na cópia, prazo de teste só na cópia, motor, conferência, navegador, down) ou os
  passos avulsos `41_homolog.py up|suppliers-load|intel-run`,
  `43_intel_check.py biomie_v2_hml`, `29_smoke.py --stock --stock-mode on --curves-readonly --intel --hml`.
- Monitoramento: `private.intel_runs` (status, segundos, estatísticas por empresa: estados, alertas,
  previsões, reposição) e as linhas JSON do motor (`intel_company`, `intel_published`, `intel_failed`).
- Desligar: `42_intel.py disable` (a tela fica com a última análise e avisa que não se atualiza).
- Fornecedores na produção (só com autorização): `40_stock.py suppliers on|off` (importação diária) e
  `40_stock.py suppliers-status`.

## 15. Testes

- Motor: 61 testes (`intelligence/tests`), inclusive vazamento temporal, reprodutibilidade, séries
  esparsas, previsão não confiável, prioridade, escolha do fornecedor, prazo do produto × padrão, prazo de
  teste rotulado, nível de serviço por curva, textos sem nome de fornecedor, política da empresa, reposição e
  oportunidades.
- Banco: `verify_stock_suppliers.sql` (importação, Compras/Super admin, Admin sem a permissão e vendedor só
  leem, validações, histórico e Auditoria antes/depois, prazo de teste só com o ajuste, filtros numa
  empresa), `verify_stock_intel.sql`, `verify_stock_intel_insights.sql`, `verify_stock_intel_commercial.sql`
  (política, entrada do motor, reposição por fornecedor, Radar e lista filtrados, oportunidades por acesso
  às duas empresas, dados oficiais intocados), mais as suítes das curvas e de segurança.
- Worker: `stock-suppliers.test.ts` (só ListarProdutoFornecedor, 10 por página, sem CPF/CNPJ, orçamento
  de tempo, chave ocupada, bloqueio de 30 min, nova tentativa ≥ 2 min, credencial sem vazar).
- Telas: testes de `intel.ts`, `intel-insights.ts`, `intel-search.ts`, `simulation.ts`; teste de
  navegador (`ops/browser/stock-smoke.cjs`) com as abas novas e o vendedor sem custo.

## 16. Retorno

- Etapa A (código com tudo desligado): reativar a release anterior. O executor ignora as migrações
  mais novas; as tabelas `intel_*` ficam sem uso; nada oficial muda.
- Motor: `42_intel.py disable`. Telas: o modo do Estoque (`40_stock.py mode off|pilot`).
- Fornecedores: `40_stock.py suppliers off` para a importação; a release anterior ignora as tabelas; o
  retorno da 0048 (`deploy/db/rollback/0048_stock_suppliers.down.sql`, `psql -1`) volta painel, posições,
  opções e agenda do worker às da 0043 e mantém as tabelas com o que Compras já informou.
- Prazos, política e alertas são dados da inteligência: podem ser removidos pela própria tela (com
  histórico e Auditoria) ou ficar sem uso.

## 17. Limitações conhecidas

- Sem histórico diário de saldo por produto (falta de estoque não identificada nas semanas sem venda).
- Vendas no BIOMIE desde 01/01/2026: sazonalidade não avaliável; algumas janelas de 12 meses são parciais.
- Prazo de entrega e lote mínimo não existem na API do Omie: dependem de Compras na tela. Produto sem
  vínculo em "Produto x Fornecedor" fica sem fornecedor até Compras vincular.
- O código do fornecedor é de cada conta do Omie: o filtro por fornecedor vale para uma empresa por vez.
- No Radar filtrado por fornecedor, a evolução diária não aparece (as fotos diárias são por empresa).
- Equivalência entre empresas pela SKU: produtos diferentes com a mesma SKU apareceriam como iguais.
