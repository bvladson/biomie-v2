/**
 * Plano de Voo — acesso ao banco com a sessão do usuário.
 * Leitura: flight_plan_v2_* (SECURITY INVOKER: a RLS decide o que cada um vê). Escrita: flight_plan_*
 * (quem pode e a auditoria ficam no banco, migração 0050). As contas ficam no motor
 * (src/domain/flight-plan/engine.ts) e as janelas de comparação em src/domain/comparison.ts; aqui só se
 * junta, traduz e entrega no formato do contrato (src/flight-plan/api/contract.ts).
 * Erros: só mensagens escritas pelas funções do Plano de Voo chegam à tela ("fp::mensagem").
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { comparisonRange } from "@/domain/comparison";
import {
  resolveConfig,
  saturdayWeightFor,
  type FlightPlanConfig,
} from "@/domain/flight-plan/config";
import {
  addDays,
  addMonths,
  diffDays,
  monthEnd,
  monthOf,
  quarterMonths,
  yearMonths,
} from "@/domain/flight-plan/dates";
import {
  buildCalendar,
  buildTimeline,
  buildWeeks,
  buildYearRows,
  classifyOrder,
  companyTargetSet,
  computeAlerts,
  computeMetrics,
  conversionStatus,
  dayWeight,
  emptyTargets,
  idleWorkdays,
  openQuotesSummary,
  periodSummaryOf,
  planCoverage,
  productivityOf,
  reconciliationOf,
  remainingWorkdays,
  resolvePlanTarget,
  round2,
  suggestion,
  undistributed,
  weeklyChange,
  type AlertSubject,
  type ComputedAlert,
  type ConversionFacts,
  type OpenOrder,
  type TargetRow,
  averageTicket,
} from "@/domain/flight-plan/engine";
import type {
  Alert,
  AlertState,
  AppRole,
  Channel,
  Company,
  FlightPlan,
  FlightStatus,
  HistoryArea,
  HistoryEvent,
  Initiative,
  InitiativeInput,
  InitiativeStatus,
  Lever,
  Me,
  Money,
  PeriodMonthRow,
  PeriodState,
  PlanCoverage,
  PlanQuery,
  Seller,
  SellerRow,
  Snapshot,
  TargetChange,
  TargetLevel,
  TargetList,
  TargetListKind,
  TargetPreview,
  TargetSet,
  TargetsMonth,
  WeeklyReview,
  YearMonthRow,
} from "@/flight-plan/api/contract";

type Db = SupabaseClient<Database>;
type DbError = { code?: string; message: string };
type Rpc = (
  name: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: DbError | null }>;

const GENERIC = "Não foi possível carregar o Plano de Voo. Tente de novo.";
const LEVELS: TargetLevel[] = ["BASE", "ACTIVE", "CHALLENGE"];

export function fpError(message: string): Error {
  return new Error(`fp::${message}`);
}

/** Mensagens das nossas funções (42501/22023) vão para a tela; o resto vira o texto genérico. */
function fromDb(error: DbError, fallback = GENERIC): Error {
  const own = !/^permission denied/i.test(error.message);
  if (own && error.code === "42501")
    return fpError(error.message === "forbidden" ? "Sem acesso a esta empresa." : error.message);
  if (own && error.code === "22023") return fpError(error.message);
  console.error(`[plano-de-voo] falha no banco code=${error.code ?? "?"}`);
  return fpError(fallback);
}

async function call<T>(db: Db, name: string, args?: Record<string, unknown>): Promise<T> {
  const rpc = (db as unknown as { rpc: Rpc }).rpc.bind(db);
  const { data, error } = await rpc(name, args);
  if (error) throw fromDb(error);
  return data as T;
}

/** Leitura de tabela fora dos tipos gerados (as tabelas novas da 0050). */
interface Rows<T> extends PromiseLike<{ data: T[] | null; error: DbError | null }> {
  eq(column: string, value: unknown): Rows<T>;
  in(column: string, values: unknown[]): Rows<T>;
  gte(column: string, value: unknown): Rows<T>;
  lte(column: string, value: unknown): Rows<T>;
  is(column: string, value: null): Rows<T>;
  order(column: string, options?: { ascending?: boolean }): Rows<T>;
  limit(n: number): Rows<T>;
}
function rows<T>(db: Db, table: string, columns: string): Rows<T> {
  return (db as unknown as { from: (t: string) => { select: (c: string) => Rows<T> } })
    .from(table)
    .select(columns);
}
async function all<T>(query: Rows<T>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw fromDb(error);
  return data ?? [];
}

// ---------- Cache curto (mesma consulta pedida por várias telas ao mesmo tempo) ----------
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > TTL_MS) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  return value;
}
/** Toda gravação limpa o que foi lido da empresa (para a tela mostrar o que acabou de mudar). */
export function invalidateCompany(companyId: string) {
  for (const k of cache.keys()) if (k.includes(`|${companyId}|`)) cache.delete(k);
}

// ---------- Leitura do mês ----------
type LevelMap = Partial<Record<TargetLevel, number>>;
interface DsSeller {
  id: string;
  name: string;
  active: boolean;
  channel: string;
  hasLogin: boolean;
  revenue: number;
  invoices: number;
  customers: number;
  lastInvoice: string | null;
  previousMonthSameCut: number;
  previousYearSameCut: number;
  last3MonthsAvg: number;
  targets: LevelMap;
  openOrders: number;
  openQuotes: number;
  commit: { amount: number; note: string | null; updatedAt: string } | null;
  statusLastMonday: FlightStatus | null;
}
interface DsCompanyTarget {
  month: number;
  channel: string | null;
  level: TargetLevel;
  amount: number;
}
interface Dataset {
  period: { start: string; end: string; today: string; state: PeriodState; lastMonday: string };
  config: unknown;
  company: { id: string; slug: string; name: string; isDemo: boolean };
  /** Nome do canal filtrado (inclusive os canais das empresas de demonstração). */
  channel: string | null;
  restricted: boolean;
  daily: { date: string; amount: number }[];
  previousDaily: { date: string; amount: number }[];
  months: { month: number; amount: number }[];
  totals: {
    invoices: number;
    customers: number;
    newCustomers: number;
    unassigned: number;
    previousMonthSameCut: number;
    previousYearSameCut: number;
    last3MonthsAvg: number;
  };
  sellers: DsSeller[];
  companyTargets: DsCompanyTarget[];
  sellerTargets: { month: number; level: TargetLevel; amount: number }[];
  orders: {
    id: string;
    number: string;
    sellerId: string | null;
    amount: number;
    openedAt: string;
    expectedDate: string | null;
  }[];
  quotes: {
    id: string;
    number: string;
    sellerId: string | null;
    amount: number;
    openedAt: string;
  }[];
  holidays: { date: string; name: string }[];
  holidayYears: Record<string, number>;
  lastMonday: { date: string | null; companyStatus: FlightStatus | null };
  conversion: ConversionFacts;
}

/** O que a montagem do plano deixa pronto para alertas, iniciativas e telas legadas. */
export interface PlanContext {
  ds: Dataset;
  cfg: FlightPlanConfig;
  saturdayWeight: number;
  holidays: Map<string, string>;
  orders: OpenOrder[];
  full: boolean;
  today: string;
  query: PlanQuery;
  /** Metas do mês da consulta: da empresa (no canal filtrado) e a soma dos vendedores do escopo. */
  monthTargets: { company: TargetSet; sellers: TargetSet };
}

export interface LoadOptions {
  /** Data de referência (a foto diária informa o dia que está fotografando). */
  asOf?: string;
  /** Canal pelo id do filtro global (telas legadas; aceita os canais das empresas de demonstração). */
  channelId?: string;
}

const toChannel = (name: string | null | undefined): Channel =>
  name === "licitacao" ? "licitacao" : "varejo";
const targetSet = (m: LevelMap | null | undefined): TargetSet => ({
  BASE: m?.BASE ?? null,
  ACTIVE: m?.ACTIVE ?? null,
  CHALLENGE: m?.CHALLENGE ?? null,
});
const hasExtraFilters = (q: PlanQuery) => !!(q.branchId || q.state || q.city || q.category);
const ym = (month: string) => ({
  year: Number(month.slice(0, 4)),
  month: Number(month.slice(5, 7)),
});

function filterArgs(q: PlanQuery, opts: LoadOptions = {}) {
  const a: Record<string, unknown> = {};
  if (opts.channelId) a["p_channel_id"] = opts.channelId;
  else if (q.channel) a["p_channel"] = q.channel;
  if (q.sellerId) a["p_seller"] = q.sellerId;
  if (q.branchId) a["p_branch"] = q.branchId;
  if (q.state) a["p_state"] = q.state;
  if (q.city) a["p_city"] = q.city;
  if (q.category) a["p_category"] = q.category;
  return a;
}

/** Marca curta e estável dos filtros extras (entra no assunto do alerta para não misturar recortes). */
function filterTag(q: PlanQuery) {
  if (!hasExtraFilters(q)) return "";
  const s = [q.branchId ?? "", q.state ?? "", q.city ?? "", q.category ?? ""].join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `~${h.toString(36)}`;
}

/** Assunto do conjunto lido: empresa (com ou sem canal), equipe de quem vê, ou o vendedor filtrado. */
function aggregateSubject(q: PlanQuery, full: boolean, userId: string | null) {
  const ch = q.channel ? `-${q.channel}` : "";
  const base = q.sellerId
    ? `filtro-${q.sellerId}`
    : full
      ? `empresa${ch}`
      : `escopo-${userId ?? "servidor"}${ch}`;
  return base + filterTag(q);
}

async function asOfFor(db: Db, userId: string | null, companyId: string): Promise<string> {
  const load = async () => {
    const d = await call<string>(db, "data_as_of", { p_company: companyId });
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw fpError(GENERIC);
    return d;
  };
  return userId ? cached(`asof|${userId}|${companyId}|`, load) : load();
}

function windowsFor(month: string, asOf: string) {
  const prev = comparisonRange("PREVIOUS_PERIOD", month, asOf);
  const ly = comparisonRange("SAME_PERIOD_LAST_YEAR", month, asOf);
  const t3 = comparisonRange("TRAILING_3_MONTH_AVERAGE", month, asOf);
  return {
    previous: { start: prev.start, end: prev.end },
    lastYear: { start: ly.start, end: ly.end },
    trailing3: { start: t3.start, end: t3.end, divisor: t3.divisor },
  };
}

export async function loadPlan(
  db: Db,
  userId: string | null,
  q: PlanQuery,
  opts: LoadOptions = {},
): Promise<{ plan: FlightPlan; ctx: PlanContext }> {
  const asOf = opts.asOf ?? (await asOfFor(db, userId, q.companyId));
  const load = async () => {
    const { year, month } = ym(q.month);
    const ds = await call<Dataset>(db, "flight_plan_v2_dataset", {
      p_company: q.companyId,
      p_year: year,
      p_month: month,
      p_windows: windowsFor(q.month, asOf),
      p_as_of: asOf,
      ...filterArgs(q, opts),
    });
    return assemble(ds, q);
  };
  // O cache é por usuário; sem usuário (telas legadas, foto diária) cada leitura vai ao banco.
  if (!userId) return load();
  return cached(
    `plan|${userId}|${q.companyId}|${JSON.stringify([q, opts.channelId ?? null, asOf])}`,
    load,
  );
}

function assemble(ds: Dataset, q: PlanQuery): { plan: FlightPlan; ctx: PlanContext } {
  const cfg = resolveConfig(ds.config);
  const level = cfg.activeLevel;
  const sat = saturdayWeightFor(cfg, ds.company.slug);
  const holidays = new Map(ds.holidays.map((h) => [h.date, h.name]));
  const today = ds.period.today;
  const month = q.month;
  const { year, month: mm } = ym(month);
  const end = monthEnd(month);
  const calendar = buildCalendar(month, sat, holidays);
  const prevCalendar = buildCalendar(addMonths(month, -1), sat, holidays);
  const full = !ds.restricted && !q.sellerId;

  const companyRows = (n: number): TargetRow[] =>
    ds.companyTargets
      .filter((r) => r.month === n)
      .map((r) => ({ channel: r.channel, level: r.level, amount: r.amount }));
  const sellersSum = (n: number): TargetSet => {
    const s = emptyTargets();
    for (const r of ds.sellerTargets.filter((x) => x.month === n))
      s[r.level] = round2((s[r.level] ?? 0) + r.amount);
    return s;
  };
  const channelName = q.channel ?? ds.channel ?? undefined;
  const companyOf = (n: number) =>
    full ? companyTargetSet(companyRows(n), channelName) : emptyTargets();
  const planTargetOf = (n: number) => resolvePlanTarget(companyOf(n), sellersSum(n), level);
  const { target, source } = planTargetOf(mm);

  const daily = new Map(ds.daily.map((d) => [d.date, d.amount]));
  const previousDaily = new Map(ds.previousDaily.map((d) => [d.date, d.amount]));
  const realized = round2(ds.daily.reduce((a, d) => a + d.amount, 0));
  const orders: OpenOrder[] = ds.orders.map((o) => ({
    id: o.id,
    sellerId: o.sellerId,
    customer: o.number,
    amount: o.amount,
    openedAt: o.openedAt,
    expectedDate: o.expectedDate,
  }));
  const commits = ds.sellers.flatMap((s) => (s.commit ? [s.commit.amount] : []));
  const summary = computeMetrics(
    { target, realized, calendar, today, month, orders, commits },
    cfg,
  );

  const sellers: SellerRow[] = ds.sellers.map((s) => {
    const targets = targetSet(s.targets);
    const own = orders.filter((o) => o.sellerId === s.id);
    const metrics = computeMetrics(
      {
        target: targets[level],
        realized: s.revenue,
        calendar,
        today,
        month,
        orders: own,
        commits: s.commit ? [s.commit.amount] : [],
      },
      cfg,
    );
    return {
      seller: {
        id: s.id,
        companyId: q.companyId,
        name: s.name,
        channel: toChannel(s.channel),
        active: s.active,
      },
      targets,
      metrics,
      hasActivity: targets[level] !== null || metrics.realized > 0 || own.length > 0,
      productivity: productivityOf(
        metrics.realized,
        s.invoices,
        s.customers,
        metrics.workdaysElapsed,
      ),
      openOrders: own.length,
      lateOrders: own.filter((o) => classifyOrder(o, today, end, cfg).late).length,
      openQuotes: s.openQuotes,
      commit: s.commit,
      comparison: {
        previousMonthSameCut: s.previousMonthSameCut,
        previousYearSameCut: s.previousYearSameCut,
        last3MonthsAvg: s.last3MonthsAvg,
      },
    };
  });

  const months: PeriodMonthRow[] = yearMonths(year).map((m, i) => ({
    month: m,
    target: planTargetOf(i + 1).target,
    realized:
      m > monthOf(today) ? 0 : round2(ds.months.find((x) => x.month === i + 1)?.amount ?? 0),
    workdaysRemaining: remainingWorkdays(buildCalendar(m, sat, holidays), m, today),
  }));
  const quarterLabel = `${Math.floor((mm - 1) / 3) + 1}º trimestre ${year}`;

  const plan: FlightPlan = {
    query: q,
    period: { start: ds.period.start, end: ds.period.end, today, state: ds.period.state },
    activeLevel: level,
    targetSource: source,
    calendarMissing: (ds.holidayYears[String(year)] ?? 0) === 0,
    summary,
    indicators: {
      invoices: ds.totals.invoices,
      averageTicket: averageTicket(summary.realized, ds.totals.invoices),
      customers: ds.totals.customers,
      newCustomers: ds.totals.newCustomers,
      recurringCustomers: ds.totals.customers - ds.totals.newCustomers,
      openQuotes: openQuotesSummary(ds.quotes, today),
      conversion: conversionStatus(ds.conversion, today, cfg),
      comparison: {
        previousMonthSameCut: ds.totals.previousMonthSameCut,
        previousYearSameCut: ds.totals.previousYearSameCut,
        last3MonthsAvg: ds.totals.last3MonthsAvg,
      },
    },
    calendar,
    timeline: buildTimeline(calendar, daily, summary, today),
    weeks: buildWeeks(calendar, daily, previousDaily, prevCalendar, summary.target, today, cfg),
    quarter: periodSummaryOf(
      quarterLabel,
      months.filter((r) => quarterMonths(month).includes(r.month)),
    ),
    year: periodSummaryOf(`Ano ${year}`, months),
    months,
    sellers,
    reconciliation: reconciliationOf(
      summary.realized,
      sellers.reduce((a, r) => a + r.metrics.realized, 0),
      ds.totals.unassigned,
    ),
  };
  return {
    plan,
    ctx: {
      ds,
      cfg,
      saturdayWeight: sat,
      holidays,
      orders,
      full,
      today,
      query: q,
      monthTargets: { company: companyOf(mm), sellers: sellersSum(mm) },
    },
  };
}

export async function getPlan(db: Db, userId: string, q: PlanQuery): Promise<FlightPlan> {
  return (await loadPlan(db, userId, q)).plan;
}

// ---------- Contexto do usuário ----------
interface MeRow {
  userId: string;
  name: string | null;
  roles: AppRole[];
  config: unknown;
  companies: {
    id: string;
    slug: string;
    name: string;
    isDemo: boolean;
    asOf: string;
    channels: Partial<Record<string, string>>;
  }[];
  sellerIds: string[];
  managedSellerIds: string[];
}

export async function bootstrap(db: Db): Promise<{ me: Me; companies: Company[] }> {
  const r = await call<MeRow>(db, "flight_plan_v2_me");
  const cfg = resolveConfig(r.config);
  const companies: Company[] = r.companies.map((c) => {
    const channels: Partial<Record<Channel | "outros", string>> = {};
    for (const k of ["varejo", "licitacao", "outros"] as const) {
      const id = c.channels[k];
      if (id) channels[k] = id;
    }
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      asOf: c.asOf,
      saturdayWeight: saturdayWeightFor(cfg, c.slug),
      channels,
      isDemo: c.isDemo,
    };
  });
  return {
    me: {
      userId: r.userId,
      name: r.name ?? "",
      roles: r.roles,
      companyIds: companies.map((c) => c.id),
      sellerId: r.sellerIds[0] ?? null,
      managedSellerIds: r.managedSellerIds,
    },
    companies,
  };
}

export async function listSellers(db: Db, companyId: string): Promise<Seller[]> {
  const data = await all(
    rows<{ id: string; name: string; active: boolean; channels: { name: string } | null }>(
      db,
      "sellers",
      "id,name,active,channels(name)",
    )
      .eq("company_id", companyId)
      .order("name"),
  );
  return data.map((s) => ({
    id: s.id,
    companyId,
    name: s.name,
    channel: toChannel(s.channels?.name?.toLowerCase()),
    active: s.active,
  }));
}

// ---------- Compromisso ----------
export async function setCommit(
  db: Db,
  q: PlanQuery & { sellerId: string },
  amount: Money | null,
  note: string | null,
) {
  const { year, month } = ym(q.month);
  await call(db, "flight_plan_set_commit", {
    p_company: q.companyId,
    p_seller: q.sellerId,
    p_year: year,
    p_month: month,
    p_amount: amount,
    p_note: note,
  });
  invalidateCompany(q.companyId);
}

// ---------- Destino ----------
interface TargetsRow {
  companyId: string;
  month: string;
  activeLevel: TargetLevel;
  canEditCompany: boolean;
  company: { varejo: LevelMap; licitacao: LevelMap; all: LevelMap };
  allSellers: LevelMap;
  sellers: {
    id: string;
    name: string;
    active: boolean;
    channel: string;
    editable: boolean;
    targets: LevelMap;
    previous: LevelMap;
    last3: { month: string; amount: number }[];
  }[];
}

function companyRowsOf(t: TargetsRow): TargetRow[] {
  const out: TargetRow[] = [];
  for (const [key, map] of [
    ["varejo", t.company.varejo],
    ["licitacao", t.company.licitacao],
    ["all", t.company.all],
  ] as const)
    for (const lvl of LEVELS) {
      const v = map[lvl];
      if (v !== undefined) out.push({ channel: key === "all" ? null : key, level: lvl, amount: v });
    }
  return out;
}

async function targetsRaw(db: Db, companyId: string, month: string) {
  const { year, month: m } = ym(month);
  return call<TargetsRow>(db, "flight_plan_targets_month", {
    p_company: companyId,
    p_year: year,
    p_month: m,
  });
}

function toTargetsMonth(t: TargetsRow, month: string): TargetsMonth {
  const last3Months = [1, 2, 3].map((n) => addMonths(month, -n));
  const company: TargetsMonth["company"] = [
    { channel: "varejo", targets: targetSet(t.company.varejo) },
    { channel: "licitacao", targets: targetSet(t.company.licitacao) },
  ];
  if (LEVELS.some((l) => t.company.all[l] !== undefined))
    company.push({ channel: null, targets: targetSet(t.company.all) });
  const sellers = t.sellers.map((s) => {
    const values = last3Months.map((m) => s.last3.find((x) => x.month === m)?.amount ?? 0);
    return {
      seller: {
        id: s.id,
        companyId: t.companyId,
        name: s.name,
        channel: toChannel(s.channel),
        active: s.active,
      },
      targets: targetSet(s.targets),
      previousMonth: targetSet(s.previous),
      suggestion: values.some((v) => v > 0) ? suggestion(values) : null,
      editable: s.editable,
    };
  });
  const anyEdit = t.canEditCompany || sellers.some((s) => s.editable);
  return {
    companyId: t.companyId,
    month: t.month,
    activeLevel: t.activeLevel,
    company,
    sellers,
    undistributed: undistributed(companyTargetSet(companyRowsOf(t)), targetSet(t.allSellers)),
    canEditCompany: t.canEditCompany,
    readOnlyReason: anyEdit ? null : "Somente leitura: metas são definidas pela gestão",
  };
}

export async function getTargets(db: Db, companyId: string, month: string): Promise<TargetsMonth> {
  return toTargetsMonth(await targetsRaw(db, companyId, month), month);
}

const COMPANY_LABEL: Record<string, string> = {
  varejo: "Empresa · Varejo",
  licitacao: "Empresa · Licitação",
  all: "Empresa",
};

export async function previewTargets(
  db: Db,
  companyId: string,
  month: string,
  changes: TargetChange[],
): Promise<TargetPreview> {
  const t = await targetsRaw(db, companyId, month);
  let created = 0;
  let updated = 0;
  let removed = 0;
  const out: TargetPreview["rows"] = [];
  for (const ch of changes) {
    let before: Money | null = null;
    let label = "Vendedor";
    if (ch.scope === "company") {
      const key = ch.channel ?? "all";
      before = t.company[key][ch.level] ?? null;
      label = COMPANY_LABEL[key] ?? "Empresa";
    } else {
      const s = t.sellers.find((x) => x.id === ch.sellerId);
      before = s?.targets[ch.level] ?? null;
      label = s?.name ?? "Vendedor";
    }
    if (before === ch.amount) continue;
    if (before === null) created++;
    else if (ch.amount === null) removed++;
    else updated++;
    out.push({ ...ch, label, before });
  }
  return { created, updated, removed, rows: out };
}

export async function saveTargets(
  db: Db,
  companyId: string,
  month: string,
  changes: TargetChange[],
): Promise<TargetsMonth> {
  const { year, month: m } = ym(month);
  await call(db, "flight_plan_save_targets", {
    p_company: companyId,
    p_year: year,
    p_month: m,
    p_changes: changes.map((c) => ({
      scope: c.scope,
      channel: c.channel ?? null,
      sellerId: c.sellerId ?? null,
      level: c.level,
      amount: c.amount,
    })),
  });
  invalidateCompany(companyId);
  return getTargets(db, companyId, month);
}

interface YearRow {
  today: string;
  restricted: boolean;
  config: unknown;
  company: { id: string; slug: string; name: string };
  months: { month: number; amount: number }[];
  companyTargets: DsCompanyTarget[];
  sellerTargets: { month: number; level: TargetLevel; amount: number }[];
  holidays: { date: string; name: string }[];
}

export async function getYear(
  db: Db,
  q: Omit<PlanQuery, "month"> & { year: number },
): Promise<YearMonthRow[]> {
  const r = await call<YearRow>(db, "flight_plan_v2_year", {
    p_company: q.companyId,
    p_year: q.year,
    ...filterArgs({ ...q, month: `${q.year}-01` }),
  });
  const cfg = resolveConfig(r.config);
  const level = cfg.activeLevel;
  const sat = saturdayWeightFor(cfg, r.company.slug);
  const holidays = new Map(r.holidays.map((h) => [h.date, h.name]));
  const full = !r.restricted && !q.sellerId;
  const months = yearMonths(q.year);
  const base = months.map((m, i) => {
    const n = i + 1;
    const sellers = emptyTargets();
    for (const x of r.sellerTargets.filter((y) => y.month === n))
      sellers[x.level] = round2((sellers[x.level] ?? 0) + x.amount);
    const company = full
      ? companyTargetSet(
          r.companyTargets
            .filter((x) => x.month === n)
            .map((x) => ({ channel: x.channel, level: x.level, amount: x.amount })),
          q.channel,
        )
      : emptyTargets();
    return {
      month: m,
      target: resolvePlanTarget(company, sellers, level).target,
      realized: m > monthOf(r.today) ? 0 : round2(r.months.find((x) => x.month === n)?.amount ?? 0),
    };
  });
  return buildYearRows(base).map((row, i) => ({
    ...row,
    workdaysRemaining: remainingWorkdays(
      buildCalendar(months[i]!, sat, holidays),
      months[i]!,
      r.today,
    ),
  }));
}

// ---------- Rota: iniciativas ----------
interface InitiativeDb {
  id: string;
  company_id: string;
  year: number;
  month: number;
  title: string;
  lever: Lever;
  owner_user_id: string | null;
  owner_seller_id: string | null;
  owner_name: string;
  seller_ids: string[];
  due_date: string;
  expected_amount: number | string;
  realized_amount: number | string | null;
  status: InitiativeStatus;
  alert_key: string | null;
  target_list_kind: TargetListKind | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
const INITIATIVE_COLUMNS =
  "id,company_id,year,month,title,lever,owner_user_id,owner_seller_id,owner_name,seller_ids,due_date," +
  "expected_amount,realized_amount,status,alert_key,target_list_kind,notes,created_at,updated_at";

function toInitiative(r: InitiativeDb): Initiative {
  return {
    id: r.id,
    companyId: r.company_id,
    month: `${r.year}-${String(r.month).padStart(2, "0")}`,
    title: r.title,
    lever: r.lever,
    ownerUserId: r.owner_user_id ? `user:${r.owner_user_id}` : `seller:${r.owner_seller_id ?? ""}`,
    ownerName: r.owner_name,
    sellerIds: r.seller_ids ?? [],
    dueDate: r.due_date,
    expectedAmount: Number(r.expected_amount),
    realizedAmount: r.realized_amount === null ? null : Number(r.realized_amount),
    status: r.status,
    alertKey: r.alert_key,
    targetListKind: r.target_list_kind,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function initiativeById(db: Db, id: string): Promise<Initiative> {
  const [r] = await all(
    rows<InitiativeDb>(db, "flight_plan_initiatives", INITIATIVE_COLUMNS).eq("id", id),
  );
  if (!r) throw fpError("Iniciativa não encontrada.");
  return toInitiative(r);
}

/** Iniciativas do mês no escopo da consulta (a RLS já limita ao que a pessoa pode ver). */
async function initiativesInScope(db: Db, userId: string | null, plan: FlightPlan, full: boolean) {
  const q = plan.query;
  const { year, month } = ym(q.month);
  const data = await all(
    rows<InitiativeDb>(db, "flight_plan_initiatives", INITIATIVE_COLUMNS)
      .eq("company_id", q.companyId)
      .eq("year", year)
      .eq("month", month)
      .order("due_date"),
  );
  const ids = new Set(plan.sellers.map((r) => r.seller.id));
  return data
    .map(toInitiative)
    .filter(
      (i) =>
        full ||
        i.sellerIds.some((id) => ids.has(id)) ||
        (i.ownerUserId.startsWith("seller:") && ids.has(i.ownerUserId.slice(7))) ||
        (userId !== null && i.ownerUserId === `user:${userId}`),
    );
}

const isLate = (i: Initiative, today: string) =>
  i.dueDate < today && i.status !== "DONE" && i.status !== "CANCELLED";
const plannedAmount = (list: Initiative[]) =>
  round2(
    list
      .filter((i) => i.status === "PLANNED" || i.status === "IN_PROGRESS")
      .reduce((s, i) => s + i.expectedAmount, 0),
  );

export async function listInitiatives(
  db: Db,
  userId: string,
  q: PlanQuery,
): Promise<{ rows: Initiative[]; coverage: PlanCoverage }> {
  const { plan, ctx } = await loadPlan(db, userId, q);
  const list = await initiativesInScope(db, userId, plan, ctx.full);
  const gap = plan.summary.remainingGap;
  const amount = plannedAmount(list);
  const cov = planCoverage(gap, amount);
  return {
    rows: list,
    coverage: {
      remainingGap: gap,
      plannedAmount: amount,
      coverage: cov.coverage,
      uncovered: cov.uncovered,
      open: list.filter((i) => i.status === "PLANNED" || i.status === "IN_PROGRESS").length,
      late: list.filter((i) => isLate(i, ctx.today)).length,
    },
  };
}

export async function saveInitiative(db: Db, input: InitiativeInput): Promise<Initiative> {
  const id = await call<string>(db, "flight_plan_save_initiative", { p_initiative: input });
  invalidateCompany(input.companyId);
  return initiativeById(db, id);
}

export async function setInitiativeStatus(
  db: Db,
  id: string,
  status: InitiativeStatus,
  realizedAmount: Money | null,
  note: string | null,
): Promise<Initiative> {
  await call(db, "flight_plan_set_initiative_status", {
    p_id: id,
    p_status: status,
    p_realized: realizedAmount,
    p_note: note,
  });
  const i = await initiativeById(db, id);
  invalidateCompany(i.companyId);
  return i;
}

// ---------- Rota: listas de alvos ----------
interface ListsRow {
  today: string;
  limit: number;
  inactiveDays: number;
  lookbackDays: number;
  quotes: {
    count: number;
    amount: number;
    items: {
      id: string;
      number: string;
      sellerId: string | null;
      seller: string | null;
      customer: string | null;
      amount: number;
      openedAt: string;
    }[];
  };
  lateOrders: {
    count: number;
    amount: number;
    items: {
      id: string;
      number: string;
      sellerId: string | null;
      seller: string | null;
      customer: string | null;
      amount: number;
      expectedDate: string;
    }[];
  };
  inactiveCustomers: {
    count: number;
    amount: number;
    items: {
      id: string;
      customer: string | null;
      sellerId: string | null;
      seller: string | null;
      amount: number;
      lastPurchase: string;
    }[];
  };
}
const br = (iso: string) => iso.split("-").reverse().join("/");

export async function getTargetLists(db: Db, q: PlanQuery): Promise<TargetList[]> {
  const r = await call<ListsRow>(db, "flight_plan_v2_target_lists", {
    p_company: q.companyId,
    ...filterArgs(q),
  });
  return [
    {
      kind: "OPEN_QUOTES",
      title: "Orçamentos em aberto",
      count: r.quotes.count,
      amount: r.quotes.amount,
      limit: r.limit,
      items: r.quotes.items.map((x) => ({
        id: x.id,
        label: `${x.number} · ${x.customer ?? "Cliente"}`,
        sellerId: x.sellerId,
        amount: x.amount,
        ageDays: diffDays(r.today, x.openedAt),
        detail: x.seller ?? "Sem vendedor",
      })),
    },
    {
      kind: "INACTIVE_CUSTOMERS",
      title: `Clientes há mais de ${r.inactiveDays} dias sem comprar (compraram nos últimos ${Math.round(r.lookbackDays / 30)} meses)`,
      count: r.inactiveCustomers.count,
      amount: r.inactiveCustomers.amount,
      limit: r.limit,
      items: r.inactiveCustomers.items.map((x) => ({
        id: x.id,
        label: x.customer ?? "Cliente",
        sellerId: x.sellerId,
        amount: x.amount,
        ageDays: diffDays(r.today, x.lastPurchase),
        detail: `Última compra ${br(x.lastPurchase)} · ${x.seller ?? "Sem vendedor"}`,
      })),
    },
    {
      kind: "LATE_ORDERS",
      title: "Pedidos com previsão de faturamento vencida",
      count: r.lateOrders.count,
      amount: r.lateOrders.amount,
      limit: r.limit,
      items: r.lateOrders.items.map((x) => ({
        id: x.id,
        label: `${x.number} · ${x.customer ?? "Cliente"}`,
        sellerId: x.sellerId,
        amount: x.amount,
        ageDays: diffDays(r.today, x.expectedDate),
        detail: `Previsto para ${br(x.expectedDate)} · ${x.seller ?? "Sem vendedor"}`,
      })),
    },
    // Estoque parado: a análise oficial (com custo só para quem pode ver) fica em Estoque › Inteligência.
    {
      kind: "IDLE_STOCK",
      title: "Produtos parados no estoque",
      count: 0,
      amount: 0,
      limit: 0,
      items: [],
    },
  ];
}

// ---------- Correção de rota: alertas ----------
interface StateRow {
  key: string;
  state: AlertState;
  reopened: boolean;
  note: string | null;
  initiativeId: string | null;
  updatedAt: string | null;
  firstSeen: string | null;
}

function subjectsOf(
  plan: FlightPlan,
  ctx: PlanContext,
  planned: Money,
): { subjects: AlertSubject[]; aggregate: boolean } {
  const q = ctx.query;
  const current = plan.period.state === "current";
  const level = ctx.cfg.activeLevel;
  const weightOf = (d: string) => dayWeight(d, ctx.saturdayWeight, ctx.holidays);
  const end = monthEnd(q.month);
  const subjects: AlertSubject[] = [];
  const aggregate = !q.sellerId;
  if (aggregate)
    subjects.push({
      sellerId: null,
      name: ctx.ds.company.name,
      metrics: plan.summary,
      hasTarget: plan.summary.target !== null,
      plannedAmount: planned,
      lateOrders: current
        ? ctx.orders
            .filter((o) => classifyOrder(o, ctx.today, end, ctx.cfg).late)
            .map((o) => ({ amount: o.amount, overdueDays: diffDays(ctx.today, o.expectedDate!) }))
        : [],
      staleQuotes: [],
      idleWorkdays: null,
      statusLastMonday:
        current && ctx.full && !q.channel && !hasExtraFilters(q)
          ? ctx.ds.lastMonday.companyStatus
          : null,
    });
  const byId = new Map(ctx.ds.sellers.map((s) => [s.id, s]));
  for (const r of plan.sellers.filter((x) => x.hasActivity)) {
    const s = byId.get(r.seller.id);
    subjects.push({
      sellerId: r.seller.id,
      name: r.seller.name,
      metrics: r.metrics,
      hasTarget: r.targets[level] !== null,
      plannedAmount: 0,
      lateOrders: [],
      staleQuotes: current
        ? ctx.ds.quotes
            .filter((x) => x.sellerId === r.seller.id)
            .map((x) => ({ amount: x.amount, ageDays: diffDays(ctx.today, x.openedAt) }))
        : [],
      idleWorkdays: current ? idleWorkdays(s?.lastInvoice ?? null, ctx.today, weightOf) : null,
      statusLastMonday: current && !hasExtraFilters(q) ? (s?.statusLastMonday ?? null) : null,
    });
  }
  return { subjects, aggregate };
}

async function computeAndSync(db: Db, userId: string | null, q: PlanQuery, opts: LoadOptions = {}) {
  const { plan, ctx } = await loadPlan(db, userId, q, opts);
  const initiatives = await initiativesInScope(db, userId, plan, ctx.full);
  const { subjects } = subjectsOf(plan, ctx, plannedAmount(initiatives));
  const year = Number(q.month.slice(0, 4));
  const yearHas = (y: number) => (ctx.ds.holidayYears[String(y)] ?? 0) > 0;
  const agg = aggregateSubject(q, ctx.full, userId);
  const computed: ComputedAlert[] = computeAlerts(
    {
      companyId: q.companyId,
      month: q.month,
      noTarget: plan.targetSource === "none",
      calendarMissingYear: !yearHas(year) ? year : !yearHas(year + 1) ? year + 1 : null,
      aggregateSubject: agg,
    },
    subjects,
    ctx.cfg,
  );
  const { year: y, month: m } = ym(q.month);
  const states = await call<StateRow[]>(db, "flight_plan_sync_alerts", {
    p_company: q.companyId,
    p_year: y,
    p_month: m,
    p_subjects: [agg, ...subjects.flatMap((s) => (s.sellerId ? [s.sellerId] : []))],
    p_alerts: computed.map((a) => ({
      key: a.key,
      subject: a.subject,
      sellerId: a.sellerId,
      priority: a.priority,
      message: a.message.slice(0, 300),
      evidence: a.evidence.slice(0, 500),
    })),
  });
  const byKey = new Map(states.map((s) => [s.key, s]));
  const alerts: Alert[] = computed.map((a) => {
    const st = byKey.get(a.key);
    return {
      ...a,
      state: st?.state ?? "OPEN",
      reopened: st?.reopened ?? false,
      initiativeId: st?.initiativeId ?? null,
      note: st?.note ?? null,
      updatedAt: st?.updatedAt ?? null,
      firstSeen: st?.firstSeen ?? null,
    };
  });
  return { plan, ctx, alerts, initiatives };
}

export async function listAlerts(db: Db, userId: string, q: PlanQuery): Promise<Alert[]> {
  return (await computeAndSync(db, userId, q)).alerts;
}

/** Foto diária: registra a presença dos alertas da empresa inteira (o "sumiu e voltou" do Resolvido). */
export async function syncCompanyAlerts(db: Db, companyId: string, month: string, asOf: string) {
  await computeAndSync(db, null, { companyId, month }, { asOf });
}

/** Consulta de onde o alerta saiu, a partir da chave (quando a tela não manda os filtros). */
function queryFromKey(key: string): PlanQuery {
  const parts = key.split(":");
  if (parts.length !== 4) throw fpError("Alerta inválido.");
  const [, companyId, subject, month] = parts as [string, string, string, string];
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fpError("Alerta inválido.");
  if (subject.includes("~"))
    throw fpError("Abra o alerta com os mesmos filtros para mudar o estado.");
  const q: PlanQuery = { companyId, month };
  const ch = /-(varejo|licitacao)$/.exec(subject);
  if (ch && (subject.startsWith("empresa") || subject.startsWith("escopo-")))
    q.channel = ch[1] as Channel;
  if (subject.startsWith("filtro-")) q.sellerId = subject.slice(7);
  return q;
}

export async function setAlertState(
  db: Db,
  userId: string,
  key: string,
  state: AlertState,
  note: string | null,
  initiativeId: string | undefined,
  query: PlanQuery | undefined,
): Promise<Alert> {
  const q = query ?? queryFromKey(key);
  const { alerts } = await computeAndSync(db, userId, q);
  const current = alerts.find((a) => a.key === key);
  if (!current) throw fpError("Alerta não está mais ativo.");
  const row = await call<StateRow>(db, "flight_plan_set_alert_state", {
    p_alert: {
      companyId: q.companyId,
      key,
      subject: current.subject ?? "empresa",
      month: q.month,
      sellerId: current.sellerId,
      state,
      note,
      initiativeId: initiativeId ?? null,
      priority: current.priority,
      message: current.message.slice(0, 300),
      evidence: current.evidence.slice(0, 500),
    },
  });
  invalidateCompany(q.companyId);
  return {
    ...current,
    state: row.state,
    reopened: row.reopened,
    note: row.note,
    initiativeId: row.initiativeId,
    updatedAt: row.updatedAt,
    firstSeen: row.firstSeen,
  };
}

// ---------- Correção de rota: evolução e reunião semanal ----------
interface SnapshotDb {
  snapshot_date: string;
  seller_id: string | null;
  target: number | string;
  realized: number | string;
  forecast_probable: number | string | null;
  status: FlightStatus | null;
}
const toSnapshot = (r: SnapshotDb): Snapshot => ({
  date: r.snapshot_date,
  sellerId: r.seller_id,
  target: Number(r.target) > 0 ? Number(r.target) : null,
  realized: Number(r.realized),
  forecastProbable: r.forecast_probable === null ? null : Number(r.forecast_probable),
  status: r.status,
});

async function snapshotRows(
  db: Db,
  companyId: string,
  from: string,
  to: string,
  sellerId?: string | null,
) {
  let query = rows<SnapshotDb>(
    db,
    "flight_plan_snapshots",
    "snapshot_date,seller_id,target,realized,forecast_probable,status",
  )
    .eq("company_id", companyId)
    .gte("snapshot_date", from)
    .lte("snapshot_date", to);
  if (sellerId === null) query = query.is("seller_id", null);
  else if (sellerId) query = query.eq("seller_id", sellerId);
  return (await all(query.order("snapshot_date"))).map(toSnapshot);
}

export async function getSnapshots(db: Db, userId: string, q: PlanQuery): Promise<Snapshot[]> {
  // As fotos são da empresa inteira e de cada vendedor: com canal ou filtros extras não há o que comparar.
  if (q.channel || hasExtraFilters(q)) return [];
  const asOf = await asOfFor(db, userId, q.companyId);
  return snapshotRows(db, q.companyId, addDays(asOf, -120), asOf, q.sellerId ?? null);
}

interface DecisionDb {
  id: string;
  week_start: string;
  body: string;
  author_name: string | null;
  created_at: string;
}

export async function getWeeklyReview(
  db: Db,
  userId: string,
  q: PlanQuery,
  weekStart: string,
): Promise<WeeklyReview> {
  const asOf = await asOfFor(db, userId, q.companyId);
  const weekEnd = addDays(weekStart, 6);
  const cut = weekEnd < asOf ? weekEnd : asOf;
  const qm: PlanQuery = { ...q, month: monthOf(cut) };
  const prevWeek = addDays(weekStart, -7);
  const filtered = !!q.channel || hasExtraFilters(q);
  const [{ plan, ctx, alerts, initiatives }, snaps, decisions] = await Promise.all([
    computeAndSync(db, userId, qm),
    filtered
      ? Promise.resolve([] as Snapshot[])
      : snapshotRows(db, q.companyId, addDays(weekStart, -7), cut),
    all(
      rows<DecisionDb>(db, "flight_plan_decisions", "id,week_start,body,author_name,created_at")
        .eq("company_id", q.companyId)
        .in("week_start", [weekStart, prevWeek])
        .order("created_at"),
    ),
  ]);
  const subject = q.sellerId ?? null;
  const at = (d: string, sellerId: string | null) =>
    [...snaps].reverse().find((s) => s.date <= d && s.sellerId === sellerId) ?? null;
  const change = weeklyChange(at(weekStart, subject), at(cut, subject));
  const level = ctx.cfg.activeLevel;
  const statusChanges = plan.sellers
    .filter((r) => r.targets[level] !== null)
    .flatMap((r) => {
      const from = at(weekStart, r.seller.id)?.status ?? null;
      const to = at(cut, r.seller.id)?.status ?? null;
      return from !== to ? [{ sellerId: r.seller.id, from, to }] : [];
    });
  return {
    weekStart,
    weekEnd,
    realizedChange: change.realizedChange,
    forecastChange: change.forecastChange,
    statusChanges,
    newAlerts: alerts.filter(
      (a) => !!a.firstSeen && a.firstSeen >= weekStart && a.firstSeen <= weekEnd,
    ),
    lateInitiatives: initiatives.filter((i) => isLate(i, cut)),
    doneInitiatives: initiatives.filter(
      (i) =>
        i.status === "DONE" &&
        i.updatedAt.slice(0, 10) >= weekStart &&
        i.updatedAt.slice(0, 10) <= weekEnd,
    ),
    decisions: decisions.map((d) => ({
      id: d.id,
      at: d.created_at,
      authorName: d.author_name ?? "—",
      text: d.week_start === prevWeek ? `(semana anterior) ${d.body}` : d.body,
    })),
  };
}

export async function addDecision(db: Db, q: PlanQuery, weekStart: string, text: string) {
  await call(db, "flight_plan_add_decision", {
    p_company: q.companyId,
    p_week: weekStart,
    p_text: text,
  });
  invalidateCompany(q.companyId);
}

// ---------- Histórico ----------
interface HistoryDb {
  id: string;
  at: string;
  action: string;
  area: HistoryArea | null;
  label: string | null;
  month: string | null;
  level: TargetLevel | null;
  before: unknown;
  after: unknown;
  author: string;
}
const ACTION_PT: Record<string, string> = {
  "flight_plan.target.created": "Meta criada",
  "flight_plan.target.updated": "Meta alterada",
  "flight_plan.target.removed": "Meta removida",
  "flight_plan.commit.saved": "Compromisso registrado",
  "flight_plan.commit.removed": "Compromisso removido",
  "flight_plan.initiative.created": "Iniciativa criada",
  "flight_plan.initiative.updated": "Iniciativa alterada",
  "flight_plan.initiative.status": "Status da iniciativa",
  "flight_plan.alert.state": "Estado do alerta",
  "flight_plan.decision.created": "Decisão registrada",
};
const LEVEL_PT: Record<TargetLevel, string> = {
  BASE: "Base",
  ACTIVE: "Ativa",
  CHALLENGE: "Desafio",
};
const STATE_PT: Record<string, string> = {
  OPEN: "Aberto",
  ACKNOWLEDGED: "Ciente",
  ACTION_CREATED: "Ação criada",
  RESOLVED: "Resolvido",
  PLANNED: "Planejada",
  IN_PROGRESS: "Em andamento",
  DONE: "Concluída",
  CANCELLED: "Cancelada",
};
const money = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
function show(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return money(v);
  const s = String(v);
  return STATE_PT[s] ?? s;
}

export async function listHistory(
  db: Db,
  companyId: string,
  area?: HistoryArea,
): Promise<HistoryEvent[]> {
  const data = await call<HistoryDb[]>(db, "flight_plan_history", {
    p_company: companyId,
    p_area: area ?? null,
    p_limit: 100,
  });
  return data.map((e) => ({
    id: e.id,
    at: e.at,
    author: e.author,
    area: e.area ?? "visao",
    action: ACTION_PT[e.action] ?? e.action,
    target: [e.label, e.level ? LEVEL_PT[e.level] : null, e.month].filter(Boolean).join(" · "),
    before: show(e.before),
    after: show(e.after),
  }));
}
