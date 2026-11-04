export const DEFINITIONS = {
  target: {
    title: "Meta Ativa",
    text: "Meta usada como referência do plano. Vem da meta da empresa quando existe; senão, da soma das metas dos vendedores.",
    formula: "meta da empresa (canal) ou Σ metas dos vendedores",
  },
  realized: {
    title: "Realizado",
    text: "Faturamento das notas válidas no mês até a data dos dados.",
    formula: "Σ notas do período",
  },
  attainment: {
    title: "% da meta",
    text: "Quanto da meta já foi faturado.",
    formula: "realizado ÷ meta",
  },
  ideal: {
    title: "Linha de voo (ideal até hoje)",
    text: "Quanto deveria estar faturado hoje para chegar à meta no ritmo dos dias úteis.",
    formula: "meta × dias úteis decorridos ÷ dias úteis do mês",
  },
  deviation: {
    title: "Desvio",
    text: "Diferença entre o realizado e a linha de voo.",
    formula: "realizado − ideal até hoje",
  },
  gap: {
    title: "Falta para a meta",
    text: "Valor que ainda falta faturar.",
    formula: "máximo(meta − realizado; 0)",
  },
  workdays: {
    title: "Dias úteis",
    text: "Segunda a sexta valem 1, sábado vale o peso da empresa (0,33 ou 0), domingo e feriado valem 0.",
    formula: "Σ pesos dos dias",
  },
  currentPace: {
    title: "Ritmo atual",
    text: "Média faturada por dia útil decorrido.",
    formula: "realizado ÷ dias úteis decorridos",
  },
  requiredPace: {
    title: "Ritmo necessário",
    text: "Quanto é preciso faturar por dia útil restante para fechar a meta.",
    formula: "falta ÷ dias úteis restantes",
  },
  accumulatedPace: {
    title: "Ritmo para fechar a meta acumulada",
    text: "Quanto é preciso faturar por dia útil restante para fechar a soma das metas do trimestre ou do ano. Conta só os meses com meta, e a sobra ou a falta dos meses já encerrados entra na conta: por isso pode ser bem diferente do ritmo necessário do mês.",
    formula:
      "(Σ metas dos meses com meta − Σ realizado nesses meses) ÷ dias úteis restantes desses meses",
  },
  runRate: {
    title: "Previsão pelo ritmo",
    text: "Onde o mês termina se o ritmo atual se mantiver.",
    formula: "ritmo atual × dias úteis do mês",
  },
  forecastBase: {
    title: "Previsão base",
    text: "Realizado mais os pedidos recentes, no prazo e previstos para o mês.",
    formula: "realizado + pedidos até 15 dias não atrasados",
  },
  forecastProbable: {
    title: "Previsão provável",
    text: "Realizado mais a carteira ponderada. Orçamentos não entram.",
    formula: "realizado + carteira ponderada",
  },
  forecastCommit: {
    title: "Previsão comprometida",
    text: "Soma dos valores que os vendedores se comprometeram a faturar.",
    formula: "Σ commits dos vendedores",
  },
  portfolio: {
    title: "Carteira",
    text: "Pedidos abertos. Peso: até 15 dias 90%, 16–45 dias 60%, mais de 45 dias 30%; data prevista vencida 30% e alerta de atraso; previsto após o mês fica fora.",
    formula: "Σ pedido × peso",
  },
  coverage: {
    title: "Cobertura do gap",
    text: "Quanto da falta a carteira ponderada cobre.",
    formula: "carteira ponderada ÷ falta",
  },
  ticket: { title: "Ticket médio", text: "Valor médio por nota.", formula: "faturamento ÷ notas" },
  invoices: {
    title: "Notas",
    text: "Quantidade de notas válidas no período.",
    formula: "contagem de notas",
  },
  customers: {
    title: "Clientes atendidos",
    text: "Clientes distintos com nota no mês. Novo = primeira compra da história no mês.",
    formula: "clientes distintos (novos + recorrentes)",
  },
  quotes: {
    title: "Orçamentos em aberto",
    text: "Pedidos na etapa de orçamento. Aparecem à parte e não entram na previsão.",
    formula: "contagem, valor e idade média",
  },
  conversion: {
    title: "Conversão de orçamentos",
    text: "Orçamentos que viraram pedido. Só aparece após 30 a 60 dias de registro de etapas; antes disso não é estimada.",
    formula: "convertidos ÷ orçamentos (quantidade e valor)",
  },
  productivity: {
    title: "Produtividade",
    text: "Faturamento e notas por dia útil decorrido.",
    formula: "realizado ÷ dias úteis decorridos",
  },
  comparison: {
    title: "Comparativos",
    text: "Mesmo corte de dias no mês anterior e no mesmo mês do ano anterior.",
    formula: "Σ notas até o mesmo dia",
  },
} as const;
export type MetricKey = keyof typeof DEFINITIONS;
