import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { parsePeriod, type AnalyticsQuery } from "@/domain/filters";
import {
  resolveConfig,
  type FlightPlanConfig,
  type TargetLevel,
} from "@/domain/flight-plan/config";
import {
  computeFlightPlan,
  computeTimeline,
  deriveActions,
  type ActionSuggestion,
  type DayInput,
  type FlightPlanMetrics,
  type PeriodState,
  type TimelinePoint,
} from "@/domain/flight-plan/engine";
import { bucketOrders } from "@/domain/flight-plan/order-weight";

type Client = SupabaseClient<Database>;
type ActionStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";

interface RawSeller {
  id: string;
  name: string;
  revenue: number;
  invoices: number;
  targets: Record<TargetLevel, number>;
  orders: { id: string; ageDays: number; expectedDate: string | null; total: number }[];
  commit: { amount: number; note: string | null; updatedAt: string } | null;
  comparisons: { previousMonth: number; previousYear: number; last3Avg: number };
}
interface RawDataset {
  period: { start: string; end: string; today: string; cut: string; state: PeriodState };
  isDemo: boolean;
  config: unknown;
  days: { date: string; working: boolean; revenue: number | null }[];
  companyComparisons: { previousMonth: number; previousYear: number; last3Avg: number };
  sellers: RawSeller[];
  actions: {
    id: string;
    sellerId: string | null;
    type: string;
    status: ActionStatus;
    createdAt: string;
    updatedAt: string;
    resolvedAt: string | null;
  }[];
}

export interface FlightPlanAction extends ActionSuggestion {
  key: string;
  sellerId: string | null;
  sellerName: string | null;
  status: ActionStatus;
  createdAt: string | null;
  resolvedAt: string | null;
}

export interface VendorRow {
  id: string;
  name: string;
  targets: Record<TargetLevel, number>;
  metrics: FlightPlanMetrics;
  invoices: number;
  orders: number;
  commitNote: string | null;
  comparisons: RawSeller["comparisons"];
}

export interface FlightPlanDTO {
  period: RawDataset["period"];
  isDemo: boolean;
  config: FlightPlanConfig;
  targets: Record<TargetLevel, number>;
  summary: FlightPlanMetrics;
  timeline: TimelinePoint[];
  vendors: VendorRow[];
  actions: FlightPlanAction[];
  comparisons: RawSeller["comparisons"];
  reconciliation: { company: number; sellers: number; difference: number };
}

const n = (v: unknown) => Number(v ?? 0);

async function fetchDataset(
  supabase: Client,
  q: AnalyticsQuery,
  asOf?: string,
): Promise<RawDataset> {
  const { year, month } = parsePeriod(q.period);
  const args = Object.fromEntries(
    Object.entries({
      p_company: q.company,
      p_year: year,
      p_month: month,
      p_channel: q.channel,
      p_branch: q.branch,
      p_seller: q.seller,
      p_state: q.state,
      p_city: q.city,
      p_category: q.category,
      p_as_of: asOf,
    }).filter(([, v]) => v !== undefined),
  ) as { p_company: string; p_year: number; p_month: number };
  const { data, error } = await supabase.rpc("flight_plan_dataset", args);
  if (error) {
    console.error("flight_plan_dataset failed", error);
    throw new Error(
      error.code === "42501"
        ? "Sem acesso a esta empresa."
        : "Não foi possível carregar o Plano de Voo.",
    );
  }
  const raw = data as unknown as RawDataset;
  raw.sellers = raw.sellers.map((s) => ({
    ...s,
    revenue: n(s.revenue),
    invoices: n(s.invoices),
    targets: {
      BASE: n(s.targets.BASE),
      ACTIVE: n(s.targets.ACTIVE),
      CHALLENGE: n(s.targets.CHALLENGE),
    },
    orders: (s.orders ?? []).map((o) => ({ ...o, ageDays: n(o.ageDays), total: n(o.total) })),
    commit: s.commit ? { ...s.commit, amount: n(s.commit.amount) } : null,
    comparisons: {
      previousMonth: n(s.comparisons.previousMonth),
      previousYear: n(s.comparisons.previousYear),
      last3Avg: n(s.comparisons.last3Avg),
    },
  }));
  raw.days = raw.days.map((d) => ({ ...d, revenue: d.revenue == null ? null : n(d.revenue) }));
  raw.companyComparisons = {
    previousMonth: n(raw.companyComparisons.previousMonth),
    previousYear: n(raw.companyComparisons.previousYear),
    last3Avg: n(raw.companyComparisons.last3Avg),
  };
  return raw;
}

function workingDays(days: DayInput[], today: string) {
  return {
    total: days.filter((d) => d.working).length,
    elapsed: days.filter((d) => d.working && d.date <= today).length,
  };
}

export async function buildFlightPlan(
  supabase: Client,
  q: AnalyticsQuery,
  asOf?: string,
): Promise<FlightPlanDTO> {
  const raw = await fetchDataset(supabase, q, asOf);
  const cfg = resolveConfig(raw.config);
  const level = cfg.activeLevel;
  const state = raw.period.state;
  const wd = workingDays(raw.days, raw.period.today);
  const companyRealized = raw.days.reduce((a, d) => a + (d.revenue ?? 0), 0);

  const buckets = new Map(raw.sellers.map((s) => [s.id, bucketOrders(s.orders, cfg)]));
  const bk = (s: RawSeller) => buckets.get(s.id)!;
  const vendors: VendorRow[] = raw.sellers.map((s) => ({
    id: s.id,
    name: s.name,
    targets: s.targets,
    invoices: s.invoices,
    orders: bk(s).orders,
    commitNote: s.commit?.note ?? null,
    comparisons: s.comparisons,
    metrics: computeFlightPlan(
      {
        target: s.targets[level],
        realized: s.revenue,
        workingDaysTotal: wd.total,
        workingDaysElapsed: wd.elapsed,
        periodState: state,
        portfolio: bk(s),
        commit: s.commit?.amount ?? null,
      },
      cfg,
    ),
  }));

  const sum = (f: (s: RawSeller) => number) => raw.sellers.reduce((a, s) => a + f(s), 0);
  const targets = {
    BASE: sum((s) => s.targets.BASE),
    ACTIVE: sum((s) => s.targets.ACTIVE),
    CHALLENGE: sum((s) => s.targets.CHALLENGE),
  };
  const commits = raw.sellers.filter((s) => s.commit);
  const summary = computeFlightPlan(
    {
      target: targets[level],
      realized: companyRealized,
      workingDaysTotal: wd.total,
      workingDaysElapsed: wd.elapsed,
      periodState: state,
      portfolio: {
        fresh: sum((s) => bk(s).fresh),
        recent: sum((s) => bk(s).recent),
        aged: sum((s) => bk(s).aged),
      },
      commit: commits.length ? commits.reduce((a, s) => a + s.commit!.amount, 0) : null,
    },
    cfg,
  );

  const stored = new Map(raw.actions.map((a) => [`${a.sellerId ?? "company"}:${a.type}`, a]));
  const actions: FlightPlanAction[] = [];
  const pushActions = (
    sellerId: string | null,
    sellerName: string | null,
    m: FlightPlanMetrics,
  ) => {
    for (const a of deriveActions(m, state, cfg)) {
      const key = `${sellerId ?? "company"}:${a.type}`;
      const st = stored.get(key);
      actions.push({
        ...a,
        key,
        sellerId,
        sellerName,
        status: st?.status ?? "OPEN",
        createdAt: st?.createdAt ?? null,
        resolvedAt: st?.resolvedAt ?? null,
      });
    }
  };
  if (!q.seller) pushActions(null, null, summary);
  for (const v of vendors) pushActions(v.id, v.name, v.metrics);
  actions.sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.status === "RESOLVED" ? 1 : 0) - (b.status === "RESOLVED" ? 1 : 0),
  );

  const sellersRealized = sum((s) => s.revenue);
  const dto: FlightPlanDTO = {
    period: raw.period,
    isDemo: raw.isDemo,
    config: cfg,
    targets,
    summary,
    timeline: computeTimeline(raw.days, summary, raw.period.today, state),
    vendors,
    actions,
    comparisons: raw.companyComparisons,
    reconciliation: {
      company: companyRealized,
      sellers: sellersRealized,
      difference: Math.round((companyRealized - sellersRealized) * 100) / 100,
    },
  };

  return dto;
}

/** Snapshot rows (company total + one per seller) for a computed plan. */
export function snapshotRows(companyId: string, period: string, dto: FlightPlanDTO) {
  const { year, month } = parsePeriod(period);
  const row = (sellerId: string | null, m: FlightPlanMetrics) => ({
    company_id: companyId,
    seller_id: sellerId,
    snapshot_date: dto.period.today,
    year,
    month,
    active_level: dto.config.activeLevel,
    target: m.target,
    realized: m.realized,
    ideal: m.idealToday,
    deviation: m.deviation,
    gap: m.remainingGap,
    current_pace: m.currentDailyPace,
    required_pace: m.requiredDailyPace,
    run_rate: m.runRateForecast,
    forecast_base: m.forecastBase,
    forecast_probable: m.forecastProbable,
    forecast_commit: m.forecastCommit,
    portfolio: m.portfolio,
    coverage: m.gapCoverage,
    status: m.status,
    working_days_elapsed: m.workingDaysElapsed,
    working_days_total: m.workingDaysTotal,
    updated_at: new Date().toISOString(),
  });
  return [row(null, dto.summary), ...dto.vendors.map((v) => row(v.id, v.metrics))];
}

export async function upsertCommit(
  supabase: Client,
  input: {
    company: string;
    seller: string;
    period: string;
    amount: number;
    note?: string | undefined;
  },
) {
  const { year, month } = parsePeriod(input.period);
  const { error } = await supabase.from("flight_plan_commits").upsert(
    {
      company_id: input.company,
      seller_id: input.seller,
      year,
      month,
      amount: input.amount,
      note: input.note ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id,seller_id,year,month" },
  );
  if (error) {
    console.error("commit failed", error);
    throw new Error(
      error.code === "42501"
        ? "Você não tem permissão para registrar commit."
        : "Não foi possível salvar o commit.",
    );
  }
  return { ok: true };
}

export async function setActionStatus(
  supabase: Client,
  input: {
    company: string;
    period: string;
    seller: string | null;
    type: string;
    priority: number;
    message: string;
    status: ActionStatus;
  },
) {
  const { year, month } = parsePeriod(input.period);
  const now = new Date().toISOString();
  const patch = {
    status: input.status,
    priority: input.priority,
    message: input.message,
    updated_at: now,
    resolved_at: input.status === "RESOLVED" ? now : null,
  };
  let upd = supabase
    .from("flight_plan_actions")
    .update(patch)
    .eq("company_id", input.company)
    .eq("year", year)
    .eq("month", month)
    .eq("type", input.type);
  upd = input.seller ? upd.eq("seller_id", input.seller) : upd.is("seller_id", null);
  const { data, error } = await upd.select("id");
  if (error) throw new Error("Não foi possível atualizar a ação.");
  if (!data?.length) {
    const { error: e2 } = await supabase.from("flight_plan_actions").insert({
      company_id: input.company,
      seller_id: input.seller,
      year,
      month,
      type: input.type,
      ...patch,
    });
    if (e2) {
      console.error("action insert failed", e2);
      throw new Error(
        e2.code === "42501"
          ? "Você não tem permissão para alterar ações."
          : "Não foi possível atualizar a ação.",
      );
    }
  }
  return { ok: true };
}
