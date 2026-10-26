/**
 * Inteligência do Estoque, fases 3 a 5 — rótulos, formatos e montagem dos gráficos (puro, testável).
 * Os números vêm do que o motor gravou; aqui não se estima nada novo, só se arruma para a tela. A
 * única conta é o saldo semana a semana a partir das movimentações, que é aritmética (saldo atual −
 * entradas + saídas depois de cada semana) e some quando os dados não fecham.
 */
import type {
  ForecastModel,
  ForecastQuality,
  ForecastStatus,
  IntelEvidence,
  IntelForecast,
  IntelProductDetail,
  IntelSeverity,
  ReplenishmentRow,
  ReplenishmentStatus,
} from "../api/intel-contract";
import { shortDate } from "./curves";
import { csv, decimal, money, quantity } from "./format";
import { STATE_LABELS } from "./intel";

export const SEVERITY_ORDER: IntelSeverity[] = ["alta", "media", "baixa", "info"];
export const SEVERITY_LABELS: Record<IntelSeverity, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
  info: "Informação",
};
/** Mesmos tons dos estados (cor sempre com ícone e rótulo). */
export const SEVERITY_TONE: Record<IntelSeverity, "critical" | "serious" | "warning" | "neutral"> =
  {
    alta: "critical",
    media: "serious",
    baixa: "warning",
    info: "neutral",
  };

export const REC_LABELS: Record<string, string> = {
  comprar: "Comprar",
  avaliar_reposicao: "Avaliar reposição",
  rever_compras: "Rever compras",
  recuperar_capital: "Recuperar capital",
  nao_comprar: "Não comprar agora",
  conferir_saldo: "Conferir saldo no Omie",
  conferir_custo: "Conferir custo no Omie",
  verificar_minimo: "Verificar o mínimo",
};
export const recLabel = (type: string) => REC_LABELS[type] ?? type;
/** Recomendações oferecidas como filtro da lista (conferir custo só para quem vê custo). */
export const REC_FILTERS = [
  "comprar",
  "avaliar_reposicao",
  "nao_comprar",
  "recuperar_capital",
  "rever_compras",
  "conferir_saldo",
  "verificar_minimo",
  "conferir_custo",
];

export const ALERT_LABELS: Record<string, string> = {
  queda_abrupta_vendas: "Queda abrupta de vendas",
  entrada_acima_da_demanda: "Entrada acima da demanda",
  custo_mudou: "Custo mudou",
  custo_divergente_locais: "Custo muito diferente entre locais",
  saldo_negativo: "Saldo negativo",
  custo_acima_do_preco: "Custo acima do preço de venda",
  parou_de_vender: "Parou de vender",
  curva_caiu_dois_niveis: "Curva caiu dois níveis",
  faturamento_divergente: "Faturamento da curva diferente das vendas",
};
export const alertLabel = (kind: string) => ALERT_LABELS[kind] ?? kind;

export const FORECAST_STATUS_LABELS: Record<ForecastStatus, string> = {
  ok: "Previsão disponível",
  novo: "Produto novo",
  insuficiente: "Histórico insuficiente para previsão confiável",
  sem_vendas: "Sem vendas no histórico",
  sem_vendas_prolongadas: "Sem vendas nas últimas 26 semanas",
};
export const QUALITY_LABELS: Record<ForecastQuality, string> = {
  boa: "Boa",
  regular: "Regular",
  fraca: "Fraca",
  nao_avaliavel: "Não avaliável",
};
/** Rótulo da qualidade com a regra (é um rótulo das métricas do teste, não probabilidade). */
export const QUALITY_RULE =
  "Boa: erro do teste de até 30% do vendido; regular: até 60%; fraca: acima disso.";
export const MODEL_LABELS: Record<ForecastModel, string> = {
  media_13s: "Média das últimas 13 semanas",
  media_total: "Média do histórico",
  ses: "Suavização exponencial simples",
  croston: "Croston (demanda intermitente)",
  sba: "Croston com correção de Syntetos–Boylan",
  tsb: "Teunter–Syntetos–Babai",
};
export const DEMAND_CLASS_LABELS: Record<string, string> = {
  frequente: "Frequente",
  intermitente: "Intermitente",
  irregular: "Irregular",
  esporadica: "Esporádica",
};

export const REPLENISHMENT_LABELS: Record<ReplenishmentStatus, string> = {
  comprar: "Comprar",
  nao_comprar: "Não comprar agora",
  aguardar: "Sem compra neste ciclo",
  sem_prazo: "Sem prazo de reposição",
  sem_previsao: "Sem previsão confiável",
  sem_demanda: "Sem demanda prevista",
};

const isIsoDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
const number = (n: number, digits = 2) =>
  n.toLocaleString("pt-BR", { maximumFractionDigits: digits });

/** Valor de uma evidência com a unidade: R$ em moeda, datas em dd/mm/aaaa, nulo como "—". */
export function evidenceValue(e: IntelEvidence): string {
  const v = e.value;
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "string") return isIsoDate(v) ? shortDate(v) : v;
  switch (e.unit) {
    case "R$":
      return money(v);
    case "%":
      return `${number(v, 1)}%`;
    case "dias":
      return v === 1 ? "1 dia" : `${number(v, 0)} dias`;
    case "un.":
      return `${quantity(v)} un.`;
    default:
      return e.unit ? `${number(v)} ${e.unit}` : number(v);
  }
}

/** Rótulo da faixa de previsão (deixa claro que é a faixa dos erros do teste, não confiança calibrada). */
const one = (v: number) => quantity(Math.round(v * 10) / 10);

export function forecastRange(h: { units: number; low?: number; high?: number }): string {
  if (h.low === undefined || h.high === undefined) return `${one(h.units)} un.`;
  return `${one(h.units)} un. (faixa ${one(h.low)} a ${one(h.high)})`;
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface ForecastPoint {
  weekEnd: string;
  label: string;
  actual: number | null;
  fitted: number | null;
  forecast: number | null;
}

/** Semanas observadas (vendido e o que o modelo previa uma semana antes) + 13 semanas à frente. */
export function forecastRows(f: IntelForecast, ahead = 13): ForecastPoint[] {
  const actual = f.series.actual;
  const fitted = f.series.fitted ?? [];
  const end = f.series.weekEnd;
  const n = actual.length;
  const rows: ForecastPoint[] = actual.map((v, i) => {
    const weekEnd = addDays(end, -7 * (n - 1 - i));
    return {
      weekEnd,
      label: shortDate(weekEnd).slice(0, 5),
      actual: v,
      fitted: fitted[i] ?? null,
      forecast: null,
    };
  });
  if (f.status === "ok" && f.weeklyRate !== undefined) {
    // a linha da previsão sai do último ponto observado para não ficar solta no gráfico
    const last = rows[rows.length - 1];
    if (last) last.forecast = last.actual;
    for (let k = 1; k <= ahead; k++) {
      const weekEnd = addDays(end, 7 * k);
      rows.push({
        weekEnd,
        label: shortDate(weekEnd).slice(0, 5),
        actual: null,
        fitted: null,
        forecast: f.weeklyRate,
      });
    }
  }
  return rows;
}

export interface MovementWeek {
  weekEnd: string;
  label: string;
  purchases: number;
  sales: number;
  other: number;
  stock: number | null;
}

/**
 * Movimentações por semana (terminando na data da análise) e o saldo no fim de cada semana estimado a
 * partir do saldo atual. O saldo só aparece quando as movimentações cobrem o período e nunca dão saldo
 * negativo impossível (diferença de até 0,5 un. é arredondamento); senão fica nulo e a tela avisa.
 */
export function movementWeeks(
  movements: NonNullable<IntelProductDetail["movements"]>,
  asOf: string,
  qtyNow: number | null,
  weeks = 26,
): { rows: MovementWeek[]; stockConsistent: boolean } {
  const rows: MovementWeek[] = [];
  const net: number[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const weekEnd = addDays(asOf, -7 * w);
    rows.push({
      weekEnd,
      label: shortDate(weekEnd).slice(0, 5),
      purchases: 0,
      sales: 0,
      other: 0,
      stock: null,
    });
    net.push(0);
  }
  const start = addDays(asOf, -7 * weeks + 1);
  for (const [day, inQty, outQty, purchase, sale] of movements.days) {
    if (day < start || day > asOf) continue;
    const diff = Math.round(
      (Date.parse(`${asOf}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000,
    );
    const index = weeks - 1 - Math.floor(diff / 7);
    const row = rows[index];
    if (!row) continue;
    row.purchases += purchase ?? 0;
    row.sales += sale ?? 0;
    row.other += Math.max((inQty ?? 0) + (outQty ?? 0) - (purchase ?? 0) - (sale ?? 0), 0);
    net[index] = (net[index] ?? 0) + (inQty ?? 0) - (outQty ?? 0);
  }
  const covered = movements.from !== null && movements.from <= start;
  let consistent = covered && qtyNow !== null;
  if (consistent) {
    let level = qtyNow as number;
    for (let i = rows.length - 1; i >= 0; i--) {
      rows[i]!.stock = Math.round(level * 1000) / 1000;
      if (level < -0.5) consistent = false;
      level -= net[i] ?? 0;
    }
  }
  if (!consistent) for (const r of rows) r.stock = null;
  return { rows, stockConsistent: consistent };
}

const opt = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : decimal(value);

/** CSV da reposição (o filtro inteiro). Sem permissão de custo, sem a coluna de custo estimado. */
export function replenishmentCsv(rows: ReplenishmentRow[], viewCost: boolean): string {
  return csv([
    [
      "Empresa",
      "SKU",
      "Produto",
      "Família",
      "Estado",
      "Curva",
      "Situação",
      "Quantidade sugerida",
      ...(viewCost ? ["Custo estimado"] : []),
      "Disponível",
      "Pendente",
      "Demanda prevista (un./dia)",
      "Prazo de reposição (dias)",
      "Origem do prazo",
      "Nível de serviço",
      "Estoque de segurança",
      "Ponto de reposição",
      "Estoque alvo",
      "Cobertura (dias)",
      "Qualidade da previsão",
      "Risco de não comprar",
      "Explicação",
    ],
    ...rows.map((r) => [
      r.companyName,
      r.sku ?? "",
      r.name ?? "",
      r.family ?? "",
      STATE_LABELS[r.state],
      r.curve ?? "",
      REPLENISHMENT_LABELS[r.status],
      opt(r.qty),
      ...(viewCost ? [opt(r.costEstimate)] : []),
      opt(r.available),
      opt(r.pending),
      opt(r.dailyDemand),
      r.leadTimeDays ?? "",
      r.paramsSource ?? "",
      r.serviceLevel === undefined ? "" : `${Math.round(r.serviceLevel * 100)}%`,
      opt(r.safetyStock),
      opt(r.reorderPoint),
      opt(r.target),
      opt(r.coverageDays),
      r.forecastQuality ? QUALITY_LABELS[r.forecastQuality] : "",
      r.risk ?? "",
      r.explanation ?? r.message ?? "",
    ]),
  ]);
}
