/**
 * FlightPlanEngine — the ONLY place Flight Plan formulas live.
 * Pure, deterministic functions over raw facts returned by the read model.
 *
 * Conventions:
 * - Working days elapsed INCLUDE today when today is a working day.
 * - Remaining = total − elapsed.
 * - Closed period: elapsed = total, forecasts collapse to realized.
 * - Future period: nothing realized yet; only target and required pace.
 */
import { formatValue } from "@/domain/format";
import type { FlightPlanConfig, FlightStatus } from "./config";

export type PeriodState = "future" | "current" | "closed";

export interface PortfolioBuckets {
  fresh: number;
  recent: number;
  aged: number;
}

export interface FlightPlanInput {
  target: number;
  realized: number;
  workingDaysTotal: number;
  workingDaysElapsed: number;
  periodState: PeriodState;
  portfolio: PortfolioBuckets;
  commit: number | null;
}

export interface FlightPlanMetrics {
  target: number;
  realized: number;
  attainment: number | null;
  idealToday: number | null;
  deviation: number | null;
  remainingGap: number;
  workingDaysTotal: number;
  workingDaysElapsed: number;
  workingDaysRemaining: number;
  currentDailyPace: number | null;
  requiredDailyPace: number | null;
  /** Gap > 0 and no working days left. */
  gapUnreachable: boolean;
  runRateForecast: number | null;
  forecastBase: number | null;
  forecastProbable: number | null;
  forecastCommit: number | null;
  portfolio: number;
  portfolioWeighted: number;
  gapCoverage: number | null;
  /** Ratio used for status (realized/ideal, or realized/target when closed). */
  paceIndex: number | null;
  status: FlightStatus | null;
}

const div = (a: number, b: number): number | null => (b ? a / b : null);

export function statusFor(ratio: number | null, cfg: FlightPlanConfig): FlightStatus | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio >= cfg.status.onTrack) return "ON_TRACK";
  if (ratio >= cfg.status.attention) return "ATTENTION";
  if (ratio >= cfg.status.risk) return "RISK";
  return "CRITICAL";
}

export function weightedPortfolio(p: PortfolioBuckets, cfg: FlightPlanConfig): number {
  const w = cfg.probableWeights;
  return p.fresh * w.fresh + p.recent * w.recent + p.aged * w.aged;
}

export function computeFlightPlan(
  input: FlightPlanInput,
  cfg: FlightPlanConfig,
): FlightPlanMetrics {
  const target = Math.max(input.target, 0);
  const total = Math.max(input.workingDaysTotal, 0);
  const state = input.periodState;
  const realized = state === "future" ? 0 : input.realized;
  const elapsed =
    state === "closed"
      ? total
      : state === "future"
        ? 0
        : Math.min(Math.max(input.workingDaysElapsed, 0), total);
  const remaining = Math.max(total - elapsed, 0);

  const portfolioTotal = input.portfolio.fresh + input.portfolio.recent + input.portfolio.aged;
  const weighted = weightedPortfolio(input.portfolio, cfg);

  const attainment = div(realized, target);
  const idealToday = target > 0 && total > 0 ? (target * elapsed) / total : target > 0 ? 0 : null;
  const deviation = idealToday == null ? null : realized - idealToday;
  const remainingGap = Math.max(target - realized, 0);
  const currentDailyPace = elapsed > 0 ? realized / elapsed : null;
  const requiredDailyPace =
    remaining > 0 ? remainingGap / remaining : remainingGap === 0 ? 0 : null;
  const gapUnreachable = remainingGap > 0 && remaining === 0;

  let runRate: number | null;
  let forecastBase: number | null;
  let forecastProbable: number | null;
  if (state === "closed") {
    runRate = forecastBase = forecastProbable = realized;
  } else if (state === "future") {
    runRate = null;
    forecastBase = input.portfolio.fresh;
    forecastProbable = weighted;
  } else {
    runRate = currentDailyPace == null ? null : currentDailyPace * total;
    forecastBase = realized + input.portfolio.fresh;
    forecastProbable = realized + weighted;
  }

  const relevantPortfolio = state === "closed" ? 0 : weighted;
  const gapCoverage =
    state === "closed" || remainingGap === 0 ? null : relevantPortfolio / remainingGap;

  let paceIndex: number | null;
  if (target <= 0) paceIndex = null;
  else if (state === "closed") paceIndex = realized / target;
  else if (state === "future" || elapsed === 0) paceIndex = null;
  else paceIndex = idealToday ? realized / idealToday : null;

  return {
    target,
    realized,
    attainment,
    idealToday,
    deviation,
    remainingGap,
    workingDaysTotal: total,
    workingDaysElapsed: elapsed,
    workingDaysRemaining: remaining,
    currentDailyPace,
    requiredDailyPace,
    gapUnreachable,
    runRateForecast: runRate,
    forecastBase,
    forecastProbable,
    forecastCommit: input.commit,
    portfolio: portfolioTotal,
    portfolioWeighted: weighted,
    gapCoverage,
    paceIndex,
    status: statusFor(paceIndex, cfg),
  };
}

// ---------- Timeline ----------

export interface DayInput {
  date: string;
  working: boolean;
  revenue: number | null;
}

export interface TimelinePoint {
  date: string;
  working: boolean;
  revenue: number | null;
  realizedCumulative: number | null;
  idealCumulative: number;
  /** Run-rate projection from today to month end (null before today). */
  projection: number | null;
  /** Straight line from today's realized to Forecast Provável. */
  forecast: number | null;
  isToday: boolean;
}

export function computeTimeline(
  days: DayInput[],
  m: FlightPlanMetrics,
  today: string,
  state: PeriodState,
): TimelinePoint[] {
  const total = m.workingDaysTotal;
  let wdCum = 0;
  let cum = 0;
  const lastRealIdx = days.reduce((acc, d, i) => (d.revenue != null ? i : acc), -1);
  const wdAtLast = days.slice(0, lastRealIdx + 1).filter((d) => d.working).length;
  const wdRemainingAfterLast = total - wdAtLast;
  const realizedAtLast = days.slice(0, lastRealIdx + 1).reduce((a, d) => a + (d.revenue ?? 0), 0);
  const forecastEnd = m.forecastProbable;

  return days.map((d, i) => {
    if (d.working) wdCum += 1;
    if (d.revenue != null) cum += d.revenue;
    const ideal = total > 0 ? (m.target * wdCum) / total : 0;
    const hasReal = d.revenue != null && i <= lastRealIdx;
    let projection: number | null = null;
    let forecast: number | null = null;
    if (state === "current" && lastRealIdx >= 0 && i >= lastRealIdx) {
      const wdSince = wdCum - wdAtLast;
      if (m.currentDailyPace != null) projection = realizedAtLast + m.currentDailyPace * wdSince;
      if (forecastEnd != null && wdRemainingAfterLast > 0)
        forecast =
          realizedAtLast + ((forecastEnd - realizedAtLast) * wdSince) / wdRemainingAfterLast;
      else if (forecastEnd != null) forecast = realizedAtLast;
    }
    return {
      date: d.date,
      working: d.working,
      revenue: d.revenue,
      realizedCumulative: hasReal ? cum : null,
      idealCumulative: Math.round(ideal * 100) / 100,
      projection,
      forecast,
      isToday: d.date === today,
    };
  });
}

// ---------- Deterministic actions ----------

export type ActionType =
  | "BELOW_FLIGHT_LINE"
  | "GAP_OPEN"
  | "LOW_COVERAGE"
  | "PACE_ACCELERATION"
  | "NEW_PIPELINE"
  | "GAP_UNREACHABLE";

export interface ActionSuggestion {
  type: ActionType;
  priority: 1 | 2 | 3;
  message: string;
}

const PRIORITY_BY_STATUS: Record<FlightStatus, 1 | 2 | 3> = {
  CRITICAL: 1,
  RISK: 1,
  ATTENTION: 2,
  ON_TRACK: 3,
};
const brl = (v: number) => formatValue(v, "currency");
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Rules only fire for the current period; closed/future months need no action. */
export function deriveActions(
  m: FlightPlanMetrics,
  state: PeriodState,
  cfg: FlightPlanConfig,
): ActionSuggestion[] {
  if (state !== "current" || m.target <= 0 || m.remainingGap <= 0) return [];
  const base = m.status ? PRIORITY_BY_STATUS[m.status] : 3;
  const out: ActionSuggestion[] = [];
  if (m.gapUnreachable) {
    out.push({
      type: "GAP_UNREACHABLE",
      priority: 1,
      message: `Sem dias úteis restantes e gap de ${brl(m.remainingGap)}.`,
    });
    return out;
  }
  if (m.deviation != null && m.deviation < 0 && m.status && m.status !== "ON_TRACK") {
    out.push({
      type: "BELOW_FLIGHT_LINE",
      priority: base,
      message: `Abaixo da linha de voo em ${brl(-m.deviation)}.`,
    });
  }
  if (m.status && m.status !== "ON_TRACK") {
    out.push({
      type: "GAP_OPEN",
      priority: base,
      message: `Gap de ${brl(m.remainingGap)} para a meta.`,
    });
  }
  if (m.gapCoverage != null && m.gapCoverage < 1) {
    out.push({
      type: "LOW_COVERAGE",
      priority: m.gapCoverage < 0.5 ? 1 : 2,
      message: `Carteira ponderada cobre apenas ${pct(m.gapCoverage)} do gap.`,
    });
  }
  if (m.currentDailyPace && m.requiredDailyPace != null) {
    const accel = m.requiredDailyPace / m.currentDailyPace - 1;
    if (accel > cfg.accelerationAlert) {
      out.push({
        type: "PACE_ACCELERATION",
        priority: accel > 0.5 ? 1 : 2,
        message: `Ritmo necessário está ${pct(accel)} acima do ritmo atual.`,
      });
    }
  }
  if (m.gapCoverage != null && m.gapCoverage < 0.5) {
    out.push({
      type: "NEW_PIPELINE",
      priority: 2,
      message: "Necessário gerar novas oportunidades.",
    });
  }
  return out.sort((a, b) => a.priority - b.priority);
}
