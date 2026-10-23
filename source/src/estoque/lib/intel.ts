/**
 * Inteligência do Estoque — rótulos, formatos e montagem dos gráficos (puro, testável).
 * Tudo parte dos indicadores já gravados pelo motor; nada aqui recalcula ou estima valores.
 */
import type { ClassifiedCurve, Curve } from "../api/contract";
import type {
  CurveCapital,
  IntelBand,
  IntelMetrics,
  IntelMinIdle,
  IntelOverview,
  IntelPareto,
  IntelProductRow,
  IntelState,
} from "../api/intel-contract";
import { shortDate } from "./curves";
import { csv, decimal } from "./format";

export const STATE_ORDER: IntelState[] = [
  "risco_ruptura",
  "possivel_obsolescencia",
  "sem_venda_janela",
  "possivel_excesso",
  "baixo_giro",
  "historico_insuficiente",
  "novo",
  "saudavel",
  "sem_saldo",
];

export const STATE_LABELS: Record<IntelState, string> = {
  novo: "Produto novo",
  historico_insuficiente: "Histórico insuficiente",
  sem_venda_janela: "Sem venda na janela",
  baixo_giro: "Baixo giro",
  possivel_excesso: "Possível excesso",
  possivel_obsolescencia: "Possível obsolescência",
  saudavel: "Estoque saudável",
  risco_ruptura: "Risco de ruptura",
  sem_saldo: "Sem saldo",
};

/** A regra de cada estado, com os parâmetros padrão do motor (podem mudar nas configurações). */
export const STATE_RULES: Record<IntelState, string> = {
  novo: "Chegou há menos de 90 dias: não é tratado como encalhe, mesmo sem venda.",
  historico_insuficiente:
    "Sem venda, mas observado há menos de 90 dias: ainda não dá para afirmar falta de giro.",
  sem_venda_janela: "Saldo positivo e nenhuma venda há pelo menos 90 dias observados.",
  possivel_obsolescencia: "Saldo positivo e nenhuma venda há pelo menos 365 dias observados.",
  risco_ruptura: "Vende e o saldo cobre menos de 15 dias no ritmo atual.",
  possivel_excesso: "Vende, mas o saldo cobre mais de 180 dias no ritmo atual.",
  baixo_giro: "Vende, mas o giro anual estimado é menor que 1 (vendas de um ano < saldo).",
  saudavel: "Vende, com cobertura entre 15 e 180 dias e giro de pelo menos 1 ao ano.",
  sem_saldo: "Sem saldo positivo; aparece se teve venda no último ano.",
};

export const BAND_ORDER: IntelBand[] = [
  "0-30",
  "31-60",
  "61-90",
  "91-180",
  "181-365",
  "365+",
  "insuficiente",
];
export const BAND_LABELS: Record<IntelBand, string> = {
  "0-30": "0 a 30 dias",
  "31-60": "31 a 60 dias",
  "61-90": "61 a 90 dias",
  "91-180": "91 a 180 dias",
  "181-365": "181 a 365 dias",
  "365+": "Mais de 365 dias",
  insuficiente: "Histórico insuficiente",
};

/** Rótulos curtos para o eixo do radar (o nome completo fica na dica e na tabela). */
export const BAND_SHORT: Record<IntelBand, string> = {
  "0-30": "0–30 d",
  "31-60": "31–60 d",
  "61-90": "61–90 d",
  "91-180": "91–180 d",
  "181-365": "181–365 d",
  "365+": "+365 d",
  insuficiente: "Insuficiente",
};

export const FLAG_LABELS: Record<string, string> = {
  historico_incompleto: "Histórico incompleto",
  custo_desconhecido: "Custo desconhecido",
  custo_provisorio: "Custo provisório (até R$ 1)",
  custo_divergente: "Custo diferente entre locais",
  saldo_negativo: "Saldo negativo em algum local",
  demanda_em_queda: "Demanda em queda",
  curva_piorou: "Curva piorou",
  vendido_no_grupo: "Vendido por outra empresa",
  saida_recente: "Saída nos últimos 90 dias",
  venda_para_grupo: "Venda para empresa do grupo",
  devolucoes: "Devoluções de venda",
  abaixo_do_minimo: "Abaixo do mínimo",
  pendente_recebimento: "Pendente de recebimento",
  sem_consumo: "Sem consumo observado",
  demanda_recente: "Demanda recente",
};
export const flagLabel = (flag: string) => FLAG_LABELS[flag] ?? flag;

/** Escala ordenada (A mais forte), a mesma do selo de curva; valores em styles.css. */
export const CURVE_COLORS: Record<Curve, string> = {
  A: "var(--curve-a)",
  B: "var(--curve-b)",
  C: "var(--curve-c)",
  D: "var(--curve-d)",
  U: "var(--curve-u)",
};

/** Tempo sem venda: laranja mais escuro = mais tempo; "insuficiente" fica neutro (fora da escala). */
export const BAND_COLORS: Record<IntelBand, string> = {
  "0-30": "var(--age-1)",
  "31-60": "var(--age-2)",
  "61-90": "var(--age-3)",
  "91-180": "var(--age-4)",
  "181-365": "var(--age-5)",
  "365+": "var(--age-6)",
  insuficiente: "var(--age-none)",
};

/** Gravidade de cada estado (cor de alerta sempre com ícone e rótulo na tela). */
export type StateTone = "critical" | "serious" | "warning" | "good" | "neutral";
export const STATE_TONE: Record<IntelState, StateTone> = {
  risco_ruptura: "critical",
  possivel_obsolescencia: "serious",
  sem_venda_janela: "warning",
  possivel_excesso: "warning",
  baixo_giro: "warning",
  historico_insuficiente: "neutral",
  novo: "neutral",
  saudavel: "good",
  sem_saldo: "neutral",
};

export const MIN_IDLE: IntelMinIdle[] = [30, 60, 90, 180, 365];
export const minIdleLabel = (n: IntelMinIdle) => `Sem venda há mais de ${n} dias`;

/** Faixas do radar acima de N dias: a mesma regra do filtro "mais de N dias" (card = lista). */
export function bandsAbove(n: IntelMinIdle): IntelBand[] {
  const limits: [IntelBand, number][] = [
    ["31-60", 30],
    ["61-90", 60],
    ["91-180", 90],
    ["181-365", 180],
    ["365+", 365],
  ];
  return limits.filter(([, from]) => from >= n).map(([band]) => band);
}

const number = (n: number, digits = 0) =>
  n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function days(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n === 1 ? "1 dia" : `${number(n)} dias`;
}

/** Cobertura: dias que o saldo dura no ritmo atual; "sem consumo" quando não houve venda observada. */
export function coverageText(
  coverage: number | null | undefined,
  velocity?: number | null,
): string {
  if (coverage === null || coverage === undefined) return velocity === 0 ? "sem consumo" : "—";
  return days(Math.round(coverage));
}

export function percentText(share: number | null | undefined, digits = 1): string {
  if (share === null || share === undefined) return "—";
  return `${number(share * 100, digits)}%`;
}

const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
/** Eixos e rótulos dos gráficos: 1,2 mil · 3,4 mi. */
export const compactNumber = (n: number) => compact.format(n);
export const compactMoney = (n: number) => `R$ ${compact.format(n)}`;
export const integer = (n: number) => number(n);

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "2026-03" → "mar/26". */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]}/${m[1]!.slice(2)}`;
}

/** Marcas redondas de 0 até max (passo 1, 2, 2,5 ou 5 × 10ⁿ), para o eixo não ter 650 mil, 1,3 mi. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const n = Math.ceil(max / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
}

export type CurveMode = "capital" | "products" | "share";

export function curveDistribution(byCurve: Record<Curve, CurveCapital>, mode: CurveMode) {
  const curves: Curve[] = ["A", "B", "C", "D"];
  const total = curves.reduce((sum, c) => sum + (byCurve[c]?.capital ?? 0), 0);
  return curves.map((curve) => {
    const capital = byCurve[curve]?.capital ?? null;
    const products = byCurve[curve]?.products ?? 0;
    const value =
      mode === "products"
        ? products
        : mode === "capital"
          ? capital
          : capital === null || !total
            ? null
            : capital / total;
    return { curve, value, capital, products, fill: CURVE_COLORS[curve] };
  });
}

export interface EvolutionRow extends Record<ClassifiedCurve, number | null> {
  day: string;
  label: string;
  total: number | null;
}

export function evolutionRows(
  evolution: IntelOverview["evolution"],
  mode: "capital" | "products",
): EvolutionRow[] {
  return evolution.map((point) => {
    const source = (mode === "capital" ? point.capital : point.products) ?? {};
    const values = {
      A: source.A ?? null,
      B: source.B ?? null,
      C: source.C ?? null,
      D: source.D ?? null,
    };
    const total =
      mode === "capital" && !point.capital
        ? null
        : (values.A ?? 0) + (values.B ?? 0) + (values.C ?? 0) + (values.D ?? 0);
    return { day: point.day, label: shortDate(point.day).slice(0, 5), ...values, total };
  });
}

export function radarRows(radar: IntelOverview["radar"], mode: "capital" | "products") {
  const byBand = new Map(radar.map((r) => [r.band, r]));
  return BAND_ORDER.map((band) => {
    const r = byBand.get(band);
    return {
      band,
      label: BAND_LABELS[band],
      value: mode === "capital" ? (r?.capital ?? null) : (r?.products ?? 0),
      products: r?.products ?? 0,
      capital: r?.capital ?? null,
      newProducts: r?.newProducts ?? 0,
    };
  });
}

/** Pareto: as N primeiras barras (faturamento) e o acumulado de TODOS os produtos vendidos. */
export function paretoChart(pareto: IntelPareto, maxBars = 60) {
  const counts = { A: 0, B: 0, C: 0 } as Record<"A" | "B" | "C", number>;
  for (const row of pareto.rows) {
    const curve = row[7];
    if (curve === "A" || curve === "B" || curve === "C") counts[curve] += 1;
  }
  const bars = pareto.rows.slice(0, maxBars).map((row) => ({
    rank: row[0],
    omieProductId: row[1],
    sku: row[2],
    name: row[3],
    revenue: row[4],
    cumulativePct: Math.round(row[6] * 10000) / 100,
    curve: row[7],
    manual: row[8],
    fill: CURVE_COLORS[row[7]],
  }));
  const rest = pareto.rows.slice(maxBars);
  return {
    bars,
    counts,
    rest: { products: rest.length, revenue: rest.reduce((sum, row) => sum + row[4], 0) },
  };
}

/** Evidências que sustentam o estado do produto, com os números gravados (sem inventar causas). */
export function evidence(state: IntelState, m: IntelMetrics): string[] {
  const lines: string[] = [];
  const units365 = m.sales.d365.units;
  if (units365 === null) lines.push("Sem histórico de vendas no BIOMIE para o último ano.");
  else
    lines.push(
      `${number(units365, units365 % 1 ? 1 : 0)} unidades vendidas em ${days(m.sales.d365.coveredDays)} com histórico${
        m.sales.d365.coveredDays < 365 ? " (o histórico não cobre o ano inteiro)" : ""
      }.`,
    );
  if (m.lastSale)
    lines.push(`Última venda em ${shortDate(m.lastSale)} (${days(m.daysWithoutSale)}).`);
  else if (m.daysWithoutSale !== null)
    lines.push(
      `Nenhuma venda observada em ${days(m.daysWithoutSale)} (desde ${shortDate(m.idleSince)}).`,
    );
  if (m.velocityDaily !== null && m.velocityDaily > 0)
    lines.push(
      `Ritmo de ${number(m.velocityDaily, 2)} unidade(s) por dia (base ${m.velocityBasis === "90d" ? "90 dias" : "dias cobertos do ano"}).`,
    );
  if (m.coverageDays !== null && (m.stock.qty ?? 0) > 0)
    lines.push(
      `O saldo de ${number(m.stock.qty ?? 0)} cobre ${days(Math.round(m.coverageDays))} nesse ritmo.`,
    );
  if (m.turnoverAnnual !== null)
    lines.push(
      `Giro anual estimado de ${number(m.turnoverAnnual, 2)} (vendas anualizadas ÷ saldo atual).`,
    );
  if (m.trend60Pct !== null)
    lines.push(
      `Vendas dos últimos 60 dias ${m.trend60Pct >= 0 ? "+" : ""}${number(m.trend60Pct, 0)}% contra os 60 anteriores.`,
    );
  if (state === "novo" && m.arrivedOn)
    lines.push(`Chegada considerada em ${shortDate(m.arrivedOn)}.`);
  if (m.incompleteReason === "sales")
    lines.push(
      "As vendas no BIOMIE começam depois do início da janela de 12 meses: ausência de venda não é confirmada.",
    );
  if (m.incompleteReason === "product")
    lines.push("O produto é mais novo que a janela de 12 meses.");
  if (m.elsewhereCompany)
    lines.push(
      `A mesma SKU vendeu em ${m.elsewhereCompany}${m.elsewhereLastSale ? ` (${shortDate(m.elsewhereLastSale)})` : ""}.`,
    );
  if ((m.returns365.units ?? 0) > 0)
    lines.push(
      `${number(m.returns365.units ?? 0)} unidade(s) devolvida(s) em ${m.returns365.events} devolução(ões) no ano.`,
    );
  return lines;
}

const opt = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : decimal(value);

/** CSV da lista (o filtro inteiro, não a página). Sem permissão de custo, sem colunas de custo. */
export function intelCsv(rows: IntelProductRow[], viewCost: boolean): string {
  return csv([
    [
      "Empresa",
      "SKU",
      "Produto",
      "Família",
      "Estado",
      "Sinais",
      "Prioridade",
      "Curva (12 meses)",
      "Origem da curva",
      "Saldo",
      "Disponível",
      ...(viewCost ? ["CMC", "Capital"] : []),
      "Última venda",
      "Dias sem venda",
      "Faixa sem venda",
      "Cobertura (dias)",
      "Giro anual",
      "Tendência 60 dias (%)",
      "Unidades em 12 meses",
      ...(viewCost ? ["Faturamento em 12 meses"] : []),
    ],
    ...rows.map((r) => [
      r.companyName,
      r.sku ?? "",
      r.name ?? "",
      r.family ?? "",
      STATE_LABELS[r.state],
      r.flags.map(flagLabel).join(", "),
      opt(r.priority),
      r.curve ?? "",
      r.curveSource === "manual" ? "Manual" : r.curveSource === "auto" ? "Automática" : "",
      opt(r.qty),
      opt(r.available),
      ...(viewCost ? [opt(r.unitCost), opt(r.capital)] : []),
      r.lastSale ? shortDate(r.lastSale) : "",
      r.daysWithoutSale ?? "",
      BAND_LABELS[r.band],
      opt(r.coverageDays === null ? null : Math.round(r.coverageDays)),
      opt(r.turnoverAnnual),
      opt(r.trend60Pct),
      opt(r.units365),
      ...(viewCost ? [opt(r.revenue365)] : []),
    ]),
  ]);
}
