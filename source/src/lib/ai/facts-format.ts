// Montagem dos FATOS do assistente: números e CONCLUSÕES calculados pelo BIOMIE (meta batida sim/não,
// diferenças, variações), prontos para a IA só redigir. Tudo puro e testável; quem busca os dados é
// src/lib/ai/facts.server.ts. Linhas curtas: o contexto do modelo é 2.048 tokens.
import type { Opportunity } from "@/estoque/api/intel-contract";
import type { IntelOverview } from "@/estoque/api/intel-contract";
import type { FlightPlan, FlightStatus } from "@/flight-plan/api/contract";
import type { BreakdownRow, Dimension } from "@/lib/repositories/sales.repository.server";
import { formatDelta, formatValue } from "@/domain/format";

// O Intl põe espaço duro (U+00A0) depois de "R$"; espaço comum evita surpresa no modelo e nos testes.
const plain = (s: string) => s.split(String.fromCharCode(160)).join(" ");
const m = (v: number | null | undefined) => plain(formatValue(v, "currency"));
const p = (v: number | null | undefined) => plain(formatValue(v, "percent"));
const i = (v: number | null | undefined) => plain(formatValue(v, "integer"));

const STATUS_PT: Record<FlightStatus, string> = {
  ON_TRACK: "no rumo",
  ATTENTION: "atenção",
  RISK: "risco",
  CRITICAL: "crítico",
};

function delta(current: number, previous: number): string {
  if (!(previous > 0)) return "sem base de comparação";
  return formatDelta((current - previous) / previous);
}

const dmy = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, mo, d] = iso.split("-");
  return `${d}/${mo}/${y}`;
};

export function headerLine(companyName: string, periodLabel: string, asOf: string): string {
  return `FATOS — ${companyName}, ${periodLabel}, dados de ${dmy(asOf)}:`;
}

/** Ritmo e meta do mês (Plano de Voo). Conclusões já fechadas: meta batida, falta, adiantado/atrasado. */
export function planFacts(plan: FlightPlan): string[] {
  const s = plan.summary;
  const lines: string[] = [];
  lines.push(`Faturamento do mês até agora: ${m(s.realized)}`);
  if (s.target != null) {
    lines.push(`Meta do mês: ${m(s.target)}`);
    if (s.attainment != null) lines.push(`Percentual da meta atingido: ${p(s.attainment)}`);
    lines.push(
      s.realized >= s.target
        ? `Meta batida: SIM (passou ${m(s.realized - s.target)})`
        : `Meta batida: AINDA NÃO (faltam ${m(s.remainingGap ?? s.target - s.realized)})`,
    );
  } else {
    lines.push("Meta do mês: não definida");
  }
  if (s.idealToday != null && s.deviation != null) {
    const lado = s.deviation >= 0 ? "adiantado" : "atrasado";
    lines.push(`Ideal até hoje: ${m(s.idealToday)}; está ${lado} ${m(Math.abs(s.deviation))}`);
  }
  lines.push(
    `Dias úteis: ${i(s.workdaysElapsed)} de ${i(s.workdaysTotal)} (restam ${i(s.workdaysRemaining)})`,
  );
  if (s.currentDailyPace != null) lines.push(`Ritmo atual por dia útil: ${m(s.currentDailyPace)}`);
  if (s.requiredDailyPace != null)
    lines.push(`Ritmo necessário por dia útil para a meta: ${m(s.requiredDailyPace)}`);
  if (s.runRateForecast != null)
    lines.push(`Previsão do mês no ritmo atual: ${m(s.runRateForecast)}`);
  lines.push(`Carteira em aberto: ${m(s.portfolio)}; pedidos atrasados: ${m(s.lateOrdersAmount)}`);
  if (s.status) lines.push(`Situação do plano: ${STATUS_PT[s.status]}`);
  return lines;
}

/** Faturamento do período com notas, ticket, clientes e comparações (variações já calculadas). */
export function revenueFacts(plan: FlightPlan): string[] {
  const s = plan.summary;
  const ind = plan.indicators;
  const c = ind.comparison;
  const lines: string[] = [];
  lines.push(`Faturamento do mês até agora: ${m(s.realized)}`);
  if (s.target != null)
    lines.push(
      s.realized >= s.target
        ? `Meta do mês: ${m(s.target)} — meta batida: SIM`
        : `Meta do mês: ${m(s.target)} — faltam ${m(s.remainingGap ?? s.target - s.realized)}`,
    );
  lines.push(`Notas emitidas: ${i(ind.invoices)}; ticket médio: ${m(ind.averageTicket)}`);
  lines.push(`Clientes atendidos: ${i(ind.customers)} (novos: ${i(ind.newCustomers)})`);
  lines.push(
    `Mesmo corte do mês anterior: ${m(c.previousMonthSameCut)} (variação: ${delta(s.realized, c.previousMonthSameCut)})`,
  );
  lines.push(
    `Mesmo corte do ano anterior: ${m(c.previousYearSameCut)} (variação: ${delta(s.realized, c.previousYearSameCut)})`,
  );
  return lines;
}

/** Comparação de períodos (mesmo corte de dias úteis; média de 3 meses). */
export function comparisonFacts(plan: FlightPlan): string[] {
  const s = plan.summary;
  const c = plan.indicators.comparison;
  return [
    `Faturamento do mês até agora: ${m(s.realized)}`,
    `Mesmo corte do mês anterior: ${m(c.previousMonthSameCut)} (variação: ${delta(s.realized, c.previousMonthSameCut)})`,
    `Mesmo corte do ano anterior: ${m(c.previousYearSameCut)} (variação: ${delta(s.realized, c.previousYearSameCut)})`,
    `Média dos últimos 3 meses (mesmo corte): ${m(c.last3MonthsAvg)} (variação: ${delta(s.realized, c.last3MonthsAvg)})`,
    `A comparação usa o mesmo corte de dias úteis do mês atual.`,
  ];
}

/** Ranking de vendedores do mês (Plano de Voo), com meta e situação por vendedor. */
export function sellersFacts(plan: FlightPlan): string[] {
  const active = plan.sellers.filter((r) => r.hasActivity || r.metrics.realized > 0);
  const sorted = [...active].sort((a, b) => b.metrics.realized - a.metrics.realized);
  const lines: string[] = [];
  lines.push(`Vendedores com venda no mês: ${i(sorted.length)}`);
  sorted.slice(0, 5).forEach((r, idx) => {
    const mt = r.metrics;
    const alvo =
      mt.target != null && mt.attainment != null
        ? ` (meta ${m(mt.target)}, ${p(mt.attainment)} atingido)`
        : "";
    lines.push(`${idx + 1}º ${r.seller.name}: ${m(mt.realized)}${alvo}`);
  });
  const atras = sorted.filter(
    (r) => r.metrics.status === "RISK" || r.metrics.status === "CRITICAL",
  );
  if (atras.length > 0)
    lines.push(
      `Em risco de não bater a meta: ${atras
        .slice(0, 3)
        .map((r) => r.seller.name)
        .join(", ")}${atras.length > 3 ? ` e mais ${i(atras.length - 3)}` : ""}`,
    );
  const total = plan.summary.realized;
  if (sorted[0] && total > 0)
    lines.push(
      `O 1º colocado representa ${p(sorted[0].metrics.realized / total)} do faturamento do mês`,
    );
  return lines;
}

const DIM_PT: Partial<Record<Dimension, string>> = { customer: "cliente", product: "produto" };

/** Ranking por dimensão (clientes ou produtos) a partir dos drivers de vendas da tela. */
export function breakdownFacts(dim: Dimension, rows: BreakdownRow[], total: number): string[] {
  const name = DIM_PT[dim] ?? dim;
  const sorted = [...rows].sort((a, b) => b.revenue - a.revenue);
  const lines: string[] = [];
  lines.push(`Faturamento do período: ${m(total)}`);
  sorted.slice(0, 5).forEach((r, idx) => {
    const label = r.label ?? r.key ?? "(sem nome)";
    const parts = [m(r.revenue)];
    if (r.share != null) parts.push(`${p(r.share)} do total`);
    if (r.variation != null) parts.push(`variação ${formatDelta(r.variation)}`);
    lines.push(`${idx + 1}º ${name} ${label}: ${parts.join("; ")}`);
  });
  if (sorted.length > 5) lines.push(`Outros ${i(sorted.length - 5)} ${name}s somam o restante`);
  return lines;
}

const STATE_PT: Record<string, string> = {
  sem_venda_janela: "parados (sem venda na janela)",
  baixo_giro: "baixo giro",
  possivel_excesso: "possível excesso",
  possivel_obsolescencia: "possível obsolescência",
  risco_ruptura: "risco de ruptura",
  sem_saldo: "sem saldo",
  saudavel: "saudáveis",
};

/** Estoque: capital por curva, estados de atenção, parados há mais de 365 dias e maiores capitais parados. */
export function stockFacts(ov: IntelOverview): string[] {
  const lines: string[] = [];
  if (ov.capital.total != null) lines.push(`Capital em estoque (ao custo): ${m(ov.capital.total)}`);
  const curvas = (["A", "B", "C"] as const)
    .map((c) => {
      const cc = ov.capital.byCurve[c];
      if (!cc || cc.products === 0) return null;
      return `${c}: ${i(cc.products)} produtos${cc.capital != null ? ` (${m(cc.capital)})` : ""}`;
    })
    .filter(Boolean);
  if (curvas.length > 0) lines.push(`Curvas — ${curvas.join("; ")}`);
  for (const key of [
    "sem_venda_janela",
    "baixo_giro",
    "possivel_excesso",
    "possivel_obsolescencia",
    "risco_ruptura",
  ]) {
    const st = ov.states.find((s) => s.state === key);
    if (st && st.products > 0)
      lines.push(
        `Produtos em ${STATE_PT[key]}: ${i(st.products)}${st.capital != null ? ` (${m(st.capital)})` : ""}`,
      );
  }
  const velho = ov.radar.find((r) => r.band === "365+");
  if (velho && velho.products > 0)
    lines.push(
      `Sem venda há mais de 365 dias: ${i(velho.products)} produtos${velho.capital != null ? ` (${m(velho.capital)})` : ""}`,
    );
  const parked = ov.top
    .filter((t) => t.state !== "saudavel" && t.state !== "risco_ruptura" && t.state !== "sem_saldo")
    .slice(0, 3);
  parked.forEach((t) => {
    lines.push(`Atenção: ${t.name ?? t.sku ?? t.omieProductId} (${STATE_PT[t.state] ?? t.state})`);
  });
  if (ov.capital.negative.products > 0)
    lines.push(
      `Produtos com saldo negativo: ${i(ov.capital.negative.products)} (conferir lançamentos)`,
    );
  return lines;
}

/** Oportunidades de transferência entre empresas (já calculadas pelo motor). */
export function opportunityFacts(rows: Opportunity[], total: number): string[] {
  if (total === 0) return ["Nenhuma oportunidade de transferência entre empresas hoje."];
  const lines: string[] = [`Oportunidades de transferência hoje: ${i(total)}`];
  rows.slice(0, 3).forEach((o, idx) => {
    const valor = o.valueAtCost != null ? ` — valor ao custo ${m(o.valueAtCost)}` : "";
    lines.push(
      `${idx + 1}ª: mover ${i(o.qty)} un. de ${o.name ?? o.sku} de ${o.fromCompanyName} para ${o.toCompanyName}${valor}`,
    );
    lines.push(`   Motivo: ${o.reason}`);
  });
  return lines;
}

const MES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const mesLabel = (ym: string) => {
  const [y, mo] = ym.split("-").map(Number);
  return `${MES_PT[(mo ?? 1) - 1]}/${y}`;
};

/** Conclusão de um cenário de previsão contra a meta (o BIOMIE fecha a conta; a IA só repete). */
function cenario(nome: string, valor: number | null, target: number | null): string | null {
  if (valor == null) return null;
  if (target == null) return `${nome}: ${m(valor)}`;
  const diff = valor - target;
  return `${nome}: ${m(valor)} — ${diff >= 0 ? `meta batida com sobra de ${m(diff)}` : `faltariam ${m(-diff)}`}`;
}

/** O QUE VAI ACONTECER: as previsões do mês já calculadas pelo motor do Plano de Voo. */
export function forecastFacts(plan: FlightPlan): string[] {
  const s = plan.summary;
  const lines: string[] = [];
  if (s.target != null)
    lines.push(`Meta do mês: ${m(s.target)}; realizado até agora: ${m(s.realized)}`);
  else lines.push(`Realizado até agora: ${m(s.realized)} (meta do mês não definida)`);
  for (const linha of [
    cenario("Previsão no ritmo atual", s.runRateForecast, s.target),
    cenario("Previsão provável (com a carteira ponderada)", s.forecastProbable, s.target),
    cenario("Previsão otimista (toda a carteira entra)", s.forecastBase, s.target),
  ])
    if (linha) lines.push(linha);
  if (s.forecastCommit != null)
    lines.push(`Compromissos assumidos pelos vendedores: ${m(s.forecastCommit)}`);
  lines.push(`Restam ${i(s.workdaysRemaining)} dias úteis no mês`);
  if (s.currentDailyPace != null && s.requiredDailyPace != null) {
    const acel =
      s.currentDailyPace > 0 && s.requiredDailyPace > s.currentDailyPace
        ? ` — precisa acelerar ${p(s.requiredDailyPace / s.currentDailyPace - 1)}`
        : s.requiredDailyPace <= s.currentDailyPace
          ? " — o ritmo atual já basta"
          : "";
    lines.push(
      `Ritmo por dia útil: atual ${m(s.currentDailyPace)}, necessário ${m(s.requiredDailyPace)}${acel}`,
    );
  }
  if (s.gapUnreachable)
    lines.push("Aviso do motor: no ritmo possível, a meta deste mês está fora de alcance");
  const semana = plan.weeks?.find((w) => w.current);
  if (semana && semana.target != null)
    lines.push(
      `Semana atual (${dmy(semana.start)}–${dmy(semana.end)}): ${m(semana.realized ?? 0)} de ${m(semana.target)}`,
    );
  if (s.status) lines.push(`Situação do plano: ${STATUS_PT[s.status]}`);
  return lines;
}

/** O QUE ACONTECEU: meses fechados do ano do plano, com atingimento e tendência (contas do BIOMIE). */
export function historyFacts(plan: FlightPlan): string[] {
  const atual = plan.query.month;
  const fechados = (plan.months ?? [])
    .filter((row) => row.month < atual && row.realized > 0)
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  const lines: string[] = [];
  if (fechados.length === 0) {
    lines.push("Ainda não há meses fechados com venda no ano deste plano.");
  } else {
    for (const row of fechados.slice(-6)) {
      const alvo =
        row.target != null
          ? ` (meta ${m(row.target)} — ${row.realized >= row.target ? "batida" : `${p(row.realized / row.target)} atingido`})`
          : "";
      lines.push(`${mesLabel(row.month)}: ${m(row.realized)}${alvo}`);
    }
    if (fechados.length >= 2) {
      const ultimo = fechados[fechados.length - 1]!;
      const anterior = fechados[fechados.length - 2]!;
      lines.push(
        `Último mês fechado contra o anterior: ${m(ultimo.realized)} vs ${m(anterior.realized)} (variação ${delta(ultimo.realized, anterior.realized)})`,
      );
    }
  }
  const c = plan.indicators.comparison;
  lines.push(`Mês atual até agora: ${m(plan.summary.realized)}`);
  lines.push(
    `Mesmo corte do ano anterior: ${m(c.previousYearSameCut)} (variação ${delta(plan.summary.realized, c.previousYearSameCut)})`,
  );
  lines.push(`Média dos últimos 3 meses (mesmo corte): ${m(c.last3MonthsAvg)}`);
  return lines;
}

/** TENDÊNCIA: o que aconteceu → o que está acontecendo → o que vai acontecer, numa leitura só. */
export function trendFacts(plan: FlightPlan): string[] {
  const s = plan.summary;
  const c = plan.indicators.comparison;
  const atual = plan.query.month;
  const fechados = (plan.months ?? [])
    .filter((row) => row.month < atual && row.realized > 0)
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .slice(-3);
  const lines: string[] = [];
  for (const row of fechados) lines.push(`PASSADO — ${mesLabel(row.month)}: ${m(row.realized)}`);
  lines.push(
    `PASSADO — mesmo corte do ano anterior: ${m(c.previousYearSameCut)} (variação ${delta(s.realized, c.previousYearSameCut)})`,
  );
  lines.push(
    `AGORA — mês atual: ${m(s.realized)}${s.target != null ? ` de ${m(s.target)} de meta (${p(s.attainment)})` : ""}`,
  );
  if (s.idealToday != null && s.deviation != null)
    lines.push(
      `AGORA — contra o ideal do dia: ${s.deviation >= 0 ? "adiantado" : "atrasado"} ${m(Math.abs(s.deviation))}`,
    );
  if (s.status) lines.push(`AGORA — situação do plano: ${STATUS_PT[s.status]}`);
  const fut1 = cenario("FUTURO — previsão no ritmo atual", s.runRateForecast, s.target);
  const fut2 = cenario(
    "FUTURO — previsão provável (carteira ponderada)",
    s.forecastProbable,
    s.target,
  );
  if (fut1) lines.push(fut1);
  if (fut2) lines.push(fut2);
  if (s.requiredDailyPace != null)
    lines.push(
      `FUTURO — ritmo necessário por dia útil até o fim do mês: ${m(s.requiredDailyPace)} (restam ${i(s.workdaysRemaining)} dias úteis)`,
    );
  return lines;
}

/** Visão geral (tela sem pacote próprio): ritmo + faturamento resumidos. */
export function overviewFacts(plan: FlightPlan): string[] {
  const seen = new Set<string>();
  return [...revenueFacts(plan), ...planFacts(plan)].filter((l) => {
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
}
