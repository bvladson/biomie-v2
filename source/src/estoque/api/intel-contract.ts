// src/estoque/api/intel-contract.ts — BIOMIE Intelligence (migrações 0044, 0045, 0047 e 0048).
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
  unknownCost: number | null; // produtos com saldo e sem custo (fora do capital); null sem permissão de custo
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
  /** Fase 3: o diagnóstico e a ação mais importantes (sem itens de custo para quem não vê custo). */
  diagnosis?: { code: string; title: string; severity: IntelSeverity; text: string } | null;
  action?: { type: string; action: string } | null;
  alerts?: number;
  /** Fase 4: previsão de 30 dias (só com status "ok") e a qualidade no teste histórico. */
  forecast?: {
    status: ForecastStatus | null;
    units30: number | null;
    quality: ForecastQuality | null;
  };
}

export interface IntelQuery {
  companyId: CompanyFilter;
  state?: IntelState | undefined;
  flag?: string | undefined;
  curve?: ClassifiedCurve | undefined;
  band?: IntelBand | undefined;
  minIdle?: IntelMinIdle | undefined;
  search?: string | undefined;
  /** Fase 3: só produtos com esta recomendação / com alerta aberto. */
  rec?: string | undefined;
  withAlerts?: boolean | undefined;
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
    | {
        unitCost: number | null;
        known: boolean;
        suspect: boolean;
        divergentLocations: boolean;
        minUnitCost?: number | null;
        prevUnitCost?: number | null;
      }
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
  prev60Units?: number | null;
  received30?: number | null;
  received90?: number | null;
  diagnoses?: IntelDiagnosis[];
  recommendations?: IntelRecommendation[];
  alerts?: IntelAlertItem[];
  forecast?: IntelForecast;
  replenishment?: IntelReplenishment | Record<string, never>;
}

// ---------------------------------------------------------------- fase 3: diagnóstico e alertas

export type IntelSeverity = "alta" | "media" | "baixa" | "info";

/** Indicador que sustenta um item: valor e unidade como o motor gravou ("cost" só para quem vê custo). */
export interface IntelEvidence {
  key: string;
  label: string;
  value: number | string | boolean | null;
  unit?: string;
  cost?: boolean;
}

export interface IntelDiagnosis {
  rule: string;
  code: string;
  severity: IntelSeverity;
  title: string;
  text: string;
  evidence: IntelEvidence[];
  period?: string;
  requiresCost?: boolean;
}

export interface IntelRecommendation {
  rule: string;
  type: string;
  action: string;
  why: string;
  evidence: IntelEvidence[];
  limitations: string[];
  requiresCost?: boolean;
}

/** Alerta como o motor detectou nesta análise (o histórico fica em IntelAlert). */
export interface IntelAlertItem {
  rule: string;
  kind: string;
  severity: IntelSeverity;
  reason: string;
  evidence: IntelEvidence[];
  requiresCost?: boolean;
}

/** Alerta guardado entre análises: novo, mudou de gravidade, ciência, resolvido. */
export interface IntelAlert {
  id: string;
  companyId: string;
  companyName?: string;
  omieProductId: string;
  sku?: string | null;
  name?: string | null;
  curve?: Curve | null;
  kind: string;
  rule: string;
  severity: IntelSeverity;
  status: "open" | "resolved";
  reason: string;
  evidence: IntelEvidence[];
  firstSeenAt: string;
  lastSeenAt: string;
  changedAt: string;
  resolvedAt: string | null;
  isNew: boolean;
  changed: boolean;
  acknowledged: { at: string; note: string | null; by: string } | null;
}

export interface IntelAlertQuery {
  companyId: CompanyFilter;
  status?: "open" | "resolved" | "all" | undefined;
  severity?: IntelSeverity | undefined;
  kind?: string | undefined;
  onlyNew?: boolean | undefined;
  search?: string | undefined;
  omieProductId?: string | undefined;
  page: number;
}

export interface IntelAlertSummary {
  open: number;
  alta: number;
  media: number;
  baixa: number;
  info: number;
  new: number;
  changed: number;
  acknowledged: number;
}

// ---------------------------------------------------------------- fase 4: previsão

export type ForecastStatus =
  "ok" | "novo" | "insuficiente" | "sem_vendas" | "sem_vendas_prolongadas";
export type ForecastQuality = "boa" | "regular" | "fraca" | "nao_avaliavel";
export type ForecastModel = "media_13s" | "media_total" | "ses" | "croston" | "sba" | "tsb";

export interface ForecastHorizon {
  units: number;
  low?: number;
  high?: number;
  wape: number | null;
  origins: number;
}

export interface IntelForecast {
  status: ForecastStatus;
  message: string | null;
  version: string;
  computedFor: string;
  weeks: number;
  nonzeroWeeks: number;
  trainFrom: string | null;
  trainTo: string | null;
  demandClass: "frequente" | "intermitente" | "irregular" | "esporadica" | null;
  adi: number | null;
  cv2: number | null;
  seasonality: "nao_avaliavel" | "nao_calculada";
  limitations: string[];
  series: { weekEnd: string; actual: number[]; fitted?: (number | null)[] };
  model?: ForecastModel;
  modelLabel?: string;
  weeklyRate?: number;
  weeklyStd?: number;
  dailyRate?: number;
  horizons?: Record<"30" | "60" | "90", ForecastHorizon>;
  intervalBasis?: string | null;
  backtest?: {
    origins: number;
    horizonWeeks: number;
    mae: number;
    wape: number | null;
    bias: number | null;
    skillVsBase: number | null;
    quality: ForecastQuality;
    models: Record<ForecastModel, number>;
  };
}

// ---------------------------------------------------------------- fase 5: reposição e grupo

export type ReplenishmentStatus =
  "comprar" | "nao_comprar" | "aguardar" | "sem_prazo" | "sem_previsao" | "sem_demanda";

export interface IntelReplenishment {
  status: ReplenishmentStatus;
  message?: string;
  leadTimeDays?: number;
  reviewDays?: number;
  serviceLevel?: number;
  paramsSource?: "empresa" | "familia" | "produto";
  minLot?: number | null;
  maxCoverageDays?: number | null;
  dailyDemand?: number;
  safetyStock?: number;
  reorderPoint?: number;
  reorderFromOmieMin?: boolean;
  position?: number;
  target?: number;
  coverageDays?: number;
  model?: ForecastModel;
  forecastQuality?: ForecastQuality;
  qty?: number;
  costEstimate?: number | null; // ausente sem permissão de custo
  risk?: string;
  explanation?: string;
  evidence?: IntelEvidence[];
  limitations?: string[];
}

export interface ReplenishmentRow extends IntelReplenishment {
  companyId: string;
  companyName: string;
  omieProductId: string;
  sku: string | null;
  name: string | null;
  family: string | null;
  curve: Curve | null;
  state: IntelState;
  available: number | null;
  pending: number | null;
}

export interface ReplenishmentSummary {
  comprar: number;
  naoComprar: number;
  aguardar: number;
  semPrazo: number;
  semPrevisao: number;
  semDemanda: number;
  costEstimate: number | null;
  costEstimateMissing: number;
}

export interface ReplenishmentQuery {
  companyId: CompanyFilter;
  status?: ReplenishmentStatus | "all" | undefined;
  search?: string | undefined;
  page: number;
}

export type ParamScope = "empresa" | "familia" | "produto";
export const SERVICE_LEVELS = [0.8, 0.85, 0.9, 0.95, 0.97, 0.98, 0.99] as const;
export type ServiceLevel = (typeof SERVICE_LEVELS)[number];

export interface ReplenishmentParam {
  companyId: string;
  companyName: string;
  scope: ParamScope;
  key: string;
  productName: string | null;
  sku: string | null;
  leadTimeDays: number;
  reviewDays: number;
  serviceLevel: number;
  minLot: number | null;
  maxCoverageDays: number | null;
  reason: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ReplenishmentParamInput {
  companyId: string;
  scope: ParamScope;
  key: string;
  values: {
    leadTimeDays: number;
    reviewDays?: number | undefined;
    serviceLevel?: ServiceLevel | undefined;
    minLot?: number | null | undefined;
    maxCoverageDays?: number | null | undefined;
  } | null; // null = remover
  reason: string;
}

export interface Opportunity {
  sku: string;
  name: string | null;
  qty: number;
  fromCompanyId: string;
  fromCompanyName: string;
  fromOmie: string;
  toCompanyId: string;
  toCompanyName: string;
  toOmie: string;
  from: {
    available: number;
    state: IntelState;
    idleDays: number | null;
    dailyDemand: number | null;
  };
  to: { available: number; pending: number; dailyDemand: number; coverageDays: number };
  valueAtCost?: number | null; // ausente sem permissão de custo
  reason: string;
  note: string;
  horizonDays: number;
}

export interface OpportunityQuery {
  companyId: CompanyFilter;
  omieProductId?: string | undefined;
  search?: string | undefined;
  page: number;
}

/** [empresa, produto Omie, preço médio vendido em 12 meses, unidades em 12 meses] */
export type PriceBasisRow = [string, string, number, number | null];

/** Ponto da matriz risco × impacto: [empresa, produto Omie, SKU, nome, capital, prioridade, estado, curva] */
export type MatrixPoint = [
  string,
  string,
  string | null,
  string | null,
  number,
  number,
  IntelState,
  Curve | null,
];

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
  /** Fase 3: alertas do produto (abertos e resolvidos nos últimos 90 dias). */
  alerts?: IntelAlert[];
  /** Movimentações por dia: [dia, entradas, saídas, compras/produção, vendas] (só quantidades). */
  movements?: {
    from: string | null;
    days: [string, number | null, number | null, number | null, number | null][];
  };
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
  // fase 3
  alerts(
    query: IntelAlertQuery,
  ): Promise<{ rows: IntelAlert[]; total: number; summary: IntelAlertSummary }>;
  ackAlert(alertId: string, note: string | null): Promise<{ acknowledged: boolean }>;
  // fase 5
  replenishment(
    query: ReplenishmentQuery,
  ): Promise<{ rows: ReplenishmentRow[]; total: number; summary: ReplenishmentSummary }>;
  exportReplenishmentCsv(
    query: Omit<ReplenishmentQuery, "page">,
  ): Promise<{ fileName: string; csv: string }>;
  replenishmentParams(
    companyId: CompanyFilter,
  ): Promise<{ canEdit: boolean; serviceLevels: number[]; rows: ReplenishmentParam[] }>;
  setReplenishment(input: ReplenishmentParamInput): Promise<{ saved?: boolean; removed?: boolean }>;
  opportunities(
    query: OpportunityQuery,
  ): Promise<{ rows: Opportunity[]; total: number; note: string }>;
  priceBasis(companyId: CompanyFilter): Promise<{ asOf: string | null; prices: PriceBasisRow[] }>;
  /** Matriz risco × impacto (só com custo): os produtos de maior prioridade com capital. */
  matrix(companyId: CompanyFilter): Promise<{ points: MatrixPoint[]; total: number }>;
}
