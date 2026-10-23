// src/estoque/api/intel-contract.ts — BIOMIE Intelligence (migração 0044).
// Resultados já calculados pelo motor (fora das requisições) e gravados no banco; a tela só lê.
// Valores ausentes chegam como null (custo desconhecido, histórico que não cobre o período,
// ou campo de custo/faturamento escondido de quem não pode vê-lo) — nunca como zero.
import type { ClassifiedCurve, CompanyFilter, Curve, CurveWindow } from "./contract";

export type IntelState =
  | "novo"
  | "historico_insuficiente"
  | "sem_venda_janela"
  | "baixo_giro"
  | "possivel_excesso"
  | "possivel_obsolescencia"
  | "saudavel"
  | "risco_ruptura"
  | "sem_saldo";

export type IntelBand = "0-30" | "31-60" | "61-90" | "91-180" | "181-365" | "365+" | "insuficiente";
export type IntelMinIdle = 30 | 60 | 90 | 180 | 365;
export type IntelSort = "priority" | "capital" | "daysWithoutSale" | "coverageDays" | "name";

export interface IntelRun {
  status: "running" | "published" | "failed" | "abandoned";
  asOf: string;
  startedAt: string;
  finishedAt: string | null;
  version: string;
  error: string | null; // só para o Super admin
}

export interface IntelStatus {
  enabled: boolean;
  lastRun: IntelRun | null;
  current: { companyId: string; runId: string; publishedAt: string; asOf: string }[];
}

export interface CurveCapital {
  products: number; // produtos com saldo positivo
  capital: number | null; // saldos positivos × custo; null sem permissão de custo
  unknownCost: number; // produtos com saldo e sem custo (fora do capital)
}

export interface IntelTopItem {
  companyId: string;
  omieProductId: string;
  productId: string | null;
  sku: string | null;
  name: string | null;
  curve: Curve | null;
  state: IntelState;
  flags: string[];
  priority: number | null;
  capital: number | null;
  daysWithoutSale: number | null;
  coverageDays: number | null;
}

export interface IntelOverview {
  window: CurveWindow;
  companies: string[];
  status: {
    enabled: boolean;
    runs: {
      companyId: string;
      companyName: string;
      asOf: string;
      publishedAt: string;
      version: string;
    }[];
    readings: { companyId: string; positionDate: string; readAt: string | null }[];
    salesFrom: string | null; // início do histórico de vendas no BIOMIE
  };
  capital: {
    total: number | null;
    byCurve: Record<Curve, CurveCapital>;
    cdShare: number | null; // 0–1
    negative: { positions: number; products: number; value: number | null };
  };
  states: { state: IntelState; products: number; capital: number | null }[];
  radar: { band: IntelBand; products: number; capital: number | null; newProducts: number }[];
  evolution: {
    day: string;
    capital: Partial<Record<ClassifiedCurve, number>> | null;
    products: Partial<Record<ClassifiedCurve, number>>;
  }[];
  top: IntelTopItem[];
}

export interface PriorityParts {
  capital: number;
  idle: number;
  coverage: number;
  trend: number;
  weights: { capital: number; idle: number; coverage: number; trend: number };
}

export interface IntelProductRow {
  companyId: string;
  companyName: string;
  omieProductId: string;
  productId: string | null;
  sku: string | null;
  name: string | null;
  family: string | null;
  curve: Curve | null; // curva de 12 meses no momento da análise
  curveSource: "auto" | "manual" | null;
  curveWorsened: boolean | null;
  qty: number | null;
  available: number | null;
  capital: number | null;
  unitCost: number | null;
  lastSale: string | null;
  daysWithoutSale: number | null;
  coverageDays: number | null;
  turnoverAnnual: number | null;
  trend60Pct: number | null;
  units365: number | null;
  revenue365: number | null;
  state: IntelState;
  flags: string[];
  band: IntelBand;
  priority: number | null;
  priorityParts: PriorityParts | null;
}

export interface IntelQuery {
  companyId: CompanyFilter;
  state?: IntelState | undefined;
  flag?: string | undefined;
  curve?: ClassifiedCurve | undefined;
  band?: IntelBand | undefined;
  minIdle?: IntelMinIdle | undefined;
  search?: string | undefined;
  sortBy?: IntelSort | undefined;
  sortDir?: "asc" | "desc" | undefined;
  page: number; // 50 por página; -1 = todas (exportação)
}

export interface SalesWindow {
  units: number | null; // null = período sem histórico de vendas no BIOMIE
  revenue?: number | null | undefined; // ausente sem permissão de custo
  invoices: number | null;
  coveredDays: number;
}

export interface IntelMetrics {
  stock: {
    qty: number | null;
    available: number | null;
    reserved: number | null;
    pending: number | null;
    minQty: number | null;
    locations: number | null;
    negativePositions: number;
    negativeValue?: number | null | undefined;
  };
  cost?:
    | { unitCost: number | null; known: boolean; suspect: boolean; divergentLocations: boolean }
    | undefined;
  capital?: number | null | undefined;
  salePrice?: number | null | undefined;
  sales: Record<"d30" | "d60" | "d90" | "d180" | "d365", SalesWindow>;
  velocityDaily: number | null;
  velocityBasis: "90d" | "365d" | null;
  coverageDays: number | null;
  turnoverAnnual: number | null;
  trend60Pct: number | null;
  avgPrice?: number | null | undefined;
  marginEstPct?: number | null | undefined;
  returns365: { units: number | null; events: number };
  lastSale: string | null;
  daysWithoutSale: number | null;
  idleSince: string | null;
  lastEntry: string | null;
  lastEntryOperation: string | null;
  lastExit: string | null;
  lastExitOperation: string | null;
  lastExitGroup: boolean;
  recentExit: boolean;
  arrivedOn: string | null;
  registeredAt: string | null;
  isNew: boolean;
  incompleteReason: "sales" | "product" | null;
  elsewhereCompany: string | null;
  elsewhereLastSale: string | null;
  curve: {
    current: Curve | null;
    source: "auto" | "manual" | null;
    previous: Curve | null;
    changedOn: string | null;
    worsened: boolean;
    revenue12m?: number | null | undefined;
    share12m: number | null;
  };
  salesMonthly: [string, number | null, (number | null)?][]; // [mês, unidades, faturamento?]
  historyCoveredDays: number;
}

export interface IntelProductDetail {
  companyId: string;
  companyName: string;
  omieProductId: string;
  productId: string | null;
  sku: string | null;
  name: string | null;
  family: string | null;
  state: IntelState;
  flags: string[];
  priority: number | null;
  priorityParts: PriorityParts | null;
  metrics: IntelMetrics;
  run: { asOf: string; publishedAt: string; version: string };
  curveHistory: { day: string; curve: ClassifiedCurve; source: string }[];
}

/** [posição, produto Omie, SKU, nome, faturamento, participação, acumulado, curva automática, curva manual] */
export type ParetoRow = [
  number,
  string,
  string | null,
  string,
  number,
  number,
  number,
  ClassifiedCurve,
  ClassifiedCurve | null,
];

export interface IntelPareto {
  window: CurveWindow;
  companyId: string;
  total: number;
  limits: [number, number]; // 80 e 95 (%)
  rows: ParetoRow[];
}

export interface IntelApi {
  status(): Promise<IntelStatus>;
  overview(companyId: CompanyFilter, window?: CurveWindow): Promise<IntelOverview>;
  products(query: IntelQuery): Promise<{ rows: IntelProductRow[]; total: number }>;
  product(companyId: string, omieProductId: string): Promise<IntelProductDetail | null>;
  pareto(companyId: string, window?: CurveWindow): Promise<IntelPareto>;
  /** Filtro inteiro em CSV (só com a permissão de exportar). */
  exportCsv(query: Omit<IntelQuery, "page">): Promise<{ fileName: string; csv: string }>;
}
