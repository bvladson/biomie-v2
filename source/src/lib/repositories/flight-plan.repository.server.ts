/**
 * Plano de Voo no formato das telas que já existiam (Vendedores, Vendedor 360, Vendas) e da foto
 * diária. Os números saem do mesmo cálculo das abas do Plano de Voo (flight-plan-v2.repository):
 * peso do sábado por empresa, pedido vencido a 30%, meta da empresa quando existe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { parsePeriod, type AnalyticsQuery } from "@/domain/filters";
import type { FlightPlanConfig, TargetLevel } from "@/domain/flight-plan/config";
import {
  deriveActions,
  resolvePlanTarget,
  toLegacyMetrics,
  toLegacyTimeline,
  type ActionSuggestion,
  type FlightPlanMetrics,
  type LegacyTimelinePoint,
} from "@/domain/flight-plan/engine";
import type { PeriodState, PlanQuery, TargetSet } from "@/flight-plan/api/contract";
import { invalidateCompany, loadPlan, type LoadOptions } from "./flight-plan-v2.repository.server";

type Client = SupabaseClient<Database>;
type ActionStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";
const LEVELS: TargetLevel[] = ["BASE", "ACTIVE", "CHALLENGE"];

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
  comparisons: { previousMonth: number; previousYear: number; last3Avg: number };
}

export interface FlightPlanDTO {
  period: { start: string; end: string; today: string; cut: string; state: PeriodState };
  isDemo: boolean;
  config: FlightPlanConfig;
  targets: Record<TargetLevel, number>;
  summary: FlightPlanMetrics;
  timeline: LegacyTimelinePoint[];
  vendors: VendorRow[];
  actions: FlightPlanAction[];
  comparisons: VendorRow["comparisons"];
  reconciliation: { company: number; sellers: number; difference: number };
}

const zeroIfNull = (t: TargetSet): Record<TargetLevel, number> => ({
  BASE: t.BASE ?? 0,
  ACTIVE: t.ACTIVE ?? 0,
  CHALLENGE: t.CHALLENGE ?? 0,
});

export async function buildFlightPlan(
  supabase: Client,
  q: AnalyticsQuery,
  asOf?: string,
): Promise<FlightPlanDTO> {
  const query: PlanQuery = { companyId: q.company, month: q.period };
  if (q.seller) query.sellerId = q.seller;
  if (q.branch) query.branchId = q.branch;
  if (q.state) query.state = q.state;
  if (q.city) query.city = q.city;
  if (q.category) query.category = q.category;
  const opts: LoadOptions = {};
  if (asOf) opts.asOf = asOf;
  if (q.channel) opts.channelId = q.channel;
  const [{ plan, ctx }, stored] = await Promise.all([
    loadPlan(supabase, null, query, opts),
    storedActions(supabase, q),
  ]);
  const cfg = ctx.cfg;
  const state = plan.period.state;
  const byId = new Map(ctx.ds.sellers.map((s) => [s.id, s]));

  const vendors: VendorRow[] = plan.sellers.map((r) => ({
    id: r.seller.id,
    name: r.seller.name,
    targets: zeroIfNull(r.targets),
    metrics: toLegacyMetrics(r.metrics, state),
    invoices: byId.get(r.seller.id)?.invoices ?? 0,
    orders: r.openOrders,
    commitNote: r.commit?.note ?? null,
    comparisons: {
      previousMonth: r.comparison.previousMonthSameCut,
      previousYear: r.comparison.previousYearSameCut,
      last3Avg: r.comparison.last3MonthsAvg,
    },
  }));
  const planTargets = Object.fromEntries(
    LEVELS.map((l) => [
      l,
      resolvePlanTarget(ctx.monthTargets.company, ctx.monthTargets.sellers, l).target ?? 0,
    ]),
  ) as Record<TargetLevel, number>;
  const summary = toLegacyMetrics(plan.summary, state);

  const actions: FlightPlanAction[] = [];
  const push = (sellerId: string | null, sellerName: string | null, m: FlightPlanMetrics) => {
    for (const a of deriveActions(m, state, cfg)) {
      const key = `${sellerId ?? "company"}:${a.type}`;
      const st = stored.get(key);
      actions.push({
        ...a,
        key,
        sellerId,
        sellerName,
        status: st?.status ?? "OPEN",
        createdAt: st?.created_at ?? null,
        resolvedAt: st?.resolved_at ?? null,
      });
    }
  };
  if (!q.seller) push(null, null, summary);
  for (const v of vendors) push(v.id, v.name, v.metrics);
  actions.sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.status === "RESOLVED" ? 1 : 0) - (b.status === "RESOLVED" ? 1 : 0),
  );

  return {
    period: {
      start: plan.period.start,
      end: plan.period.end,
      today: plan.period.today,
      cut: plan.period.today < plan.period.end ? plan.period.today : plan.period.end,
      state,
    },
    isDemo: ctx.ds.company.isDemo,
    config: cfg,
    targets: planTargets,
    summary,
    timeline: toLegacyTimeline(plan.timeline),
    vendors,
    actions,
    comparisons: {
      previousMonth: plan.indicators.comparison.previousMonthSameCut,
      previousYear: plan.indicators.comparison.previousYearSameCut,
      last3Avg: plan.indicators.comparison.last3MonthsAvg,
    },
    reconciliation: {
      company: plan.reconciliation.company,
      sellers: plan.reconciliation.sellers,
      difference: plan.reconciliation.difference,
    },
  };
}

async function storedActions(supabase: Client, q: AnalyticsQuery) {
  const { year, month } = parsePeriod(q.period);
  const { data, error } = await supabase
    .from("flight_plan_actions")
    .select("seller_id,type,status,created_at,resolved_at")
    .eq("company_id", q.company)
    .eq("year", year)
    .eq("month", month);
  if (error) throw new Error("Não foi possível carregar o Plano de Voo.");
  return new Map(
    (data ?? []).map((a) => [
      `${a.seller_id ?? "company"}:${a.type}`,
      a as { status: ActionStatus; created_at: string | null; resolved_at: string | null },
    ]),
  );
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

/** Compromisso pela mesma função do banco das abas (regra de quem pode e auditoria). */
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
  const rpc = (
    supabase as unknown as {
      rpc: (
        n: string,
        a: Record<string, unknown>,
      ) => PromiseLike<{ error: { code?: string; message: string } | null }>;
    }
  ).rpc.bind(supabase);
  const { error } = await rpc("flight_plan_set_commit", {
    p_company: input.company,
    p_seller: input.seller,
    p_year: year,
    p_month: month,
    p_amount: input.amount,
    p_note: input.note ?? null,
  });
  if (error) {
    console.error("commit failed", error.code);
    throw new Error(
      error.code === "42501"
        ? "Você não tem permissão para registrar o compromisso deste vendedor."
        : error.code === "22023"
          ? error.message
          : "Não foi possível salvar o compromisso.",
    );
  }
  invalidateCompany(input.company);
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
