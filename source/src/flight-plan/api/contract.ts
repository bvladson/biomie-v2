// Contrato do Plano de Voo — 'Rota do Plano de Voo' (04/11/2026). As telas só conversam com o servidor por aqui.
// Extensões da integração (marcadas "integração"): só acréscimos, o protótipo continua compatível.
export type AppRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "DIRETORIA"
  | "GESTOR"
  | "VENDEDOR"
  | "FINANCEIRO"
  | "ANALISTA"
  | "VIEWER";
export type Channel = "varejo" | "licitacao";
export type TargetLevel = "BASE" | "ACTIVE" | "CHALLENGE";
export type FlightStatus = "ON_TRACK" | "ATTENTION" | "RISK" | "CRITICAL";
export type PeriodState = "future" | "current" | "closed";
export type Money = number; // reais, 2 casas

export interface PlanQuery {
  companyId: string;
  month: string /* AAAA-MM */;
  channel?: Channel;
  sellerId?: string;
  /** integração: demais filtros globais do BIOMIE (mudam realizado e carteira; a meta não é por UF/categoria). */
  branchId?: string;
  state?: string;
  city?: string;
  category?: string;
}
export interface Me {
  userId: string;
  name: string;
  roles: AppRole[];
  companyIds: string[];
  sellerId: string | null;
  managedSellerIds: string[];
}
export interface Company {
  id: string;
  slug: string;
  name: string;
  asOf: string;
  saturdayWeight: number;
  /** integração: id de cada canal da empresa (o filtro global de canal usa o id). */
  channels?: Partial<Record<Channel | "outros", string>>;
  isDemo?: boolean;
}
export interface Seller {
  id: string;
  companyId: string;
  name: string;
  channel: Channel;
  active: boolean;
}

// ---------- Painel, Velocidade e Visão geral ----------
export interface Metrics {
  target: Money | null;
  realized: Money;
  attainment: number | null;
  idealToday: Money | null;
  deviation: Money | null;
  remainingGap: Money | null;
  workdaysTotal: number;
  workdaysElapsed: number;
  workdaysRemaining: number;
  currentDailyPace: Money | null;
  requiredDailyPace: Money | null;
  gapUnreachable: boolean;
  runRateForecast: Money | null;
  forecastBase: Money | null;
  forecastProbable: Money | null;
  forecastCommit: Money | null;
  portfolio: Money;
  portfolioWeighted: Money;
  lateOrdersAmount: Money;
  gapCoverage: number | null;
  status: FlightStatus | null;
}
export interface CalendarDay {
  date: string;
  weight: number /* 1, peso do sábado ou 0 */;
  holiday: string | null;
}
export interface TimelinePoint {
  date: string;
  weight: number;
  revenue: Money | null;
  realizedCumulative: Money | null;
  idealCumulative: Money | null;
  projection: Money | null;
  forecast: Money | null;
  isToday: boolean;
}
export interface WeekPace {
  index: number;
  start: string;
  end: string;
  workdays: number;
  target: Money | null;
  realized: Money | null;
  previousMonthSameWeek: Money | null;
  status: FlightStatus | null;
  current: boolean;
}
export interface Comparison {
  previousMonthSameCut: Money;
  previousYearSameCut: Money;
  last3MonthsAvg: Money;
}
export interface Indicators {
  invoices: number;
  averageTicket: Money | null;
  customers: number;
  newCustomers: number;
  recurringCustomers: number;
  openQuotes: { count: number; amount: Money; avgAgeDays: number | null };
  conversion: {
    status: "forming" | "ready";
    since: string;
    quotes: number;
    converted: number;
    lost: number;
    rateCount: number | null;
    rateAmount: number | null;
  };
  comparison: Comparison;
}
export interface SellerRow {
  seller: Seller;
  targets: TargetSet;
  metrics: Metrics;
  hasActivity: boolean;
  productivity: {
    revenuePerWorkday: Money | null;
    invoicesPerWorkday: number | null;
    customers: number;
    averageTicket: Money | null;
  };
  openOrders: number;
  lateOrders: number;
  openQuotes: number;
  commit: { amount: Money; note: string | null; updatedAt: string } | null;
  comparison: Comparison;
}
export interface PeriodSummary {
  label: string;
  target: Money | null;
  realized: Money;
  attainment: number | null;
  requiredDailyPace: Money | null;
  workdaysRemaining: number;
}
/** integração: um mês do ano do plano, no mesmo escopo (canal/vendedor) da consulta. */
export interface PeriodMonthRow {
  month: string;
  target: Money | null;
  realized: Money;
  workdaysRemaining: number;
}
export interface FlightPlan {
  query: PlanQuery;
  period: { start: string; end: string; today: string; state: PeriodState };
  activeLevel: TargetLevel;
  targetSource: "company" | "sellers" | "none";
  calendarMissing: boolean;
  summary: Metrics;
  indicators: Indicators;
  calendar: CalendarDay[];
  timeline: TimelinePoint[];
  weeks: WeekPace[];
  quarter: PeriodSummary;
  year: PeriodSummary;
  /** integração: os 12 meses do ano (trimestre e ano sem uma leitura por mês). */
  months: PeriodMonthRow[];
  sellers: SellerRow[];
  reconciliation: { company: Money; sellers: Money; difference: Money; reason: string | null };
}

// ---------- Destino ----------
export interface TargetSet {
  BASE: Money | null;
  ACTIVE: Money | null;
  CHALLENGE: Money | null;
}
export interface TargetsMonth {
  companyId: string;
  month: string;
  activeLevel: TargetLevel;
  company: { channel: Channel | null /* null = empresa toda */; targets: TargetSet }[];
  sellers: {
    seller: Seller;
    targets: TargetSet;
    previousMonth: TargetSet;
    suggestion: Money | null;
    editable: boolean;
  }[];
  undistributed: TargetSet;
  canEditCompany: boolean;
  readOnlyReason: string | null;
}
export interface TargetChange {
  scope: "company" | "seller";
  channel?: Channel | null;
  sellerId?: string;
  level: TargetLevel;
  amount: Money | null;
}
export interface TargetPreview {
  created: number;
  updated: number;
  removed: number;
  rows: (TargetChange & { label: string; before: Money | null })[];
}
export interface YearMonthRow {
  month: string;
  target: Money | null;
  realized: Money;
  attainment: number | null;
  cumulativeTarget: Money | null;
  cumulativeRealized: Money;
  /** integração: dias úteis que ainda faltam no mês (0 nos meses encerrados). */
  workdaysRemaining?: number;
}

// ---------- Rota ----------
export type Lever =
  | "CONVERT_QUOTES"
  | "REACTIVATE_CUSTOMERS"
  | "EXPAND_MIX"
  | "PRODUCT_CAMPAIGN"
  | "PUBLIC_BIDS"
  | "PROSPECTING"
  | "OTHER";
export type InitiativeStatus = "PLANNED" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export type TargetListKind = "OPEN_QUOTES" | "INACTIVE_CUSTOMERS" | "LATE_ORDERS" | "IDLE_STOCK";
export interface Initiative {
  id: string;
  companyId: string;
  month: string;
  title: string;
  lever: Lever;
  /** integração: "user:<id>" (pessoa com acesso) ou "seller:<id>" (vendedor, com ou sem login). */
  ownerUserId: string;
  ownerName: string;
  sellerIds: string[];
  dueDate: string;
  expectedAmount: Money;
  realizedAmount: Money | null;
  status: InitiativeStatus;
  alertKey: string | null;
  targetListKind: TargetListKind | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
export type InitiativeInput = Omit<Initiative, "id" | "ownerName" | "createdAt" | "updatedAt"> & {
  id?: string;
};
export interface TargetList {
  kind: TargetListKind;
  title: string;
  /** Total da lista; `items` pode trazer só os maiores (ver `limit`). */
  count: number;
  amount: Money;
  /** integração: quantos itens no máximo vêm em `items` (os maiores primeiro). */
  limit?: number;
  items: {
    id: string;
    label: string;
    sellerId: string | null;
    amount: Money;
    ageDays: number | null;
    detail: string;
  }[];
}
export interface PlanCoverage {
  remainingGap: Money | null;
  plannedAmount: Money;
  coverage: number | null;
  uncovered: Money | null;
  open: number;
  late: number;
}

// ---------- Correção de rota ----------
export type AlertType =
  | "BELOW_FLIGHT_LINE"
  | "LOW_COVERAGE"
  | "PACE_ACCELERATION"
  | "GAP_UNREACHABLE"
  | "LATE_ORDERS"
  | "STALE_QUOTES"
  | "SELLER_IDLE"
  | "STATUS_WORSENED"
  | "NO_TARGET"
  | "NO_CALENDAR";
export type AlertState = "OPEN" | "ACKNOWLEDGED" | "ACTION_CREATED" | "RESOLVED";
export interface Alert {
  key: string;
  type: AlertType;
  priority: 1 | 2 | 3;
  sellerId: string | null;
  message: string;
  evidence: string;
  state: AlertState;
  reopened: boolean;
  initiativeId: string | null;
  note: string | null;
  updatedAt: string | null;
  /** integração: dia em que o alerta apareceu pela primeira vez (reunião semanal). */
  firstSeen?: string | null;
  /** integração: de quem é o alerta (vendedor ou o conjunto lido: empresa, canal ou equipe). */
  subject?: string;
}
export interface Snapshot {
  date: string;
  sellerId: string | null;
  target: Money | null;
  realized: Money;
  forecastProbable: Money | null;
  status: FlightStatus | null;
}
export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  realizedChange: Money;
  forecastChange: Money | null;
  statusChanges: { sellerId: string; from: FlightStatus | null; to: FlightStatus | null }[];
  newAlerts: Alert[];
  lateInitiatives: Initiative[];
  doneInitiatives: Initiative[];
  decisions: { id: string; at: string; authorName: string; text: string }[];
}

/** integração: histórico das alterações (audit_log). */
export type HistoryArea = "visao" | "destino" | "rota" | "correcao";
export interface HistoryEvent {
  id: string;
  at: string;
  author: string;
  area: HistoryArea;
  action: string;
  target: string;
  before: string | null;
  after: string | null;
}

export interface FlightPlanApi {
  me(): Promise<Me>;
  listCompanies(): Promise<Company[]>;
  listSellers(companyId: string): Promise<Seller[]>;
  getPlan(q: PlanQuery): Promise<FlightPlan>;
  getSnapshots(q: PlanQuery): Promise<Snapshot[]>;
  setCommit(
    q: PlanQuery & { sellerId: string },
    amount: Money | null,
    note: string | null,
  ): Promise<void>;
  getTargets(companyId: string, month: string): Promise<TargetsMonth>;
  previewTargets(companyId: string, month: string, changes: TargetChange[]): Promise<TargetPreview>;
  saveTargets(companyId: string, month: string, changes: TargetChange[]): Promise<TargetsMonth>;
  getYear(
    companyId: string,
    year: number,
    channel?: Channel,
    sellerId?: string,
  ): Promise<YearMonthRow[]>;
  listInitiatives(q: PlanQuery): Promise<{ rows: Initiative[]; coverage: PlanCoverage }>;
  saveInitiative(input: InitiativeInput): Promise<Initiative>;
  setInitiativeStatus(
    id: string,
    status: InitiativeStatus,
    realizedAmount: Money | null,
    note: string | null,
  ): Promise<Initiative>;
  getTargetLists(q: PlanQuery): Promise<TargetList[]>;
  listAlerts(q: PlanQuery): Promise<Alert[]>;
  setAlertState(
    key: string,
    state: AlertState,
    note: string | null,
    initiativeId?: string,
    /** integração: filtros da tela de onde o alerta saiu (para recalcular e conferir que ainda vale). */
    query?: PlanQuery,
  ): Promise<Alert>;
  getWeeklyReview(q: PlanQuery, weekStart: string): Promise<WeeklyReview>;
  addDecision(q: PlanQuery, weekStart: string, text: string): Promise<void>;
  /** integração */
  listHistory(companyId: string, area?: HistoryArea): Promise<HistoryEvent[]>;
}
